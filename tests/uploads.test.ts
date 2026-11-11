// アップロードしたアドオン: 受け取り・ライブラリ・サーバーへ送る・保存先(Pterodactyl・WebDAV は偽物の応答で代わりをする)
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { backupService } from "~/server/backup";
import { worldBackup } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { smbStore, webdavStore } from "~/server/storage";
import { UPLOAD_LIMITS, uploadService } from "~/server/uploads";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const dataDir = mkdtempSync(join(tmpdir(), "cs-up-data-"));
const received: { directory: string; name: string; text: string }[] = [];
const dav = new Map<string, Uint8Array>();

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "dav.example.test") {
    const m = init?.method ?? "GET";
    if (init?.headers && (init.headers as Record<string, string>).Authorization !== `Basic ${Buffer.from("me:pw").toString("base64")}`) return new Response(null, { status: 401 });
    if (m === "MKCOL") return new Response(null, { status: 201 });
    if (m === "PUT") { dav.set(u.pathname, new Uint8Array(init!.body as Uint8Array)); return new Response(null, { status: 201 }); }
    if (m === "DELETE") { dav.delete(u.pathname); return new Response(null, { status: 204 }); }
    return dav.has(u.pathname) ? new Response(new Uint8Array(dav.get(u.pathname)!)) : new Response(null, { status: 404 });
  }
  if (u.host === "wings.example.test") {
    const file = (init!.body as FormData).get("files") as File;
    received.push({ directory: u.searchParams.get("directory")!, name: file.name, text: Buffer.from(await file.arrayBuffer()).toString("latin1") });
    return new Response(null, { status: 200 });
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/files/upload")) return json({ attributes: { url: "https://wings.example.test/upload/file?token=t" } });
  if (u.pathname.endsWith("/files/list") || u.pathname.endsWith("/files/delete")) return json({ data: [] });
  return json({}, 404);
};

const plugin = (v: string) => makeZip({ "plugin.yml": `name: MyPlugin\nversion: ${v}\nmain: a.B\n`, "a/B.class": `class ${v}` }, false); // 中身を見分けられるよう、圧縮しない
const fabricMod = makeZip({ "fabric.mod.json": '{"id":"m","name":"MyMod","version":"1.0"}' });

let t: Awaited<ReturnType<typeof setup>>;
let up: ReturnType<typeof uploadService>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let viewer: Headers;
let id: string;
const bytesOf = async (p: ReturnType<ReturnType<typeof uploadService>["download"]>) => Buffer.concat(await (await p).stream.toArray());
const webStream = (data: Uint8Array, chunk = 7) => new ReadableStream<Uint8Array>({
  start(c) {
    for (let i = 0; i < data.length; i += chunk) c.enqueue(data.subarray(i, i + chunk));
    c.close();
  },
});
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  up = uploadService(deps);
  lib = libraryService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" });
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
});

