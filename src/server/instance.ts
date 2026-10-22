// サーバーで共有する接続(起動したときに一度だけ作る)
import { createAuth } from "./auth";
import { createDb } from "./db";
import { readEnv } from "./env";

const env = readEnv();
export const db = await createDb(env.databaseUrl, env.migrationsDir);
export const auth = createAuth(db, env);
