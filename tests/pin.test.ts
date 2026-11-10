// セットの版の固定(03.59.00)。Pterodactyl と Modrinth は偽物の応答で代わりをする
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
// 古い版・新しい版・このサーバー(1.21.4)には合わない版
const VERSIONS = [
  { id: "ver00001", number: "5.3.0", date: "2026-01-01", mc: ["1.21.4"] },
  { id: "ver00002", number: "5.4.0", date: "2026-02-01", mc: ["1.21.4"] },
  { id: "ver00003", number: "4.0.0", date: "2025-01-01", mc: ["1.8.8"] },
];
const raw = (v: (typeof VERSIONS)[number]) => ({
  id: v.id, project_id: PLUGIN, version_number: v.number, version_type: "release", date_published: v.date, loaders: ["paper"], game_versions: v.mc,
  files: [{ primary: true, filename: `LuckPerms-${v.number}.jar`, url: `https://cdn.modrinth.com/data/${PLUGIN}/LuckPerms-${v.number}.jar`, size: 1, hashes: {} }],
});

const files = new Map<string, string[]>([["plugins", []]]);
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === `/v2/project/${PLUGIN}`) return json({ id: PLUGIN, title: "LuckPerms", slug: "luckperms", project_type: "plugin" });
    if (u.pathname === `/v2/project/${PLUGIN}/version`) {
      const mc = u.searchParams.get("game_versions");
      return json(VERSIONS.filter((v) => !mc || v.mc.some((x) => JSON.parse(mc).includes(x))).map(raw));
    }
    const v = VERSIONS.find((x) => u.pathname === `/v2/version/${x.id}`);
    return v ? json(raw(v)) : json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先");
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete|rename)$/);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  if (m?.[1] === "pull") files.set(body.directory, [...new Set([...(files.get(body.directory) ?? []), body.filename])]); // 同じ名前は上書き
  if (m?.[1] === "delete") files.set(body.root, (files.get(body.root) ?? []).filter((x) => !body.files.includes(x)));
  if (m?.[1] === "rename") files.set(body.root, (files.get(body.root) ?? []).map((x) => (x === body.files[0].from ? body.files[0].to : x)));
  return m ? new Response(null, { status: 204 }) : json({}, 404);
};

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let owner: Headers;
let viewer: Headers;
let outsider: Headers;
let serverId: string;
let setId: string;
let itemId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const plugins = () => files.get("plugins");

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
  await lib.setProfile(owner, serverId, { platform: "paper", mcVersion: "1.21.4" });
  await lib.addItem(owner, PLUGIN);
  itemId = (await lib.catalog(owner)).items[0].id;
  setId = (await sets.create(owner, "ロビー")).id;
  await sets.toggleItem(owner, setId, itemId, true);
  await sets.bind(owner, serverId, setId);

  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
  outsider = t.headers(await t.signUp("部外者", "outsider@example.com"));
});

describe("セットの版の固定", () => {
  it("固定するのは編集者以上。ほかのチームのセット・配布元に無い版は固定できない", async () => {
    expect(await code(sets.pin(viewer, setId, itemId, "ver00001"))).toBe(403);
    expect(await code(sets.pin(outsider, setId, itemId, "ver00001"))).toBe(404);
    expect(await code(sets.pin(owner, setId, itemId, "verXXXXX"))).toBe(404);
    expect(await sets.pin(owner, setId, itemId, "ver00001")).toEqual({ versionNumber: "5.3.0" });
    const [s] = await sets.list(viewer);
    expect(s.items[0]).toMatchObject({ versionId: "ver00001", versionNumber: "5.3.0" });
  });

  it("そろえる・まとめて最新・自動更新は、新しい版ではなく固定した版を入れる。新しい版のお知らせにも出さない", async () => {
    const r = await sets.sync(owner, serverId, "add");
    expect(r.map((x) => [x.status, x.detail])).toEqual([["installed", "5.3.0(固定した版)"]]);
    expect(plugins()).toEqual(["LuckPerms-5.3.0.jar"]);
    expect((await sets.updateServers(owner, [serverId]))[0].results).toEqual([]); // 変えたものは無い
    await sets.setAutoUpdate(owner, serverId, true);
    await sets.runAutoUpdates(new Date());
    expect(plugins()).toEqual(["LuckPerms-5.3.0.jar"]);
    expect(await lib.updates(owner, serverId)).toEqual([]);
    expect((await lib.installed(owner, serverId)).items[0]).toMatchObject({ versionNumber: "5.3.0", pinned: "5.3.0" });
  });

  it("ライブラリ・サーバーの一覧の「更新あり」に出さず「固定」と出す。版を選ばずに入れ直しても(更新を押しても)固定した版のまま", async () => {
    expect(await lib.outdatedServers(owner)).toEqual([]);
    expect((await lib.catalog(owner)).items[0].installs[0]).toMatchObject({ versionNumber: "5.3.0", pinned: "5.3.0" });
    const r = await lib.install(owner, serverId, PLUGIN);
    expect(r.versionNumber).toBe("5.3.0");
    expect(plugins()).toEqual(["LuckPerms-5.3.0.jar"]);
    // 版を選べば、その版にできる(いままでどおり)
    expect((await lib.install(owner, serverId, PLUGIN, "modrinth", "ver00002")).versionNumber).toBe("5.4.0");
    expect((await sets.sync(owner, serverId, "update"))[0]).toMatchObject({ status: "updated", detail: "5.4.0 → 5.3.0(固定した版)" });
  });

  it("サーバーに合わない版に固定すると、知らせて飛ばす(まとめにも載る)", async () => {
    await sets.pin(owner, setId, itemId, "ver00003");
    const r = await sets.sync(owner, serverId, "update");
    expect(r).toEqual([{ title: "LuckPerms", status: "skipped", detail: "固定した版 4.0.0 は、このサーバーの種類・バージョンに合わないので飛ばしました", pinned: true }]);
    expect(sets.summary(r)).toContain("固定した版 4.0.0");
    expect(plugins()).toEqual(["LuckPerms-5.3.0.jar"]);
    const check = await sets.runForSchedule((await t.auth.api.getFullOrganization({ headers: owner }))!.id, "check");
    expect(check.servers[0].results[0].status).toBe("skipped");
  });

  it("固定をやめると新しい版にする。サーバーの「更新を止める」は固定より先に効く", async () => {
    await sets.pin(owner, setId, itemId, null);
    expect((await sets.list(owner))[0].items[0]).toMatchObject({ versionId: null, versionNumber: "" });
    expect((await sets.sync(owner, serverId, "update")).map((x) => x.status)).toEqual(["updated"]);
    expect(plugins()).toEqual(["LuckPerms-5.4.0.jar"]);
    await lib.setHold(owner, serverId, "modrinth", PLUGIN, true);
    await sets.pin(owner, setId, itemId, "ver00001");
    expect((await sets.sync(owner, serverId, "update"))[0].detail).toBe("更新を止めています(5.4.0)");
    await lib.setHold(owner, serverId, "modrinth", PLUGIN, false);
    expect((await sets.sync(owner, serverId, "update"))[0]).toMatchObject({ status: "updated", detail: "5.4.0 → 5.3.0(固定した版)" });
    expect(plugins()).toEqual(["LuckPerms-5.3.0.jar"]);
  });
});
