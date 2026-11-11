// 画面から呼ぶ Mod・プラグインの処理(中身は src/server/library.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).library;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const source = z.enum(["modrinth", "spigot", "curseforge", "upload"]).default("modrinth");
// 種類(ライブラリ)と、サーバーに入れるときの種類(データパックだけ。ほかはサーバーの種類のもの)
const type = z.enum(["plugin", "mod", "datapack", "resourcepack", "shader", "modpack"]);
const kind = z.enum(["datapack"]).optional();

export const serverDetail = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).detail(headers(), data.id));

export const setProfile = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, platform: z.string().max(20), mcVersion: z.string().max(10) }))
  .handler(async ({ data }) => (await svc()).setProfile(headers(), data.id, data));

export const installedMods = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).installed(headers(), data.id));

export const searchMods = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, query: z.string().max(100), source, kind }))
  .handler(async ({ data }) => (await svc()).search(headers(), data.id, data.query, data.source, data.kind));

export const installMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, projectId: z.string().max(20), source, versionId: z.string().min(1).max(64).optional(), kind, unsupported: z.boolean().optional() }))
  .handler(async ({ data }) => (await svc()).install(headers(), data.id, data.projectId, data.source, data.versionId, data.kind, data.unsupported));

export const modVersions = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, projectId: z.string().max(20), source, kind }))
  .handler(async ({ data }) => (await svc()).versions(headers(), data.id, data.source, data.projectId, data.kind));

export const removeMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200) }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id, data.filename));

export const modUpdates = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).updates(headers(), data.id));

export const setModHold = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, projectId: z.string().max(20), source, hold: z.boolean() }))
  .handler(async ({ data }) => (await svc()).setHold(headers(), data.id, data.source, data.projectId, data.hold));

export const libraryCatalog = createServerFn({ method: "GET" }).handler(async () => (await svc()).catalog(headers()));

// 枠の「ライブラリ N」と保存先の印だけに使う、軽い読み込み(catalog は一覧の全部を返すので重い)
export const librarySummary = createServerFn({ method: "GET" }).handler(async () => (await svc()).summary(headers()));

export const searchCatalog = createServerFn({ method: "GET" })
  .validator(z.object({ query: z.string().max(100), type, source }))
  .handler(async ({ data }) => (await svc()).searchCatalog(headers(), data.query, data.type, data.source));

export const addLibraryItem = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.string().max(20), source, type: type.optional() }))
  .handler(async ({ data }) => (await svc()).addItem(headers(), data.projectId, data.source, data.type));

export const removeLibraryItem = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).removeItem(headers(), data.itemId));

export const curseforgeKey = createServerFn({ method: "GET" }).handler(async () => (await svc()).curseforgeKey(headers()));

export const setCurseforgeKey = createServerFn({ method: "POST" })
  .validator(z.object({ key: z.string().max(200).nullable() }))
  .handler(async ({ data }) => (await svc()).setCurseforgeKey(headers(), data.key));

export const identifyMods = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).identify(headers(), data.id));

export const serverChanges = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).changes(headers(), data.id));

export const undoChange = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, changeId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).undo(headers(), data.id, data.changeId));

export const rollbackMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, projectId: z.string().max(40), source }))
  .handler(async ({ data }) => (await svc()).rollback(headers(), data.id, data.source, data.projectId));

export const tagLibraryItems = createServerFn({ method: "POST" })
  .validator(z.object({ itemIds: z.array(sid).min(1).max(500), tag: z.string().max(60), on: z.boolean() }))
  .handler(async ({ data }) => (await svc()).tagItems(headers(), data.itemIds, data.tag, data.on));

export const favoriteLibraryItem = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: sid, on: z.boolean() }))
  .handler(async ({ data }) => (await svc()).favorite(headers(), data.itemId, data.on));

// fresh: 「今すぐ確認」など、サーバーが覚えている「いちばん新しい版」を使わずに配布元へ問い合わせ直す
const check = z.object({ fresh: z.boolean().optional() }).optional();
export const outdatedLibraryItems = createServerFn({ method: "GET" }).validator(check).handler(async ({ data }) => (await svc()).outdated(headers(), !!data?.fresh));

export const outdatedLibraryServers = createServerFn({ method: "GET" }).validator(check).handler(async ({ data }) => (await svc()).outdatedServers(headers(), !!data?.fresh));

export const setModEnabled = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200), enable: z.boolean() }))
  .handler(async ({ data }) => (await svc()).setEnabled(headers(), data.id, data.filename, data.enable));

export const adoptMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200) }))
  .handler(async ({ data }) => (await svc()).adopt(headers(), data.id, data.filename));

const iid = z.string().min(1).max(64);

export const addLibraryItemFromUrl = createServerFn({ method: "POST" })
  .validator(z.object({ url: z.string().min(1).max(300) }))
  .handler(async ({ data }) => (await svc()).addFromUrl(headers(), data.url));

export const editLibraryItem = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: iid, projectType: z.string().max(10), loaders: z.array(z.string().max(20)).max(20).nullable(),
    mcVersions: z.array(z.string().max(10)).max(60).nullable(), channel: z.string().max(10) }))
  .handler(async ({ data }) => (await svc()).editItem(headers(), data.itemId, data));

export const relinkLibraryItem = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: iid, url: z.string().min(1).max(300) }))
  .handler(async ({ data }) => (await svc()).relinkItem(headers(), data.itemId, data.url));

export const linkLibraryDep = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: iid, depItemId: iid, on: z.boolean() }))
  .handler(async ({ data }) => (await svc()).linkDep(headers(), data.itemId, data.depItemId, data.on));

export const libraryMissingDeps = createServerFn({ method: "GET" })
  .validator(z.object({ itemId: iid.optional() }))
  .handler(async ({ data }) => (await svc()).missingDeps(headers(), data.itemId));

export const serverMissingDeps = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).serverDeps(headers(), data.id));

export const libraryItemVersions = createServerFn({ method: "GET" })
  .validator(z.object({ itemId: iid }))
  .handler(async ({ data }) => (await svc()).itemVersions(headers(), data.itemId));

export const libraryItemChangelog = createServerFn({ method: "GET" })
  .validator(z.object({ itemId: iid, versionId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).itemChangelog(headers(), data.itemId, data.versionId));

export const setLibraryChannel = createServerFn({ method: "POST" })
  .validator(z.object({ channel: z.string().max(10) }))
  .handler(async ({ data }) => (await svc()).setChannel(headers(), data.channel));

// ライブラリの Modパックから、セットを作る(serverId を渡すと、そのサーバーに設定ファイルと中身を入れる)
export const modpackFromItem = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: iid, serverId: sid.optional() }))
  .handler(async ({ data }) => (await import("~/server/instance")).modpacks.fromItem(headers(), data.itemId, data.serverId));
