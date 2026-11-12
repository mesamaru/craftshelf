// Mod(Fabric・Quilt・Forge・NeoForge)の前提の確かめ: jar の説明ファイルの必須の前提と、入っている jar の「提供する id」(自分の id・provides・jar の中の jar)を突き合わせる
// (Pterodactyl・Wings・Modrinth は偽物の応答で代わりをする)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { jarMeta } from "~/server/jar";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const fabricMod = (o: Record<string, unknown>) => makeZip({ "fabric.mod.json": JSON.stringify({ schemaVersion: 1, version: "1.0", ...o }) }, false);
// Fabric API: 自分の id と provides に fabric、部品は jar の中の jar(META-INF/jars/)
const fabricApi = makeZip({
  "fabric.mod.json": JSON.stringify({ id: "fabric-api", name: "Fabric API", version: "0.100.0", provides: ["fabric"] }),
  "META-INF/jars/fabric-api-base-0.4.jar": makeZip({ "fabric.mod.json": JSON.stringify({ id: "fabric-api-base", version: "0.4" }) }),
  "META-INF/jars/fabric-resource-loader-v0-1.0.jar": makeZip({ "fabric.mod.json": JSON.stringify({ id: "fabric-resource-loader-v0", version: "1.0" }) }),
}, false);

describe("jarMeta: Mod の前提と、提供する id", () => {
  it("fabric.mod.json: depends だけ読む(recommends・suggests・breaks・conflicts は読まない)。minecraft・java・fabricloader は前提にしない", () => {
    const m = jarMeta(fabricMod({
      id: "mymod", name: "MyMod",
      depends: { fabricloader: ">=0.15", minecraft: "~1.21", java: ">=21", "fabric-api": "*", somelib: [">=1", "<3"] },
      recommends: { modmenu: "*" }, suggests: { extra: "*" }, breaks: { bad: "*" }, conflicts: { worse: "*" },
    }));
    expect(m).toMatchObject({ key: "mod:mymod", name: "MyMod", depends: [{ key: "mod:fabric-api", name: "fabric-api" }, { key: "mod:somelib", name: "somelib" }], provides: ["mod:mymod"] });
  });

  it("provides と、jar の中の jar(Fabric API の部品)の id も、提供するものに入れる", () => {
    expect(jarMeta(fabricApi).provides.sort()).toEqual(["mod:fabric", "mod:fabric-api", "mod:fabric-api-base", "mod:fabric-resource-loader-v0"]);
    expect(jarMeta(fabricMod({ id: "a", provides: ["old-a", "older-a"] })).provides).toEqual(["mod:a", "mod:old-a", "mod:older-a"]);
  });

  it("クライアントだけの Mod の前提は、サーバーでは数えない", () => {
    expect(jarMeta(fabricMod({ id: "cl", environment: "client", depends: { "fabric-api": "*" } })).depends).toEqual([]);
    expect(jarMeta(fabricMod({ id: "sv", environment: "server", depends: { "fabric-api": "*" } })).depends).toHaveLength(1);
  });

  it("quilt.mod.json: quilt_loader の depends(文字・{ id })。任意(optional)は数えない。quilt_loader・minecraft は前提にしない。provides も読む", () => {
    const q = makeZip({ "quilt.mod.json": JSON.stringify({ schema_version: 1, quilt_loader: {
      id: "qmod", version: "1.0", provides: [{ id: "alias", version: "1" }, "alias2"],
      depends: [{ id: "quilt_loader", versions: ">=0.20" }, { id: "minecraft" }, { id: "qsl", versions: ">=1" }, { id: "optmod", optional: true }, "other_mod"],
    } }) }, false);
    expect(jarMeta(q)).toMatchObject({ key: "mod:qmod", depends: [{ key: "mod:qsl", name: "qsl" }, { key: "mod:other_mod", name: "other_mod" }], provides: ["mod:qmod", "mod:alias", "mod:alias2"] });
  });

  it("mods.toml: mandatory = true の前提だけ。forge・minecraft・fml・javafml・lowcodefml・mixinextras は前提にしない。クライアント側だけの前提も数えない。[[mods]] の modId は全部提供する", () => {
    const toml = [
      'modLoader="javafml"', 'loaderVersion="[47,)"', "",
      "[[mods]]", 'modId="mymod"', 'version="1.0"', 'displayName="My Mod"', "",
      "[[mods]]", 'modId="mymod_api"', "",
      "[[dependencies.mymod]]", 'modId="forge"', "mandatory=true", 'versionRange="[47,)"', "",
      "[[dependencies.mymod]]", 'modId="minecraft"', "mandatory=true", "",
      "[[dependencies.mymod]]", 'modId="mixinextras"', "mandatory=true", "",
      "[[dependencies.mymod]]", 'modId="jei"', "mandatory=true", 'side="BOTH"', "",
      "[[dependencies.mymod]]", 'modId="curios"', "mandatory=false", "",
      "[[dependencies.mymod]]", 'modId="clientonly"', "mandatory=true", 'side="CLIENT"', "",
    ].join("\n");
    expect(jarMeta(makeZip({ "META-INF/mods.toml": toml }, false))).toMatchObject({ key: "mod:mymod", depends: [{ key: "mod:jei", name: "jei" }], provides: ["mod:mymod", "mod:mymod_api"] });
  });

  it("neoforge.mods.toml: type = \"required\" の前提だけ(optional・incompatible・discouraged は数えない。neoforge・minecraft は前提にしない)", () => {
    const toml = [
      "[[mods]]", 'modId="neomod"', "",
      "[[dependencies.neomod]]", 'modId="neoforge"', 'type="required"', "",
      "[[dependencies.neomod]]", 'modId="minecraft"', 'type="required"', "",
      "[[dependencies.neomod]]", 'modId="geckolib"', 'type="required"', "",
      "[[dependencies.neomod]]", 'modId="opt"', 'type="optional"', "",
      "[[dependencies.neomod]]", 'modId="bad"', 'type="incompatible"', "",
    ].join("\n");
    expect(jarMeta(makeZip({ "META-INF/neoforge.mods.toml": toml }, false)).depends).toEqual([{ key: "mod:geckolib", name: "geckolib" }]);
  });

  it("プラグインは今までどおり(提供するものは自分の名前だけ)", () => {
    expect(jarMeta(makeZip({ "plugin.yml": "name: P\nversion: 1\ndepend: [Vault]\n" }, false))).toEqual({ key: "plugin:p", name: "P", version: "1", depends: [{ key: "plugin:vault", name: "Vault" }], provides: [] });
  });
});

