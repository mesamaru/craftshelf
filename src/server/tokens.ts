// API トークン(cs_…)の作成・一覧・削除。トークンは選んでいるチームのもので、作った人のそのチームでの役割で動く。
// 範囲(読む・Mod・プラグインを変える・サーバーを操作する・管理)を選べ、選ばなかった操作はできない。範囲は作った人の役割を超えられない。
// トークンそのものは作ったときにだけ返す
import { and, eq } from "drizzle-orm";
import { SCOPE_LABELS, type TokenScope, isTokenScope, roleAllowsScope } from "~/lib/permissions";
import { member } from "./db/schema";
import { HttpError, apiKeyOf, requireTeam, scopesOf } from "./guard";
import type { Deps } from "./servers";
import { eventService } from "./events";

export const TOKEN_LIMITS = { perUserTeam: 20, maxDays: 365 };
type Meta = { teamId?: string; readOnly?: boolean; scopes?: unknown };
const metaOf = (m: unknown): Meta => {
  try {
    return (typeof m === "string" ? JSON.parse(m) : m ?? {}) as Meta;
  } catch {
    return {};
  }
};

export function tokenService(deps: Deps) {
  const { auth } = deps;
  const { record } = eventService(deps);
  // トークンの管理は、ログインしてから(トークンでトークンを作らせない)
  const needSession = (headers: Headers) => {
    if (apiKeyOf(headers)) throw new HttpError(403, "API トークンの管理は、ログインしてから行ってください");
  };

  return {
    /** このチームで自分が作ったトークン(中身は最初の数文字だけ) */
    async list(headers: Headers) {
      needSession(headers);
      const { teamId } = await requireTeam(auth, headers);
      const keys = (await auth.api.listApiKeys({ headers })) as unknown as { apiKeys?: unknown[] } | unknown[];
      const arr = (Array.isArray(keys) ? keys : keys.apiKeys ?? []) as { id: string; name: string | null; start: string | null; prefix: string | null; createdAt: Date; expiresAt: Date | null; lastRequest: Date | null; metadata: unknown }[];
      return arr.filter((k) => metaOf(k.metadata).teamId === teamId).map((k) => ({
        id: k.id, name: k.name ?? "", start: k.start ?? k.prefix ?? "cs_", scopes: scopesOf(metaOf(k.metadata)), readOnly: scopesOf(metaOf(k.metadata)).length === 1,
        createdAt: new Date(k.createdAt).toISOString(), expiresAt: k.expiresAt ? new Date(k.expiresAt).toISOString() : null,
        lastUsed: k.lastRequest ? new Date(k.lastRequest).toISOString() : null,
      }));
    },

    /** トークンを作る(days が 0 なら期限なし。scopes に read は必ず入る)。返す key は、このときにしか見られない */
    async create(headers: Headers, input: { name: string; scopes: string[]; days: number }) {
      needSession(headers);
      const { teamId, user } = await requireTeam(auth, headers);
      if (!Array.isArray(input.scopes) || !input.scopes.every(isTokenScope)) throw new HttpError(400, "トークンの範囲を選んでください");
      const scopes = [...new Set<TokenScope>(["read", ...input.scopes])];
      const [me] = await deps.db.select({ role: member.role }).from(member).where(and(eq(member.organizationId, teamId), eq(member.userId, user.id)));
      const over = scopes.filter((x) => !roleAllowsScope(me?.role ?? "", x));
      if (over.length) throw new HttpError(403, `あなたの役割では、この範囲のトークンは作れません(${over.map((x) => SCOPE_LABELS[x]).join("、")})`);
      const name = String(input.name ?? "").trim().slice(0, 60);
      if (!name) throw new HttpError(400, "トークンの名前(使い道)を入力してください");
      const days = Math.floor(Number(input.days) || 0);
      if (days < 0 || days > TOKEN_LIMITS.maxDays) throw new HttpError(400, `期限は 0(期限なし)〜${TOKEN_LIMITS.maxDays} 日にしてください`);
      if ((await this.list(headers)).length >= TOKEN_LIMITS.perUserTeam) throw new HttpError(400, `トークンは 1 つのチームで ${TOKEN_LIMITS.perUserTeam} 個までです`);
      const r = await auth.api.createApiKey({
        body: { name, userId: user.id, prefix: "cs_", metadata: { teamId, scopes, readOnly: scopes.length === 1 }, expiresIn: days ? days * 86400 : null,
          rateLimitEnabled: true, rateLimitTimeWindow: 60_000, rateLimitMax: 120 },
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "API トークンを作る", target: name, detail: scopes.map((x) => SCOPE_LABELS[x]).join("、") });
      return { id: r.id, key: r.key };
    },

    /** トークンを消す */
    async remove(headers: Headers, id: string) {
      needSession(headers);
      const { teamId, user } = await requireTeam(auth, headers);
      const mine = (await this.list(headers)).find((k) => k.id === id);
      if (!mine) throw new HttpError(404, "見つかりません");
      await auth.api.deleteApiKey({ headers, body: { keyId: id } });
      await record({ teamId, userId: user.id, kind: "admin", action: "API トークンを消す", target: mine.name });
    },
  };
}
