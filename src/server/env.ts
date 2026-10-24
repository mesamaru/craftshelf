// 環境変数(サーバーの中だけで読む)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";

// self = 自分のサーバー機に入れて使う版(既定)/ service = 多くの人が使うサービス版
export type Mode = "self" | "service";

function need(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`環境変数 ${name} を設定してください`);
  return v;
}

// 自分用の版は、鍵を自分で作ってデータの置き場所に保存する(v02 と同じく、設定しなくても動くように)
function storedSecret(dir: string): string {
  const file = join(dir, "secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dir, { recursive: true });
  const s = randomBytes(32).toString("base64url");
  writeFileSync(file, s + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows など、権限を変えられない環境
  }
  return s;
}

export function readEnv() {
  const mode: Mode = process.env.CRAFTSHELF_MODE === "service" ? "service" : "self";
  const dataDir = process.env.DATA_DIR || (isProd ? "/data" : "./.data");
  const v03Dir = join(dataDir, "v03"); // v02 のデータ(index.db・ライブラリ)とは分けて置く
  const service = mode === "service";

  // サービス版は公開する URL を決めておく。自分用の版は、開いたアドレスに合わせる(null)
  const appUrl = service ? need("APP_URL", isProd ? undefined : "http://localhost:3000") : process.env.APP_URL || null;
  const secret = process.env.BETTER_AUTH_SECRET
    || (service ? need("BETTER_AUTH_SECRET", isProd ? undefined : "dev-only-secret-change-me-0123456789") : storedSecret(v03Dir));
  if (isProd && secret.length < 32) throw new Error("BETTER_AUTH_SECRET は 32 文字以上にしてください");
  return {
    mode,
    dataDir,
    v03Dir,
    // v02 のデータ(index.db・secret.key)の場所。v02 と同じく CONFIG_DIR・DB_DIR があればそちら
    v02Dir: process.env.V02_CONFIG_DIR || process.env.CONFIG_DIR || process.env.DB_DIR || dataDir,
    appUrl,
    secret,
    databaseUrl: process.env.DATABASE_URL || (service && isProd ? need("DATABASE_URL") : `pglite:${join(v03Dir, "pg")}`),
    migrationsDir: process.env.MIGRATIONS_DIR || "drizzle",
    // 利用者の IP を入れてくるヘッダー(Cloudflare Tunnel なら cf-connecting-ip)。
    // アプリに直接つなげない構成のときだけ設定する(直接つなげると書き換えられる)
    clientIpHeader: process.env.CLIENT_IP_HEADER || "",
  };
}

export type Env = ReturnType<typeof readEnv>;
