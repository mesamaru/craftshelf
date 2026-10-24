import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

// ログイン中の利用者(未ログインなら null)と、アプリの動き方(自分用かサービス版か・登録できるか)
export const getAppState = createServerFn({ method: "GET" }).handler(async () => {
  const { auth, db, env } = await import("~/server/instance");
  const { signupOpen } = await import("~/server/auth");
  const s = await auth.api.getSession({ headers: getRequest().headers });
  const app = { mode: env.mode, signupOpen: await signupOpen(db, env.mode) };
  if (!s) return { user: null, app };
  const { id, name, email, twoFactorEnabled } = s.user;
  return { user: { id, name, email, twoFactorEnabled: !!twoFactorEnabled }, app };
});

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getAppState>>["user"]>;
