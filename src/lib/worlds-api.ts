// 画面から呼ぶワールドのバックアップ(中身は src/server/worlds.ts。権限の確認もそちらで行う)。ダウンロードは /api/worlds/<ID>/<名前>
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).worlds;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const name = z.string().min(1).max(100);

export const worldBackups = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).get(headers(), data.id));

export const createWorldBackup = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => { await (await svc()).create(headers(), data.id); });

export const removeWorldBackup = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, name }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id, data.name));

export const setWorldBackup = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, mode: z.string().max(10), time: z.string().max(5), dow: z.number().int(), keep: z.number().int(), targetId: z.string().max(64).nullable(), tz: z.string().max(64) }))
  .handler(async ({ data: { id, ...input } }) => (await svc()).setSettings(headers(), id, input));

export const restoreWorldBackup = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, name, stop: z.boolean(), truncate: z.boolean() }))
  .handler(async ({ data }) => (await svc()).restore(headers(), data.id, data.name, { stop: data.stop, truncate: data.truncate }));
