// 画面から呼ぶ操作の記録・Discord への通知(中身は src/server/events.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).events;
const headers = () => getRequest().headers;

export const listEvents = createServerFn({ method: "GET" })
  .validator(z.object({ before: z.string().max(40).optional(), q: z.string().max(100).optional() }))
  .handler(async ({ data }) => (await svc()).list(headers(), data.before, data.q));

export const notifySettings = createServerFn({ method: "GET" }).handler(async () => (await svc()).notifySettings(headers()));

export const setNotify = createServerFn({ method: "POST" })
  .validator(z.object({ url: z.string().max(300).nullable(), kinds: z.array(z.string().max(20)).max(20) }))
  .handler(async ({ data }) => (await svc()).setNotify(headers(), data));

export const testNotify = createServerFn({ method: "POST" }).handler(async () => (await svc()).testNotify(headers()));

// お知らせと、どこまで読んだか(利用者ごとにサーバーに残す)
export const recentEvents = createServerFn({ method: "GET" }).handler(async () => (await svc()).feed(headers()));

export const markNoticesSeen = createServerFn({ method: "POST" })
  .validator(z.object({ at: z.string().max(40) }))
  .handler(async ({ data }) => (await svc()).markSeen(headers(), data.at));
