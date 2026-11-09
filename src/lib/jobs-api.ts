// 画面から呼ぶ処理の一覧(中身は src/server/jobs.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const listJobs = createServerFn({ method: "GET" }).handler(async () => (await import("~/server/instance")).jobs.list(getRequest().headers));