// ---- サーバーの「前提不足」: 入っている jar 全部の提供するものと突き合わせる ----
const disk = new Map<string, Uint8Array>(); // "<サーバーの識別子>/mods/<ファイル名>"
const modrinthAsked: string[] = [];
let jarReads = 0;
const fake: FetchLike = async (url) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    modrinthAsked.push(u.pathname);
    if (u.pathname === "/v2/project/fabric-api") return json({ id: "P7dR8mSH", slug: "fabric-api", title: "Fabric API", project_type: "mod", icon_url: null });
    if (u.pathname === "/v2/project/geckolib") return json({ id: "8BmcQJ2H", slug: "geckolib", title: "GeckoLib", project_type: "mod" });
    if (u.pathname === "/v2/project/samename") return json({ id: "AAAAAAAA", slug: "samename", title: "Not A Mod", project_type: "resourcepack" });
    return json({}, 404);
  }
  if (u.host === "wings.example.test") jarReads++;
  if (u.host === "wings.example.test") return new Response(new Uint8Array(disk.get(`${u.searchParams.get("ident")}/${u.searchParams.get("file")}`)!));
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: ["fab00001", "frg00001", "qlt00001", "big00001"].map((identifier) => ({ attributes: { identifier, name: identifier } })), meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/([a-z0-9]+)\/files\/(list|download)$/);
  if (m?.[2] === "list") {
    const dir = (u.searchParams.get("directory") ?? "/").replace(/^\/+|\/+$/g, "");
    return json({ data: [...disk].filter(([p]) => p.startsWith(`${m[1]}/${dir}/`)).map(([p, d]) => ({ attributes: { name: p.slice(`${m[1]}/${dir}/`.length), size: d.byteLength, is_file: true } })) });
  }
  if (m?.[2] === "download") return json({ attributes: { url: `https://wings.example.test/download/file?ident=${m[1]}&file=${encodeURIComponent(u.searchParams.get("file")!.replace(/^\/+/, ""))}` } });
  return json({}, 404);
};

let lib: ReturnType<typeof libraryService>;
let owner: Headers;
const ids: Record<string, string> = {};
const put = (server: string, name: string, data: Uint8Array) => disk.set(`${server}/mods/${name}`, data);
const unmet = async (server: string) => (await lib.serverDeps(owner, ids[server])).unmet;

beforeAll(async () => {
  const t = await setup({ mode: "self" });
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-mm-")) } };
  lib = libraryService(deps);
  const servers = serverService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["fab00001", "frg00001", "qlt00001", "big00001"]);
  for (const s of await servers.listServers(owner)) ids[s.name] = s.id;
  await lib.setProfile(owner, ids.fab00001, { platform: "fabric", mcVersion: "1.21.1" });
  await lib.setProfile(owner, ids.frg00001, { platform: "forge", mcVersion: "1.20.1" });
  await lib.setProfile(owner, ids.qlt00001, { platform: "quilt", mcVersion: "1.21.1" });
  await lib.setProfile(owner, ids.big00001, { platform: "fabric", mcVersion: "1.21.1" });
});

