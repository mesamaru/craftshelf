// アドオンの無効化・設定フォルダの退避・ほかのサーバーにそろえる・ライブラリに取り込む・自動更新。
// フォルダのサーバー(本物のフォルダ)と偽の Modrinth で確かめる(Pterodactyl・エージェントも同じ操作だけを使う)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { AUTO_UPDATE_EVERY, setService } from "~/server/sets";
import { eventService } from "~/server/events";
import { job } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const LP = "Vebnzrzj";
const OT = "OtherPrj";
const EX = "ExtraPrj";
const dataDir = mkdtempSync(join(tmpdir(), "cs-data-"));
const folder = (jar: string) => {
  const root = mkdtempSync(join(tmpdir(), "cs-srv-"));
  writeFileSync(join(root, jar), "");
  mkdirSync(join(root, jar.startsWith("fabric") ? "mods" : "plugins"));
  return root;
};
const rootA = folder("paper-1.21.4-1.jar"); // 検証用
const rootB = folder("paper-1.21.4-2.jar"); // 本番
const rootM = folder("fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar"); // Mod のサーバー

// プラグインの版(date の新しいものがいちばん新しい版)
const ver = (pid: string, name: string, n: string, date: string) => ({
  id: `${pid.slice(0, 3)}v${n.replace(/\./g, "")}`.padEnd(8, "0"), project_id: pid, version_number: n, version_type: "release", date_published: date, loaders: ["paper"],
  files: [{ primary: true, filename: `${name}-${n}.jar`, url: `https://cdn.modrinth.com/data/${pid}/${name}-${n}.jar`, size: 1, hashes: {} }],
});
const versions: Record<string, ReturnType<typeof ver>[]> = {
  [LP]: [ver(LP, "LuckPerms", "5.4.0", "2026-01-01")],
  [OT]: [ver(OT, "Other", "1.0", "2026-01-01")],
  [EX]: [ver(EX, "Extra", "1.0", "2026-01-01")],
};
const TITLE: Record<string, string> = { [LP]: "LuckPerms", [OT]: "Other", [EX]: "Extra" };

const fake: FetchLike = async (url) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === "/v2/version_files") return json({}); // 中身からは見つからない
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && versions[m[1]]) return m[2] ? json(versions[m[1]]) : json({ title: TITLE[m[1]], slug: TITLE[m[1]].toLowerCase(), project_type: "plugin" });
    const v = u.pathname.match(/^\/v2\/version\/(\w+)$/);
    const hit = v && Object.values(versions).flat().find((x) => x.id === v[1]);
    return hit ? json(hit) : json({}, 404);
  }
  // jar の中身は plugin.yml だけ(設定フォルダの名前を読むため)
  const f = u.host === "cdn.modrinth.com" && u.pathname.match(/\/([A-Za-z]+)-([\d.]+)\.jar$/);
  if (f) return new Response(new Uint8Array(makeZip({ "plugin.yml": `name: ${f[1]}\nversion: ${f[2]}\nmain: x.Main\n` })));
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let viewer: Headers;
let outsider: Headers;
let A: string;
let B: string;
let M: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const names = (root: string) => readdirSync(join(root, "plugins")).filter((n) => n.includes(".jar")).sort();
const row = async (id: string, pid: string) => (await lib.installed(owner, id)).items.find((i) => i.projectId === pid);

beforeAll(async () => {
  t = await setup(); // ほかのチームの人も登録できるよう、サービス版の認証で(フォルダのサーバーは deps.local で使える)
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  const servers = serverService(deps);
  lib = libraryService(deps);
  sets = setService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  A = (await servers.addLocal(owner, { rootDir: rootA, name: "検証用" })).id;
  B = (await servers.addLocal(owner, { rootDir: rootB, name: "本番" })).id;
  M = (await servers.addLocal(owner, { rootDir: rootM, name: "Mod" })).id;
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
  await lib.install(owner, A, LP);
  await lib.install(owner, A, OT);
});

