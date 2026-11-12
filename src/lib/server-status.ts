// サーバーの今の状態を取る場所(1 か所)。左のメニュー・サーバーの一覧・サーバーの詳細が、この 1 つの結果を共有して使う。
// 状態は serverStatuses で、権限のあるサーバーぶんを 1 回の呼び出しでまとめて取る(間隔は見ている画面の中でいちばん短いもの。
// 一覧 = 15 秒、メニューだけ = 60 秒)。タブが見えていないあいだは取らない。サーバー側も 5 秒は同じ結果を返す
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { type serverStatus, serverStatuses } from "./servers-api";
import { shared } from "./shared";

export type Status = Awaited<ReturnType<typeof serverStatus>>;
type Entry = Status | string; // 文字はつながらなかった理由
type Sub = { ids: string[]; all: boolean; every: number };

const subs = new Set<Sub>();
const listeners = new Set<() => void>();
let st: Record<string, Entry> = {};
let timer: ReturnType<typeof setInterval> | null = null;
let timerEvery = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
const NONE: Record<string, Entry> = {};
const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

const set = (next: Record<string, Entry>) => { st = next; for (const l of listeners) l(); };

/** 見ている画面が欲しいサーバーを取って、覚える(ids を渡すと、そのサーバーだけを今すぐ取り直す) */
export function loadStatuses(only?: string[]): Promise<void> {
  const all = !only && [...subs].some((s) => s.all);
  const ids = only ?? [...new Set([...subs].flatMap((s) => s.ids))];
  if (!all && ids.length === 0) return Promise.resolve();
  // 同じ問い合わせは 2 秒のあいだ 1 つにまとめる(今すぐ取り直すときは、まとめない)
  return shared(`statuses:${all ? "all" : ids.slice().sort().join(",")}`, () => serverStatuses({ data: all ? {} : { ids } }), only ? 0 : 2000).then(
    (r) => {
      const next = { ...(all ? {} : st) };
      for (const id of ids) delete next[id];
      set(Object.assign(next, r));
    },
    (e) => set({ ...st, ...Object.fromEntries(ids.map((id) => [id, message(e)])) }),
  );
}

const visible = () => { if (!document.hidden) loadStatuses(); };

function retime() {
  const every = Math.min(...[...subs].map((s) => s.every));
  if (subs.size === 0) {
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", visible);
    return;
  }
  if (!timer) document.addEventListener("visibilitychange", visible);
  if (timer && every === timerEvery) return;
  if (timer) clearInterval(timer);
  timerEvery = every;
  timer = setInterval(visible, every);
}

/** ids のサーバーの状態を見る(all = 権限のあるサーバーすべて)。every ミリ秒ごとに取り直す。使っているあいだだけ取る */
export function useStatuses(ids: string[], every: number, all = false): Record<string, Entry> {
  const key = ids.join(",");
  useEffect(() => {
    if (ids.length === 0 && !all) return;
    const sub: Sub = { ids, all, every };
    subs.add(sub);
    retime();
    // 同じときに始まった画面の分は、1 回にまとめて取る
    if (!pending) pending = setTimeout(() => { pending = null; loadStatuses(); }, 30);
    return () => { subs.delete(sub); retime(); };
  }, [key, all, every]);
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => st, () => NONE);
}

/** 1 台を少し待ってから読み直す(起動・停止のあと) */
export const refreshStatus = (id: string) => { setTimeout(() => loadStatuses([id]), 1500); };

type Ctx = {
  /** 状態(文字はつながらなかった理由) */
  st: Record<string, Entry>;
  /** 1 台を今すぐ読み直す(起動・停止のあと) */
  refresh: (id: string) => void;
  /** 一覧の先頭(パソコンで、何も選んでいないときに開く) */
  first: string | null;
  /** 古い版が入っているサーバーごとの数(配布元に問い合わせたあと。まだなら null) */
  old: Map<string, number> | null;
};
export const ServerStatusCtx = createContext<Ctx>({ st: {}, refresh: () => {}, first: null, old: null });
export const useServerStatus = () => useContext(ServerStatusCtx);
