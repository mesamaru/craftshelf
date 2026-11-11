// サーバーの画面(左の一覧と右の詳細)で共有する、各サーバーの今の状態。一覧が 15 秒ごとに読み、詳細はそれを使う(同じものを二重に読まない)
import { createContext, useContext } from "react";
import type { serverStatus } from "./servers-api";

export type Status = Awaited<ReturnType<typeof serverStatus>>;
type Ctx = {
  /** 状態(文字はつながらなかった理由) */
  st: Record<string, Status | string>;
  /** 1 台を今すぐ読み直す(起動・停止のあと) */
  refresh: (id: string) => void;
  /** 一覧の先頭(パソコンで、何も選んでいないときに開く) */
  first: string | null;
  /** 古い版が入っているサーバーごとの数(配布元に問い合わせたあと。まだなら null) */
  old: Map<string, number> | null;
};
export const ServerStatusCtx = createContext<Ctx>({ st: {}, refresh: () => {}, first: null, old: null });
export const useServerStatus = () => useContext(ServerStatusCtx);
