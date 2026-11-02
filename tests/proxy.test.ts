// 自分用の版で URL を決めていないとき: リバースプロキシ(HTTPS)の後ろでもログインできる・ほかのサイトからは受け付けない
import { beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup({ mode: "self", appUrl: null });
});

// プロキシの後ろ: こちらには http://内側のアドレス で届き、元のアドレスは Host / X-Forwarded-* で伝わる
const signIn = (origin: string, extra: Record<string, string>) => t.auth.handler(new Request("http://10.0.0.5:8080/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json", origin, cookie: "x=1", "x-test-ip": `10.20.0.${Math.floor(Math.random() * 250)}`, ...extra },
  body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery" }),
}));

describe("リバースプロキシの後ろ(URL を決めていない)", () => {
  it("同じホストの https から開いたときはログインできる", async () => {
    await t.signUp("オーナー", "owner@example.com");
    expect((await signIn("https://panel.example.test", { host: "panel.example.test", "x-forwarded-proto": "https" })).status).toBe(200);
    expect((await signIn("https://panel.example.test", { host: "app:8080", "x-forwarded-host": "panel.example.test", "x-forwarded-proto": "https" })).status).toBe(200);
  });

  it("ほかのサイトからのリクエストは受け付けない", async () => {
    const r = await signIn("https://evil.example.test", { host: "panel.example.test", "x-forwarded-proto": "https" });
    expect(r.status).toBe(403);
  });
});
