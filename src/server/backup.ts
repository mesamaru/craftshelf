// パネルのバックアップと復元(自分用の版・PGlite だけ。管理者以上)。
// バックアップは 1 つの tar.gz: db.tar.gz(PGlite のデータの書き出し)・secret(保存した API キーなどを解く鍵)・library(パネルの中に置いたアドオン)。
// 戻すときは restore-pending.tar.gz として置いて再起動し、次の起動で入れ替える(今のデータは before-restore-… に移して残す)
import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import type { Deps } from "./servers";

const run = promisify(execFile);
export const BACKUP_KEEP = 5;
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const NAME = /^craftshelf-v03-\d{8}-\d{6}\.tar\.gz$/;
const PENDING = "restore-pending.tar.gz";
const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

type Dumpable = { dumpDataDir?: (c: "gzip") => Promise<Blob> };

export function backupService(deps: Deps) {
  const { record } = eventService(deps);
  const v03Dir = () => {
    if (!deps.local) throw new HttpError(400, "バックアップは、自分用の版だけで使えます");
    return join(deps.local.dataDir, "v03");
  };
  const backupsDir = () => join(v03Dir(), "backups");
  const admin = (headers: Headers) => requireTeam(deps.auth, headers, { member: ["update"] });
  const pathOf = (name: string) => {
    if (!NAME.test(name)) throw new HttpError(400, "バックアップの名前が正しくありません");
    const p = join(backupsDir(), name);
    if (!existsSync(p)) throw new HttpError(404, "バックアップが見つかりません");
    return p;
  };
  const listOf = () => (existsSync(backupsDir()) ? readdirSync(backupsDir()) : []).filter((n) => NAME.test(n)).sort().reverse()
    .map((name) => { const s = statSync(join(backupsDir(), name)); return { name, size: s.size, at: s.mtime.toISOString() }; });

  return {
    /** パネルの中にあるバックアップ(新しい順)と、次の起動で戻すものがあるか */
    async list(headers: Headers) {
      await admin(headers);
      return { backups: listOf(), pending: existsSync(join(v03Dir(), PENDING)) };
    },

    /** 今のデータのバックアップを作る(新しい 5 個を残す) */
    async create(headers: Headers) {
      const who = await admin(headers);
      const v03 = v03Dir();
      const client = (deps.db as unknown as { $client?: Dumpable }).$client;
      if (!client?.dumpDataDir) throw new HttpError(400, "このデータベースはここではバックアップできません(PostgreSQL は、そちらのバックアップを使ってください)");
      const name = `craftshelf-v03-${stampOf()}.tar.gz`;
      mkdirSync(backupsDir(), { recursive: true });
      const work = mkdtempSync(join(v03, "backup-"));
      try {
        writeFileSync(join(work, "db.tar.gz"), Buffer.from(await (await client.dumpDataDir("gzip")).arrayBuffer()));
        if (existsSync(join(v03, "secret"))) copyFileSync(join(v03, "secret"), join(work, "secret"));
        if (existsSync(join(v03, "library"))) cpSync(join(v03, "library"), join(work, "library"), { recursive: true });
        // 相対パスで渡す(Windows の C: を、GNU tar がリモートのホストと読まないように)
        await run("tar", ["-czf", join("..", "backups", name), "."], { cwd: work });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      for (const old of listOf().slice(BACKUP_KEEP)) rmSync(join(backupsDir(), old.name), { force: true });
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "バックアップを作る", target: name });
      return { name };
    },

    /** ダウンロードするファイルの場所 */
    async file(headers: Headers, name: string) {
      await admin(headers);
      return pathOf(name);
    },

    /** パネルの中のバックアップから戻す(次の起動で入れ替える。再起動は呼ぶ側で) */
    async restore(headers: Headers, name: string) {
      const who = await admin(headers);
      copyFileSync(pathOf(name), join(v03Dir(), PENDING));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "バックアップから戻す", target: name });
    },

    /** 手元のバックアップのファイルから戻す(中身を確かめてから置く。再起動は呼ぶ側で) */
    async restoreUpload(headers: Headers, data: Uint8Array) {
      const who = await admin(headers);
      if (data.byteLength > BACKUP_MAX_BYTES) throw new HttpError(400, "ファイルが大きすぎます");
      const v03 = v03Dir();
      const tmp = join(v03, `upload-${stampOf()}.tar.gz`);
      writeFileSync(tmp, data);
      try {
        const { stdout } = await run("tar", ["-tzf", tmp.replace(v03, ".").replace(/\\/g, "/")], { cwd: v03, maxBuffer: 64 * 1024 * 1024 });
        if (!stdout.split(/\r?\n/).some((l) => l.replace(/^\.\//, "") === "db.tar.gz")) throw new HttpError(400, "CraftShelf v03 のバックアップではありません(db.tar.gz がありません)");
      } catch (e) {
        rmSync(tmp, { force: true });
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "バックアップのファイルとして読めません");
      }
      renameSync(tmp, join(v03, PENDING));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "バックアップから戻す", target: "手元のファイル" });
    },

    /** 次の起動で戻すのをやめる */
    async cancel(headers: Headers) {
      await admin(headers);
      rmSync(join(v03Dir(), PENDING), { force: true });
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
    rmSync(pgDir, { recursive: true, force: true });
    for (const [from, to] of moved.reverse()) if (existsSync(to)) renameSync(to, from);
    if (existsSync(join(aside, "secret"))) copyFileSync(join(aside, "secret"), join(v03Dir, "secret"));
    renameSync(pending, join(v03Dir, `restore-failed-${stamp}.tar.gz`));
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
