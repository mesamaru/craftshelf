// サーバーの操作: コマンド・設定ファイルの閲覧と編集・履歴(Pterodactyl は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { eventService } from "~/server/events";
import { cleanPath, fileService } from "~/server/files";
import { HttpError } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
// 偽のサーバーのフォルダー
const disk = new Map<string, string>([
  ["server.properties", "motd=Hello\nserver-port=25565\n"],
  ["plugins/Essentials/config.yml", "spawn: world\n"],
  ["plugins/Vault/config.yml", "a: 1\n"],
  ["world/level.dat", "x".repeat(10)],
  ["huge.yml", "y".repeat(600 * 1024)],
]);
const disk2 = new Map<string, string>([
  ["server.properties", "motd=Hello\nserver-port=25566\n"],
  ["plugins/LuckPerms/config.yml", "storage: h2\n"],
  ["plugins/Essentials/config.yml", "spawn: world_nether\nkits: true\n"],
  ["plugins/Vault/config.yml", "a: 2\n"],
]);
const commands: string[] = [];

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }, { attributes: { identifier: "efgh5678", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname === "/api/client/servers/efgh5678/files/contents") {
    const f = u.searchParams.get("file")!.replace(/^\/+/, "");
    return disk2.has(f) ? new Response(disk2.get(f)) : json({}, 404);
  }
  const m2 = u.pathname.match(/^\/api\/client\/servers\/efgh5678\/files\/list$/);
  if (m2) {
    const dir = (u.searchParams.get("directory") ?? "/").replace(/^\/+|\/+$/g, "");
    const names = new Map<string, boolean>();
    for (const p of disk2.keys()) {
      if (dir && !p.startsWith(dir + "/")) continue;
      const [first, ...more] = (dir ? p.slice(dir.length + 1) : p).split("/");
      names.set(first, more.length === 0);
    }
    if (dir && !names.size) return json({}, 404);
    return json({ data: [...names].map(([name, isFile]) => ({ attributes: { name, size: isFile ? disk2.get(dir ? `${dir}/${name}` : name)!.length : 0, is_file: isFile } })) });
  }
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/(files\/list|files\/contents|files\/write|command)$/);
  if (m?.[1] === "files/list") {
    const dir = (u.searchParams.get("directory") ?? "/").replace(/^\/+|\/+$/g, "");
    const names = new Map<string, boolean>();
    for (const p of disk.keys()) {
      if (dir && !p.startsWith(dir + "/")) continue;
      const rest = dir ? p.slice(dir.length + 1) : p;
      const [first, ...more] = rest.split("/");
      names.set(first, more.length === 0 ? true : names.get(first) ?? false);
    }
    return json({ data: [...names].map(([name, isFile]) => ({ attributes: { name, size: isFile ? (disk.get(dir ? `${dir}/${name}` : name)?.length ?? 0) : 0, is_file: isFile } })) });
  }
  if (m?.[1] === "files/contents") {
    const f = u.searchParams.get("file")!.replace(/^\/+/, "");
    return disk.has(f) ? new Response(disk.get(f)) : json({}, 404);
  }
  if (m?.[1] === "files/write") {
    disk.set(u.searchParams.get("file")!.replace(/^\/+/, ""), String(init?.body));
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "command") {
    commands.push(JSON.parse(String(init?.body)).command);
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let files: ReturnType<typeof fileService>;
let ev: ReturnType<typeof eventService>;
let owner: Headers;
let editor: Headers;
let outsider: Headers;
let id: string;
let id2: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  files = fileService(deps);
  ev = eventService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234", "efgh5678"]);
  const list = await servers.listServers(owner);
  id = list.find((s) => s.name === "ロビー")!.id;
  id2 = list.find((s) => s.name === "サバイバル")!.id;
  const inv = await (await t.call("/organization/invite-member", { email: "editor@example.com", role: "editor" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("編集者", "editor@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  editor = t.headers(cookie);
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
});

describe("ファイルの場所", () => {
  it("サーバーのフォルダーの中の相対パスだけ", () => {
    expect(cleanPath("/plugins/Essentials/")).toBe("plugins/Essentials");
    expect(cleanPath("")).toBe("");
    for (const bad of ["../etc/passwd", "plugins/../../x", "a//b", "a\nb"]) expect(() => cleanPath(bad)).toThrow(HttpError);
  });
});

describe("コマンド", () => {
  it("編集者以上が送れる。先頭の / は外す。複数行・ほかのチームは断る", async () => {
    await files.command(editor, id, "/say こんにちは");
    expect(commands).toEqual(["say こんにちは"]);
    expect(await code(files.command(editor, id, "say a\nop me"))).toBe(400);
    expect(await code(files.command(outsider, id, "stop"))).toBe(404);
    expect((await ev.list(owner))[0]).toMatchObject({ action: "コマンドを送る", detail: "say こんにちは" });
  });
});

describe("設定ファイル", () => {
  it("見るのは管理者以上。フォルダーの中身と、開けるファイルが分かる", async () => {
    expect(await code(files.list(editor, id, ""))).toBe(403);
    const root = await files.list(owner, id, "");
    expect(root.entries.map((e) => [e.name, e.isFile, e.editable])).toEqual([
      ["plugins", false, false], ["world", false, false], ["huge.yml", true, false], ["server.properties", true, true]]);
    expect((await files.list(owner, id, "plugins/Essentials")).entries.map((e) => e.name)).toEqual(["config.yml"]);
    expect(await code(files.list(owner, id, "../"))).toBe(400);
  });

  it("テキストの設定ファイルだけを開ける。大きすぎるもの・ほかのチームは断る", async () => {
    expect((await files.read(owner, id, "server.properties")).content).toContain("server-port=25565");
    expect(await code(files.read(owner, id, "world/level.dat"))).toBe(400);
    expect(await code(files.read(owner, id, "huge.yml"))).toBe(400);
    expect(await code(files.read(owner, id, "missing.yml"))).toBe(404);
    expect(await code(files.read(outsider, id, "server.properties"))).toBe(404);
  });

  it("保存すると前の中身が履歴に残り、そこから戻せる。開いたあとに書き換えられていたら保存しない", async () => {
    const f = await files.read(owner, id, "server.properties");
    await files.save(owner, id, f.path, f.content.replace("Hello", "ようこそ"), f.content);
    expect(disk.get("server.properties")).toBe("motd=ようこそ\nserver-port=25565\n");
    const again = await files.read(owner, id, "server.properties");
    expect(again.history.map((h) => h.savedBy)).toEqual(["オーナー"]);
    expect((await files.historyContent(owner, id, again.history[0].id)).content).toBe("motd=Hello\nserver-port=25565\n");
    expect(await code(files.historyContent(outsider, id, again.history[0].id))).toBe(404);
    disk.set("server.properties", "motd=だれかが変えた\n");
    expect(await code(files.save(owner, id, again.path, "motd=x\n", again.content))).toBe(409);
    expect(disk.get("server.properties")).toBe("motd=だれかが変えた\n");
    expect(await code(files.save(editor, id, again.path, "x", "y"))).toBe(403);
    expect((await ev.list(owner))[0]).toMatchObject({ action: "設定ファイルを直す", target: "ロビー の server.properties" });
  });
});

describe("ファイル比較", () => {
  it("選んだサーバーの設定ファイルを集め、どこにあるか・同じ大きさかを返す。ワールド・大きすぎるものは入れない。見るのは管理者以上", async () => {
    expect(await code(files.configs(editor, [id, id2]))).toBe(403);
    expect(await code(files.configs(owner, [id]))).toBe(400);
    expect(await code(files.configs(outsider, [id, id2]))).toBe(404);
    const r = await files.configs(owner, [id, id2]);
    expect(r.servers.map((s) => [s.name, s.error])).toEqual([["ロビー", ""], ["サバイバル", ""]]);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(["plugins/Essentials/config.yml", "plugins/LuckPerms/config.yml", "plugins/Vault/config.yml", "server.properties"]);
    expect(by["server.properties"].on).toEqual([id, id2]);
    expect(by["plugins/LuckPerms/config.yml"]).toMatchObject({ on: [id2], same: false, lines: null });
    // Pterodactyl は大きさが違うものだけ中身を読んで数える(同じ大きさのものは読まない)
    expect(by["plugins/Essentials/config.yml"]).toMatchObject({ on: [id, id2], lines: 2, same: false });
    expect(by["plugins/Vault/config.yml"]).toMatchObject({ lines: null, same: true });
    expect(by["server.properties"]).toMatchObject({ lines: 2, same: false }); // 上のテストで書き換わり、大きさが違う
  });
});

describe("最近のログ", () => {
  it("最後の行を返す(色の記号と終わりの空行は外す)。無ければ found: false。ほかのチームは断る", async () => {
    expect((await files.logs(editor, id)).found).toBe(false);
    disk.set("logs/latest.log", Array.from({ length: 30 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join("\r\n") + "\r\n\r\n");
    const r = await files.logs(editor, id, 20);
    expect(r).toMatchObject({ found: true, file: "logs/latest.log" });
    expect(r.lines).toHaveLength(20);
    expect(r.lines.at(-1)).toBe("line 29");
    expect(await code(files.logs(outsider, id))).toBe(404);
  });
});

describe("設定ファイルを編集者にも許す", () => {
  it("既定は管理者以上だけ。管理者が許すと編集者も見る・直せる(閲覧者・ほかのチームは見られない)。決めるのは管理者以上", async () => {
    const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
    const cookie = await t.signUp("閲覧者", "viewer@example.com");
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    const viewer = t.headers(cookie);

    expect(await files.access(editor)).toEqual({ allowed: false, editors: false });
    expect(await code(files.read(editor, id, "server.properties"))).toBe(403);
    expect(await code(files.setEditorFiles(editor, true))).toBe(403);
    await files.setEditorFiles(owner, true);
    expect(await files.access(editor)).toEqual({ allowed: true, editors: true });
    const f = await files.read(editor, id, "server.properties");
    await files.save(editor, id, "server.properties", f.content + "pvp=false\n", f.content);
    expect(disk.get("server.properties")).toContain("pvp=false");
    expect((await files.list(editor, id, "")).entries.length).toBeGreaterThan(0);
    expect((await files.configs(editor, [id, id2])).files.length).toBeGreaterThan(0);
    expect(await files.access(viewer)).toEqual({ allowed: false, editors: true });
    expect(await code(files.read(viewer, id, "server.properties"))).toBe(403);
    expect(await code(files.read(outsider, id, "server.properties"))).toBe(404); // ほかのチームのサーバーは見つからない
    expect((await files.access(outsider)).editors).toBe(false); // チームごとの決めごと
    await files.setEditorFiles(owner, false);
    expect(await code(files.read(editor, id, "server.properties"))).toBe(403);
    expect((await ev.list(owner)).slice(0, 3).map((r) => r.action)).toEqual(["設定ファイルを管理者以上だけにする", "設定ファイルを直す", "編集者にも設定ファイルを許す"]);
  });
});
