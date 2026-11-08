// メール(サービス版のメールアドレスの確認・パスワードの再設定・招待)。送るのは偽物の送り手で受け取る
import { beforeAll, describe, expect, it } from "vitest";
import { type Mail, resendMailer } from "~/server/mail";
import type { FetchLike } from "~/server/net";
import { APP_URL, setup } from "./helpers";

const box: Mail[] = [];
const last = (to: string) => [...box].reverse().find((m) => m.to === to)!;
const link = (m: Mail) => m.text.match(/https?:\/\/\S+/)![0];
let t: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  t = await setup({ mode: "service", mailer: { send: async (m) => { box.push(m); } } });
});

describe("メールアドレスの確認(サービス版)", () => {
  it("登録すると確認のメールを送り、確かめるまではログインできない。リンクを開くとログインできる", async () => {
    const res = await t.call("/sign-up/email", { name: "Ann", email: "ann@example.com", password: "correct horse battery" }, "", "10.1.0.1");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(false);
    expect(last("ann@example.com").subject).toContain("メールアドレスの確認");
    const before = await t.call("/sign-in/email", { email: "ann@example.com", password: "correct horse battery" }, "", "10.1.0.2");
    expect(before.status).toBe(403);
    expect((await before.json()).code).toBe("EMAIL_NOT_VERIFIED");
    const url = new URL(link(last("ann@example.com")));
    expect(url.pathname).toBe("/api/auth/verify-email");
    const v = await t.get(url.pathname.slice("/api/auth".length) + url.search);
    expect(v.status).toBeLessThan(400);
    expect((await t.call("/sign-in/email", { email: "ann@example.com", password: "correct horse battery" }, "", "10.1.0.3")).status).toBe(200);
  });
});

describe("パスワードの再設定", () => {
  it("メールのリンクの合言葉で、新しいパスワードにできる", async () => {
    expect((await t.call("/request-password-reset", { email: "ann@example.com", redirectTo: "/reset" }, "", "10.1.0.4")).status).toBe(200);
    const m = last("ann@example.com");
    expect(m.subject).toContain("パスワードの再設定");
    const token = new URL(link(m)).pathname.split("/").pop()!;
    expect((await t.call("/reset-password", { newPassword: "a brand new password", token }, "", "10.1.0.5")).status).toBe(200);
    expect((await t.call("/sign-in/email", { email: "ann@example.com", password: "a brand new password" }, "", "10.1.0.6")).status).toBe(200);
    expect((await t.call("/reset-password", { newPassword: "another one 12345", token }, "", "10.1.0.7")).status).toBe(400); // 一度だけ
  });
});

describe("招待", () => {
  it("招待するとメールでもリンクを送る", async () => {
    const res = await t.call("/sign-in/email", { email: "ann@example.com", password: "a brand new password" }, "", "10.1.0.8");
    const cookie = t.cookieOf(res);
    const inv = await (await t.call("/organization/invite-member", { email: "bob@example.com", role: "viewer" }, cookie)).json();
    const m = last("bob@example.com");
    expect(m.subject).toContain("への招待");
    expect(link(m)).toBe(`${APP_URL}/invite/${inv.id}`);
  });
});

describe("Resend", () => {
  it("API キーと送り元を付けて送る。失敗したら理由を返す", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fake: FetchLike = async (url, init) => { sent.push({ url, init: init! }); return new Response("{}", { status }); };
    const mailer = resendMailer(fake, "re_test", "CraftShelf <no-reply@example.com>");
    await mailer.send({ to: "x@example.com", subject: "s", text: "t" });
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect((sent[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ from: "CraftShelf <no-reply@example.com>", to: ["x@example.com"], subject: "s", text: "t" });
    status = 422;
    await expect(mailer.send({ to: "x@example.com", subject: "s", text: "t" })).rejects.toThrow("HTTP 422");
  });
});
