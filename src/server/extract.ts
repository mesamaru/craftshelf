// サーバーの「ファイル」タブの圧縮ファイルの展開(権限・記録・変更の履歴・取り消し)。
// 展開そのものと安全の確かめは extract-safe.ts(フォルダのサーバー・エージェント・Pterodactyl の事前の確かめが同じものを使う)。
// ここでは、権限(ファイルを書く権限 files:edit + そのサーバーへの割り当て)・サーバーごとに 1 つだけ・終わったときの記録を受け持つ。
// 展開を始めるときに、変更の履歴(server_change)に「展開中」の行を先に書く(= サーバーごとの同時 1 つの根拠・サービスが再起動しても結果が失われない根拠)。
// 終わると「展開」(取り消しのための一覧つき)に、失敗・キャンセルは行を消して操作の記録に、起動のとき残っていた「展開中」は「展開中断」(結果不明)にする
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { fmtSize } from "~/lib/format";
import { localServer, server as serverTable, serverChange } from "./db/schema";
import { cleanStale, type JobState, type Manifest, type Mode, cleanEntryName, manifestOf, removeCreated } from "./extract-safe";
import { eventService } from "./events";
import { cleanPath } from "./files";
import { HttpError, requireTeam } from "./guard";
import { checkRoot } from "./local";
import { type Deps, remote, serverOf } from "./servers";

/** 変更の履歴(server_change)の action: 展開中 → 展開(終わった。取り消せる)/ 展開中断(結果不明) */
export const EXTRACT_ACTION = "展開";
export const EXTRACT_RUNNING = "展開中";
export const EXTRACT_ABORTED = "展開中断";
const KEPT = 30; // 終わった展開の記録は、1 台につき新しい 30 件まで
const WATCH_MS = 6 * 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const modeOf = (m: unknown): Mode => (m === "here" ? "here" : "folder");
type Row = typeof serverChange.$inferSelect;
type Slot = { teamId: string; userId: string | null };

