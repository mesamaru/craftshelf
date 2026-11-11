// バックアップは最終の名前に直接書かない(途中で止まった書きかけが、正しいバックアップとして一覧に出ないように)。
// 再起動する操作(戻す・取り込み直す・版の切り替え)は、動いている処理があれば断る
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { backupService } from "~/server/backup";
import { HttpError } from "~/server/guard";
import { jobService } from "~/server/jobs";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
vi.setConfig({ testTimeout: 60_000 });
const seen = vi.hoisted(() => ({ during: null as null | (() => Promise<string[]>), names: [] as string[] }));

// tar が動いている最中(書きかけのファイルがあるとき)に、一覧に何が出るかを見る
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  const { promisify: p } = await import("node:util");
  const { writeFileSync: w, rmSync: rm } = await import("node:fs");
  const { resolve: r } = await import("node:path");
  const fake = Object.assign((...a: unknown[]) => (real.execFile as (...x: unknown[]) => unknown)(...a), {
    [p.custom]: async (cmd: string, args: string[], opts: { cwd: string }) => {
      if (seen.during && args[0] === "-czf") {
        const out = r(opts.cwd, args[1]);
        w(out, "半分だけ書いたところ");
        seen.names = await seen.during();
        rm(out, { force: true });
      }
      return p(real.execFile)(cmd, args, opts as never);
    },
  });
  return { ...real, execFile: fake };
});

const dataDir = mkdtempSync(join(tmpdir(), "cs-bkp-"));
const v03 = join(dataDir, "v03");
let t: Awaited<ReturnType<typeof setup>>;
let svc: ReturnType<typeof backupService>;
let owner: Headers;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup({ mode: "self" });
  svc = backupService({ db: t.db, auth: t.auth, secret: SECRET, fetch, local: { dataDir } });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  mkdirSync(v03, { recursive: true });
  writeFileSync(join(v03, "secret"), "s\n");
});

describe("バックアップの書きかけ", () => {
  it("作っている途中のファイルは、一覧に出ない・残す数に数えない。できあがったら名前が付く", async () => {
    seen.during = async () => (await svc.list(owner)).backups.map((b) => b.name);
    const { name } = await svc.create(owner);
    seen.during = null;
    expect(seen.names).toEqual([]); // 途中の書きかけは、バックアップとして見えない
    expect((await svc.list(owner)).backups.map((b) => b.name)).toEqual([name]);
    expect(readdirSync(join(v03, "backups")).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("前に止まったときの古い書きかけ(1 日より前)は、次に作るときに片付ける。新しいものは残す", async () => {
    const dir = join(v03, "backups");
    const old = join(dir, "craftshelf-v03-20200101-000000.tar.gz.part");
    const fresh = join(dir, "craftshelf-v03-20990101-000000.tar.gz.part");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    utimesSync(old, new Date(Date.now() - 3 * 86400_000), new Date(Date.now() - 3 * 86400_000));
    expect((await svc.list(owner)).backups.every((b) => !b.name.endsWith(".part"))).toBe(true);
    await new Promise((r) => setTimeout(r, 1100)); // 名前の日時が変わるまで
    await svc.create(owner);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("動いている処理があるとき", () => {
  it("戻す・取り込み直す・手元のファイルから戻すは、終わってからやり直してもらう", async () => {
    const { name } = (await svc.list(owner)).backups[0];
    const jobs = jobService({ db: t.db, auth: t.auth, secret: SECRET, fetch });
    const team = (await t.auth.api.getFullOrganization({ headers: owner }))!.id;
    let done!: () => void;
    const running = jobs.track({ teamId: team, userId: null, action: "処理" }, () => new Promise<void>((r) => { done = r; }));
    await vi.waitFor(async () => expect(await jobs.busy()).toBe(true));
    expect(await code(svc.restore(owner, name))).toBe(409);
    expect(await code(svc.reimport(owner))).toBe(409);
    expect(await code(svc.restoreUpload(owner, new Uint8Array([1])))).toBe(409);
    expect(existsSync(join(v03, "restore-pending.tar.gz"))).toBe(false);
    done();
    await running;
    expect(await jobs.busy()).toBe(false);
    expect(await code(svc.restore(owner, name))).toBe(200);
  });
});

describe("保存先に置くのに失敗したとき", () => {
  it("書きかけを保存先から消す(ほかのバックアップは消さない)", async () => {
    const dav = new Map<string, string>();
    let failPut = false;
    const fake = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const m = init?.method ?? "GET";
      if (m === "MKCOL") return new Response(null, { status: 201 });
      if (m === "PUT") {
        dav.set(u.pathname, "書きかけ");
        return new Response(null, { status: failPut && !u.pathname.endsWith(".craftshelf-test") ? 500 : 201 });
      }
      if (m === "DELETE") { dav.delete(u.pathname); return new Response(null, { status: 204 }); }
      if (m === "PROPFIND") return new Response("<d:multistatus xmlns:d=\"DAV:\"></d:multistatus>", { status: 207 });
      return new Response(null, { status: 404 });
    };
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
    const { uploadService } = await import("~/server/uploads");
    const up = uploadService(deps);
    await up.addTarget(owner, { name: "DAV", kind: "webdav", url: "https://dav.example.test/files", user: "me", password: "pw" });
    const target = (await up.targets(owner)).targets.find((x) => x.kind === "webdav")!;
    const b = backupService(deps);
    await b.setSchedule(owner, { enabled: false, time: "04:00", keep: 5, targetId: target.id, tz: "Asia/Tokyo" });
    dav.set("/files/_craftshelf_backup/craftshelf-v03-20200101-000000.tar.gz", "前のバックアップ");
    failPut = true;
    expect(await code(b.create(owner))).toBe(502);
    expect([...dav.keys()].filter((k) => k.includes("_craftshelf_backup"))).toEqual(["/files/_craftshelf_backup/craftshelf-v03-20200101-000000.tar.gz"]);
    failPut = false;
  });
});
