// チームと権限の通しテスト
import { beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "~/server/auth";
import { HttpError, requireTeam } from "~/server/guard";
import { safeNext } from "~/lib/next";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});

const status = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : 500));

describe("チーム", () => {
  let owner: string;
  let teamId: string;

  it("登録すると自分のチームができ、オーナーとして選ばれた状態になる", async () => {
    owner = await t.signUp("オーナー", "owner@example.com");
    const s = await t.auth.api.getSession({ headers: t.headers(owner) });
    teamId = s!.session.activeOrganizationId!;
    expect(teamId).toBeTruthy();
    const res = await t.get("/organization/get-full-organization", owner);
    const team = await res.json();
    expect(team.name).toBe("オーナー のチーム");
    expect(team.members).toHaveLength(1);
    expect(team.members[0].role).toBe("owner");
    expect(await status(requireTeam(t.auth, t.headers(owner), { server: ["create", "delete"], library: ["edit"] }))).toBe(200);
  });

  it("招待された人は閲覧者として参加し、閲覧者にはできない操作が拒否される", async () => {
    const inv = await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner);
    expect(inv.status).toBe(200);
    const { id } = await inv.json();

    // 宛先と違う人は参加できない
    const other = await t.signUp("別の人", "other@example.com");
    expect((await t.call("/organization/accept-invitation", { invitationId: id }, other)).status).not.toBe(200);

    const viewer = await t.signUp("閲覧者", "viewer@example.com");
    expect((await t.call("/organization/accept-invitation", { invitationId: id }, viewer)).status).toBe(200);
    expect((await t.call("/organization/set-active", { organizationId: teamId }, viewer)).status).toBe(200);

    expect(await status(requireTeam(t.auth, t.headers(viewer)))).toBe(200);
    expect(await status(requireTeam(t.auth, t.headers(viewer), { library: ["edit"] }))).toBe(403);
    expect(await status(requireTeam(t.auth, t.headers(viewer), { server: ["control"] }))).toBe(403);
    expect((await t.call("/organization/invite-member", { email: "x@example.com", role: "viewer" }, viewer)).status).toBe(403);

    // オーナーが編集者に変えると、Mod の操作とサーバーの起動・停止ができるようになる(登録・削除はできない)
    const team = await (await t.get("/organization/get-full-organization", owner)).json();
    const m = team.members.find((x: { user: { email: string } }) => x.user.email === "viewer@example.com");
    expect((await t.call("/organization/update-member-role", { memberId: m.id, role: "editor" }, owner)).status).toBe(200);
    expect(await status(requireTeam(t.auth, t.headers(viewer), { library: ["edit"], server: ["control"] }))).toBe(200);
    expect(await status(requireTeam(t.auth, t.headers(viewer), { server: ["delete"] }))).toBe(403);

    // 編集者は、ほかの人の役割を変えられない
    const ownerMember = team.members.find((x: { role: string }) => x.role === "owner");
    expect((await t.call("/organization/update-member-role", { memberId: ownerMember.id, role: "viewer" }, viewer)).status).not.toBe(200);
  });

  it("ログインしていなければ 401", async () => {
    expect(await status(requireTeam(t.auth, t.headers()))).toBe(401);
  });

  it("作れるチームの数に上限がある", async () => {
    const t = await setup(); // 登録の回数制限にかからないよう、別に立ち上げる
    const u = await t.signUp("上限", "limit@example.com");
    for (let i = 1; i < LIMITS.teamsPerUser; i++) {
      expect((await t.call("/organization/create", { name: `チーム${i}`, slug: `limit-${i}` }, u)).status).toBe(200);
    }
    expect((await t.call("/organization/create", { name: "多すぎ", slug: "limit-x" }, u)).status).not.toBe(200);
  });
});

describe("ログインのあとに戻る先", () => {
  it("同じサイトの中のパスだけを受け付ける", () => {
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext("/\\evil.example/")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});
