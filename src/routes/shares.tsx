import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { SettingsFrame } from "~/lib/settings-frame";
import { listShares, removeShare, stopShare } from "~/lib/shares-api";

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
  const stop = useServerFn(stopShare);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listShares>> | null>(null);
  const [error, setError] = useState("");
  const reload = () => load().then(setRows, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);
  return (
    <SettingsFrame at="shares" info={<><span>リンクの URL は作ったときにしか表示しません(このアプリには、URL の鍵のハッシュだけを残します)。期限が切れたリンク・回数を使い切ったリンク・止めたリンクは使えません。</span></>}>
      <section className="group">
        {!rows && !error && <div className="row muted">読み込んでいます…</div>}
        {rows?.length === 0 && <div className="row muted">まだありません。ライブラリのアップロードしたものの「版を見る」・「保存した版」か、選んだものから作れます。</div>}
        {rows?.map((s) => (
          <div className="row" key={s.id}>
            <span className="main">
              <span translate="no">{s.name}</span>
              <span className="muted">
                {s.count} 件 · {s.expired ? "止めました・期限切れ" : s.used ? "回数を使い切りました" : s.expiresAt ? `${new Date(s.expiresAt).toLocaleString("ja-JP")} まで` : "無期限"}
                {s.maxDownloads ? ` · ダウンロード ${s.downloads} / ${s.maxDownloads} 回` : ` · ダウンロード ${s.downloads} 回`}
                {s.createdBy && <> · <span translate="no">{s.createdBy}</span></>}
              </span>
            </span>
            {!s.expired && !s.used && (
              <button className="trail link" type="button"
                onClick={() => confirm(`共有リンク「${s.name}」を止めますか?(リンクは使えなくなります。一覧には残ります)`) && stop({ data: { id: s.id } }).then(reload, (e) => setError(message(e)))}>止める</button>
            )}
            <button className={`${s.expired || s.used ? "trail " : ""}link danger`} type="button"
              onClick={() => confirm(`共有リンク「${s.name}」を消しますか?(リンクは使えなくなります)`) && remove({ data: { id: s.id } }).then(reload, (e) => setError(message(e)))}>消す</button>
          </div>
        ))}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </SettingsFrame>
  );
}
