// 外から呼べる API(/api/v1/…)。API トークン(x-api-key か Authorization: Bearer cs_…)で使う。
// 中身は画面と同じサービスの処理で、権限の確認もそちらで行う(トークンを作った人のチームでの役割・読み取りだけか)
import { HttpError } from "./guard";

type Services = typeof import("./instance");
type Handler = (s: Services, headers: Headers, params: string[], body: Record<string, unknown>) => Promise<unknown>;
type Route = { method: "GET" | "POST"; path: string; summary: string; handler: Handler };

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const ROUTES: Route[] = [
  { method: "GET", path: "/servers", summary: "サーバーの一覧", handler: (s, h) => s.servers.listServers(h) },
  { method: "GET", path: "/servers/:id", summary: "サーバーの名前・種類・バージョン", handler: (s, h, [id]) => s.library.detail(h, id) },
  { method: "GET", path: "/servers/:id/status", summary: "サーバーの状態(動いているか・CPU・メモリ)", handler: (s, h, [id]) => s.servers.status(h, id) },
  { method: "POST", path: "/servers/:id/power", summary: "起動・停止・再起動・強制停止(signal: start / stop / restart / kill)", handler: (s, h, [id], b) => s.servers.power(h, id, str(b.signal) as never) },
  { method: "GET", path: "/servers/:id/software", summary: "サーバー本体の今のビルドと、いちばん新しいビルド", handler: (s, h, [id]) => s.software.info(h, id) },
  { method: "POST", path: "/servers/:id/software", summary: "サーバー本体をいちばん新しいビルドに入れ替える(restart: true で再起動も)", handler: (s, h, [id], b) => s.software.update(h, id, b.restart === true) },
  { method: "GET", path: "/servers/:id/logs", summary: "最近のログ(logs/latest.log の最後の 400 行)", handler: (s, h, [id]) => s.files.logs(h, id) },
  { method: "POST", path: "/servers/:id/command", summary: "コンソールにコマンドを送る(command)", handler: (s, h, [id], b) => s.files.command(h, id, str(b.command)) },
  { method: "GET", path: "/servers/:id/addons", summary: "入っている Mod・プラグイン", handler: (s, h, [id]) => s.library.installed(h, id) },
  { method: "GET", path: "/servers/:id/updates", summary: "新しい版があるもの", handler: (s, h, [id]) => s.library.updates(h, id) },
  { method: "POST", path: "/servers/:id/addons", summary: "入れる・更新する(source: modrinth / spigot / curseforge / upload、projectId。versionId で版を選べる)", handler: (s, h, [id], b) => s.library.install(h, id, str(b.projectId), str(b.source) || "modrinth", str(b.versionId) || undefined) },
  { method: "POST", path: "/servers/:id/addons/enable", summary: "無効にする・有効にする(filename、enable: true で有効に。無効にしたものは名前の最後が .disabled)", handler: (s, h, [id], b) => s.library.setEnabled(h, id, str(b.filename), b.enable === true) },
  { method: "POST", path: "/servers/:id/copy", summary: "このサーバーの構成を、ほかのサーバーにそろえる(to: サーバーの ID の配列、mode: update / add / mirror)", handler: (s, h, [id], b) => s.sets.copy(h, id, Array.isArray(b.to) ? b.to.map(String) : [], str(b.mode)) },
  { method: "POST", path: "/servers/:id/auto-update", summary: "自動更新を入れる・やめる(enabled: true / false)", handler: (s, h, [id], b) => s.sets.setAutoUpdate(h, id, b.enabled === true) },
  { method: "POST", path: "/servers/:id/sync", summary: "結び付けたセットでそろえる(removeExtra: セットに無いものを外す)", handler: (s, h, [id], b) => s.sets.sync(h, id, b.removeExtra === true) },
  { method: "GET", path: "/library", summary: "ライブラリ(チームの Mod・プラグイン)", handler: (s, h) => s.library.catalog(h) },
  { method: "GET", path: "/sets", summary: "セットの一覧", handler: (s, h) => s.sets.list(h) },
  { method: "GET", path: "/events", summary: "操作の記録(管理者以上)", handler: (s, h) => s.events.list(h) },
];

const match = (pattern: string, path: string) => {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(b[i])) return null;
      params.push(b[i]);
    } else if (a[i] !== b[i]) return null;
  }
  return params;
};

/** /api/v1 の下のリクエストを処理する(path は /api/v1 を除いたもの) */
export async function handleRest(services: Services, request: Request, path: string) {
  const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "Cache-Control": "no-store" } });
  if (path === "" || path === "/") {
    return json({ name: "CraftShelf API", version: 1, auth: "x-api-key: cs_… (または Authorization: Bearer cs_…)",
      routes: ROUTES.map((r) => ({ method: r.method, path: `/api/v1${r.path}`, summary: r.summary })) });
  }
  const route = ROUTES.map((r) => ({ r, params: r.method === request.method ? match(r.path, path) : null })).find((x) => x.params);
  if (!route) return json({ message: "その API はありません(GET /api/v1 で一覧を見られます)" }, 404);
  // ブラウザのログインの Cookie では使わせない(ほかのサイトから呼ばれないように)。トークンだけ
  const headers = new Headers({ "x-api-key": request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "" });
  if (!headers.get("x-api-key")) return json({ message: "API トークンを x-api-key か Authorization: Bearer で渡してください" }, 401);
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  try {
    const r = await route.r.handler(services, headers, route.params!, body ?? {});
    return json(r ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json({ message: e.message }, e.status);
    console.error("[API]", e);
    return json({ message: "うまくいきませんでした" }, 500);
  }
}
