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
  ["world/level.dat", "x".repeat(10)],
  ["huge.yml", "y".repeat(600 * 1024)],
]);
const commands: string[] = [];

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
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
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  files = fileService(deps);
  ev = eventService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
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
