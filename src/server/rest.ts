// 外から呼べる API(/api/v1/…)。API トークン(x-api-key か Authorization: Bearer cs_…)で使う。
// 中身は画面と同じサービスの処理で、権限の確認もそちらで行う(トークンを作った人のチームでの役割・トークンの範囲)。
// ここの定義から、画面の「API の説明」(/api-docs)と GET /api/v1 の一覧を作る。summary と scope は必ず書く(tests/rest-docs.test.ts が確かめる)
import { SCOPE_LABELS, SCOPE_ROLE, type TokenScope } from "~/lib/permissions";
import { HttpError } from "./guard";

type Services = typeof import("./instance");
type Handler = (s: Services, headers: Headers, params: string[], body: Record<string, unknown>) => Promise<unknown>;
/** scope = 要るトークンの範囲(と、その範囲を持てる役割)。example = POST で送る中身の例(GET はクエリー) */
type Route = { method: "GET" | "POST"; path: string; summary: string; scope: TokenScope; example?: Record<string, unknown>; handler: Handler };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const num = (v: unknown, d: number) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);

export const ROUTES: Route[] = [
  // サーバー
  { method: "GET", path: "/servers", scope: "read", summary: "サーバーの一覧", handler: (s, h) => s.servers.listServers(h) },
  { method: "GET", path: "/servers/:id", scope: "read", summary: "サーバーの名前・種類・バージョン", handler: (s, h, [id]) => s.library.detail(h, id) },
  { method: "POST", path: "/servers/:id/profile", scope: "admin", summary: "サーバーの種類(platform: paper・fabric など)と Minecraft のバージョン(mcVersion)を設定する", example: { platform: "paper", mcVersion: "1.21.4" }, handler: (s, h, [id], b) => s.library.setProfile(h, id, { platform: str(b.platform), mcVersion: str(b.mcVersion) }) },
  { method: "GET", path: "/servers/:id/status", scope: "read", summary: "サーバーの状態(動いているか・CPU・メモリ・ping: 人数・名前の一部・応答の速さ)", handler: (s, h, [id]) => s.servers.status(h, id) },
  { method: "POST", path: "/servers/:id/power", scope: "control", summary: "起動・停止・再起動・強制停止(signal: start / stop / restart / kill)", example: { signal: "restart" }, handler: (s, h, [id], b) => s.servers.power(h, id, str(b.signal) as never) },
  { method: "GET", path: "/servers/:id/logs", scope: "control", summary: "最近のログ(logs/latest.log の最後の行。lines で 20〜1000 行)", handler: (s, h, [id], b) => s.files.logs(h, id, num(b.lines, 400)) },
  { method: "POST", path: "/servers/:id/command", scope: "control", summary: "コンソールにコマンドを送る(command)", example: { command: "say こんにちは" }, handler: (s, h, [id], b) => s.files.command(h, id, str(b.command)) },
  // サーバー本体
  { method: "GET", path: "/servers/:id/software", scope: "read", summary: "サーバー本体の今のビルドと、いちばん新しいビルド", handler: (s, h, [id]) => s.software.info(h, id) },
  { method: "POST", path: "/servers/:id/software", scope: "admin", summary: "サーバー本体をいちばん新しいビルドに入れ替える(restart: true で再起動も)", example: { restart: true }, handler: (s, h, [id], b) => s.software.update(h, id, b.restart === true) },
  { method: "GET", path: "/servers/:id/software/builds", scope: "read", summary: "サーバー本体の配布元のビルドの一覧(今の Minecraft のバージョンの)と、選べるバージョン", handler: (s, h, [id]) => s.software.builds(h, id) },
  { method: "POST", path: "/servers/:id/software/install", scope: "admin", summary: "サーバー本体を選んだビルドに入れ替える(mc・build を省くといちばん新しいもの。restart: true で再起動も)", example: { mc: "1.21.4", build: "", restart: false }, handler: (s, h, [id], b) => s.software.install(h, id, { mc: str(b.mc) || undefined, build: str(b.build) || undefined, restart: b.restart === true }) },
  { method: "POST", path: "/servers/:id/software/rollback", scope: "admin", summary: "サーバー本体を残した jar に戻す(file を省くといちばん新しいもの)", example: {}, handler: (s, h, [id], b) => s.software.rollback(h, id, str(b.file) || undefined) },
  // サーバーの Mod・プラグイン
  { method: "GET", path: "/servers/:id/addons", scope: "read", summary: "入っている Mod・プラグイン・データパック(datapack: true の行はワールドの datapacks のもの)", handler: (s, h, [id]) => s.library.installed(h, id) },
  { method: "GET", path: "/servers/:id/updates", scope: "read", summary: "新しい版があるもの", handler: (s, h, [id]) => s.library.updates(h, id) },
  { method: "GET", path: "/servers/:id/search", scope: "read", summary: "このサーバーに入れられるものを配布元で探す(query、source: modrinth / spigot / curseforge。kind: datapack でデータパック)", handler: (s, h, [id], b) => s.library.search(h, id, str(b.query), str(b.source) || "modrinth", str(b.kind) || undefined) },
  { method: "POST", path: "/servers/:id/addons", scope: "library", summary: "入れる・更新する(source: modrinth / spigot / curseforge / upload、projectId。versionId で版を選べる。kind: datapack でデータパックとしてワールドの datapacks に。ライブラリでデータパックにしたものは省いてよい)", example: { source: "modrinth", projectId: "P7dR8mSH" }, handler: (s, h, [id], b) => s.library.install(h, id, str(b.projectId), str(b.source) || "modrinth", str(b.versionId) || undefined, str(b.kind) || undefined) },
  { method: "POST", path: "/servers/:id/addons/remove", scope: "library", summary: "外す(filename)", example: { filename: "example.jar" }, handler: (s, h, [id], b) => s.library.remove(h, id, str(b.filename)) },
  { method: "POST", path: "/servers/:id/addons/enable", scope: "library", summary: "無効にする・有効にする(filename、enable: true で有効に。無効にしたものは名前の最後が .disabled)", example: { filename: "example.jar", enable: false }, handler: (s, h, [id], b) => s.library.setEnabled(h, id, str(b.filename), b.enable === true) },
  { method: "POST", path: "/servers/:id/addons/hold", scope: "library", summary: "更新を止める・止めるのをやめる(source、projectId、hold: true / false)", example: { source: "modrinth", projectId: "P7dR8mSH", hold: true }, handler: (s, h, [id], b) => s.library.setHold(h, id, str(b.source) || "modrinth", str(b.projectId), b.hold === true) },
  { method: "POST", path: "/servers/:id/addons/rollback", scope: "library", summary: "前の版に戻す(source、projectId。戻したものは更新を止める)", example: { source: "modrinth", projectId: "P7dR8mSH" }, handler: (s, h, [id], b) => s.library.rollback(h, id, str(b.source) || "modrinth", str(b.projectId)) },
  { method: "GET", path: "/servers/:id/changes", scope: "read", summary: "このサーバーで入れた・更新した・外したものの履歴", handler: (s, h, [id]) => s.library.changes(h, id) },
  { method: "POST", path: "/servers/:id/changes/:changeId/undo", scope: "library", summary: "履歴の変更を元に戻す", example: {}, handler: (s, h, [id, c]) => s.library.undo(h, id, c) },
  { method: "GET", path: "/servers/:id/deps", scope: "read", summary: "入っているものの必須の前提で、このサーバーに無いもの(配布元に問い合わせる)", handler: (s, h, [id]) => s.library.serverDeps(h, id) },
  { method: "POST", path: "/servers/:id/copy", scope: "library", summary: "このサーバーの構成を、ほかのサーバーにそろえる(to: サーバーの ID の配列、mode: update / add / mirror)", example: { to: ["<サーバーの ID>"], mode: "add" }, handler: (s, h, [id], b) => s.sets.copy(h, id, ids(b.to), str(b.mode)) },
  { method: "POST", path: "/servers/:id/auto-update", scope: "library", summary: "自動更新を入れる・やめる(enabled: true / false)", example: { enabled: true }, handler: (s, h, [id], b) => s.sets.setAutoUpdate(h, id, b.enabled === true) },
  { method: "POST", path: "/servers/:id/set", scope: "library", summary: "サーバーにセットを結び付ける(setId。null で外す)", example: { setId: "<セットの ID>" }, handler: (s, h, [id], b) => s.sets.bind(h, id, str(b.setId) || null) },
  { method: "POST", path: "/servers/:id/sync", scope: "library", summary: "結び付けたセットでそろえる(mode: update = 入っているものだけ / add = 足りないものも入れる(既定)/ mirror = セットに無いものを外す。removeExtra: true は mirror と同じ)", example: { mode: "add" }, handler: (s, h, [id], b) => s.sets.sync(h, id, str(b.mode) || b.removeExtra === true) },
  { method: "POST", path: "/servers/update", scope: "library", summary: "サーバーの Mod・プラグインをまとめて最新にする(ids: サーバーの ID の配列。省くとすべて。止めたもの・無効にしたものは除く)", example: { ids: [] }, handler: (s, h, _p, b) => s.sets.updateServers(h, ids(b.ids)) },
  { method: "GET", path: "/servers/:id/schedule", scope: "read", summary: "サーバーごとの予約(毎日・毎週の時刻・すること・再起動)", handler: (s, h, [id]) => s.schedules.getServer(h, id) },
  // サーバーのファイル(権限「設定ファイルを見る・直す」が要る: 管理者以上・チームで許していれば編集者・メンバーごとに足した人。トークンは管理の範囲)
  { method: "GET", path: "/servers/:id/files", scope: "admin", summary: "フォルダーの中身(dir。省くといちばん上)", handler: (s, h, [id], b) => s.files.list(h, id, str(b.dir)) },
  { method: "GET", path: "/servers/:id/files/read", scope: "admin", summary: "テキストの設定ファイルを読む(path)と、その履歴", handler: (s, h, [id], b) => s.files.read(h, id, str(b.path)) },
  { method: "POST", path: "/servers/:id/files/save", scope: "admin", summary: "設定ファイルを保存する(path・content。base = 読んだときの中身。違っていたら保存しない)", example: { path: "server.properties", content: "…", base: "…" }, handler: (s, h, [id], b) => s.files.save(h, id, str(b.path), str(b.content), str(b.base)) },
  // ワールドのバックアップ
  { method: "GET", path: "/servers/:id/worlds", scope: "control", summary: "ワールドのバックアップの一覧と設定(Pterodactyl はパネルのバックアップ)", handler: (s, h, [id]) => s.worlds.get(h, id) },
  { method: "POST", path: "/servers/:id/worlds", scope: "control", summary: "ワールドのバックアップを始める(終わると一覧・処理の一覧・操作の記録に出る)", example: {}, handler: async (s, h, [id]) => { await s.worlds.create(h, id); return { started: true }; } },
  { method: "POST", path: "/servers/:id/worlds/remove", scope: "control", summary: "ワールドのバックアップを消す(name)", example: { name: "world-20261109-050000.tar.gz" }, handler: (s, h, [id], b) => s.worlds.remove(h, id, str(b.name)) },
  { method: "POST", path: "/servers/:id/worlds/restore", scope: "admin", summary: "ワールドをバックアップから戻す(name。stop: true で動いていたら止める、truncate: true で Pterodactyl の今のファイルを消してから)", example: { name: "world-20261109-050000.tar.gz", stop: true, truncate: false }, handler: (s, h, [id], b) => s.worlds.restore(h, id, str(b.name), { stop: b.stop === true, truncate: b.truncate === true }) },
  // ライブラリ
  { method: "GET", path: "/library", scope: "read", summary: "ライブラリ(チームの Mod・プラグイン・データパック・リソースパック・シェーダー・Modパック。対応 MC・受け取る版・手で決めた前提を含む)", handler: (s, h) => s.library.catalog(h) },
  { method: "GET", path: "/library/search", scope: "read", summary: "ライブラリに足すものを配布元で探す(query、type: plugin / mod / datapack / resourcepack / shader / modpack、source)", handler: (s, h, _p, b) => s.library.searchCatalog(h, str(b.query), str(b.type) || "plugin", str(b.source) || "modrinth") },
  { method: "POST", path: "/library", scope: "library", summary: "配布元のものをライブラリに足す(source・projectId。type: plugin / mod / datapack / resourcepack / shader / modpack)", example: { source: "modrinth", projectId: "P7dR8mSH", type: "mod" }, handler: (s, h, _p, b) => s.library.addItem(h, str(b.projectId), str(b.source) || "modrinth", str(b.type) || undefined) },
  { method: "POST", path: "/library/url", scope: "library", summary: "配布元のページの URL(url。Modrinth・SpigotMC・CurseForge)からライブラリに足す", example: { url: "https://modrinth.com/mod/fabric-api" }, handler: (s, h, _p, b) => s.library.addFromUrl(h, str(b.url)) },
  { method: "POST", path: "/library/tag", scope: "library", summary: "タグを付ける・外す(itemIds: アイテムの ID の配列、tag、on: true / false)", example: { itemIds: ["<アイテムの ID>"], tag: "ロビー", on: true }, handler: (s, h, _p, b) => s.library.tagItems(h, ids(b.itemIds), str(b.tag), b.on === true) },
  { method: "GET", path: "/library/outdated", scope: "read", summary: "どこかのサーバーに新しい版があるアイテム", handler: (s, h) => s.library.outdated(h) },
  { method: "GET", path: "/library/deps", scope: "read", summary: "必須の前提が入っていないもの(アイテムごと・サーバーごと。配布元に問い合わせる)", handler: (s, h) => s.library.missingDeps(h) },
  { method: "POST", path: "/library/:id/modpack", scope: "library", summary: "Modパックのアイテムからセットを作る(serverId を渡すと、そのサーバーに設定ファイルと中身も入れる。管理者以上)", example: { serverId: "<サーバーの ID>" }, handler: (s, h, [id], b) => s.modpacks.fromItem(h, id, str(b.serverId) || undefined) },
  { method: "POST", path: "/library/:id/remove", scope: "library", summary: "ライブラリから外す(サーバーに入っているものはそのまま)", example: {}, handler: (s, h, [id]) => s.library.removeItem(h, id) },
  { method: "GET", path: "/library/:id/versions", scope: "read", summary: "アイテムの配布元の版(新しい順)。変更内容は /library/:id/versions/:versionId/changelog", handler: (s, h, [id]) => s.library.itemVersions(h, id) },
  { method: "GET", path: "/library/:id/versions/:versionId/changelog", scope: "read", summary: "版の変更内容(Modrinth・CurseForge。文字だけ)", handler: (s, h, [id, v]) => s.library.itemChangelog(h, id, v) },
  // セット
  { method: "GET", path: "/sets", scope: "read", summary: "セットの一覧", handler: (s, h) => s.sets.list(h) },
  { method: "POST", path: "/sets", scope: "library", summary: "セットを作る(name)", example: { name: "ロビー用" }, handler: (s, h, _p, b) => s.sets.create(h, str(b.name)) },
  { method: "POST", path: "/sets/:id/rename", scope: "library", summary: "セットの名前を変える(name)", example: { name: "ロビー用" }, handler: (s, h, [id], b) => s.sets.rename(h, id, str(b.name)) },
  { method: "POST", path: "/sets/:id/remove", scope: "library", summary: "セットを消す", example: {}, handler: (s, h, [id]) => s.sets.remove(h, id) },
  { method: "POST", path: "/sets/:id/items", scope: "library", summary: "セットにアイテムを入れる・外す(itemId、add: true / false)", example: { itemId: "<アイテムの ID>", add: true }, handler: (s, h, [id], b) => s.sets.toggleItem(h, id, str(b.itemId), b.add === true) },
  { method: "POST", path: "/sets/:id/pin", scope: "library", summary: "セットのアイテムを版に固定する(itemId、versionId。null で固定をやめ、いつも新しい版に)", example: { itemId: "<アイテムの ID>", versionId: "<版の ID>" }, handler: (s, h, [id], b) => s.sets.pin(h, id, str(b.itemId), str(b.versionId) || null) },
  { method: "POST", path: "/sets/:id/apply", scope: "library", summary: "セットの中身をサーバーに入れる(serverId。足りないものだけ)", example: { serverId: "<サーバーの ID>" }, handler: (s, h, [id], b) => s.sets.apply(h, id, str(b.serverId)) },
  // パネル
  { method: "GET", path: "/me/permissions", scope: "read", summary: "自分のこのチームでの権限(役割・チームの設定・メンバーごとの足し引きを合わせたもの。\"種類:操作\" の一覧)", handler: (s, h) => s.teams.myPerms(h) },
  { method: "GET", path: "/jobs", scope: "read", summary: "処理の一覧(導入・そろえる・バックアップなど。待ち・実行中・成功・失敗)", handler: (s, h) => s.jobs.list(h) },
  { method: "GET", path: "/events", scope: "admin", summary: "操作の記録", handler: (s, h) => s.events.list(h) },
  { method: "GET", path: "/backups", scope: "admin", summary: "パネルのバックアップの一覧と定期バックアップの設定(自分用の版)", handler: (s, h) => s.backups.list(h) },
  { method: "POST", path: "/backups", scope: "admin", summary: "パネルのバックアップを作る(自分用の版。置き場所・残す数は定期バックアップの設定のもの)", example: {}, handler: (s, h) => s.backups.create(h) },
];

/** 画面の「API の説明」・GET /api/v1 に出す形 */
export const routeDocs = () => ROUTES.map((r) => ({
  method: r.method, path: `/api/v1${r.path}`, summary: r.summary, scope: r.scope, scopeLabel: SCOPE_LABELS[r.scope], role: SCOPE_ROLE[r.scope], example: r.example ?? null,
}));

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

/** /api/v1 の下のリクエストを処理する(path は /api/v1 を除いたもの)。GET はクエリー、POST は JSON の中身を受け取る */
export async function handleRest(services: Services, request: Request, path: string) {
  const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "Cache-Control": "no-store" } });
  if (path === "" || path === "/") {
    return json({ name: "CraftShelf API", version: 1, auth: "x-api-key: cs_… (または Authorization: Bearer cs_…)", docs: "/api-docs", routes: routeDocs() });
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
  } else {
    body = Object.fromEntries(new URL(request.url).searchParams);
  }
  try {
    const r = await route.r.handler(services, headers, route.params!, body && typeof body === "object" ? body : {});
    return json(r ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json({ message: e.message }, e.status);
    console.error("[API]", e);
    return json({ message: "うまくいきませんでした" }, 500);
  }
}
