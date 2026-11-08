// セットの前提・入っているものだけ合わせる・まとめて最新にする・サーバーごとの予約(Pterodactyl と Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { scheduleService } from "~/server/schedule";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { eventService } from "~/server/events";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const PLUGIN = "Vebnzrzj"; // LuckPerms(Vault が前提)
const DEP = "VaultPrj";
const EXTRA = "EssxPrj1";
const files = new Map<string, string[]>([["plugins", []]]);
const power: string[] = [];
const discord: string[] = [];
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123456789";
let latest = { id: "ver00001", number: "5.4.0" };

const version = (pid: string, id: string, number: string, name: string, deps: string[] = []) => ({
  id, version_number: number, version_type: "release", date_published: "2026-01-01", loaders: ["paper"],
  dependencies: deps.map((d) => ({ project_id: d, dependency_type: "required" })),
  files: [{ primary: true, filename: `${name}-${number}.jar`, url: `https://cdn.modrinth.com/data/${pid}/${name}-${number}.jar`, size: 1, hashes: {} }],
});

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    const projects: Record<string, unknown> = {
      [PLUGIN]: { title: "LuckPerms", slug: "luckperms", project_type: "plugin" },
      [DEP]: { title: "Vault", slug: "vault", project_type: "plugin", icon_url: "" },
      [EXTRA]: { title: "Essentials", slug: "essentials", project_type: "plugin" },
    };
    const m = u.pathname.match(/^\/v2\/project\/(\w+)(\/version)?$/);
    if (m && projects[m[1]] && !m[2]) return json(projects[m[1]]);
    if (m?.[2] && m[1] === PLUGIN) return json([version(PLUGIN, latest.id, latest.number, "LuckPerms", [DEP])]);
    if (m?.[2] && m[1] === DEP) return json([version(DEP, "vault001", "1.7", "Vault")]);
    if (m?.[2] && m[1] === EXTRA) return json([version(EXTRA, "essx0001", "2.20", "Essentials")]);
    return json({}, 404);
  }
  if (u.host === "discord.com") {
    discord.push(JSON.parse(String(init?.body)).content);
    return new Response(null, { status: 204 });
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/power")) {
    power.push(JSON.parse(String(init?.body)).signal);
    return new Response(null, { status: 204 });
  }
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete|rename)$/);
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

// 2026-01-04(日曜)の日本時間 04:00
const SUN_0400 = new Date(Date.UTC(2026, 0, 3, 19, 0, 0));
const later = (minutes: number) => new Date(SUN_0400.getTime() + minutes * 60_000);

let t: Awaited<ReturnType<typeof setup>>;
let lib: ReturnType<typeof libraryService>;
let sets: ReturnType<typeof setService>;
let sched: ReturnType<typeof scheduleService>;
let ev: ReturnType<typeof eventService>;
let owner: Headers;
let editor: Headers;
let viewer: Headers;
let outsider: Headers;
let serverId: string;
let setId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const itemId = async (title: string) => (await lib.catalog(owner)).items.find((i) => i.title === title)!.id;

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
  sched = scheduleService(deps, sets);
  ev = eventService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  serverId = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, serverId, { platform: "paper", mcVersion: "" });
  editor = await join2("editor@example.com", "editor");
  viewer = await join2("viewer@example.com", "viewer");
  outsider = t.headers(await t.signUp("よそ", "outsider@example.com"));
  await lib.addItem(owner, PLUGIN);
  await lib.addItem(owner, EXTRA);
  setId = (await sets.create(owner, "基本")).id;
  for (const title of ["LuckPerms", "Essentials"]) await sets.toggleItem(owner, setId, await itemId(title), true);
});

describe("セットの前提", () => {
  it("セットに無い前提を、使うものと一緒に出す。足すとライブラリにも載る", async () => {
    const r = await sets.missingDeps(viewer, setId, "paper");
    expect(r.missing.map((m) => [m.title, m.projectId, m.by])).toEqual([["Vault", DEP, ["LuckPerms"]]]);
    expect(r.errors).toEqual([]);
    expect((await sets.missingDeps(owner, setId, "fabric")).missing).toEqual([]); // Mod のサーバーではプラグインを見ない
    expect(await code(sets.missingDeps(owner, setId, "spongeforge"))).toBe(400);
    expect(await code(sets.missingDeps(outsider, setId, "paper"))).toBe(404);
    expect(await code(sets.addDeps(viewer, setId, [{ source: "modrinth", projectId: DEP }], "paper"))).toBe(403);
    expect(await sets.addDeps(editor, setId, [{ source: "modrinth", projectId: DEP }], "paper")).toEqual({ added: ["Vault"] });
    expect((await sets.missingDeps(owner, setId, "paper")).missing).toEqual([]);
    expect((await lib.catalog(owner)).items.find((i) => i.title === "Vault")?.projectType).toBe("plugin");
  });
});

