import { randomBytes, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx, isAPIError } from "better-auth/api";
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
import { MAILS, type Mailer } from "./mail";

// v02 のユーザー名の決まり(英数字・日本語などの文字と . _ - @、40 文字まで)
export const USERNAME_RE = /^[\p{L}\p{N}_.@-]{1,40}$/u;
export const legacyTotpContext = (userId: string) => `v02-totp:${userId}`;

export const APP_NAME = "CraftShelf";

// ログイン・アカウントの操作を残す操作の記録の種類(EVENT_KINDS には入れない: Discord には送らず、お知らせにも出さない)
export const ACCOUNT_KIND = "account";
const SIGN_IN = new Set(["/sign-in/email", "/sign-in/username", "/passkey/verify-authentication", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);

// サービス版で無料で使える範囲。自分用の版はチームを 1 つだけ使う
export const LIMITS = { teamsPerUser: 5, membersPerTeam: 20 };

// URL を決めていないとき: ブラウザが開いたアドレスと同じホストからのリクエストを受け付ける。
// リバースプロキシ(HTTPS)の後ろでは、こちらには http://内側のアドレス しか見えず、Origin と合わなくなるため
export function sameHostOrigins(req?: Request): string[] {
  if (!req) return [];
  const hosts = [req.headers.get("x-forwarded-host")?.split(",")[0].trim(), req.headers.get("host")].filter((h): h is string => !!h);
  return hosts.flatMap((h) => [`https://${h}`, `http://${h}`]);
}

type Options = { appUrl: string | null; secret: string; clientIpHeader?: string; mode?: Mode; mailer?: Mailer | null };

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
  // 操作の記録に残す(記録できなくても、ログインなどは止めない)
  const log = async (teamId: string | null, userId: string | null, action: string, target = "", detail = "") => {
    if (!teamId) return;
    try {
      await db.insert(schema.auditLog).values({ id: randomUUID(), teamId, userId, kind: ACCOUNT_KIND, action, target: target.slice(0, 200), detail: detail.slice(0, 2000) });
    } catch (e) {
      console.error("[記録] ログインの記録を残せませんでした:", e instanceof Error ? e.message : e);
    }
  };
  const nameOf = async (userId: string) => (await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId)).limit(1))[0]?.name ?? "";
  const userCount = async () => (await db.select({ n: count() }).from(schema.user))[0].n;
  // メール: 送れるとき(と、リンクに使う URL がわかるとき)だけ。ログインの前にメールアドレスの確認を求めるのはサービス版だけ。
  // 招待を受けるときは、メールを送れるならどちらの版でも確認を求める(リンクを知っている他人が、そのアドレスで先に登録して参加できないように)
  const mailer = opts.mailer ?? null;
  const verify = !!mailer && mode === "service";
  const send = (to: string, m: { subject: string; text: string }) => mailer!.send({ to, ...m }).catch((e) => console.error("[メール] 送れませんでした:", e));

  const auth = betterAuth({
    appName: APP_NAME,
    ...(url ? { baseURL: url.origin, trustedOrigins: [url.origin] } : { trustedOrigins: sameHostOrigins }),
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: verify,
      ...(mailer ? { sendResetPassword: async ({ user, url: link }: { user: { email: string }; url: string }) => send(user.email, MAILS.reset(link)) } : {}),
      // v02 から取り込んだパスワード(Werkzeug の形)もそのまま使えるようにする
      password: { hash: hashPassword, verify: async ({ hash, password }) => verifyWerkzeug(hash, password) ?? verifyPassword({ hash, password }) },
    },
    hooks: {
      // v02 で二段階認証を使っていた人は、v02 の認証アプリのコード(ヘッダー x-v02-totp)も確かめる。
      // パスワードが合っているときだけ求める(ユーザー名からは、二段階認証の有無がわからないように)
      before: createAuthMiddleware(async (ctx) => {
        // ログアウト(消したあとはだれかわからないので、消す前に残す)
        if (ctx.path === "/sign-out") {
          const s = await getSessionFromCtx(ctx).catch(() => null);
          if (s) await log(s.session.activeOrganizationId ?? (await firstTeam(s.user.id)), s.user.id, "ログアウト");
          return;
        }
        // 表示名の長さ(Better Auth は決めていない)
        if ((ctx.path === "/update-user" || ctx.path === "/sign-up/email") && String((ctx.body as { name?: unknown } | undefined)?.name ?? "").length > 60) {
          throw new APIError("BAD_REQUEST", { message: "表示名は 60 文字までです", code: "NAME_TOO_LONG" });
        }
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
      // ログイン(と失敗)・パスワードの変更・メンバーの招待・役割の変更・外すを、操作の記録に残す
      after: createAuthMiddleware(async (ctx) => {
        const failed = isAPIError(ctx.context.returned);
        const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options) ?? "";
        const from = ip ? `IP ${ip}` : "";
        if (SIGN_IN.has(ctx.path)) {
          const s = ctx.context.newSession;
          if (s) return log(s.session.activeOrganizationId ?? (await firstTeam(s.user.id)), s.user.id, "ログイン", "", from);
          if (!failed || (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-in/username")) return;
          const body = (ctx.body ?? {}) as { username?: unknown; email?: unknown };
          const name = String((ctx.path === "/sign-in/username" ? body.username : body.email) ?? "").toLowerCase().slice(0, 100);
          const [u] = name ? await db.select({ id: schema.user.id }).from(schema.user)
            .where(ctx.path === "/sign-in/username" ? eq(schema.user.username, name) : eq(schema.user.email, name)).limit(1) : [];
          // いない人の名前の失敗は、自分用の版だけ(チームが 1 つなのでそこに残す)
          const team = u ? await firstTeam(u.id) : mode === "self" ? (await db.select({ id: schema.organization.id }).from(schema.organization).limit(1))[0]?.id ?? null : null;
          return log(team, u?.id ?? null, "ログインに失敗", name, from);
        }
        if (failed) return;
        // チームの操作は、Better Auth が読んだセッションを after に渡さないので読み直す
        const s = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
        if (!s) return;
        const body = (ctx.body ?? {}) as { organizationId?: unknown; email?: unknown; role?: unknown };
        const team = typeof body.organizationId === "string" ? body.organizationId : s.session.activeOrganizationId ?? null;
        const ret = ctx.context.returned as { member?: { userId?: string; role?: string }; userId?: string; role?: string } | null;
        const role = (r: unknown) => String(Array.isArray(r) ? r.join("・") : r ?? "");
        if (ctx.path === "/change-password") return log(await firstTeam(s.user.id), s.user.id, "パスワードを変える", "", from);
        if (ctx.path === "/organization/invite-member") return log(team, s.user.id, "メンバーを招待", String(body.email ?? ""), role(body.role));
        if (ctx.path === "/organization/update-member-role") {
          const m = ret?.member ?? ret;
          return log(team, s.user.id, "メンバーの役割を変える", m?.userId ? await nameOf(m.userId) : "", role(body.role));
        }
        if (ctx.path === "/organization/remove-member") {
          const m = ret?.member;
          return log(team, s.user.id, "メンバーを外す", m?.userId ? await nameOf(m.userId) : "");
        }
      }),
    },
    ...(mailer ? {
      emailVerification: {
        // 自分用の版は、招待のページで「確認のメールを送る」を押したときだけ送る(最初の 1 人・招待を受けない人には送らない)
        sendOnSignUp: verify, sendOnSignIn: verify, autoSignInAfterVerification: true, expiresIn: 60 * 60 * 24,
        sendVerificationEmail: async ({ user, url: link }: { user: { email: string }; url: string }) => send(user.email, MAILS.verify(link)),
      },
    } : {}),
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    // ログインなどの回数制限。複数のプロセスでも効くよう、データベースに数える
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      disableOriginCheck: false, // テスト(NODE_ENV=test)でも、ほかのサイトからのリクエストを断る確認を行う
      // URL を決めていなければ、プロキシが伝える元のアドレス(X-Forwarded-Host / Proto)から自分の URL を決める
      ...(url ? { useSecureCookies: url.protocol === "https:" } : { trustedProxyHeaders: true }),
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
        // メールを送れるときは、確かめたメールアドレスでないと招待を見る・受ける・断ることができない
        requireEmailVerificationOnInvitation: !!mailer,
        // 外された人のセッションに、選んでいたチームが残らないようにする(Better Auth が消すのは、自分で抜けたときだけ)
        organizationHooks: {
          afterRemoveMember: async ({ member: m, organization: o }: { member: { userId: string }; organization: { id: string } }) => {
            await db.update(schema.session).set({ activeOrganizationId: null })
              .where(and(eq(schema.session.userId, m.userId), eq(schema.session.activeOrganizationId, o.id)));
          },
        },
        // 招待のリンクをメールでも送る(URL を決めているときだけ。画面のリンクはいつもどおり出す)
        ...(mailer && url ? {
          sendInvitationEmail: async (d: { id: string; email: string; organization: { name: string }; inviter: { user: { name: string } } }) =>
            send(d.email, MAILS.invite(d.inviter.user.name, d.organization.name, `${url.origin}/invite/${d.id}`)),
        } : {}),
      }),
      // API トークン(cs_…)。チーム(metadata.teamId)ごとに作り、1 分に 120 回まで
      apiKey({ defaultPrefix: "cs_", enableMetadata: true, rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 } }),
      tanstackStartCookies(), // 最後に置く
    ],
  });
  // 権限の確かめ(guard.ts)が、メンバーごとの足し引き・チームの設定を読むのに使う
  return Object.assign(auth, { appDb: db });
}

export type Auth = ReturnType<typeof createAuth>;

// 登録の画面を出すか(サービス版はいつでも。自分用の版は最初の 1 人がまだいないときだけ)
export async function signupOpen(db: Db, mode: Mode) {
  if (mode === "service") return true;
  return (await db.select({ n: count() }).from(schema.user))[0].n === 0;
}
