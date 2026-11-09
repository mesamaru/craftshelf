// 画面から呼ぶ API トークンの処理(中身は src/server/tokens.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).tokens;
const headers = () => getRequest().headers;

export const listTokens = createServerFn({ method: "GET" }).handler(async () => (await svc()).list(headers()));

export const createToken = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().max(100), scopes: z.array(z.string().max(20)).max(10), days: z.number().int() }))
  .handler(async ({ data }) => (await svc()).create(headers(), data));

export const removeToken = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id));
