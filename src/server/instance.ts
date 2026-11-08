// サーバーで共有する接続(起動したときに一度だけ作る)
import { createAuth } from "./auth";
import { createDb } from "./db";
import { readEnv } from "./env";
import { lanFetch, safeFetch } from "./net";
import { libraryService } from "./library";
import { portService } from "./ports";
import { serverService } from "./servers";
import { setService } from "./sets";
import { eventService } from "./events";
import { scheduleService } from "./schedule";
import { fileService } from "./files";
import { uploadService } from "./uploads";
import { shareService } from "./shares";
import { tokenService } from "./tokens";
import { versionService } from "./versions";
import { softwareService } from "./software";
import { backupService } from "./backup";
import { worldService } from "./worlds";
import { modpackService } from "./modpack";
import { telemetryService } from "./telemetry";
import { teamService } from "./teams";

// 置いてあるバックアップで入れ替える(データベースを開く前・鍵を読む前。自分用の版だけ)
{
  const first = readEnv();
  if (first.mode === "self") {
    const { applyPendingReimport, applyPendingRestore } = await import("./backup");
    try {
      const aside = await applyPendingRestore(first.v03Dir, first.databaseUrl);
      if (aside) console.log(`[復元] バックアップから戻しました(前のデータは ${aside})`);
    } catch (e) {
      console.error("[復元] 戻せませんでした(前のデータのまま起動します):", e);
    }
    try {
      const aside = applyPendingReimport(first.v03Dir, first.databaseUrl);
      if (aside) console.log(`[v02] 取り込み直します(v03 の前のデータは ${aside})`);
    } catch (e) {
      console.error("[v02] 取り込み直す用意ができませんでした:", e);
    }
  }
}
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
  const { maybeImportV02Library } = await import("./import-v02");
  try {
    const r = await maybeImportV02Library(db, env);
    if (r) console.log(`[v02] ライブラリを取り込みました: ${r.items} 件・セット ${r.sets} 個・フォルダのサーバー ${r.folders ?? 0} 台(結果は /data/v03/import-v02-library.json)`);
  } catch (e) {
    console.error("[v02] ライブラリの取り込みに失敗しました(v02 のデータはそのままです):", e);
  }
  const { maybeImportV02AutoUpdate } = await import("./import-v02");
  try {
    const r = await maybeImportV02AutoUpdate(db, env);
    if (r?.servers.length) console.log(`[v02] 自動更新を引き継ぎました: ${r.servers.join("、")}`);
  } catch (e) {
    console.error("[v02] 自動更新の取り込みに失敗しました(v02 のデータはそのままです):", e);
  }
  const { maybeImportV02Backups } = await import("./import-v02");
  try {
    const r = await maybeImportV02Backups(db, env);
    if (r && (r.panel || r.worlds.length)) console.log(`[v02] バックアップの設定を引き継ぎました: ${[r.panel ? "パネルの定期バックアップ" : "", ...r.worlds].filter(Boolean).join("、")}`);
  } catch (e) {
    console.error("[v02] バックアップの設定の取り込みに失敗しました(v02 のデータはそのままです):", e);
  }
  const { maybeImportV02Software } = await import("./import-v02");
  try {
    const r = await maybeImportV02Software(db, env);
    if (r?.servers.length) console.log(`[v02] サーバー本体の種類を引き継ぎました: ${r.servers.join("、")}`);
  } catch (e) {
    console.error("[v02] サーバー本体の種類の取り込みに失敗しました(v02 のデータはそのままです):", e);
  }
  const { maybeImportV02Schedules } = await import("./import-v02");
  try {
    const r = await maybeImportV02Schedules(db, env);
    if (r?.servers.length) console.log(`[v02] サーバーごとの予約を引き継ぎました: ${r.servers.join("、")}`);
  } catch (e) {
    console.error("[v02] サーバーごとの予約の取り込みに失敗しました(v02 のデータはそのままです):", e);
  }
}
const { resendMailer } = await import("./mail");
export const mailer = env.mail ? resendMailer(safeFetch, env.mail.resendKey, env.mail.from) : null;
export const auth = createAuth(db, { ...env, mailer });
// 自分用の版は家の中のアドレスにもつなぐ。サービス版は公開されたアドレスだけ(SSRF 対策)
// エージェントとのやりとりの列(このプロセスに 1 つ)
const { agentHub } = await import("./agent-hub");
export const hub = agentHub();
const deps = { agents: hub, db, auth, secret: env.secret, fetch: env.mode === "self" ? lanFetch : safeFetch, allowPrivate: env.mode === "self",
  ...(env.mode === "self" ? { local: { dataDir: env.dataDir } } : {}) };
export const servers = serverService(deps);
export const library = libraryService(deps);
export const sets = setService(deps);
export const events = eventService(deps);
export const schedules = scheduleService(deps, sets);
export const files = fileService(deps);
export const software = softwareService(deps);
export const backups = backupService(deps);
export const worlds = worldService(deps);
export const modpacks = modpackService(deps);
export const teams = teamService(deps);
const { agentService } = await import("./agents");
export const agents = agentService(deps);
// 利用状況の送信は、同意したパネルから v02 と同じ受け口へ(送る先へのつなぎ方はサービス版と同じ)
export const telemetry = telemetryService({ ...deps, fetch: safeFetch });
export const uploads = uploadService(deps);
export const shares = shareService(deps);
export const tokens = tokenService(deps);
export const ports = portService(deps);

// パネルからの版の切り替え(自分用の版だけ。サービス版は Docker のイメージで入れ替える)
export const versions = env.mode === "self" ? versionService({ fetch: safeFetch, dataDir: env.dataDir }) : null;
versions?.confirmStarted();
