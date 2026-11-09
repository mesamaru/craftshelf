// 画面から呼ぶ個人の設定の処理(中身は src/server/prefs.ts。本人の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export const saveMyTheme = createServerFn({ method: "POST" })
  .validator(z.object({ mode: z.string().max(10), accent: z.string().max(10), preset: z.string().max(20), dim: z.number(), blur: z.number() }))
  .handler(async ({ data }) => (await import("~/server/instance")).prefs.setTheme(getRequest().headers, data));
