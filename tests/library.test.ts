// Mod・プラグインの通しテスト(Pterodactyl と Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import { pickVersion } from "~/server/modrinth";
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
    if (u.pathname === "/v2/project/AANobbMI") return json({ title: "Sodium", slug: "sodium", project_type: "mod", icon_url: "https://cdn.modrinth.com/i.png" });
    if (u.pathname === "/v2/project/MULTIPLA") return json({ title: "Multi", slug: "multi", project_type: "mod" }); // Fabric にも対応したプラグイン
    if (u.pathname === "/v2/project/RPRPRPRP") return json({ title: "Faithful", slug: "faithful", project_type: "resourcepack" });
    if (u.pathname === `/v2/project/${PID}/version`) {
      return json([{ id: latest.id, version_number: latest.number, version_type: "release", date_published: "2026-01-01",
        files: [{ primary: true, filename: latest.filename, url: latest.url || `https://cdn.modrinth.com/data/${PID}/versions/${latest.id}/${latest.filename}`, size: 1, hashes: { sha512: "x" } }] }]);
    }
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先");
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "サバイバル" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete|rename)$/);
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
  if (m?.[1] === "rename") {
    const f = body.files[0];
    files.set(body.root, (files.get(body.root) ?? []).map((x) => (x === f.from ? f.to : x)));
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
    expect(await lib.updates(viewer, id)).toEqual([{ source: "modrinth", projectId: PID, filename: "LuckPerms-5.4.0.jar", current: "5.4.0", latest: "5.5.0" }]);
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
    expect(files.get("plugins")).toEqual(["Other-1.0.jar", "LuckPerms-5.5.0.jar.craftshelf-removed"]); // 消さずに名前を変えて残す
    expect((await lib.installed(viewer, id)).items.map((i) => i.filename)).toEqual(["Other-1.0.jar"]);
  });
});

describe("ライブラリ(チームの目録)", () => {
  it("サーバーに入れたものは自動で載り、外してもライブラリには残る(入っているサーバーは無くなる)", async () => {
    await lib.install(editor, id, PID);
    let cat = await lib.catalog(viewer);
    expect(cat.items.map((i) => [i.title, i.projectType, i.installs.map((x) => `${x.serverName} ${x.versionNumber}`)])).toEqual([["LuckPerms", "plugin", ["サバイバル 5.5.0"]]]);
    expect(cat.servers).toEqual([{ id, name: "サバイバル", type: "plugin", kinds: ["plugin", "datapack"] }]);
    await lib.remove(editor, id, "LuckPerms-5.5.0.jar");
    cat = await lib.catalog(viewer);
    expect(cat.items[0].installs).toEqual([]);
  });

  it("種類だけで探して足せる(リソースパックなども。クライアントで使うものはサーバーで動くかで絞らない)。足せるのは編集者以上", async () => {
    await lib.searchCatalog(viewer, "sod", "mod");
    expect(lastSearch).toContain("project_type:mod");
    expect(lastSearch).not.toContain("categories:");
    expect(lastSearch).toContain("server_side");
    await lib.searchCatalog(viewer, "", "resourcepack");
    expect(lastSearch).toContain("project_type:resourcepack");
    expect(lastSearch).not.toContain("server_side");
    expect(await code(lib.searchCatalog(viewer, "", "world"))).toBe(400);
    expect(await code(lib.searchCatalog(viewer, "", "shader", "spigot"))).toBe(400);
    expect(await code(lib.addItem(viewer, "AANobbMI"))).toBe(403);
    const rp = await lib.addItem(editor, "RPRPRPRP");
    expect((await lib.catalog(viewer)).items.find((i) => i.id === rp.id)?.projectType).toBe("resourcepack");
    await lib.removeItem(editor, rp.id);
    expect(await code(lib.addItem(editor, "Missing1"))).toBe(404);
    await lib.addItem(editor, "AANobbMI");
    await lib.addItem(editor, "AANobbMI"); // 2 回足しても 1 件
    const cat = await lib.catalog(viewer);
    expect(cat.items.map((i) => [i.title, i.projectType, i.iconUrl])).toEqual([
      ["LuckPerms", "plugin", ""], ["Sodium", "mod", "https://cdn.modrinth.com/i.png"]]);
    // Modrinth が "mod" と返しても、プラグインとして探して足したものはプラグイン
    await lib.addItem(editor, "MULTIPLA", "modrinth", "plugin");
    const multi = (await lib.catalog(viewer)).items.find((i) => i.title === "Multi")!;
    expect(multi.projectType).toBe("plugin");
    await lib.removeItem(editor, multi.id);
  });

  it("ほかのチームからは見えず、外せない。外すのは編集者以上", async () => {
    expect((await lib.catalog(outsider)).items).toEqual([]);
    const item = (await lib.catalog(viewer)).items.find((i) => i.title === "Sodium")!;
    expect(await code(lib.removeItem(outsider, item.id))).toBe(404);
    expect(await code(lib.removeItem(viewer, item.id))).toBe(403);
    await lib.removeItem(editor, item.id);
    expect((await lib.catalog(viewer)).items.map((i) => i.title)).toEqual(["LuckPerms"]);
  });
});

