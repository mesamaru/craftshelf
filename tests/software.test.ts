// サーバー本体(jar)の確認・ビルドを選んで入れ替える・残した jar に戻す・種類の判定(Pterodactyl と配布元は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { serverProfile } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { KEEP_JARS, SOFTWARE_MEMO, detectServer, parseBuild, softwareClient, softwareOfName, softwareService } from "~/server/software";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
// サーバーのフォルダの一番上(名前 → 大きさ)
const root = new Map<string, number>([["server.jar", 100], ["server.properties", 10]]);
let evil = false;
const powers: string[] = [];
const paperBuild = (v: string, id: number, channel = "STABLE") => ({
  id, channel, downloads: { "server:default": { name: `paper-${v}-${id}.jar`, url: evil ? "https://evil.example.com/paper.jar" : `https://fill-data.papermc.io/v1/objects/x/paper-${v}-${id}.jar` } },
});
let pulled = "";

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "fill.papermc.io") {
    if (u.pathname === "/v3/projects/paper/versions/1.21.4/builds") return json([paperBuild("1.21.4", 230), paperBuild("1.21.4", 232), paperBuild("1.21.4", 233, "ALPHA"), paperBuild("1.21.4", 231)]);
    if (u.pathname === "/v3/projects/paper/versions/1.21.5/builds") return json([paperBuild("1.21.5", 10)]);
    if (u.pathname === "/v3/projects/paper/versions/1.21.3/builds") return json([paperBuild("1.21.3", 80)]);
    if (u.pathname === "/v3/projects/paper") return json({ versions: { "1.21": ["1.21.5", "1.21.5-rc1", "1.21.4", "1.21.3"] } });
    return json({}, 404);
  }
  if (u.host === "api.leafmc.one") {
    if (u.pathname === "/v2/projects/leaf") return json({ versions: ["1.21.4", "1.21.5"] });
    if (u.pathname === "/v2/projects/leaf/versions/1.21.4/builds") return json({ builds: [{ build: 1, channel: "default", downloads: { primary: { name: "leaf-1.21.4-1.jar" } } }, { build: 2, channel: "experimental", downloads: { primary: { name: "leaf-1.21.4-2.jar" } } }] });
    return json({}, 404);
  }
  if (u.host === "files.minecraftforge.net") return json({ promos: { "1.20.1-recommended": "47.3.0" } });
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }, { attributes: { identifier: "eeee5555", name: "生存" } }], meta: { pagination: { total_pages: 1 } } });
  // 2 台目: egg と起動の変数だけで判定できるサーバー
  if (u.pathname === "/api/client/servers/eeee5555") return json({ attributes: { relationships: {
    egg: { attributes: { name: "Purpur" } }, variables: { data: [{ attributes: { env_variable: "MINECRAFT_VERSION", server_value: "1.21.4" } }, { attributes: { env_variable: "SERVER_JARFILE", server_value: "server.jar" } }] },
  } } });
  if (u.pathname.startsWith("/api/client/servers/eeee5555/")) return u.pathname.endsWith("/files/list") ? json({ data: [{ attributes: { name: "server.jar", size: 1, is_file: true } }] }) : json({}, 404);
  const m = u.pathname.match(/\/files\/(list|contents|pull|rename|delete)$|\/(power)$/);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "list") {
    if ((u.searchParams.get("directory") ?? "/") !== "/") return json({ data: [] });
    return json({ data: [...root].map(([name, size]) => ({ attributes: { name, size, is_file: true } })) });
  }
  if (m?.[1] === "contents") return u.searchParams.get("file")?.replace(/^\//, "") === "version_history.json"
    ? new Response(JSON.stringify({ currentVersion: "git-Paper-230 (MC: 1.21.4)" })) : json({}, 404);
  if (m?.[1] === "pull") { pulled = body.url; root.set(body.filename, 200 + root.size); return new Response(null, { status: 204 }); }
  if (m?.[1] === "rename") {
    for (const f of body.files) { if (!root.has(f.from)) return json({}, 404); root.set(f.to, root.get(f.from)!); root.delete(f.from); }
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") { for (const f of body.files) root.delete(f); return new Response(null, { status: 204 }); }
  if (m?.[2] === "power") { powers.push(body.signal); return new Response(null, { status: 204 }); }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let sw: ReturnType<typeof softwareService>;
let owner: Headers;
let viewer: Headers;
let outsider: Headers;
let id: string;
let second: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const olds = () => [...root.keys()].filter((n) => n.startsWith("server.jar.craftshelf-old"));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  sw = softwareService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234", "eeee5555"]);
  const list = await servers.listServers(owner);
  id = list.find((s) => s.name === "ロビー")!.id;
  second = list.find((s) => s.name === "生存")!.id;
  await libraryService(deps).setProfile(owner, id, { platform: "paper", mcVersion: "" });
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
  outsider = t.headers(await t.signUp("ほかのチーム", "other@example.com"));
});

