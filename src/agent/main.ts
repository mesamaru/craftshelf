// CraftShelf エージェント: 家の中のサーバー機で動かし、CraftShelf(サービス版)に外向きにつなぐ。家のポートは開けない。
// 扱うのは、設定ファイルに書いたサーバーのフォルダと、そこに書いた起動・停止のコマンド・Docker のコンテナ・RCON だけ。
// サービスからは、決まった操作(ファイルの一覧・読み書き・配布元からの取り込み・起動と停止など)しか頼めない(任意のコマンドは実行しない)
//
//   node craftshelf-agent.mjs [設定ファイル(既定 ./craftshelf-agent.json)]
//
// 設定ファイルの例:
// { "url": "https://craftshelf.example.com", "token": "ca_…",
//   "servers": [{ "key": "lobby", "name": "ロビー", "root": "/srv/minecraft/lobby", "control": "docker", "container": "mc-lobby", "rconPort": 25575, "rconPassword": "…" }] }
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_METHODS } from "../server/agent-hub";
import { checkRoot, detectFromJar, localClient } from "../server/local";

export const AGENT_VERSION = "1.0.0";
// 取り込んでよい取得先(Mod・プラグインの配布元と、サーバー本体の公式の取得先)
export const AGENT_PULL_HOSTS = new Set(["cdn.modrinth.com", "api.spiget.org", "cdn.spiget.org", "edge.forgecdn.net", "mediafilez.forgecdn.net", "fill-data.papermc.io", "api.purpurmc.org", "meta.fabricmc.net"]);

type ServerConf = { key: string; name?: string; root: string; control?: string; startCmd?: string; stopCmd?: string; container?: string; rconPort?: number; rconPassword?: string };
export type AgentConf = { url: string; token: string; servers: ServerConf[] };
type Client = ReturnType<typeof localClient>;

/** 設定ファイルを読んで確かめる(おかしければ理由を投げる) */
export function loadConf(text: string): AgentConf {
  const c = JSON.parse(text) as AgentConf;
  const url = new URL(String(c.url ?? ""));
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("url は https:// にしてください");
  if (!/^ca_[A-Za-z0-9_-]{40,60}$/.test(String(c.token ?? ""))) throw new Error("token が正しくありません(CraftShelf の「サーバー」→「エージェント」で作ったもの)");
  if (!Array.isArray(c.servers) || !c.servers.length) throw new Error("servers にサーバーを 1 つ以上書いてください");
  const keys = new Set<string>();
  for (const s of c.servers) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(String(s.key ?? "")) || keys.has(s.key)) throw new Error(`key が正しくないか、重なっています: ${s.key}`);
    keys.add(s.key);
    if (!["none", "command", "docker", undefined].includes(s.control)) throw new Error(`${s.key}: control は none・command・docker のどれかにしてください`);
  }
  return { url: url.origin, token: c.token, servers: c.servers };
}

/** サーバーごとのクライアント(フォルダの外は扱えない。起動・停止は設定ファイルのものだけ) */
export function makeClients(conf: AgentConf, fetchFn: typeof fetch = fetch) {
  const clients = new Map<string, { conf: ServerConf; client: Client; root: string }>();
  for (const s of conf.servers) {
    const root = checkRoot(s.root, resolve("/nonexistent-craftshelf-agent-data"));
    clients.set(s.key, {
      conf: s, root,
      client: localClient(root, fetchFn as never, {
        control: s.control ?? "none", startCmd: s.startCmd ?? "", stopCmd: s.stopCmd ?? "", container: s.container ?? "",
        rconPort: s.rconPort ?? null, rconPassword: s.rconPassword ?? "",
      }),
    });
  }
  return clients;
}

