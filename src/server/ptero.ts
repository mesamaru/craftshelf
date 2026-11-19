// Pterodactyl パネルとの連携(Client API)。CraftShelf 02 の ptero.py と同じ考え方。
// パネルの「アカウント → API 認証情報」で作る Client API キー(ptlc_…)を使う
import { createWriteStream, openAsBlob } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { FetchLike } from "./net";
import { FormData as UFormData } from "undici";
import { createHash, randomBytes } from "node:crypto";
import { type Created, EXTRACT_LIMITS, ExtractError, type JobState, type Mode, type Plan, type Scan, type Space, STAGING, assemblePlan, cancelJob, entriesManifest, findConflicts, freeFolderName, hashEntries, isExtractError, jobState, levelOf, memorySource, memoryTar, protectedOf, relOf, removeCreated, reserveRead, scanTar, scanZip, startJob } from "./extract-safe";
import { fmtSize } from "../lib/format";
import { formatOf, unsupportedReason } from "../lib/archive";

export class PteroError extends Error {}

export type RemoteServer = { identifier: string; name: string; node: string; description: string };
export type RemoteFile = { name: string; size: number; isFile: boolean; modifiedAt: string; link?: boolean };
export type Allocation = { ip: string; alias: string; port: number; notes: string; isDefault: boolean };
// パネルのバックアップ(サーバー全体。Wings が作り、パネルの置き場所に残す)
export type RemoteBackup = { uuid: string; name: string; bytes: number; createdAt: string; completedAt: string | null; successful: boolean; locked: boolean };
export type Resources = { state: string; cpu: number | null; memory: number | null; disk: number | null; uptime: number | null };
export const POWER_SIGNALS = ["start", "stop", "restart", "kill"] as const;
export type PowerSignal = (typeof POWER_SIGNALS)[number];

const IDENT = /^[a-z0-9-]{1,64}$/i;
// 大きいファイルを送る・読むときに待つ長さ(5 分か、1 MB/秒で送れる長さの長い方)
export const transferTimeout = (bytes: number) => Math.max(300_000, Math.ceil(bytes / 1_000_000) * 1000);

/** 応答の中身を、maxBytes まで少しずつファイルに書く(超えたら書いたものを消して PteroError) */
export async function bodyToFile(res: Response, maxBytes: number, path: string) {
  if (!res.body) throw new PteroError("ファイルを取ってこられませんでした");
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new PteroError("ファイルが大きすぎます");
  let n = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      done(n > maxBytes ? new PteroError("ファイルが大きすぎます") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as WebStream<Uint8Array>), limit, createWriteStream(path));
  } catch (e) {
    await rm(path, { force: true });
    throw e instanceof PteroError ? e : new PteroError("ファイルを取ってこられませんでした(途中で切れました)");
  }
}
const allocationOf = (a: Record<string, unknown>): Allocation => ({
  ip: String(a.ip ?? ""), alias: String(a.ip_alias ?? ""), port: Number(a.port ?? 0), notes: String(a.notes ?? ""), isDefault: !!a.is_default,
});
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 読むだけの問い合わせの覚え(パネルの URL とキーごと)。同じ問い合わせは、同時なら 1 回にまとめ、短い間は使い回す。
// CraftShelf から書き込んだ(GET 以外を送った)サーバーの分は、すぐ捨てる。パネルで直接変えたものは、長くても ttl だけ遅れて見える。
// 読んでから書く・利用者が開いて直す・ファイルのタブでたどるときは fresh(覚えを使わない)
// 上の「読み直す」は、チームのパネルの覚えを捨ててから読む(forgetPteroReadsFor)
export const READ_TTL = { list: 30_000, file: 30_000, resources: 2_000, servers: 60_000, allocations: 120_000, details: 300_000 } as const;
// このファイルはビルドで 2 か所に入る(画面の下ごしらえとサーバーの処理)ので、覚えと同時の数はプロセスで 1 つにする
const G = globalThis as { __csPteroReads?: Map<string, { until: number; p: Promise<unknown> }>; __csPteroGates?: Map<string, { busy: number; queue: (() => void)[] }> };
const reads = (G.__csPteroReads ??= new Map());
function remembered<T>(key: string, ttl: number, fresh: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = reads.get(key);
  if (!fresh && hit && hit.until > now) return hit.p as Promise<T>;
  if (reads.size > 5000) for (const [k, v] of reads) if (v.until <= now) reads.delete(k);
  const p = fn();
  reads.set(key, { until: now + ttl, p });
  p.catch(() => { if (reads.get(key)?.p === p) reads.delete(key); }); // 失敗は覚えない
  return p;
}
const forgetReads = (prefix: string) => { for (const k of reads.keys()) if (k.startsWith(prefix)) reads.delete(k); };
/** 覚えをすべて捨てる(テストで、パネルの中身を外から変えたとき) */
export const forgetPteroReads = () => reads.clear();
/** そのパネルの覚えを捨てる(画面の「読み直す」。キーは問わない) */
export const forgetPteroReadsFor = (baseUrl: string) => forgetReads(`${baseUrl}|`);

