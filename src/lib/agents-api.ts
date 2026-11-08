// 画面から呼ぶエージェントの処理(中身は src/server/agents.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).agents;
const headers = () => getRequest().headers;
const id = z.string().min(1).max(64);

export const listAgents = createServerFn({ method: "GET" }).handler(async () => (await svc()).list(headers()));

export const createAgent = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().max(40) }))
  .handler(async ({ data }) => (await svc()).create(headers(), data.name));

export const removeAgent = createServerFn({ method: "POST" })
  .validator(z.object({ id }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id));

export const addAgentServer = createServerFn({ method: "POST" })
  .validator(z.object({ agentId: id, key: z.string().max(40) }))
  .handler(async ({ data }) => (await svc()).addServer(headers(), data.agentId, data.key));
