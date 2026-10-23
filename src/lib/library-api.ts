// 画面から呼ぶ Mod・プラグインの処理(中身は src/server/library.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).library;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);

export const serverDetail = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).detail(headers(), data.id));

export const setProfile = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, platform: z.string().max(20), mcVersion: z.string().max(10) }))
  .handler(async ({ data }) => (await svc()).setProfile(headers(), data.id, data));

export const installedMods = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).installed(headers(), data.id));

export const searchMods = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid, query: z.string().max(100) }))
  .handler(async ({ data }) => (await svc()).search(headers(), data.id, data.query));

export const installMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, projectId: z.string().max(20) }))
  .handler(async ({ data }) => (await svc()).install(headers(), data.id, data.projectId));

export const removeMod = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200) }))
  .handler(async ({ data }) => (await svc()).remove(headers(), data.id, data.filename));

export const modUpdates = createServerFn({ method: "GET" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).updates(headers(), data.id));
