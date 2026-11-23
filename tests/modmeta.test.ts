// Mod(Fabric・Quilt・Forge・NeoForge)の前提の確かめ: jar の説明ファイルの必須の前提と、入っている jar の「提供する id」(自分の id・provides・jar の中の jar)を突き合わせる
// (Pterodactyl・Wings・Modrinth は偽物の応答で代わりをする)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { jarMeta } from "~/server/jar";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { forgetPteroReads } from "~/server/ptero";
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
    expect(m).toMatchObject({ key: "mod:mymod", name: "MyMod", provides: [{ key: "mod:mymod", version: "1.0" }] });
    expect(m.depends).toEqual([
      { key: "mod:fabric-api", name: "fabric-api", range: { style: "fabric", any: ["*"] } },
      { key: "mod:somelib", name: "somelib", range: { style: "fabric", any: [">=1", "<3"] } },
    ]);
  });

  it("provides と、jar の中の jar(Fabric API の部品)の id も、版と一緒に提供するものに入れる", () => {
    expect(jarMeta(fabricApi).provides.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "mod:fabric", version: "0.100.0" }, { key: "mod:fabric-api", version: "0.100.0" }, { key: "mod:fabric-api-base", version: "0.4" }, { key: "mod:fabric-resource-loader-v0", version: "1.0" },
    ]);
    expect(jarMeta(fabricMod({ id: "a", provides: ["old-a", "older-a"] })).provides.map((p) => p.key)).toEqual(["mod:a", "mod:old-a", "mod:older-a"]);
  });

  it("クライアントだけの Mod の前提は、サーバーでは数えない", () => {
    expect(jarMeta(fabricMod({ id: "cl", environment: "client", depends: { "fabric-api": "*" } })).depends).toEqual([]);
    expect(jarMeta(fabricMod({ id: "sv", environment: "server", depends: { "fabric-api": "*" } })).depends).toHaveLength(1);
  });

  it("quilt.mod.json: quilt_loader の depends(文字・{ id })。任意(optional)は数えない。quilt_loader・minecraft は前提にしない。provides も読む", () => {
    const q = makeZip({ "quilt.mod.json": JSON.stringify({ schema_version: 1, quilt_loader: {
      id: "qmod", version: "1.0", provides: [{ id: "alias", version: "1" }, "alias2"],
      depends: [{ id: "quilt_loader", versions: ">=0.20" }, { id: "minecraft" }, { id: "qsl", versions: ">=1" }, { id: "optmod", optional: true }, "other_mod", { id: "anyof", versions: { any: ["1.x", "2.x"] } }, { id: "allof", versions: { all: [">=1", "<2"] } }],
    } }) }, false);
    expect(jarMeta(q)).toEqual(expect.objectContaining({ key: "mod:qmod", depends: [
      { key: "mod:qsl", name: "qsl", range: { style: "quilt", any: [">=1"] } }, { key: "mod:other_mod", name: "other_mod" },
      { key: "mod:anyof", name: "anyof", range: { style: "quilt", any: ["1.x", "2.x"] } }, { key: "mod:allof", name: "allof", range: { style: "quilt", any: [">=1 <2"] } },
    ], provides: [{ key: "mod:qmod", version: "1.0" }, { key: "mod:alias", version: "1" }, { key: "mod:alias2", version: "1.0" }] }));
  });

  it("mods.toml: mandatory = true の前提だけ。forge・minecraft・fml・javafml・lowcodefml・mixinextras は前提にしない。クライアント側だけの前提も数えない。[[mods]] の modId は全部提供する", () => {
    const toml = [
      'modLoader="javafml"', 'loaderVersion="[47,)"', "",
      "[[mods]]", 'modId="mymod"', 'version="1.0"', 'displayName="My Mod"', "",
      "[[mods]]", 'modId="mymod_api"', "",
      "[[dependencies.mymod]]", 'modId="forge"', "mandatory=true", 'versionRange="[47,)"', "",
      "[[dependencies.mymod]]", 'modId="minecraft"', "mandatory=true", "",
      "[[dependencies.mymod]]", 'modId="mixinextras"', "mandatory=true", "",
      "[[dependencies.mymod]]", 'modId="jei"', "mandatory=true", 'versionRange="[19.0,)"', 'side="BOTH"', "",
      "[[dependencies.mymod]]", 'modId="curios"', "mandatory=false", "",
      "[[dependencies.mymod]]", 'modId="clientonly"', "mandatory=true", 'side="CLIENT"', "",
    ].join("\n");
    expect(jarMeta(makeZip({ "META-INF/mods.toml": toml }, false))).toEqual(expect.objectContaining({ key: "mod:mymod",
      depends: [{ key: "mod:jei", name: "jei", range: { style: "maven", any: ["[19.0,)"] } }], provides: [{ key: "mod:mymod", version: "1.0" }, { key: "mod:mymod_api", version: "" }] }));
  });

  it("mods.toml の version が ${file.jarVersion} なら、MANIFEST.MF の Implementation-Version を版にする(無ければ分からない)", () => {
    const toml = '[[mods]]\nmodId="jarver"\nversion="${file.jarVersion}"\n';
    expect(jarMeta(makeZip({ "META-INF/mods.toml": toml, "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\nImplementation-Version: 4.4.9\r\n" }, false)).provides).toEqual([{ key: "mod:jarver", version: "4.4.9" }]);
    expect(jarMeta(makeZip({ "META-INF/mods.toml": toml }, false)).provides).toEqual([{ key: "mod:jarver", version: "" }]);
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
// パネルで直接置いた・消したとき: 問い合わせの覚え(10 秒)を捨てて、すぐ見えるようにする
const put = (server: string, name: string, data: Uint8Array) => { disk.set(`${server}/mods/${name}`, data); forgetPteroReads(); };
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
    forgetPteroReads();
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

  it("入っていても版の範囲を満たさなければ「版が合わない」(need・have。入れるは付けない)。版が分からないものは満たすとみなす", async () => {
    // Forge: geckolib(版なし)が入っている → 範囲があっても満たすとみなす
    const needs = (id: string, name: string, range: string) => makeZip({ "META-INF/mods.toml": ['[[mods]]', `modId="${id}"`, `displayName="${name}"`, "", `[[dependencies.${id}]]`, 'modId="geckolib"', "mandatory=true", `versionRange="${range}"`, ""].join("\n") }, false);
    put("frg00001", "needsnew.jar", needs("needsnew", "NeedsNew", "[4.4,)"));
    put("frg00001", "needsold.jar", needs("needsold", "NeedsOld", "[4.0,5.0)"));
    expect(await unmet("frg00001")).toEqual([]);
    disk.delete("frg00001/mods/geckolib.jar");
    put("frg00001", "geckolib-4.2.jar", makeZip({ "META-INF/mods.toml": '[[mods]]\nmodId="geckolib"\nversion="${file.jarVersion}"\n', "META-INF/MANIFEST.MF": "Implementation-Version: 4.2.0\n" }, false));
    expect(await unmet("frg00001")).toEqual([{ name: "geckolib", by: ["NeedsNew"], need: "[4.4,)", have: "4.2.0" }]);
    disk.delete("frg00001/mods/geckolib-4.2.jar");
    put("frg00001", "geckolib-4.5.jar", makeZip({ "META-INF/mods.toml": '[[mods]]\nmodId="geckolib"\nversion="4.5.1"\n' }, false));
    expect(await unmet("frg00001")).toEqual([]);

    // Fabric: Fabric API 0.100.0 が入っている。足りないもの(my-private-lib)とは別に出す。部品・provides の版も見る
    put("fab00001", "wantsnew.jar", fabricMod({ id: "wantsnew", name: "WantsNew", depends: { "fabric-api": ">=0.110", "fabric-api-base": ">=0.4", fabric: ["<0.50", ">=0.100"], "fabric-resource-loader-v0": ">=2.0" } }));
    expect(await unmet("fab00001")).toEqual([
      { name: "my-private-lib", by: ["MyMod"] },
      { name: "fabric-api", by: ["WantsNew"], need: ">=0.110", have: "0.100.0" },
      { name: "fabric-resource-loader-v0", by: ["WantsNew"], need: ">=2.0", have: "1.0" },
    ]);
    disk.delete("fab00001/mods/wantsnew.jar");
    forgetPteroReads();
  });

  it("jar が多すぎて全部は読めないとき(100 個を超える)は、誤って出さないよう Mod の前提は確かめない", async () => {
    for (let i = 0; i < 101; i++) put("big00001", `m${i}.jar`, fabricMod({ id: `m${i}`, depends: i === 0 ? { absent: "*" } : {} }));
    expect(await unmet("big00001")).toEqual([]);
  });
});
