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
  return { user: { id, name, email, username: displayUsername || username || null, twoFactorEnabled: !!twoFactorEnabled, legacyTotp: legacy, theme: await prefs.theme(id), background: await prefs.backgroundUrl(id) }, app };
});

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getAppState>>["user"]>;

// v02 から取り込んだ結果(チームの管理者だけ)
export const getImportReport = createServerFn({ method: "GET" }).handler(async () => {
  const { auth, env } = await import("~/server/instance");
  const { requireTeam } = await import("~/server/guard");
  const { depsReportPath, readKindsReport, readLibraryReport, readPermsReport, readPinsReport, readReport, readReportFile, sharesReportPath } = await import("~/server/import-v02");
  await requireTeam(auth, getRequest().headers, { member: ["update"] });
  const report = env.mode === "self" ? readReport(env.v03Dir) : null;
  if (!report) return null;
  const library = readLibraryReport(env.v03Dir);
  const pins = readPinsReport(env.v03Dir);
  // 03.58.00 までの取り込みは「固定は引き継がない」と書いていた。固定を取り込んだあとは、そちらの結果を出す
  if (library && pins) library.skipped = library.skipped.filter((x) => !x.what.startsWith("セットの版の固定"));
  const perms = readPermsReport(env.v03Dir);
  // 03.59.00 までの取り込みは「個別の権限は役割に置き換わった」と書いていた。権限を取り込んだあとは、そちらの結果を出す
  if (perms) report.notes = report.notes.filter((n) => !n.includes("個別に付けていた権限"));
  return { ...report, library, kinds: readKindsReport(env.v03Dir), pins, perms,
    deps: readReportFile<import("~/server/import-v02").DepsImportReport>(depsReportPath(env.v03Dir)), shares: readReportFile<import("~/server/import-v02").SharesImportReport>(sharesReportPath(env.v03Dir)) };
});
