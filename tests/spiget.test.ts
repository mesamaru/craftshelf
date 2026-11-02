// SpigotMC(Spiget)から探す・入れる(Pterodactyl と Spiget は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { spigetClient, spigetFits } from "~/server/spiget";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";

// 偽の SpigotMC: LuckPerms(どちらでも)・Essentials(サーバー用)・プロキシ用・外のサイト・有料・名前が日本語だけのもの
type R = { id: number; name: string; tag: string; downloads: number; external: boolean; premium: boolean; category: { id: number }; version: { id: number } };
const res = (id: number, name: string, category: number, extra: Partial<R> = {}): R =>
  ({ id, name, tag: `${name} です`, downloads: 1000 - id, external: false, premium: false, category: { id: category }, version: { id: id * 10 }, ...extra });
const RESOURCES: R[] = [
  res(28140, "LuckPerms", 21), res(9089, "EssentialsX", 15), res(100, "ProxyChat", 11),
  res(200, "OutsideDownload", 15, { external: true }), res(300, "PaidPlugin", 15, { premium: true }), res(400, "ちょっと便利", 15),
];
const latest = new Map<number, { id: number; name: string }>([[28140, { id: 648014, name: "5.5.71" }], [9089, { id: 1, name: "2.21.0" }], [400, { id: 2, name: "1.0" }]]);
const files = new Map<string, string[]>([["plugins", []]]);
const pulls: { url: string; filename: string }[] = [];

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.spiget.org") {
    if (u.pathname.startsWith("/v2/search/resources/") || u.pathname === "/v2/resources") return json(RESOURCES);
    const m = u.pathname.match(/^\/v2\/resources\/(\d+)(\/versions\/latest)?$/);
    const r = m && RESOURCES.find((x) => x.id === Number(m[1]));
    if (!r) return json({}, 404);
    return m![2] ? json(latest.get(r.id) ?? {}, latest.has(r.id) ? 200 : 404) : json(r);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete)$/);
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "pull") {
    pulls.push({ url: body.url, filename: body.filename });
    files.set(body.directory, [...(files.get(body.directory) ?? []), body.filename]);
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") {
    files.set(body.root, (files.get(body.root) ?? []).filter((x) => !body.files.includes(x)));
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

describe("SpigotMC のカテゴリーと種類", () => {
  it("サーバー用は Paper・Purpur・Spigot、プロキシ用は BungeeCord、Universal は両方。Folia・Velocity・Mod のサーバーには入れない", () => {
    expect(["paper", "purpur", "spigot", "folia", "bungeecord", "velocity", "fabric"].map((p) => spigetFits(15, p as never))).toEqual([true, true, true, false, false, false, false]);
    expect(["paper", "bungeecord", "velocity"].map((p) => spigetFits(11, p as never))).toEqual([false, true, false]);
    expect(["paper", "bungeecord", "folia"].map((p) => spigetFits(21, p as never))).toEqual([true, true, false]);
    expect(spigetFits(19, "paper")).toBe(false); // Standalone
  });
});

describe("Spiget のクライアント", () => {
  const c = spigetClient(fake);

  it("外のサイトで配っているもの・有料のものは探しても出ない。サーバーの種類で絞る", async () => {
    expect((await c.search("x", "paper")).map((h) => h.title)).toEqual(["LuckPerms", "EssentialsX", "ちょっと便利"]);
    expect((await c.search("", "bungeecord")).map((h) => h.title)).toEqual(["LuckPerms", "ProxyChat"]);
    expect((await c.searchAll("x")).map((h) => h.title)).toEqual(["LuckPerms", "EssentialsX", "ProxyChat", "ちょっと便利"]);
  });

  it("取り込ませる URL は Spiget のものだけ。ファイルの名前は安全な文字だけで作る", async () => {
    expect(await c.latestFile("28140", "paper")).toMatchObject({
      url: "https://api.spiget.org/v2/resources/28140/download", filename: "LuckPerms-5.5.71.jar", versionId: "648014", versionNumber: "5.5.71" });
    expect((await c.latestFile("400", "paper"))?.filename).toBe("spigot-400.jar");
    expect(await c.latestFile("200", "paper")).toBeNull(); // 外のサイト
    expect(await c.latestFile("300", "paper")).toBeNull(); // 有料
    expect(await c.latestFile("100", "paper")).toBeNull(); // プロキシ用
    expect(await c.latestFile("../etc", "paper")).toBeNull();
  });
});

describe("SpigotMC のプラグインをサーバーに入れる", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let lib: ReturnType<typeof libraryService>;
  let sets: ReturnType<typeof setService>;
  let owner: Headers;
  let id: string;
  const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

  beforeAll(async () => {
    t = await setup();
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    const servers = serverService(deps);
    lib = libraryService(deps);
    sets = setService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const conn = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
    await servers.addServers(owner, conn.id, ["abcd1234"]);
    id = (await servers.listServers(owner))[0].id;
    await lib.setProfile(owner, id, { platform: "paper", mcVersion: "1.21.1" });
  });

  it("Pterodactyl が Spiget から直接取り込み、ライブラリに SpigotMC のものとして載る", async () => {
    const r = await lib.install(owner, id, "28140", "spigot");
    expect(r.filename).toBe("LuckPerms-5.5.71.jar");
    expect(pulls.at(-1)?.url).toBe("https://api.spiget.org/v2/resources/28140/download");
    const cat = await lib.catalog(owner);
    expect(cat.items.map((i) => [i.title, i.source, i.installs.map((x) => x.versionNumber)])).toEqual([["LuckPerms", "spigot", ["5.5.71"]]]);
    expect((await lib.installed(owner, id)).items[0]).toMatchObject({ source: "spigot", projectId: "28140", versionNumber: "5.5.71" });
  });

  it("入れられないものは理由を返す。Mod のサーバーでは SpigotMC を探せない", async () => {
    expect(await code(lib.install(owner, id, "200", "spigot"))).toBe(404);
    expect(await code(lib.addItem(owner, "300", "spigot"))).toBe(400);
    expect(await code(lib.searchCatalog(owner, "", "mod", "spigot"))).toBe(400);
    expect(await code(lib.install(owner, id, "28140", "curseforge"))).toBe(400);
  });

  it("新しい版がわかり、セットでそろえると更新される(古いファイルは消える)", async () => {
    latest.set(28140, { id: 650000, name: "5.5.72" });
    expect(await lib.updates(owner, id)).toEqual([{ source: "spigot", projectId: "28140", filename: "LuckPerms-5.5.71.jar", current: "5.5.71", latest: "5.5.72" }]);
    await lib.addItem(owner, "9089", "spigot");
    const setId = (await sets.create(owner, "基本")).id;
    for (const i of (await lib.catalog(owner)).items) await sets.toggleItem(owner, setId, i.id, true);
    await sets.bind(owner, id, setId);
    const r = await sets.sync(owner, id);
    expect(r.map((x) => [x.title, x.status, x.detail])).toEqual([["EssentialsX", "installed", "2.21.0"], ["LuckPerms", "updated", "5.5.71 → 5.5.72"]]);
    expect(files.get("plugins")?.sort()).toEqual(["EssentialsX-2.21.0.jar", "LuckPerms-5.5.72.jar"]);
  });
});
