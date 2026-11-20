// 処理(サーバーへの導入・セットでそろえる・本体の入れ替え・バックアップなど)の 1 行と、どの画面でも出る上のバーの「処理」のしるし。
// しるしは、動いている処理があるか、まだ見ていない終わった処理があるときだけ出し、押すとシートで様子を見られる
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { type listJobs, sharedJobs } from "./jobs-api";
import { Icon, Sheet } from "./ui";

export type Job = Awaited<ReturnType<typeof listJobs>>[number];
const STATE: Record<Job["state"], string> = { running: "実行中", queued: "待ち", done: "成功", failed: "失敗" };
const time = (s: string | null) => (s ? new Date(s).toLocaleString("ja-JP") : "");
// かかった時間(終わっていなければ今まで)
const took = (j: Job) => {
  if (!j.startedAt) return "";
  const sec = Math.max(0, Math.round(((j.finishedAt ? new Date(j.finishedAt).getTime() : Date.now()) - new Date(j.startedAt).getTime()) / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
};

/** 終わったが、結果の中に失敗がある(「失敗 1」など。セットを入れる・まとめて更新するで、一部だけ入らなかったとき) */
export const partlyFailed = (j: Job) => j.state === "done" && /失敗 [1-9]/.test(j.detail ?? "");

/** 処理の 1 行(状態・何を・どのサーバー・いつ・だれ・かかった時間・結果) */
export function JobRow({ j }: { j: Job }) {
  return (
    <div className="row">
      {partlyFailed(j) ? <span className="badge upd">一部失敗</span> : <span className={`badge state-${j.state}`}>{STATE[j.state]}</span>}
      <span className="mid">
        <span className="ttl">{j.action}{(j.serverName || j.target) && <> · <span translate="no">{[j.serverName, j.target].filter(Boolean).join(" · ")}</span></>}</span>
        <span className="sub">
          {time(j.createdAt)}{j.userName ? <> · <span translate="no">{j.userName}</span></> : " · 予約・自動"}{took(j) && <> · <span>{took(j)}</span></>}
        </span>
        {j.detail && <span className={`small pre${j.state === "failed" ? " error" : " muted"}`}>{j.detail}</span>}
      </span>
    </div>
  );
}

/** 処理を始めたことを、上のバーのしるしに知らせる(すぐ読み直して、動いているあいだは細かく見る) */
export const JOBS_CHANGED = "craftshelf:jobs";
export const jobsChanged = () => window.dispatchEvent(new Event(JOBS_CHANGED));

const SEEN = "craftshelf.jobs-seen";
const readSeen = () => {
  try {
    const v = localStorage.getItem(SEEN);
    if (v) return v;
    const now = new Date().toISOString(); // 初めて開いた端末は、前に終わったものを知らせない
    localStorage.setItem(SEEN, now);
    return now;
  } catch {
    return new Date().toISOString();
  }
};

/** 上のバーの「処理」のしるし(いつも出す)。動いている数(回る輪)・まだ見ていない終わった数(失敗があれば赤)。押すと様子のシート */
export function JobsButton() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [seen, setSeen] = useState("");
  const [open, setOpen] = useState(false);
  const reload = () => { sharedJobs().then(setJobs, () => {}); };
  useEffect(() => {
    setSeen(readSeen());
    reload();
    const on = () => { setTimeout(reload, 500); setTimeout(reload, 2000); };
    window.addEventListener(JOBS_CHANGED, on);
    return () => window.removeEventListener(JOBS_CHANGED, on);
  }, []);
  const running = (jobs ?? []).filter((j) => j.state === "running" || j.state === "queued");
  // 動いているあいだは 3 秒ごと、無ければ 20 秒ごとに読み直す(読むのはパネルのデータベースだけ)
  useEffect(() => {
    const t = setInterval(reload, running.length ? 3000 : 20_000);
    return () => clearInterval(t);
  }, [running.length > 0]);
  const fresh = (jobs ?? []).filter((j) => (j.state === "done" || j.state === "failed") && !!j.finishedAt && !!seen && j.finishedAt > seen);
  const failed = fresh.filter((j) => j.state === "failed" || partlyFailed(j)).length;
  const show = () => {
    const now = new Date().toISOString();
    setSeen(now);
    try { localStorage.setItem(SEEN, now); } catch { /* 覚えられなくても開く */ }
    setOpen(true);
  };
  const label = !running.length && !fresh.length ? "処理" : running.length ? `処理 ${running.length} 件が動いています` : failed ? `処理 ${failed} 件に失敗があります` : `処理 ${fresh.length} 件が終わりました`;
  const ended = (jobs ?? []).filter((j) => j.state === "done" || j.state === "failed").slice(0, 8);
  return (
    <>
      <button type="button" className={`rbtn jobs${running.length ? " busy" : ""}`} onClick={show} aria-label={label} title={label}>
        <Icon name="jobs" />
        {running.length > 0 ? <span className="nb run">{running.length}</span> : fresh.length > 0 && <span className={`nb${failed ? "" : " ok"}`}>{failed || fresh.length}</span>}
      </button>
      {open && (
        <Sheet title="処理" onClose={() => setOpen(false)}>
          <div className="gtitle">実行中・待ち</div>
          <section className="group">
            {running.length === 0 && <div className="row muted">いま動いている処理はありません。</div>}
            {running.map((j) => <JobRow key={j.id} j={j} />)}
          </section>
          <div className="gtitle">最近終わったもの</div>
          <section className="group">
            {ended.length === 0 && <div className="row muted">まだありません。</div>}
            {ended.map((j) => <JobRow key={j.id} j={j} />)}
            <Link to="/jobs" className="row link" onClick={() => setOpen(false)}>すべての処理を見る ›</Link>
          </section>
        </Sheet>
      )}
    </>
  );
}
