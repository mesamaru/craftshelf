// ログイン・アカウントの操作が、操作の記録に残る(auth.ts の hooks)
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "~/server/db/schema";
import { setup } from "./helpers";

describe("ログイン・アカウントの操作の記録", () => {
  it("ログイン・失敗・パスワード・招待・役割・外す・ログアウトを残す", async () => {
    const t = await setup();
    const pw = "correct horse battery";
    await t.signUp("オーナー", "log-owner@example.com", pw);
    expect((await t.call("/sign-in/email", { email: "log-owner@example.com", password: "wrong password!!" }, "", "203.0.113.7")).status).toBe(401);
    const login = await t.call("/sign-in/email", { email: "log-owner@example.com", password: pw }, "", "203.0.113.8");
    expect(login.status).toBe(200);
    const owner = t.cookieOf(login);
    const s = await t.auth.api.getSession({ headers: t.headers(owner) });
    const teamId = s!.session.activeOrganizationId!;

    expect((await t.call("/change-password", { currentPassword: pw, newPassword: "another horse battery" }, owner)).status).toBe(200);
    const inv = await (await t.call("/organization/invite-member", { email: "log-member@example.com", role: "viewer" }, owner)).json();
    const member = await t.signUp("メンバー", "log-member@example.com");
    expect((await t.call("/organization/accept-invitation", { invitationId: inv.id }, member)).status).toBe(200);
    const team = await (await t.get("/organization/get-full-organization", owner)).json();
    const m = team.members.find((x: { user: { email: string } }) => x.user.email === "log-member@example.com");
    expect((await t.call("/organization/update-member-role", { memberId: m.id, role: "editor" }, owner)).status).toBe(200);
    expect((await t.call("/organization/remove-member", { memberIdOrEmail: m.id }, owner)).status).toBe(200);
    expect((await t.call("/sign-out", {}, owner)).status).toBe(200);
    // ほかの人(いない人)の失敗は、サービス版ではどのチームにも残さない
    await t.call("/sign-in/email", { email: "nobody@example.com", password: "wrong password!!" });

    const rows = await t.db.select().from(auditLog).where(and(eq(auditLog.teamId, teamId), eq(auditLog.kind, "account"))).orderBy(asc(auditLog.at));
    expect(rows.map((r) => r.action)).toEqual(["ログインに失敗", "ログイン", "パスワードを変える", "メンバーを招待", "メンバーの役割を変える", "メンバーを外す", "ログアウト"]);
    expect(rows[0]).toMatchObject({ target: "log-owner@example.com", detail: "IP 203.0.113.7" });
    expect(rows[1].detail).toBe("IP 203.0.113.8");
    expect(rows[3]).toMatchObject({ target: "log-member@example.com", detail: "viewer" });
    expect(rows[4]).toMatchObject({ target: "メンバー", detail: "editor" });
    expect(rows[5].target).toBe("メンバー");
    expect((await t.db.select().from(auditLog).where(eq(auditLog.target, "nobody@example.com"))).length).toBe(0);
  });

  it("自分用の版は、いない人の名前での失敗もチームに残す", async () => {
    const t = await setup({ mode: "self" });
    await t.signUp("管理者", "self-admin@example.com");
    await t.call("/sign-in/email", { email: "nobody@example.com", password: "wrong password!!" });
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "ログインに失敗"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: null, target: "nobody@example.com" });
  });
});
