// データパック・リソースパック・シェーダー・Modパック(03.58.00 から)。フォルダのサーバーと、偽物の Modrinth で確かめる
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { analyzePack } from "~/server/jar";
import { libraryService } from "~/server/library";
import { modpackService } from "~/server/modpack";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { uploadService } from "~/server/uploads";
import { setup } from "./helpers";
import { makeZip } from "./zip";

const SECRET = "test-secret-0123456789-0123456789-abcd";
const DP = "DPDPDPDP";
const RP = "RPRPRPRP";
const MP = "MPMPMPMP";
let dpVer = "1.0";
let mpVer = "1.0";
let lastFacets = "";
const datapackZip = makeZip({ "pack.mcmeta": "{\"pack\":{\"pack_format\":61}}", "data/x/function/a.mcfunction": "say hi" });
const mrpack = () => makeZip({ "modrinth.index.json": JSON.stringify({ name: "My Pack", versionId: mpVer, files: [{ path: "mods/sodium.jar", hashes: { sha1: "a".repeat(40) } }] }) });

const cdn = (name: string) => `https://cdn.modrinth.com/data/x/${name}`;
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "cdn.modrinth.com") return new Response(new Uint8Array(u.pathname.endsWith(".mrpack") ? mrpack() : datapackZip) as BodyInit);
  if (u.host !== "api.modrinth.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/v2/search") {
    lastFacets = u.searchParams.get("facets") ?? "";
    return json({ hits: [] });
  }
  if (u.pathname === `/v2/project/${DP}`) return json({ id: DP, title: "Villager Trades", slug: "villager", project_type: "mod" });
  if (u.pathname === `/v2/project/${RP}`) return json({ id: RP, title: "Faithful", slug: "faithful", project_type: "resourcepack" });
  if (u.pathname === `/v2/project/${MP}`) return json({ id: MP, title: "My Pack", slug: "my-pack", project_type: "modpack" });
  if (u.pathname === `/v2/project/${DP}/version`) {
    // データパックとしての版と、同じプロジェクトの Mod としての版(こちらは選ばない)
    const all = [
      { id: `dp${dpVer.replace(".", "")}0000`.slice(0, 8), version_number: dpVer, version_type: "release", date_published: "2026-01-02", loaders: ["datapack"], game_versions: ["1.21.4"],
        files: [{ primary: true, filename: `villager-${dpVer}.zip`, url: cdn(`villager-${dpVer}.zip`), size: 1, hashes: {} }] },
      { id: "dpmod001", version_number: `${dpVer}-fabric`, version_type: "release", date_published: "2026-01-03", loaders: ["fabric"], game_versions: ["1.21.4"],
        files: [{ primary: true, filename: "villager-fabric.jar", url: cdn("villager-fabric.jar"), size: 1, hashes: {} }] },
    ];
    const want = u.searchParams.get("loaders");
    return json(want ? all.filter((v) => v.loaders.some((l) => want.includes(`"${l}"`))) : all);
  }
  if (u.pathname === `/v2/project/${MP}/version`) {
    return json([{ id: `mp${mpVer.replace(".", "")}0000`.slice(0, 8), version_number: mpVer, version_type: "release", date_published: "2026-01-01", loaders: ["fabric"], game_versions: ["1.21.4"],
      files: [{ primary: true, filename: `pack-${mpVer}.mrpack`, url: cdn(`pack-${mpVer}.mrpack`), size: 1, hashes: {} }] }]);
  }
  if (u.pathname === "/v2/version_files") {
    const { hashes } = JSON.parse(String(init!.body)) as { hashes: string[] };
    return json(Object.fromEntries(hashes.filter((h) => h === "a".repeat(40)).map((h) => [h, { id: "SODIUMV1", project_id: "SODIUMAA", version_number: "0.6" }])));
  }
  if (u.pathname === "/v2/projects") return json([{ id: "SODIUMAA", title: "Sodium", slug: "sodium", icon_url: "" }]);
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let deps: Parameters<typeof libraryService>[0];
let lib: ReturnType<typeof libraryService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
let outsider: Headers;
let id: string; // Paper(ワールドは lobby)
let proxy: string; // Velocity(ワールドが無い)
let root: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const packs = () => readdirSync(join(root, "lobby", "datapacks")).sort();

async function join2(email: string, role: string) {
  const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
  const cookie = await t.signUp(email, email);
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  return t.headers(cookie);
}

