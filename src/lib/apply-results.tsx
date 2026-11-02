// セットを入れた・そろえた結果の一覧(セットの画面とサーバーの画面で使う)
import type { ApplyResult } from "~/server/sets";

const LABEL: Record<ApplyResult["status"], string> = {
  installed: "入れました", updated: "更新しました", present: "入っています", skipped: "入れません", failed: "入れられません",
};

export function ApplyResults({ server, verb, list }: { server: string; verb: string; list: ApplyResult[] }) {
  return (
    <div className="row">
      <span className="main">
        <span><span translate="no">{server}</span> に{verb}結果</span>
        {list.length === 0 && <span className="muted">セットに何も入っていません。</span>}
        {list.map((r) => (
          <span key={r.title} className={r.status === "failed" ? "error" : "muted"}>
            <span translate="no">{r.title}</span>: {LABEL[r.status]}{r.detail && r.detail !== LABEL[r.status] ? `(${r.detail})` : ""}
          </span>
        ))}
      </span>
    </div>
  );
}
