// ライブラリの前提・変更内容・情報の編集・対応 MC・受け取る版・URL から足す(Pterodactyl・Modrinth・Spiget は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mcCovers, mcRange } from "~/lib/platforms";
import { parseSourceUrl } from "~/lib/sources";
import { installedMod, libraryItem } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { htmlToText } from "~/server/html-text";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const LP = "Vebnzrzj"; // LuckPerms(Modrinth が Vault を前提と言う)
const VAULT = "VaultPrj";
const BETA = "BetaPrj1"; // 正式版より新しいベータがある
const OTHER = "OtherPrj";
const files = new Map<string, string[]>([["plugins", []]]);
const asked: string[] = []; // Modrinth に版を問い合わせた URL

const version = (pid: string, id: string, number: string, type: string, date: string, deps: string[] = [], mc = ["1.20.4"]) => ({
  id, project_id: pid, version_number: number, version_type: type, date_published: date, loaders: ["paper"], game_versions: mc,
  dependencies: deps.map((d) => ({ project_id: d, dependency_type: "required" })),
  files: [{ primary: true, filename: `${pid}-${number}.jar`, url: `https://cdn.modrinth.com/data/${pid}/${pid}-${number}.jar`, size: 1, hashes: {} }],
});
const VERSIONS: Record<string, ReturnType<typeof version>[]> = {
  [LP]: [version(LP, "lp000001", "5.4.0", "release", "2026-01-01", [VAULT])],
  [VAULT]: [version(VAULT, "vault001", "1.7", "release", "2026-01-01")],
  [BETA]: [version(BETA, "beta0001", "1.0", "release", "2026-01-01"), version(BETA, "beta0002", "1.1-beta", "beta", "2026-02-01")],
  [OTHER]: [version(OTHER, "othr0001", "2.0", "release", "2026-01-01")],
};
const PROJECTS: Record<string, Record<string, unknown>> = {
  [LP]: { id: LP, title: "LuckPerms", slug: "luckperms", project_type: "plugin", game_versions: ["1.19.4", "1.21.4", "23w31a", "1.20.1"] },
  [VAULT]: { id: VAULT, title: "Vault", slug: "vault", project_type: "plugin", game_versions: ["1.20.4"] },
  [BETA]: { id: BETA, title: "BetaThing", slug: "betathing", project_type: "plugin", game_versions: [] },
  [OTHER]: { id: OTHER, title: "OtherPerms", slug: "otherperms", project_type: "plugin", game_versions: [] },
};

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === "/v2/projects") return json(JSON.parse(u.searchParams.get("ids")!).map((id: string) => PROJECTS[id]).filter(Boolean));
    const m = u.pathname.match(/^\/v2\/project\/([\w.-]+)(\/version)?$/);
    const p = m && (PROJECTS[m[1]] ?? Object.values(PROJECTS).find((x) => x.slug === m[1]));
    if (m && p && !m[2]) return json(p);
    if (m?.[2] && VERSIONS[m[1]]) {
      asked.push(url);
      const mc = u.searchParams.get("game_versions");
      return json(VERSIONS[m[1]].filter((v) => !mc || JSON.parse(mc).some((x: string) => v.game_versions.includes(x))));
    }
    const v = u.pathname.match(/^\/v2\/version\/(\w+)$/);
    const found = v && Object.values(VERSIONS).flat().find((x) => x.id === v[1]);
    if (found) return json({ ...found, changelog: `## ${found.version_number}\n<script>alert(1)</script>直しました` });
    return json({}, 404);
  }
  if (u.host === "api.spiget.org") {
    if (u.pathname === "/v2/resources/9089") return json({ id: 9089, name: "EssentialsX", tag: "", downloads: 1, external: false, premium: false, category: { id: 4 }, testedVersions: ["1.20", "1.21"] });
    if (u.pathname === "/v2/resources/9089/updates") {
      return json([{ id: 77, title: "2.21 の更新", date: 1767225600, description: Buffer.from("<p>Fixed &amp; <b>improved</b></p><ul><li>one</li></ul>").toString("base64") }]);
    }
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete)$/);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  if (m?.[1] === "pull") {
    files.set(body.directory, [...(files.get(body.directory) ?? []), body.filename]);
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") {
    files.set(body.root, (files.get(body.root) ?? []).filter((x) => !body.files.includes(x)));
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
let outsider: Headers;
let serverId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const item = async (title: string) => (await lib.catalog(owner)).items.find((i) => i.title === title)!;

async function join2(email: string, role: string) {
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
  sets = setService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  serverId = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, serverId, { platform: "paper", mcVersion: "1.20.4" });
  editor = await join2("editor@example.com", "editor");
  viewer = await join2("viewer@example.com", "viewer");
  outsider = t.headers(await t.signUp("よそ", "outsider@example.com"));
});

