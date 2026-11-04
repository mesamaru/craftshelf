// API トークン(cs_…)の作成・一覧・削除。トークンは選んでいるチームのもので、作った人のそのチームでの役割で動く。
// 「読み取りだけ」にすると、変える操作(入れる・起動など)はできない。トークンそのものは作ったときにだけ返す
import { HttpError, apiKeyOf, requireTeam } from "./guard";
import type { Deps } from "./servers";
import { eventService } from "./events";

export const TOKEN_LIMITS = { perUserTeam: 20, maxDays: 365 };
type Meta = { teamId?: string; readOnly?: boolean };
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
        id: k.id, name: k.name ?? "", start: k.start ?? k.prefix ?? "cs_", readOnly: !!metaOf(k.metadata).readOnly,
        createdAt: new Date(k.createdAt).toISOString(), expiresAt: k.expiresAt ? new Date(k.expiresAt).toISOString() : null,
        lastUsed: k.lastRequest ? new Date(k.lastRequest).toISOString() : null,
      }));
    },

    /** トークンを作る(days が 0 なら期限なし)。返す key は、このときにしか見られない */
    async create(headers: Headers, input: { name: string; readOnly: boolean; days: number }) {
      needSession(headers);
      const { teamId, user } = await requireTeam(auth, headers);
      const name = String(input.name ?? "").trim().slice(0, 60);
      if (!name) throw new HttpError(400, "トークンの名前(使い道)を入力してください");
      const days = Math.floor(Number(input.days) || 0);
      if (days < 0 || days > TOKEN_LIMITS.maxDays) throw new HttpError(400, `期限は 0(期限なし)〜${TOKEN_LIMITS.maxDays} 日にしてください`);
      if ((await this.list(headers)).length >= TOKEN_LIMITS.perUserTeam) throw new HttpError(400, `トークンは 1 つのチームで ${TOKEN_LIMITS.perUserTeam} 個までです`);
      const r = await auth.api.createApiKey({
        body: { name, userId: user.id, prefix: "cs_", metadata: { teamId, readOnly: !!input.readOnly }, expiresIn: days ? days * 86400 : null,
          rateLimitEnabled: true, rateLimitTimeWindow: 60_000, rateLimitMax: 120 },
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "API トークンを作る", target: name, detail: input.readOnly ? "読み取りだけ" : "役割のとおり" });
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