describe("タグ・お気に入り・更新あり", () => {
  const lp = async (h: Headers) => (await lib.catalog(h)).items.find((i) => i.title === "LuckPerms")!;

  it("タグは編集者以上が付け外しでき、チームの中で共有。ほかのチームのものには付けられない", async () => {
    const { id: itemId } = await lp(viewer);
    expect(await code(lib.tagItems(viewer, [itemId], "権限", true))).toBe(403);
    expect(await code(lib.tagItems(editor, [itemId], "  ", true))).toBe(400);
    expect(await code(lib.tagItems(editor, [itemId], "x".repeat(31), true))).toBe(400);
    expect(await code(lib.tagItems(outsider, [itemId], "権限", true))).toBe(404);
    await lib.tagItems(editor, [itemId, "missing"], " 権限 ", true);
    await lib.tagItems(owner, [itemId], "権限", true); // 2 回付けても 1 つ
    expect((await lp(viewer)).tags).toEqual(["権限"]);
    expect((await lib.catalog(outsider)).items).toEqual([]);
    for (let n = 0; n < 19; n++) await lib.tagItems(editor, [itemId], `t${n}`, true);
    expect(await code(lib.tagItems(editor, [itemId], "多すぎ", true))).toBe(400);
    for (let n = 0; n < 19; n++) await lib.tagItems(editor, [itemId], `t${n}`, false);
    expect(await code(lib.tagItems(viewer, [itemId], "権限", false))).toBe(403);
    await lib.tagItems(editor, [itemId], "権限", false);
    expect((await lp(viewer)).tags).toEqual([]);
  });

  it("お気に入りは利用者ごと。閲覧者もできる。ほかのチームのものはできない", async () => {
    const { id: itemId } = await lp(viewer);
    await lib.favorite(viewer, itemId, true);
    await lib.favorite(viewer, itemId, true);
    expect((await lp(viewer)).favorite).toBe(true);
    expect((await lp(editor)).favorite).toBe(false);
    expect(await code(lib.favorite(outsider, itemId, true))).toBe(404);
    await lib.favorite(viewer, itemId, false);
    expect((await lp(viewer)).favorite).toBe(false);
  });

  it("どこかのサーバーに古い版が入っていれば「更新あり」。更新を止めたものは入れない", async () => {
    const { id: itemId } = await lp(viewer);
    await lib.install(editor, id, PID);
    expect(await lib.outdated(viewer)).toEqual([]);
    latest = { id: "ver00004", number: "5.6.0", filename: "LuckPerms-5.6.0.jar", url: "" };
    expect(await lib.outdated(viewer)).toEqual([itemId]);
    expect(await lib.outdated(outsider)).toEqual([]);
    await lib.setHold(editor, id, "modrinth", PID, true);
    expect(await lib.outdated(viewer)).toEqual([]);
    await lib.setHold(editor, id, "modrinth", PID, false);
    latest = { id: "ver00002", number: "5.5.0", filename: "LuckPerms-5.5.0.jar", url: "" };
  });
});

describe("版の選び方(サーバーの種類に合う作り)", () => {
  const v = (id: string, loaders: string[], date: string) => ({ id, loaders, date_published: date });
  const paper = ["paper", "spigot", "bukkit"];

  it("同じ時期に Paper 向けと Bukkit 向けがあれば、Paper のサーバーには Paper 向け", () => {
    expect(pickVersion([v("bukkit", ["bukkit", "spigot"], "2026-05-02"), v("paper", ["paper"], "2026-05-01")], paper)?.id).toBe("paper");
    expect(pickVersion([v("bukkit", ["bukkit", "spigot"], "2026-05-02"), v("paper", ["paper"], "2026-05-01")], ["spigot", "bukkit"])?.id).toBe("bukkit");
  });

  it("Paper 向けの印が古い版にしか無ければ、新しい版を選ぶ(古い版には戻らない)", () => {
    expect(pickVersion([v("new", ["bukkit"], "2026-05-20"), v("old", ["paper"], "2026-03-01")], paper)?.id).toBe("new");
    expect(pickVersion([], paper)).toBeUndefined();
  });
});