beforeAll(async () => {
  t = await setup(); // フォルダのサーバー・アップロードは deps.local で使う(人を招待するため、登録を閉じない)
  const dataDir = mkdtempSync(join(tmpdir(), "cs-dp-data-"));
  deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake, local: { dataDir } };
  lib = libraryService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  root = mkdtempSync(join(tmpdir(), "cs-dp-srv-"));
  writeFileSync(join(root, "server.properties"), "motd=x\nlevel-name=lobby\n");
  mkdirSync(join(root, "plugins"));
  const servers = serverService(deps);
  id = (await servers.addLocal(owner, { rootDir: root, name: "ロビー" })).id;
  await lib.setProfile(owner, id, { platform: "paper", mcVersion: "1.21.4" });
  const proxyRoot = mkdtempSync(join(tmpdir(), "cs-dp-px-"));
  proxy = (await servers.addLocal(owner, { rootDir: proxyRoot, name: "プロキシ" })).id;
  await lib.setProfile(owner, proxy, { platform: "velocity", mcVersion: "" });
  editor = await join2("editor@example.com", "editor");
  viewer = await join2("viewer@example.com", "viewer");
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
});

describe("データパック", () => {
  it("ライブラリに足せる。入れられるサーバーは、ワールドのあるものだけ", async () => {
    await lib.addItem(editor, DP, "modrinth", "datapack");
    const cat = await lib.catalog(viewer);
    expect(cat.items.map((i) => [i.title, i.projectType])).toEqual([["Villager Trades", "datapack"]]);
    expect(Object.fromEntries(cat.servers.map((s) => [s.name, s.kinds]))).toEqual({ ロビー: ["plugin", "datapack"], プロキシ: ["plugin"] });
  });

  it("サーバーでデータパックを探せる(サーバーの種類の作りでは絞らない)", async () => {
    await lib.search(viewer, id, "", "modrinth", "datapack");
    expect(lastFacets).toContain("project_type:datapack");
    expect(lastFacets).not.toContain("categories:paper");
    expect(await code(lib.search(viewer, proxy, "", "modrinth", "datapack"))).toBe(400);
  });

  it("入れると、ワールドの datapacks に .zip を置く(Mod としての版は選ばない)。入っているものにデータパックとして出る", async () => {
    expect(await code(lib.install(viewer, id, DP))).toBe(403);
    expect(await code(lib.install(outsider, id, DP))).toBe(404);
    expect(await code(lib.install(editor, proxy, DP))).toBe(400);
    const r = await lib.install(editor, id, DP);
    expect(r.filename).toBe("villager-1.0.zip");
    expect(packs()).toEqual(["villager-1.0.zip"]);
    expect(readdirSync(join(root, "plugins"))).toEqual([]);
    const inst = await lib.installed(viewer, id);
    expect(inst.datapacks).toBe("lobby/datapacks");
    expect(inst.items.map((i) => [i.title, i.datapack, i.versionNumber])).toEqual([["Villager Trades", true, "1.0"]]);
    expect((await lib.versions(viewer, id, "modrinth", DP)).map((v) => v.versionNumber)).toEqual(["1.0"]);
  });

  it("新しい版がわかり、更新すると古い .zip は消える", async () => {
    expect(await lib.updates(viewer, id)).toEqual([]);
    dpVer = "1.1";
    expect((await lib.updates(viewer, id)).map((u) => [u.current, u.latest])).toEqual([["1.0", "1.1"]]);
    expect(await lib.outdated(viewer)).toHaveLength(1);
    await lib.install(editor, id, DP);
    expect(packs()).toEqual(["villager-1.1.zip"]);
  });

  it("無効にする・外す・元に戻すは、datapacks の中で行う", async () => {
    await lib.setEnabled(editor, id, "villager-1.1.zip", false);
    expect(packs()).toEqual(["villager-1.1.zip.disabled"]);
    await lib.setEnabled(editor, id, "villager-1.1.zip.disabled", true);
    await lib.remove(editor, id, "villager-1.1.zip");
    expect(packs()).toEqual(["villager-1.1.zip.craftshelf-removed"]);
    const gone = (await lib.changes(viewer, id))[0];
    await lib.undo(editor, id, gone.id);
    expect(packs()).toEqual(["villager-1.1.zip"]);
    expect((await lib.installed(viewer, id)).items[0].projectId).toBe(DP);
  });

  it("セットで入れる・そろえる。リソースパックはサーバーに入れない", async () => {
    await lib.addItem(editor, RP);
    const cat = await lib.catalog(viewer);
    const rp = cat.items.find((i) => i.projectType === "resourcepack")!;
    expect(await code(lib.install(editor, id, RP))).toBe(400);
    const sets = setService(deps);
    const s = await sets.create(editor, "ワールド");
    for (const i of cat.items) await sets.toggleItem(editor, s.id, i.id, true);
    dpVer = "1.2";
    const r = await sets.apply(editor, s.id, id);
    expect(r.map((x) => [x.title, x.status])).toEqual([["Faithful", "skipped"], ["Villager Trades", "present"]]);
    expect(r[0].detail).toBe("リソースパックなので、Paper のサーバーには入れません");
    await sets.bind(editor, id, s.id);
    expect((await sets.sync(editor, id)).find((x) => x.title === "Villager Trades")).toMatchObject({ status: "updated", detail: "1.1 → 1.2" });
    expect(packs()).toEqual(["villager-1.2.zip"]);
    await lib.removeItem(editor, rp.id);
  });
});

