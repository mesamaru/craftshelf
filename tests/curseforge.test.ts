// CurseForge(自分用の版だけ。API キーは利用者のもの)。CurseForge と Pterodactyl は偽物の応答で代わりをする
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { curseforgeClient } from "~/server/curseforge";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const CF = "$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ";
const SECRET = "test-secret-0123456789-0123456789-abcd";
let lastSearch = "";
const pulls: { url: string; filename: string }[] = [];

const mods: Record<number, Record<string, unknown>> = {
  100: { id: 100, name: "Sodium Extra", slug: "sodium-extra", summary: "", downloadCount: 5, classId: 6, allowModDistribution: true, logo: { thumbnailUrl: "https://media.forgecdn.net/a.png" } },
  200: { id: 200, name: "Closed", slug: "closed", summary: "", downloadCount: 9, classId: 6, allowModDistribution: false },
  300: { id: 300, name: "WorldEdit", slug: "worldedit", summary: "", downloadCount: 7, classId: 5, allowModDistribution: true },
  400: { id: 400, name: "Fabric API", slug: "fabric-api", summary: "", downloadCount: 99, classId: 6, allowModDistribution: true },
};
const file = (id: number, name: string, loaders: string[], date: string, extra: Record<string, unknown> = {}) => ({
  id, displayName: name, fileName: `${name}.jar`, downloadUrl: `https://edge.forgecdn.net/files/${id}/${name}.jar`, fileDate: date, releaseType: 1, gameVersions: ["1.21.1", ...loaders], fileLength: 1, ...extra });
const files: Record<number, unknown[]> = {
  100: [file(11, "sodium-extra-fabric-0.6", ["Fabric"], "2026-05-02", { dependencies: [{ modId: 400, relationType: 3 }, { modId: 300, relationType: 2 }] }), file(12, "sodium-extra-forge-0.6", ["Forge"], "2026-05-01"),
    file(13, "sodium-extra-beta", ["Fabric"], "2026-06-01", { releaseType: 2 }), file(14, "no-dl", ["Fabric"], "2026-07-01", { downloadUrl: null })],
  300: [file(31, "worldedit-bukkit-7.3", [], "2026-04-01")],
  400: [file(41, "fabric-api-0.100", ["Fabric"], "2026-04-01")],
};

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.curseforge.com") {
    if ((init?.headers as Record<string, string>)?.["x-api-key"] !== CF) return json({}, 403);
    if (u.pathname === "/v1/games/432") return json({ data: { id: 432 } });
    if (u.pathname === "/v1/mods/search") {
      lastSearch = u.search;
      return json({ data: Object.values(mods).filter((m) => String(m.classId) === u.searchParams.get("classId")) });
    }
    const m = u.pathname.match(/^\/v1\/mods\/(\d+)(\/files)?$/);
    if (m && mods[Number(m[1])]) return json({ data: m[2] ? files[Number(m[1])] ?? [] : mods[Number(m[1])] });
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "Mod のサーバー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/files/pull")) { pulls.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }
  if (u.pathname.endsWith("/files/list")) return json({ data: [] });
  return json({}, 404);
};

describe("CurseForge のクライアント", () => {
  const c = curseforgeClient(fake, CF);

  it("種類(プラグイン・Mod)・作り・バージョンで探し、外部からのダウンロードを許していないものは出さない", async () => {
    expect((await c.search("", "fabric", "1.21.1")).map((h) => h.title)).toEqual(["Sodium Extra", "Fabric API"]);
    expect(lastSearch).toContain("classId=6");
    expect(lastSearch).toContain("modLoaderType=4");
    expect(lastSearch).toContain("gameVersion=1.21.1");
    expect((await c.searchType("we", "plugin")).map((h) => [h.title, h.slug])).toEqual([["WorldEdit", "bukkit-plugins/worldedit"]]);
  });

  it("ファイルを対応する Minecraft つきで返す。ダウンロードできないもの・種類の違うものは出さない(合う版を選ぶのはライブラリ)", async () => {
    const rows = await c.rows("100", "fabric", "1.21.1");
    expect(rows.map((r) => [r.versionId, r.type, r.mcVersions])).toEqual([["11", "release", ["1.21.1"]], ["12", "release", ["1.21.1"]], ["13", "beta", ["1.21.1"]]]);
    expect(rows[0].url).toBe("https://edge.forgecdn.net/files/11/sodium-extra-fabric-0.6.jar");
    expect(await c.rows("200", "fabric", null)).toEqual([]); // 外部からのダウンロードを許していない
    expect(await c.rows("100", "paper", null)).toEqual([]); // Mod は Paper のサーバーに入れない
    expect((await c.rows("300", "paper", null)).map((r) => r.filename)).toEqual(["worldedit-bukkit-7.3.jar"]);
  });
});

describe("CurseForge をライブラリ・サーバーで使う", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let lib: ReturnType<typeof libraryService>;
  let owner: Headers;
  let id: string;
  const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

  beforeAll(async () => {
    t = await setup({ mode: "self" });
    const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-cf-")) } };
    lib = libraryService(deps);
    const servers = serverService(deps);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
    await servers.addServers(owner, c.id, ["abcd1234"]);
    id = (await servers.listServers(owner))[0].id;
    await lib.setProfile(owner, id, { platform: "fabric", mcVersion: "1.21.1" });
  });

  it("キーを設定するまでは使えない。使えないキーは保存しない", async () => {
    expect((await lib.catalog(owner)).sources).toEqual(["modrinth", "spigot"]);
    expect(await code(lib.search(owner, id, "", "curseforge"))).toBe(400);
    expect(await code(lib.setCurseforgeKey(owner, "$2a$10$wrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwron"))).toBe(502);
    await lib.setCurseforgeKey(owner, CF);
    expect((await lib.curseforgeKey(owner)).hint).toBe("…NOPQ");
    expect((await lib.catalog(owner)).sources).toEqual(["modrinth", "spigot", "curseforge"]);
  });

  it("サーバーが CurseForge の CDN から直接取り込み、ライブラリに CurseForge のものとして載る", async () => {
    const r = await lib.install(owner, id, "100", "curseforge");
    expect(r.filename).toBe("sodium-extra-fabric-0.6.jar");
    expect(r.deps).toEqual([{ title: "Fabric API", ok: true, detail: "fabric-api-0.100" }]); // 必須の前提だけを一緒に入れる(任意のものは入れない)
    expect(pulls.map((x) => x.url)).toEqual(["https://edge.forgecdn.net/files/11/sodium-extra-fabric-0.6.jar", "https://edge.forgecdn.net/files/41/fabric-api-0.100.jar"]);
    const item = (await lib.catalog(owner)).items.find((i) => i.title === "Sodium Extra")!;
    expect([item.title, item.source, item.slug]).toEqual(["Sodium Extra", "curseforge", "mc-mods/sodium-extra"]);
    expect(await code(lib.addItem(owner, "200", "curseforge"))).toBe(400);
  });

  it("サービス版(自分用の版でない)では設定できない", async () => {
    const svc = libraryService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fake });
    expect(await code(svc.setCurseforgeKey(owner, CF))).toBe(400);
    expect((await svc.catalog(owner)).sources).toEqual(["modrinth", "spigot"]);
  });
});
