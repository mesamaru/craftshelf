// v02(Python)のデータの形を読む: パスワードのハッシュ(Werkzeug)・暗号化した値(Fernet)・二段階認証のコード
import { createDecipheriv, createHmac, pbkdf2Sync, scryptSync, timingSafeEqual } from "node:crypto";

const eq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

// Werkzeug の generate_password_hash の形(scrypt:N:r:p$salt$hex / pbkdf2:sha256:回数$salt$hex)なら確かめる。
// それ以外の形なら null(v03 の形として確かめてもらう)
export function verifyWerkzeug(hash: string, password: string): boolean | null {
  const m = hash.match(/^(scrypt|pbkdf2):([^$]+)\$([^$]*)\$([0-9a-f]+)$/);
  if (!m) return null;
  const [, method, args, salt, hex] = m;
  const want = Buffer.from(hex, "hex");
  try {
    if (method === "scrypt") {
      const [n, r, p] = args.split(":").map(Number);
      if (!n || !r || !p || n > 2 ** 20) return false;
      return eq(scryptSync(password, salt, want.length, { N: n, r, p, maxmem: 132 * n * r * p + 2 ** 20 }), want);
    }
    const [digest, iter] = args.split(":");
    if (!/^sha(1|256|512)$/.test(digest)) return false;
    return eq(pbkdf2Sync(password, salt, Number(iter) || 600000, want.length, digest), want);
  } catch {
    return false;
  }
}

// v02 の encrypt_secret の値(enc:<Fernet> / plain:<base64>)を戻す。key は v02 の secret.key の中身
export function decryptV02Secret(value: string, key: string): string {
  if (!value) return "";
  if (value.startsWith("plain:")) return Buffer.from(value.slice(6), "base64url").toString("utf8");
  if (!value.startsWith("enc:")) throw new Error("v02 の暗号化した値の形が違います");
  const k = Buffer.from(key.trim(), "base64url");
  if (k.length !== 32) throw new Error("v02 の secret.key の形が違います");
  const token = Buffer.from(value.slice(4), "base64url");
  if (token.length < 1 + 8 + 16 + 16 + 32 || token[0] !== 0x80) throw new Error("v02 の暗号化した値の形が違います");
  const body = token.subarray(0, token.length - 32);
  const mac = createHmac("sha256", k.subarray(0, 16)).update(body).digest();
  if (!eq(mac, token.subarray(token.length - 32))) throw new Error("v02 の暗号化した値を確かめられません(鍵が違います)");
  const d = createDecipheriv("aes-128-cbc", k.subarray(16), body.subarray(9, 25));
  return Buffer.concat([d.update(body.subarray(25)), d.final()]).toString("utf8");
}

// v02 の二段階認証(base32 の秘密の値・30 秒・6 桁・前後 1 つまで許す)
function base32(s: string): Buffer {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = alpha.indexOf(ch);
    if (i < 0) throw new Error("base32 の形が違います");
    bits += i.toString(2).padStart(5, "0");
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function verifyV02Totp(secret: string, code: string, now = Date.now()): boolean {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!secret || !/^\d{6}$/.test(c)) return false;
  const step = Math.floor(now / 1000 / 30);
  return [-1, 0, 1].some((d) => eq(Buffer.from(totpCode(secret, step + d)), Buffer.from(c)));
}
