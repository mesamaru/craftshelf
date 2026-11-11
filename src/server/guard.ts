// サーバー側の処理ごとの確認: ログインしているか(または API トークン)・選んでいるチームでその操作をしてよいか
import { and, eq } from "drizzle-orm";
import { type RoleName, SCOPE_LABELS, TOKEN_SCOPES, type TokenScope, isTokenScope, permits, permsOf, scopesFor, type statements } from "~/lib/permissions";
import type { Auth } from "./auth";
import { member, memberPerm, teamOption } from "./db/schema";

export type Permissions = { [K in keyof typeof statements]?: (typeof statements)[K][number][] };

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * HttpError か。ビルドすると束が 2 つに分かれて HttpError のクラスも 2 つでき、instanceof では見分けられないので、名前と status で見る
 */
export const isHttpError = (e: unknown): e is HttpError =>
  (e as { name?: unknown } | null)?.name === "HttpError" && typeof (e as { status?: unknown }).status === "number";

/** 本文を max バイトまで少しずつ読む(大きさを知らせていなくても、超えたら途中でやめて 400)。権限を確かめてから呼ぶ */
export async function readBody(request: Request, max: number, tooLarge = "ファイルが大きすぎます") {
  if (Number(request.headers.get("content-length") ?? 0) > max) throw new HttpError(400, tooLarge);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    size += r.value.byteLength;
    if (size > max) {
      await reader!.cancel().catch(() => {});
      throw new HttpError(400, tooLarge);
    }
    chunks.push(r.value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// API トークン(cs_…)は、x-api-key か Authorization: Bearer で受け取る
export const apiKeyOf = (headers: Headers) =>
  headers.get("x-api-key")?.trim() || headers.get("authorization")?.match(/^Bearer\s+(cs_\S+)$/i)?.[1] || null;

type KeyMeta = { teamId?: string; readOnly?: boolean; scopes?: unknown };

/** トークンの範囲。03.56 までのトークン(scopes が無い)は、読み取りだけなら read、そうでなければ役割のとおり(すべて) */
export function scopesOf(meta: KeyMeta): TokenScope[] {
  if (Array.isArray(meta.scopes)) return [...new Set(["read" as const, ...meta.scopes.filter(isTokenScope)])];
  return meta.readOnly ? ["read"] : [...TOKEN_SCOPES];
}

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
  const scopes = scopesOf(meta);
  return { user, teamId: meta.teamId, role: member.role as RoleName, scopes, readOnly: scopes.length === 1 };
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

/** JSON の文字列の配列(読めなければ空) */
export const jsonList = (v: string | null | undefined): string[] => {
  try {
    const a = JSON.parse(v ?? "[]");
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * そのチームでのその人の権限(メンバーでなければ null)。Better Auth の役割の権限(~/lib/permissions の roles。member・invitation・organization は
 * Better Auth も同じ役割で確かめる)に、チームの設定(編集者にも設定ファイル)と、メンバーごとの足し引き(member_perm)を合わせる
 */
export async function memberPerms(auth: Auth, teamId: string, userId: string) {
  return (await memberAccess(auth, teamId, userId))?.perms ?? null;
}

/** memberPerms と同じ確かめ(毎回データベースを読む。キャッシュしない)で、役割(owner,admin など)も返す。requireTeam が 1 回だけ読み、結果を呼び出しの中で使い回す */
export async function memberAccess(auth: Auth, teamId: string, userId: string) {
  const [m] = await auth.appDb.select({ role: member.role, allow: memberPerm.allow, deny: memberPerm.deny, editorFiles: teamOption.editorFiles }).from(member)
    .leftJoin(memberPerm, eq(memberPerm.memberId, member.id)).leftJoin(teamOption, eq(teamOption.teamId, member.organizationId))
    .where(and(eq(member.organizationId, teamId), eq(member.userId, userId)));
  return m ? { role: m.role, perms: permsOf(m.role, { allow: jsonList(m.allow), deny: jsonList(m.deny), editorFiles: !!m.editorFiles }) } : null;
}

type Resolved = { apiKey: { readOnly: boolean; scopes: TokenScope[] } | null };
// その権限があるか(API トークンは、トークンの範囲とその人の今の権限の両方)。無ければ 403
function authorize(s: Resolved, perms: ReadonlySet<string>, permissions: Permissions) {
  if (s.apiKey) {
    if (s.apiKey.readOnly) throw new HttpError(403, "読み取りだけの API トークンでは、この操作はできません");
    const lack = scopesFor(permissions).filter((x) => !s.apiKey!.scopes.includes(x));
    if (lack.length) throw new HttpError(403, `この API トークンの範囲では、この操作はできません(要る範囲: ${lack.map((x) => SCOPE_LABELS[x]).join("、")})`);
  }
  if (!permits(perms, permissions)) throw new HttpError(403, "この操作をする権限がありません");
}

/** requireTeam が返した人が、この権限を持っているか(データベースは読まない。同じ呼び出しの中で認証を繰り返さないために使う) */
export function holds(who: Resolved & { perms: ReadonlySet<string> }, permissions: Permissions) {
  try {
    authorize(who, who.perms, permissions);
    return true;
  } catch (e) {
    if (isHttpError(e) && e.status === 403) return false;
    throw e;
  }
}

// チームの中の操作。いまもそのチームのメンバーかを必ず確かめる(外された人のセッションに、選んでいたチームが残っていても断る)。
// permissions を渡すと、その権限があるかも確かめる(API トークンは、トークンの範囲とその人の今の権限の両方)
export async function requireTeam(auth: Auth, headers: Headers, permissions?: Permissions) {
  const s = await requireUser(auth, headers);
  const teamId = s.session.activeOrganizationId;
  if (!teamId) throw new HttpError(403, "チームを選んでください");
  const access = await memberAccess(auth, teamId, s.user.id);
  if (!access) throw new HttpError(403, "このチームのメンバーではありません");
  if (permissions) authorize(s, access.perms, permissions);
  // role・perms は、この確かめで読んだもの(続く処理が役割・権限を読み直さずに使える)
  return { ...s, teamId, role: access.role, perms: access.perms };
}

/** その権限があるか(無くても例外にしない) */
export async function allowed(auth: Auth, headers: Headers, permissions: Permissions) {
  try {
    await requireTeam(auth, headers, permissions);
    return true;
  } catch (e) {
    if (isHttpError(e) && e.status === 403) return false;
    throw e;
  }
}
