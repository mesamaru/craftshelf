import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { listJobs } from "~/lib/jobs-api";

export const Route = createFileRoute("/jobs")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/jobs" } });
    return { user: context.user };
  },
  component: Jobs,
});

type Job = Awaited<ReturnType<typeof listJobs>>[number];
const STATE: Record<Job["state"], string> = { running: "実行中", queued: "待ち", done: "成功", failed: "失敗" };
const time = (s: string | null) => (s ? new Date(s).toLocaleString("ja-JP") : "");
// かかった時間(終わっていなければ今まで)
const took = (j: Job) => {
  if (!j.startedAt) return "";
  const sec = Math.max(0, Math.round(((j.finishedAt ? new Date(j.finishedAt).getTime() : Date.now()) - new Date(j.startedAt).getTime()) / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
};

// 処理の一覧(v02 の「処理」): サーバーへの導入・そろえる・バックアップなどの、実行中・待ち・終わったもの
function Jobs() {
  const load = useServerFn(listJobs);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const busy = !!jobs?.some((j) => j.state === "running" || j.state === "queued");
  const reload = () => load().then((r) => { setJobs(r); setError(""); }, (e) => setError(e instanceof Error ? e.message : "読み込めませんでした"));
  useEffect(() => { reload(); }, []);
  // 動いているものがあるあいだは 3 秒ごと、無ければ 30 秒ごとに読み直す
  useEffect(() => {
    const t = setInterval(reload, busy ? 3000 : 30_000);
    return () => clearInterval(t);
  }, [busy]);
  const active = (jobs ?? []).filter((j) => j.state === "running" || j.state === "queued");
  const ended = (jobs ?? []).filter((j) => (j.state === "done" || j.state === "failed") && (filter === "all" || j.state === "failed"));
  const row = (j: Job) => (
    <div className="row" key={j.id}>
      <span className="main">
        <span>
          <span className={`badge state-${j.state}`}>{STATE[j.state]}</span> {j.action}
          {(j.serverName || j.target) && <> · <span translate="no">{[j.serverName, j.target].filter(Boolean).join(" · ")}</span></>}
        </span>
        <span className="muted small">
          {time(j.createdAt)}{j.userName ? <> · <span translate="no">{j.userName}</span></> : " · 予約・自動"}{took(j) && ` · ${took(j)}`}
        </span>
        {j.detail && <span className={`small pre${j.state === "failed" ? " error" : " muted"}`}>{j.detail}</span>}
      </span>
    </div>
  );
  return (
    <main className="page narrow">
      <header className="bar">
        <h1>処理の一覧</h1>
        <button type="button" className="capsule small" onClick={reload}>読み直す</button>
      </header>
      {error && <section className="group"><p className="row error" role="alert">{error}</p></section>}
      <div className="group-title">実行中・待ち</div>
      <section className="group">
        {!jobs && !error && <div className="row muted">読み込んでいます…</div>}
        {jobs && active.length === 0 && <div className="row muted">いま動いている処理はありません。</div>}
        {active.map(row)}
      </section>
      <div className="group-title">終わったもの</div>
      <section className="group">
        <div className="row">
          <span className="seg" role="group" aria-label="絞り込み">
            <button type="button" className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>すべて</button>
            <button type="button" className={filter === "failed" ? "on" : ""} aria-pressed={filter === "failed"} onClick={() => setFilter("failed")}>失敗だけ</button>
          </span>
        </div>
        {jobs && ended.length === 0 && <div className="row muted">まだありません。</div>}
        {ended.map(row)}
      </section>
      <p className="foot">サーバーへの導入・セットでそろえる・まとめて最新にする・本体の入れ替え・バックアップなどの、時間のかかる処理です。終わったものは 30 日たつと消えます。結果の詳しい内容は「操作の記録」にも残ります。</p>
    </main>
  );
}