describe("無効にする・有効にする", () => {
  it("名前の最後に .disabled を付けて止め、一覧・比較に「無効」と出す。更新の確認からは外す", async () => {
    expect(await code(lib.setEnabled(viewer, A, "LuckPerms-5.4.0.jar", false))).toBe(403);
    expect(await code(lib.setEnabled(outsider, A, "LuckPerms-5.4.0.jar", false))).toBe(404);
    expect(await code(lib.setEnabled(owner, A, "../x.jar", false))).toBe(400);
    expect((await lib.setEnabled(owner, A, "LuckPerms-5.4.0.jar", false)).filename).toBe("LuckPerms-5.4.0.jar.disabled");
    expect(names(rootA)).toEqual(["LuckPerms-5.4.0.jar.disabled", "Other-1.0.jar"]);
    expect(await row(A, LP)).toMatchObject({ filename: "LuckPerms-5.4.0.jar.disabled", disabled: true, title: "LuckPerms" });
    const item = (await lib.catalog(owner)).items.find((i) => i.projectId === LP)!;
    expect(item.installs).toMatchObject([{ serverId: A, disabled: true }]);
    versions[LP].push(ver(LP, "LuckPerms", "5.5.0", "2026-02-01"));
    expect((await lib.updates(owner, A)).map((u) => u.projectId)).toEqual([]);
    expect(await code(lib.setEnabled(owner, A, "LuckPerms-5.4.0.jar.disabled", false))).toBe(400); // すでに無効
  });

  it("変更の履歴から元に戻せる。有効にすると戻る", async () => {
    const [c] = await lib.changes(owner, A);
    expect(c).toMatchObject({ action: "無効にする", undoable: true });
    await lib.undo(owner, A, c.id);
    expect(names(rootA)).toEqual(["LuckPerms-5.4.0.jar", "Other-1.0.jar"]);
    await lib.setEnabled(owner, A, "LuckPerms-5.4.0.jar", false);
    await lib.setEnabled(owner, A, "LuckPerms-5.4.0.jar.disabled", true);
    expect(await row(A, LP)).toMatchObject({ filename: "LuckPerms-5.4.0.jar", disabled: false });
    expect((await lib.updates(owner, A)).map((u) => u.latest)).toEqual(["5.5.0"]);
  });
});

describe("設定フォルダの退避", () => {
  it("更新で入れ替えるとき plugins/<名前>/ を退避し、元に戻すと設定も戻る", async () => {
    mkdirSync(join(rootA, "plugins", "LuckPerms", "data"), { recursive: true });
    writeFileSync(join(rootA, "plugins", "LuckPerms", "config.yml"), "a: 1\n");
    writeFileSync(join(rootA, "plugins", "LuckPerms", "data", "users.json"), "[]");
    await lib.install(owner, A, LP);
    expect(names(rootA)).toEqual(["LuckPerms-5.5.0.jar", "Other-1.0.jar"]);
    const [c] = await lib.changes(owner, A);
    expect(c).toMatchObject({ action: "更新", config: true });
    writeFileSync(join(rootA, "plugins", "LuckPerms", "config.yml"), "a: 2\n");
    writeFileSync(join(rootA, "plugins", "LuckPerms", "data", "users.json"), "[1]");
    await lib.undo(owner, A, c.id);
    expect(names(rootA)).toEqual(["LuckPerms-5.4.0.jar", "Other-1.0.jar"]);
    expect(readFileSync(join(rootA, "plugins", "LuckPerms", "config.yml"), "utf8")).toBe("a: 1\n");
    expect(readFileSync(join(rootA, "plugins", "LuckPerms", "data", "users.json"), "utf8")).toBe("[]");
  });

  it("外すときも退避し、元に戻すと設定も戻る。設定フォルダの無いものは退避しない", async () => {
    await lib.remove(owner, A, "LuckPerms-5.4.0.jar");
    expect((await lib.changes(owner, A))[0]).toMatchObject({ action: "外す", config: true });
    writeFileSync(join(rootA, "plugins", "LuckPerms", "config.yml"), "a: 3\n");
    await lib.undo(owner, A, (await lib.changes(owner, A))[0].id);
    expect(readFileSync(join(rootA, "plugins", "LuckPerms", "config.yml"), "utf8")).toBe("a: 1\n");
    expect(await row(A, LP)).toMatchObject({ versionNumber: "5.4.0" });
    // 退避先は plugins/.craftshelf-config(jar の一覧には出ない)
    expect(existsSync(join(rootA, "plugins", ".craftshelf-config"))).toBe(true);
    expect((await lib.installed(owner, A)).items.map((i) => i.filename)).toEqual(["LuckPerms-5.4.0.jar", "Other-1.0.jar"]);
  });
});

describe("ほかのサーバーにそろえる(検証用から本番へ反映)", () => {
  it("編集者以上。ほかのチームのサーバー・同じサーバー・そろえ方の間違いは断る", async () => {
    expect(await code(sets.copy(viewer, A, [B], "add"))).toBe(403);
    expect(await code(sets.copy(outsider, A, [B], "add"))).toBe(404);
    expect(await code(sets.copy(owner, A, [A], "add"))).toBe(400);
    expect(await code(sets.copy(owner, A, [B], "all"))).toBe(400);
  });

  it("「入っているものだけ」は何も足さない。「足りないものも入れる」は同じ版で入れ、止めているものは止める", async () => {
    expect(await sets.copy(owner, A, [B], "update")).toEqual([{ serverId: B, server: "本番", results: [], error: "" }]);
    const [r] = await sets.copy(owner, A, [B], "add");
    expect(r.results.map((x) => [x.title, x.status, x.detail])).toEqual([["LuckPerms", "installed", "5.4.0"], ["Other", "installed", "1.0"]]);
    expect(names(rootB)).toEqual(["LuckPerms-5.4.0.jar", "Other-1.0.jar"]); // いちばん新しい 5.5.0 ではなく、検証用と同じ版
    expect(await row(B, LP)).toMatchObject({ held: true }); // 検証用で前の版に戻して止めていたので
    expect((await sets.copy(owner, A, [B], "add"))[0].results).toEqual([]); // 同じなら何もしない
  });

  it("「まったく同じにする」は、そろえる元に無いもの(このアプリで入れたもの)を外す。種類の違うサーバーは理由を返す", async () => {
    await lib.install(owner, B, EX);
    writeFileSync(join(rootB, "plugins", "Hand.jar"), "hand"); // 手で置いたものは触らない
    const r = await sets.copy(owner, A, [B, M], "mirror");
    expect(r[0].results.map((x) => [x.title, x.status])).toEqual([["Extra", "removed"]]);
    expect(names(rootB)).toEqual(["Extra-1.0.jar.craftshelf-removed", "Hand.jar", "LuckPerms-5.4.0.jar", "Other-1.0.jar"]);
    expect(r[1]).toMatchObject({ server: "Mod", results: [], error: "プラグインのサーバーと Mod のサーバーはそろえられません" });
  });
});

