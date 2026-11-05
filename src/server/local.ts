// フォルダでつなぐサーバー(自分用の版だけ)。パネルから見えるフォルダ(同じ PC・NAS・Docker でマウントしたもの)を直接読み書きする。
// Pterodactyl のクライアント(ptero.ts)と同じ形にして、ライブラリ・セット・予約・ファイルとコマンド・ポートの処理をそのまま使う
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { Socket } from "node:net";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MC_VERSION, type Platform } from "~/lib/platforms";
import type { FetchLike } from "./net";
import { type Allocation, POWER_SIGNALS, type PowerSignal, type PteroClient, PteroError, type RemoteFile, type Resources } from "./ptero";

// フォルダのサーバーへ取ってくるファイルの置き場所(配布元の CDN だけ)
const PULL_HOSTS = new Set(["cdn.modrinth.com", "api.spiget.org", "cdn.spiget.org", "edge.forgecdn.net", "mediafilez.forgecdn.net"]);
export const LOCAL_LIMITS = { downloadBytes: 300 * 1024 * 1024, commandSeconds: 120 };
export type Control = { control: string; startCmd: string; stopCmd: string; container: string; rconPort: number | null; rconPassword: string };

/** サーバーのフォルダとして使える場所か(絶対パス・あるフォルダ・パネル自身のデータの中ではない)。実際の場所を返す */
export function checkRoot(input: string, dataDir: string) {
  const p = String(input ?? "").trim();
  if (!p || !isAbsolute(p)) throw new PteroError("フォルダの場所は、/ から始まる絶対パスで入力してください");
  let real: string;
  try {
    real = realpathSync(resolve(p));
  } catch {
    throw new PteroError("そのフォルダが見つかりません(Docker なら、サーバーのフォルダをコンテナにマウントしてください)");
  }
  if (!statSync(real).isDirectory()) throw new PteroError("フォルダを選んでください");
  const data = existsSync(dataDir) ? realpathSync(resolve(dataDir)) : resolve(dataDir);
  if (real === data || real.startsWith(data + sep) || data.startsWith(real + sep)) throw new PteroError("パネルのデータのフォルダ(またはそれを含むフォルダ)は、サーバーにできません");
  return real;
}

// フォルダの中の相対パス → 実際の場所(外に出るものは断る。シンボリックリンクで外へ出るものも断る)
function inside(root: string, rel: string) {
  const r = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const full = resolve(root, r);
  if (full !== root && !full.startsWith(root + sep)) throw new PteroError("サーバーのフォルダの外は扱えません");
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + sep)) throw new PteroError("サーバーのフォルダの外を指すリンクは扱えません");
  }
  return full;
}

// jar の名前から、サーバーの種類と Minecraft のバージョンを推し量る(例 paper-1.21.4-123.jar・fabric-server-mc.1.21.1-loader…)
export function detectFromJar(name: string): { platform: Platform | null; mcVersion: string | null } {
  const n = name.toLowerCase();
  const platform: Platform | null = n.includes("purpur") ? "purpur" : n.includes("folia") ? "folia" : n.includes("paper") ? "paper"
    : n.includes("spigot") || n.includes("craftbukkit") ? "spigot" : n.includes("velocity") ? "velocity"
    : n.includes("waterfall") || n.includes("bungee") ? "bungeecord" : n.includes("neoforge") ? "neoforge" : n.includes("forge") ? "forge"
    : n.includes("quilt") ? "quilt" : n.includes("fabric") ? "fabric" : null;
  const proxy = platform === "velocity" || platform === "bungeecord";
  const v = proxy ? null : n.match(/(?:mc\.?|[-_])((?:1\.\d{1,2}|\d{2}\.\d{1,2})(?:\.\d{1,2})?)(?=[-_.]|$)/)?.[1] ?? null;
  return { platform, mcVersion: v && MC_VERSION.test(v) ? v : null };
}

// RCON(Minecraft の遠隔コンソール)。1 つのコマンドを送って、返事を受け取る
export async function rcon(host: string, port: number, password: string, command: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolveP, reject) => {
    const sock = new Socket();
    let buf = Buffer.alloc(0);
    let authed = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new PteroError("RCON に接続できません(ポート・パスワードと、server.properties の enable-rcon を確かめてください)")); }, timeoutMs);
    const packet = (id: number, type: number, body: string) => {
      const b = Buffer.from(body, "utf8");
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0);
      p.writeInt32LE(id, 4);
      p.writeInt32LE(type, 8);
      b.copy(p, 12);
      return p;
    };
    const done = (e: Error | null, out = "") => { clearTimeout(timer); sock.destroy(); if (e) reject(e); else resolveP(out); };
    sock.on("error", () => done(new PteroError("RCON に接続できません(ポート・パスワードと、server.properties の enable-rcon を確かめてください)")));
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const body = buf.subarray(12, 4 + len - 2).toString("utf8");
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (id === -1) return done(new PteroError("RCON のパスワードが違います"));
          authed = true;
          sock.write(packet(2, 2, command));
        } else return done(null, body);
      }
    });
    sock.connect(port, host, () => sock.write(packet(1, 3, password)));
  });
}

