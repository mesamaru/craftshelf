// 画面から呼ぶ処理の一覧(中身は src/server/jobs.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { shared } from "./shared";

export const listJobs = createServerFn({ method: "GET" }).handler(async () => (await import("~/server/instance")).jobs.list(getRequest().headers));
/** 上のバーのしるしとホームで同じ問い合わせを 1 回にまとめる(処理を始める = 書き込みのあとは、覚えたものを捨てる) */
export const sharedJobs = () => shared("jobs", () => listJobs(), 2000);
