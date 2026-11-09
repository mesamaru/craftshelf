// 個人の設定(見た目): アカウントに保存して、どの端末でも同じにする。知らない値は既定にそろえる。本人だけ・API トークンでは変えない
import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "~/server/guard";
import { prefService } from "~/server/prefs";
import { cleanTheme } from "~/lib/theme";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let prefs: ReturnType<typeof prefService>;

beforeAll(async () => {
  t = await setup();
  prefs = prefService({ db: t.db, auth: t.auth });
});

describe("見た目の設定", () => {
  it("保存したものは、その人のアカウントから読める(ほかの人には関係しない)", async () => {
    const a = t.headers(await t.signUp("A", "a@example.com"));
    const b = t.headers(await t.signUp("B", "b@example.com"));
    const idOf = async (h: Headers) => (await t.auth.api.getSession({ headers: h }))!.user.id;
    expect(await prefs.theme(await idOf(a))).toBeNull();
    await prefs.setTheme(a, { mode: "dark", accent: "green", preset: "ocean", dim: 25, blur: 6, background: "data:image/jpeg;base64,xx" });
    expect(await prefs.theme(await idOf(a))).toEqual({ mode: "dark", accent: "green", preset: "ocean", dim: 25, blur: 6 }); // 背景画像はサーバーに置かない
    await prefs.setTheme(a, { mode: "light", accent: "auto", preset: "end", dim: 10, blur: 0 });
    expect((await prefs.theme(await idOf(a)))?.preset).toBe("end");
    expect(await prefs.theme(await idOf(b))).toBeNull();
  });

  it("知らない値・範囲の外は既定にそろえる。ログインしていない・API トークンでは保存できない", async () => {
    expect(cleanTheme({ mode: "x", accent: "red", preset: "<script>", dim: 999, blur: -3 })).toEqual({ mode: "auto", accent: "auto", preset: "standard", dim: 80, blur: 0 });
    await expect(prefs.setTheme(new Headers(), {})).rejects.toBeInstanceOf(HttpError);
    await expect(prefs.setTheme(new Headers({ "x-api-key": "cs_wrongwrongwrong" }), {})).rejects.toMatchObject({ status: 401 });
  });
});