describe("ビルドと種類の読み取り", () => {
  it("version_history.json・jar の名前から、Minecraft のバージョンとビルドを読む", () => {
    expect(parseBuild("git-Paper-232 (MC: 1.21.4)")).toEqual({ mc: "1.21.4", build: "232" });
    expect(parseBuild("1.21.4-232-abcdef (MC: 1.21.4)")).toEqual({ mc: "1.21.4", build: "232" });
    expect(parseBuild("paper-1.21.4-232.jar")).toEqual({ mc: "1.21.4", build: "232" });
    expect(parseBuild("fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar")).toEqual({ mc: "1.21.1", build: "0.16.9" });
    expect(parseBuild("server.jar")).toEqual({ mc: "", build: "" });
  });

  it("jar・egg の名前からサーバー本体の種類がわかる(ほかの名前を含むものを先に見る)", () => {
    expect(softwareOfName("pufferfish-paperclip-1.21.10-R0.1-SNAPSHOT-mojmap.jar")).toBe("pufferfish");
    expect(softwareOfName("leaf-1.21.4-50.jar")).toBe("leaf");
    expect(softwareOfName("minecraft_server.1.21.4.jar")).toBe("vanilla");
    expect(softwareOfName("Vanilla Minecraft")).toBe("vanilla");
    expect(softwareOfName("neoforge-21.1.1-installer.jar")).toBe("neoforge");
    expect(softwareOfName("server.jar")).toBeNull();
  });

  it("配布元のビルドは新しい順。いちばん新しいものは安定版の中から選ぶ。Forge は確かめるだけ", async () => {
    const c = softwareClient(fake);
    expect((await c.builds("paper", "1.21.4")).map((b) => b.build)).toEqual(["233", "232", "231", "230"]);
    expect((await c.latest("paper", "1.21.4"))?.build).toBe("232");
    expect(await c.mcVersions("paper")).toEqual(["1.21.5", "1.21.4", "1.21.3"]);
    expect((await c.latest("leaf", "1.21.4"))).toMatchObject({ build: "1", auto: true, url: "https://api.leafmc.one/v2/projects/leaf/versions/1.21.4/builds/1/downloads/leaf-1.21.4-1.jar" });
    expect(await c.latest("forge", "1.20.1")).toMatchObject({ build: "47.3.0", auto: false });
  });

  it("配布元の一覧は数分覚えて、同じ問い合わせを繰り返さない。つながらなかった結果は覚えない・捨てると取り直す", async () => {
    let n = 0;
    let down = true;
    const count: FetchLike = async (url, init) => {
      n++;
      if (down) throw new Error("つながらない");
      return fake(url, init);
    };
    const c = softwareClient(count);
    await expect(c.mcVersions("paper")).rejects.toThrow();
    down = false;
    n = 0;
    expect(await c.mcVersions("paper")).toEqual(["1.21.5", "1.21.4", "1.21.3"]);
    await c.mcVersions("paper");
    await c.latest("paper", "1.21.4");
    await c.latest("paper", "1.21.4");
    await c.builds("paper", "1.21.4");
    expect(n).toBe(2); // バージョンの一覧 1 回 + 1.21.4 のビルド 1 回
    c.forget();
    await c.latest("paper", "1.21.4");
    expect(n).toBe(3);
    expect(SOFTWARE_MEMO.ms).toBe(5 * 60_000);
  });
});

