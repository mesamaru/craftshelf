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
  .validator(z.object({ id: sid, restart: z.boolean(), mc: z.string().max(40).optional() }))
  .handler(async ({ data }) => (await svc()).update(headers(), data.id, data.restart, data.mc));

export const rollbackSoftware = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, file: z.string().max(300).optional() }))
  .handler(async ({ data }) => (await svc()).rollback(headers(), data.id, data.file));

export const softwareBuilds = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, mc: z.string().max(40).optional() }))
  .handler(async ({ data }) => (await svc()).builds(headers(), data.id, data.mc));

export const installSoftware = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, mc: z.string().max(40).optional(), build: z.string().max(80).optional(), restart: z.boolean() }))
  .handler(async ({ data: { id, ...input } }) => (await svc()).install(headers(), id, input));

export const setSoftware = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, software: z.string().max(20) }))
  .handler(async ({ data }) => (await svc()).setSoftware(headers(), data.id, data.software));

export const detectSoftware = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).detect(headers(), data.id));
