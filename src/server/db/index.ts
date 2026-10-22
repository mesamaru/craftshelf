import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// DATABASE_URL が postgres:// なら PostgreSQL、pglite:<フォルダー> なら組み込みの PGlite(試すとき・テスト用)
export async function createDb(url: string, migrationsDir: string): Promise<Db> {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dir = url.slice("pglite:".length);
    if (dir) (await import("node:fs")).mkdirSync(dir, { recursive: true });
    const db = drizzle(new PGlite(dir || undefined), { schema });
    await migrate(db, { migrationsFolder: migrationsDir });
    return db;
  }
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const db = drizzle(new pg.Pool({ connectionString: url, max: 10 }), { schema });
  await migrate(db, { migrationsFolder: migrationsDir });
  return db;
}
