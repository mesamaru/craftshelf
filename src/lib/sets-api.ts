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
