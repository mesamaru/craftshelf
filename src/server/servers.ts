// サーバーと Pterodactyl の接続・フォルダでつなぐサーバー(自分用の版だけ)。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { and, asc, count, eq } from "drizzle-orm";
import type { Auth } from "./auth";
import type { Db } from "./db";
import { localServer, pteroConnection, server, serverProfile } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { type FetchLike, UnsafeUrlError, checkPublicUrl } from "./net";
import { POWER_SIGNALS, type PowerSignal, PteroError, pteroClient } from "./ptero";
import { eventService } from "./events";
import { checkRoot, detectFromJar, localClient } from "./local";
import { hint, open, seal } from "./secrets";

// 無料で使える範囲
export const SERVER_LIMITS = { connectionsPerTeam: 5, serversPerTeam: 20 };

// allowPrivate: 自分用の版では、家の中のアドレス・http のパネルも登録できる
// local: 自分用の版だけ。フォルダでつなぐサーバーを使えるようにする(dataDir はパネルのデータの場所。サーバーにはできない)
export type Deps = { db: Db; auth: Auth; secret: string; fetch: FetchLike; allowPrivate?: boolean; local?: { dataDir: string } };

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
const rconContext = (serverId: string) => `rcon:${serverId}`;
const CONTROLS = ["none", "command", "docker"] as const;
const oneLine = (v: unknown, max: number, what: string) => {
  const s = String(v ?? "").trim();
  if (s.length > max || /[\r\n\0]/.test(s)) throw new HttpError(400, `${what}は 1 行・${max} 文字までです`);
  return s;
};

async function connectionOf({ db, secret, fetch }: Deps, teamId: string, id: string) {
  const [c] = await db.select().from(pteroConnection).where(and(eq(pteroConnection.id, id), eq(pteroConnection.teamId, teamId)));
  if (!c) throw new HttpError(404, "接続が見つかりません");
  return { row: c, client: pteroClient(c.url, open(secret, c.apiKeySealed, sealContext(teamId, c.id)), fetch) };
}

