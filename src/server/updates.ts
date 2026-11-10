// パネルの自動アップデートと「この更新の前に戻す」(自分用の版だけ。v02 の自動アップデート・01.24 のアップデートの前の状態)。
// 更新(自動でも手動でも)の前にパネルのバックアップを作り、前の版と組にして覚える。戻すときは、そのバックアップを次の起動で戻し(restore-pending)、版も前のものにする。
// 設定と更新の記録はデータベースではなく /data/v03/panel-update.json に置く(バックアップから戻しても、記録と「戻した版を自動で入れ直さない」が消えないように)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import type { backupService } from "./backup";
import { job, organization } from "./db/schema";
import { eventService } from "./events";
import { HttpError, isHttpError, requireTeam } from "./guard";
import { jobService } from "./jobs";
import type { Deps } from "./servers";
import type { Release, versionService } from "./versions";

export type UpdateChannel = "stable" | "dev";
export type UpdateEntry = { at: string; from: string; to: string; backup: string | null; auto: boolean; rolledBackAt?: string };
export type UpdateState = { auto: boolean; channel: UpdateChannel; lastCheck: string; skip: string[]; history: UpdateEntry[] };
const HISTORY_MAX = 20;

export const updateStatePath = (v03Dir: string) => join(v03Dir, "panel-update.json");

export function readUpdateState(v03Dir: string): UpdateState {
  let s: Partial<UpdateState> = {};
  try {
    if (existsSync(updateStatePath(v03Dir))) s = JSON.parse(readFileSync(updateStatePath(v03Dir), "utf8"));
  } catch { /* 読めなければ既定 */ }
  return { auto: s.auto === true, channel: s.channel === "dev" ? "dev" : "stable", lastCheck: String(s.lastCheck ?? ""),
    skip: Array.isArray(s.skip) ? s.skip.map(String) : [], history: Array.isArray(s.history) ? s.history : [] };
}

export const writeUpdateState = (v03Dir: string, s: UpdateState) => writeFileSync(updateStatePath(v03Dir), JSON.stringify(s, null, 2) + "\n");

const majorOf = (v: string) => v.split(".")[0];

/** 自動で入れる版: 選んだ範囲(安定版だけ / 開発版も)で、いまより新しく、大きな版上げ(メジャーが変わる)でなく、戻したことのないもの(releases は新しい順) */
export function pickAuto(releases: Release[], current: string, channel: UpdateChannel, skip: string[]): Release | null {
  return releases.find((r) => (channel === "dev" || r.stable) && r.version > current && majorOf(r.version) === majorOf(current) && !skip.includes(r.version)) ?? null;
}

type Versions = ReturnType<typeof versionService>;
type Backups = ReturnType<typeof backupService>;

