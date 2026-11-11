// サーバーの一覧(servers.tsx の左)の並べ替え・絞り込み・グループ分け
import { kindLabel } from "./platforms";

export type ServerSort = "name" | "nameDesc" | "running" | "update" | "players" | "new" | "kind";
export type ServerFilter = "all" | "running" | "stopped" | "update";
export const SERVER_SORTS: [ServerSort, string][] = [
  ["name", "名前順"], ["nameDesc", "名前の逆順"], ["running", "稼働中を上に"], ["update", "更新があるものを上に"], ["players", "人数が多い順"], ["new", "追加が新しい順"], ["kind", "種類順"],
];
export const SERVER_FILTERS: [ServerFilter, string][] = [["all", "すべて"], ["running", "稼働中"], ["stopped", "停止中"], ["update", "更新あり"]];
export const isServerSort = (v: unknown): v is ServerSort => SERVER_SORTS.some(([k]) => k === v);

/** 一覧の 1 台(state は serverStatus の state。読めるまでは "")。index は追加された順(0 が最初) */
export type ServerItem = { id: string; name: string; platform?: string | null; mcVersion?: string | null; state: string; old: number; online: number; index: number };

const byText = (a: string, b: string) => a.localeCompare(b, "ja", { numeric: true });

/** 並べ替え。同じものは名前順(元の配列は変えない) */
export function sortServers<T extends ServerItem>(list: readonly T[], sort: ServerSort): T[] {
  const by: Record<ServerSort, (a: T, b: T) => number> = {
    name: () => 0,
    nameDesc: (a, b) => byText(b.name, a.name),
    running: (a, b) => Number(b.state === "running") - Number(a.state === "running"),
    update: (a, b) => b.old - a.old,
    players: (a, b) => b.online - a.online,
    new: (a, b) => b.index - a.index,
    // 種類の無いもの(空)は最後
    kind: (a, b) => { const x = kindLabel(a.platform, a.mcVersion); const y = kindLabel(b.platform, b.mcVersion); return x && y ? byText(x, y) : Number(!x) - Number(!y); },
  };
  return [...list].sort((a, b) => by[sort](a, b) || byText(a.name, b.name) || a.index - b.index);
}

/** 名前の一部と、稼働中・停止中・更新あり で絞り込む */
export function filterServers<T extends ServerItem>(list: readonly T[], q: string, filter: ServerFilter): T[] {
  const w = q.trim().toLowerCase();
  return list.filter((s) => (!w || s.name.toLowerCase().includes(w))
    && (filter === "all" || (filter === "running" ? s.state === "running" : filter === "stopped" ? s.state === "offline" : s.old > 0)));
}

/** 絞り込み → 並べ替え。group なら「対応が必要」(古い版が入っている)と「問題なし」に分け、それぞれの中を並べる。first はいちばん上のサーバー */
export function arrange<T extends ServerItem>(list: readonly T[], o: { sort: ServerSort; q: string; filter: ServerFilter; group: boolean }) {
  const shown = filterServers(list, o.q, o.filter);
  const need = o.group ? sortServers(shown.filter((s) => s.old > 0), o.sort) : [];
  const ok = sortServers(o.group ? shown.filter((s) => !s.old) : shown, o.sort);
  return { need, ok, first: (need[0] ?? ok[0])?.id ?? null };
}
