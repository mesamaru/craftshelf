// メール(サービス版のメールアドレスの確認・パスワードの再設定・招待)。送るのは偽物の送り手で受け取る
import { beforeAll, describe, expect, it } from "vitest";
import { type Mail, resendMailer, smtpMailer } from "~/server/mail";
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

describe("招待を受ける前のメールアドレスの確認(自分用の版でメールを送れるとき)", () => {
  it("確かめるまでは招待を見られず、確認のメールのリンクを開くと参加できる。最初の 1 人には確認のメールを送らない", async () => {
    const own: Mail[] = [];
    const s = await setup({ mode: "self", mailer: { send: async (m) => { own.push(m); } } });
    const owner = await s.signUp("オーナー", "owner@example.com");
    expect(own.filter((m) => m.subject.includes("確認"))).toEqual([]);
    const inv = await (await s.call("/organization/invite-member", { email: "cat@example.com", role: "viewer" }, owner)).json();
    const cat = await s.signUp("Cat", "cat@example.com"); // 招待されたアドレスなので登録はできる
    const blocked = await s.get(`/organization/get-invitation?id=${inv.id}`, cat);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toMatch(/EMAIL_VERIFICATION_REQUIRED/);
    expect((await s.call("/organization/accept-invitation", { invitationId: inv.id }, cat)).status).toBe(403);
    // 招待のページの「確認のメールを送る」
    expect((await s.call("/send-verification-email", { email: "cat@example.com", callbackURL: `/invite/${inv.id}` }, cat)).status).toBe(200);
    const m = [...own].reverse().find((x) => x.to === "cat@example.com" && x.subject.includes("メールアドレスの確認"))!;
    const url = new URL(link(m));
    expect((await s.get(url.pathname.slice("/api/auth".length) + url.search)).status).toBeLessThan(400);
    expect((await s.call("/organization/accept-invitation", { invitationId: inv.id }, cat)).status).toBe(200);
  });

  it("メールを送れないパネルでは、確認なしで参加できる(リンクを本人だけに渡す)", async () => {
    const s = await setup({ mode: "self" });
    const owner = await s.signUp("オーナー", "owner@example.com");
    const inv = await (await s.call("/organization/invite-member", { email: "dan@example.com", role: "viewer" }, owner)).json();
    const dan = await s.signUp("Dan", "dan@example.com");
    expect((await s.call("/organization/accept-invitation", { invitationId: inv.id }, dan)).status).toBe(200);
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

describe("SMTP", () => {
  it("SMTP_URL のサーバーへ送る(送り元・宛先・件名・本文)。つながらなければ理由を返す", async () => {
    const { createServer } = await import("node:net");
    const got: string[] = [];
    const srv = createServer((sock) => {
      let data = false;
      let buf = "";
      sock.write("220 test ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          got.push(line);
          if (data) { if (line === ".") { data = false; sock.write("250 queued\r\n"); } continue; }
          if (/^EHLO/i.test(line)) sock.write("250 test\r\n");
          else if (/^DATA/i.test(line)) { data = true; sock.write("354 go\r\n"); }
          else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
          else sock.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      await smtpMailer(`smtp://127.0.0.1:${port}?ignoreTLS=true`, "CraftShelf <no-reply@example.com>").send({ to: "eve@example.com", subject: "件名", text: "本文です" });
      expect(got).toContain("MAIL FROM:<no-reply@example.com>");
      expect(got).toContain("RCPT TO:<eve@example.com>");
      expect(got.some((l) => l.startsWith("Subject:"))).toBe(true);
    } finally {
      srv.close();
    }
    await expect(smtpMailer("smtp://127.0.0.1:1?connectionTimeout=2000", "a@example.com").send({ to: "eve@example.com", subject: "s", text: "t" })).rejects.toThrow(/SMTP/);
  });
});
