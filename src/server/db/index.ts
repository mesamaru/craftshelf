import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// 時刻の列は timestamp(時間帯なし)で、Drizzle は UTC として読み書きする。データベースの既定の now() も UTC で入るよう、
// つなぎの時間帯を UTC にする(しないと、パソコン・コンテナの時間帯のぶん先の時刻として読まれる)。
// 移行は切り替える前のつなぎで流す(0025_time_utc が、それまでの時間帯で入った時刻を UTC に直すため)
const UTC = "SET TIME ZONE 'UTC'";

// 本番のビルドでは instance.ts が 2 つの束(サーバーの関数 / サーバーのルートと起動時の処理)に別々に入るので、同じデータベースはプロセスで 1 回だけ開く
// (PGlite は同じフォルダを 2 つで開くと、互いの書き込みが見えず、予約などが古い中身で動く)。テストの "pglite:"(メモリ)は毎回新しく作る
const opened: Map<string, Promise<Db>> = ((globalThis as { __craftshelfDb?: Map<string, Promise<Db>> }).__craftshelfDb ??= new Map());
export function createDb(url: string, migrationsDir: string): Promise<Db> {
  if (url === "pglite:") return openDb(url, migrationsDir);
  if (!opened.has(url)) opened.set(url, openDb(url, migrationsDir));
  return opened.get(url)!;
}

// DATABASE_URL が postgres:// なら PostgreSQL、pglite:<フォルダー> なら組み込みの PGlite(試すとき・テスト用)
async function openDb(url: string, migrationsDir: string): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dir = url.slice("pglite:".length);
    if (dir) (await import("node:fs")).mkdirSync(dir, { recursive: true });
    const pg = new PGlite(dir || undefined);
    const db = drizzle(pg, { schema });
    await migrate(db, { migrationsFolder: migrationsDir });
    await pg.exec(UTC); // PGlite のつなぎは 1 つだけ
    return db;
  }
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const once = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(once, { schema }), { migrationsFolder: migrationsDir });
  } finally {
    await once.end();
  }
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // つないだら最初に送る(同じつなぎの問い合わせは順に流れるので、ほかの問い合わせより先に効く)
  pool.on("connect", (c) => { c.query(UTC).catch(() => {}); });
  return drizzle(pool, { schema });
}
