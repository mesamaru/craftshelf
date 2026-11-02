// 画面から呼ぶポート管理の処理(中身は src/server/ports.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).ports;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);
const num = z.number().int().nullable().optional();

export const portOverview = createServerFn({ method: "GET" }).handler(async () => (await svc()).overview(headers()));

export const scanPorts = createServerFn({ method: "POST" })
  .validator(z.object({ serverId: sid.optional() }))
  .handler(async ({ data }) => (await svc()).scan(headers(), data.serverId));

export const savePortRules = createServerFn({ method: "POST" })
  .validator(z.object({
    kinds: z.array(z.object({ id: sid.optional(), name: z.string().max(100), mode: z.string().max(10), start: num, size: num, rangeFrom: num, rangeTo: num,
      proto: z.string().max(10), file: z.string().max(300), key: z.string().max(200) })).max(100),
    groups: z.array(z.object({ id: sid.optional(), number: z.string().max(10), name: z.string().max(100) })).max(100),
  }))
  .handler(async ({ data }) => (await svc()).saveRules(headers(), data));

export const setServerPortInfo = createServerFn({ method: "POST" })
  .validator(z.object({ serverId: sid, groupId: sid.nullable(), memo: z.string().max(200) }))
  .handler(async ({ data }) => (await svc()).setServerInfo(headers(), data.serverId, data));

export const saveServerPorts = createServerFn({ method: "POST" })
  .validator(z.object({ serverId: sid, changes: z.array(z.object({ id: sid.optional(), kindId: sid.nullable().optional(), port: z.number().int().optional(),
    memo: z.string().max(200).optional(), remove: z.boolean().optional(), ignore: z.boolean().optional() })).max(100) }))
  .handler(async ({ data }) => (await svc()).savePorts(headers(), data.serverId, data.changes));

export const adoptFoundPort = createServerFn({ method: "POST" })
  .validator(z.object({ portId: sid, kindId: sid.optional(), newKindName: z.string().max(100).optional() }))
  .handler(async ({ data }) => (await svc()).adoptFound(headers(), data.portId, data));
