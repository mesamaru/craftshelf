// パネルのバックアップと復元(自分用の版・PGlite だけ。管理者以上)。
// バックアップは 1 つの tar.gz: db.tar.gz(PGlite のデータの書き出し)・secret(保存した API キーなどを解く鍵)・library(パネルの中に置いたアドオン)。
// 戻すときは restore-pending.tar.gz として置いて再起動し、次の起動で入れ替える(今のデータは before-restore-… に移して残す)。
// 定期バックアップ(03.53.00 から): 毎日決めた時刻に作る。置き場所はパネルの中か保存先(SMB・WebDAV・フォルダ)、残す数も選べる
import { execFile } from "node:child_process";
import { copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { backupSchedule, storageTarget } from "./db/schema";
import { eventService } from "./events";
import { jobService } from "./jobs";
import { HttpError, isHttpError, requireTeam } from "./guard";
import { localParts } from "./schedule";
import type { Deps } from "./servers";
import { v02DirOf } from "./env";
import { readUpdateState } from "./updates";
import { fileStore, fromStorage } from "./uploads";

const run = promisify(execFile);
export const BACKUP_KEEP = 5; // 残す数の既定
export const BACKUP_KEEP_MAX = 60;
// パネルの更新の記録の新しい方からこの件数は、更新の前に作ったバックアップを「残す数」に数えず、消さない(「この更新の前に戻す」のため)
export const BACKUP_UPDATE_REFS = 5;
const DIR = "_craftshelf_backup"; // 保存先の中の場所(v02 と同じ。v02 のものは名前が違うので混ざらない)
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT = { enabled: false, time: "04:00", tz: "Asia/Tokyo", keep: BACKUP_KEEP, targetId: null as string | null, lastRunAt: null as Date | null };
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const NAME = /^craftshelf-v03-\d{8}-\d{6}\.tar\.gz$/;
const PENDING = "restore-pending.tar.gz";
const REIMPORT = "reimport-pending"; // 置いておくと、次の起動で v02 から取り込み直す
const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
// 名前の日時(UTC)
const atOf = (name: string) => {
  const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
};

type Dumpable = { dumpDataDir?: (c: "gzip") => Promise<Blob> };

/** CraftShelf v03 のバックアップか(中に db.tar.gz があるか)を確かめる。違えば file を消して 400 */
async function checkArchive(v03: string, file: string) {
  try {
    const { stdout } = await run("tar", ["-tzf", file.replace(v03, ".").replace(/\\/g, "/")], { cwd: v03, maxBuffer: 64 * 1024 * 1024 });
    if (!stdout.split(/\r?\n/).some((l) => l.replace(/^\.\//, "") === "db.tar.gz")) throw new HttpError(400, "CraftShelf v03 のバックアップではありません(db.tar.gz がありません)");
  } catch (e) {
    rmSync(file, { force: true });
    if (isHttpError(e)) throw e;
    throw new HttpError(400, "バックアップのファイルとして読めません");
  }
}

export function backupService(deps: Deps) {
  const { db } = deps;
  const { record } = eventService(deps);
  const jobs = jobService(deps);
  const { storeOf } = fileStore(deps);
  const v03Dir = () => {
    if (!deps.local) throw new HttpError(400, "バックアップは、自分用の版だけで使えます");
    return join(deps.local.dataDir, "v03");
  };
  const backupsDir = () => join(v03Dir(), "backups");
  const admin = (headers: Headers) => requireTeam(deps.auth, headers, { member: ["update"] });
  const checkName = (name: string) => {
    if (!NAME.test(name)) throw new HttpError(400, "バックアップの名前が正しくありません");
    return name;
  };
  const listOf = () => (existsSync(backupsDir()) ? readdirSync(backupsDir()) : []).filter((n) => NAME.test(n)).sort().reverse()
    .map((name) => { const s = statSync(join(backupsDir(), name)); return { name, size: s.size, at: s.mtime.toISOString() }; });
  const scheduleOf = async (teamId: string) => (await db.select().from(backupSchedule).where(eq(backupSchedule.teamId, teamId)))[0] ?? { ...DEFAULT, teamId };
  // 保存先にあるもの(新しい順)
  const storedOf = async (teamId: string, targetId: string) =>
    (await fromStorage(async () => (await storeOf(teamId, targetId)).list(DIR))).filter((n) => NAME.test(n)).sort().reverse();

  /** 読む: パネルの中にあればそれ、無ければ置き場所の保存先から */
  async function openOf(teamId: string, name: string): Promise<Readable> {
    const p = join(backupsDir(), checkName(name));
    if (existsSync(p)) return createReadStream(p);
    const s = await scheduleOf(teamId);
    if (!s.targetId) throw new HttpError(404, "バックアップが見つかりません");
    return fromStorage(async () => (await storeOf(teamId, s.targetId)).read(`${DIR}/${name}`));
  }

  /** 作る(手でも予約でも)。置き場所・残す数は定期バックアップの設定のもの。失敗したら記録し、エラーとしても知らせる */
  async function make(teamId: string, userId: string | null) {
    const v03 = v03Dir();
    const client = (deps.db as unknown as { $client?: Dumpable }).$client;
    if (!client?.dumpDataDir) throw new HttpError(400, "このデータベースはここではバックアップできません(PostgreSQL は、そちらのバックアップを使ってください)");
    const s = await scheduleOf(teamId);
    const name = `craftshelf-v03-${stampOf()}.tar.gz`;
    mkdirSync(backupsDir(), { recursive: true });
    const work = mkdtempSync(join(v03, "backup-"));
    let place = "パネルの中";
    const forUpdates = new Set(readUpdateState(v03).history.slice(0, BACKUP_UPDATE_REFS).map((e) => e.backup));
    try {
      writeFileSync(join(work, "db.tar.gz"), Buffer.from(await (await client.dumpDataDir("gzip")).arrayBuffer()));
      if (existsSync(join(v03, "secret"))) copyFileSync(join(v03, "secret"), join(work, "secret"));
      if (existsSync(join(v03, "library"))) cpSync(join(v03, "library"), join(work, "library"), { recursive: true });
      // 相対パスで渡す(Windows の C: を、GNU tar がリモートのホストと読まないように)
      await run("tar", ["-czf", join("..", "backups", name), "."], { cwd: work });
      if (s.targetId) {
        // 保存先に置いて、パネルの中のものは消す(残すのは保存先の新しい keep 個)
        const [t] = await db.select({ name: storageTarget.name }).from(storageTarget).where(eq(storageTarget.id, s.targetId));
        place = `保存先「${t?.name ?? ""}」`;
        const store = await storeOf(teamId, s.targetId);
        await fromStorage(() => store.putFile(`${DIR}/${name}`, join(backupsDir(), name)));
        rmSync(join(backupsDir(), name), { force: true });
        for (const old of (await storedOf(teamId, s.targetId)).filter((n) => !forUpdates.has(n)).slice(s.keep)) await fromStorage(() => store.remove(`${DIR}/${old}`)).catch(() => {});
      } else {
        for (const old of listOf().filter((b) => !forUpdates.has(b.name)).slice(s.keep)) rmSync(join(backupsDir(), old.name), { force: true });
      }
    } catch (e) {
      rmSync(join(backupsDir(), name), { force: true });
      await record({ teamId, userId, kind: "admin", also: ["backup", "errors"], action: "バックアップを作れませんでした", target: place, detail: e instanceof Error ? e.message : String(e) });
      throw isHttpError(e) ? e : new HttpError(500, "バックアップを作れませんでした");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    await record({ teamId, userId, kind: "admin", also: ["backup"], action: "バックアップを作る", target: name, detail: place });
    return { name };
  }

  return {
    /** パネルの中・置き場所の保存先にあるバックアップ(新しい順)・定期バックアップの設定と、次の起動で戻すもの・取り込み直すものがあるか */
    async list(headers: Headers) {
      const { teamId } = await admin(headers);
      const s = await scheduleOf(teamId);
      let stored: { name: string; at: string }[] = [];
      let storageError = "";
      if (s.targetId) {
        try {
          stored = (await storedOf(teamId, s.targetId)).map((name) => ({ name, at: atOf(name) }));
        } catch (e) {
          storageError = e instanceof Error ? e.message : String(e);
        }
      }
      const targets = await db.select({ id: storageTarget.id, name: storageTarget.name }).from(storageTarget).where(eq(storageTarget.teamId, teamId)).orderBy(storageTarget.createdAt);
      return {
        backups: listOf(), stored, storageError, targets,
        schedule: { enabled: s.enabled, time: s.time, tz: s.tz, keep: s.keep, targetId: s.targetId, lastRunAt: s.lastRunAt?.toISOString() ?? null },
        pending: existsSync(join(v03Dir(), PENDING)), reimport: existsSync(join(v03Dir(), REIMPORT)),
        v02: existsSync(join(v02DirOf(deps.local!.dataDir), "index.db")),
      };
    },

    /** 定期バックアップ・置き場所・残す数を決める。tz は画面の時間帯 */
    async setSchedule(headers: Headers, input: { enabled: boolean; time: string; keep: number; targetId: string | null; tz: string }) {
      const who = await admin(headers);
      v03Dir();
      if (!TIME.test(input.time)) throw new HttpError(400, "時刻は 04:00 のように入力してください");
      if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > BACKUP_KEEP_MAX) throw new HttpError(400, `残す数は 1〜${BACKUP_KEEP_MAX} にしてください`);
      try {
        localParts(new Date(), input.tz);
      } catch {
        throw new HttpError(400, "時間帯が正しくありません");
      }
      let place = "パネルの中";
      if (input.targetId) {
        const [t] = await db.select().from(storageTarget).where(and(eq(storageTarget.id, input.targetId), eq(storageTarget.teamId, who.teamId)));
        if (!t) throw new HttpError(404, "保存先が見つかりません");
        place = `保存先「${t.name}」`;
      }
      const values = { teamId: who.teamId, enabled: input.enabled, time: input.time, keep: input.keep, targetId: input.targetId || null, tz: input.tz, updatedAt: new Date() };
      await db.insert(backupSchedule).values(values).onConflictDoUpdate({ target: backupSchedule.teamId, set: values });
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: input.enabled ? "定期バックアップを設定" : "定期バックアップを止める",
        detail: `${input.enabled ? `毎日 ${input.time}・` : ""}${place}・${input.keep} 個残す` });
    },

    /** 1 分ごとに呼ぶ。時刻になったら定期バックアップを作る(自分用の版だけ) */
    async tick(now: Date) {
      if (!deps.local) return 0;
      let made = 0;
      for (const s of await db.select().from(backupSchedule).where(eq(backupSchedule.enabled, true))) {
        let local;
        try {
          local = localParts(now, s.tz);
        } catch {
          continue;
        }
        if (local.time !== s.time) continue;
        const claimed = await db.update(backupSchedule).set({ lastRunAt: now })
          .where(and(eq(backupSchedule.teamId, s.teamId), or(isNull(backupSchedule.lastRunAt), lt(backupSchedule.lastRunAt, new Date(now.getTime() - 90_000)))))
          .returning({ teamId: backupSchedule.teamId });
        if (!claimed.length) continue;
        try {
          await jobs.track({ teamId: s.teamId, userId: null, action: "バックアップを作る" }, () => make(s.teamId, null), (r) => r.name);
          made++;
        } catch (e) {
          console.error("[定期バックアップ] 作れませんでした:", e instanceof Error ? e.message : e);
        }
      }
      return made;
    },

    /**
     * 次の起動で、v02 のデータを取り込み直す(再起動は呼ぶ側で)。v03 の今のデータは before-reimport-… に移して残す。
     * v03 を試したあと v02 に戻って使い続け、もう一度 v03 に移るときに使う
     */
    async reimport(headers: Headers) {
      const who = await admin(headers);
      if (!existsSync(join(v02DirOf(deps.local!.dataDir), "index.db"))) throw new HttpError(404, "v02 のデータが見つかりません");
      writeFileSync(join(v03Dir(), REIMPORT), new Date().toISOString());
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "v02 から取り込み直す" });
    },

    /** 今のデータのバックアップを作る(置き場所・残す数は定期バックアップの設定のもの) */
    async create(headers: Headers) {
      const who = await admin(headers);
      return jobs.track({ teamId: who.teamId, userId: who.user.id, action: "バックアップを作る" }, () => make(who.teamId, who.user.id), (r) => r.name);
    },

    /** ダウンロードする中身(パネルの中か、置き場所の保存先) */
    async open(headers: Headers, name: string) {
      const { teamId } = await admin(headers);
      return openOf(teamId, name);
    },

    /** バックアップから戻す(パネルの中か、置き場所の保存先のもの。次の起動で入れ替える。再起動は呼ぶ側で) */
    async restore(headers: Headers, name: string) {
      const who = await admin(headers);
      await this.restoreFor(who.teamId, who.user.id, name);
    },

    /** 戻す(中から呼ぶ。権限は呼ぶ側で確かめる) */
    async restoreFor(teamId: string, userId: string | null, name: string) {
      const pending = join(v03Dir(), PENDING);
      try {
        await pipeline(await openOf(teamId, name), createWriteStream(pending));
      } catch (e) {
        rmSync(pending, { force: true });
        throw e;
      }
      await checkArchive(v03Dir(), pending);
      await record({ teamId, userId, kind: "admin", action: "バックアップから戻す", target: name });
    },

    /** このデータベースをバックアップできるか(PGlite だけ) */
    supported: () => !!(deps.db as unknown as { $client?: Dumpable }).$client?.dumpDataDir,

    /** 作る(中から呼ぶ。権限は呼ぶ側で確かめる。パネルの更新の前など) */
    makeFor: (teamId: string, userId: string | null) => make(teamId, userId),

    /** 次の起動で戻すのをやめる(中から呼ぶ) */
    cancelRestore: () => rmSync(join(v03Dir(), PENDING), { force: true }),

    /** 手元のバックアップのファイルから戻す(中身を確かめてから置く。再起動は呼ぶ側で) */
    async restoreUpload(headers: Headers, data: Uint8Array) {
      const who = await admin(headers);
      if (data.byteLength > BACKUP_MAX_BYTES) throw new HttpError(400, "ファイルが大きすぎます");
      const v03 = v03Dir();
      const tmp = join(v03, `upload-${stampOf()}.tar.gz`);
      writeFileSync(tmp, data);
      await checkArchive(v03, tmp);
      renameSync(tmp, join(v03, PENDING));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "バックアップから戻す", target: "手元のファイル" });
    },

    /** 次の起動で戻す・取り込み直すのをやめる */
    async cancel(headers: Headers) {
      await admin(headers);
      rmSync(join(v03Dir(), PENDING), { force: true });
      rmSync(join(v03Dir(), REIMPORT), { force: true });
    },
  };
}

