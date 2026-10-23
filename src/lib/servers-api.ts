// 画面から呼ぶサーバーの処理(中身は src/server/servers.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).servers;
const headers = () => getRequest().headers;
const id = z.object({ id: z.string().min(1).max(64) });

export const listServers = createServerFn({ method: "GET" }).handler(async () => (await svc()).listServers(headers()));

export const listConnections = createServerFn({ method: "GET" }).handler(async () => (await svc()).listConnections(headers()));

export const serverStatus = createServerFn({ method: "GET" })
  .validator(id)
  .handler(async ({ data }) => (await svc()).status(headers(), data.id));

export const powerServer = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1).max(64), signal: z.enum(["start", "stop", "restart", "kill"]) }))
  .handler(async ({ data }) => (await svc()).power(headers(), data.id, data.signal));

export const removeServer = createServerFn({ method: "POST" })
  .validator(id)
  .handler(async ({ data }) => (await svc()).removeServer(headers(), data.id));

export const addConnection = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().max(60), url: z.string().min(1).max(300), apiKey: z.string().min(1).max(200) }))
  .handler(async ({ data }) => (await svc()).addConnection(headers(), data));

export const removeConnection = createServerFn({ method: "POST" })
  .validator(id)
  .handler(async ({ data }) => (await svc()).removeConnection(headers(), data.id));

export const remoteServers = createServerFn({ method: "GET" })
  .validator(id)
  .handler(async ({ data }) => (await svc()).remoteServers(headers(), data.id));

export const addServers = createServerFn({ method: "POST" })
  .validator(z.object({ connectionId: z.string().min(1).max(64), remoteIds: z.array(z.string().max(64)).max(100) }))
  .handler(async ({ data }) => (await svc()).addServers(headers(), data.connectionId, data.remoteIds));
