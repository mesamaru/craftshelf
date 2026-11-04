// サーバー側の処理ごとの確認: ログインしているか(または API トークン)・選んでいるチームでその操作をしてよいか
import { type RoleName, roles, type statements } from "~/lib/permissions";
import type { Auth } from "./auth";

type Permissions = { [K in keyof typeof statements]?: (typeof statements)[K][number][] };

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// API トークン(cs_…)は、x-api-key か Authorization: Bearer で受け取る
export const apiKeyOf = (headers: Headers) =>
  headers.get("x-api-key")?.trim() || headers.get("authorization")?.match(/^Bearer\s+(cs_\S+)$/i)?.[1] || null;

type KeyMeta = { teamId?: string; readOnly?: boolean };

// API トークンの持ち主・チーム・役割。トークンはチームごとに作り、作った人のそのチームでの役割で動く
async function fromApiKey(auth: Auth, key: string) {
  const r = await auth.api.verifyApiKey({ body: { key } });
  if (!r.valid || !r.key) {
    if (r.error?.code === "RATE_LIMITED") throw new HttpError(429, "API トークンでのリクエストが多すぎます。少し待ってからお試しください");
    throw new HttpError(401, "API トークンが正しくないか、期限が切れています");
  }
  const meta = (typeof r.key.metadata === "string" ? JSON.parse(r.key.metadata) : r.key.metadata ?? {}) as KeyMeta;
  if (!meta.teamId) throw new HttpError(401, "この API トークンは使えません(CraftShelf の「アカウント」で作り直してください)");
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(r.key.referenceId);
  const member = await ctx.adapter.findOne<{ role: string }>({
    model: "member", where: [{ field: "organizationId", value: meta.teamId }, { field: "userId", value: r.key.referenceId }],
  });
  if (!user || !member) throw new HttpError(401, "この API トークンの持ち主は、もうチームにいません");
  return { user, teamId: meta.teamId, role: member.role as RoleName, readOnly: !!meta.readOnly };
}

export async function requireUser(auth: Auth, headers: Headers) {
  const key = apiKeyOf(headers);
  if (key) {
    const k = await fromApiKey(auth, key);
    return { user: k.user, session: { activeOrganizationId: k.teamId }, apiKey: k };
  }
  const s = await auth.api.getSession({ headers });
  if (!s) throw new HttpError(401, "ログインしてください");
  return { ...s, apiKey: null };
}

// チームの中の操作。permissions を渡すと、その権限があるかも確かめる
export async function requireTeam(auth: Auth, headers: Headers, permissions?: Permissions) {
  const s = await requireUser(auth, headers);
  const teamId = s.session.activeOrganizationId;
  if (!teamId) throw new HttpError(403, "チームを選んでください");
  if (permissions) {
    if (s.apiKey) {
      if (s.apiKey.readOnly) throw new HttpError(403, "読み取りだけの API トークンでは、この操作はできません");
      const role = roles[s.apiKey.role];
      if (!role?.authorize(permissions as never).success) throw new HttpError(403, "この操作をする権限がありません");
    } else {
      const r = await auth.api.hasPermission({ headers, body: { organizationId: teamId, permissions } });
      if (!r.success) throw new HttpError(403, "この操作をする権限がありません");
    }
  }
  return { ...s, teamId };
}

/** その権限があるか(無くても例外にしない) */
export async function allowed(auth: Auth, headers: Headers, permissions: Permissions) {
  try {
    await requireTeam(auth, headers, permissions);
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) return false;
    throw e;
  }
}
