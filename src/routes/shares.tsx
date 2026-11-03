import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { listShares, removeShare } from "~/lib/shares-api";

export const Route = createFileRoute("/shares")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/shares" } });
    return { user: context.user };
  },
  component: Shares,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

// 共有リンクの一覧(自分が作ったもの。管理者はチームのすべて)
function Shares() {
  const load = useServerFn(listShares);
  const remove = useServerFn(removeShare);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listShares>> | null>(null);
  const [error, setError] = useState("");
  const reload = () => load().then(setRows, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/team" className="capsule">‹ チーム</Link>
        <h1>共有リンク</h1>
      </header>
      <section className="group">
        {!rows && !error && <div className="row muted">読み込んでいます…</div>}
        {rows?.length === 0 && <div className="row muted">まだありません。ライブラリのアップロードしたものの「版を見る」から作れます。</div>}
        {rows?.map((s) => (
          <div className="row" key={s.id}>
            <span className="main">
              <span translate="no">{s.name}</span>
              <span className="muted">
                {s.count} 件 · {s.expired ? "期限切れ" : `${new Date(s.expiresAt).toLocaleString("ja-JP")} まで`} · ダウンロード {s.downloads} 回
                {s.createdBy && <> · <span translate="no">{s.createdBy}</span></>}
              </span>
            </span>
            <button className="trail link danger" type="button"
              onClick={() => confirm(`共有リンク「${s.name}」を消しますか?(リンクは使えなくなります)`) && remove({ data: { id: s.id } }).then(reload, (e) => setError(message(e)))}>消す</button>
          </div>
        ))}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">リンクの URL は作ったときにしか表示しません(このアプリには、URL の鍵のハッシュだけを残します)。期限が切れたリンクは使えません。</p>
    </main>
  );
}