/** サービスに知らせるサーバーの一覧(jar の名前から種類と Minecraft のバージョンを読む) */
export function reportOf(clients: ReturnType<typeof makeClients>) {
  return [...clients.values()].map(({ conf, root }) => {
    const jars = (() => { try { return readdirSync(root).filter((f) => f.toLowerCase().endsWith(".jar")); } catch { return []; } })();
    const found = jars.map(detectFromJar).find((d) => d.platform) ?? { platform: null, mcVersion: null };
    return { key: conf.key, name: conf.name || conf.key, platform: found.platform, mcVersion: found.mcVersion };
  });
}

/** 1 つの頼みごとを行う(決まった操作だけ) */
export async function handle(clients: ReturnType<typeof makeClients>, method: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(AGENT_METHODS as readonly string[]).includes(method)) throw new Error("この操作はできません");
  const s = clients.get(String(args.key ?? ""));
  if (!s) throw new Error("このサーバーは、エージェントの設定ファイルにありません");
  const c = s.client;
  const str = (v: unknown) => String(v ?? "");
  switch (method) {
    case "resources": return c.resources("");
    case "command": return c.command("", str(args.command).slice(0, 500));
    case "power": return c.power("", str(args.signal) as never);
    case "listFiles": return c.listFiles("", str(args.directory));
    case "pull": {
      const u = new URL(str(args.url));
      if (u.protocol !== "https:" || !AGENT_PULL_HOSTS.has(u.host)) throw new Error("配布元の外からは取り込みません");
      return c.pull("", u.toString(), str(args.directory), str(args.filename));
    }
    case "upload": return c.upload("", str(args.directory), str(args.filename), new Uint8Array(Buffer.from(str(args.data), "base64")));
    case "readFile": return c.readFile("", str(args.file));
    case "writeFile": return c.writeFile("", str(args.file), str(args.text));
    case "readBytes": return Buffer.from(await c.readBytes("", str(args.file), Math.min(Number(args.maxBytes) || 0, 100 * 1024 * 1024))).toString("base64");
    case "deleteFiles": return c.deleteFiles("", str(args.root), (Array.isArray(args.files) ? args.files : []).map(String));
    case "rename": return c.rename("", str(args.root), str(args.from), str(args.to));
  }
  throw new Error("この操作はできません");
}

async function main() {
  const file = resolve(process.argv[2] ?? "craftshelf-agent.json");
  const conf = loadConf(readFileSync(file, "utf8"));
  const clients = makeClients(conf);
  const headers = { Authorization: `Bearer ${conf.token}`, "Content-Type": "application/json", "User-Agent": `CraftShelf-Agent/${AGENT_VERSION}` };
  const post = (path: string, body: unknown) => fetch(conf.url + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  console.log(`[エージェント] ${conf.url} につなぎます(サーバー ${clients.size} 台: ${[...clients.keys()].join(", ")})`);
  let wait = 1000;
  for (;;) {
    try {
      const res = await post("/api/agent/poll", { version: AGENT_VERSION, servers: reportOf(clients) });
      if (res.status === 401) throw new Error("トークンが正しくありません(CraftShelf でエージェントを消した・作り直したときは、設定ファイルのトークンを替えてください)");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { requests } = (await res.json()) as { requests: { id: string; method: string; args: Record<string, unknown> }[] };
      wait = 1000;
      // 頼みごとは並べて行い、終わったものから結果を返す
      for (const r of requests ?? []) {
        void (async () => {
          let body: Record<string, unknown>;
          try {
            body = { id: r.id, ok: true, value: (await handle(clients, r.method, r.args ?? {})) ?? null };
          } catch (e) {
            body = { id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          await post("/api/agent/result", body).catch((e) => console.error("[エージェント] 結果を返せませんでした:", e));
        })();
      }
    } catch (e) {
      console.error(`[エージェント] つながりません(${wait / 1000} 秒後にやり直します):`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }
}

if (process.argv[1] && /craftshelf-agent\.m?js$/.test(process.argv[1])) main().catch((e) => { console.error("[エージェント]", e instanceof Error ? e.message : e); process.exit(1); });
