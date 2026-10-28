// サーバーで共有する接続(起動したときに一度だけ作る)
import { createAuth } from "./auth";
import { createDb } from "./db";
import { readEnv } from "./env";
import { lanFetch, safeFetch } from "./net";
import { libraryService } from "./library";
import { serverService } from "./servers";
import { versionService } from "./versions";

export const env = readEnv();
export const db = await createDb(env.databaseUrl, env.migrationsDir);
// 自分用の版が v02 と同じ /data で初めて起動したら、v02 のデータを取り込む(v02 のデータには書き込まない)
if (env.mode === "self") {
  const { maybeImportV02 } = await import("./import-v02");
  try {
    const r = await maybeImportV02(db, env);
    if (r) console.log(`[v02] 取り込みました: 利用者 ${r.users.length} 人・サーバー ${r.ptero?.servers ?? 0} 台(結果は /data/v03/import-v02.json)`);
  } catch (e) {
    console.error("[v02] 取り込みに失敗しました(v02 のデータはそのままです):", e);
  }
}
export const auth = createAuth(db, env);
// 自分用の版は家の中のアドレスにもつなぐ。サービス版は公開されたアドレスだけ(SSRF 対策)
const deps = { db, auth, secret: env.secret, fetch: env.mode === "self" ? lanFetch : safeFetch, allowPrivate: env.mode === "self" };
export const servers = serverService(deps);
export const library = libraryService(deps);

// パネルからの版の切り替え(自分用の版だけ。サービス版は Docker のイメージで入れ替える)
export const versions = env.mode === "self" ? versionService({ fetch: safeFetch, dataDir: env.dataDir }) : null;
versions?.confirmStarted();