describe("アップロード", () => {
  it("jar を調べてライブラリに載せる。同じ名前は同じものの新しい版、同じ中身は 2 度入れない", async () => {
    expect(await code(up.ingest(viewer, "MyPlugin-1.0.jar", plugin("1.0")))).toBe(403);
    expect(await code(up.ingest(owner, "notes.txt", plugin("1.0")))).toBe(400);
    expect(await code(up.ingest(owner, "lib.jar", makeZip({ "x.txt": "x" })))).toBe(400);
    expect(await up.ingest(owner, "MyPlugin-1.0.jar", plugin("1.0"))).toMatchObject({ title: "MyPlugin", version: "1.0", projectType: "plugin" });
    await up.ingest(owner, "MyPlugin-1.1.jar", plugin("1.1"));
    expect(await code(up.ingest(owner, "copy.jar", plugin("1.1")))).toBe(400);
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "MyPlugin")!;
    expect(item.source).toBe("upload");
    expect((await up.files(viewer, item.id)).map((f) => f.version)).toEqual(["1.1", "1.0"]);
    // 一覧の「版 · N バージョン · 大きさ」と、使っている保存先(まだパネルの中)
    expect(item).toMatchObject({ version: "1.1", files: 2, size: plugin("1.0").length + plugin("1.1").length });
    expect((await lib.catalog(viewer)).storage).toEqual({ name: "", kind: "" });
  });

  it("本文を少しずつ受け取って取り込む(一時ファイルは残さない)。ログインしていない人の本文は受け取らない", async () => {
    expect(await code(up.receive(new Headers(), "Stream-1.0.jar", webStream(plugin("9.0")) as never))).toBe(401);
    const big = makeZip({ "plugin.yml": "name: Streamed\nversion: 2.0\nmain: a.B\n", "a/B.class": "x".repeat(50_000) }, false);
    expect(await up.receive(owner, "Streamed-2.0.jar", webStream(big, 1000) as never)).toMatchObject({ title: "Streamed", version: "2.0", projectType: "plugin" });
    expect(readdirSync(join(dataDir, "v03", "tmp"))).toEqual([]);
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "Streamed")!;
    const [f] = await up.files(owner, item.id);
    expect(f.size).toBe(big.length);
    expect(Buffer.compare(await bytesOf(up.download(owner, f.id)), Buffer.from(big))).toBe(0);
    expect(await code(up.receive(owner, "broken.jar", webStream(new Uint8Array(100)) as never))).toBe(400);
    const was = UPLOAD_LIMITS.fileBytes;
    UPLOAD_LIMITS.fileBytes = 10_000; // 上限を超えたら、途中でやめる
    await expect(up.receive(owner, "Big-3.0.jar", webStream(big, 1000) as never)).rejects.toThrow("MB までです");
    UPLOAD_LIMITS.fileBytes = was;
    expect(readdirSync(join(dataDir, "v03", "tmp"))).toEqual([]);
  });

  it("サーバーには新しい版を送る(Pterodactyl にはアップロード)。Paper のサーバーに Mod は送らない", async () => {
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "MyPlugin")!;
    const r = await lib.install(owner, id, item.projectId, "upload");
    expect(r).toMatchObject({ filename: "MyPlugin-1.1.jar", versionNumber: "1.1" });
    expect(received.at(-1)).toMatchObject({ directory: "plugins", name: "MyPlugin-1.1.jar" });
    expect(received.at(-1)!.text).toContain("class 1.1");
    await up.ingest(owner, "MyMod-1.0.jar", fabricMod);
    const mod = (await lib.catalog(owner)).items.find((i) => i.title === "MyMod")!;
    expect(await code(lib.install(owner, id, mod.projectId, "upload"))).toBe(404);
  });

  it("ダウンロードでき、版を消すと保存先からも消える", async () => {
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "MyPlugin")!;
    const [newest, older] = await up.files(owner, item.id);
    expect((await bytesOf(up.download(viewer, older.id))).toString("latin1")).toContain("class 1.0");
    expect(await code(up.removeFile(viewer, newest.id))).toBe(403);
    const dir = join(dataDir, "v03", "library", "plugin", "MyPlugin");
    expect(readdirSync(dir).length).toBe(2);
    await up.removeFile(owner, newest.id);
    expect(readdirSync(dir).length).toBe(1);
  });

  it("自分用の版でなければ使えない", async () => {
    const svc = uploadService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake });
    expect(await code(svc.ingest(owner, "MyPlugin-2.0.jar", plugin("2.0")))).toBe(400);
  });
});

describe("保存先", () => {
  it("フォルダ・WebDAV を足すと、これからのアップロードはそこに置く。ファイルがある保存先は消せない", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cs-up-store-"));
    expect(await code(up.addTarget(viewer, { name: "NAS", kind: "local", path: folder }))).toBe(403);
    expect(await code(up.addTarget(owner, { name: "x", kind: "local", path: "relative" }))).toBe(502);
    await up.addTarget(owner, { name: "NAS", kind: "local", path: folder });
    await up.ingest(owner, "MyPlugin-3.0.jar", plugin("3.0"));
    expect(existsSync(join(folder, "plugin", "MyPlugin"))).toBe(true);
    const nas = (await up.targets(owner)).targets[0];
    expect(nas).toMatchObject({ name: "NAS", kind: "local", active: true });
    expect(await code(up.removeTarget(owner, nas.id))).toBe(400);

    expect(await code(up.addTarget(owner, { name: "DAV", kind: "webdav", url: "https://dav.example.test/files", user: "me", password: "bad" }))).toBe(502);
    await up.addTarget(owner, { name: "DAV", kind: "webdav", url: "https://dav.example.test/files", user: "me", password: "pw" });
    await up.ingest(owner, "MyPlugin-4.0.jar", plugin("4.0"));
    expect([...dav.keys()].some((k) => k.startsWith("/files/plugin/MyPlugin/"))).toBe(true);
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "MyPlugin")!;
    const f40 = (await up.files(owner, item.id))[0];
    expect((await bytesOf(up.download(owner, f40.id))).toString("latin1")).toContain("class 4.0");
    expect(JSON.stringify(await up.targets(owner))).not.toContain("\"pw\""); // パスワードの値そのもの(一時フォルダの名前にたまたま pw が入ることがある)
  });

  it("パネル・ワールドのバックアップの置き場所に使っている保存先は消せない(消すとバックアップが見えなくなる)", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cs-up-bk-"));
    await up.addTarget(owner, { name: "バックアップ先", kind: "local", path: folder });
    const bk = (await up.targets(owner)).targets.find((x) => x.name === "バックアップ先")!;
    const backups = backupService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } });
    await backups.setSchedule(owner, { enabled: false, time: "04:00", keep: 5, targetId: bk.id, tz: "Asia/Tokyo" });
    await expect(up.removeTarget(owner, bk.id)).rejects.toThrow("パネルのバックアップの置き場所");
    await backups.setSchedule(owner, { enabled: false, time: "04:00", keep: 5, targetId: null, tz: "Asia/Tokyo" });
    await t.db.insert(worldBackup).values({ serverId: id, targetId: bk.id });
    await expect(up.removeTarget(owner, bk.id)).rejects.toThrow("ワールドのバックアップの置き場所");
    await t.db.delete(worldBackup).where(eq(worldBackup.serverId, id));
    await up.removeTarget(owner, bk.id);
    expect((await up.targets(owner)).targets.some((x) => x.name === "バックアップ先")).toBe(false);
  });

  it("WebDAV の URL にユーザー名を書いたものは断る", () => {
    expect(() => webdavStore("https://me:pw@dav.example.test/", "", "", fake)).toThrow();
  });
});