describe("画面とサーバーで共有する小さな処理", () => {
  it("配布元のページの URL を読む", () => {
    expect(parseSourceUrl("https://modrinth.com/plugin/luckperms/versions")).toEqual({ source: "modrinth", ref: "luckperms", type: "plugin" });
    expect(parseSourceUrl("https://www.spigotmc.org/resources/essentialsx.9089/")).toEqual({ source: "spigot", ref: "9089", type: "plugin" });
    expect(parseSourceUrl("https://www.curseforge.com/minecraft/mc-mods/jei")).toEqual({ source: "curseforge", ref: "jei", type: "mod" });
    expect(parseSourceUrl("https://hangar.papermc.io/ViaVersion/ViaVersion")?.source).toBe("hangar");
    expect(parseSourceUrl("https://example.com/plugin/x")).toBeNull();
    expect(parseSourceUrl("javascript:alert(1)")).toBeNull();
    expect(parseSourceUrl("modrinth.com/plugin/x")).toBeNull();
  });
  it("変更内容の HTML を文字にする(タグ・スクリプトは残さない)", () => {
    expect(htmlToText("<p>a &amp; b</p><script>alert(1)</script><ul><li>x</li></ul>&#x41;")).toBe("a & b\n\n・x\n\nA");
  });
  it("対応 MC の範囲と、含むか(1.20 は 1.20.x を含む)", () => {
    expect(mcRange(["1.21.4", "1.19.4", "23w31a", "1.20.1"])).toBe("1.19.4〜1.21.4");
    expect(mcRange(["1.20"])).toBe("1.20");
    expect(mcCovers(["1.20"], "1.20.4")).toBe(true);
    expect(mcCovers(["1.20"], "1.2")).toBe(false);
  });
});

describe("URL から足す", () => {
  it("編集者以上が、Modrinth・SpigotMC のページの URL から足せる。Hangar・ほかのサイトは断る", async () => {
    expect(await code(lib.addFromUrl(viewer, "https://modrinth.com/plugin/luckperms"))).toBe(403);
    expect(await lib.addFromUrl(editor, "https://modrinth.com/plugin/luckperms")).toMatchObject({ title: "LuckPerms" });
    expect((await item("LuckPerms")).projectId).toBe(LP);
    expect(await lib.addFromUrl(owner, "https://www.spigotmc.org/resources/essentialsx.9089/")).toMatchObject({ title: "EssentialsX" });
    expect(await code(lib.addFromUrl(owner, "https://hangar.papermc.io/ViaVersion/ViaVersion"))).toBe(400);
    expect(await code(lib.addFromUrl(owner, "https://example.com/plugin/x"))).toBe(400);
    expect(await code(lib.addFromUrl(owner, "https://modrinth.com/plugin/nothing-here"))).toBe(404);
  });
});