describe("Modパック", () => {
  let itemId: string;
  it("ライブラリに Modパックとして持ち、そこからセットを作る(使った版を覚える)。作れるのは編集者以上", async () => {
    itemId = (await lib.addItem(editor, MP, "modrinth", "modpack")).id;
    const packsSvc = modpackService(deps);
    expect(await code(packsSvc.fromItem(viewer, itemId))).toBe(403);
    expect(await code(packsSvc.fromItem(outsider, itemId))).toBe(404);
    expect(await code(packsSvc.fromItem(editor, (await lib.catalog(viewer)).items.find((i) => i.projectType === "datapack")!.id))).toBe(400);
    const r = await packsSvc.fromItem(editor, itemId);
    expect(r).toMatchObject({ name: "My Pack 1.0", added: 1, version: "1.0", applied: null });
    expect((await lib.catalog(viewer)).items.find((i) => i.id === itemId)?.pack).toEqual({ used: { id: "mp100000", number: "1.0" }, latest: { id: "mp100000", number: "1.0" } });
    expect(await code(lib.install(editor, id, MP))).toBe(400); // サーバーには「Modパックをサーバーに入れる」から
  });

  it("新しい版が出たら、一度だけ知らせる", async () => {
    mpVer = "2.0";
    await lib.refreshInfo(new Date(Date.now() + 2 * 86_400_000));
    await lib.refreshInfo(new Date(Date.now() + 4 * 86_400_000));
    const notes = await t.db.select().from(auditLog).where(eq(auditLog.action, "Modパックに新しい版があります"));
    expect(notes.map((n) => [n.target, n.detail, n.kind])).toEqual([["My Pack", "1.0 → 2.0", "updates"]]);
    expect((await lib.catalog(viewer)).items.find((i) => i.id === itemId)?.pack?.latest).toEqual({ id: "mp200000", number: "2.0" });
  });
});

describe("アップロード(zip)", () => {
  it("中身でデータパック・リソースパック・シェーダー・Modパックを見分ける", () => {
    expect(analyzePack(datapackZip, "Trades-2.1.zip")).toMatchObject({ projectType: "datapack", name: "Trades", version: "2.1" });
    expect(analyzePack(makeZip({ "Pack/pack.mcmeta": "{}", "Pack/assets/minecraft/x.png": "x" }), "Faithful.zip").projectType).toBe("resourcepack");
    expect(analyzePack(makeZip({ "shaders/final.fsh": "x" }), "BSL_v8.zip").projectType).toBe("shader");
    expect(analyzePack(mrpack(), "x.mrpack")).toMatchObject({ projectType: "modpack", name: "My Pack" });
    expect(analyzePack(makeZip({ "readme.txt": "x" }), "x.zip").projectType).toBeNull();
  });

  it("zip をライブラリに載せ、サーバーのデータパックとして入れられる", async () => {
    const up = uploadService(deps);
    expect(await code(up.ingest(editor, "notes.txt", new Uint8Array([1])))).toBe(400);
    expect(await code(up.ingest(editor, "x.zip", makeZip({ "readme.txt": "x" })))).toBe(400);
    const r = await up.ingest(editor, "Mine-1.0.zip", makeZip({ "pack.mcmeta": "{}", "data/mine/a.json": "{}" }));
    expect(r).toMatchObject({ projectType: "datapack", title: "Mine", version: "1.0" });
    await lib.install(editor, id, r.projectId, "upload");
    expect(existsSync(join(root, "lobby", "datapacks", "Mine-1.0.zip"))).toBe(true);
  });
});
