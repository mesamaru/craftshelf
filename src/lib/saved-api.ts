// 画面から呼ぶ、配布元のファイルの保存・保存先の状況と中身・取り込み・アドオンの整理(中身は src/server/saved.ts。権限の確認もそちらで行う)
// zip のダウンロードはファイルをそのまま送るので /api/library/zip の口を使う
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).saved;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const pick = z.object({ itemIds: z.array(sid).max(500).optional(), setId: sid.optional() });

export const savedOptions = createServerFn({ method: "GET" }).handler(async () => (await svc()).options(headers()));

export const setSavedOptions = createServerFn({ method: "POST" })
  .validator(z.object({ keepFiles: z.boolean(), keepVersions: z.number().int().min(0).max(100) }))
  .handler(async ({ data }) => (await svc()).setOptions(headers(), data));

export const setItemSaved = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: sid, keepFiles: z.enum(["", "on", "off"]), keepVersions: z.number().int().min(0).max(100).nullable() }))
  .handler(async ({ data }) => (await svc()).setItem(headers(), data.itemId, data));

export const saveVersion = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: sid, versionId: z.string().min(1).max(100).optional() }))
  .handler(async ({ data }) => (await svc()).save(headers(), data.itemId, data.versionId));

export const zipPlan = createServerFn({ method: "POST" })
  .validator(pick)
  .handler(async ({ data }) => (await svc()).zipPlan(headers(), data));

export const storageStatus = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid.nullable() }))
  .handler(async ({ data }) => (await svc()).status(headers(), data.id));

export const storageContents = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid.nullable() }))
  .handler(async ({ data }) => (await svc()).contents(headers(), data.id));

export const scanStorage = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid.nullable() }))
  .handler(async ({ data }) => (await svc()).scan(headers(), data.id));

export const cleanupFind = createServerFn({ method: "GET" })
  .validator(z.object({ cond: z.enum(["old", "dup", "stale", "unused"]), n: z.number().int().min(1).max(120) }))
  .handler(async ({ data }) => (await svc()).cleanup(headers(), data.cond, data.n));

export const cleanupRemove = createServerFn({ method: "POST" })
  .validator(z.object({ fileIds: z.array(sid).max(1000), itemIds: z.array(sid).max(1000) }))
  .handler(async ({ data }) => (await svc()).cleanupRemove(headers(), data));
