import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, twoFactor, username } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { passkey } from "@better-auth/passkey";
import { apiKey } from "@better-auth/api-key";
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import { ac, roles } from "~/lib/permissions";
import type { Db } from "./db";
import * as schema from "./db/schema";
import type { Mode } from "./env";
import { verifyV02Totp, verifyWerkzeug } from "./legacy";
import { open } from "./secrets";

// v02 のユーザー名の決まり(英数字・日本語などの文字と . _ - @、40 文字まで)
export const USERNAME_RE = /^[\p{L}\p{N}_.@-]{1,40}$/u;
export const legacyTotpContext = (userId: string) => `v02-totp:${userId}`;

export const APP_NAME = "CraftShelf";

// サービス版で無料で使える範囲。自分用の版はチームを 1 つだけ使う
export const LIMITS = { teamsPerUser: 5, membersPerTeam: 20 };

type Options = { appUrl: string | null; secret: string; clientIpHeader?: string; mode?: Mode };

export function createAuth(db: Db, opts: Options) {
  const mode = opts.mode ?? "service";
  // 自分用の版で URL を決めていないときは、開いたアドレス(リクエスト)に合わせる
  const url = opts.appUrl ? new URL(opts.appUrl) : null;

  // 最初に入ったチーム(ログインしたとき、これを選んだ状態にする)
  const firstTeam = async (userId: string) => {
    const [m] = await db.select({ id: schema.member.organizationId }).from(schema.member)
      .where(eq(schema.member.userId, userId)).orderBy(asc(schema.member.createdAt)).limit(1);
    return m?.id ?? null;
  };
  const userCount = async () => (await db.select({ n: count() }).from(schema.user))[0].n;

  const auth = betterAuth({
    appName: APP_NAME,
    ...(url ? { baseURL: url.origin, trustedOrigins: [url.origin] } : {}),
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      // v02 から取り込んだパスワード(Werkzeug の形)もそのまま使えるようにする
      password: { hash: hashPassword, verify: async ({ hash, password }) => verifyWerkzeug(hash, password) ?? verifyPassword({ hash, password }) },
    },
    hooks: {
      // v02 で二段階認証を使っていた人は、v02 の認証アプリのコード(ヘッダー x-v02-totp)も確かめる。
      // パスワードが合っているときだけ求める(ユーザー名からは、二段階認証の有無がわからないように)
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/username" && ctx.path !== "/sign-in/email") return;
        const body = (ctx.body ?? {}) as { username?: string; email?: string; password?: string };
        const where = ctx.path === "/sign-in/username"
          ? eq(schema.user.username, String(body.username ?? "").toLowerCase())
          : eq(schema.user.email, String(body.email ?? "").toLowerCase());
        const [u] = await db.select({ id: schema.user.id, tfa: schema.user.twoFactorEnabled }).from(schema.user).where(where).limit(1);
        if (!u) return;
        const [legacy] = await db.select().from(schema.legacyTotp).where(eq(schema.legacyTotp.userId, u.id)).limit(1);
        if (!legacy) return;
        if (u.tfa) { // v03 で設定し直したので、v02 のものは使わない
          await db.delete(schema.legacyTotp).where(eq(schema.legacyTotp.userId, u.id));
          return;
        }
        const [acc] = await db.select({ password: schema.account.password }).from(schema.account)
          .where(and(eq(schema.account.userId, u.id), eq(schema.account.providerId, "credential"))).limit(1);
        const pw = String(body.password ?? "");
        const ok = !!acc?.password && (verifyWerkzeug(acc.password, pw) ?? (await verifyPassword({ hash: acc.password, password: pw })));
        if (!ok) return; // パスワードが違う: いつもどおり「違います」と返す
        const code = ctx.headers?.get("x-v02-totp");
        if (!code) throw new APIError("UNAUTHORIZED", { message: "認証アプリのコードを入力してください", code: "V02_TOTP_REQUIRED" });
        if (!verifyV02Totp(open(opts.secret, legacy.secretSealed, legacyTotpContext(u.id)), code)) {
          throw new APIError("UNAUTHORIZED", { message: "コードが違います", code: "V02_TOTP_INVALID" });
        }
      }),
    },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    // ログインなどの回数制限。複数のプロセスでも効くよう、データベースに数える
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      ...(url ? { useSecureCookies: url.protocol === "https:" } : {}),
      ...(opts.clientIpHeader ? { ipAddress: { ipAddressHeaders: [opts.clientIpHeader] } } : {}),
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // 自分用の版: 最初の 1 人のあとは、招待された人だけが登録できる
          before: async (user) => {
            if (mode !== "self" || (await userCount()) === 0) return;
            const [inv] = await db.select({ id: schema.invitation.id }).from(schema.invitation).where(and(
              eq(schema.invitation.email, user.email.toLowerCase()), eq(schema.invitation.status, "pending"),
              gt(schema.invitation.expiresAt, new Date()),
            )).limit(1);
            if (!inv) throw new APIError("FORBIDDEN", { message: "招待された人だけが登録できます。管理者に招待のリンクをもらってください" });
          },
          // チームを作る(サービス版は登録した人ごと、自分用の版は最初の 1 人のときだけ)。登録と同時にできた
          // セッションはチームより先に作られるので、ここでチームを選んだ状態にする
          after: async (user) => {
            if (mode === "self" && (await db.select({ n: count() }).from(schema.organization))[0].n > 0) return;
            const team = await auth.api.createOrganization({
              body: { name: mode === "self" ? APP_NAME : `${user.name} のチーム`, slug: `t-${randomBytes(6).toString("hex")}`, userId: user.id },
            });
            if (team) {
              await db.update(schema.session).set({ activeOrganizationId: team.id })
                .where(and(eq(schema.session.userId, user.id), isNull(schema.session.activeOrganizationId)));
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({ data: { ...session, activeOrganizationId: await firstTeam(session.userId) } }),
        },
      },
    },
    plugins: [
      twoFactor({ issuer: APP_NAME }),
      // ユーザー名でもログインできるように(v02 はユーザー名でログインしていた)
      username({ minUsernameLength: 1, maxUsernameLength: 40, usernameValidator: (u) => USERNAME_RE.test(u) }),
      passkey({ rpName: APP_NAME, ...(url ? { rpID: url.hostname, origin: url.origin } : {}) }),
      organization({
        ac,
        roles,
        creatorRole: "owner",
        // 自分用の版はチームを 1 つだけ使う(作れるのは最初の 1 人の分だけ)
        organizationLimit: mode === "self" ? 1 : LIMITS.teamsPerUser,
        ...(mode === "service" ? { membershipLimit: LIMITS.membersPerTeam } : {}),
        cancelPendingInvitationsOnReInvite: true,
      }),
      apiKey(),
      tanstackStartCookies(), // 最後に置く
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

// 登録の画面を出すか(サービス版はいつでも。自分用の版は最初の 1 人がまだいないときだけ)
export async function signupOpen(db: Db, mode: Mode) {
  if (mode === "service") return true;
  return (await db.select({ n: count() }).from(schema.user))[0].n === 0;
}
