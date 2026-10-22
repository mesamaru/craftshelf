// テスト用: 組み込みの PGlite で認証の仕組みを立ち上げ、HTTP と同じ形で呼ぶ
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";

export const APP_URL = "http://localhost:3000";

export async function setup() {
  const db = await createDb("pglite:", "drizzle");
  const auth = createAuth(db, { appUrl: APP_URL, secret: "test-secret-0123456789-0123456789-abcd" });

  const headers = (cookie = "") => new Headers({ origin: APP_URL, cookie });
  const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  async function call(path: string, body: unknown, cookie = "") {
    const h = headers(cookie);
    h.set("content-type", "application/json");
    return auth.handler(new Request(APP_URL + "/api/auth" + path, { method: "POST", headers: h, body: JSON.stringify(body) }));
  }
  async function get(path: string, cookie = "") {
    return auth.handler(new Request(APP_URL + "/api/auth" + path, { headers: headers(cookie) }));
  }
  // 登録して、そのまま使えるセッションの Cookie を返す
  async function signUp(name: string, email: string, password = "correct horse battery") {
    const res = await call("/sign-up/email", { name, email, password });
    if (res.status !== 200) throw new Error(`登録に失敗: ${res.status} ${await res.text()}`);
    return cookieOf(res);
  }

  return { db, auth, headers, cookieOf, call, get, signUp };
}