// Docker のコンテナを、パネルにマウントした /var/run/docker.sock で操作する
function docker(method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, reject) => {
    const req = request({ socketPath: "/var/run/docker.sock", method, path, timeout: 30_000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolveP({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => reject(new PteroError("Docker に接続できません(パネルのコンテナに /var/run/docker.sock をマウントしてください)")));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// パネルの PC でコマンドを実行する(サーバーのフォルダで。start は待たない)
function runCommand(cmd: string, cwd: string, wait: boolean) {
  return new Promise<void>((resolveP, reject) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: "ignore", detached: !wait, windowsHide: true });
    child.on("error", () => reject(new PteroError("コマンドを実行できませんでした")));
    if (!wait) {
      child.unref();
      return resolveP();
    }
    const timer = setTimeout(() => { child.kill(); reject(new PteroError("コマンドが終わりませんでした")); }, LOCAL_LIMITS.commandSeconds * 1000);
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolveP(); else reject(new PteroError(`コマンドが失敗しました(終了コード ${code})`)); });
  });
}

const propsOf = (text: string) => Object.fromEntries(text.split(/\r?\n/).map((l) => l.match(/^\s*([^#!=\s][^=]*?)\s*=\s*(.*)$/)).filter((m) => !!m).map((m) => [m![1], m![2].trim()]));

export function localClient(root: string, fetch: FetchLike, control: Control): PteroClient {
  const props = async () => propsOf(await readFile(join(root, "server.properties"), "utf8").catch(() => ""));
  const rconOf = async () => {
    const p = await props();
    const port = control.rconPort ?? (Number(p["rcon.port"]) || null);
    if (!port || !control.rconPassword) return null;
    return { port, password: control.rconPassword };
  };
  const containerPath = () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(control.container)) throw new PteroError("コンテナの名前が正しくありません");
    return `/containers/${encodeURIComponent(control.container)}`;
  };

  return {
    async servers() {
      return [];
    },

    async resources(): Promise<Resources> {
      const none = { cpu: null, memory: null, disk: null, uptime: null };
      if (control.control === "docker" && control.container) {
        const r = await docker("GET", `${containerPath()}/json`);
        if (r.status === 404) throw new PteroError("コンテナが見つかりません");
        const s = JSON.parse(r.body || "{}")?.State?.Status;
        return { state: s === "running" ? "running" : s === "restarting" ? "starting" : "offline", ...none };
      }
      const rc = await rconOf();
      if (!rc) return { state: "unknown", ...none };
      try {
        await rcon("127.0.0.1", rc.port, rc.password, "list", 3000);
        return { state: "running", ...none };
      } catch {
        return { state: "offline", ...none };
      }
    },

    async command(_ident: string, command: string) {
      const rc = await rconOf();
      if (!rc) throw new PteroError("コマンドを送るには、起動・停止の設定で RCON のパスワードを入れてください");
      await rcon("127.0.0.1", rc.port, rc.password, command);
    },

    async power(_ident: string, signal: PowerSignal) {
      if (!POWER_SIGNALS.includes(signal)) throw new PteroError("不正な操作です");
      if (control.control === "docker") {
        const r = await docker("POST", `${containerPath()}/${signal === "kill" ? "kill" : signal}`);
        if (r.status === 404) throw new PteroError("コンテナが見つかりません");
        if (r.status >= 400) throw new PteroError(`Docker がエラーを返しました(HTTP ${r.status})`);
        return;
      }
      if (control.control !== "command") throw new PteroError("起動・停止の設定(コマンドか Docker)をしてください");
      const stop = async () => {
        if (control.stopCmd) return runCommand(control.stopCmd, root, true);
        const rc = await rconOf();
        if (!rc) throw new PteroError("停止のコマンドか、RCON のパスワードを設定してください");
        await rcon("127.0.0.1", rc.port, rc.password, "stop");
      };
      if (signal === "start") {
        if (!control.startCmd) throw new PteroError("起動のコマンドを設定してください");
        return runCommand(control.startCmd, root, false);
      }
      if (signal === "stop" || signal === "kill") return stop();
      await stop();
      await new Promise((r) => setTimeout(r, 5000));
      if (!control.startCmd) throw new PteroError("起動のコマンドを設定してください");
      return runCommand(control.startCmd, root, false);
    },

    async listFiles(_ident: string, directory: string): Promise<RemoteFile[]> {
      const dir = inside(root, directory);
      const names = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!names) return [];
      return Promise.all(names.map(async (d) => {
        const s = await stat(join(dir, d.name)).catch(() => null);
        return { name: d.name, size: s?.size ?? 0, isFile: !!s?.isFile(), modifiedAt: s?.mtime.toISOString() ?? "" };
      }));
    },

    // URL のファイルを、パネルが取ってきてフォルダに置く(取り込ませる URL は呼ぶ側で配布元のものだけにしている)
    async pull(_ident: string, url: string, directory: string, filename: string) {
      if (/[\\/]/.test(filename) || filename.startsWith(".")) throw new PteroError("ファイルの名前が正しくありません");
      const dir = inside(root, directory);
      await mkdir(dir, { recursive: true });
      // 転送(Spiget → CDN)は、配布元の CDN へのものだけを 3 回まで追う
      let res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      for (let i = 0; i < 3 && res.status >= 300 && res.status < 400; i++) {
        const next = new URL(res.headers.get("location") ?? "", url);
        if (next.protocol !== "https:" || !PULL_HOSTS.has(next.host)) throw new PteroError("配布元の外へ転送されたので、取り込みませんでした");
        res = await fetch(next.toString(), { signal: AbortSignal.timeout(300_000) });
      }
      if (!res.ok || !res.body) throw new PteroError(`ファイルを取ってこられませんでした(HTTP ${res.status})`);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > LOCAL_LIMITS.downloadBytes) throw new PteroError("ファイルが大きすぎます");
      const tmp = join(dir, `.craftshelf-${process.pid}-${Date.now()}.part`);
      let n = 0;
      const limit = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c) {
          n += chunk.byteLength;
          if (n > LOCAL_LIMITS.downloadBytes) c.error(new PteroError("ファイルが大きすぎます"));
          else c.enqueue(chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body.pipeThrough(limit) as import("node:stream/web").ReadableStream), createWriteStream(tmp));
        await rename(tmp, join(dir, filename));
      } catch (e) {
        await rm(tmp, { force: true });
        throw e instanceof PteroError ? e : new PteroError("ファイルを書き込めませんでした");
      }
    },

    async upload(_ident: string, directory: string, filename: string, data: Uint8Array) {
      if (/[\\/]/.test(filename) || filename.startsWith(".")) throw new PteroError("ファイルの名前が正しくありません");
      const dir = inside(root, directory);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.craftshelf-${process.pid}-${Date.now()}.part`);
      await writeFile(tmp, data);
      await rename(tmp, join(dir, filename));
    },

    async allocations(): Promise<Allocation[]> {
      const p = await props();
      const out: Allocation[] = [];
      const port = Number(p["server-port"] || 25565);
      if (Number.isInteger(port) && port > 0) out.push({ ip: p["server-ip"] || "", alias: "", port, notes: "ゲーム", isDefault: true });
      return out;
    },

    async readFile(_ident: string, file: string): Promise<string | null> {
      return readFile(inside(root, file), "utf8").catch(() => null);
    },

    async writeFile(_ident: string, file: string, text: string) {
      const full = inside(root, file);
      const tmp = `${full}.craftshelf-tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, full);
    },

    async readBytes(_ident: string, file: string, maxBytes: number): Promise<Uint8Array> {
      const full = inside(root, file);
      const s = await stat(full).catch(() => null);
      if (!s?.isFile()) throw new PteroError("ファイルが見つかりません");
      if (s.size > maxBytes) throw new PteroError("ファイルが大きすぎます");
      return new Uint8Array(await readFile(full));
    },

    async rename(_ident: string, dirRel: string, from: string, to: string) {
      const dir = inside(root, dirRel);
      for (const f of [from, to]) if (/[\\/]/.test(f) || f === "." || f === "..") throw new PteroError("ファイルの名前が正しくありません");
      await rename(join(dir, from), join(dir, to)).catch(() => { throw new PteroError(`${from} の名前を変えられませんでした`); });
    },

    async deleteFiles(_ident: string, dirRel: string, files: string[]) {
      const dir = inside(root, dirRel);
      for (const f of files) {
        if (/[\\/]/.test(f) || f === "." || f === "..") throw new PteroError("ファイルの名前が正しくありません");
        await unlink(join(dir, f)).catch((e) => { if (e?.code !== "ENOENT") throw new PteroError(`${f} を消せませんでした`); });
      }
    },
  };
}