/**
 * 起動のはじめに、置いてあるバックアップで入れ替える(データベースを開く前・鍵を読む前)。
 * 今のデータは before-restore-<日時> に移して残す。失敗したら元に戻し、置いたものは restore-failed-… に名前を変える
 */
export async function applyPendingRestore(v03Dir: string, databaseUrl: string): Promise<string | null> {
  const pending = join(v03Dir, PENDING);
  if (!existsSync(pending) || !databaseUrl.startsWith("pglite:")) return null;
  const pgDir = databaseUrl.slice("pglite:".length);
  const stamp = stampOf();
  const aside = join(v03Dir, `before-restore-${stamp}`);
  const work = mkdtempSync(join(v03Dir, "restore-"));
  const moved: [string, string][] = [];
  let replacing = false; // 今のデータベースを退避して、新しく作り始めたか(失敗したとき消してよいのは、そのあとだけ)
  const move = (from: string, to: string) => {
    if (!existsSync(from)) return;
    mkdirSync(aside, { recursive: true });
    renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    await run("tar", ["-xzf", join("..", PENDING)], { cwd: work });
    if (!existsSync(join(work, "db.tar.gz"))) throw new Error("バックアップの中身が足りません(db.tar.gz がありません)");
    move(pgDir, join(aside, "pg"));
    replacing = true;
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite(pgDir, { loadDataDir: new Blob([readFileSync(join(work, "db.tar.gz"))]) });
    await pg.waitReady;
    await pg.close();
    if (existsSync(join(work, "secret"))) {
      if (existsSync(join(v03Dir, "secret"))) { mkdirSync(aside, { recursive: true }); copyFileSync(join(v03Dir, "secret"), join(aside, "secret")); }
      copyFileSync(join(work, "secret"), join(v03Dir, "secret"));
    }
    if (existsSync(join(work, "library"))) {
      move(join(v03Dir, "library"), join(aside, "library"));
      renameSync(join(work, "library"), join(v03Dir, "library"));
    }
    rmSync(pending, { force: true });
    return aside;
  } catch (e) {
    if (replacing) rmSync(pgDir, { recursive: true, force: true });
    for (const [from, to] of moved.reverse()) if (existsSync(to)) renameSync(to, from);
    if (existsSync(join(aside, "secret"))) copyFileSync(join(aside, "secret"), join(v03Dir, "secret"));
    renameSync(pending, join(v03Dir, `restore-failed-${stamp}.tar.gz`));
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 起動のはじめに、取り込み直す用意をする(データベースを開く前)。v03 のデータ・取り込みの結果・パネルの中のアドオンを
 * before-reimport-<日時> に移すので、そのあとの起動はデータベースが空になり、いつもどおり v02 から取り込む
 */
export function applyPendingReimport(v03Dir: string, databaseUrl: string): string | null {
  const marker = join(v03Dir, REIMPORT);
  if (!existsSync(marker) || !databaseUrl.startsWith("pglite:")) return null;
  const aside = join(v03Dir, `before-reimport-${stampOf()}`);
  mkdirSync(aside, { recursive: true });
  const pgDir = databaseUrl.slice("pglite:".length);
  for (const [from, name] of [[pgDir, "pg"], [join(v03Dir, "import-v02.json"), "import-v02.json"], [join(v03Dir, "import-v02-library.json"), "import-v02-library.json"], [join(v03Dir, "library"), "library"]]) {
    if (existsSync(from)) renameSync(from, join(aside, name));
  }
  rmSync(marker, { force: true });
  return aside;
}
