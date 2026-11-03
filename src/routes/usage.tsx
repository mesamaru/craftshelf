import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { SOURCE_LABEL, isItemSource } from "~/lib/sources";
import { teamUsage } from "~/lib/shares-api";

export const Route = createFileRoute("/usage")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/usage" } });
    return { user: context.user };
  },
  component: Usage,
});

const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

// チームの利用状況(管理者以上)
function Usage() {
  const load = useServerFn(teamUsage);
  const [u, setU] = useState<Awaited<ReturnType<typeof teamUsage>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then(setU, (e) => setError(e instanceof Error ? e.message : "読み込めませんでした")); }, []);
  const total = u ? Object.values(u.items).reduce((a, b) => a + b, 0) : 0;
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/team" className="capsule">‹ チーム</Link>
        <h1>利用状況</h1>
      </header>
      {error && <section className="group"><p className="row error" role="alert">{error}</p></section>}
      {u && (
        <>
          <div className="group-title">ライブラリ</div>
          <section className="group">
            <div className="row"><span>Mod・プラグイン</span><span className="trail">{total} 件</span></div>
            {Object.entries(u.items).map(([k, n]) => (
              <div className="row" key={k}><span className="muted">{isItemSource(k) ? SOURCE_LABEL[k] : k}</span><span className="trail">{n} 件</span></div>
            ))}
            <div className="row"><span>アップロードした版</span><span className="trail">{u.files.count} 個・{size(u.files.bytes)}</span></div>
          </section>
          {u.storage.length > 0 && (
            <>
              <div className="group-title">保存先ごと</div>
              <section className="group">
                {u.storage.map((s) => <div className="row" key={s.name}><span translate="no">{s.name}</span><span className="trail">{s.count} 個・{size(s.bytes)}</span></div>)}
              </section>
            </>
          )}
          <div className="group-title">チーム</div>
          <section className="group">
            <div className="row"><span>サーバー</span><span className="trail">{u.servers} 台(入れたもの {u.installed} 件)</span></div>
            <div className="row"><span>セット</span><span className="trail">{u.sets} 個</span></div>
            <div className="row"><span>メンバー</span><span className="trail">{u.members} 人</span></div>
            <div className="row"><span>共有リンク</span><span className="trail">{u.shareLinks} 個</span></div>
          </section>
        </>
      )}
    </main>
  );
}
