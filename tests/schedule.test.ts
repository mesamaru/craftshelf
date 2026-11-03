// 予約: 決めた曜日・時刻に、セットを結び付けたサーバーをそろえる・確かめる(Pterodactyl と Modrinth は偽物の応答で代わりをする)
import { beforeAll, describe, expect, it } from "vitest";
import { eventService } from "~/server/events";
import { HttpError } from "~/server/guard";
import { libraryService } from "~/server/library";
import type { FetchLike } from "~/server/net";
import { localParts, scheduleService } from "~/server/schedule";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const PLUGIN = "Vebnzrzj";
const files = new Map<string, string[]>([["plugins", []]]);
const pulls: string[] = [];
let latest = { id: "ver00001", number: "5.4.0" };

const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  if (u.host === "api.modrinth.com") {
    if (u.pathname === `/v2/project/${PLUGIN}`) return json({ title: "LuckPerms", slug: "luckperms", project_type: "plugin" });
    if (u.pathname === `/v2/project/${PLUGIN}/version`) {
      return json([{ id: latest.id, version_number: latest.number, version_type: "release", date_published: "2026-01-01", loaders: ["paper"],
        files: [{ primary: true, filename: `LuckPerms-${latest.number}.jar`, url: `https://cdn.modrinth.com/data/${PLUGIN}/LuckPerms-${latest.number}.jar`, size: 1, hashes: {} }] }]);
    }
    return json({}, 404);
  }
  if (u.host !== "panel.example.com") throw new Error("想定外の接続先: " + url);
  if (u.pathname === "/api/client") return json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  const m = u.pathname.match(/^\/api\/client\/servers\/abcd1234\/files\/(list|pull|delete)$/);
  if (m?.[1] === "list") return json({ data: (files.get(u.searchParams.get("directory")!) ?? []).map((name) => ({ attributes: { name, size: 1, is_file: true } })) });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (m?.[1] === "pull") {
    pulls.push(body.filename);
    files.set(body.directory, [...(files.get(body.directory) ?? []), body.filename]);
    return new Response(null, { status: 204 });
  }
  if (m?.[1] === "delete") {
    files.set(body.root, (files.get(body.root) ?? []).filter((x) => !body.files.includes(x)));
    return new Response(null, { status: 204 });
  }
  return json({}, 404);
};

// 2026-01-04(日曜)の日本時間 04:00 = 2026-01-03 19:00(UTC)
const SUN_0400 = new Date(Date.UTC(2026, 0, 3, 19, 0, 0));
const later = (minutes: number) => new Date(SUN_0400.getTime() + minutes * 60_000);

let t: Awaited<ReturnType<typeof setup>>;
let sched: ReturnType<typeof scheduleService>;
let ev: ReturnType<typeof eventService>;
let owner: Headers;
let editor: Headers;
let teamId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  const servers = serverService(deps);
  const lib = libraryService(deps);
  const sets = setService(deps);
  sched = scheduleService(deps, sets);
  ev = eventService(deps);
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  const id = (await servers.listServers(owner))[0].id;
  await lib.setProfile(owner, id, { platform: "paper", mcVersion: "" });
  await lib.addItem(owner, PLUGIN);
  const setId = (await sets.create(owner, "基本")).id;
  await sets.toggleItem(owner, setId, (await lib.catalog(owner)).items[0].id, true);
  await sets.bind(owner, id, setId);
  const team = await (await t.get("/organization/get-full-organization", owner.get("cookie")!)).json();
  teamId = team.id;
  const inv = await (await t.call("/organization/invite-member", { email: "editor@example.com", role: "editor" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("編集者", "editor@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  editor = t.headers(cookie);
});

describe("予約", () => {
  it("時刻と曜日は、その場所の時間で見る", () => {
    expect(localParts(SUN_0400, "Asia/Tokyo")).toEqual({ day: 0, time: "04:00" });
    expect(localParts(SUN_0400, "UTC")).toEqual({ day: 6, time: "19:00" });
  });

  it("決めるのは管理者以上。時刻と曜日を確かめる", async () => {
    expect((await sched.get(editor)).enabled).toBe(false);
    expect(await code(sched.set(editor, { enabled: true, mode: "check", time: "04:00", days: [0] }))).toBe(403);
    expect(await code(sched.set(owner, { enabled: true, mode: "check", time: "4時", days: [0] }))).toBe(400);
    expect(await code(sched.set(owner, { enabled: true, mode: "check", time: "04:00", days: [] }))).toBe(400);
    expect(await code(sched.set(owner, { enabled: true, mode: "delete", time: "04:00", days: [0] }))).toBe(400);
    await sched.set(owner, { enabled: true, mode: "check", time: "04:00", days: [0, 3] });
    expect(await sched.get(editor)).toMatchObject({ enabled: true, mode: "check", time: "04:00", days: [0, 3] });
  });

  it("「確かめるだけ」は何も入れず、入っていないものを記録する。同じ分に 2 回は動かない。時刻・曜日が違えば動かない", async () => {
    expect(await sched.tick(later(-1))).toEqual([]);
    expect(await sched.tick(SUN_0400)).toEqual([teamId]);
    expect(await sched.tick(new Date(SUN_0400.getTime() + 20_000))).toEqual([]); // 同じ分
    expect(await sched.tick(later(60 * 24))).toEqual([]); // 月曜
    expect(pulls).toEqual([]);
    const [r] = await ev.list(owner);
    expect([r.action, r.target, r.userName]).toEqual(["予約で更新を確かめる", "1 台", ""]);
    expect(r.detail).toContain("LuckPerms: 入っていません");
  });

  it("「そろえる」なら入れ、新しい版が出れば次の回に更新する", async () => {
    await sched.set(owner, { enabled: true, mode: "sync", time: "04:00", days: [0] });
    expect(await sched.tick(later(60 * 24 * 7))).toEqual([teamId]);
    expect(pulls).toEqual(["LuckPerms-5.4.0.jar"]);
    latest = { id: "ver00002", number: "5.5.0" };
    expect(await sched.tick(later(60 * 24 * 14))).toEqual([teamId]);
    expect(files.get("plugins")).toEqual(["LuckPerms-5.5.0.jar"]);
    expect((await ev.list(owner))[0].detail).toContain("LuckPerms: 5.4.0 → 5.5.0");
  });

  it("止めると動かない", async () => {
    await sched.set(owner, { enabled: false, mode: "sync", time: "04:00", days: [0] });
    expect(await sched.tick(later(60 * 24 * 21))).toEqual([]);
  });
});
