// 画面から呼ぶサーバーの操作(中身は src/server/files.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).files;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const path = z.string().max(300);

export const configFiles = createServerFn({ method: "GET" })
  .validator(z.object({ ids: z.array(sid).min(2).max(8) }))
  .handler(async ({ data }) => (await svc()).configs(headers(), data.ids));

export const sendCommand = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, command: z.string().max(600) }))
  .handler(async ({ data }) => (await svc()).command(headers(), data.id, data.command));

export const listFiles = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, dir: path }))
  .handler(async ({ data }) => (await svc()).list(headers(), data.id, data.dir));

export const readServerFile = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, path }))
  .handler(async ({ data }) => (await svc()).read(headers(), data.id, data.path));

export const saveServerFile = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, path, content: z.string().max(600_000), base: z.string().max(600_000) }))
  .handler(async ({ data }) => (await svc()).save(headers(), data.id, data.path, data.content, data.base));

export const fileHistory = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, historyId: sid }))
  .handler(async ({ data }) => (await svc()).historyContent(headers(), data.id, data.historyId));
