// 画面から呼ぶ予約の処理(中身は src/server/schedule.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).schedules;
const headers = () => getRequest().headers;

export const getSchedule = createServerFn({ method: "GET" }).handler(async () => (await svc()).get(headers()));

export const setSchedule = createServerFn({ method: "POST" })
  .validator(z.object({ enabled: z.boolean(), mode: z.string().max(10), time: z.string().max(5), days: z.array(z.number().int()).max(7) }))
  .handler(async ({ data }) => (await svc()).set(headers(), data));

export const getServerSchedule = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).getServer(headers(), data.id));

export const setServerSchedule = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1).max(64), mode: z.string().max(10), action: z.string().max(10), time: z.string().max(5), dow: z.number().int(), restart: z.boolean(), tz: z.string().max(64) }))
  .handler(async ({ data: { id, ...input } }) => (await svc()).setServer(headers(), id, input));