// チームのサーバーと、それを操作する Pterodactyl のクライアント(ほかのチームのものは 404)
export async function serverOf(deps: Deps, teamId: string, id: string) {
  const [s] = await deps.db.select().from(server).where(and(eq(server.id, id), eq(server.teamId, teamId)));
  if (!s) throw new HttpError(404, "サーバーが見つかりません");
  if (s.kind === "local") {
    if (!deps.local) throw new HttpError(400, "フォルダのサーバーは、自分用の版だけで使えます");
    const [l] = await deps.db.select().from(localServer).where(eq(localServer.serverId, s.id));
    if (!l) throw new HttpError(404, "サーバーのフォルダの設定が見つかりません");
    let root: string;
    try {
      root = checkRoot(l.rootDir, deps.local.dataDir);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
    const rconPassword = l.rconPasswordSealed ? open(deps.secret, l.rconPasswordSealed, rconContext(s.id)) : "";
    const client = localClient(root, deps.fetch, { control: l.control, startCmd: l.startCmd, stopCmd: l.stopCmd, container: l.container, rconPort: l.rconPort, rconPassword });
    return { row: s, client, remoteId: s.id };
  }
  if (s.kind !== "ptero" || !s.pteroConnectionId || !s.remoteId) throw new HttpError(400, "このサーバーはまだ操作できません");
  const { client } = await connectionOf(deps, teamId, s.pteroConnectionId);
  return { row: s, client, remoteId: s.remoteId };
}

const POWER_LABEL: Record<PowerSignal, string> = { start: "起動", stop: "停止", restart: "再起動", kill: "強制停止" };

export function serverService(deps: Deps) {
  const { db, auth, secret, fetch } = deps;
  const { record } = eventService(deps);

  return {
    /** Pterodactyl パネルを登録する。キーで一覧が取れることを確かめてから保存する */
    async addConnection(headers: Headers, input: { name: string; url: string; apiKey: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["create"] });
      const name = input.name.trim().slice(0, 60) || "Pterodactyl";
      const apiKey = input.apiKey.trim();
      if (!/^ptlc_[A-Za-z0-9]{10,100}$/.test(apiKey)) throw new HttpError(400, "Client API キー(ptlc_…)を入力してください");
      let url: string;
      try {
        url = checkPublicUrl(input.url, deps.allowPrivate);
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
      await record({ teamId, userId: user.id, kind: "admin", action: "Pterodactyl パネルを登録", target: name, detail: url });
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
      const { teamId, user } = await requireTeam(auth, headers, { server: ["create"] });
      const { client } = await connectionOf(deps, teamId, connectionId);
      const available = new Map((await remote(() => client.servers())).map((s) => [s.identifier, s]));
      const picked = [...new Set(remoteIds)].map((r) => available.get(r)).filter((s) => !!s);
      if (picked.length === 0) return { added: 0 };
      const r = await db.transaction(async (tx) => {
        const [{ n }] = await tx.select({ n: count() }).from(server).where(eq(server.teamId, teamId));
        if (n + picked.length > SERVER_LIMITS.serversPerTeam) throw new HttpError(400, `サーバーは 1 チーム ${SERVER_LIMITS.serversPerTeam} 台までです`);
        const rows = picked.map((s) => ({ id: randomUUID(), teamId, kind: "ptero", name: s.name || s.identifier, pteroConnectionId: connectionId, remoteId: s.identifier }));
        const inserted = await tx.insert(server).values(rows).onConflictDoNothing().returning({ name: server.name });
        return { added: inserted.length, names: inserted.map((x) => x.name) };
      });
      if (r.added) await record({ teamId, userId: user.id, kind: "admin", action: "サーバーを追加", target: r.names.join("、") });
      return { added: r.added };
    },

    async removeConnection(headers: Headers, id: string) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["delete"] });
      const r = await db.delete(pteroConnection).where(and(eq(pteroConnection.id, id), eq(pteroConnection.teamId, teamId))).returning({ name: pteroConnection.name });
      if (r.length === 0) throw new HttpError(404, "接続が見つかりません");
      await record({ teamId, userId: user.id, kind: "admin", action: "Pterodactyl パネルの登録を消す", target: r[0].name });
    },

    async listServers(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      const rows = await db.select({ id: server.id, name: server.name, kind: server.kind, connection: pteroConnection.name })
        .from(server).leftJoin(pteroConnection, eq(server.pteroConnectionId, pteroConnection.id))
        .where(eq(server.teamId, teamId)).orderBy(asc(server.createdAt));
      return rows.map((r) => (r.kind === "local" ? { ...r, connection: "フォルダ" } : r));
    },

    /** フォルダのサーバーを使えるか(自分用の版だけ) */
    localEnabled: () => !!deps.local,

    /** パネルから見えるフォルダをたどる(フォルダと jar だけ。管理者以上・自分用の版だけ) */
    async browseHost(headers: Headers, path: string) {
      await requireTeam(auth, headers, { server: ["create"] });
      if (!deps.local) throw new HttpError(400, "フォルダのサーバーは、自分用の版だけで使えます");
      const p = resolve(String(path || "/"));
      if (!isAbsolute(p)) throw new HttpError(400, "フォルダの場所が正しくありません");
      let list;
      try {
        list = readdirSync(p, { withFileTypes: true });
      } catch {
        throw new HttpError(400, "このフォルダは開けません");
      }
      const entries = list.filter((d) => !d.name.startsWith(".") && (d.isDirectory() || (d.isFile() && d.name.toLowerCase().endsWith(".jar"))))
        .map((d) => ({ name: d.name, isDir: d.isDirectory() })).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)).slice(0, 500);
      return { path: p, parent: dirname(p) === p ? null : dirname(p), entries };
    },

    /** フォルダのサーバーを追加する(管理者以上・自分用の版だけ)。jar の名前から種類とバージョンを決める */
    async addLocal(headers: Headers, input: { rootDir: string; name: string; jar?: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["create"] });
      if (!deps.local) throw new HttpError(400, "フォルダのサーバーは、自分用の版だけで使えます");
      let root: string;
      try {
        root = checkRoot(input.rootDir, deps.local.dataDir);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const dup = await db.select({ id: localServer.serverId }).from(localServer).innerJoin(server, eq(localServer.serverId, server.id))
        .where(and(eq(server.teamId, teamId), eq(localServer.rootDir, root)));
      if (dup.length) throw new HttpError(400, "このフォルダのサーバーは、もう追加しています");
      const [{ n }] = await db.select({ n: count() }).from(server).where(eq(server.teamId, teamId));
      if (n >= SERVER_LIMITS.serversPerTeam) throw new HttpError(400, `サーバーは 1 チーム ${SERVER_LIMITS.serversPerTeam} 台までです`);
      const jars = input.jar ? [basename(input.jar)] : readdirSync(root).filter((f) => f.toLowerCase().endsWith(".jar"));
      const found = jars.map(detectFromJar).find((d) => d.platform) ?? { platform: null, mcVersion: null };
      const id = randomUUID();
      const name = String(input.name ?? "").trim().slice(0, 60) || basename(root);
      await db.transaction(async (tx) => {
        await tx.insert(server).values({ id, teamId, kind: "local", name });
        await tx.insert(localServer).values({ serverId: id, rootDir: root });
        if (found.platform) await tx.insert(serverProfile).values({ serverId: id, platform: found.platform, mcVersion: found.mcVersion });
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "フォルダのサーバーを追加", target: name, detail: root });
      return { id, profile: found };
    },

    /** フォルダのサーバーの起動・停止・RCON の設定(パスワードは返さない) */
    async localSettings(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers, { server: ["update"] });
      const [l] = await db.select().from(localServer).innerJoin(server, eq(localServer.serverId, server.id)).where(and(eq(server.id, id), eq(server.teamId, teamId)));
      if (!l) throw new HttpError(404, "フォルダのサーバーが見つかりません");
      const x = l.local_server;
      return { rootDir: x.rootDir, control: x.control, startCmd: x.startCmd, stopCmd: x.stopCmd, container: x.container, rconPort: x.rconPort, hasRconPassword: !!x.rconPasswordSealed };
    },

    /** 起動・停止・RCON を設定する(パネルの PC でコマンドを実行するので、管理者以上だけ)。rconPassword は undefined なら変えない */
    async setLocalSettings(headers: Headers, id: string, input: { control: string; startCmd: string; stopCmd: string; container: string; rconPort: number | null; rconPassword?: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["update"] });
      const [l] = await db.select({ name: server.name }).from(localServer).innerJoin(server, eq(localServer.serverId, server.id)).where(and(eq(server.id, id), eq(server.teamId, teamId)));
      if (!l) throw new HttpError(404, "フォルダのサーバーが見つかりません");
      if (!(CONTROLS as readonly string[]).includes(input.control)) throw new HttpError(400, "起動・停止の方法を選んでください");
      const container = oneLine(input.container, 128, "コンテナの名前");
      if (container && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new HttpError(400, "コンテナの名前が正しくありません");
      if (input.rconPort !== null && !(Number.isInteger(input.rconPort) && input.rconPort > 0 && input.rconPort <= 65535)) throw new HttpError(400, "RCON のポートは 1〜65535 の番号にしてください");
      const set = {
        control: input.control, startCmd: oneLine(input.startCmd, 500, "起動のコマンド"), stopCmd: oneLine(input.stopCmd, 500, "停止のコマンド"), container, rconPort: input.rconPort,
        ...(input.rconPassword === undefined ? {} : { rconPasswordSealed: input.rconPassword ? seal(secret, oneLine(input.rconPassword, 200, "RCON のパスワード"), rconContext(id)) : "" }),
        updatedAt: new Date(),
      };
      await db.update(localServer).set(set).where(eq(localServer.serverId, id));
      await record({ teamId, userId: user.id, kind: "admin", action: "起動・停止の設定を変える", target: l.name,
        detail: { none: "設定しない", command: "コマンド", docker: `Docker(${container})` }[input.control] });
    },

    async status(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { client, remoteId } = await serverOf(deps, teamId, id);
      return remote(() => client.resources(remoteId));
    },

    async power(headers: Headers, id: string, signal: PowerSignal) {
      if (!POWER_SIGNALS.includes(signal)) throw new HttpError(400, "不正な操作です");
      const { teamId, user } = await requireTeam(auth, headers, { server: ["control"] });
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      await remote(() => client.power(remoteId, signal));
      await record({ teamId, userId: user.id, kind: "power", action: POWER_LABEL[signal], target: row.name });
    },

    async removeServer(headers: Headers, id: string) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["delete"] });
      const r = await db.delete(server).where(and(eq(server.id, id), eq(server.teamId, teamId))).returning({ name: server.name });
      if (r.length === 0) throw new HttpError(404, "サーバーが見つかりません");
      await record({ teamId, userId: user.id, kind: "admin", action: "サーバーを外す", target: r[0].name });
    },
  };
}

export type ServerService = ReturnType<typeof serverService>;
