// 画面から呼ぶチームとアカウントの操作(中身は src/server/teams.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).teams;
const headers = () => getRequest().headers;

export const transferOwner = createServerFn({ method: "POST" })
  .validator(z.object({ userId: z.string().min(1).max(64) }))
  .handler(async ({ data }) => (await svc()).transferOwner(headers(), data.userId));

export const deleteTeam = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().max(100) }))
  .handler(async ({ data }) => (await svc()).deleteTeam(headers(), data.name));

export const deleteAccount = createServerFn({ method: "POST" })
  .validator(z.object({ password: z.string().max(200) }))
  .handler(async ({ data }) => (await svc()).deleteAccount(headers(), data.password));
