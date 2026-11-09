// メンバーごとの権限(03.60.00)。役割に足す・引く・API トークンの範囲・オーナー・ほかのチーム。Pterodactyl は偽物の応答で代わりをする
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GRANTS, permsOf, permsAllowScope } from "~/lib/permissions";
import { member, memberPerm } from "~/server/db/schema";
import { eventService } from "~/server/events";
import { fileService } from "~/server/files";
import { HttpError, requireTeam } from "~/server/guard";
import type { FetchLike } from "~/server/net";
import { serverService } from "~/server/servers";
import { setService } from "~/server/sets";
import { teamService } from "~/server/teams";
import { tokenService } from "~/server/tokens";
import { setup } from "./helpers";

const KEY = "ptlc_0123456789abcdefghij";
const SECRET = "test-secret-0123456789-0123456789-abcd";
const power: string[] = [];
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (u.pathname === "/api/client") return Response.json({ data: [{ attributes: { identifier: "abcd1234", name: "ロビー" } }], meta: { pagination: { total_pages: 1 } } });
  if (u.pathname.endsWith("/power")) { power.push(JSON.parse(String(init?.body)).signal); return new Response(null, { status: 204 }); }
  return Response.json({}, { status: 404 });
};

let t: Awaited<ReturnType<typeof setup>>;
let teams: ReturnType<typeof teamService>;
let servers: ReturnType<typeof serverService>;
let sets: ReturnType<typeof setService>;
let files: ReturnType<typeof fileService>;
let events: ReturnType<typeof eventService>;
let tokens: ReturnType<typeof tokenService>;
let owner: Headers, admin: Headers, editor: Headers, viewer: Headers;
const ids: Record<string, string> = {};
let teamA: string;
let serverId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const withKey = (key: string) => new Headers({ "x-api-key": key });
const userId = async (h: Headers) => (await requireTeam(t.auth, h)).user.id;

// owner のチームに招待して、そのチームを選んだ状態にする
async function join(ownerCookie: string, email: string, role: string, cookie?: string) {
  const inv = await (await t.call("/organization/invite-member", { email, role }, ownerCookie)).json();
  const c = cookie ?? await t.signUp(email.split("@")[0], email);
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, c);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, c);
  return c;
}

beforeAll(async () => {
  t = await setup();
  const deps = { db: t.db, auth: t.auth, secret: SECRET, fetch: fake };
  teams = teamService(deps);
  servers = serverService(deps);
  sets = setService(deps);
  files = fileService(deps);
  events = eventService(deps);
  tokens = tokenService(deps);
  const ownerCookie = await t.signUp("オーナー", "owner@example.com");
  owner = t.headers(ownerCookie);
  teamA = (await requireTeam(t.auth, owner)).teamId;
  admin = t.headers(await join(ownerCookie, "admin@example.com", "admin"));
  editor = t.headers(await join(ownerCookie, "editor@example.com", "editor"));
  viewer = t.headers(await join(ownerCookie, "viewer@example.com", "viewer"));
  for (const [k, h] of Object.entries({ owner, admin, editor, viewer })) ids[k] = await userId(h);
  const c = await servers.addConnection(owner, { name: "", url: "panel.example.com", apiKey: KEY });
  await servers.addServers(owner, c.id, ["abcd1234"]);
  serverId = (await servers.listServers(owner))[0].id;
});

describe("役割と足し引きの計算(permsOf)", () => {
  it("足す・引くのは決まったものだけ。オーナーは減らせない。チームの設定は編集者だけに効く", () => {
    expect(permsOf("viewer", { allow: ["server:control", "member:update", "x:y"] }).has("server:control")).toBe(true);
    expect(permsOf("viewer", { allow: ["member:update"] }).has("member:update")).toBe(false); // メンバーの管理は役割だけ
    expect(permsOf("editor", { deny: ["library:edit"] }).has("library:edit")).toBe(false);
    expect(permsOf("owner", { deny: [...GRANTS] }).has("library:edit")).toBe(true);
    expect(permsOf("editor", { editorFiles: true }).has("files:edit")).toBe(true);
    expect(permsOf("viewer", { editorFiles: true }).has("files:edit")).toBe(false);
    expect(permsOf("editor", { editorFiles: true, deny: ["files:edit"] }).has("files:edit")).toBe(false);
    expect(permsAllowScope(permsOf("editor"), "admin")).toBe(false);
    expect(permsAllowScope(permsOf("editor", { allow: ["files:edit"] }), "admin")).toBe(true);
    expect(permsAllowScope(permsOf("viewer"), "read")).toBe(true);
  });
});