describe("前提", () => {
  it("サーバーに入っているものの前提(配布元の必須)が無ければ、サーバー・ライブラリの両方で知らせる", async () => {
    await lib.addItem(owner, VAULT);
    files.set("plugins", ["LuckPerms-5.4.0.jar"]);
    await t.db.insert(installedMod).values({ id: "im1", serverId, source: "modrinth", projectId: LP, versionId: "lp000001", versionNumber: "5.4.0", title: "LuckPerms", filename: "LuckPerms-5.4.0.jar" });
    const s = await lib.serverDeps(viewer, serverId);
    expect(s.missing.map((m) => [m.title, m.by, !!m.itemId])).toEqual([["Vault", ["LuckPerms"], true]]);
    expect(await code(lib.serverDeps(outsider, serverId))).toBe(404);
    const all = await lib.missingDeps(viewer);
    const lp = await item("LuckPerms");
    expect(all.items).toEqual([{ itemId: lp.id, servers: [{ serverId, serverName: "ロビー", deps: [expect.objectContaining({ title: "Vault", source: "modrinth", projectId: VAULT })] }] }]);
    expect((await lib.missingDeps(viewer, (await item("Vault")).id)).items).toEqual([]);
    expect((await lib.missingDeps(outsider)).items).toEqual([]);
    // ワンクリックで入れると、警告は消える
    await lib.install(editor, serverId, VAULT);
    expect((await lib.serverDeps(viewer, serverId)).missing).toEqual([]);
  });

  it("前提を手で決められる(編集者以上・同じチームのものだけ)。サーバー・セットの確かめにも出る", async () => {
    const ess = await item("EssentialsX");
    const lp = await item("LuckPerms");
    expect(await code(lib.linkDep(viewer, lp.id, ess.id, true))).toBe(403);
    expect(await code(lib.linkDep(outsider, lp.id, ess.id, true))).toBe(404);
    expect(await code(lib.linkDep(editor, lp.id, lp.id, true))).toBe(400);
    await lib.linkDep(editor, lp.id, ess.id, true);
    expect((await item("LuckPerms")).deps).toEqual([ess.id]);
    expect((await lib.serverDeps(viewer, serverId)).missing.map((m) => [m.title, m.source])).toEqual([["EssentialsX", "spigot"]]);
    const set = await sets.create(owner, "基本");
    await sets.toggleItem(owner, set.id, lp.id, true);
    const r = await sets.missingDeps(viewer, set.id, "paper");
    expect(r.missing.map((m) => m.title)).toEqual(["EssentialsX", "Vault"]);
    expect(await sets.addDeps(editor, set.id, [{ source: "spigot", projectId: "9089" }], "paper")).toEqual({ added: ["EssentialsX"] });
    await lib.linkDep(editor, lp.id, ess.id, false);
    expect((await lib.serverDeps(viewer, serverId)).missing).toEqual([]);
  });
});

describe("変更内容", () => {
  it("アイテムの版の一覧と、版ごとの変更内容(文字として)。SpigotMC は更新のお知らせを版の代わりにする", async () => {
    const lp = await item("LuckPerms");
    const vs = await lib.itemVersions(viewer, lp.id);
    expect(vs.map((v) => [v.versionNumber, v.type])).toEqual([["5.4.0", "release"]]);
    expect((await lib.itemChangelog(viewer, lp.id, "lp000001")).text).toContain("直しました");
    expect(await code(lib.itemChangelog(viewer, lp.id, "vault001"))).toBe(404); // ほかのプロジェクトの版
    expect(await code(lib.itemVersions(outsider, lp.id))).toBe(404);
    const ess = await item("EssentialsX");
    const up = await lib.itemVersions(viewer, ess.id);
    expect(up[0]).toMatchObject({ versionNumber: "2.21 の更新", changelog: "Fixed & improved\n\n・one" });
    expect(await code(lib.itemChangelog(viewer, ess.id, "77"))).toBe(400);
  });
});

