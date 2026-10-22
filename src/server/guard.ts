// サーバー側の処理ごとの確認: ログインしているか・選んでいるチームでその操作をしてよいか
import type { statements } from "~/lib/permissions";
import type { Auth } from "./auth";

type Permissions = { [K in keyof typeof statements]?: (typeof statements)[K][number][] };

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function requireUser(auth: Auth, headers: Headers) {
  const s = await auth.api.getSession({ headers });
  if (!s) throw new HttpError(401, "ログインしてください");
  return s;
}

// チームの中の操作。permissions を渡すと、その権限があるかも確かめる
export async function requireTeam(auth: Auth, headers: Headers, permissions?: Permissions) {
  const s = await requireUser(auth, headers);
  const teamId = s.session.activeOrganizationId;
  if (!teamId) throw new HttpError(403, "チームを選んでください");
  if (permissions) {
    const r = await auth.api.hasPermission({ headers, body: { organizationId: teamId, permissions } });
    if (!r.success) throw new HttpError(403, "この操作をする権限がありません");
  }
  return { ...s, teamId };
}
