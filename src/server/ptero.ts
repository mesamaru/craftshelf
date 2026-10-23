// Pterodactyl パネルとの連携(Client API)。CraftShelf 02 の ptero.py と同じ考え方。
// パネルの「アカウント → API 認証情報」で作る Client API キー(ptlc_…)を使う
import type { FetchLike } from "./net";

export class PteroError extends Error {}

export type RemoteServer = { identifier: string; name: string; node: string; description: string };
export type Resources = { state: string; cpu: number | null; memory: number | null; disk: number | null; uptime: number | null };
export const POWER_SIGNALS = ["start", "stop", "restart", "kill"] as const;
export type PowerSignal = (typeof POWER_SIGNALS)[number];

const IDENT = /^[a-z0-9-]{1,64}$/i;

export function pteroClient(baseUrl: string, apiKey: string, fetch: FetchLike) {
  async function req(method: string, path: string, body?: unknown, ok = [200, 201, 204]) {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "Craftshelf-Next",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
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
    async power(ident: string, signal: PowerSignal) {
      if (!POWER_SIGNALS.includes(signal)) throw new PteroError("不正な操作です");
      await req("POST", srv(ident) + "/power", { signal });
    },
  };
}
