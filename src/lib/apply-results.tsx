// セットを入れた・そろえた結果の一覧(セットの画面とサーバーの画面で使う。ほかのサーバーにそろえた結果にも)
import type { ApplyResult } from "~/server/sets";
import { applySummary } from "./apply-summary";

const LABEL: Record<ApplyResult["status"], string> = {
  installed: "入れました", updated: "更新しました", present: "入っています", skipped: "入れません", failed: "入れられません",
  missing: "入っていません", available: "新しい版があります", removed: "外しました",
};

export function ApplyResults({ server, verb, list, empty = "セットに何も入っていません。" }: { server: string; verb: string; list: ApplyResult[]; empty?: string }) {
  const parts = applySummary(list);
  return (
    <div className="row">
      <span className="main">
        <span>{verb}結果: <span translate="no">{server}</span></span>
        {list.length === 0 && <span className="muted">{empty}</span>}
        {parts.length > 0 && <span className="apply-sum" role="status">{parts.map((p, i) => <span key={p}>{i > 0 && " · "}<b>{p}</b></span>)}</span>}
        {list.map((r) => (
          <span key={r.title} className={r.status === "failed" ? "error" : "muted"}>
            <span translate="no">{r.title}</span>: {(r.status === "present" || r.status === "skipped") && r.detail ? r.detail : `${LABEL[r.status]}${r.detail && r.detail !== LABEL[r.status] ? `(${r.detail})` : ""}`}
          </span>
        ))}
      </span>
    </div>
  );
}