describe("SMB の保存先", () => {
  it("サーバー名・共有フォルダ・中の場所を確かめる", () => {
    const base = { host: "nas.local", share: "share", path: "", user: "", password: "", domain: "" };
    expect(() => smbStore({ ...base, host: "\\nas\share" })).toThrow();
    expect(() => smbStore({ ...base, share: "" })).toThrow();
    expect(() => smbStore({ ...base, share: "a/b" })).toThrow();
    expect(() => smbStore({ ...base, path: "../x" })).toThrow();
    expect(() => smbStore({ ...base, path: "craftshelf/library" })).not.toThrow();
  });

  it("つながらない・認証できないときは、足さずに理由を返す", async () => {
    expect(await code(up.addTarget(owner, { name: "NAS", kind: "smb", host: "127.0.0.1", share: "nope", user: "x", password: "y" }))).toBe(502);
    expect((await up.targets(owner)).targets.some((t) => t.kind === "smb")).toBe(false);
  }, 60_000);
});

describe("保存先のあいだでファイルを移す", () => {
  it("移した先で中身を確かめてから元を消し、移したあともダウンロード・送るのに使える。移すのは管理者以上", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cs-up-move-"));
    await up.addTarget(owner, { name: "移す先", kind: "local", path: folder });
    const dest = (await up.targets(owner)).targets.find((x) => x.name === "移す先")!;
    expect(await code(up.moveFiles(viewer, null, dest.id))).toBe(403);
    expect(await code(up.moveFiles(owner, dest.id, dest.id))).toBe(400);
    const before = readdirSync(join(dataDir, "v03", "library", "plugin", "MyPlugin")).length;
    const r = await up.moveFiles(owner, null, dest.id);
    expect(r.failed).toEqual([]);
    expect(r.moved).toBeGreaterThanOrEqual(before);
    expect(readdirSync(join(dataDir, "v03", "library", "plugin", "MyPlugin")).length).toBe(0);
    expect(readdirSync(join(folder, "plugin", "MyPlugin")).length).toBe(before);
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "MyPlugin")!;
    const oldest = (await up.files(owner, item.id)).at(-1)!;
    expect((await bytesOf(up.download(owner, oldest.id))).toString("latin1")).toContain("class 1.0");
  });
});

describe("大きいファイル(バックアップ)の送り・読み・一覧", () => {
  it("WebDAV: ファイルから少しずつ送り、少しずつ読み、PROPFIND でフォルダの中のファイルを並べる", async () => {
    const files = new Map<string, Uint8Array>();
    const davFake: FetchLike = async (url, init) => {
      const u = new URL(url);
      const m = init?.method ?? "GET";
      if (m === "MKCOL") return new Response(null, { status: 405 });
      if (m === "PUT") { files.set(decodeURIComponent(u.pathname), new Uint8Array(await new Response(init!.body).arrayBuffer())); return new Response(null, { status: 201 }); }
      if (m === "PROPFIND") {
        const dir = decodeURIComponent(u.pathname);
        const inside = [...files.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes("/"));
        if (!inside.length) return new Response(null, { status: 404 });
        const hrefs = [dir, ...inside, `${dir}sub/`].map((h) => `<d:response><d:href>${h.split("/").map(encodeURIComponent).join("/")}</d:href></d:response>`).join("");
        return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`, { status: 207 });
      }
      const f = files.get(decodeURIComponent(u.pathname));
      return f ? new Response(new Uint8Array(f)) : new Response(null, { status: 404 });
    };
    const s = webdavStore("https://dav.example.test/files", "me", "pw", davFake);
    const src = join(mkdtempSync(join(tmpdir(), "cs-big-")), "big.bin");
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    writeFileSync(src, data);
    expect(await s.list("_craftshelf_backup")).toEqual([]);
    await s.putFile("_craftshelf_backup/a b.tar.gz", src);
    expect(await s.list("_craftshelf_backup")).toEqual(["a b.tar.gz"]);
    const chunks: Buffer[] = [];
    for await (const c of await s.read("_craftshelf_backup/a b.tar.gz")) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(Buffer.from(data))).toBe(true);
    await expect(s.read("_craftshelf_backup/none.tar.gz")).rejects.toThrow();
  });
});
