// Pterodactyl パネルとの連携(Client API)。CraftShelf 02 の ptero.py と同じ考え方。
// パネルの「アカウント → API 認証情報」で作る Client API キー(ptlc_…)を使う
import type { FetchLike } from "./net";
import { FormData as UFormData } from "undici";

export class PteroError extends Error {}

export type RemoteServer = { identifier: string; name: string; node: string; description: string };
export type RemoteFile = { name: string; size: number; isFile: boolean; modifiedAt: string };
export type Allocation = { ip: string; alias: string; port: number; notes: string; isDefault: boolean };
// パネルのバックアップ(サーバー全体。Wings が作り、パネルの置き場所に残す)
export type RemoteBackup = { uuid: string; name: string; bytes: number; createdAt: string; completedAt: string | null; successful: boolean; locked: boolean };
export type Resources = { state: string; cpu: number | null; memory: number | null; disk: number | null; uptime: number | null };
export const POWER_SIGNALS = ["start", "stop", "restart", "kill"] as const;
export type PowerSignal = (typeof POWER_SIGNALS)[number];

const IDENT = /^[a-z0-9-]{1,64}$/i;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pteroClient(baseUrl: string, apiKey: string, fetch: FetchLike) {
  // body が文字列なら、そのまま送る(ファイルの書き込み)。それ以外は JSON
  async function req(method: string, path: string, body?: unknown, ok = [200, 201, 204]) {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "CraftShelf",
          ...(body ? { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" } : {}),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const msg = e instanceof Error && /公開|EUNSAFEADDR/.test(String((e as { cause?: unknown }).cause ?? e.message))
        ? "公開されていないアドレスにはつなげません"
        : `${new URL(baseUrl).hostname} に接続できません(URL を確認してください)`;
      throw new PteroError(msg);
    }
    if (ok.includes(res.status)) return res;
    if (res.status >= 300 && res.status < 400) throw new PteroError("URL が転送されました。パネルの正しい URL を入力してください");
    if (res.status === 401 || res.status === 403) throw new PteroError("API キーが無効か、このサーバーを操作する権限がありません(Client API キー ptlc_… を使ってください)");
    if (res.status === 404) throw new PteroError("サーバーが見つかりません");
    if (res.status === 409) throw new PteroError("サーバーが処理中のため操作できません(インストール中・移行中など)");
    if (res.status === 429) throw new PteroError("Pterodactyl へのリクエストが多すぎます。しばらく待ってからお試しください");
    throw new PteroError(`Pterodactyl からエラーが返りました(HTTP ${res.status})`);
  }

  const srv = (ident: string) => {
    if (!IDENT.test(ident)) throw new PteroError("サーバーの ID が正しくありません");
    return `/api/client/servers/${ident}`;
  };

  return {
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
        name: String(a.name ?? ""), size: Number(a.size ?? 0), isFile: !!a.is_file, modifiedAt: String(a.modified_at ?? ""),
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
      return (d?.data ?? []).map((x: { attributes?: Record<string, unknown> }) => x.attributes ?? {}).map((a: Record<string, unknown>) => ({
        ip: String(a.ip ?? ""), alias: String(a.ip_alias ?? ""), port: Number(a.port ?? 0), notes: String(a.notes ?? ""), isDefault: !!a.is_default,
      })).filter((a: Allocation) => Number.isInteger(a.port) && a.port > 0);
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
    // ファイルを送る(Wings の、署名付きのアップロード先へ)
    async upload(ident: string, directory: string, filename: string, data: Uint8Array) {
      const d = await (await req("GET", srv(ident) + "/files/upload")).json();
      const url = String(d?.attributes?.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new PteroError("Pterodactyl からアップロード先を受け取れませんでした");
      // undici の fetch(lanFetch・safeFetch)には、undici の FormData を渡す(Node の FormData だと中身が送られない)
      const form = new UFormData();
      form.append("files", new Blob([new Uint8Array(data)]), filename);
      let res: Response;
      try {
        res = await fetch(`${url}${url.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, { method: "POST", body: form as unknown as BodyInit, signal: AbortSignal.timeout(300_000) });
      } catch {
        throw new PteroError("Pterodactyl のノード(Wings)に接続できません");
      }
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
        throw new PteroError("Pterodactyl のノード(Wings)に接続できません");
      }
      if (!res.ok) throw new PteroError(`ファイルを取ってこられませんでした(HTTP ${res.status})`);
      if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new PteroError("ファイルが大きすぎます");
      return new Uint8Array(await res.arrayBuffer());
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
}

// ファイル・コマンドなど、フォルダのサーバー・エージェントも同じ形で持つ操作(バックアップは Pterodactyl だけ)
export type PteroClient = Omit<ReturnType<typeof pteroClient>, "backups" | "details">;
export type PteroBackups = ReturnType<typeof pteroClient>["backups"];
