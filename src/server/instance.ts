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
import { jobService } from "./jobs";
import { prefService } from "./prefs";

// 本番のビルドでは、このファイルが 2 つの束(サーバーの関数 / サーバーのルートと起動時の処理)に別々に入る。
// 中身(データベースを開く・v02 の取り込み・エージェントの列)はプロセスで 1 回だけ作り、両方で同じものを使う
async function build() {
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
  const env = readEnv();
  const db = await createDb(env.databaseUrl, env.migrationsDir);
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
    const { maybeImportV02Kinds } = await import("./import-v02");
    try {
      const r = await maybeImportV02Kinds(db, env);
      if (r && (r.items || r.uploads)) console.log(`[v02] データパックなどを取り込みました: ${r.items + (r.uploads ?? 0)} 件(結果は /data/v03/import-v02-kinds.json)`);
    } catch (e) {
      console.error("[v02] データパックなどの取り込みに失敗しました(v02 のデータはそのままです):", e);
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
    const { maybeImportV02Channels } = await import("./import-v02");
    try {
      const r = await maybeImportV02Channels(db, env);
      if (r && (r.team === "all" || r.items.length)) console.log(`[v02] 受け取る版の設定を引き継ぎました: ${[r.team === "all" ? "チームの既定(ベータ版も)" : "", ...r.items].filter(Boolean).join("、")}`);
    } catch (e) {
      console.error("[v02] 受け取る版の設定の取り込みに失敗しました(v02 のデータはそのままです):", e);
    }
    const { maybeImportV02Prefs } = await import("./import-v02");
    try {
      const r = await maybeImportV02Prefs(db, env);
      if (r?.users.length) console.log(`[v02] 見た目の設定を引き継ぎました: ${r.users.join("、")}`);
    } catch (e) {
      console.error("[v02] 見た目の設定の取り込みに失敗しました(v02 のデータはそのままです):", e);
    }
    const { maybeImportV02Pins } = await import("./import-v02");
    try {
      const r = await maybeImportV02Pins(db, { ...env, fetch: safeFetch });
      if (r && (r.pinned.length || r.skipped.length)) console.log(`[v02] セットの版の固定を引き継ぎました: ${r.pinned.length} 件(引き継げなかったもの ${r.skipped.length} 件。結果は /data/v03/import-v02-pins.json)`);
    } catch (e) {
      console.error("[v02] セットの版の固定の取り込みに失敗しました(v02 のデータはそのままです):", e);
    }
    const { maybeImportV02Perms } = await import("./import-v02");
    try {
      const r = await maybeImportV02Perms(db, env);
      if (r?.users.length) console.log(`[v02] ユーザーごとの権限を引き継ぎました: ${r.users.map((u) => u.name).join("、")}`);
    } catch (e) {
      console.error("[v02] ユーザーごとの権限の取り込みに失敗しました(v02 のデータはそのままです):", e);
    }
  }
  const { resendMailer } = await import("./mail");
  const mailer = env.mail ? resendMailer(safeFetch, env.mail.resendKey, env.mail.from) : null;
  const auth = createAuth(db, { ...env, mailer });
  // 自分用の版は家の中のアドレスにもつなぐ。サービス版は公開されたアドレスだけ(SSRF 対策)
  // エージェントとのやりとりの列(このプロセスに 1 つ)
  const { agentHub } = await import("./agent-hub");
  const hub = agentHub();
  const deps = { agents: hub, db, auth, secret: env.secret, fetch: env.mode === "self" ? lanFetch : safeFetch, allowPrivate: env.mode === "self",
    ...(env.mode === "self" ? { local: { dataDir: env.dataDir } } : {}) };
  const servers = serverService(deps);
  const library = libraryService(deps);
  const sets = setService(deps);
  const events = eventService(deps);
  const schedules = scheduleService(deps, sets);
  const files = fileService(deps);
  const software = softwareService(deps);
  const backups = backupService(deps);
  const worlds = worldService(deps);
  const modpacks = modpackService(deps);
  const teams = teamService(deps);
  const { agentService } = await import("./agents");
  const agents = agentService(deps);
  // 利用状況の送信は、同意したパネルから v02 と同じ受け口へ(送る先へのつなぎ方はサービス版と同じ)
  const telemetry = telemetryService({ ...deps, fetch: safeFetch });
  const uploads = uploadService(deps);
  const shares = shareService(deps);
  const tokens = tokenService(deps);
  const ports = portService(deps);
  const jobs = jobService(deps);
  const prefs = prefService(deps);
  // 前の起動で途中だった処理(処理の一覧)は「中断」にする(リクエストを受ける前に)
  await jobs.recover().catch((e) => console.error("[処理の一覧] 途中だったものを片付けられませんでした:", e));

  // パネルからの版の切り替え(自分用の版だけ。サービス版は Docker のイメージで入れ替える)
  const versions = env.mode === "self" ? versionService({ fetch: safeFetch, dataDir: env.dataDir }) : null;
  versions?.confirmStarted();
  return { env, db, mailer, auth, hub, servers, library, sets, events, schedules, files, software, backups, worlds, modpacks, teams, agents, telemetry, uploads, shares, tokens, ports, versions, jobs, prefs };
}
type Instance = Awaited<ReturnType<typeof build>>;
const once = globalThis as { __craftshelf?: Promise<Instance> };
export const { env, db, mailer, auth, hub, servers, library, sets, events, schedules, files, software, backups, worlds, modpacks, teams, agents, telemetry, uploads, shares, tokens, ports, versions, jobs, prefs } = await (once.__craftshelf ??= build());