export function updateService(deps: Deps, versions: Versions, backups: Backups) {
  const { db, auth } = deps;
  const { record, announcePanel } = eventService(deps);
  const jobs = jobService(deps);
  if (!deps.local) throw new Error("パネルの更新は、自分用の版だけで使えます");
  const v03Dir = join(deps.local.dataDir, "v03");
  const read = () => readUpdateState(v03Dir);
  const write = (s: UpdateState) => writeUpdateState(v03Dir, s);

  /** バックアップを作ってから版を切り替え、組にして覚える(再起動は呼ぶ側で) */
  async function apply(teamId: string, userId: string | null, version: string, auto: boolean) {
    const from = versions.state().current;
    return jobs.track({ teamId, userId, action: auto ? "パネルの自動アップデート" : "パネルの版を切り替える", target: `v${from} → v${version}` }, async () => {
      // PostgreSQL のときは、ここではバックアップを作れない(そちらのバックアップを使う)ので、作らずに切り替える
      const backup = backups.supported() ? (await backups.makeFor(teamId, userId)).name : null;
      await versions.use(version);
      const s = read();
      s.history = [{ at: new Date().toISOString(), from, to: version, backup, auto }, ...s.history].slice(0, HISTORY_MAX);
      write(s);
      await record({ teamId, userId, kind: "panel", action: auto ? "パネルを自動でアップデート" : "パネルの版を切り替える", target: `v${from} → v${version}`,
        detail: backup ? `前のデータ: ${backup}(「この更新の前に戻す」で戻せます)` : "" });
      return backup;
    }, (b) => (b ? `前のデータ: ${b}` : ""));
  }

  return {
    /** 自動アップデートの設定と、更新の記録(新しい順。戻せるものに印) */
    async settings(headers: Headers) {
      await requireTeam(auth, headers, { panel: ["manage"] });
      const s = read();
      return { auto: s.auto, channel: s.channel, lastCheck: s.lastCheck, history: s.history.map((e) => ({ ...e, canRollback: !!e.backup && !e.rolledBackAt })) };
    },

    async setAuto(headers: Headers, input: { auto: boolean; channel: UpdateChannel }) {
      const who = await requireTeam(auth, headers, { panel: ["manage"] });
      const s = read();
      s.auto = input.auto;
      s.channel = input.channel === "dev" ? "dev" : "stable";
      write(s);
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: input.auto ? "パネルの自動アップデートを使う" : "パネルの自動アップデートをやめる",
        detail: input.auto ? (s.channel === "dev" ? "開発版も" : "安定版だけ") : "" });
    },

    /** 手で版を切り替える(前にバックアップを作る。再起動は呼ぶ側で) */
    async update(headers: Headers, version: string) {
      const who = await requireTeam(auth, headers, { panel: ["manage"] });
      await apply(who.teamId, who.user.id, version, false);
    },

    /**
     * この更新の前に戻す: 更新の前に作ったバックアップを次の起動で戻し、版も前のものにする(再起動は呼ぶ側で)。
     * データを戻すので、版の切り替えに加えてバックアップから戻せる人(管理者以上)だけ。戻した版は自動では入れ直さない
     */
    async rollback(headers: Headers, at: string) {
      const who = await requireTeam(auth, headers, { panel: ["manage"], member: ["update"] });
      const s = read();
      const e = s.history.find((x) => x.at === at);
      if (!e?.backup) throw new HttpError(404, "その更新の前のバックアップがありません");
      if (e.rolledBackAt) throw new HttpError(400, "その更新は、もう戻しています");
      try {
        await backups.restoreFor(who.teamId, who.user.id, e.backup);
      } catch (err) {
        throw isHttpError(err) && err.status === 404 ? new HttpError(404, "その更新の前のバックアップが見つかりません(残す数を超えて消えた可能性があります)") : err;
      }
      try {
        await versions.use(e.from);
      } catch (err) {
        backups.cancelRestore();
        throw err;
      }
      e.rolledBackAt = new Date().toISOString();
      if (!s.skip.includes(e.to)) s.skip.push(e.to);
      write(s);
      await record({ teamId: who.teamId, userId: who.user.id, kind: "panel", action: "パネルを更新の前に戻す", target: `v${e.to} → v${e.from}`, detail: `データ: ${e.backup}` });
    },

    /**
     * 6 時間ごとに呼ぶ: 新しい版があれば知らせ、自動アップデートを使うなら入れる。入れたら true(呼ぶ側で再起動する)。
     * 時間のかかる処理が動いている間は入れない(次の回に)
     */
    async check(now = new Date()) {
      const releases = await versions.list();
      const current = versions.state().current;
      const s = read();
      s.lastCheck = now.toISOString();
      write(s);
      if (releases[0] && releases[0].version > current) await announcePanel(releases[0].version);
      const pick = s.auto ? pickAuto(releases, current, s.channel, s.skip) : null;
      if (!pick) return false;
      if ((await db.select({ id: job.id }).from(job).where(inArray(job.state, ["queued", "running"])).limit(1)).length) return false;
      const [team] = await db.select({ id: organization.id }).from(organization).orderBy(organization.createdAt).limit(1);
      if (!team) return false;
      try {
        await apply(team.id, null, pick.version, true);
        return true;
      } catch (e) {
        await record({ teamId: team.id, userId: null, kind: "panel", also: ["errors"], action: "パネルの自動アップデートができませんでした", target: `v${current} → v${pick.version}`,
          detail: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
  };
}
