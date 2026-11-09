// ワールドのバックアップ(v02 の 01.17)。手で作る・予約(毎日・毎週)・残す数・一覧・ダウンロード・削除。
// Pterodactyl はパネルのバックアップ(Client API。サーバー全体)を使う。フォルダのサーバー・エージェントは(自分用の版だけ)、
// ワールドのフォルダ(server.properties の level-name と _nether・_the_end)をファイルごとに読んで tar.gz にまとめ、保存先かパネルの中に置く
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { server, storageTarget, worldBackup } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import type { PteroBackups, PteroClient } from "./ptero";
import { localParts } from "./schedule";
import { type Deps, remote, serverOf } from "./servers";
import { tarGz, untarGz } from "./tar";
import { type Ping, gamePort, ping } from "./mcping";
import { fileStore, fromStorage } from "./uploads";
import { jobService } from "./jobs";

export const WORLD_LIMITS = { keepMax: 30, fileBytes: 100 * 1024 * 1024, files: 200_000, depth: 32, stopWaitMs: 120_000 };
const ASIDE = ".craftshelf-before-restore-"; // 戻す前のワールドを退避するときの名前の後ろ
export const WORLD_DIR = "_craftshelf_worlds"; // 保存先の中の場所(v02 と同じ)
export const WORLD_NAME = /^[A-Za-z0-9_.-]{1,60}-\d{8}-\d{6}\.tar\.gz$/;
const MODES = ["off", "daily", "weekly"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PREFIX = "CraftShelf "; // Pterodactyl のバックアップのうち、このアプリが作ったもの(古いものを消すのはこれだけ)
const DEFAULT = { mode: "off", time: "05:00", dow: 0, tz: "Asia/Tokyo", keep: 5, targetId: null as string | null, lastRunAt: null as Date | null };
const stampOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
// 名前の日時(UTC)
const atOf = (name: string) => {
  const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backupsOf = (client: PteroClient) => (client as unknown as { backups: PteroBackups }).backups;

export type WorldBackupItem = { name: string; label: string; size: number | null; at: string; done: boolean; ok: boolean; locked: boolean };

export function worldService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const { storeOf } = fileStore(deps);
  const jobs = jobService(deps);
  const running = new Set<string>();
  const last = new Map<string, { ok: boolean; message: string; at: string }>(); // 最後に作った結果(画面に出す。このプロセスの中だけ)

  const settingsOf = async (serverId: string) => (await db.select().from(worldBackup).where(eq(worldBackup.serverId, serverId)))[0] ?? { ...DEFAULT, serverId };
  const v03 = () => join(deps.local!.dataDir, "v03");
  const panelDir = (serverId: string) => join(v03(), "worlds", serverId);
  const keyOf = (serverId: string, name = "") => [WORLD_DIR, serverId, name].filter(Boolean).join("/");
  const needFiles = () => {
    if (!deps.local) throw new HttpError(400, "フォルダのサーバー・エージェントのワールドのバックアップは、自分用の版だけで使えます");
  };
  const checkName = (name: string) => {
    if (!WORLD_NAME.test(name)) throw new HttpError(400, "バックアップの名前が正しくありません");
    return name;
  };

  /** 置き場所にあるバックアップの名前(新しい順) */
  async function names(teamId: string, serverId: string, targetId: string | null) {
    const list = targetId
      ? await fromStorage(async () => (await storeOf(teamId, targetId)).list(keyOf(serverId)))
      : existsSync(panelDir(serverId)) ? readdirSync(panelDir(serverId)) : [];
    return list.filter((n) => WORLD_NAME.test(n)).sort().reverse();
  }

  /** ワールドのフォルダを読んで tar.gz にする(1 ファイルずつ読むので、メモリは大きいファイル 1 つぶんまで) */
  async function archive(client: PteroClient, remoteId: string, out: string) {
    const props = await client.readFile(remoteId, "server.properties").catch(() => null);
    const level = props?.match(/^\s*level-name\s*=\s*(.*?)\s*$/m)?.[1].replace(/\\/g, "/") ?? "";
    const world = level && !level.startsWith("/") && !level.split("/").includes("..") ? level : "world";
    const dirs: string[] = [];
    for (const d of [world, `${world}_nether`, `${world}_the_end`]) if ((await client.listFiles(remoteId, d)).length) dirs.push(d);
    if (!dirs.length) throw new HttpError(404, `ワールドのフォルダ(${world})が見つかりません`);
    const tar = tarGz(out);
    const skipped: string[] = [];
    let files = 0;
    const walk = async (dir: string, depth: number) => {
      for (const f of await client.listFiles(remoteId, dir)) {
        const rel = `${dir}/${f.name}`;
        if (!f.isFile) {
          if (depth < WORLD_LIMITS.depth) await walk(rel, depth + 1);
          continue;
        }
        if (f.name === "session.lock") continue; // 動いているサーバーが握っているので飛ばす(v02 と同じ)
        if (f.size > WORLD_LIMITS.fileBytes) {
          skipped.push(rel);
          continue;
        }
        if (++files > WORLD_LIMITS.files) throw new HttpError(400, `ワールドのファイルが多すぎます(${WORLD_LIMITS.files} 個まで)`);
        let data: Uint8Array;
        try {
          data = await client.readBytes(remoteId, rel, WORLD_LIMITS.fileBytes);
        } catch {
          skipped.push(rel); // 書き込み中などで読めないものは飛ばす(v02 と同じ)
          continue;
        }
        await tar.add(rel, data, Date.parse(f.modifiedAt) / 1000 || undefined);
      }
    };
    try {
      for (const d of dirs) await walk(d, 0);
      await tar.end();
    } catch (e) {
      tar.abort();
      throw e;
    }
    return { world, dirs, skipped };
  }

  /** バックアップを作る(手でも予約でも)。結果は操作の記録に残し、失敗はエラーとしても知らせる */
  async function run(teamId: string, serverId: string, userId: string | null) {
    if (running.has(serverId)) throw new HttpError(409, "このサーバーのワールドは、いまバックアップしています");
    running.add(serverId); // 記録を書くあいだに 2 回目が始まらないよう、先に印を付ける(外すのは make の最後)
    return jobs.track({ teamId, userId, serverId, action: "ワールドをバックアップ" }, () => make(teamId, serverId, userId), (r) => r.name);
  }

  async function make(teamId: string, serverId: string, userId: string | null) {
    running.add(serverId);
    let name = "";
    try {
      const { row, client, remoteId } = await serverOf(deps, teamId, serverId);
      name = row.name;
      const s = await settingsOf(serverId);
      if (row.kind === "ptero") {
        const b = backupsOf(client);
        const label = `${PREFIX}${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
        await remote(() => b.create(remoteId, label));
        // このアプリが作ったものだけを、新しい keep 個まで残す(作っている途中・鍵をかけたものは消さない)
        const mine = (await remote(() => b.list(remoteId))).filter((x) => x.name.startsWith(PREFIX)).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
        for (const old of mine.slice(s.keep).filter((x) => !x.locked && x.completedAt)) await remote(() => b.remove(remoteId, old.uuid)).catch(() => {});
        await record({ teamId, userId, kind: "backup", action: "ワールドをバックアップ", target: row.name, detail: `${label}(Pterodactyl のバックアップ。サーバー全体。できあがりはパネルで確かめてください)` });
        last.set(serverId, { ok: true, message: label, at: new Date().toISOString() });
        return { name: label };
      }
      needFiles();
      mkdirSync(join(v03(), "tmp"), { recursive: true });
      const tmp = join(v03(), "tmp", `world-${randomUUID()}.part`);
      try {
        // 書き込みを止めてから読む(壊れたバックアップにならないように。RCON・コンソールが使えなければそのまま)
        let paused = false;
        try {
          await client.command(remoteId, "save-off");
          paused = true;
          await client.command(remoteId, "save-all flush");
          await sleep(3000);
        } catch { /* 動いていない・RCON が無い */ }
        let made;
        try {
          made = await remote(() => archive(client, remoteId, tmp));
        } finally {
          if (paused) await client.command(remoteId, "save-on").catch(() => {});
        }
        const file = `${made.world.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "world"}-${stampOf()}.tar.gz`;
        const size = statSync(tmp).size;
        if (s.targetId) {
          const store = await storeOf(teamId, s.targetId);
          await fromStorage(() => store.putFile(keyOf(serverId, file), tmp));
          for (const old of (await names(teamId, serverId, s.targetId)).slice(s.keep)) await fromStorage(() => store.remove(keyOf(serverId, old))).catch(() => {});
        } else {
          mkdirSync(panelDir(serverId), { recursive: true });
          renameSync(tmp, join(panelDir(serverId), file));
          for (const old of (await names(teamId, serverId, null)).slice(s.keep)) rmSync(join(panelDir(serverId), old), { force: true });
        }
        const note = made.skipped.length ? `\n読めなかった・大きすぎて飛ばしたファイル ${made.skipped.length} 個: ${made.skipped.slice(0, 10).join("、")}` : "";
        last.set(serverId, { ok: true, message: file, at: new Date().toISOString() });
        await record({ teamId, userId, kind: "backup", action: "ワールドをバックアップ", target: row.name, detail: `${file}(${Math.max(1, Math.round(size / 1024 / 1024))} MB・${made.dirs.join("・")})${note}` });
        return { name: file };
      } finally {
        rmSync(tmp, { force: true });
      }
    } catch (e) {
      last.set(serverId, { ok: false, message: e instanceof Error ? e.message : String(e), at: new Date().toISOString() });
      await record({ teamId, userId, kind: "backup", also: ["errors"], action: "ワールドをバックアップできませんでした", target: name, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      running.delete(serverId);
    }
  }

  /**
   * バックアップから戻す(管理者以上・危ない操作なので画面では 2 回確かめる)。Pterodactyl はパネルの復元(truncate なら今のファイルを消してから)。
   * フォルダのサーバー・エージェントは、サーバーが止まっていることを確かめ(stop なら止めて待つ)、今のワールドのフォルダを名前を変えて残してから展開する。
   * 途中で失敗したら、展開したものを消して、残したフォルダを元の名前に戻す
   */
  async function restoreOf(headers: Headers, id: string, name: string, input: { stop?: boolean; truncate?: boolean } = {}) {
    const who = await requireTeam(auth, headers, { server: ["update"] });
    const { row, client, remoteId } = await serverOf(deps, who, id);
    if (running.has(row.id)) throw new HttpError(409, "このサーバーのワールドは、いまバックアップか復元をしています");
    if (row.kind === "ptero") {
      await remote(() => backupsOf(client).restore(remoteId, name, !!input.truncate));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "backup", action: "ワールドをバックアップから戻す", target: row.name,
        detail: `${name}(Pterodactyl のバックアップ${input.truncate ? "。今のファイルを消してから" : ""})` });
      return { aside: [] as string[], files: 0 };
    }
    needFiles();
    checkName(name);
    const s = await settingsOf(row.id);
    if (!s.targetId && !existsSync(join(panelDir(row.id), name))) throw new HttpError(404, "バックアップが見つかりません");
    running.add(row.id);
    const aside: [string, string][] = []; // [元の名前, 残した名前]
    const made = new Set<string>();
    try {
      // 動いているかわからないとき(RCON・Docker が無い)は、Minecraft の問い合わせに答えるかで決める
      const stateOf = async () => {
        const st = (await remote(() => client.resources(remoteId))).state;
        if (st !== "unknown") return st;
        const p = row.kind === "agent" ? (client as unknown as { ping: () => Promise<Ping> }).ping() : ping("127.0.0.1", gamePort(await client.readFile(remoteId, "server.properties").catch(() => null)));
        return (await p.then(() => true, () => false)) ? "running" : "unknown";
      };
      let state = await stateOf();
      if (state !== "offline" && state !== "unknown") {
        if (!input.stop) throw new HttpError(409, "サーバーが動いています。止めてから戻してください(「動いていたら止める」を選ぶと、止めてから戻します)");
        await remote(() => client.power(remoteId, "stop"));
        for (const until = Date.now() + WORLD_LIMITS.stopWaitMs; state !== "offline" && state !== "unknown" && Date.now() < until;) {
          await sleep(3000);
          state = await stateOf();
        }
        if (state !== "offline" && state !== "unknown") throw new HttpError(409, "サーバーが止まりませんでした。止めてからやり直してください");
      }
      const stream = s.targetId ? await fromStorage(async () => (await storeOf(who.teamId, s.targetId)).read(keyOf(row.id, name))) : createReadStream(join(panelDir(row.id), name));
      const present = new Set((await remote(() => client.listFiles(remoteId, "/"))).map((f) => f.name));
      const stamp = stampOf();
      let allowed: string[] = [];
      let files = 0;
      try {
        for await (const f of untarGz(stream, WORLD_LIMITS.fileBytes)) {
          const parts = f.name.split("/");
          const top = parts[0];
          // 入れてよいのは、1 つのワールド(とその _nether・_the_end)のフォルダの中だけ
          if (!allowed.length) {
            const base = top.replace(/_(nether|the_end)$/, "");
            allowed = [base, `${base}_nether`, `${base}_the_end`];
          }
          if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,59}$/.test(top) || !allowed.includes(top) || parts.length < 2 || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) {
            throw new HttpError(400, `ワールドの外のファイルが入っています(${f.name.slice(0, 100)})`);
          }
          if (!made.has(top)) {
            if (present.has(top)) {
              let to = `${top}${ASIDE}${stamp}`;
              for (let n = 2; present.has(to); n++) to = `${top}${ASIDE}${stamp}-${n}`;
              await remote(() => client.rename(remoteId, "/", top, to));
              aside.push([top, to]);
            }
            made.add(top);
          }
          if (++files > WORLD_LIMITS.files) throw new HttpError(400, `ワールドのファイルが多すぎます(${WORLD_LIMITS.files} 個まで)`);
          await remote(() => client.upload(remoteId, parts.slice(0, -1).join("/"), parts[parts.length - 1], f.data));
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      if (!files) throw new HttpError(400, "バックアップにファイルがありません");
      await record({ teamId: who.teamId, userId: who.user.id, kind: "backup", action: "ワールドをバックアップから戻す", target: row.name,
        detail: `${name}(${files} ファイル${aside.length ? `。前のワールドは ${aside.map((a) => a[1]).join("・")} に残しました` : ""})` });
      return { aside: aside.map((a) => a[1]), files };
    } catch (e) {
      // 展開したものを消して、残したフォルダを元に戻す
      if (made.size) await client.deleteFiles(remoteId, "/", [...made]).catch(() => {});
      for (const [from, to] of aside) await client.rename(remoteId, "/", to, from).catch(() => {});
      await record({ teamId: who.teamId, userId: who.user.id, kind: "backup", also: ["errors"], action: "ワールドを戻せませんでした", target: row.name, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      running.delete(row.id);
    }
  }

  return {
    /** 設定と、置き場所にあるバックアップ(新しい順)。見る・作る・消すのは編集者以上(割り当てたサーバーだけ) */
    async get(headers: Headers, id: string) {
      const who = await requireTeam(auth, headers, { server: ["control"] });
      const { row, client, remoteId } = await serverOf(deps, who, id);
      const s = await settingsOf(row.id);
      const ptero = row.kind === "ptero";
      const available = ptero || !!deps.local;
      const targets = !ptero && deps.local ? await db.select({ id: storageTarget.id, name: storageTarget.name }).from(storageTarget).where(eq(storageTarget.teamId, who.teamId)).orderBy(storageTarget.createdAt) : [];
      let backups: WorldBackupItem[] = [];
      let error = "";
      try {
        if (ptero) {
          backups = (await remote(() => backupsOf(client).list(remoteId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((b) => ({ name: b.uuid, label: b.name, size: b.bytes || null, at: b.createdAt, done: !!b.completedAt, ok: b.successful, locked: b.locked }));
        } else if (available) {
          backups = (await names(who.teamId, row.id, s.targetId)).map((n) => ({
            name: n, label: n, size: s.targetId ? null : statSync(join(panelDir(row.id), n)).size, at: atOf(n), done: true, ok: true, locked: false,
          }));
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return {
        kind: ptero ? "ptero" as const : "files" as const, available, running: running.has(row.id), last: last.get(row.id) ?? null, error, backups, targets,
        settings: { mode: s.mode, time: s.time, dow: s.dow, tz: s.tz, keep: s.keep, targetId: s.targetId, lastRunAt: s.lastRunAt?.toISOString() ?? null },
      };
    },

    /** 予約・残す数・置き場所を決める(管理者以上)。tz は画面の時間帯 */
    async setSettings(headers: Headers, id: string, input: { mode: string; time: string; dow: number; keep: number; targetId: string | null; tz: string }) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, who, id);
      if (row.kind !== "ptero") needFiles();
      if (!(MODES as readonly string[]).includes(input.mode)) throw new HttpError(400, "予約の種類を選んでください");
      if (!TIME.test(input.time)) throw new HttpError(400, "時刻は 05:00 のように入力してください");
      if (!Number.isInteger(input.dow) || input.dow < 0 || input.dow > 6) throw new HttpError(400, "曜日を選んでください");
      if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > WORLD_LIMITS.keepMax) throw new HttpError(400, `残す数は 1〜${WORLD_LIMITS.keepMax} にしてください`);
      try {
        localParts(new Date(), input.tz);
      } catch {
        throw new HttpError(400, "時間帯が正しくありません");
      }
      let targetId: string | null = null;
      if (input.targetId && row.kind !== "ptero") {
        const [t] = await db.select({ id: storageTarget.id }).from(storageTarget).where(and(eq(storageTarget.id, input.targetId), eq(storageTarget.teamId, who.teamId)));
        if (!t) throw new HttpError(404, "保存先が見つかりません");
        targetId = t.id;
      }
      const values = { serverId: row.id, mode: input.mode, time: input.time, dow: input.dow, keep: input.keep, targetId, tz: input.tz, updatedAt: new Date() };
      await db.insert(worldBackup).values(values).onConflictDoUpdate({ target: worldBackup.serverId, set: values });
      const days = "日月火水木金土";
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "ワールドのバックアップの設定", target: row.name,
        detail: `${input.mode === "off" ? "予約なし" : input.mode === "daily" ? `毎日 ${input.time}` : `毎週${days[input.dow]}曜 ${input.time}`}・${input.keep} 個残す` });
    },

    /** 手で作る。wait が false なら、始めたらすぐ返す(大きいワールドは時間がかかるため。終わると一覧と操作の記録に出る) */
    async create(headers: Headers, id: string, wait = false) {
      const who = await requireTeam(auth, headers, { server: ["control"] });
      const { row } = await serverOf(deps, who, id);
      if (row.kind !== "ptero") needFiles();
      if (running.has(row.id)) throw new HttpError(409, "このサーバーのワールドは、いまバックアップしています");
      const p = run(who.teamId, row.id, who.user.id);
      if (wait) return p;
      p.catch(() => {}); // 失敗は操作の記録とお知らせで知らせる
      return { name: "" };
    },

    /** ダウンロード: Pterodactyl は Wings の URL、ほかはファイルの中身 */
    async open(headers: Headers, id: string, name: string): Promise<{ url: string } | { stream: Readable; size: number | null }> {
      const who = await requireTeam(auth, headers, { server: ["control"] });
      const { row, client, remoteId } = await serverOf(deps, who, id);
      if (row.kind === "ptero") return { url: await remote(() => backupsOf(client).url(remoteId, name)) };
      needFiles();
      checkName(name);
      const s = await settingsOf(row.id);
      if (s.targetId) return { stream: await fromStorage(async () => (await storeOf(who.teamId, s.targetId)).read(keyOf(row.id, name))), size: null };
      const p = join(panelDir(row.id), name);
      if (!existsSync(p)) throw new HttpError(404, "バックアップが見つかりません");
      return { stream: createReadStream(p), size: statSync(p).size };
    },

    /** バックアップから戻す(管理者以上)。中身は restoreOf。処理の一覧に残す */
    async restore(headers: Headers, id: string, name: string, input: { stop?: boolean; truncate?: boolean } = {}) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, who, id);
      return jobs.track({ teamId: who.teamId, userId: who.user.id, serverId: row.id, action: "ワールドをバックアップから戻す", target: name },
        () => restoreOf(headers, id, name, input), (r) => (r.files ? `${r.files} ファイル` : ""));
    },

    async remove(headers: Headers, id: string, name: string) {
      const who = await requireTeam(auth, headers, { server: ["control"] });
      const { row, client, remoteId } = await serverOf(deps, who, id);
      if (row.kind === "ptero") {
        await remote(() => backupsOf(client).remove(remoteId, name));
      } else {
        needFiles();
        checkName(name);
        const s = await settingsOf(row.id);
        if (s.targetId) await fromStorage(async () => (await storeOf(who.teamId, s.targetId)).remove(keyOf(row.id, name)));
        else rmSync(join(panelDir(row.id), name), { force: true });
      }
      await record({ teamId: who.teamId, userId: who.user.id, kind: "backup", action: "ワールドのバックアップを消す", target: row.name, detail: name });
    },

    /** 1 分ごとに呼ぶ。時刻になったサーバーのバックアップを始める(wait はテスト用: 終わるまで待つ) */
    async tick(now: Date, wait = false) {
      const started: Promise<unknown>[] = [];
      const rows = await db.select({ w: worldBackup, teamId: server.teamId, kind: server.kind }).from(worldBackup)
        .innerJoin(server, eq(worldBackup.serverId, server.id)).where(ne(worldBackup.mode, "off"));
      for (const { w, teamId, kind } of rows) {
        if (kind !== "ptero" && !deps.local) continue;
        let local;
        try {
          local = localParts(now, w.tz);
        } catch {
          continue;
        }
        if (local.time !== w.time || (w.mode === "weekly" && local.day !== w.dow)) continue;
        // 同じ分に 2 回動かさない
        const claimed = await db.update(worldBackup).set({ lastRunAt: now })
          .where(and(eq(worldBackup.serverId, w.serverId), or(isNull(worldBackup.lastRunAt), lt(worldBackup.lastRunAt, new Date(now.getTime() - 90_000)))))
          .returning({ id: worldBackup.serverId });
        if (!claimed.length || running.has(w.serverId)) continue;
        started.push(run(teamId, w.serverId, null).catch((e) => console.error("[ワールドのバックアップ] 作れませんでした:", e instanceof Error ? e.message : e)));
      }
      if (wait) await Promise.all(started);
      return started.length;
    },
  };
}

export type WorldService = ReturnType<typeof worldService>;
