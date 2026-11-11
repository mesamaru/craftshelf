// エージェントの登録(トークン)・一覧・消す、エージェントのサーバーを足す。エージェントからの「取りに来る」もここで確かめる。
// トークン(ca_…)は作ったときに 1 度だけ見せ、ハッシュだけを残す
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { MC_VERSION, isPlatform } from "~/lib/platforms";
import { agent, agentServer, server, serverProfile } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import type { Deps } from "./servers";

export const AGENT_TEAM_LIMIT = 5;
const TOKEN = /^ca_[A-Za-z0-9_-]{40,60}$/;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export type Reported = { key: string; name: string; platform: string | null; mcVersion: string | null };

/** エージェントが知らせてきたサーバーの一覧を、扱える形にそろえる(変なものは捨てる) */
export function cleanReported(list: unknown): Reported[] {
  const out: Reported[] = [];
  for (const s of Array.isArray(list) ? list.slice(0, 50) : []) {
    const key = String((s as Reported)?.key ?? "");
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key) || out.some((o) => o.key === key)) continue;
    const name = String((s as Reported)?.name ?? key).replace(/[\r\n\t]/g, " ").trim().slice(0, 60) || key;
    const platform = isPlatform((s as Reported)?.platform) ? String((s as Reported).platform) : null;
    const mc = String((s as Reported)?.mcVersion ?? "");
    out.push({ key, name, platform, mcVersion: MC_VERSION.test(mc) ? mc : null });
  }
  return out;
}

export function agentService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const admin = (headers: Headers) => requireTeam(auth, headers, { server: ["create"] });

  return {
    /** チームのエージェントと、それぞれが知らせてきたサーバー(足したものには印) */
    async list(headers: Headers) {
      const { teamId } = await admin(headers);
      const rows = await db.select().from(agent).where(eq(agent.teamId, teamId));
      const added = rows.length ? await db.select().from(agentServer).where(inArray(agentServer.agentId, rows.map((r) => r.id))) : [];
      return rows.map((a) => ({
        id: a.id, name: a.name, tokenHint: a.tokenHint, version: a.version, lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        online: deps.agents?.online(a.id) ?? false,
        servers: (JSON.parse(a.servers) as Reported[]).map((s) => ({ ...s, added: added.some((x) => x.agentId === a.id && x.key === s.key) })),
      }));
    },

    /** エージェントを登録し、トークンを返す(この 1 度だけ) */
    async create(headers: Headers, name: string) {
      const { teamId, user } = await admin(headers);
      const n = String(name ?? "").trim().slice(0, 40);
      if (!n) throw new HttpError(400, "エージェントの名前を入力してください");
      const [{ c }] = await db.select({ c: count() }).from(agent).where(eq(agent.teamId, teamId));
      if (c >= AGENT_TEAM_LIMIT) throw new HttpError(400, `エージェントは ${AGENT_TEAM_LIMIT} 個までです`);
      const token = "ca_" + randomBytes(32).toString("base64url");
      const id = randomUUID();
      await db.insert(agent).values({ id, teamId, name: n, tokenHash: hashOf(token), tokenHint: token.slice(-4), createdBy: user.id });
      await record({ teamId, userId: user.id, kind: "admin", action: "エージェントを登録", target: n });
      return { id, token };
    },

    /** エージェントを消す(足したサーバーも一覧から外す。家のサーバーのファイルは消えない) */
    async remove(headers: Headers, id: string) {
      const { teamId, user } = await admin(headers);
      const [a] = await db.select().from(agent).where(and(eq(agent.id, id), eq(agent.teamId, teamId)));
      if (!a) throw new HttpError(404, "エージェントが見つかりません");
      const ids = (await db.select({ id: agentServer.serverId }).from(agentServer).where(eq(agentServer.agentId, id))).map((r) => r.id);
      await db.transaction(async (tx) => {
        if (ids.length) await tx.delete(server).where(inArray(server.id, ids));
        await tx.delete(agent).where(eq(agent.id, id));
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "エージェントを消す", target: a.name });
    },

    /** エージェントが知らせてきたサーバーを、チームのサーバーに足す */
    async addServer(headers: Headers, agentId: string, key: string) {
      const { teamId, user } = await admin(headers);
      const [a] = await db.select().from(agent).where(and(eq(agent.id, agentId), eq(agent.teamId, teamId)));
      if (!a) throw new HttpError(404, "エージェントが見つかりません");
      const s = (JSON.parse(a.servers) as Reported[]).find((x) => x.key === key);
      if (!s) throw new HttpError(404, "エージェントがこのサーバーを知らせてきていません(エージェントの設定ファイルを確かめてください)");
      if ((await db.select().from(agentServer).where(and(eq(agentServer.agentId, agentId), eq(agentServer.key, key)))).length) {
        throw new HttpError(400, "このサーバーは、もう追加しています");
      }
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(server).values({ id, teamId, kind: "agent", name: s.name, remoteId: key });
        await tx.insert(agentServer).values({ serverId: id, agentId, key });
        if (s.platform) await tx.insert(serverProfile).values({ serverId: id, platform: s.platform, mcVersion: s.mcVersion });
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "エージェントのサーバーを追加", target: s.name, detail: a.name });
      return { id };
    },

    /** エージェントのトークンを確かめ、知らせてきた版・サーバーを残す(取りに来るたびに呼ぶ) */
    /** トークンが正しいか(エージェントの ID。正しくなければ null)。本文を読む前に確かめる */
    async verify(token: string) {
      if (!TOKEN.test(token)) return null;
      const [a] = await db.select({ id: agent.id }).from(agent).where(eq(agent.tokenHash, hashOf(token)));
      return a?.id ?? null;
    },

    async checkIn(token: string, report: { version?: unknown; servers?: unknown }) {
      if (!TOKEN.test(token)) return null;
      const [a] = await db.select({ id: agent.id }).from(agent).where(eq(agent.tokenHash, hashOf(token)));
      if (!a) return null;
      await db.update(agent).set({
        lastSeenAt: new Date(), version: String(report.version ?? "").slice(0, 20), servers: JSON.stringify(cleanReported(report.servers)),
      }).where(eq(agent.id, a.id));
      return a.id;
    },
  };
}