describe("アイテムの情報を直す・受け取る版", () => {
  it("直せるのは管理者以上。種類・動く作り・対応 MC・受け取る版を確かめる", async () => {
    const lp = await item("LuckPerms");
    const ok = { projectType: "plugin", loaders: ["spigot"], mcVersions: ["1.21.4"], channel: "all" };
    expect(await code(lib.editItem(editor, lp.id, ok))).toBe(403);
    expect(await code(lib.editItem(outsider, lp.id, ok))).toBe(404);
    expect(await code(lib.editItem(owner, lp.id, { ...ok, projectType: "world" }))).toBe(400);
    expect(await code(lib.editItem(owner, lp.id, { ...ok, loaders: ["sponge"] }))).toBe(400);
    expect(await code(lib.editItem(owner, lp.id, { ...ok, mcVersions: ["1.21.x"] }))).toBe(400);
    expect(await code(lib.editItem(owner, lp.id, { ...ok, channel: "nightly" }))).toBe(400);
    await lib.editItem(owner, lp.id, ok);
    expect(await item("LuckPerms")).toMatchObject({ loaders: ["spigot"], mcVersions: ["1.21.4"], mc: ["1.21.4"], channel: "all" });
    await lib.editItem(owner, lp.id, { projectType: "plugin", loaders: null, mcVersions: null, channel: "" });
    expect(await item("LuckPerms")).toMatchObject({ loaders: null, mcVersions: null, channel: "" });
  });

  it("対応 MC を直して、サーバーのバージョンを含むなら、配布元の対応 MC では絞らない。動く作りも直したものを使う", async () => {
    await lib.addItem(owner, OTHER);
    const o = await item("OtherPerms");
    await lib.editItem(owner, o.id, { projectType: "plugin", loaders: ["bukkit"], mcVersions: ["1.20"], channel: "" });
    await t.db.insert(installedMod).values({ id: "im9", serverId, source: "modrinth", projectId: OTHER, versionId: "othr0001", versionNumber: "2.0", title: "OtherPerms", filename: "OtherPrj-2.0.jar" });
    asked.length = 0;
    await lib.updates(owner, serverId);
    const q = new URL(asked.find((a) => a.includes(OTHER))!).searchParams;
    expect(q.get("game_versions")).toBeNull();
    expect(q.get("loaders")).toBe(JSON.stringify(["bukkit"]));
  });

  it("受け取る版: 既定は正式版だけ。アイテムごと・チームの既定で、ベータ版も入れられる", async () => {
    await lib.addItem(owner, BETA);
    expect((await lib.catalog(viewer)).channel).toBe("release");
    expect((await lib.install(editor, serverId, BETA)).versionNumber).toBe("1.0");
    expect(await code(lib.setChannel(editor, "all"))).toBe(403);
    expect(await code(lib.setChannel(owner, "nightly"))).toBe(400);
    await lib.setChannel(owner, "all");
    expect((await lib.catalog(viewer)).channel).toBe("all");
    expect((await lib.updates(owner, serverId)).find((u) => u.projectId === BETA)?.latest).toBe("1.1-beta");
    await lib.editItem(owner, (await item("BetaThing")).id, { projectType: "plugin", loaders: null, mcVersions: null, channel: "release" });
    expect((await lib.updates(owner, serverId)).find((u) => u.projectId === BETA)).toBeUndefined();
    await lib.setChannel(owner, "release");
  });
});

describe("配布元を付け替える", () => {
  it("管理者以上が、URL で別のプロジェクトに付け替える。サーバーに入っているものの記録も付け替わる。重なるもの・アップロードは断る", async () => {
    const o = await item("OtherPerms");
    expect(await code(lib.relinkItem(editor, o.id, "https://modrinth.com/plugin/vault"))).toBe(403);
    expect(await code(lib.relinkItem(owner, o.id, "https://modrinth.com/plugin/vault"))).toBe(400); // Vault はもうある
    expect(await code(lib.relinkItem(owner, o.id, "https://modrinth.com/plugin/otherperms"))).toBe(400); // 同じ
    await t.db.delete(libraryItem).where(eq(libraryItem.projectId, VAULT));
    expect(await lib.relinkItem(owner, o.id, "https://modrinth.com/plugin/vault")).toEqual({ title: "Vault" });
    const now = await t.db.select().from(installedMod).where(eq(installedMod.id, "im9"));
    expect([now[0].source, now[0].projectId]).toEqual(["modrinth", VAULT]);
    expect((await lib.catalog(owner)).items.find((i) => i.id === o.id)).toMatchObject({ title: "Vault", projectId: VAULT });
  });
});

describe("対応 MC", () => {
  it("1 日ごとに配布元から取り直す(スナップショットは除く)。直したものがあれば、そちらを出す", async () => {
    const now = new Date();
    expect(await lib.refreshInfo(now)).toBeGreaterThan(0);
    expect((await item("LuckPerms")).mc).toEqual(["1.19.4", "1.20.1", "1.21.4"]);
    expect((await item("EssentialsX")).mc).toEqual(["1.20", "1.21"]);
    expect(await lib.refreshInfo(new Date(now.getTime() + 60_000))).toBe(0); // 1 日たつまで取り直さない
    expect(await lib.refreshInfo(new Date(now.getTime() + 25 * 60 * 60_000))).toBeGreaterThan(0);
  });
});