export function extractService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  // このプロセスの中で、サーバーごとに 1 つだけ(始めた直後に置くので、同時の 2 回目も止まる)。ほかのプロセスとは DB の「展開中」の行で調整する
  const active = new Map<string, { jobId: string; path: string; done: Promise<void> }>();

  // 展開は、ファイルを書く権限(設定ファイルの編集と同じ files:edit)+ そのサーバーへの割り当て(serverOf)
  const target = async (headers: Headers, serverId: string) => {
    const who = await requireTeam(auth, headers, { files: ["edit"] });
    return { who, t: await serverOf(deps, who, serverId) };
  };
  const friendly = (e: unknown) => {
    if (e instanceof HttpError && /この操作はできません/.test(e.message)) return new HttpError(502, "エージェントが古いので、展開できません。サーバー機のエージェントを新しい版(1.2.0 以上)に入れ替えてください");
    return e;
  };
  const busyError = () => new HttpError(409, "このサーバーでは、すでに展開しています。終わるまでお待ちください");

  /** 「展開中」の行を先に書く。同じサーバーに、ほかの「展開中」(6 時間以内)があれば書かない(false)。advisory lock で、複数のプロセスが同時に来ても 1 つだけ通る */
  async function claim(rowId: string, serverId: string, userId: string | null, name: string, path: string, mode: Mode) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`extract:${serverId}`}))`);
      const [other] = await tx.select({ id: serverChange.id }).from(serverChange)
        .where(and(eq(serverChange.serverId, serverId), eq(serverChange.action, EXTRACT_RUNNING), gt(serverChange.at, new Date(Date.now() - WATCH_MS)))).limit(1);
      if (other) return false;
      await tx.insert(serverChange).values({ id: rowId, serverId, userId, action: EXTRACT_RUNNING, title: name, added: "", removed: JSON.stringify({ path, mode }) });
      return true;
    });
  }

  /** 終わった展開を記録する(変更の履歴の行を「展開」に・操作の記録)。画面を閉じていても、サービスが再起動しても残る */
  async function finish(rowId: string, who: Slot, serverName: string, serverId: string, path: string, s: JobState) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const { teamId, userId } = who;
    if (s.phase === "done" && s.result) {
      const r = s.result;
      const where = `${r.base ? `${r.base}/` : "/"}`;
      await db.update(serverChange).set({ action: EXTRACT_ACTION, added: `${where}(${r.files} 個・${fmtSize(r.bytes)})`, removed: JSON.stringify(manifestOf(r)) }).where(eq(serverChange.id, rowId));
      const old = await db.select({ id: serverChange.id }).from(serverChange).where(and(eq(serverChange.serverId, serverId), eq(serverChange.action, EXTRACT_ACTION)))
        .orderBy(desc(serverChange.at)).offset(KEPT);
      if (old.length) await db.delete(serverChange).where(inArray(serverChange.id, old.map((o) => o.id)));
      await record({ teamId, userId, kind: "changes", action: "圧縮ファイルを展開", target: serverName, detail: `${path} → ${where}(${r.files} 個・${fmtSize(r.bytes)})` });
      return;
    }
    await db.delete(serverChange).where(eq(serverChange.id, rowId));
    if (s.phase === "cancelled") await record({ teamId, userId, kind: "changes", action: "圧縮ファイルの展開をやめた", target: serverName, detail: `${path}(何も残していません)` });
    else await record({ teamId, userId, kind: "changes", also: ["errors"], action: "圧縮ファイルを展開できなかった", target: serverName, detail: `${path}: ${s.error}` });
  }

  /** 終わるまで 1 秒ほどごとに状態を見て、終わったら記録する。見えなくなって retry 回数を超えたら、中断(結果不明)にする */
  async function watch(t: Awaited<ReturnType<typeof serverOf>>, rowId: string, who: Slot, serverId: string, path: string, jobId: string, retry = 40) {
    const until = Date.now() + WATCH_MS;
    let wait = 150;
    let fails = 0;
    while (Date.now() < until) {
      await sleep(wait);
      wait = Math.min(wait * 2, 1500);
      let s: JobState;
      try {
        s = await t.client.extractState(t.remoteId, jobId);
        fails = 0;
      } catch {
        if (++fails > retry) break;
        continue;
      }
      if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") {
        await finish(rowId, who, t.row.name, serverId, path, s).catch((e) => console.error("[展開] 記録できませんでした:", e));
        return;
      }
    }
    await abort(rowId, who, t.row.name, path);
  }

  /** 結果が分からなくなった展開を「展開中断」にする */
  async function abort(rowId: string, who: Slot, serverName: string, path: string) {
    await db.update(serverChange).set({ action: EXTRACT_ABORTED }).where(and(eq(serverChange.id, rowId), eq(serverChange.action, EXTRACT_RUNNING))).catch(() => {});
    await record({ teamId: who.teamId, userId: who.userId, kind: "changes", also: ["errors"], action: "圧縮ファイルの展開が中断された", target: serverName, detail: `${path}(結果は分かりません。展開先を確かめてください)` }).catch(() => {});
  }

  return {
    /** 展開する前の確かめ(読むだけ。ディスクには書かない): 数・大きさ・展開先・空き容量・衝突・断る理由 */
    async plan(headers: Headers, serverId: string, path: string, mode: string) {
      const { t } = await target(headers, serverId);
      const p = cleanPath(path);
      if (!p) throw new HttpError(400, "圧縮ファイルを選んでください");
      try {
        const plan = await remote(() => t.client.extractPlan(t.remoteId, p, modeOf(mode)));
        return { ...plan, busy: active.has(serverId) };
      } catch (e) {
        throw friendly(e);
      }
    },

    /** 展開を始める(バックグラウンド。進みは state で見る)。事前の確かめは、ここでもう一度、必ずやり直す */
    async start(headers: Headers, serverId: string, path: string, mode: string) {
      const { who, t } = await target(headers, serverId);
      const p = cleanPath(path);
      if (!p) throw new HttpError(400, "圧縮ファイルを選んでください");
      if (active.has(serverId)) throw busyError();
      let settle!: () => void;
      const done = new Promise<void>((r) => { settle = r; });
      const slot = { jobId: "", path: p, done };
      active.set(serverId, slot);
      const rowId = randomUUID();
      const name = p.slice(p.lastIndexOf("/") + 1);
      const m = modeOf(mode);
      try {
        if (!(await claim(rowId, serverId, who.user.id, name, p, m))) throw busyError();
        let jobId: string;
        try {
          ({ jobId } = await remote(() => t.client.extractStart(t.remoteId, p, m)));
        } catch (e) {
          await db.delete(serverChange).where(eq(serverChange.id, rowId)).catch(() => {});
          throw e;
        }
        slot.jobId = jobId;
        await db.update(serverChange).set({ removed: JSON.stringify({ jobId, path: p, mode: m }) }).where(eq(serverChange.id, rowId)).catch(() => {});
        void watch(t, rowId, { teamId: who.teamId, userId: who.user.id }, serverId, p, jobId).finally(() => { active.delete(serverId); settle(); });
        return { jobId };
      } catch (e) {
        active.delete(serverId);
        settle();
        throw friendly(e);
      }
    },

    /** 進み(書いたバイト数 / 合計・終わったら結果)。取り消しのための一覧(created)は返さない */
    async state(headers: Headers, serverId: string, jobId: string) {
      const { t } = await target(headers, serverId);
      const s = await remote(() => t.client.extractState(t.remoteId, jobId));
      const { result, ...rest } = s;
      return { ...rest, result: result && { base: result.base, mode: result.mode, files: result.files, dirs: result.dirs, bytes: result.bytes } };
    },

    /** やめる(後片付けも行う)。Pterodactyl はパネル側で展開しているので、確かめの途中までしか止められない */
    async cancel(headers: Headers, serverId: string, jobId: string) {
      const { t } = await target(headers, serverId);
      await remote(() => t.client.extractCancel(t.remoteId, jobId));
    },

    /**
     * 展開を元に戻す: 展開で作ったものだけを消す。ファイルは、種類・大きさ・内容の sha256 が展開したときと同じものだけ
     * (展開のあとに、書き換えられた・別のものに入れ替えられたものは残す。確かめられないものも残す)。結果に、消した・残した・確かめられなかった数が出る
     */
    async undo(headers: Headers, serverId: string, changeId: string) {
      const { who, t } = await target(headers, serverId);
      const [c] = await db.select().from(serverChange).where(and(eq(serverChange.id, changeId), eq(serverChange.serverId, t.row.id)));
      if (!c || c.action !== EXTRACT_ACTION) throw new HttpError(404, "履歴が見つかりません");
      if (c.undone) throw new HttpError(400, "この展開は、もう元に戻しています");
      let m: Manifest;
      try {
        m = JSON.parse(c.removed) as Manifest;
        if (m.v !== 2 || !Array.isArray(m.files) || !Array.isArray(m.dirs)) throw new Error();
        if (m.base) cleanPath(m.base);
        for (const f of m.files) if (cleanEntryName(String(f[0])).problem || typeof f[1] !== "number" || typeof f[3] !== "string") throw new Error();
        for (const d of m.dirs) if (d && cleanEntryName(String(d)).problem) throw new Error();
      } catch {
        throw new HttpError(400, "この展開は元に戻せません");
      }
      const r = await remote(() => removeCreated(t.client, t.remoteId, m));
      await db.update(serverChange).set({ undone: true }).where(eq(serverChange.id, c.id));
      const parts = [`${r.removed} 個を消しました`];
      if (r.kept) parts.push(`${r.kept} 個は、展開のあとに変えられていたので残しました`);
      if (r.unverified) parts.push(`${r.unverified} 個は、中身を確かめられなかったので残しました`);
      await record({ teamId: who.teamId, userId: who.user.id, kind: "changes", action: "展開を元に戻す", target: t.row.name, detail: `${c.title}: ${parts.join("・")}` });
      return r;
    },

    /**
     * 起動のとき(リクエストを受ける前でなくてよい)、「展開中」のまま残った行を片付ける。フォルダのサーバー・Pterodactyl は、展開がこのプロセスの中にあったので
     * 「展開中断」(結果不明)にする。エージェントの展開は、エージェントの上で続いているので、エージェントに状態を問い合わせて、終わっていれば履歴に反映する
     * (エージェントがまだつながっていなければ、あとで 5 秒ごとに 15 分まで問い合わせる)
     */
    async recover() {
      const rows = await db.select().from(serverChange).where(eq(serverChange.action, EXTRACT_RUNNING));
      for (const row of rows) {
        const info = (() => { try { return JSON.parse(row.removed) as { jobId?: string; path?: string }; } catch { return {}; } })();
        const [srv] = await db.select().from(serverTable).where(eq(serverTable.id, row.serverId));
        const who: Slot | null = srv ? { teamId: srv.teamId, userId: row.userId } : null;
        if (!srv || !who) { await db.delete(serverChange).where(eq(serverChange.id, row.id)).catch(() => {}); continue; }
        const path = info.path ?? row.title;
        if (srv.kind !== "agent" || !info.jobId) { await abort(row.id, who, srv.name, path); continue; }
        const attach = async (tries: number): Promise<void> => {
          try {
            const t = await serverOf(deps, srv.teamId, srv.id);
            const s = await t.client.extractState(t.remoteId, info.jobId!);
            if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") return await finish(row.id, who, srv.name, srv.id, path, s);
            return await watch(t, row.id, who, srv.id, path, info.jobId!);
          } catch (e) {
            const lost = e instanceof Error && /見つかりません/.test(e.message);
            if (lost || tries <= 0) return abort(row.id, who, srv.name, path);
            setTimeout(() => { void attach(tries - 1); }, 5000).unref?.();
          }
        };
        await attach(180);
      }
    },

    /** 古い展開の一時フォルダの掃除(起動のとき・1 時間ごと)。フォルダのサーバーだけ。エージェントは自分で掃除する */
    async cleanStale() {
      if (!deps.local) return 0;
      let n = 0;
      for (const l of (await db.select({ dir: localServer.rootDir }).from(localServer)).map((x) => x.dir)) {
        try {
          n += await cleanStale(checkRoot(l, deps.local.dataDir));
        } catch { /* 見えないフォルダは飛ばす */ }
      }
      return n;
    },

    /** (確かめ用)いま動いている展開が終わって、記録されるまで待つ */
    settled: (serverId: string) => active.get(serverId)?.done ?? Promise.resolve(),
  };
}
