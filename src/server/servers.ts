// サーバーと Pterodactyl の接続。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import type { Auth } from "./auth";
import type { Db } from "./db";
import { pteroConnection, server } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { type FetchLike, UnsafeUrlError, checkPublicUrl } from "./net";
import { POWER_SIGNALS, type PowerSignal, PteroError, pteroClient } from "./ptero";
import { hint, open, seal } from "./secrets";

// 無料で使える範囲
export const SERVER_LIMITS = { connectionsPerTeam: 5, serversPerTeam: 20 };

export type Deps = { db: Db; auth: Auth; secret: string; fetch: FetchLike };

// Pterodactyl からのエラーは、画面に出せる言葉にして返す
export async function remote<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PteroError || e instanceof UnsafeUrlError) throw new HttpError(502, e.message);
    throw e;
  }
}

const sealContext = (teamId: string, id: string) => `ptero:${teamId}:${id}`;

async function connectionOf({ db, secret, fetch }: Deps, teamId: string, id: string) {
  const [c] = await db.select().from(pteroConnection).where(and(eq(pteroConnection.id, id), eq(pteroConnection.teamId, teamId)));
  if (!c) throw new HttpError(404, "接続が見つかりません");
  return { row: c, client: pteroClient(c.url, open(secret, c.apiKeySealed, sealContext(teamId, c.id)), fetch) };
}

// チームのサーバーと、それを操作する Pterodactyl のクライアント(ほかのチームのものは 404)
export async function serverOf(deps: Deps, teamId: string, id: string) {
  const [s] = await deps.db.select().from(server).where(and(eq(server.id, id), eq(server.teamId, teamId)));
  if (!s) throw new HttpError(404, "サーバーが見つかりません");
  if (s.kind !== "ptero" || !s.pteroConnectionId || !s.remoteId) throw new HttpError(400, "このサーバーはまだ操作できません");
  const { client } = await connectionOf(deps, teamId, s.pteroConnectionId);
  return { row: s, client, remoteId: s.remoteId };
}

export function serverService(deps: Deps) {
  const { db, auth, secret, fetch } = deps;

  return {
    /** Pterodactyl パネルを登録する。キーで一覧が取れることを確かめてから保存する */
    async addConnection(headers: Headers, input: { name: string; url: string; apiKey: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["create"] });
      const name = input.name.trim().slice(0, 60) || "Pterodactyl";
      const apiKey = input.apiKey.trim();
      if (!/^ptlc_[A-Za-z0-9]{10,100}$/.test(apiKey)) throw new HttpError(400, "Client API キー(ptlc_…)を入力してください");
      let url: string;
      try {
        url = checkPublicUrl(input.url);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const [{ n }] = await db.select({ n: count() }).from(pteroConnection).where(eq(pteroConnection.teamId, teamId));
      if (n >= SERVER_LIMITS.connectionsPerTeam) throw new HttpError(400, `登録できるパネルは ${SERVER_LIMITS.connectionsPerTeam} つまでです`);

      const servers = await remote(() => pteroClient(url, apiKey, fetch).servers());
      const id = randomUUID();
      await db.insert(pteroConnection).values({
        id, teamId, name, url, apiKeySealed: seal(secret, apiKey, sealContext(teamId, id)), apiKeyHint: hint(apiKey), createdBy: user.id,
      });
      return { id, servers };
    },

    async listConnections(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      return db.select({ id: pteroConnection.id, name: pteroConnection.name, url: pteroConnection.url, apiKeyHint: pteroConnection.apiKeyHint })
        .from(pteroConnection).where(eq(pteroConnection.teamId, teamId)).orderBy(asc(pteroConnection.createdAt));
    },

    /** 登録したパネルで操作できるサーバーの一覧(まだ追加していないものを選ぶため) */
    async remoteServers(headers: Headers, connectionId: string) {
      const { teamId } = await requireTeam(auth, headers, { server: ["create"] });
      const { client } = await connectionOf(deps, teamId, connectionId);
      const list = await remote(() => client.servers());
      const added = new Set((await db.select({ r: server.remoteId }).from(server)
        .where(and(eq(server.teamId, teamId), eq(server.pteroConnectionId, connectionId)))).map((x) => x.r));
      return list.map((s) => ({ ...s, added: added.has(s.identifier) }));
    },

    /** パネルのサーバーを、チームのサーバーとして追加する */
    async addServers(headers: Headers, connectionId: string, remoteIds: string[]) {
      const { teamId } = await requireTeam(auth, headers, { server: ["create"] });
      const { client } = await connectionOf(deps, teamId, connectionId);
      const available = new Map((await remote(() => client.servers())).map((s) => [s.identifier, s]));
      const picked = [...new Set(remoteIds)].map((r) => available.get(r)).filter((s) => !!s);
      if (picked.length === 0) return { added: 0 };
      return db.transaction(async (tx) => {
        const [{ n }] = await tx.select({ n: count() }).from(server).where(eq(server.teamId, teamId));
        if (n + picked.length > SERVER_LIMITS.serversPerTeam) throw new HttpError(400, `サーバーは 1 チーム ${SERVER_LIMITS.serversPerTeam} 台までです`);
        const rows = picked.map((s) => ({ id: randomUUID(), teamId, kind: "ptero", name: s.name || s.identifier, pteroConnectionId: connectionId, remoteId: s.identifier }));
        const inserted = await tx.insert(server).values(rows).onConflictDoNothing().returning({ id: server.id });
        return { added: inserted.length };
      });
    },

    async removeConnection(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers, { server: ["delete"] });
      const r = await db.delete(pteroConnection).where(and(eq(pteroConnection.id, id), eq(pteroConnection.teamId, teamId))).returning({ id: pteroConnection.id });
      if (r.length === 0) throw new HttpError(404, "接続が見つかりません");
    },

    async listServers(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      return db.select({ id: server.id, name: server.name, kind: server.kind, connection: pteroConnection.name })
        .from(server).leftJoin(pteroConnection, eq(server.pteroConnectionId, pteroConnection.id))
        .where(eq(server.teamId, teamId)).orderBy(asc(server.createdAt));
    },

    async status(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { client, remoteId } = await serverOf(deps, teamId, id);
      return remote(() => client.resources(remoteId));
    },

    async power(headers: Headers, id: string, signal: PowerSignal) {
      if (!POWER_SIGNALS.includes(signal)) throw new HttpError(400, "不正な操作です");
      const { teamId } = await requireTeam(auth, headers, { server: ["control"] });
      const { client, remoteId } = await serverOf(deps, teamId, id);
      await remote(() => client.power(remoteId, signal));
    },

    async removeServer(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers, { server: ["delete"] });
      const r = await db.delete(server).where(and(eq(server.id, id), eq(server.teamId, teamId))).returning({ id: server.id });
      if (r.length === 0) throw new HttpError(404, "サーバーが見つかりません");
    },
  };
}

export type ServerService = ReturnType<typeof serverService>;
