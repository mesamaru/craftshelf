// サーバーの「ファイル」タブの圧縮ファイルの展開(権限・記録・変更の履歴・取り消し)。
// 展開そのものと安全の確かめは extract-safe.ts(フォルダのサーバー・エージェント・Pterodactyl の事前の確かめが同じものを使う)。
// ここでは、権限(ファイルを書く権限 files:edit + そのサーバーへの割り当て)・サーバーごとに 1 つだけ・終わったときの記録を受け持つ
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { fmtSize } from "~/lib/format";
import { localServer, serverChange } from "./db/schema";
import { cleanStale, type JobState, type Manifest, type Mode, cleanEntryName, manifestOf, removeCreated } from "./extract-safe";
import { eventService } from "./events";
import { cleanPath } from "./files";
import { HttpError, requireTeam } from "./guard";
import { checkRoot } from "./local";
import { type Deps, remote, serverOf } from "./servers";

/** 変更の履歴(server_change)の action */
export const EXTRACT_ACTION = "展開";
const KEPT = 30; // 展開の記録は、1 台につき新しい 30 件まで
const WATCH_MS = 6 * 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const modeOf = (m: unknown): Mode => (m === "here" ? "here" : "folder");

export function extractService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  // サーバーごとに 1 つだけ(2 つ目は断る)。始めた直後に置くので、同時の 2 回目も止まる
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

  /** 終わった展開を記録する(変更の履歴 + 操作の記録)。画面を閉じていても残る */
  async function finish(who: Awaited<ReturnType<typeof target>>["who"], serverName: string, serverId: string, path: string, s: JobState) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const { teamId, user } = who;
    if (s.phase === "done" && s.result) {
      const r = s.result;
      const where = `${r.base ? `${r.base}/` : "/"}`;
      await db.insert(serverChange).values({
        id: randomUUID(), serverId, userId: user.id, action: EXTRACT_ACTION, title: name,
        added: `${where}(${r.files} 個・${fmtSize(r.bytes)})`, removed: JSON.stringify(manifestOf(r)),
      });
      const old = await db.select({ id: serverChange.id }).from(serverChange).where(and(eq(serverChange.serverId, serverId), eq(serverChange.action, EXTRACT_ACTION)))
        .orderBy(desc(serverChange.at)).offset(KEPT);
      if (old.length) await db.delete(serverChange).where(inArray(serverChange.id, old.map((o) => o.id)));
      await record({ teamId, userId: user.id, kind: "changes", action: "圧縮ファイルを展開", target: serverName, detail: `${path} → ${where}(${r.files} 個・${fmtSize(r.bytes)})` });
    } else if (s.phase === "cancelled") {
      await record({ teamId, userId: user.id, kind: "changes", action: "圧縮ファイルの展開をやめた", target: serverName, detail: `${path}(何も残していません)` });
    } else {
      await record({ teamId, userId: user.id, kind: "changes", also: ["errors"], action: "圧縮ファイルを展開できなかった", target: serverName, detail: `${path}: ${s.error}` });
    }
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
      if (active.has(serverId)) throw new HttpError(409, "このサーバーでは、すでに展開しています。終わるまでお待ちください");
      let settle!: () => void;
      const done = new Promise<void>((r) => { settle = r; });
      const slot = { jobId: "", path: p, done };
      active.set(serverId, slot);
      try {
        const { jobId } = await remote(() => t.client.extractStart(t.remoteId, p, modeOf(mode)));
        slot.jobId = jobId;
        void (async () => {
          const until = Date.now() + WATCH_MS;
          let wait = 150;
          let fails = 0;
          try {
            while (Date.now() < until) {
              await sleep(wait);
              wait = Math.min(wait * 2, 1500);
              let s: JobState;
              try {
                s = await t.client.extractState(t.remoteId, jobId);
                fails = 0;
              } catch {
                if (++fails > 40) return;
                continue;
              }
              if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") {
                await finish(who, t.row.name, serverId, p, s).catch((e) => console.error("[展開] 記録できませんでした:", e));
                return;
              }
            }
          } finally {
            active.delete(serverId);
            settle();
          }
        })();
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

    /** 展開を元に戻す: 展開で作ったフォルダ・ファイルだけを消す(展開のあとに、大きさが変わった・足されたものは残す) */
    async undo(headers: Headers, serverId: string, changeId: string) {
      const { who, t } = await target(headers, serverId);
      const [c] = await db.select().from(serverChange).where(and(eq(serverChange.id, changeId), eq(serverChange.serverId, t.row.id)));
      if (!c || c.action !== EXTRACT_ACTION) throw new HttpError(404, "履歴が見つかりません");
      if (c.undone) throw new HttpError(400, "この展開は、もう元に戻しています");
      let m: Manifest;
      try {
        m = JSON.parse(c.removed) as Manifest;
        if (m.v !== 1 || !Array.isArray(m.files) || !Array.isArray(m.dirs)) throw new Error();
        if (m.base) cleanPath(m.base);
        for (const f of m.files) if (cleanEntryName(String(f[0])).problem || typeof f[1] !== "number") throw new Error();
        for (const d of m.dirs) if (d && cleanEntryName(String(d)).problem) throw new Error();
      } catch {
        throw new HttpError(400, "この展開は元に戻せません");
      }
      const r = await remote(() => removeCreated(t.client, t.remoteId, m));
      await db.update(serverChange).set({ undone: true }).where(eq(serverChange.id, c.id));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "changes", action: "展開を元に戻す", target: t.row.name, detail: `${c.title}: ${r.removed} 個を消しました${r.kept ? `(${r.kept} 個は、展開のあとに変えられていたので残しました)` : ""}` });
      return r;
    },

    /** 古い展開の一時フォルダの掃除(起動のとき)。フォルダのサーバーだけ。エージェントは自分で掃除する */
    async cleanStale() {
      if (!deps.local) return 0;
      let n = 0;
      for (const [l] of (await db.select({ dir: localServer.rootDir }).from(localServer)).map((x) => [x.dir])) {
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
