// ワールドのバックアップ: フォルダのサーバー(tar.gz にまとめてパネルの中・保存先へ)と Pterodactyl(パネルのバックアップ)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { localParts } from "~/server/schedule";
import { serverService } from "~/server/servers";
import { uploadService } from "~/server/uploads";
import { worldService } from "~/server/worlds";
import { setup } from "./helpers";

vi.setConfig({ testTimeout: 60_000 });
const SECRET = "test-secret-0123456789-0123456789-abcd";
const KEY = "ptlc_0123456789abcdefghij";
const run = promisify(execFile);
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const dataDir = mkdtempSync(join(tmpdir(), "cs-wdata-"));
const root = mkdtempSync(join(tmpdir(), "cs-world-"));
const store = mkdtempSync(join(tmpdir(), "cs-wstore-"));
const LONG = `myworld/datapacks/${"a".repeat(60)}/${"b".repeat(50)}.json`;

// 偽の Pterodactyl: バックアップの一覧・作る・ダウンロード先・消す
let seq = 0;
const remoteBackups: Record<string, unknown>[] = [
  { uuid: "00000000-0000-4000-8000-000000000001", name: "手で作ったもの", created_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:00Z", is_successful: true, is_locked: false, bytes: 10 },
  { uuid: "00000000-0000-4000-8000-000000000002", name: "CraftShelf 鍵つき", created_at: "2026-01-02T00:00:00Z", completed_at: "2026-01-02T00:01:00Z", is_successful: true, is_locked: true, bytes: 10 },
];
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.origin !== "https://panel.example.com") throw new Error("想定外の接続先");
  if (u.pathname === "/api/client") return Response.json({ data: [{ attributes: { identifier: "abcd1234", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/backups(?:\/([0-9a-f-]+)(\/download)?)?$/);
  if (!m) return new Response("{}", { status: 404 });
  if (!m[1] && init?.method === "POST") {
    seq++;
    remoteBackups.push({ uuid: `00000000-0000-4000-8000-1000000000${String(seq).padStart(2, "0")}`, name: JSON.parse(String(init.body)).name,
      created_at: `2026-02-01T00:00:${String(seq).padStart(2, "0")}Z`, completed_at: `2026-02-01T00:01:00Z`, is_successful: true, is_locked: false, bytes: 100 });
    return Response.json({ attributes: {} });
  }
  if (!m[1]) return Response.json({ data: remoteBackups.map((attributes) => ({ attributes })), meta: { pagination: { total_pages: 1 } } });
  if (m[2]) return Response.json({ attributes: { url: `https://wings.example.com/download/backup?token=${m[1]}` } });
  if (init?.method === "DELETE") {
    remoteBackups.splice(remoteBackups.findIndex((b) => b.uuid === m[1]), 1);
    return new Response(null, { status: 204 });
  }
  return new Response("{}", { status: 404 });
};

let t: Awaited<ReturnType<typeof setup>>;
let worlds: ReturnType<typeof worldService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
let outsider: Headers;
let id: string;
let pteroId: string;

beforeAll(async () => {
  writeFileSync(join(root, "server.properties"), "level-name=myworld\n");
  for (const [p, body] of [["myworld/level.dat", "level"], ["myworld/region/r.0.0.mca", "region"], ["myworld/session.lock", "lock"],
    ["myworld_nether/DIM-1/region/r.0.0.mca", "nether"], ["world/level.dat", "ほかのワールド"], [LONG, "{}"]]) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  worlds = worldService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const join2 = async (role: string, email: string) => {
    const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
    const cookie = await t.signUp(role, email);
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    return t.headers(cookie);
  };
  editor = await join2("editor", "editor@example.com");
  viewer = await join2("viewer", "viewer@example.com");
  outsider = t.headers(await t.signUp("ほかのチーム", "other@example.com"));
  id = (await servers.addLocal(owner, { rootDir: root, name: "家のサーバー" })).id;
  const c = await servers.addConnection(owner, { name: "ホスティング", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  pteroId = (await servers.listServers(owner)).find((s) => s.kind === "ptero")!.id;
});

const extract = async (headers: Headers, name: string, serverId = id) => {
  const f = await worlds.open(headers, serverId, name);
  if ("url" in f) throw new Error("ファイルのはず");
  const dir = mkdtempSync(join(tmpdir(), "cs-wout-"));
  await pipeline(f.stream, createWriteStream(join(dir, "w.tar.gz")));
  await run("tar", ["-xzf", "w.tar.gz"], { cwd: dir });
  return dir;
};

describe("フォルダのサーバーのワールド", () => {
  it("編集者が作れる。level-name のワールドと _nether をまとめ、session.lock とほかのワールドは入れない", async () => {
    expect(await code(worlds.create(viewer, id, true))).toBe(403);
    expect(await code(worlds.create(outsider, id, true))).toBe(404);
    const { name } = await worlds.create(editor, id, true);
    expect(name).toMatch(/^myworld-\d{8}-\d{6}\.tar\.gz$/);
    const got = await worlds.get(editor, id);
    expect(got.backups.map((b) => b.name)).toEqual([name]);
    expect(got.backups[0].size).toBeGreaterThan(0);
    expect(got.last?.ok).toBe(true);
    const dir = await extract(editor, name);
    expect(readFileSync(join(dir, "myworld/region/r.0.0.mca"), "utf8")).toBe("region");
    expect(readFileSync(join(dir, "myworld_nether/DIM-1/region/r.0.0.mca"), "utf8")).toBe("nether");
    expect(readFileSync(join(dir, LONG), "utf8")).toBe("{}"); // 100 バイトを超える名前
    expect(existsSync(join(dir, "myworld/session.lock"))).toBe(false);
    expect(existsSync(join(dir, "world"))).toBe(false);
    const [r] = (await t.db.select().from(auditLog)).filter((a) => a.action === "ワールドをバックアップ");
    expect(r.kind).toBe("backup");
  });

  it("設定は管理者以上。残す数を超えた古いものは消す。名前の外のものは扱わない", async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const input = { mode: "off", time: "05:00", dow: 0, keep: 1, targetId: null, tz };
    expect(await code(worlds.setSettings(editor, id, input))).toBe(403);
    expect(await code(worlds.setSettings(owner, id, { ...input, keep: 0 }))).toBe(400);
    expect(await code(worlds.setSettings(owner, id, { ...input, time: "25:00" }))).toBe(400);
    expect(await code(worlds.setSettings(owner, id, { ...input, tz: "Mars/Base" }))).toBe(400);
    await worlds.setSettings(owner, id, input);
    const [first] = (await worlds.get(owner, id)).backups;
    await new Promise((r) => setTimeout(r, 1100)); // 名前は秒まで
    const { name } = await worlds.create(owner, id, true);
    expect((await worlds.get(owner, id)).backups.map((b) => b.name)).toEqual([name]);
    expect(name).not.toBe(first.name);
    expect(await code(worlds.open(editor, id, "../secret"))).toBe(400);
    expect(await code(worlds.remove(viewer, id, name))).toBe(403);
    await worlds.remove(editor, id, name);
    expect((await worlds.get(owner, id)).backups).toEqual([]);
  });

  it("置き場所に保存先を選べる(ほかのチームの保存先は選べない)", async () => {
    const up = uploadService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } });
    await up.addTarget(owner, { name: "NAS", kind: "local", path: store });
    const target = (await up.targets(owner)).targets[0];
    const tz = "Asia/Tokyo";
    expect(await code(worlds.setSettings(outsider, id, { mode: "off", time: "05:00", dow: 0, keep: 5, targetId: target.id, tz }))).toBe(404);
    await worlds.setSettings(owner, id, { mode: "off", time: "05:00", dow: 0, keep: 5, targetId: target.id, tz });
    const { name } = await worlds.create(owner, id, true);
    expect(readdirSync(join(store, "_craftshelf_worlds", id))).toEqual([name]);
    const got = await worlds.get(editor, id);
    expect(got.backups.map((b) => b.name)).toEqual([name]);
    expect(got.targets.map((x) => x.name)).toEqual(["NAS"]);
    const dir = await extract(editor, name);
    expect(readFileSync(join(dir, "myworld/level.dat"), "utf8")).toBe("level");
  });

  it("予約: 毎日・毎週の時刻になったら作る(同じ分に 2 回は動かない)", async () => {
    const now = new Date();
    const tz = "Asia/Tokyo";
    const { time, day } = localParts(now, tz);
    const target = (await worlds.get(owner, id)).settings.targetId;
    await worlds.setSettings(owner, id, { mode: "weekly", time, dow: (day + 1) % 7, keep: 5, targetId: target, tz });
    expect(await worlds.tick(now, true)).toBe(0); // 曜日が違う
    await worlds.setSettings(owner, id, { mode: "daily", time, dow: 0, keep: 5, targetId: target, tz });
    const before = (await worlds.get(owner, id)).backups.length;
    await new Promise((r) => setTimeout(r, 1100));
    expect(await worlds.tick(now, true)).toBe(1);
    expect(await worlds.tick(now, true)).toBe(0);
    expect((await worlds.get(owner, id)).backups.length).toBe(before + 1);
    expect((await worlds.get(owner, id)).settings.lastRunAt).toBe(now.toISOString());
  });

  it("ワールドが無ければ失敗として記録し、エラーとしても知らせる", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cs-noworld-"));
    const servers = serverService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } });
    const { id: emptyId } = await servers.addLocal(owner, { rootDir: empty, name: "空のサーバー" });
    expect(await code(worlds.create(owner, emptyId, true))).toBe(404);
    const r = (await t.db.select().from(auditLog)).find((a) => a.action === "ワールドをバックアップできませんでした");
    expect(r?.target).toBe("空のサーバー");
    expect((await worlds.get(owner, emptyId)).last).toMatchObject({ ok: false });
  });

  it("サービス版(フォルダのサーバーが無い版)では、Pterodactyl 以外は使えない", async () => {
    const svc = worldService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake });
    expect(await code(svc.setSettings(owner, pteroId, { mode: "daily", time: "05:00", dow: 0, keep: 3, targetId: null, tz: "Asia/Tokyo" }))).toBe(200);
    expect(await code(svc.setSettings(owner, id, { mode: "daily", time: "05:00", dow: 0, keep: 3, targetId: null, tz: "Asia/Tokyo" }))).toBe(400);
    expect(await code(svc.create(owner, id, true))).toBe(400);
  });
});

describe("Pterodactyl のサーバー", () => {
  it("パネルのバックアップを作り、このアプリが作ったものだけを残す数まで消す(鍵つき・手で作ったものは消さない)", async () => {
    await worlds.setSettings(owner, pteroId, { mode: "off", time: "05:00", dow: 0, keep: 1, targetId: null, tz: "Asia/Tokyo" });
    await worlds.create(editor, pteroId, true);
    await worlds.create(editor, pteroId, true);
    const got = await worlds.get(editor, pteroId);
    expect(got.kind).toBe("ptero");
    expect(got.targets).toEqual([]);
    expect(got.backups.map((b) => b.label)).toEqual([expect.stringMatching(/^CraftShelf /), "CraftShelf 鍵つき", "手で作ったもの"]);
    const f = await worlds.open(editor, pteroId, got.backups[0].name);
    expect(f).toEqual({ url: `https://wings.example.com/download/backup?token=${got.backups[0].name}` });
    expect(await code(worlds.open(editor, pteroId, "../x"))).toBe(502);
    expect(await code(worlds.get(viewer, pteroId))).toBe(403);
    expect(await code(worlds.get(outsider, pteroId))).toBe(404);
  });
});
