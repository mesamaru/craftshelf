// テスト用: 組み込みの PGlite で認証の仕組みを立ち上げ、HTTP と同じ形で呼ぶ
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";

export const APP_URL = "http://localhost:3000";

export async function setup() {
  const db = await createDb("pglite:", "drizzle");
  // 利用者の IP は x-test-ip で渡す(登録ごとに変えて、回数制限にかからないようにする)
  const auth = createAuth(db, { appUrl: APP_URL, secret: "test-secret-0123456789-0123456789-abcd", clientIpHeader: "x-test-ip" });
  let ipSeq = 0;

  const headers = (cookie = "", ip = "198.51.100.1") => new Headers({ origin: APP_URL, cookie, "x-test-ip": ip });
  const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  async function call(path: string, body: unknown, cookie = "", ip?: string) {
    const h = headers(cookie, ip);
    h.set("content-type", "application/json");
    return auth.handler(new Request(APP_URL + "/api/auth" + path, { method: "POST", headers: h, body: JSON.stringify(body) }));
  }
  async function get(path: string, cookie = "") {
    return auth.handler(new Request(APP_URL + "/api/auth" + path, { headers: headers(cookie) }));
  }
  // 登録して、そのまま使えるセッションの Cookie を返す
  async function signUp(name: string, email: string, password = "correct horse battery") {
    ipSeq++;
    const res = await call("/sign-up/email", { name, email, password }, "", `10.9.${ipSeq >> 8}.${ipSeq & 255}`);
    if (res.status !== 200) throw new Error(`登録に失敗: ${res.status} ${await res.text()}`);
    return cookieOf(res);
  }

  return { db, auth, headers, cookieOf, call, get, signUp };
}
