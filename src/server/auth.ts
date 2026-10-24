import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { passkey } from "@better-auth/passkey";
import { apiKey } from "@better-auth/api-key";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ac, roles } from "~/lib/permissions";
import type { Db } from "./db";
import * as schema from "./db/schema";

export const APP_NAME = "CraftShelf";

// 無料で使える範囲
export const LIMITS = { teamsPerUser: 5, membersPerTeam: 20 };

export function createAuth(db: Db, opts: { appUrl: string; secret: string; clientIpHeader?: string }) {
  const url = new URL(opts.appUrl);

  // 最初に入ったチーム(ログインしたとき、これを選んだ状態にする)
  const firstTeam = async (userId: string) => {
    const [m] = await db.select({ id: schema.member.organizationId }).from(schema.member)
      .where(eq(schema.member.userId, userId)).orderBy(asc(schema.member.createdAt)).limit(1);
    return m?.id ?? null;
  };

  const auth = betterAuth({
    appName: APP_NAME,
    baseURL: opts.appUrl,
    secret: opts.secret,
    trustedOrigins: [url.origin],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    // ログインなどの回数制限。複数のプロセスでも効くよう、データベースに数える
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      useSecureCookies: url.protocol === "https:",
      ...(opts.clientIpHeader ? { ipAddress: { ipAddressHeaders: [opts.clientIpHeader] } } : {}),
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // 登録したら、その人だけのチームを 1 つ作る。登録と同時にできたセッションは
          // チームより先に作られるので、ここでチームを選んだ状態にする
          after: async (user) => {
            const team = await auth.api.createOrganization({
              body: { name: `${user.name} のチーム`, slug: `t-${randomBytes(6).toString("hex")}`, userId: user.id },
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
      passkey({ rpID: url.hostname, rpName: APP_NAME, origin: url.origin }),
      organization({
        ac,
        roles,
        creatorRole: "owner",
        organizationLimit: LIMITS.teamsPerUser,
        membershipLimit: LIMITS.membersPerTeam,
        cancelPendingInvitationsOnReInvite: true,
      }),
      apiKey(),
      tanstackStartCookies(), // 最後に置く
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
