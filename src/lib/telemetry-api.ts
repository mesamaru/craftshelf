// 画面から呼ぶ利用状況の送信とお問い合わせ(中身は src/server/telemetry.ts。権限の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

const svc = async () => (await import("~/server/instance")).telemetry;
const headers = () => getRequest().headers;

export const telemetryInfo = createServerFn({ method: "GET" }).handler(async () => (await svc()).info(headers()));

export const setTelemetry = createServerFn({ method: "POST" })
  .validator(z.object({ enabled: z.boolean() }))
  .handler(async ({ data }) => (await svc()).set(headers(), data.enabled));

export const sendFeedback = createServerFn({ method: "POST" })
  .validator(z.object({ kind: z.enum(["request", "bug", "question", "other"]), message: z.string().max(4000), contact: z.string().max(200), includeEnv: z.boolean() }))
  .handler(async ({ data }) => (await svc()).feedback(headers(), data));
