// 利用者から預かる API キーなどを、データベースに暗号化して保存する(AES-256-GCM)。
// 鍵は BETTER_AUTH_SECRET から用途ごとに作る。BETTER_AUTH_SECRET を変えると、保存済みのものは読めなくなる
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFor(secret: string) {
  return Buffer.from(hkdfSync("sha256", secret, "craftshelf-next", "stored-credentials-v1", 32));
}

// context(保存する行の ID など)を一緒に渡す。別の行へ写し替えられても読めないようにするため
export function seal(secret: string, plain: string, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  c.setAAD(Buffer.from(context));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [VERSION, iv.toString("base64url"), body.toString("base64url"), c.getAuthTag().toString("base64url")].join(":");
}

export function open(secret: string, sealed: string, context: string): string {
  const [v, iv, body, tag] = sealed.split(":");
  if (v !== VERSION || !iv || !body || !tag) throw new Error("保存した鍵の形式が違います");
  const d = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(context));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

// 画面に出すときの見分け用(最後の 4 文字だけ)
export const hint = (key: string) => `…${key.slice(-4)}`;