describe("メンバーごとの権限", () => {
  it("決めるのは管理者以上で、ログインしてから。オーナーと自分は変えられない。足し引きできないものは受け付けない", async () => {
    expect(await code(teams.setMemberGrants(editor, ids.viewer, ["server:control"]))).toBe(403);
    expect(await code(teams.setMemberGrants(viewer, ids.viewer, ["server:control"]))).toBe(403);
    expect(await code(teams.setMemberGrants(admin, ids.owner, []))).toBe(403);
    expect(await code(teams.setMemberGrants(owner, ids.owner, []))).toBe(400);
    expect(await code(teams.setMemberGrants(admin, ids.admin, []))).toBe(400);
    expect(await code(teams.setMemberGrants(owner, ids.viewer, ["member:update"]))).toBe(400);
    expect(await code(teams.setMemberGrants(owner, "no-such-user", []))).toBe(404);
    expect(await code(teams.memberGrants(editor))).toBe(403);
    const full = (await tokens.create(owner, { name: "管理", scopes: ["library", "control", "admin"], days: 0 })).key;
    expect(await code(teams.setMemberGrants(withKey(full), ids.viewer, ["server:control"]))).toBe(403);
  });

  it("閲覧者に電源の操作を足すと、電源を操作できる。引くと、またできなくなる", async () => {
    expect(await code(servers.power(viewer, serverId, "start"))).toBe(403);
    expect(await teams.setMemberGrants(admin, ids.viewer, ["server:control"])).toEqual({ allow: ["server:control"], deny: [] });
    await servers.power(viewer, serverId, "start");
    expect(power).toEqual(["start"]);
    expect((await teams.myPerms(viewer)).perms).toEqual(["server:control"]);
    expect(await code(sets.create(viewer, "閲覧者のセット"))).toBe(403); // 足していないものはできない
    await teams.setMemberGrants(admin, ids.viewer, []);
    expect(await code(servers.power(viewer, serverId, "stop"))).toBe(403);
    expect((await events.list(owner)).filter((r) => r.action === "メンバーの権限を変える").map((r) => [r.target, r.detail])).toEqual([["viewer", "役割のとおり"], ["viewer", "+ サーバーを操作する(起動と停止・コマンド・ログ・ワールドのバックアップ)"]]);
  });

  it("編集者からライブラリを引くと、Mod・プラグインを変えられない。設定ファイルを足すと見られる", async () => {
    await sets.create(editor, "編集者のセット");
    await teams.setMemberGrants(owner, ids.editor, ["server:control", "files:edit"]);
    expect(await code(sets.create(editor, "引いたあと"))).toBe(403);
    expect(await files.access(editor)).toEqual({ allowed: true, editors: false });
    const g = (await teams.memberGrants(owner)).find((r) => r.userId === ids.editor)!;
    expect(g).toMatchObject({ owner: false, base: ["library:edit", "server:control"], perms: ["server:control", "files:edit"] });
    expect((await teams.memberGrants(owner)).find((r) => r.userId === ids.owner)!.owner).toBe(true);
  });

  it("チームの「編集者にも設定ファイル」は編集者の既定。人ごとに引ける", async () => {
    await teams.setMemberGrants(owner, ids.editor, ["library:edit", "server:control"]); // 役割のとおりに戻す
    expect((await files.access(editor)).allowed).toBe(false);
    await files.setEditorFiles(owner, true);
    expect((await files.access(editor)).allowed).toBe(true);
    // 既定で持っているものを外すと「引いた」として覚える
    expect(await teams.setMemberGrants(owner, ids.editor, ["library:edit", "server:control"])).toEqual({ allow: [], deny: ["files:edit"] });
    expect((await files.access(editor)).allowed).toBe(false);
    await teams.setMemberGrants(owner, ids.editor, ["library:edit", "server:control", "files:edit"]);
    await files.setEditorFiles(owner, false);
    expect((await files.access(editor)).allowed).toBe(false); // 足していないので、既定がなくなれば見られない
  });

  it("管理者から引くこともできる(操作の記録を見られない)。管理者の役割の操作(メンバーの管理)は残る", async () => {
    await teams.setMemberGrants(owner, ids.admin, GRANTS.filter((g) => g !== "audit:read"));
    expect(await code(events.list(admin))).toBe(403);
    expect((await teams.memberGrants(admin)).length).toBe(4);
    await teams.setMemberGrants(owner, ids.admin, [...GRANTS]);
    expect(await code(events.list(admin))).toBe(200);
  });

  it("オーナーは、足し引きが残っていても(データベースに直接入れても)減らない", async () => {
    const [m] = await t.db.select({ id: member.id }).from(member).where(eq(member.userId, ids.owner));
    await t.db.insert(memberPerm).values({ memberId: m.id, deny: JSON.stringify([...GRANTS]) });
    expect(await code(sets.create(owner, "オーナーのセット"))).toBe(200);
    expect(await code(events.list(owner))).toBe(200);
    expect((await teams.myPerms(owner)).perms).toEqual(expect.arrayContaining([...GRANTS]));
  });
});

