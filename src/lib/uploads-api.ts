// 画面から呼ぶアップロードしたアドオン・保存先の処理(中身は src/server/uploads.ts。権限の確認もそちらで行う)
// アップロードとダウンロードは、ファイルをそのまま送るので src/routes/api/library/ の口を使う
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).uploads;
const headers = () => getRequest().headers;
const sid = z.string().min(1).max(64);

export const storageTargets = createServerFn({ method: "GET" }).handler(async () => (await svc()).targets(headers()));

export const addStorageTarget = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().max(100), kind: z.enum(["local", "webdav", "smb"]), path: z.string().max(1000).optional(),
    url: z.string().max(1000).optional(), user: z.string().max(200).optional(), password: z.string().max(300).optional(),
    host: z.string().max(253).optional(), share: z.string().max(200).optional(), domain: z.string().max(100).optional() }))
  .handler(async ({ data }) => (await svc()).addTarget(headers(), data));

export const activateStorageTarget = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid.nullable() }))
  .handler(async ({ data }) => (await svc()).activate(headers(), data.id));

export const importServerFile = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid, filename: z.string().min(1).max(200) }))
  .handler(async ({ data }) => (await svc()).fromServer(headers(), data.id, data.filename));

export const moveStorageFiles = createServerFn({ method: "POST" })
  .validator(z.object({ from: sid.nullable(), to: sid.nullable() }))
  .handler(async ({ data }) => (await svc()).moveFiles(headers(), data.from, data.to));

export const removeStorageTarget = createServerFn({ method: "POST" })
  .validator(z.object({ id: sid }))
  .handler(async ({ data }) => (await svc()).removeTarget(headers(), data.id));

export const uploadedFiles = createServerFn({ method: "GET" })
  .validator(z.object({ itemId: sid }))
  .handler(async ({ data }) => (await svc()).files(headers(), data.itemId));

export const removeUploadedFile = createServerFn({ method: "POST" })
  .validator(z.object({ fileId: sid }))
  .handler(async ({ data }) => (await svc()).removeFile(headers(), data.fileId));
