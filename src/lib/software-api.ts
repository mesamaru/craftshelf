// 画面から呼ぶサーバー本体の処理(中身は src/server/software.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).software;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);

export const softwareInfo = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).info(headers(), data.id));

export const updateSoftware = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, restart: z.boolean(), mc: z.string().max(10).optional() }))
  .handler(async ({ data }) => (await svc()).update(headers(), data.id, data.restart, data.mc));

export const rollbackSoftware = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).rollback(headers(), data.id));
