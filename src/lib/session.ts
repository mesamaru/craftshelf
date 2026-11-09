import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

// ログイン中の利用者(未ログインなら null)と、アプリの動き方(自分用かサービス版か・登録できるか)
export const getAppState = createServerFn({ method: "GET" }).handler(async () => {
  const { auth, db, env, prefs } = await import("~/server/instance");
  const { signupOpen } = await import("~/server/auth");
  const s = await auth.api.getSession({ headers: getRequest().headers });
  const app = { mode: env.mode, signupOpen: await signupOpen(db, env.mode), mail: !!env.mail, verifyEmail: !!env.mail && env.mode === "service" };
  if (!s) return { user: null, app };
  const { eq } = await import("drizzle-orm");
  const { legacyTotp } = await import("~/server/db/schema");
  // v02 の二段階認証のまま(v03 で設定し直していない)か
  const legacy = !s.user.twoFactorEnabled && (await db.select({ id: legacyTotp.userId }).from(legacyTotp).where(eq(legacyTotp.userId, s.user.id))).length > 0;
  const { id, name, email, twoFactorEnabled, displayUsername, username } = s.user;
  return { user: { id, name, email, username: displayUsername || username || null, twoFactorEnabled: !!twoFactorEnabled, legacyTotp: legacy, theme: await prefs.theme(id) }, app };
});

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getAppState>>["user"]>;

// v02 から取り込んだ結果(チームの管理者だけ)
export const getImportReport = createServerFn({ method: "GET" }).handler(async () => {
  const { auth, env } = await import("~/server/instance");
  const { requireTeam } = await import("~/server/guard");
  const { readLibraryReport, readReport } = await import("~/server/import-v02");
  await requireTeam(auth, getRequest().headers, { member: ["update"] });
  const report = env.mode === "self" ? readReport(env.v03Dir) : null;
  return report ? { ...report, library: readLibraryReport(env.v03Dir) } : null;
});
