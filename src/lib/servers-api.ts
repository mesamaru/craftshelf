// 画面から呼ぶサーバーの処理(中身は src/server/servers.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).servers;
const headers = () => getRequest().headers;
const id = z.object({ id: z.string().min(1).max(64) });

export const serverAssignments = createServerFn({ method: "GET" }).handler(async () => (await svc()).assignments(headers()));

export const setServerAssignment = createServerFn({ method: "POST" })
  .validator(z.object({ userId: z.string().min(1).max(64), limited: z.boolean(), serverIds: z.array(z.string().min(1).max(64)).max(200) }))
  .handler(async ({ data }) => (await svc()).setAssignment(headers(), data.userId, data.limited, data.serverIds));

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

export const localEnabled = createServerFn({ method: "GET" }).handler(async () => (await svc()).localEnabled());

export const browseHost = createServerFn({ method: "GET" })
  .validator(z.object({ path: z.string().max(1000) }))
  .handler(async ({ data }) => (await svc()).browseHost(headers(), data.path));

export const addLocalServer = createServerFn({ method: "POST" })
  .validator(z.object({ rootDir: z.string().min(1).max(1000), name: z.string().max(100), jar: z.string().max(300).optional() }))
  .handler(async ({ data }) => (await svc()).addLocal(headers(), data));

export const localSettings = createServerFn({ method: "GET" })
  .validator(id)
  .handler(async ({ data }) => (await svc()).localSettings(headers(), data.id));

export const setLocalSettings = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1).max(64), control: z.string().max(10), startCmd: z.string().max(600), stopCmd: z.string().max(600),
    container: z.string().max(200), rconPort: z.number().int().nullable(), rconPassword: z.string().max(300).optional() }))
  .handler(async ({ data }) => (await svc()).setLocalSettings(headers(), data.id, data));
