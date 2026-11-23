// Hangar(PaperMC)から探す・入れる・更新する(Pterodactyl と Hangar は偽物の応答で代わりをする。応答の形は hangar.papermc.io/api/v1 の実物に合わせた)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { hangarClient, hangarPlatform } from "~/server/hangar";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const CDN = "https://hangarcdn.papermc.io/plugins";

type P = "PAPER" | "VELOCITY" | "WATERFALL";
const project = (id: number, owner: string, slug: string, platforms: P[]) => ({
  createdAt: "2023-01-01T00:00:00Z", id, name: slug, namespace: { owner, slug }, stats: { views: 1, downloads: 10_000 - id, recentViews: 0, recentDownloads: 0, stars: 0, watchers: 0 },
  category: "misc", description: `${slug} です`, lastUpdated: "2026-11-01T00:00:00Z", visibility: "public",
  supportedPlatforms: Object.fromEntries(platforms.map((p) => [p, p === "PAPER" ? ["1.20.4", "1.21.1"] : ["3.4"]])), avatarUrl: `https://hangarcdn.papermc.io/avatars/project/${id}.webp?v=1`,
});
const PROJECTS = [project(31, "ViaVersion", "ViaVersion", ["PAPER", "VELOCITY"]), project(12, "ViaVersion", "ViaBackwards", ["PAPER", "VELOCITY"]),
  project(14, "GeyserMC", "Geyser", ["PAPER", "VELOCITY", "WATERFALL"]), project(571, "SRTeam", "SkinsRestorer", ["PAPER", "WATERFALL"]), project(40, "someone", "Snappy", ["PAPER"])];

