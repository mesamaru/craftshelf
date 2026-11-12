import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Info, fmtSize } from "~/lib/ui";
import { SettingsFrame } from "~/lib/settings-frame";
import { SOURCE_LABEL, isItemSource } from "~/lib/sources";
import { ITEM_TYPES } from "~/lib/platforms";
import { roleLabel } from "~/lib/permissions";
import { teamUsage } from "~/lib/shares-api";
import { settingsTitle } from "~/lib/titles";

export const Route = createFileRoute("/usage")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/usage" } });
    return { user: context.user };
  },
  head: () => ({ meta: [{ title: settingsTitle("usage") }] }),
  component: Usage,
});

const TYPE_LABEL: Record<string, string> = ITEM_TYPES;

// チームの利用状況(管理者以上)
function Usage() {
  const load = useServerFn(teamUsage);
  const [u, setU] = useState<Awaited<ReturnType<typeof teamUsage>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then(setU, (e) => setError(e instanceof Error ? e.message : "読み込めませんでした")); }, []);
  const total = u ? Object.values(u.items).reduce((a, b) => a + b, 0) : 0;
  return (
    <SettingsFrame at="usage">
      {error && <section className="group"><p className="row error" role="alert">{error}</p></section>}
      {u && (
        <>
          <div className="gtitle">ライブラリ</div>
          <section className="group">
            <div className="row"><span>Mod・プラグイン</span><span className="trail">{total} 件</span></div>
            {Object.entries(u.items).map(([k, n]) => (
              <div className="row" key={k}><span className="muted">{isItemSource(k) ? SOURCE_LABEL[k] : k}</span><span className="trail">{n} 件</span></div>
            ))}
            <div className="row"><span>アップロードした版</span><span className="trail">{u.files.count} 個・{fmtSize(u.files.bytes)}</span></div>
          </section>
          {u.storage.length > 0 && (
            <>
              <div className="gtitle">保存先ごと</div>
              <section className="group">
                {u.storage.map((s) => <div className="row" key={s.name}><span translate="no">{s.name}</span><span className="trail">{s.count} 個・{fmtSize(s.bytes)}</span></div>)}
              </section>
            </>
          )}
          <div className="gtitle">チーム</div>
          <section className="group">
            <div className="row"><span>サーバー</span><span className="trail">{u.servers} 台(入れたもの {u.installed} 件)</span></div>
            <div className="row"><span>セット</span><span className="trail">{`${u.sets} 個`}</span></div>
            <div className="row"><span>メンバー</span><span className="trail">{u.members} 人</span></div>
            <div className="row"><span>共有リンク</span><span className="trail">{u.shareLinks} 個</span></div>
          </section>
          <div className="gtitle">ユーザーごと<Info>ユーザーごとの数は、このチームの中で、その人が登録・アップロード・作成したものと、操作の記録に残った操作の数です。予約・自動更新で動いたものは数えません。</Info></div>
          <section className="group">
            {u.users.map((m) => (
              <div className="row" key={m.id}>
                <span className="main">
                  <span><span translate="no">{m.name || m.email}</span> <span className="muted small">{m.role.split(",").map(roleLabel).join("・")}</span></span>
                  <span className="muted small">
                    {`登録 ${m.items} 件`}{Object.keys(m.types).length > 0 && `(${Object.entries(m.types).map(([k, n]) => `${TYPE_LABEL[k] ?? k} ${n}`).join("・")})`}
                    {` · アップロード ${m.files} 個・${fmtSize(m.bytes)} · セット ${m.sets} 個 · 共有リンク ${m.shareLinks} 個`}
                  </span>
                  <span className="muted small">
                    {`操作 ${m.actions} 回(30 日で ${m.recentActions} 回)`}{m.lastActionAt ? ` · 最後の操作 ${new Date(m.lastActionAt).toLocaleString("ja-JP")}` : " · 操作はまだありません"}
                  </span>
                </span>
              </div>
            ))}
          </section>
        </>
      )}
    </SettingsFrame>
  );
}
