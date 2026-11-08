// 画面から呼ぶセットの処理(中身は src/server/sets.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).sets;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const name = z.string().max(100);

export const listSets = createServerFn({ method: "GET" }).handler(async () => (await svc()).list(headers()));

export const createSet = createServerFn({ method: "POST" })
  .validator(z.object({ name }))
  .handler(async ({ data }) => (await svc()).create(headers(), data.name));

export const renameSet = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, name }))
  .handler(async ({ data }) => (await svc()).rename(headers(), data.id, data.name));

export const removeSet = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id));

export const toggleSetItem = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, itemId: sid, add: z.boolean() }))
  .handler(async ({ data }) => (await svc()).toggleItem(headers(), data.id, data.itemId, data.add));

export const applySet = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, serverId: sid }))
  .handler(async ({ data }) => (await svc()).apply(headers(), data.id, data.serverId));

export const bindServerSet = createServerFn({ method: "POST" })
  .validator(z.object({ serverId: sid, setId: sid.nullable() }))
  .handler(async ({ data }) => (await svc()).bind(headers(), data.serverId, data.setId));

export const syncServerSet = createServerFn({ method: "POST" })
  .validator(z.object({ serverId: sid, removeExtra: z.boolean().default(false), mode: z.enum(["update", "add", "mirror"]).optional() }))
  .handler(async ({ data }) => (await svc()).sync(headers(), data.serverId, data.mode ?? data.removeExtra));

export const copyServer = createServerFn({ method: "POST" })
  .validator(z.object({ from: sid, to: z.array(sid).min(1).max(50), mode: z.enum(["update", "add", "mirror"]) }))
  .handler(async ({ data }) => (await svc()).copy(headers(), data.from, data.to, data.mode));

export const setAutoUpdate = createServerFn({ method: "POST" })
  .validator(z.object({ serverId: sid, on: z.boolean() }))
  .handler(async ({ data }) => (await svc()).setAutoUpdate(headers(), data.serverId, data.on));

export const updateServers = createServerFn({ method: "POST" })
  .validator(z.object({ ids: z.array(sid).max(100) }))
  .handler(async ({ data }) => (await svc()).updateServers(headers(), data.ids));

export const setMissingDeps = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, platform: z.string().max(20) }))
  .handler(async ({ data }) => (await svc()).missingDeps(headers(), data.id, data.platform));

export const addSetDeps = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, platform: z.string().max(20), list: z.array(z.object({ source: z.enum(["modrinth", "spigot", "curseforge", "upload"]), projectId: sid })).min(1).max(100) }))
  .handler(async ({ data }) => (await svc()).addDeps(headers(), data.id, data.list, data.platform));