describe("API トークンとメンバーごとの権限", () => {
  it("足した権限の範囲のトークンを作れ、その分だけ使える。引くと、作ったトークンでもできなくなる", async () => {
    expect(await code(tokens.create(viewer, { name: "電源", scopes: ["control"], days: 0 }))).toBe(403);
    await teams.setMemberGrants(owner, ids.viewer, ["server:control"]);
    const key = (await tokens.create(viewer, { name: "電源", scopes: ["control"], days: 0 })).key;
    await servers.power(withKey(key), serverId, "restart");
    expect(power.at(-1)).toBe("restart");
    await teams.setMemberGrants(owner, ids.viewer, []);
    expect(await code(servers.power(withKey(key), serverId, "restart"))).toBe(403);
  });

  it("トークンの範囲の外は、権限があってもできない。管理の範囲でも、持っている権限の分だけ", async () => {
    await teams.setMemberGrants(owner, ids.editor, ["library:edit", "server:control", "files:edit"]);
    const lib = (await tokens.create(editor, { name: "Mod だけ", scopes: ["library"], days: 0 })).key;
    expect(await code(files.list(withKey(lib), serverId, ""))).toBe(403); // 範囲が足りない(設定ファイルは管理の範囲)
    const adm = (await tokens.create(editor, { name: "管理", scopes: ["admin"], days: 0 })).key; // 設定ファイルの権限があるので作れる
    expect(await code(servers.removeServer(withKey(adm), serverId))).toBe(403); // 管理の範囲でも、サーバーを外す権限は無い
    expect(await code(events.list(withKey(adm)))).toBe(403);
    await teams.setMemberGrants(owner, ids.editor, ["server:control", "files:edit"]);
    expect(await code(sets.create(withKey(lib), "引いたあと"))).toBe(403); // ライブラリを引くと、ライブラリの範囲のトークンも
    expect(await code(tokens.create(editor, { name: "Mod だけ 2", scopes: ["library"], days: 0 }))).toBe(403);
  });
});

describe("ほかのチーム", () => {
  it("足し引きはチームごと。ほかのチームの役割・権限には効かない。チームを抜けると消える", async () => {
    // 編集者は、別のチーム B でも編集者
    const ownerB = await t.signUp("オーナーB", "ownerb@example.com");
    const editorCookie = editor.get("cookie")!;
    await join(ownerB, "editor@example.com", "editor", editorCookie);
    const teamB = (await requireTeam(t.auth, editor)).teamId;
    expect(teamB).not.toBe(teamA);
    // チーム A では、ライブラリを引き・設定ファイルを足している
    expect((await teams.myPerms(editor)).perms).toEqual(["library:edit", "server:control"]);
    expect(await code(sets.create(editor, "チーム B のセット"))).toBe(200);
    expect((await files.access(editor)).allowed).toBe(false);
    // チーム B の管理者は、チーム A の人の権限を変えられない(B の人として見つからない)
    expect(await code(teams.setMemberGrants(t.headers(ownerB), ids.viewer, ["server:control"]))).toBe(404);
    // チーム A に戻すと、A の足し引きのまま
    await t.call("/organization/set-active", { organizationId: teamA }, editorCookie);
    expect((await teams.myPerms(editor)).perms).toEqual(["files:edit", "server:control"]);
    // チームから外すと、足し引きも消える
    await t.call("/organization/remove-member", { memberIdOrEmail: "viewer@example.com", organizationId: teamA }, owner.get("cookie")!);
    const rows = await t.db.select({ id: memberPerm.memberId }).from(memberPerm).innerJoin(member, eq(member.id, memberPerm.memberId)).where(eq(member.userId, ids.viewer));
    expect(rows).toEqual([]);
  });
});
