// 環境変数(サーバーの中だけで読む)
const isProd = process.env.NODE_ENV === "production";

function need(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`環境変数 ${name} を設定してください`);
  return v;
}

export function readEnv() {
  const appUrl = need("APP_URL", isProd ? undefined : "http://localhost:3000");
  const secret = need("BETTER_AUTH_SECRET", isProd ? undefined : "dev-only-secret-change-me-0123456789");
  if (isProd && secret.length < 32) throw new Error("BETTER_AUTH_SECRET は 32 文字以上にしてください");
  return {
    appUrl,
    secret,
    databaseUrl: need("DATABASE_URL", isProd ? undefined : "pglite:./.data/pg"),
    migrationsDir: process.env.MIGRATIONS_DIR || "drizzle",
    // 利用者の IP を入れてくるヘッダー(Cloudflare Tunnel なら cf-connecting-ip)。
    // アプリに直接つなげない構成のときだけ設定する(直接つなげると書き換えられる)
    clientIpHeader: process.env.CLIENT_IP_HEADER || "",
  };
}

export type Env = ReturnType<typeof readEnv>;
