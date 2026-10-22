import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { passkey } from "@better-auth/passkey";
import { apiKey } from "@better-auth/api-key";
import type { Db } from "./db";
import * as schema from "./db/schema";

export const APP_NAME = "Craftshelf Next";

export function createAuth(db: Db, opts: { appUrl: string; secret: string; clientIpHeader?: string }) {
  const url = new URL(opts.appUrl);
  return betterAuth({
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
    plugins: [
      twoFactor({ issuer: APP_NAME }),
      passkey({ rpID: url.hostname, rpName: APP_NAME, origin: url.origin }),
      organization(),
      apiKey(),
      tanstackStartCookies(), // 最後に置く
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
