// サーバーで共有する接続(起動したときに一度だけ作る)
import { createAuth } from "./auth";
import { createDb } from "./db";
import { readEnv } from "./env";
import { safeFetch } from "./net";
import { libraryService } from "./library";
import { serverService } from "./servers";

const env = readEnv();
export const db = await createDb(env.databaseUrl, env.migrationsDir);
export const auth = createAuth(db, env);
export const servers = serverService({ db, auth, secret: env.secret, fetch: safeFetch });
export const library = libraryService({ db, auth, secret: env.secret, fetch: safeFetch });