describe("セットでそろえるときのそろえ方", () => {
  it("「入っているものだけ合わせる」は足りないものを入れず、入っているものだけ新しい版にする", async () => {
    await lib.install(owner, serverId, PLUGIN);
    expect(files.get("plugins")?.sort()).toEqual(["LuckPerms-5.4.0.jar", "Vault-1.7.jar"]);
    await sets.bind(owner, serverId, setId);
    latest = { id: "ver00002", number: "5.5.0" };
    expect(await code(sets.sync(owner, serverId, "delete"))).toBe(400);
    const r = await sets.sync(editor, serverId, "update");
    expect(r.map((x) => [x.title, x.status])).toEqual([["LuckPerms", "updated"], ["Vault", "present"]]); // Essentials は入れない
    expect(files.get("plugins")).not.toContain("Essentials-2.20.jar");
    expect((await sets.sync(owner, serverId, "add")).find((x) => x.title === "Essentials")?.status).toBe("installed");
  });
});

describe("まとめて最新にする", () => {
  it("編集者以上が、選んだ(空ならすべての)サーバーを新しい版にする。変えたものだけを返す。ほかのチームのサーバーは使えない", async () => {
    latest = { id: "ver00003", number: "5.6.0" };
    expect(await code(sets.updateServers(viewer, []))).toBe(403);
    expect(await code(sets.updateServers(outsider, [serverId]))).toBe(404);
    expect(await sets.updateServers(outsider, [])).toEqual([]);
    const [r] = await sets.updateServers(editor, []);
    expect([r.server, r.error, r.results]).toEqual(["ロビー", "", [{ title: "LuckPerms", status: "updated", detail: "5.5.0 → 5.6.0" }]]);
    expect((await sets.updateServers(owner, [serverId]))[0].results).toEqual([]); // もう最新
    expect((await ev.list(owner)).find((e) => e.action === "まとめて最新にする")?.target).toBe("ロビー");
  });
});

describe("サーバーごとの予約", () => {
  it("決めるのは管理者以上。種類・時刻・曜日を確かめる。見るのはメンバー(ほかのチームは見えない)", async () => {
    expect(await sched.getServer(viewer, serverId)).toMatchObject({ mode: "off", action: "update", restart: false });
    const ok = { mode: "weekly", action: "update", time: "04:00", dow: 0, restart: true, tz: "Asia/Tokyo" };
    expect(await code(sched.setServer(editor, serverId, ok))).toBe(403);
    expect(await code(sched.setServer(owner, serverId, { ...ok, mode: "hourly" }))).toBe(400);
    expect(await code(sched.setServer(owner, serverId, { ...ok, action: "wipe" }))).toBe(400);
    expect(await code(sched.setServer(owner, serverId, { ...ok, time: "4時" }))).toBe(400);
    expect(await code(sched.setServer(owner, serverId, { ...ok, tz: "Mars/Base" }))).toBe(400);
    expect(await code(sched.getServer(outsider, serverId))).toBe(404);
    await sched.setServer(owner, serverId, ok);
    expect(await sched.getServer(viewer, serverId)).toMatchObject(ok);
  });

  it("時刻・曜日になったら最新にし、変えたら再起動する。同じ分に 2 回は動かない。変えるものが無ければ再起動せず、Discord にも送らない", async () => {
    await ev.setNotify(owner, { url: HOOK, kinds: ["schedule"] });
    latest = { id: "ver00004", number: "5.7.0" };
    expect(await sched.serverTick(later(-1))).toEqual([]);
    expect(await sched.serverTick(SUN_0400)).toEqual([serverId]);
    expect(await sched.serverTick(new Date(SUN_0400.getTime() + 20_000))).toEqual([]);
    expect(await sched.serverTick(later(60 * 24))).toEqual([]); // 月曜
    expect(files.get("plugins")).toContain("LuckPerms-5.7.0.jar");
    expect(power).toEqual(["restart"]);
    const [e] = await ev.list(owner);
    expect([e.action, e.target, e.userName]).toEqual(["予約で最新にする", "ロビー", ""]);
    expect(e.detail).toContain("LuckPerms: 5.6.0 → 5.7.0");
    expect(e.detail).toContain("再起動しました");
    expect(discord.filter((d) => d.includes("予約で最新にする"))).toHaveLength(1);
    expect(await sched.serverTick(later(60 * 24 * 7))).toEqual([serverId]);
    expect(power).toEqual(["restart"]);
    expect((await ev.list(owner))[0].detail).toBe("変えるものはありませんでした"); // 記録は残す
    expect(discord.filter((d) => d.includes("予約で最新にする"))).toHaveLength(1); // 通知はしない
  });

  it("毎日なら曜日を問わない。止めると動かない。チームの予約とは別に動く", async () => {
    await sched.setServer(owner, serverId, { mode: "daily", action: "sync", time: "04:00", dow: 0, restart: false, tz: "Asia/Tokyo" });
    expect(await sched.serverTick(later(60 * 24 * 8))).toEqual([serverId]);
    expect(await sched.tick(later(60 * 24 * 8))).toEqual([]); // チームの予約は決めていない
    await sched.setServer(owner, serverId, { mode: "off", action: "update", time: "04:00", dow: 0, restart: false, tz: "Asia/Tokyo" });
    expect(await sched.serverTick(later(60 * 24 * 9))).toEqual([]);
  });
});
