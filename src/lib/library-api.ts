// 画面から呼ぶ Mod・プラグインの処理(中身は src/server/library.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).library;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const source = z.enum(["modrinth", "spigot", "curseforge", "upload"]).default("modrinth");

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
  .validator(z.object({ id: sid, query: z.string().max(100), source }))
  .handler(async ({ data }) => (await svc()).search(headers(), data.id, data.query, data.source));

export const installMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, projectId: z.string().max(20), source, versionId: z.string().min(1).max(64).optional() }))
  .handler(async ({ data }) => (await svc()).install(headers(), data.id, data.projectId, data.source, data.versionId));

export const modVersions = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, projectId: z.string().max(20), source }))
  .handler(async ({ data }) => (await svc()).versions(headers(), data.id, data.source, data.projectId));

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

export const searchCatalog = createServerFn({ method: "GET" })
  .validator(z.object({ query: z.string().max(100), type: z.enum(["plugin", "mod"]), source }))
  .handler(async ({ data }) => (await svc()).searchCatalog(headers(), data.query, data.type, data.source));

export const addLibraryItem = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.string().max(20), source, type: z.enum(["plugin", "mod"]).optional() }))
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

export const outdatedLibraryItems = createServerFn({ method: "GET" }).handler(async () => (await svc()).outdated(headers()));

export const setModEnabled = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200), enable: z.boolean() }))
  .handler(async ({ data }) => (await svc()).setEnabled(headers(), data.id, data.filename, data.enable));

export const adoptMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200) }))
  .handler(async ({ data }) => (await svc()).adopt(headers(), data.id, data.filename));