describe("Mod の前提不足(手で置いた jar)", () => {
  it("Fabric: 足りない前提を出す。Modrinth の slug と同じ id には「入れる」の情報を付け、違うものは名前だけ。minecraft・fabricloader・recommends は数えない", async () => {
    put("fab00001", "mymod.jar", fabricMod({ id: "mymod", name: "MyMod", depends: { fabricloader: "*", minecraft: "*", java: "*", "fabric-api": "*", "my-private-lib": "*", samename: "*" }, recommends: { modmenu: "*" } }));
    expect(await unmet("fab00001")).toEqual([
      { name: "fabric-api", by: ["MyMod"], install: { source: "modrinth", projectId: "P7dR8mSH", title: "Fabric API", iconUrl: "", projectType: "mod" } },
      { name: "my-private-lib", by: ["MyMod"] },
      { name: "samename", by: ["MyMod"] }, // 同じ名前でも Mod でなければ付けない
    ]);
  });

  it("jar を足すと、足りないものが消える: 入れ子の Fabric API 部品・provides で満たされる。無効にした jar は数えない", async () => {
    put("fab00001", "fabric-api-0.100.jar", fabricApi);
    put("fab00001", "needs-parts.jar", fabricMod({ id: "parts", name: "Parts", depends: { "fabric-api-base": "*", "fabric-resource-loader-v0": ">=1", fabric: "*" } }));
    expect((await unmet("fab00001")).map((d) => d.name)).toEqual(["my-private-lib", "samename"]); // fabric-api は入った。部品・fabric(provides)も満たされる
    put("fab00001", "private-lib.jar", fabricMod({ id: "my-private-lib" }));
    put("fab00001", "samename.jar", fabricMod({ id: "samename" }));
    expect(await unmet("fab00001")).toEqual([]);
    disk.delete("fab00001/mods/private-lib.jar");
    put("fab00001", "private-lib.jar.disabled", fabricMod({ id: "my-private-lib" }));
    expect((await unmet("fab00001")).map((d) => d.name)).toEqual(["my-private-lib"]);
  });

  it("Fabric API の jar の中の jar を読めなくても、fabric-api が入っていれば fabric-*-v1 の部品は満たされているとみなす(fabric-api と同じ名前の別の Mod は別)", async () => {
    put("qlt00001", "fabric-api.jar", fabricMod({ id: "fabric-api", provides: ["fabric"] })); // 入れ子なしの Fabric API
    put("qlt00001", "uses-api.jar", fabricMod({ id: "uses", name: "Uses", depends: { "fabric-lifecycle-events-v1": "*", "fabric-api-base": "*", "fabric-language-kotlin": "*" } }));
    expect((await unmet("qlt00001")).map((d) => d.name)).toEqual(["fabric-language-kotlin"]); // 部品は満たされる。Fabric API の部品ではない Mod は足りない
  });

  it("Quilt の前提(quilt.mod.json)・Forge の前提(mods.toml)も出す。クライアントだけ・任意の前提は数えない", async () => {
    put("qlt00001", "qmod.jar", makeZip({ "quilt.mod.json": JSON.stringify({ schema_version: 1, quilt_loader: { id: "qmod", depends: [{ id: "quilt_loader" }, { id: "minecraft" }, { id: "qsl" }, { id: "opt", optional: true }] } }) }, false));
    expect((await unmet("qlt00001")).map((d) => [d.name, d.by])).toEqual([["fabric-language-kotlin", ["Uses"]], ["qsl", ["qmod"]]]);
    put("frg00001", "forgemod.jar", makeZip({ "META-INF/mods.toml": ['[[mods]]', 'modId="forgemod"', 'displayName="ForgeMod"', "", "[[dependencies.forgemod]]", 'modId="forge"', "mandatory=true", "",
      "[[dependencies.forgemod]]", 'modId="minecraft"', "mandatory=true", "", "[[dependencies.forgemod]]", 'modId="geckolib"', "mandatory=true", "",
      "[[dependencies.forgemod]]", 'modId="curios"', "mandatory=false", ""].join("\n") }, false));
    expect(await unmet("frg00001")).toEqual([{ name: "geckolib", by: ["ForgeMod"], install: { source: "modrinth", projectId: "8BmcQJ2H", title: "GeckoLib", iconUrl: "", projectType: "mod" } }]);
    put("frg00001", "geckolib.jar", makeZip({ "META-INF/mods.toml": '[[mods]]\nmodId="geckolib"\n' }, false));
    expect(await unmet("frg00001")).toEqual([]);
  });

  it("読む jar は 1 回だけ(場所と大きさが同じなら、2 回目からは読み直さない・Modrinth にも聞き直さない)", async () => {
    await unmet("fab00001");
    const before = [modrinthAsked.length, jarReads];
    await unmet("fab00001");
    await unmet("fab00001");
    expect([modrinthAsked.length, jarReads]).toEqual(before); // jar を読み直さない・同じ前提を Modrinth に聞き直さない(数分は覚えている)
  });

  it("jar が多すぎて全部は読めないとき(100 個を超える)は、誤って出さないよう Mod の前提は確かめない", async () => {
    for (let i = 0; i < 101; i++) put("big00001", `m${i}.jar`, fabricMod({ id: `m${i}`, depends: i === 0 ? { absent: "*" } : {} }));
    expect(await unmet("big00001")).toEqual([]);
  });
});
