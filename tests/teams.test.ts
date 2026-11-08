// オーナーを譲る・チームを消す・アカウントを消す(サービス版)
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { member, organization, user } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { teamService } from "~/server/teams";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
let t: Awaited<ReturnType<typeof setup>>;
let teams: ReturnType<typeof teamService>;
let owner: Headers;
let editor: Headers;
let teamId: string;
let editorId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup({ mode: "service" });
  teams = teamService({ db: t.db, auth: t.auth, secret: SECRET, fetch });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const inv = await (await t.call("/organization/invite-member", { email: "editor@example.com", role: "editor" }, owner.get("cookie")!)).json();
  teamId = inv.organizationId;
  const cookie = await t.signUp("編集者", "editor@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: teamId }, cookie);
  editor = t.headers(cookie);
  editorId = (await t.db.select({ id: user.id }).from(user).where(eq(user.email, "editor@example.com")))[0].id;
});

const roleOf = async (email: string) =>
  (await t.db.select({ role: member.role }).from(member).innerJoin(user, eq(member.userId, user.id)).where(eq(user.email, email)).then((r) => r.find(() => true)))?.role;

describe("チームとアカウント", () => {
  it("ほかのメンバーがいるチームのオーナーは、アカウントを消せない。パスワードが違えば断る", async () => {
    expect(await code(teams.deleteAccount(owner, "wrong password"))).toBe(400);
    await expect(teams.deleteAccount(owner, "correct horse battery")).rejects.toThrow("ほかのメンバーがいます");
  });

  it("オーナーを譲れるのはオーナーだけ。譲ると、自分は管理者になる", async () => {
    expect(await code(teams.transferOwner(editor, editorId))).toBe(403);
    await teams.transferOwner(owner, editorId);
    expect(await roleOf("editor@example.com")).toBe("owner");
  });

  it("チームを消せるのはオーナーだけで、名前で確かめる。消すとチームのものはなくなる", async () => {
    expect(await code(teams.deleteTeam(owner, "x"))).toBe(403); // もう管理者
    expect(await code(teams.deleteTeam(editor, "ちがう名前"))).toBe(400);
    const [org] = await t.db.select({ name: organization.name }).from(organization).where(eq(organization.id, teamId));
    await teams.deleteTeam(editor, org.name);
    expect((await t.db.select().from(organization).where(eq(organization.id, teamId))).length).toBe(0);
  });

  it("アカウントを消すと、自分だけのチームも一緒に消える", async () => {
    const solo = t.headers(await t.signUp("ひとり", "solo@example.com")); // 登録すると自分のチームができる
    const before = (await t.db.select().from(organization)).length;
    await teams.deleteAccount(solo, "correct horse battery");
    expect((await t.db.select().from(user).where(eq(user.email, "solo@example.com"))).length).toBe(0);
    expect((await t.db.select().from(organization)).length).toBe(before - 1);
    await teams.deleteAccount(owner, "correct horse battery"); // チームが無くても消せる
    expect((await t.db.select().from(user).where(eq(user.email, "owner@example.com"))).length).toBe(0);
  });
});
