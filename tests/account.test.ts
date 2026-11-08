// アカウントの設定: ユーザー名・パスワードの変更・パスキーの名前、管理者による二段階認証・パスキーのリセット
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, passkey, session, twoFactor, user } from "~/server/db/schema";
import { HttpError } from "~/server/guard";
import { teamService } from "~/server/teams";
import { TEST_SECRET, setup } from "./helpers";

const PW = "correct horse battery";
let t: Awaited<ReturnType<typeof setup>>;
let teams: ReturnType<typeof teamService>;
let owner: string, admin: string, editor: string;
let ownerId: string, adminId: string, editorId: string;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));
const idOf = async (email: string) => (await t.db.select({ id: user.id }).from(user).where(eq(user.email, email)))[0].id;

// 自分用の版: オーナー・管理者・編集者が同じチームにいる
beforeAll(async () => {
  t = await setup({ mode: "self" });
  teams = teamService({ db: t.db, auth: t.auth, secret: TEST_SECRET, fetch, local: { dataDir: mkdtempSync(join(tmpdir(), "cs-acc-")) } });
  owner = await t.signUp("オーナー", "owner@example.com");
  const join_ = async (name: string, email: string, role: string) => {
    const inv = await (await t.call("/organization/invite-member", { email, role }, owner)).json();
    const cookie = await t.signUp(name, email);
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    return cookie;
  };
  admin = await join_("管理者", "admin@example.com", "admin");
  editor = await join_("編集者", "editor@example.com", "editor");
  [ownerId, adminId, editorId] = await Promise.all(["owner@example.com", "admin@example.com", "editor@example.com"].map(idOf));
});

describe("アカウントの設定", () => {
  it("表示名とユーザー名を変えられ、新しいユーザー名でログインできる。重複・使えない文字・長すぎる名前は断る", async () => {
    const r = await t.call("/update-user", { name: "新しい名前", username: "Steve.01", displayUsername: "Steve.01" }, editor);
    expect(r.status).toBe(200);
    const [u] = await t.db.select().from(user).where(eq(user.id, editorId));
    expect([u.name, u.username, u.displayUsername]).toEqual(["新しい名前", "steve.01", "Steve.01"]);
    expect((await t.call("/sign-in/username", { username: "Steve.01", password: PW }, "", "10.7.0.1")).status).toBe(200);

    expect((await (await t.call("/update-user", { username: "steve.01" }, admin)).json()).code).toBe("USERNAME_IS_ALREADY_TAKEN");
    expect((await (await t.call("/update-user", { username: "a b/c" }, admin)).json()).code).toBe("INVALID_USERNAME");
    expect((await t.call("/update-user", { name: "x".repeat(61) }, admin)).status).toBe(400);
    expect((await t.db.select({ u: user.username }).from(user).where(eq(user.id, adminId)))[0].u).toBeNull();
  });

  it("いまのパスワードでパスワードを変えられる。ほかの端末のログインを切れる", async () => {
    const other = t.cookieOf(await t.call("/sign-in/email", { email: "admin@example.com", password: PW }, "", "10.7.0.2"));
    expect((await t.call("/change-password", { currentPassword: "wrong password!!", newPassword: "another good pass" }, admin)).status).not.toBe(200);
    const r = await t.call("/change-password", { currentPassword: PW, newPassword: "another good pass", revokeOtherSessions: true }, admin);
    expect(r.status).toBe(200);
    admin = t.cookieOf(r); // 新しいセッション
    expect(await t.auth.api.getSession({ headers: t.headers(other) })).toBeNull();
    expect(await t.auth.api.getSession({ headers: t.headers(admin) })).not.toBeNull();
    expect((await t.call("/sign-in/email", { email: "admin@example.com", password: "another good pass" }, "", "10.7.0.3")).status).toBe(200);
  });

  it("自分のパスキーだけ名前を変えられる", async () => {
    const id = randomUUID();
    await t.db.insert(passkey).values({ id, name: "パスキー", publicKey: "x", userId: editorId, credentialID: randomUUID(), counter: 0, deviceType: "singleDevice", backedUp: false, createdAt: new Date() });
    expect((await t.call("/passkey/update-passkey", { id, name: "仕事の PC" }, admin)).status).not.toBe(200);
    expect((await t.call("/passkey/update-passkey", { id, name: "仕事の PC" }, editor)).status).toBe(200);
    expect((await t.db.select({ n: passkey.name }).from(passkey).where(eq(passkey.id, id)))[0].n).toBe("仕事の PC");
  });
});

describe("管理者による二段階認証・パスキーのリセット(自分用の版)", () => {
  it("編集者・自分・オーナー・ほかのチームの人には使えない", async () => {
    expect(await code(teams.resetSignIn(t.headers(editor), adminId, "twoFactor"))).toBe(403);
    expect(await code(teams.resetSignIn(t.headers(admin), adminId, "twoFactor"))).toBe(400);
    expect(await code(teams.resetSignIn(t.headers(admin), ownerId, "twoFactor"))).toBe(403);
    expect(await code(teams.resetSignIn(t.headers(admin), "no-such-user", "passkeys"))).toBe(404);
  });

  it("二段階認証を外し、パスキーを消すと、その人のログインも切れ、記録に残る", async () => {
    await t.db.insert(twoFactor).values({ id: randomUUID(), secret: "s", backupCodes: "b", userId: editorId });
    await t.db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, editorId));
    expect(await teams.resetSignIn(t.headers(admin), editorId, "twoFactor")).toEqual({ removed: 1 });
    expect((await t.db.select().from(user).where(eq(user.id, editorId)))[0].twoFactorEnabled).toBe(false);
    expect(await t.db.select().from(twoFactor).where(eq(twoFactor.userId, editorId))).toHaveLength(0);
    expect(await t.db.select().from(session).where(eq(session.userId, editorId))).toHaveLength(0);

    expect(await teams.resetSignIn(t.headers(owner), editorId, "passkeys")).toEqual({ removed: 1 });
    expect(await t.db.select().from(passkey).where(eq(passkey.userId, editorId))).toHaveLength(0);
    const log = await t.db.select({ action: auditLog.action, target: auditLog.target }).from(auditLog);
    expect(log).toEqual(expect.arrayContaining([{ action: "二段階認証を外す", target: "新しい名前" }, { action: "パスキーをすべて消す", target: "新しい名前" }]));
  });

  it("サービス版では使えない", async () => {
    const svc = teamService({ db: t.db, auth: t.auth, secret: TEST_SECRET, fetch });
    expect(await code(svc.resetSignIn(t.headers(owner), adminId, "twoFactor"))).toBe(400);
  });
});