// パネルごとの、同時の問い合わせの数(一度にたくさん送って、Pterodactyl の回数の上限に当たらないように)
const PANEL_PARALLEL = 6;
const gates = (G.__csPteroGates ??= new Map());
async function gate(panel: string) {
  let g = gates.get(panel);
  if (!g) gates.set(panel, (g = { busy: 0, queue: [] }));
  const q = g;
  if (q.busy >= PANEL_PARALLEL) await new Promise<void>((r) => q.queue.push(r)); // 空いた枠を、そのまま受け取る
  else q.busy++;
  return () => { const next = q.queue.shift(); if (next) next(); else q.busy--; };
}

export function pteroClient(baseUrl: string, apiKey: string, fetch: FetchLike) {
  const memoKey = `${baseUrl}|${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}|`;
  const serverKey = (ident: string) => `${memoKey}${ident}|`;
  const dirKey = (d: string) => d.replace(/^\/+|\/+$/g, "");
  // body が文字列なら、そのまま送る(ファイルの書き込み)。それ以外は JSON
  async function req(method: string, path: string, body?: unknown, ok = [200, 201, 204], timeoutMs = 20_000): Promise<Response> {
    const release = await gate(baseUrl);
    let res: Response;
    try {
      res = await send(method, path, body, timeoutMs);
      // 回数の上限: 読むだけなら、言われた時間(10 秒まで)待って 1 回だけやり直す
      if (res.status === 429 && method === "GET") {
        const wait = Math.min(10, Math.max(1, Number(res.headers.get("retry-after")) || 2));
        await res.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, wait * 1000));
        res = await send(method, path, body, timeoutMs);
      }
    } finally {
      release();
      const m = method !== "GET" && path.match(/^\/api\/client\/servers\/([^/?]+)/);
      if (m) forgetReads(serverKey(m[1])); // 書き込んだサーバーの覚えを捨てる
    }
    if (ok.includes(res.status)) return res;
    if (res.status >= 300 && res.status < 400) throw new PteroError("URL が転送されました。パネルの正しい URL を入力してください");
    if (res.status === 401 || res.status === 403) throw new PteroError("API キーが無効か、このサーバーを操作する権限がありません(Client API キー ptlc_… を使ってください)");
    if (res.status === 404) throw new PteroError("サーバーが見つかりません");
    if (res.status === 409) throw new PteroError("サーバーが処理中のため操作できません(インストール中・移行中など)");
    if (res.status === 429) throw new PteroError("Pterodactyl へのリクエストが多すぎます。しばらく待ってからお試しください");
    throw new PteroError(`Pterodactyl からエラーが返りました(HTTP ${res.status})`);
  }
  async function send(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "CraftShelf",
          ...(body ? { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" } : {}),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error && /公開|EUNSAFEADDR/.test(String((e as { cause?: unknown }).cause ?? e.message))
        ? "公開されていないアドレスにはつなげません"
        : `${new URL(baseUrl).hostname} に接続できません(URL を確かめてください)`;
      throw new PteroError(msg);
    }
  }

  const srv = (ident: string) => {
    if (!IDENT.test(ident)) throw new PteroError("サーバーの ID が正しくありません");
    return `/api/client/servers/${ident}`;
  };

  const base = {
    // 操作できるサーバーの一覧(このキーの持ち主が所有者かサブユーザーのもの)
    async servers(): Promise<RemoteServer[]> {
      const out: RemoteServer[] = [];
      for (let page = 1; page <= 50; page++) {
        const d = await (await req("GET", `/api/client?page=${page}&per_page=100`)).json();
        for (const x of d?.data ?? []) {
          const a = x?.attributes ?? {};
          if (typeof a.identifier === "string" && IDENT.test(a.identifier)) {
            out.push({ identifier: a.identifier, name: String(a.name ?? ""), node: String(a.node ?? ""), description: String(a.description ?? "") });
          }
        }
        if (page >= Number(d?.meta?.pagination?.total_pages ?? 1)) break;
      }
      return out;
    },
    async resources(ident: string): Promise<Resources> {
      const a = (await (await req("GET", srv(ident) + "/resources")).json())?.attributes ?? {};
      const r = a.resources ?? {};
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      return { state: String(a.current_state ?? "unknown"), cpu: num(r.cpu_absolute), memory: num(r.memory_bytes), disk: num(r.disk_bytes), uptime: num(r.uptime) };
    },
    // コンソールにコマンドを送る(動いていないと 502 が返る)
    async command(ident: string, command: string) {
      await req("POST", srv(ident) + "/command", { command });
    },
    async power(ident: string, signal: PowerSignal) {
      if (!POWER_SIGNALS.includes(signal)) throw new PteroError("不正な操作です");
      await req("POST", srv(ident) + "/power", { signal });
    },
    // フォルダーの中のファイル(フォルダーが無ければ空)
    async listFiles(ident: string, directory: string): Promise<RemoteFile[]> {
      const res = await req("GET", srv(ident) + `/files/list?directory=${encodeURIComponent(directory)}`, undefined, [200, 404]);
      if (res.status === 404) return [];
      const d = await res.json();
      return (d?.data ?? []).map((x: { attributes?: Record<string, unknown> }) => x.attributes ?? {}).map((a: Record<string, unknown>) => ({
        name: String(a.name ?? ""), size: Number(a.size ?? 0), isFile: !!a.is_file, modifiedAt: String(a.modified_at ?? ""), link: !!a.is_symlink,
      }));
    },
    // URL のファイルを、Pterodactyl(Wings)に直接取り込ませる。このアプリはファイルを持たない
    async pull(ident: string, url: string, directory: string, filename: string) {
      try {
        await req("POST", srv(ident) + "/files/pull", { url, directory, filename, use_header: false, foreground: true });
      } catch (e) {
        if (e instanceof PteroError && /HTTP 4\d\d/.test(e.message)) {
          throw new PteroError("パネルが URL からの取り込みを受け付けませんでした(パネルの設定で止められている可能性があります)");
        }
        throw e;
      }
    },
    // サーバーに割り当てられたポート(Pterodactyl の割り当て。is_default がゲームのポート)
    async allocations(ident: string): Promise<Allocation[]> {
      const d = await (await req("GET", srv(ident) + "/network/allocations")).json();
      return (d?.data ?? []).map((x: { attributes?: Record<string, unknown> }) => allocationOf(x.attributes ?? {})).filter((a: Allocation) => Number.isInteger(a.port) && a.port > 0);
    },
    // 割り当てを 1 つ足す(番号はパネルが決める)。パネルの設定で自動の割り当てが許され、サーバーの割り当ての上限に余裕があるときだけ
    async addAllocation(ident: string): Promise<Allocation> {
      let a: Allocation;
      try {
        const res = await req("POST", srv(ident) + "/network/allocations");
        a = allocationOf((await res.json().catch(() => null))?.attributes ?? {}); // 中身が読めなければ、下で「受け取れませんでした」
      } catch (e) {
        if (e instanceof PteroError && /HTTP 4(00|22)/.test(e.message)) {
          throw new PteroError("パネルが割り当てを足しませんでした(パネルの設定で自動の割り当てが許されていないか、このサーバーの割り当ての数が上限です。パネルの管理者に「ネットワーク」で足してもらってください)");
        }
        throw e;
      }
      if (!Number.isInteger(a.port) || a.port <= 0) throw new PteroError("パネルから割り当ての番号を受け取れませんでした");
      return a;
    },
    // egg の名前と起動の変数(MINECRAFT_VERSION・SERVER_JARFILE など)。サーバーの種類を推し量るのに使う
    async details(ident: string): Promise<{ egg: string; vars: Record<string, string> }> {
      const a = (await (await req("GET", srv(ident) + "?include=egg,variables")).json())?.attributes ?? {};
      const vars: Record<string, string> = {};
      for (const v of a.relationships?.variables?.data ?? []) {
        const x = v?.attributes ?? {};
        if (typeof x.env_variable === "string") vars[x.env_variable] = String(x.server_value ?? x.default_value ?? "").slice(0, 200);
      }
      return { egg: String(a.relationships?.egg?.attributes?.name ?? "").slice(0, 100), vars };
    },
    // テキストのファイルを読む(無ければ null)
    async readFile(ident: string, file: string): Promise<string | null> {
      const res = await req("GET", srv(ident) + `/files/contents?file=${encodeURIComponent(file)}`, undefined, [200, 404]);
      return res.status === 404 ? null : res.text();
    },
    async writeFile(ident: string, file: string, text: string) {
      await req("POST", srv(ident) + `/files/write?file=${encodeURIComponent(file)}`, text);
    },
    // ファイルを送る(Wings の、署名付きのアップロード先へ)。data が文字列なら、パネルの中のそのファイルを少しずつ読んで送る(メモリに全部を載せない)
    async upload(ident: string, directory: string, filename: string, data: Uint8Array | string) {
      const d = await (await req("GET", srv(ident) + "/files/upload")).json();
      const url = String(d?.attributes?.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new PteroError("Pterodactyl からアップロード先を受け取れませんでした");
      // undici の fetch(lanFetch・safeFetch)には、undici の FormData を渡す(Node の FormData だと中身が送られない)
      const form = new UFormData();
      const blob = typeof data === "string" ? await openAsBlob(data) : new Blob([new Uint8Array(data)]);
      form.append("files", blob, filename);
      let res: Response;
      try {
        res = await fetch(`${url}${url.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, { method: "POST", body: form as unknown as BodyInit, signal: AbortSignal.timeout(transferTimeout(blob.size)) });
      } catch {
        throw new PteroError("Pterodactyl のノード(Wings)につながりません(ノードが動いているか、パネルのノードの設定を確かめてください)");
      }
      forgetReads(serverKey(ident)); // Wings へ直接送ったので、req では捨てられない
      if (!res.ok) throw new PteroError(`ファイルを送れませんでした(HTTP ${res.status})`);
    },
    // ファイルの中身(jar などのバイナリ)。ダウンロード用の URL を受け取り、Wings から読む
    async readBytes(ident: string, file: string, maxBytes: number): Promise<Uint8Array> {
      const d = await (await req("GET", srv(ident) + "/files/download?file=" + encodeURIComponent(file))).json();
      const url = String(d?.attributes?.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new PteroError("Pterodactyl からダウンロード先を受け取れませんでした");
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      } catch {
        throw new PteroError("Pterodactyl のノード(Wings)につながりません(ノードが動いているか、パネルのノードの設定を確かめてください)");
      }
      if (!res.ok) throw new PteroError(`ファイルを取ってこられませんでした(HTTP ${res.status})`);
      if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new PteroError("ファイルが大きすぎます");
      return new Uint8Array(await res.arrayBuffer());
    },
    // ファイルの中身を、パネルの中の path に少しずつ書く(大きい jar を取り込むとき。メモリに全部を載せない)
    async readToFile(ident: string, file: string, maxBytes: number, path: string) {
      const d = await (await req("GET", srv(ident) + "/files/download?file=" + encodeURIComponent(file))).json();
      const url = String(d?.attributes?.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new PteroError("Pterodactyl からダウンロード先を受け取れませんでした");
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(transferTimeout(maxBytes)) });
      } catch {
        throw new PteroError("Pterodactyl のノード(Wings)につながりません(ノードが動いているか、パネルのノードの設定を確かめてください)");
      }
      if (!res.ok) throw new PteroError(`ファイルを取ってこられませんでした(HTTP ${res.status})`);
      await bodyToFile(res, maxBytes, path);
    },
    // 中身の sha256(展開の取り消しが、展開したままかを見る)。Wings から読むので、大きいファイル(hashBytes 超)は読まずに null(確かめられない)
    async hashFiles(ident: string, dir: string, files: { name: string; size: number }[]): Promise<Record<string, string | null>> {
      const out: Record<string, string | null> = {};
      for (const f of files.slice(0, 500)) {
        out[f.name] = null;
        if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > EXTRACT_LIMITS.hashBytes || f.name.includes("/") || f.name.includes(String.fromCharCode(92))) continue;
        try {
          const b = await base.readBytes(ident, dir === "/" ? f.name : `${dir}/${f.name}`, f.size);
          if (b.byteLength === f.size) out[f.name] = createHash("sha256").update(b).digest("hex");
        } catch { /* 読めない = 確かめられない */ }
      }
      return out;
    },
    async deleteFiles(ident: string, root: string, files: string[]) {
      if (files.length) await req("POST", srv(ident) + "/files/delete", { root, files });
    },
    // 同じフォルダの中で、ファイルの名前を変える
    async rename(ident: string, root: string, from: string, to: string) {
      await req("PUT", srv(ident) + "/files/rename", { root, files: [{ from, to }] });
    },
    // パネルのバックアップ(Pterodactyl だけ。フォルダのサーバー・エージェントには無い)
    backups: {
      async list(ident: string): Promise<RemoteBackup[]> {
        const out: RemoteBackup[] = [];
        for (let page = 1; page <= 20; page++) {
          const d = await (await req("GET", srv(ident) + `/backups?page=${page}&per_page=50`)).json();
          for (const x of d?.data ?? []) {
            const a = x?.attributes ?? {};
            if (typeof a.uuid !== "string" || !UUID.test(a.uuid)) continue;
            out.push({ uuid: a.uuid, name: String(a.name ?? ""), bytes: Number(a.bytes ?? 0), createdAt: String(a.created_at ?? ""),
              completedAt: a.completed_at ? String(a.completed_at) : null, successful: !!a.is_successful, locked: !!a.is_locked });
          }
          if (page >= Number(d?.meta?.pagination?.total_pages ?? 1)) break;
        }
        return out;
      },
      async create(ident: string, name: string) {
        try {
          await req("POST", srv(ident) + "/backups", { name });
        } catch (e) {
          // 上限(サーバーごとのバックアップの数)に達していると 400 が返る
          if (e instanceof PteroError && /HTTP 400/.test(e.message)) throw new PteroError("Pterodactyl のバックアップの数が上限に達しています(残す数を減らすか、パネルで古いものを消してください)");
          throw e;
        }
      },
      // ダウンロード用の URL(Wings の、しばらくだけ使える署名付きのもの)
      async url(ident: string, uuid: string): Promise<string> {
        if (!UUID.test(uuid)) throw new PteroError("バックアップの ID が正しくありません");
        const d = await (await req("GET", srv(ident) + `/backups/${uuid}/download`)).json();
        const url = String(d?.attributes?.url ?? "");
        if (!/^https?:\/\//.test(url)) throw new PteroError("Pterodactyl からダウンロード先を受け取れませんでした");
        return url;
      },
      // バックアップから戻す(パネルがサーバーを止めて展開する)。truncate なら、今のファイルを消してから戻す
      async restore(ident: string, uuid: string, truncate: boolean) {
        if (!UUID.test(uuid)) throw new PteroError("バックアップの ID が正しくありません");
        await req("POST", srv(ident) + `/backups/${uuid}/restore`, { truncate });
      },
      async remove(ident: string, uuid: string) {
        if (!UUID.test(uuid)) throw new PteroError("バックアップの ID が正しくありません");
        await req("DELETE", srv(ident) + `/backups/${uuid}`);
      },
    },
  };

  // 圧縮ファイルの展開(Pterodactyl は、パネル側(Wings)で展開する)。事前の確かめはこちらで必ず行い、全部通ったときだけ decompress を呼ぶ。
  // Wings は中のパスの確かめとディスクの上限を持つが、こちらの予約領域・展開中の見張り・途中のキャンセルは効かない(docs/DESIGN.md)
  const jobKey = (ident: string) => `ptero:${baseUrl}:${ident}`;
  const slash = (dir: string) => dir || "/";
  const rootOf = (dir: string) => (`/${dir}`.replace(/\/+$/, "") || "/");
  async function prepare(ident: string, archive: string, mode: Mode, wantHash = false) {
    const L = EXTRACT_LIMITS;
    const rel = relOf(archive);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const list = await base.listFiles(ident, slash(parentRel));
    const entry = list.find((f) => f.isFile && f.name === name);
    if (!entry) throw new ExtractError("圧縮ファイルが見つかりません");
    const format = formatOf(name);
    const pre: string[] = [];
    if (!format) pre.push(unsupportedReason(name) ?? "この形式は展開できません(対応しているのは .zip・.tar・.tar.gz・.tgz です)");
    else if (entry.size > L.pteroArchiveBytes) pre.push(`Pterodactyl では ${fmtSize(L.pteroArchiveBytes)} までの圧縮ファイルしか確かめられません。パネルのファイルマネージャで展開してください(この圧縮ファイルは ${fmtSize(entry.size)})`);
    let scan: Scan | null = null;
    let hashes = new Map<string, string>();
    if (format && !pre.length) {
      // 圧縮ファイルをメモリに読む: 同時の数と、読み込み中の合計に上限がある(超えたら「しばらくしてからやり直してください」)
      const release = reserveRead(entry.size);
      try {
        const bytes = await base.readBytes(ident, rel, L.pteroArchiveBytes);
        scan = format === "zip" ? scanZip(memorySource(bytes), L) : await scanTar(memoryTar(bytes, format === "tar.gz"), format, L);
        if (wantHash && scan && !scan.fatal.length && !scan.guard.problems.size) hashes = await hashEntries(bytes, format, scan.entries, L);
      } finally {
        release();
      }
    }
    const protect = protectedOf(levelOf(await base.readFile(ident, "server.properties").catch(() => null)));
    let destRel = parentRel;
    let conflicts: string[] = [];
    let existing = new Set<string>();
    if (mode === "folder") {
      const f = freeFolderName(name, parentRel, list.map((x) => x.name), protect);
      if (!f) pre.push("展開先のフォルダの名前を決められません");
      destRel = parentRel ? `${parentRel}/${f ?? "extracted"}` : (f ?? "extracted");
    } else if (scan && !scan.fatal.length && !scan.guard.problems.size && !scan.guard.stopped) {
      try {
        const r = await findConflicts(parentRel, scan.entries, async (d) => { const l = await base.listFiles(ident, slash(d)); return l.length ? l : null; }, 150);
        conflicts = r.bad;
        existing = r.existing;
      } catch (e) {
        pre.push(isExtractError(e) ? (e as ExtractError).message : "展開先を確かめられませんでした");
      }
    }
    // 容量: そのサーバーのディスクの上限(MB。0 は無制限)と使用中
    const a = (await (await req("GET", srv(ident))).json())?.attributes ?? {};
    const limitMb = Number(a.limits?.disk);
    const used = (await base.resources(ident)).disk;
    const space: Space = limitMb === 0 ? { kind: "unlimited", block: 4096 }
      : Number.isFinite(limitMb) && limitMb > 0 ? { kind: "limit", limit: limitMb * 1024 * 1024, free: used === null ? null : Math.max(0, limitMb * 1024 * 1024 - used), block: 4096 }
      : { kind: "volume", free: null, total: null, block: 4096 };
    const plan = assemblePlan({ archive: rel, format, archiveBytes: entry.size, scan, mode, destRel, how: "panel", conflicts, conflictCount: conflicts.length, space, protect, pre, L });
    return { plan, scan, name, parentRel, destRel, existing, hashes };
  }

  const wrap = <T>(fn: () => Promise<T> | T) => Promise.resolve().then(fn).catch((e) => { throw isExtractError(e) ? new PteroError((e as ExtractError).message) : e; });
  const extract = {
    extractPlan: (ident: string, archive: string, mode: Mode): Promise<Plan> => wrap(async () => (await prepare(ident, archive, mode === "here" ? "here" : "folder")).plan),
    extractStart: (ident: string, archive: string, mode: Mode): Promise<{ jobId: string }> => wrap(() => {
      const m: Mode = mode === "here" ? "here" : "folder";
      const jobId = startJob(jobKey(ident), async (job, signal) => {
        const p = await prepare(ident, archive, m, true);
        job.plan = p.plan;
        if (!p.plan.ok || !p.scan) throw new ExtractError(`展開できません。${p.plan.reasons.join(" / ")}`);
        if (signal.aborted) throw new ExtractError("キャンセルしました。何も展開していません", true);
        job.total = p.plan.bytes;
        job.filesTotal = p.plan.files;
        job.phase = "extracting"; // ここから先は、パネル(Wings)が展開する。途中では止められない
        const decompress = (dir: string, file: string) => req("POST", srv(ident) + "/files/decompress", { root: rootOf(dir), file }, [200, 204], 30 * 60_000);
        const manifest = entriesManifest(m === "folder" ? p.destRel : p.parentRel, m, p.scan.entries, p.existing, p.hashes);
        try {
          if (m === "folder") {
            // Wings は、圧縮ファイルのあるフォルダに展開する。新しいフォルダを作り、圧縮ファイルを一時的にそこへ移し(同じボリュームなので容量は使わない)、展開して、元の場所に戻す
            const folder = p.destRel.slice(p.destRel.lastIndexOf("/") + 1);
            const ext = p.name.match(/\.(tar\.gz|tgz|tar|zip)$/i)![0];
            const temp = `${STAGING}${randomBytes(6).toString("hex")}${ext}`;
            await req("POST", srv(ident) + "/files/create-folder", { root: rootOf(p.parentRel), name: folder });
            let moved = false;
            let failure: unknown = null;
            try {
              await base.rename(ident, slash(p.parentRel), p.name, `${folder}/${temp}`);
              moved = true;
              await decompress(p.destRel, temp);
            } catch (e) {
              failure = e;
            }
            if (moved) await base.rename(ident, slash(p.parentRel), `${folder}/${temp}`, p.name).then(() => { moved = false; }, () => {});
            if (failure) {
              if (!moved) await base.deleteFiles(ident, slash(p.parentRel), [folder]).catch(() => {}); // 作ったフォルダを消す(圧縮ファイルが元に戻っているときだけ)
              throw failure;
            }
            if (moved) throw new ExtractError(`展開はできましたが、圧縮ファイルを元の場所に戻せませんでした。「${folder}」フォルダの中の ${temp} です`);
            if (p.plan.files && !(await base.listFiles(ident, p.destRel)).length) throw new ExtractError("展開されませんでした");
          } else {
            try {
              await decompress(p.parentRel, p.name);
            } catch (e) {
              await removeCreated(base, ident, manifest).catch(() => {}); // 展開が途中で止まったら、作ったものだけを消す
              throw e;
            }
          }
        } catch (e) {
          if (isExtractError(e)) throw e;
          throw new ExtractError(e instanceof PteroError ? `パネルが展開できませんでした: ${e.message}` : "パネルが展開できませんでした");
        }
        const created: Created = { dirs: manifest.dirs, files: manifest.files };
        return { base: manifest.base, mode: m, files: p.plan.files, dirs: p.plan.dirs, bytes: p.plan.bytes, created };
      });
      return { jobId };
    }),
    extractState: (ident: string, jobId: string): Promise<JobState> => wrap(() => jobState(jobId, jobKey(ident))),
    extractCancel: (ident: string, jobId: string) => wrap(() => {
      const s = jobState(jobId, jobKey(ident));
      if (s.finishedAt) return;
      if (s.phase !== "checking") throw new PteroError("Pterodactyl はパネル側で展開しているので、途中では止められません");
      cancelJob(jobId, jobKey(ident));
    }),
  };
  // 画面に出すために読むもの(覚えを使う)。返すものは呼ぶ側が変えても覚えに響かないよう写す。展開(extract)は、覚えを使わない base を使う
  const cachedReads = {
    servers: () => remembered(`${memoKey}servers`, READ_TTL.servers, false, () => base.servers()).then((l) => l.map((x) => ({ ...x }))),
    resources: (ident: string) => remembered(`${serverKey(ident)}resources`, READ_TTL.resources, false, () => base.resources(ident)).then((r) => ({ ...r })),
    listFiles: (ident: string, directory: string, fresh?: boolean) =>
      remembered(`${serverKey(ident)}list|${dirKey(directory)}`, READ_TTL.list, fresh, () => base.listFiles(ident, directory)).then((l) => l.map((x) => ({ ...x }))),
    readFile: (ident: string, file: string, fresh?: boolean) => remembered(`${serverKey(ident)}file|${dirKey(file)}`, READ_TTL.file, fresh, () => base.readFile(ident, file)),
    allocations: (ident: string) => remembered(`${serverKey(ident)}allocations`, READ_TTL.allocations, false, () => base.allocations(ident)).then((l) => l.map((x) => ({ ...x }))),
    details: (ident: string) => remembered(`${serverKey(ident)}details`, READ_TTL.details, false, () => base.details(ident)).then((d) => ({ egg: d.egg, vars: { ...d.vars } })),
  };
  return { ...base, ...cachedReads, ...extract };
}

// ファイル・コマンドなど、フォルダのサーバー・エージェントも同じ形で持つ操作(バックアップは Pterodactyl だけ)
export type PteroClient = Omit<ReturnType<typeof pteroClient>, "backups" | "details" | "addAllocation">;
export type PteroBackups = ReturnType<typeof pteroClient>["backups"];