describe("サーバー本体", () => {
  it("今のビルドと、新しいビルドがあるかがわかる(見るのは誰でも。ほかのチームからは見えない)", async () => {
    expect(await sw.info(viewer, id)).toMatchObject({ software: "paper", jar: "server.jar", mc: "1.21.4", build: "230", update: true, latest: { build: "232" }, backup: null, backups: [] });
    expect(await code(sw.info(outsider, id))).toBe(404);
  });

  it("入れ替えるのは管理者以上。配布元の外の URL は取り込まない", async () => {
    expect(await code(sw.update(viewer, id))).toBe(403);
    evil = true;
    expect(await code(sw.update(owner, id))).toBe(400);
    evil = false;
    expect(root.get("server.jar")).toBe(100);
    expect(olds()).toEqual([]);
  });

  it("いちばん新しいビルドに入れ替え、今の jar を名前を変えて残す。再起動もできる", async () => {
    expect(await sw.update(owner, id, true)).toEqual({ build: "232", mc: "1.21.4", restarted: true });
    expect(olds()).toHaveLength(1);
    expect(root.get(olds()[0])).toBe(100);
    expect(powers).toEqual(["restart"]);
    expect(await sw.info(owner, id)).toMatchObject({ build: "232", update: false, backup: { build: "230" } });
  });

  it("一覧からビルドを選んで入れ替えられる(一覧に無いビルドは断る)", async () => {
    const b = await sw.builds(viewer, id);
    expect(b.mc).toBe("1.21.4");
    expect(b.builds.map((x) => x.build)).toContain("231");
    expect(await code(sw.install(viewer, id, { build: "231" }))).toBe(403);
    expect(await code(sw.install(owner, id, { build: "999" }))).toBe(404);
    expect(await sw.install(owner, id, { build: "231" })).toMatchObject({ build: "231" });
    expect(pulled).toContain("paper-1.21.4-231.jar");
  });

  it(`残す jar は ${KEEP_JARS} つまで(古いものから消す)。選んだ jar に戻せ、今の jar は代わりに残る`, async () => {
    for (const build of ["230", "232", "233", "230", "232"]) await sw.install(owner, id, { build });
    expect(olds()).toHaveLength(KEEP_JARS);
    const info = await sw.info(owner, id);
    expect(info.backups.map((o) => o.build)).toEqual(["230", "233", "232", "230", "231"]);
    expect(await code(sw.rollback(viewer, id))).toBe(403);
    const pick = info.backups[2]; // 232 の前の 233
    expect(await sw.rollback(owner, id, pick.file)).toEqual({ build: "232" });
    const after = await sw.info(owner, id);
    expect(after.build).toBe("232");
    expect(after.backups.map((o) => o.build)).toEqual(["232", "230", "233", "230", "231"]);
    expect(olds()).toHaveLength(KEEP_JARS);
  });

  it("Minecraft のバージョンを上げる・下げる。サーバーの種類のバージョンも変わる", async () => {
    expect((await sw.info(owner, id)).mcNewer).toEqual(["1.21.5"]);
    expect(await code(sw.install(owner, id, { mc: "1.30.0" }))).toBe(400);
    expect(await sw.install(owner, id, { mc: "1.21.5" })).toMatchObject({ build: "10", mc: "1.21.5" });
    expect(await sw.info(owner, id)).toMatchObject({ mc: "1.21.5", build: "10", mcNewer: [] });
    expect(await sw.install(owner, id, { mc: "1.21.3" })).toMatchObject({ build: "80", mc: "1.21.3" });
    const [p] = await t.db.select().from(serverProfile).where(eq(serverProfile.serverId, id));
    expect(p.mcVersion).toBe("1.21.3");
  });

  it("サーバー本体の種類を選べる(Leaf など、サーバーの種類だけでは分からないもの)。管理者以上", async () => {
    expect(await code(sw.setSoftware(viewer, id, "leaf"))).toBe(403);
    expect(await code(sw.setSoftware(owner, id, "nukkit"))).toBe(400);
    await sw.setSoftware(owner, id, "leaf");
    await sw.install(owner, id, { mc: "1.21.4" });
    expect(pulled).toBe("https://api.leafmc.one/v2/projects/leaf/versions/1.21.4/builds/1/downloads/leaf-1.21.4-1.jar");
    expect(await sw.info(owner, id)).toMatchObject({ software: "leaf", label: "Leaf", build: "1" });
  });
});

describe("Pterodactyl のサーバーの種類の判定", () => {
  it("足したときに egg と起動の変数から種類と Minecraft のバージョンを決める", async () => {
    const [p] = await t.db.select().from(serverProfile).where(eq(serverProfile.serverId, second));
    expect(p).toMatchObject({ platform: "purpur", mcVersion: "1.21.4" });
    expect(await code(sw.detect(viewer, second))).toBe(403);
    expect(await sw.detect(owner, second)).toEqual({ software: "purpur", platform: "purpur", mcVersion: "1.21.4" });
  });

  it("ファイルの一覧からも分かる(velocity.toml があればプロキシ。バージョンは持たない)", async () => {
    const files = (names: string[]) => ({ listFiles: async () => names.map((name) => ({ name, size: 1, isFile: name.includes("."), modifiedAt: "" })), readFile: async () => null }) as never;
    expect(await detectServer(files(["velocity.toml", "server.jar"]), "x")).toEqual({ software: "velocity", platform: "velocity", mcVersion: null });
    expect(await detectServer(files(["paper-1.21.4-100.jar"]), "x")).toEqual({ software: "paper", platform: "paper", mcVersion: "1.21.4" });
    expect(await detectServer(files(["minecraft_server.1.20.1.jar"]), "x")).toEqual({ software: "vanilla", platform: null, mcVersion: "1.20.1" });
  });
});

describe("新しいビルドのお知らせ", () => {
  it("新しいビルドがあれば、お知らせの 1 行を返す", async () => {
    root.set("server.jar", 1); // 入れ替えた記録と大きさが違う → version_history.json(Paper 230)を読む
    await sw.setSoftware(owner, id, "paper");
    const teamId = (await t.auth.api.getSession({ headers: owner }))!.session.activeOrganizationId!;
    expect(await sw.notice(teamId, id)).toBe("・サーバー本体(Paper 1.21.4): 230 → 232");
  });
});
