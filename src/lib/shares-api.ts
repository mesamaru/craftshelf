// 画面から呼ぶ共有リンク・利用状況の処理(中身は src/server/shares.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).shares;
const headers = () => getRequest().headers;
// リンクの URL は、いま開いているアドレス(リバースプロキシの後ろでも、ブラウザが見ているもの)で作る
const origin = () => getRequest().headers.get("origin") || new URL(getRequest().url).origin;

export const createShare = createServerFn({ method: "POST" })
  .validator(z.object({ itemIds: z.array(z.string().min(1).max(64)).min(1).max(100), hours: z.number().int(), name: z.string().max(100) }))
  .handler(async ({ data }) => (await svc()).create(headers(), data, origin()));

export const listShares = createServerFn({ method: "GET" }).handler(async () => (await svc()).list(headers()));

export const removeShare = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id));

export const teamUsage = createServerFn({ method: "GET" }).handler(async () => (await svc()).usage(headers()));
