// 画面から呼ぶ個人の設定の処理(中身は src/server/prefs.ts。本人の確認もそちらで行う)
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export const saveMyTheme = createServerFn({ method: "POST" })
  .validator(z.object({ mode: z.string().max(10), accent: z.string().max(10), preset: z.string().max(20), dim: z.number(), blur: z.number() }))
  .handler(async ({ data }) => (await import("~/server/instance")).prefs.setTheme(getRequest().headers, data));

// 背景画像(縮めた画像の data URL。null で外す)。返すのは画面で使う場所
export const saveMyBackground = createServerFn({ method: "POST" })
  .validator(z.object({ image: z.string().max(4 * 1024 * 1024).nullable() }))
  .handler(async ({ data }) => (await import("~/server/instance")).prefs.setBackground(getRequest().headers, data.image));