type Dep = { name: string; projectId: number | null; required: boolean; externalUrl: string | null };
const version = (projectId: number, id: number, name: string, channel: string, createdAt: string, o: { file?: string; external?: boolean; mc?: string[]; deps?: Dep[]; platforms?: P[] } = {}) => {
  const p = PROJECTS.find((x) => x.id === projectId)!;
  const platforms = o.platforms ?? (["PAPER", "VELOCITY"] as P[]);
  const file = o.file ?? `${p.name}-${name.split("+")[0]}.jar`;
  return {
    createdAt, id, projectId, name, visibility: "public", description: `## ${name}\n- 直しました`, stats: { totalDownloads: 0, platformDownloads: {} }, author: "someone", reviewState: "reviewed",
    channel: { createdAt, name: channel, description: "", color: "#000000", flags: channel === "Release" ? ["FROZEN", "PINNED"] : [] }, pinnedStatus: "NONE",
    downloads: Object.fromEntries(platforms.map((pl) => [pl, o.external
      ? { fileInfo: null, externalUrl: "https://download.example.org/x.jar", downloadUrl: null }
      : { fileInfo: { name: file, sizeBytes: 1234, sha256Hash: "00" }, externalUrl: null, downloadUrl: `${CDN}/${p.namespace.owner}/${p.name}/versions/${encodeURIComponent(name)}/PAPER/${file}` }])),
    pluginDependencies: Object.fromEntries(platforms.map((pl) => [pl, (o.deps ?? []).map((d) => ({ ...d, platform: pl }))])),
    platformDependencies: Object.fromEntries(platforms.map((pl) => [pl, pl === "PAPER" ? o.mc ?? ["1.20.4", "1.21", "1.21.1"] : ["3.4", "4.0.0"]])),
    platformDependenciesFormatted: {}, memberNames: [],
  };
};
type V = ReturnType<typeof version>;
const VERSIONS: V[] = [
  version(31, 34580, "5.12.3-SNAPSHOT+1128", "Snapshot", "2026-11-22T14:07:34Z"),
  version(31, 32762, "5.12.2", "Release", "2026-10-27T19:47:24Z"),
  version(12, 7001, "5.4.0", "Release", "2026-10-28T00:00:00Z", { deps: [
    { name: "ViaVersion", projectId: 31, required: true, externalUrl: null },
    { name: "ViaRewind", projectId: 112, required: false, externalUrl: null },
    { name: "Outside", projectId: null, required: true, externalUrl: "https://example.org/outside" }] }),
  version(14, 238, "Geyser", "Release", "2026-11-01T00:00:00Z", { external: true, platforms: ["PAPER", "VELOCITY", "WATERFALL"] }),
  version(571, 28065, "15.12.5", "Release", "2026-09-01T00:00:00Z", { file: "SkinsRestorer.jar", platforms: ["PAPER", "WATERFALL"] }),
  // 新しい 25 個がスナップショットばかりで、正式版は 1.20.4 のものだけ
  ...Array.from({ length: 26 }, (_, i) => version(40, 4000 + i, `2.0.0-SNAPSHOT+${i}`, "Snapshot", `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`, { mc: ["1.21.1"], platforms: ["PAPER"] })),
  version(40, 3900, "1.0.0", "Release", "2025-01-01T00:00:00Z", { mc: ["1.20.4"], platforms: ["PAPER"] }),
];
const asked: string[] = [];
const files = new Map<string, string[]>([["plugins", []]]);
const pulls: { url: string; filename: string }[] = [];

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "hangar.papermc.io") {
    asked.push(u.pathname + u.search);
    expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/craftshelf/);
    const q = u.searchParams;
    const page = <T,>(list: T[]) => json({ pagination: { count: list.length, limit: Number(q.get("limit")), offset: 0 }, result: list.slice(0, Math.min(25, Number(q.get("limit") ?? 25))) });
    if (u.pathname === "/api/v1/projects") return page(PROJECTS.filter((p) => !q.get("platform") || q.get("platform")! in p.supportedPlatforms));
    const m = u.pathname.match(/^\/api\/v1\/projects\/([^/]+)(\/versions)?$/);
    if (m) {
      const p = PROJECTS.find((x) => String(x.id) === m[1] || x.namespace.slug.toLowerCase() === m[1].toLowerCase());
      if (!p) return json({ message: `Unknown value '${m[1]}' for path variable 'slugOrId'`, isHangarApiException: true, httpError: { statusCode: 404 } }, 404);
      if (!m[2]) return json(p);
      return page(VERSIONS.filter((v) => v.projectId === p.id && (!q.get("platform") || q.get("platform")! in v.downloads) && (!q.get("channel") || v.channel.name === q.get("channel"))
        && (!q.get("platformVersion") || v.platformDependencies[q.get("platform") as "PAPER"]?.includes(q.get("platformVersion")!)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    const v = u.pathname.match(/^\/api\/v1\/versions\/(\d+)$/) && VERSIONS.find((x) => String(x.id) === u.pathname.split("/").pop());
    return v ? json(v) : json({}, 404);
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

describe("Hangar の作りとサーバーの種類", () => {
  it("PAPER は Paper・Purpur、VELOCITY は Velocity、WATERFALL は BungeeCord / Waterfall。Spigot・Folia・Mod のサーバーには入れない", () => {
    expect((["paper", "purpur", "velocity", "bungeecord", "spigot", "folia", "fabric"] as const).map(hangarPlatform))
      .toEqual(["PAPER", "PAPER", "VELOCITY", "WATERFALL", null, null, null]);
  });
});

describe("Hangar のクライアント", () => {
  const c = hangarClient(fake);

  it("探す: サーバーの作り・バージョンで絞り、名前が空なら人気順。動かない種類のサーバーでは問い合わせない", async () => {
    asked.length = 0;
    expect((await c.search("", "bungeecord", "1.21.1")).map((h) => h.title)).toEqual(["Geyser", "SkinsRestorer"]);
    expect(asked.at(-1)).toBe("/api/v1/projects?limit=25&platform=WATERFALL&sort=-downloads");
    const hits = await c.search("via", "paper", "1.21.1");
    expect(asked.at(-1)).toBe("/api/v1/projects?limit=25&platform=PAPER&version=1.21.1&query=via");
    expect(hits[0]).toMatchObject({ projectId: "31", slug: "ViaVersion/ViaVersion", title: "ViaVersion", iconUrl: "https://hangarcdn.papermc.io/avatars/project/31.webp?v=1", author: "ViaVersion" });
    asked.length = 0;
    expect(await c.search("", "fabric", null)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("版: Hangar の CDN のファイルだけ。Release は正式版、Snapshot はベータ。プロキシの版は MC のバージョンを持たない", async () => {
    const rows = await c.rows("31", "paper", "1.21.1");
    expect(rows.map((r) => [r.versionNumber, r.type, r.filename])).toEqual([
      ["5.12.3-SNAPSHOT+1128", "beta", "ViaVersion-5.12.3-SNAPSHOT-5.12.3-SNAPSHOT+1128.jar"], ["5.12.2", "release", "ViaVersion-5.12.2.jar"]]);
    expect(rows[1]).toMatchObject({ projectId: "31", versionId: "32762", url: `${CDN}/ViaVersion/ViaVersion/versions/5.12.2/PAPER/ViaVersion-5.12.2.jar`, size: 1234, mcVersions: ["1.20.4", "1.21", "1.21.1"], loaders: ["paper"] });
    expect((await c.rows("31", "velocity", null))[0]).toMatchObject({ mcVersions: [], loaders: ["velocity"] });
    expect(await c.rows("31", "bungeecord", null)).toEqual([]); // WATERFALL の版が無い
    expect(await c.rows("14", "paper", null)).toEqual([]); // 外のサイトで配っている版だけ
    expect(await c.rows("../x", "paper", null)).toEqual([]);
  });

  it("問い合わせ: 足りていれば 1 回。新しい 25 個に正式版が無い・サーバーの MC に合う正式版が無いときだけ続けて問い合わせる", async () => {
    asked.length = 0;
    await c.rows("31", "paper", "1.21.1");
    expect(asked).toEqual(["/api/v1/projects/31/versions?limit=25&platform=PAPER"]);
    asked.length = 0;
    const rows = await c.rows("40", "paper", "1.20.4");
    expect(asked).toEqual(["/api/v1/projects/40/versions?limit=25&platform=PAPER", "/api/v1/projects/40/versions?limit=25&platform=PAPER&channel=Release"]);
    expect(rows.filter((r) => r.type === "release").map((r) => r.versionNumber)).toEqual(["1.0.0"]);
    asked.length = 0;
    await c.rows("40", "paper", "1.19.4");
    expect(asked.at(-1)).toBe("/api/v1/projects/40/versions?limit=25&platform=PAPER&platformVersion=1.19.4");
  });

  it("前提: 必須で Hangar にあるものだけ。版ごとに同じ名前のファイルは、版を足した名前にする", async () => {
    expect((await c.rows("12", "paper", null))[0].deps).toEqual(["31"]);
    expect((await c.rows("571", "bungeecord", null))[0].filename).toBe("SkinsRestorer-15.12.5.jar");
  });

  it("決まった版: ほかのプロジェクトの版は返さない。作りを決めなければファイルのある最初の作り", async () => {
    expect(await c.version("31", "32762", "velocity")).toMatchObject({ versionId: "32762", filename: "ViaVersion-5.12.2.jar" });
    expect(await c.version("12", "32762")).toBeNull();
    expect(await c.version("31", "32762", "bungeecord")).toBeNull();
    expect(await c.version("14", "238")).toBeNull();
  });

  it("プロジェクト(ID でも slug でも)と、変更内容を含む版の一覧", async () => {
    expect(await c.project("ViaVersion")).toMatchObject({ id: "31", title: "ViaVersion", slug: "ViaVersion/ViaVersion", projectType: "plugin", mcVersions: ["1.20.4", "1.21.1"] });
    expect(await c.project("999999999")).toBeNull();
    const all = await c.allVersions("31");
    expect(all.map((v) => [v.versionNumber, v.type, v.loaders.join("/")])).toEqual([["5.12.3-SNAPSHOT+1128", "beta", "paper/velocity"], ["5.12.2", "release", "paper/velocity"]]);
    expect(all[1].changelog).toContain("直しました");
  });
});

describe("Hangar のプラグインをサーバーに入れる", () => {
  let lib: ReturnType<typeof libraryService>;
  let owner: Headers;
  let id: string;
  const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

  beforeAll(async () => {
    const t = await setup();
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
    const servers = serverService(deps);
    lib = libraryService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const conn = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
    await servers.addServers(owner, conn.id, ["abcd1234"]);
    id = (await servers.listServers(owner))[0].id;
    await lib.setProfile(owner, id, { platform: "paper", mcVersion: "1.21.1" });
  });

  it("URL から足せる(slug をプロジェクトの ID に)。プラグイン以外では探せない", async () => {
    expect(await lib.addFromUrl(owner, "https://hangar.papermc.io/ViaVersion/ViaBackwards")).toMatchObject({ title: "ViaBackwards" });
    expect((await lib.catalog(owner)).items.map((i) => [i.title, i.source, i.projectId])).toEqual([["ViaBackwards", "hangar", "12"]]);
    expect(await code(lib.addFromUrl(owner, "https://hangar.papermc.io/someone/nothing-here"))).toBe(404);
    expect(await code(lib.searchCatalog(owner, "", "mod", "hangar"))).toBe(400);
    expect((await lib.searchCatalog(owner, "via", "plugin", "hangar")).length).toBeGreaterThan(0);
  });

  it("Pterodactyl が Hangar の CDN から直接取り込み、必須の前提(Hangar にあるもの)も入る。受け取る版は正式版", async () => {
    const r = await lib.install(owner, id, "12", "hangar");
    expect(r.filename).toBe("ViaBackwards-5.4.0.jar");
    expect(r.deps).toEqual([{ title: "ViaVersion", ok: true, detail: "5.12.2" }]);
    expect(pulls.map((p) => p.url)).toEqual([`${CDN}/ViaVersion/ViaBackwards/versions/5.4.0/PAPER/ViaBackwards-5.4.0.jar`, `${CDN}/ViaVersion/ViaVersion/versions/5.12.2/PAPER/ViaVersion-5.12.2.jar`]);
    expect((await lib.installed(owner, id)).items.map((i) => [i.source, i.projectId, i.versionNumber]).sort()).toEqual([["hangar", "12", "5.4.0"], ["hangar", "31", "5.12.2"]]);
  });

  it("版の一覧から選べ、新しい正式版が出ると更新がわかり、更新して前の版に戻せる", async () => {
    const list = await lib.versions(owner, id, "hangar", "31");
    expect(list.map((v) => [v.versionNumber, v.support, v.suggested])).toEqual([["5.12.3-SNAPSHOT+1128", "ok", false], ["5.12.2", "ok", true]]);
    VERSIONS.push(version(31, 34600, "5.12.3", "Release", "2026-11-23T00:00:00Z"));
    expect((await lib.updates(owner, id)).map((u) => [u.projectId, u.current, u.latest])).toEqual([["31", "5.12.2", "5.12.3"]]);
    expect((await lib.install(owner, id, "31", "hangar")).versionNumber).toBe("5.12.3");
    expect(files.get("plugins")).toEqual(["ViaBackwards-5.4.0.jar", "ViaVersion-5.12.3.jar"]);
    expect((await lib.rollback(owner, id, "hangar", "31")).versionNumber).toBe("5.12.2");
    expect(files.get("plugins")).toEqual(["ViaBackwards-5.4.0.jar", "ViaVersion-5.12.2.jar"]);
  });

  it("Hangar の外で配っているものは入れられない", async () => {
    expect(await code(lib.install(owner, id, "14", "hangar"))).toBe(404);
  });
});
