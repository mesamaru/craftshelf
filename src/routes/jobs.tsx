import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Btn, Chip, ChipBar, Info } from "~/lib/ui";
import { listJobs } from "~/lib/jobs-api";
import { JobRow } from "~/lib/jobs-ui";
import { pageTitle } from "~/lib/titles";

export const Route = createFileRoute("/jobs")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/jobs" } });
    return { user: context.user };
  },
  head: () => ({ meta: [{ title: pageTitle("処理") }] }),
  component: Jobs,
});

type Job = Awaited<ReturnType<typeof listJobs>>[number];

// 処理の一覧(v02 の「処理」): サーバーに入れる・そろえる・バックアップなどの、実行中・待ち・終わったもの
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
  const row = (j: Job) => <JobRow key={j.id} j={j} />;
  return (
    <main className="page fill">
      <Link to="/servers" className="back">‹ サーバー</Link>
      <header className="bar">
        <h1>処理<Info>サーバーに入れる・セットでそろえる・まとめて最新にする・本体の入れ替え・バックアップなどの、時間のかかる処理です。終わったものは 30 日たつと消えます。結果の詳しい内容は「操作の記録」にも残ります。</Info></h1>
      </header>
      <ChipBar label="絞り込み" tools={<Btn sm onClick={reload}>読み直す</Btn>}>
        <Chip on={filter === "all"} onClick={() => setFilter("all")}>すべて</Chip>
        <Chip on={filter === "failed"} warn onClick={() => setFilter("failed")}>失敗だけ</Chip>
      </ChipBar>
      {error && <section className="group"><p className="row error" role="alert">{error}</p></section>}
      <div className="gtitle">実行中・待ち</div>
      <section className="group">
        {!jobs && !error && <div className="row muted">読み込んでいます…</div>}
        {jobs && active.length === 0 && <div className="row muted">いま動いている処理はありません。</div>}
        {active.map(row)}
      </section>
      <div className="gtitle">終わったもの</div>
      <section className="group">
        {jobs && ended.length === 0 && <div className="row muted">まだありません。</div>}
        {ended.map(row)}
      </section>
    </main>
  );
}
