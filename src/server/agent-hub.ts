// エージェントとのやりとり(ロングポーリング)。サービス側は頼みごとを列に入れ、エージェントが取りに来て、結果を返す。
// 家の中のエージェントからの外向きの通信だけで動く(家のポートは開けない)。列はこのプロセスの中に持つ
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Ping } from "./mcping";
import { PteroError, type Allocation, type PowerSignal, type RemoteFile, type RemoteServer, type Resources } from "./ptero";

export type AgentRequest = { id: string; method: string; args: Record<string, unknown> };
type Waiting = { req: AgentRequest; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

// エージェントにさせてよいこと(ここに無いものは、エージェントも断る)
export const AGENT_METHODS = ["resources", "command", "power", "listFiles", "pull", "upload", "readFile", "writeFile", "readBytes", "deleteFiles", "rename", "ping"] as const;
// fileBytes = やりとりする 1 つのファイルの上限(やりとりは JSON に base64 で入れるので、大きいものは分けずに断る。エージェントの readBytes も同じ上限)
export const AGENT_LIMITS = { pendingPerAgent: 100, pollWaitMs: 25_000, callTimeoutMs: 120_000, onlineMs: 60_000, fileBytes: 100 * 1024 * 1024 };
const MB = (n: number) => `${Math.ceil(n / 1024 / 1024)} MB`;
const tooBig = (size: number) => new PteroError(`エージェントのサーバーへ送れるファイルは ${MB(AGENT_LIMITS.fileBytes)} までです(このファイルは ${MB(size)})。サーバー機のフォルダに直接置いてください`);

let seq = 0;

export function agentHub() {
  const queues = new Map<string, AgentRequest[]>();
  const waiters = new Map<string, () => void>();
  const pending = new Map<string, Waiting & { agentId: string }>();
  const lastPoll = new Map<string, number>();

  return {
    /** エージェントに頼み、結果を待つ(つながっていない・時間切れなら PteroError) */
    call(agentId: string, method: (typeof AGENT_METHODS)[number], args: Record<string, unknown>, timeoutMs = AGENT_LIMITS.callTimeoutMs): Promise<unknown> {
      if (Date.now() - (lastPoll.get(agentId) ?? 0) > AGENT_LIMITS.onlineMs) {
        return Promise.reject(new PteroError("エージェントにつながっていません(家のサーバー機でエージェントが動いているか確かめてください)"));
      }
      const q = queues.get(agentId) ?? [];
      if (q.length + [...pending.values()].filter((p) => p.agentId === agentId).length >= AGENT_LIMITS.pendingPerAgent) {
        return Promise.reject(new PteroError("エージェントへの頼みごとが多すぎます。しばらく待ってからお試しください"));
      }
      const req: AgentRequest = { id: `${Date.now().toString(36)}-${(++seq).toString(36)}`, method, args };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(req.id);
          const list = queues.get(agentId);
          if (list) queues.set(agentId, list.filter((r) => r.id !== req.id));
          reject(new PteroError("エージェントから返事がありませんでした"));
        }, timeoutMs);
        pending.set(req.id, { req, resolve, reject, timer, agentId });
        queues.set(agentId, [...q, req]);
        waiters.get(agentId)?.();
      });
    },

    /** エージェントが取りに来る。頼みごとがあればすぐ、無ければ waitMs まで待って返す */
    async poll(agentId: string, waitMs = AGENT_LIMITS.pollWaitMs): Promise<AgentRequest[]> {
      lastPoll.set(agentId, Date.now());
      const take = () => {
        const list = queues.get(agentId) ?? [];
        queues.delete(agentId);
        return list;
      };
      const now = take();
      if (now.length) return now;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { waiters.delete(agentId); resolve(); }, waitMs);
        waiters.set(agentId, () => { clearTimeout(timer); waiters.delete(agentId); resolve(); });
      });
      lastPoll.set(agentId, Date.now());
      return take();
    },

    /** エージェントからの結果 */
    result(agentId: string, id: string, ok: boolean, value: unknown, error?: string) {
      const p = pending.get(id);
      if (!p || p.agentId !== agentId) return false; // ほかのエージェントの頼みごとには答えさせない
      pending.delete(id);
      clearTimeout(p.timer);
      if (ok) p.resolve(value);
      else p.reject(new PteroError(String(error || "エージェントでうまくいきませんでした").slice(0, 500)));
      return true;
    },

    online: (agentId: string) => Date.now() - (lastPoll.get(agentId) ?? 0) <= AGENT_LIMITS.onlineMs,
  };
}

export type AgentHub = ReturnType<typeof agentHub>;

const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");

/** エージェントの中の 1 台のサーバー(key)を、Pterodactyl と同じ形で操作する */
export function agentClient(hub: AgentHub, agentId: string, key: string) {
  const call = <T>(method: (typeof AGENT_METHODS)[number], args: Record<string, unknown> = {}, timeoutMs?: number) =>
    hub.call(agentId, method, { key, ...args }, timeoutMs) as Promise<T>;
  return {
    async servers(): Promise<RemoteServer[]> { return []; },
    resources: (_ident: string) => call<Resources>("resources"),
    command: async (_ident: string, command: string) => { await call("command", { command }); },
    power: async (_ident: string, signal: PowerSignal) => { await call("power", { signal }); },
    listFiles: (_ident: string, directory: string) => call<RemoteFile[]>("listFiles", { directory }),
    pull: async (_ident: string, url: string, directory: string, filename: string) => { await call("pull", { url, directory, filename }, 300_000); },
    async allocations(): Promise<Allocation[]> { return []; },
    readFile: (_ident: string, file: string) => call<string | null>("readFile", { file }),
    writeFile: async (_ident: string, file: string, text: string) => { await call("writeFile", { file, text }); },
    // data が文字列なら、パネルの中のそのファイル(上限を超えるものは、読む前に断る)
    async upload(_ident: string, directory: string, filename: string, data: Uint8Array | string) {
      const size = typeof data === "string" ? (await stat(data)).size : data.byteLength;
      if (size > AGENT_LIMITS.fileBytes) throw tooBig(size);
      await call("upload", { directory, filename, data: b64(typeof data === "string" ? await readFile(data) : data) }, 300_000);
    },
    readBytes: async (_ident: string, file: string, maxBytes: number) => new Uint8Array(Buffer.from(await call<string>("readBytes", { file, maxBytes }, 300_000), "base64")),
    readToFile: async (_ident: string, file: string, maxBytes: number, path: string) => {
      await writeFile(path, Buffer.from(await call<string>("readBytes", { file, maxBytes: Math.min(maxBytes, AGENT_LIMITS.fileBytes) }, 300_000), "base64"));
    },
    deleteFiles: async (_ident: string, root: string, files: string[]) => { await call("deleteFiles", { root, files }); },
    rename: async (_ident: string, root: string, from: string, to: string) => { await call("rename", { root, from, to }); },
    // エージェントが、自分のサーバー(server.properties のポート)に問い合わせる
    ping: () => call<Ping>("ping", {}, 10_000),
  };
}
