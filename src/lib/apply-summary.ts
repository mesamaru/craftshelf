// セットを入れた・そろえた結果の一行のまとめ(例 入れた 2 · 更新した 1 · 変えなかった 3(同じ版です 2・無効にしています))。
// 変えなかったもの・入れなかったものは、理由ごとに数える(括弧の中の版の番号などは除く)
import type { ApplyResult } from "~/server/sets";

const reasonOf = (detail: string) => detail.replace(/[((].*$/, "").trim() || detail;

/** 結果を数えて、画面に出す短い文の並びにする(0 のものは出さない) */
export function applySummary(list: ApplyResult[]): string[] {
  const rows = (...st: ApplyResult["status"][]) => list.filter((r) => st.includes(r.status));
  const count = (label: string, r: ApplyResult[], why = false) => {
    if (!r.length) return [];
    const reasons = new Map<string, number>();
    if (why) for (const x of r) reasons.set(reasonOf(x.detail), (reasons.get(reasonOf(x.detail)) ?? 0) + 1);
    const text = [...reasons].map(([k, n]) => (n > 1 ? `${k} ${n}` : k)).join("・");
    return [`${label} ${r.length}${text ? `(${text})` : ""}`];
  };
  return [
    ...count("入れた", rows("installed")),
    ...count("更新した", rows("updated")),
    ...count("外した", rows("removed")),
    ...count("変えなかった", rows("present"), true),
    ...count("入れなかった", rows("skipped"), true),
    ...count("入れられなかった", rows("failed")),
    ...count("新しい版あり", rows("available")),
    ...count("入っていない", rows("missing")),
  ];
}
