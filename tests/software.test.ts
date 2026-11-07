// サーバー本体(jar)の確認・入れ替え・戻す(Pterodactyl と PaperMC は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { parseBuild, softwareService } from "~/server/software";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
// サーバーのフォルダの一番上(名前 → 大きさ)
const root = new Map<string, number>([["server.jar", 100], ["server.properties", 10]]);
let latestUrl = "https://fill-data.papermc.io/v1/objects/abc/paper-1.21.4-232.jar";
const powers: string[] = [];

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "fill.papermc.io") {
    if (u.pathname === "/v3/projects/paper/versions/1.21.4/builds/latest") {
      return json({ id: 232, downloads: { "server:default": { name: "paper-1.21.4-232.jar", url: latestUrl } } });
    }
    if (u.pathname === "/v3/projects/paper/versions/1.21.5/builds/latest") {
      return json({ id: 10, downloads: { "server:default": { name: "paper-1.21.5-10.jar", url: "https://fill-data.papermc.io/v1/objects/def/paper-1.21.5-10.jar" } } });
    }
    if (u.pathname === "/v3/projects/paper") return json({ versions: { "1.21": ["1.21.5", "1.21.5-rc1", "1.21.4", "1.21.3"] } });
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/\/files\/(list|contents|pull|rename|delete)$|\/(power)$/);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "list") {
    if ((u.searchParams.get("directory") ?? "/") !== "/") return json({ data: [] });
    return json({ data: [...root].map(([name, size]) => ({ attributes: { name, size, is_file: true } })) });
  }
  if (m?.[1] === "contents") return u.searchParams.get("file") === "/version_history.json" || u.searchParams.get("file") === "version_history.json"
    ? new Response(JSON.stringify({ currentVersion: "git-Paper-230 (MC: 1.21.4)" })) : json({}, 404);
  if (m?.[1] === "pull") { root.set(body.filename, 200); return new Response(null, { status: 204 }); }
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
let id: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  sw = softwareService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  id = (await servers.listServers(owner))[0].id;
  await libraryService(deps).setProfile(owner, id, { platform: "paper", mcVersion: "" });
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
});

describe("ビルドの読み取り", () => {
  it("version_history.json・jar の名前から、Minecraft のバージョンとビルドを読む", () => {
    expect(parseBuild("git-Paper-232 (MC: 1.21.4)")).toEqual({ mc: "1.21.4", build: "232" });
    expect(parseBuild("1.21.4-232-abcdef (MC: 1.21.4)")).toEqual({ mc: "1.21.4", build: "232" });
    expect(parseBuild("paper-1.21.4-232.jar")).toEqual({ mc: "1.21.4", build: "232" });
    expect(parseBuild("fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar")).toEqual({ mc: "1.21.1", build: "0.16.9" });
    expect(parseBuild("server.jar")).toEqual({ mc: "", build: "" });
  });
});

describe("サーバー本体", () => {
  it("今のビルドと、新しいビルドがあるかがわかる(見るのは誰でも)", async () => {
    expect(await sw.info(viewer, id)).toMatchObject({ platform: "paper", jar: "server.jar", mc: "1.21.4", build: "230", update: true, latest: { build: "232" }, backup: null });
  });

  it("入れ替えるのは管理者以上。配布元の外の URL は取り込まない", async () => {
    expect(await code(sw.update(viewer, id))).toBe(403);
    latestUrl = "https://evil.example.com/paper.jar";
    expect(await code(sw.update(owner, id))).toBe(400);
    expect(root.get("server.jar")).toBe(100);
    latestUrl = "https://fill-data.papermc.io/v1/objects/abc/paper-1.21.4-232.jar";
  });

  it("今の jar を名前を変えて残し、同じ名前で新しい jar を取り込む。再起動もできる", async () => {
    expect(await sw.update(owner, id, true)).toEqual({ build: "232", restarted: true });
    expect([...root.keys()].sort()).toEqual(["server.jar", "server.jar.craftshelf-old", "server.properties"]);
    expect(root.get("server.jar")).toBe(200);
    expect(powers).toEqual(["restart"]);
    expect(await sw.info(owner, id)).toMatchObject({ build: "232", update: false, backup: { jar: "server.jar.craftshelf-old", build: "230" } });
  });

  it("入れ替える前の jar に戻せる。もう一度戻すと、また新しい jar になる", async () => {
    expect(await code(sw.rollback(viewer, id))).toBe(403);
    expect(await sw.rollback(owner, id)).toEqual({ build: "230" });
    expect(root.get("server.jar")).toBe(100);
    expect(await sw.info(owner, id)).toMatchObject({ build: "230", backup: { build: "232" } });
    await sw.rollback(owner, id);
    expect(root.get("server.jar")).toBe(200);
  });
});

describe("Minecraft のバージョンを上げる", () => {
  it("上げられるバージョン(正式版だけ)がわかり、選んだバージョンのビルドに入れ替えて、サーバーの種類のバージョンも変える", async () => {
    expect((await sw.info(owner, id)).mcNewer).toEqual(["1.21.5"]);
    expect(await code(sw.update(owner, id, false, "1.30.0"))).toBe(400);
    expect(await sw.update(owner, id, false, "1.21.5")).toMatchObject({ build: "10" });
    expect(await sw.info(owner, id)).toMatchObject({ mc: "1.21.5", build: "10", mcNewer: [] });
  });
});
