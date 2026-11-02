// セットの通しテスト(Pterodactyl と Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const PLUGIN = "Vebnzrzj";
const MOD = "AANobbMI";
const EMPTY = "EmptyPrj"; // このサーバーに合う版が無いプラグイン

const files = new Map<string, string[]>([["plugins", []]]);
const pulls: string[] = [];
let pluginLatest = { id: "ver00001", number: "5.4.0" };

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    const projects: Record<string, unknown> = {
      [PLUGIN]: { title: "LuckPerms", slug: "luckperms", project_type: "plugin" },
      [MOD]: { title: "Lithium", slug: "lithium", project_type: "mod" },
      [EMPTY]: { title: "Old", slug: "old", project_type: "plugin" },
    };
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && projects[m[1]] && !m[2]) return json(projects[m[1]]);
    if (m?.[2] && m[1] === PLUGIN) {
      const { id, number } = pluginLatest;
      return json([{ id, version_number: number, version_type: "release", date_published: "2026-01-01", loaders: ["paper"],
        files: [{ primary: true, filename: `LuckPerms-${number}.jar`, url: `https://cdn.modrinth.com/data/${PLUGIN}/LuckPerms-${number}.jar`, size: 1, hashes: {} }] }]);
    }
    if (m?.[2]) return json([]);
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先");
  if ((init?.headers as Record<string, string>)?.Authorization !== `Bearer ${KEY}`) return json({}, 401);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete)$/);
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  if (m?.[1] === "pull") {
    const body = JSON.parse(String(init?.body));
    pulls.push(body.filename);
    files.set(body.directory, [...(files.get(body.directory) ?? []), body.filename]);
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") {
    const body = JSON.parse(String(init?.body));
    files.set(body.root, (files.get(body.root) ?? []).filter((x) => !body.files.includes(x)));
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let viewer: Headers;
let outsider: Headers;
let serverId: string;
let setId: string;

const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const itemId = async (h: Headers, title: string) => (await lib.catalog(h)).items.find((i) => i.title === title)!.id;

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
  await lib.setProfile(owner, serverId, { platform: "paper", mcVersion: "" });
  for (const p of [PLUGIN, MOD, EMPTY]) await lib.addItem(owner, p);

  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
});

describe("セット", () => {
  it("作る・中身を入れるのは編集者以上。名前は必須", async () => {
    expect(await code(sets.create(viewer, "基本"))).toBe(403);
    expect(await code(sets.create(owner, "  "))).toBe(400);
    setId = (await sets.create(owner, "基本")).id;
    for (const title of ["LuckPerms", "Lithium", "Old"]) await sets.toggleItem(owner, setId, await itemId(owner, title), true);
    await sets.toggleItem(owner, setId, await itemId(owner, "LuckPerms"), true); // 2 回入れても 1 件
    expect(await code(sets.toggleItem(viewer, setId, await itemId(owner, "Old"), false))).toBe(403);
    const [s] = await sets.list(viewer);
    expect([s.name, s.items.map((i) => i.title)]).toEqual(["基本", ["Lithium", "LuckPerms", "Old"]]);
  });

  it("サーバーに入れると、種類の合うものだけを入れ、Mod は入れない。合う版が無いものは理由を返し、残りは続ける", async () => {
    expect(await code(sets.apply(viewer, setId, serverId))).toBe(403);
    const r = await sets.apply(owner, setId, serverId);
    expect(r.map((x) => [x.title, x.status])).toEqual([["Lithium", "skipped"], ["LuckPerms", "installed"], ["Old", "failed"]]);
    expect(r[0].detail).toContain("Paper のサーバーには入れません");
    expect(pulls).toEqual(["LuckPerms-5.4.0.jar"]);
    expect((await sets.apply(owner, setId, serverId))[1].status).toBe("present");
    expect(pulls.length).toBe(1);
  });

  it("ほかのチームからは見えず、操作できない。ほかのチームのライブラリのものは入れられない", async () => {
    expect(await sets.list(outsider)).toEqual([]);
    expect(await code(sets.apply(outsider, setId, serverId))).toBe(404);
    expect(await code(sets.rename(outsider, setId, "x"))).toBe(404);
    expect(await code(sets.remove(outsider, setId))).toBe(404);
    await lib.addItem(outsider, PLUGIN);
    const theirs = await itemId(outsider, "LuckPerms");
    expect(await code(sets.toggleItem(owner, setId, theirs, true))).toBe(404);
    const mine = (await sets.create(outsider, "自分の")).id;
    expect(await code(sets.toggleItem(outsider, mine, await itemId(owner, "Lithium"), true))).toBe(404);
  });

  it("ライブラリから外すとセットからも消える。名前を変えて、消せる", async () => {
    await lib.removeItem(owner, await itemId(owner, "Old"));
    expect((await sets.list(owner))[0].items.map((i) => i.title)).toEqual(["Lithium", "LuckPerms"]);
    await sets.rename(owner, setId, "ロビー用");
    expect((await sets.list(owner)).map((s) => s.name)).toEqual(["ロビー用"]);
    await sets.remove(owner, setId);
    expect(await sets.list(owner)).toEqual([]);
    expect((await lib.catalog(owner)).items.map((i) => i.title)).toEqual(["Lithium", "LuckPerms"]);
  });
});

describe("サーバーとセットの結び付け", () => {
  let syncSet: string;

  it("結び付けるのは編集者以上。ほかのチームのセット・サーバーは使えない", async () => {
    syncSet = (await sets.create(owner, "同期")).id;
    for (const title of ["Lithium", "LuckPerms"]) await sets.toggleItem(owner, syncSet, await itemId(owner, title), true);
    expect(await code(sets.sync(owner, serverId))).toBe(400); // まだ結び付けていない
    expect(await code(sets.bind(viewer, serverId, syncSet))).toBe(403);
    expect(await code(sets.bind(outsider, serverId, syncSet))).toBe(404);
    const theirs = (await sets.list(outsider))[0].id;
    expect(await code(sets.bind(owner, serverId, theirs))).toBe(404);
    await sets.bind(owner, serverId, syncSet);
    expect((await sets.list(viewer)).find((x) => x.id === syncSet)?.servers.map((x) => x.name)).toEqual(["ロビー"]);
    expect(await code(sets.sync(outsider, serverId))).toBe(404);
  });

  it("そろえると、最新なら何もせず、新しい版が出ていれば更新して古いファイルを消す。Mod は入れない", async () => {
    let r = await sets.sync(owner, serverId);
    expect(r.map((x) => [x.title, x.status, x.detail])).toEqual([
      ["Lithium", "skipped", "Mod なので、Paper のサーバーには入れません"], ["LuckPerms", "present", "最新です(5.4.0)"]]);
    pluginLatest = { id: "ver00002", number: "5.5.0" };
    r = await sets.sync(owner, serverId);
    expect(r[1]).toEqual({ title: "LuckPerms", status: "updated", detail: "5.4.0 → 5.5.0" });
    expect(files.get("plugins")).toEqual(["LuckPerms-5.5.0.jar"]);
    expect((await sets.sync(owner, serverId))[1].status).toBe("present");
  });

  it("外すと、そろえられなくなる。セットを消すと結び付けも消える", async () => {
    await sets.bind(owner, serverId, null);
    expect(await code(sets.sync(owner, serverId))).toBe(400);
    await sets.bind(owner, serverId, syncSet);
    await sets.remove(owner, syncSet);
    expect(await code(sets.sync(owner, serverId))).toBe(400);
  });
});