describe("ライブラリに取り込む", () => {
  it("配布元がわかっていてライブラリに無いものは、そのまま載せる", async () => {
    const lp = (await lib.catalog(owner)).items.find((i) => i.projectId === LP)!;
    await lib.removeItem(owner, lp.id);
    const c = await lib.catalog(owner);
    expect(c.orphans.filter((o) => o.projectId === LP).map((o) => o.serverId).sort()).toEqual([A, B].sort());
    expect(await code(lib.adopt(viewer, A, "LuckPerms-5.4.0.jar"))).toBe(403);
    expect(await code(lib.adopt(outsider, A, "LuckPerms-5.4.0.jar"))).toBe(404);
    expect(await lib.adopt(owner, A, "LuckPerms-5.4.0.jar")).toEqual({ title: "LuckPerms", how: "source" });
    const after = await lib.catalog(owner);
    expect(after.orphans).toEqual([]);
    expect(after.items.find((i) => i.projectId === LP)!.installs.length).toBe(2);
  });

  it("配布元のわからない jar は、中身から探し、見つからなければアップロードしたものとして取り込む", async () => {
    writeFileSync(join(rootB, "plugins", "Hand.jar"), makeZip({ "plugin.yml": "name: Hand\nversion: 1.0\nmain: x.Main\n" }));
    expect(await lib.adopt(owner, B, "Hand.jar")).toEqual({ title: "Hand", how: "upload" });
    expect(await row(B, (await lib.catalog(owner)).items.find((i) => i.title === "Hand")!.projectId)).toMatchObject({ filename: "Hand.jar", source: "upload" });
  });
});

describe("自動更新", () => {
  it("入れる・やめるのは編集者以上。ほかのチームのサーバーは見つからない", async () => {
    expect(await code(sets.setAutoUpdate(viewer, B, true))).toBe(403);
    expect(await code(sets.setAutoUpdate(outsider, B, true))).toBe(404);
    await sets.setAutoUpdate(owner, B, true);
    expect((await lib.detail(owner, B)).autoUpdate).toBe(true);
  });

  it("6 時間ごとに、新しい版があれば入れる。止めたもの・無効にしたものは除く。変えたときだけ記録する", async () => {
    const now = new Date("2026-11-09T00:00:00Z");
    expect(await sets.runAutoUpdates(now)).toEqual([B]);
    expect(names(rootB)).toContain("LuckPerms-5.4.0.jar"); // 止めている
    await lib.setHold(owner, B, "modrinth", LP, false);
    expect(await sets.runAutoUpdates(new Date(now.getTime() + 60_000))).toEqual([]); // まだ 6 時間たっていない
    expect(await sets.runAutoUpdates(new Date(now.getTime() + AUTO_UPDATE_EVERY + 60_000))).toEqual([B]);
    expect(names(rootB)).toContain("LuckPerms-5.5.0.jar");
    const log = await eventService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake }).list(owner);
    expect(log.filter((e) => e.action === "自動更新").map((e) => e.target)).toEqual(["本番"]);
    // 処理の一覧にも、変えた回だけ残す
    const jobs = async () => (await t.db.select().from(job).where(eq(job.action, "自動更新"))).map((j) => j.state);
    expect(await jobs()).toEqual(["done"]);
    versions[OT].push(ver(OT, "Other", "2.0", "2026-03-01"));
    await lib.setEnabled(owner, B, "Other-1.0.jar", false);
    expect(await sets.runAutoUpdates(new Date(now.getTime() + 2 * AUTO_UPDATE_EVERY + 120_000))).toEqual([B]);
    expect(names(rootB)).toContain("Other-1.0.jar.disabled");
    expect(await jobs()).toEqual(["done"]);
    await sets.setAutoUpdate(owner, B, false);
    expect(await sets.runAutoUpdates(new Date(now.getTime() + 5 * AUTO_UPDATE_EVERY))).toEqual([]);
  });
});
