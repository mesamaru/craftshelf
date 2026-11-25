// 処理の一覧(v02 の 01.22「処理」): 時間のかかる処理(サーバーへの導入・そろえる・バックアップなど)を、待ち・実行中・成功・失敗で残す。
// 処理そのものは今までどおり各サービスで動かし、ここは前後に状態を書くだけ(書けなくても処理は止めない)
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { job, server, user } from "./db/schema";
import { requireTeam } from "./guard";
import { type Deps, serverScope } from "./servers";

export const JOB_LIMITS = { keepDays: 30, list: 200 };
export type JobState = "queued" | "running" | "done" | "failed";
export type JobInfo = { teamId: string; userId: string | null; serverId?: string | null; action: string; target?: string };

const short = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s);
const quiet = (p: Promise<unknown>) => p.catch((e) => console.error("[処理の一覧] 書けませんでした:", e));

// 動いている処理の途中経過を書く先(track・queue の中で動いている処理だけ。外では何もしない)
const current = new AsyncLocalStorage<(done: number, total: number | null, note: string) => void>();
/** 途中経過を知らせる(done / total 個目と、いまの中身。total が分からなければ null)。処理の中のどこからでも呼べる */
export const progress = (done: number, total: number | null, note = "") => current.getStore()?.(done, total, note);
const PROGRESS_EVERY_MS = 1000; // 書くのは 1 秒に 1 回まで(最後の 1 つは必ず書く)

export function jobService(deps: Deps) {
  const { db, auth } = deps;

  async function add(info: JobInfo, state: JobState) {
    const id = randomUUID();
    const now = new Date();
    await quiet(db.insert(job).values({ id, teamId: info.teamId, serverId: info.serverId ?? null, userId: info.userId, action: info.action,
      target: info.target ?? "", state, startedAt: state === "running" ? now : null }));
    // 古いものを片付ける(終わってから keepDays 日)
    await quiet(db.delete(job).where(and(eq(job.teamId, info.teamId), lt(job.finishedAt, new Date(now.getTime() - JOB_LIMITS.keepDays * 86400_000)))));
    return id;
  }
  const set = (id: string, values: Partial<typeof job.$inferInsert>) => quiet(db.update(job).set(values).where(eq(job.id, id)));

  /** id の処理を動かす(待ちから実行中へ)。結果を書き、失敗はそのまま投げ直す。keep が false を返した成功は、一覧から消す */
  async function runAs<T>(id: string, fn: () => Promise<T>, detail?: (r: T) => string, keep?: (r: T) => boolean): Promise<T> {
    await set(id, { state: "running", startedAt: new Date() });
    let last = 0;
    let writing: Promise<unknown> = Promise.resolve();
    const report = (done: number, total: number | null, note: string) => {
      const now = Date.now();
      if (now - last < PROGRESS_EVERY_MS && done !== total) return;
      last = now;
      writing = writing.then(() => set(id, { progressDone: done, progressTotal: total, progressNote: note.slice(0, 200) }));
    };
    try {
      const r = await current.run(report, fn);
      await writing; // 途中経過の書き込みが、終わったあとの状態を上書きしないように
      if (keep && !keep(r)) await quiet(db.delete(job).where(eq(job.id, id)));
      else await set(id, { state: "done", finishedAt: new Date(), detail: short(detail?.(r) ?? "") });
      return r;
    } catch (e) {
      await writing;
      await set(id, { state: "failed", finishedAt: new Date(), detail: short(e instanceof Error ? e.message : String(e)) });
      throw e;
    }
  }

  return {
    /** 待ち・実行中の処理があるか(あるあいだは、再起動する操作=版の切り替え・復元・取り込み直しをしない) */
    async busy() {
      return (await db.select({ id: job.id }).from(job).where(inArray(job.state, ["queued", "running"])).limit(1)).length > 0;
    },

    /** 処理を記録しながら動かす(detail は成功したときの結果のまとめ。keep が false を返したら、終わったあと一覧から消す) */
    async track<T>(info: JobInfo, fn: () => Promise<T>, detail?: (r: T) => string, keep?: (r: T) => boolean): Promise<T> {
      return runAs(await add(info, "running"), fn, detail, keep);
    },

    /** まとめて動かすものを、先に「待ち」として並べる。返す関数で 1 つずつ動かす */
    async queue(list: JobInfo[]) {
      const ids: string[] = [];
      for (const info of list) ids.push(await add(info, "queued"));
      return {
        run: <T>(i: number, fn: () => Promise<T>, detail?: (r: T) => string) => runAs(ids[i], fn, detail),
        /** i より後ろを動かさずに終える(途中で思わぬエラーになったとき。待ちのまま残さない) */
        skipRest: async (i: number) => {
          if (ids.length > i + 1) await quiet(db.update(job).set({ state: "failed", finishedAt: new Date(), detail: "前の処理が止まったため、動かしませんでした" }).where(inArray(job.id, ids.slice(i + 1))));
        },
      };
    },

    /** チームの処理(新しい順)。メンバー全員が見られる。サーバーを割り当てられている人は、そのサーバーのもの・自分の操作だけ */
    async list(headers: Headers) {
      const who = await requireTeam(auth, headers);
      const rows = await db.select({ id: job.id, serverId: job.serverId, userId: job.userId, action: job.action, target: job.target, state: job.state, detail: job.detail,
        createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
        progressDone: job.progressDone, progressTotal: job.progressTotal, progressNote: job.progressNote, serverName: server.name, userName: user.name })
        .from(job).leftJoin(server, eq(job.serverId, server.id)).leftJoin(user, eq(job.userId, user.id))
        .where(eq(job.teamId, who.teamId)).orderBy(desc(job.createdAt)).limit(JOB_LIMITS.list);
      const scope = await serverScope(deps, who);
      const iso = (d: Date | null) => (d ? d.toISOString() : null);
      return rows
        .filter((r) => !scope || r.userId === who.user.id || (r.serverId && scope.has(r.serverId)))
        .map(({ userId: _, ...r }) => ({ ...r, serverName: r.serverName ?? "", userName: r.userName ?? "", state: r.state as JobState,
          createdAt: r.createdAt.toISOString(), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) }));
    },

    /** 起動したとき(リクエストを受ける前)に呼ぶ: 前の起動で待ち・実行中のまま残ったものを「中断」にする */
    async recover() {
      await db.update(job).set({ state: "failed", finishedAt: new Date(), detail: "パネルが再起動したため、途中で止まりました" })
        .where(inArray(job.state, ["queued", "running"]));
    },
  };
}

export type JobService = ReturnType<typeof jobService>;
