// アドオンの版の選び方(配布元の版・保存した版に共通): サーバーの Minecraft バージョンに対応するか(対応 / 非対応 / 不明)と、版を選ばずに入れるときの「合う最新版」。
// 配布元の問い合わせはここでは行わない(library.ts が行い、この関数で絞る)
import { type Support, mcClean } from "~/lib/platforms";
import type { Channel } from "~/lib/sources";
import { type ReleaseType, pickVersion } from "./modrinth";

export type { ReleaseType, UpRow } from "./modrinth";
/**
 * 版を選ばずに入れる版: 対応するもの(無ければ対応不明のもの。非対応は選ばない)のうち、受け取る版のとおりのいちばん新しいもの。
 * 同じ時期に作りの違う版が出ていれば rank(動く作りの前のほう)を先にする
 */
export function bestOf<T extends { support: Support; type: ReleaseType; date: string; loaders: string[] }>(rows: T[], channel: Channel, rank: readonly string[]): T | undefined {
  const ok = rows.filter((r) => r.support === "ok");
  const pool = ok.length ? ok : rows.filter((r) => r.support === "unknown");
  const release = channel === "all" ? [] : pool.filter((r) => r.type === "release");
  return pickVersion((release.length ? release : pool).map((r) => ({ r, date_published: r.date, loaders: r.loaders })), rank)?.r;
}

/** 合う版が無いときの理由に添える、その版たちが対応するいちばん新しい Minecraft(分からなければ "") */
export const mcLatest = (rows: { mcVersions: string[] }[]) => mcClean(rows.flatMap((r) => r.mcVersions)).pop() ?? "";
