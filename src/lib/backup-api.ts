// 画面から呼ぶバックアップと復元(中身は src/server/backup.ts。管理者以上・自分用の版だけ。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).backups;
const headers = () => getRequest().headers;
const name = z.string().regex(/^craftshelf-v03-\d{8}-\d{6}\.tar\.gz$/);
// 応答を返してから終了する。Docker が再起動し、次の起動でバックアップと入れ替える
export const restartSoon = () => setTimeout(() => process.exit(0), 800);

export const listBackups = createServerFn({ method: "GET" }).handler(async () => (await svc()).list(headers()));

export const createBackup = createServerFn({ method: "POST" }).handler(async () => (await svc()).create(headers()));

export const restoreBackup = createServerFn({ method: "POST" })
  .validator(z.object({ name }))
  .handler(async ({ data }) => {
    await (await svc()).restore(headers(), data.name);
    restartSoon();
  });

export const reimportV02 = createServerFn({ method: "POST" }).handler(async () => {
  await (await svc()).reimport(headers());
  restartSoon();
});

export const cancelRestore = createServerFn({ method: "POST" }).handler(async () => (await svc()).cancel(headers()));

// 定期バックアップ・置き場所・残す数(tz は画面の時間帯)
export const setBackupSchedule = createServerFn({ method: "POST" })
  .validator(z.object({ enabled: z.boolean(), time: z.string().max(5), keep: z.number().int(), targetId: z.string().max(64).nullable(), tz: z.string().max(64) }))
  .handler(async ({ data }) => (await svc()).setSchedule(headers(), data));
