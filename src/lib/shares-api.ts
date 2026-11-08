// 画面から呼ぶ共有リンク・利用状況の処理(中身は src/server/shares.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).shares;
const headers = () => getRequest().headers;
// リンクの URL は、いま開いているアドレス(リバースプロキシの後ろでも、ブラウザが見ているもの)で作る
const origin = () => getRequest().headers.get("origin") || new URL(getRequest().url).origin;
const sid = z.string().min(1).max(64);

// hours = 0 は無期限。maxDownloads = null は回数の上限なし
export const createShare = createServerFn({ method: "POST" })
  .validator(z.object({ itemIds: z.array(sid).min(1).max(100), hours: z.number().int().min(0).max(720), name: z.string().max(100), maxDownloads: z.number().int().nullable().optional() }))
  .handler(async ({ data }) => (await svc()).create(headers(), data, origin()));

export const listShares = createServerFn({ method: "GET" }).handler(async () => (await svc()).list(headers()));

export const removeShare = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id));

export const stopShare = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).stop(headers(), data.id));

export const teamUsage = createServerFn({ method: "GET" }).handler(async () => (await svc()).usage(headers()));
