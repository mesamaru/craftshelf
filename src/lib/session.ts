import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

// ログイン中の利用者(未ログインなら null)
export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = await import("~/server/instance");
  const s = await auth.api.getSession({ headers: getRequest().headers });
  if (!s) return null;
  const { id, name, email, twoFactorEnabled } = s.user;
  return { id, name, email, twoFactorEnabled: !!twoFactorEnabled };
});

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;
