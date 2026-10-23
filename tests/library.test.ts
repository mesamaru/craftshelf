// Mod・プラグインの通しテスト(Pterodactyl と Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const PID = "Vebnzrzj";

// 偽の世界: サーバーの plugins/ の中身・取り込みと削除の記録・Modrinth の最新版
const files = new Map<string, string[]>([["plugins", ["Other-1.0.jar"]]]);
const pulls: { url: string; directory: string; filename: string }[] = [];
let latest = { id: "ver00001", number: "5.4.0", filename: "LuckPerms-5.4.0.jar", url: "" };
let lastSearch = "";

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === "/v2/search") {
      lastSearch = u.searchParams.get("facets") ?? "";
      return json({ hits: [{ project_id: PID, slug: "luckperms", title: "LuckPerms", description: "権限", downloads: 10, icon_url: "https://evil.example/x.png" }] });
    }
    if (u.pathname === `/v2/project/${PID}`) return json({ title: "LuckPerms", slug: "luckperms", project_type: "plugin" });
    if (u.pathname === `/v2/project/${PID}/version`) {
      return json([{ id: latest.id, version_number: latest.number, version_type: "release", date_published: "2026-01-01",
        files: [{ primary: true, filename: latest.filename, url: latest.url || `https://cdn.modrinth.com/data/${PID}/versions/${latest.id}/${latest.filename}`, size: 1, hashes: { sha512: "x" } }] }]);
    }
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先");
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete)$/);
  if (m?.[1] === "list") {
    const dir = u.searchParams.get("directory")!;
    if (!files.has(dir)) return json({}, 404);
    return json({ data: files.get(dir)!.map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  }
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "pull") {
    pulls.push(body);
    files.set(body.directory, [...(files.get(body.directory) ?? []), body.filename]);
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") {
    files.set(body.root, (files.get(body.root) ?? []).filter((f) => !body.files.includes(f)));
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
let outsider: Headers;
let id: string;

const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

async function join(email: string, role: string) {
  const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
  const cookie = await t.signUp(email, email);
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  return t.headers(cookie);
}

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  lib = libraryService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  editor = await join("editor@example.com", "editor");
  viewer = await join("viewer@example.com", "viewer");
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
});

describe("Mod・プラグイン", () => {
  it("種類を決めるまでは探せない。決められるのは管理者以上", async () => {
    expect(await code(lib.installed(owner, id))).toBe(400);
    expect(await code(lib.setProfile(editor, id, { platform: "paper", mcVersion: "1.21.1" }))).toBe(403);
    expect(await code(lib.setProfile(owner, id, { platform: "nope", mcVersion: "" }))).toBe(400);
    expect(await code(lib.setProfile(owner, id, { platform: "paper", mcVersion: "1.21; drop" }))).toBe(400);
    await lib.setProfile(owner, id, { platform: "paper", mcVersion: "1.21.1" });
    expect((await lib.detail(viewer, id)).profile).toEqual({ platform: "paper", mcVersion: "1.21.1" });
  });

  it("サーバーの種類とバージョンで絞って探す。外のサイトのアイコンは使わない", async () => {
    const hits = await lib.search(viewer, id, "luck");
    expect(hits[0].title).toBe("LuckPerms");
    expect(hits[0].iconUrl).toBe("");
    expect(lastSearch).toContain("categories:paper");
    expect(lastSearch).toContain("versions:1.21.1");
    expect(lastSearch).toContain("project_type:plugin");
  });

  it("編集者が入れると、Pterodactyl が Modrinth から直接取り込み、一覧に版が出る", async () => {
    const r = await lib.install(editor, id, PID);
    expect(r.filename).toBe("LuckPerms-5.4.0.jar");
    expect(pulls.at(-1)).toMatchObject({ directory: "plugins", filename: "LuckPerms-5.4.0.jar" });
    expect(pulls.at(-1)!.url.startsWith("https://cdn.modrinth.com/")).toBe(true);
    const { items } = await lib.installed(viewer, id);
    expect(items.map((i) => i.title ?? i.filename)).toEqual(["LuckPerms", "Other-1.0.jar"]);
    expect(items.find((i) => i.title === "LuckPerms")?.versionNumber).toBe("5.4.0");
  });

  it("新しい版が出たら更新がわかり、入れ直すと古いファイルは消える", async () => {
    expect(await lib.updates(viewer, id)).toEqual([]);
    latest = { id: "ver00002", number: "5.5.0", filename: "LuckPerms-5.5.0.jar", url: "" };
    expect(await lib.updates(viewer, id)).toEqual([{ projectId: PID, filename: "LuckPerms-5.4.0.jar", current: "5.4.0", latest: "5.5.0" }]);
    const r = await lib.install(editor, id, PID);
    expect(r.replaced).toEqual(["LuckPerms-5.4.0.jar"]);
    expect(files.get("plugins")).toEqual(["Other-1.0.jar", "LuckPerms-5.5.0.jar"]);
    expect(await lib.updates(viewer, id)).toEqual([]);
  });

  it("Modrinth の CDN 以外のファイルは取り込ませない", async () => {
    latest = { id: "ver00003", number: "6.0.0", filename: "LuckPerms-6.0.0.jar", url: "https://evil.example/LuckPerms-6.0.0.jar" };
    const before = pulls.length;
    expect(await code(lib.install(editor, id, PID))).toBe(404);
    expect(pulls.length).toBe(before);
    latest = { id: "ver00002", number: "5.5.0", filename: "LuckPerms-5.5.0.jar", url: "" };
  });

  it("閲覧者は入れる・外すができない。ほかのチームからは見えない", async () => {
    expect(await code(lib.install(viewer, id, PID))).toBe(403);
    expect(await code(lib.remove(viewer, id, "Other-1.0.jar"))).toBe(403);
    expect(await code(lib.installed(outsider, id))).toBe(404);
    expect(await code(lib.search(outsider, id, ""))).toBe(404);
    expect(await code(lib.install(outsider, id, PID))).toBe(404);
  });

  it("外すときは、フォルダーをまたぐ名前や、無いファイルを断る", async () => {
    expect(await code(lib.remove(editor, id, "../server.properties"))).toBe(400);
    expect(await code(lib.remove(editor, id, "..\\x.jar"))).toBe(400);
    expect(await code(lib.remove(editor, id, "server.properties"))).toBe(400);
    expect(await code(lib.remove(editor, id, "Missing.jar"))).toBe(404);
    await lib.remove(editor, id, "LuckPerms-5.5.0.jar");
    expect(files.get("plugins")).toEqual(["Other-1.0.jar"]);
    expect((await lib.installed(viewer, id)).items.map((i) => i.filename)).toEqual(["Other-1.0.jar"]);
  });
});
