// 認証の通しテスト: 組み込みの PGlite に移行を流し、登録・ログイン・二段階認証・ログアウトまで確かめる
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";

const APP_URL = "http://localhost:3000";
let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  const db = await createDb("pglite:", "drizzle");
  auth = createAuth(db, { appUrl: APP_URL, secret: "test-secret-0123456789-0123456789-abcd" });
});

const headers = (cookie = "") => new Headers({ origin: APP_URL, cookie });
const cookieOf = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function call(path: string, body: unknown, cookie = "") {
  const h = headers(cookie);
  h.set("content-type", "application/json");
  return auth.handler(new Request(APP_URL + "/api/auth" + path, { method: "POST", headers: h, body: JSON.stringify(body) }));
}

// RFC 6238 の TOTP(認証アプリと同じ計算)
function totp(base32: string, t = Date.now()) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("認証", () => {
  const user = { name: "テスト", email: "test@example.com", password: "correct horse battery" };

  it("死活確認(Docker の HEALTHCHECK)に答える", async () => {
    const res = await auth.handler(new Request(APP_URL + "/api/auth/ok"));
    expect(res.status).toBe(200);
  });

  it("登録してログインできる", async () => {
    const res = await call("/sign-up/email", user);
    expect(res.status).toBe(200);
    const session = await auth.api.getSession({ headers: headers(cookieOf(res)) });
    expect(session?.user.email).toBe(user.email);
  });

  it("パスワードが違うと失敗する", async () => {
    const res = await call("/sign-in/email", { email: user.email, password: "wrong password!!" });
    expect(res.status).toBe(401);
  });

  it("二段階認証を有効にすると、ログインにコードが要る", async () => {
    const login = await call("/sign-in/email", { email: user.email, password: user.password });
    const cookie = cookieOf(login);
    const enable = await call("/two-factor/enable", { password: user.password }, cookie);
    expect(enable.status).toBe(200);
    const { totpURI } = await enable.json();
    const secret = new URL(totpURI).searchParams.get("secret")!;
    expect((await call("/two-factor/verify-totp", { code: totp(secret) }, cookie)).status).toBe(200);

    // もう一度ログインすると、コードの入力を求められる
    const again = await call("/sign-in/email", { email: user.email, password: user.password });
    expect((await again.json()).twoFactorRedirect).toBe(true);
    const pending = cookieOf(again);
    expect(await auth.api.getSession({ headers: headers(pending) })).toBeNull();
    expect((await call("/two-factor/verify-totp", { code: "000000" }, pending)).status).not.toBe(200);
    const ok = await call("/two-factor/verify-totp", { code: totp(secret) }, pending);
    expect(ok.status).toBe(200);
    expect((await auth.api.getSession({ headers: headers(cookieOf(ok)) }))?.user.twoFactorEnabled).toBe(true);
  });

  it("ログアウトするとセッションが無効になる", async () => {
    const res = await call("/sign-up/email", { ...user, email: "out@example.com" });
    const cookie = cookieOf(res);
    expect((await call("/sign-out", {}, cookie)).status).toBe(200);
    expect(await auth.api.getSession({ headers: headers(cookie) })).toBeNull();
  });
});
