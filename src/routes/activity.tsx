import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { listEvents, notifySettings, setNotify, testNotify } from "~/lib/events-api";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/activity")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/activity" } });
    return { user: context.user };
  },
  component: Activity,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
type Row = Awaited<ReturnType<typeof listEvents>>[number];

// 操作の記録と Discord への通知(チームの管理者以上)
function Activity() {
  const { user } = Route.useRouteContext();
  const { can, me } = useCan(user.id);
  const admin = can({ member: ["update"] });
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/team" className="capsule">‹ チーム</Link>
        <h1>操作の記録と通知</h1>
      </header>
      {!me ? <section className="group"><div className="row muted">読み込んでいます…</div></section>
        : !admin ? <section className="group"><div className="row muted">見られるのは、チームの管理者とオーナーだけです。</div></section>
        : <><Notify /><Log /></>}
    </main>
  );
}

function Notify() {
  const load = useServerFn(notifySettings);
  const save = useServerFn(setNotify);
  const test = useServerFn(testNotify);
  const [s, setS] = useState<Awaited<ReturnType<typeof notifySettings>> | null>(null);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then((x) => { setS(x); setPicked(new Set(x.selected)); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setError("");
    setNote("");
    try {
      await fn();
      setNote(done);
      setUrl("");
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  if (!s) return error ? <p className="row error" role="alert">{error}</p> : null;

  return (
    <>
      <div className="group-title">Discord への通知</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), run("save", () => save({ data: { url, kinds: [...picked] } }), "保存しました"))}>
        <input className="row" type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder={s.configured ? `Webhook の URL(設定済み ${s.hint}。変えるときだけ入力)` : "Webhook の URL(https://discord.com/api/webhooks/…)"} />
        {Object.entries(s.kinds).map(([k, label]) => (
          <label className="row" key={k}>
            <span>{label}</span>
            <input className="trail" type="checkbox" checked={picked.has(k)}
              onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
          </label>
        ))}
        <div className="row actions">
          <button className="link" type="submit" disabled={!!busy || (!s.configured && !url)}>{busy === "save" ? "保存しています…" : "保存"}</button>
          {s.configured && <button className="link" type="button" disabled={!!busy} onClick={() => run("test", () => test(), "送りました。Discord を確かめてください")}>試しに送る</button>}
          {s.configured && (
            <button className="trail link danger" type="button" disabled={!!busy}
              onClick={() => confirm("Discord への通知をやめますか?(Webhook の URL を消します)") && run("off", () => save({ data: { url: null, kinds: [] } }), "通知をやめました")}>
              通知をやめる
            </button>
          )}
        </div>
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
      <p className="foot">Discord のチャンネルの設定 → 連携サービス → ウェブフックで作った URL を入れてください。URL は暗号化して保存し、画面には最後の 4 文字だけを出します。通知ではメンションはしません。</p>
    </>
  );
}

function Log() {
  const load = useServerFn(listEvents);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const fetchPage = async (before?: string) => {
    try {
      const r = await load({ data: { before, q: q.trim() || undefined } });
      setRows((p) => (before ? [...(p ?? []), ...r] : r));
      setMore(r.length === 100);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  };
  // 打ち終わるのを少し待ってから探す
  useEffect(() => {
    const t = setTimeout(() => fetchPage(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <div className="group-title">操作の記録</div>
      <section className="group">
        <input className="row" type="search" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)}
          placeholder="操作・対象・詳しく・人の名前で探す" aria-label="操作の記録を探す" />
        {!rows && !error && <div className="row muted">読み込んでいます…</div>}
        {rows?.length === 0 && <div className="row muted">{q.trim() ? "一致する記録はありません。" : "まだ記録がありません。"}</div>}
        {rows?.map((r) => (
          <div className="row" key={r.id}>
            <span className="main">
              <span>{r.action} <span translate="no">{r.target}</span></span>
              {r.detail && <span className="muted pre" translate="no">{r.detail}</span>}
              <span className="muted">{new Date(r.at).toLocaleString("ja-JP")} · {r.userName ? <span translate="no">{r.userName}</span> : r.kind === "schedule" ? "予約" : "自動"}</span>
            </span>
          </div>
        ))}
        {more && rows && <button className="row link" type="button" onClick={() => fetchPage(rows[rows.length - 1].at)}>もっと見る</button>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}
