import { type ReactNode, useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { authClient } from "~/lib/auth-client";
import { libraryCatalog, outdatedLibraryServers } from "~/lib/library-api";
import { listBackups } from "~/lib/backup-api";
import { LIBRARY_CHANGED } from "~/lib/library-add";
import { ITEM_TYPES, ITEM_TYPE_IDS } from "~/lib/platforms";
import { MobileSearch, StoragePill } from "~/lib/shell";
import { ItemIcon } from "~/lib/type-icon";
import { Btn, Icon, type IconName, fmtSize } from "~/lib/ui";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/home")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/home" } });
    return { user: context.user };
  },
  component: Home,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type CatItem = Catalog["items"][number];
const SHOW = 4; // 一覧は 4 件まで。あとは「もっと見る」でライブラリへ

// ホーム(v02 のダッシュボード): 数のカード・更新があるもの・最近追加したもの・種類ごとの件数・確認が必要なもの・サーバー・配布元の連携
function Home() {
  const { user } = Route.useRouteContext();
  const { data: team } = authClient.useActiveOrganization();
  const { can } = useCan(user.id);
  const load = useServerFn(libraryCatalog);
  const outdated = useServerFn(outdatedLibraryServers);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [old, setOld] = useState<Map<string, string[]> | null>(null); // 古い版のあるアイテム → サーバー(「今すぐ確認」で配布元に問い合わせる)
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const reload = () => { load().then((c) => { setCat(c); setError(""); }, (e) => setError(message(e))); };
  useEffect(reload, [team?.id]);
  useEffect(() => {
    window.addEventListener(LIBRARY_CHANGED, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED, reload);
  }, []);
  const check = () => {
    setChecking(true);
    setError("");
    outdated().then((r) => setOld(new Map(r.map((x) => [x.itemId, x.serverIds]))), (e) => setError(message(e))).finally(() => setChecking(false));
  };
  const edit = can({ library: ["edit"] });
  const admin = can({ storage: ["manage"] });
  // 保存先とバックアップ(自分用の版の管理者だけ。バックアップの予約は管理者しか読めない)
  const backups = useServerFn(listBackups);
  const [backup, setBackup] = useState<Awaited<ReturnType<typeof listBackups>>["schedule"] | null>(null);
  useEffect(() => { if (admin && cat?.storage) backups().then((b) => setBackup(b.schedule), () => setBackup(null)); }, [admin, !!cat?.storage]);

  const items = cat?.items ?? [];
  const files = items.reduce((s, i) => s + i.files, 0);
  const size = items.reduce((s, i) => s + i.size, 0);
  const linked = items.filter((i) => i.source !== "upload");
  const upd = items.filter((i) => old?.has(i.id));
  const recent = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts = ITEM_TYPE_IDS.map((t) => [t, items.filter((i) => i.projectType === t).length] as const).filter(([, n]) => n > 0);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const noMc = items.filter((i) => !i.mc.length).length;
  const pct = items.length ? Math.round((linked.length / items.length) * 100) : 0;
  const itemRow = (i: CatItem, trail: ReactNode) => (
    <Link key={i.id} to="/" search={{ item: i.id }} className="row click">
      <span className="ic"><ItemIcon type={i.projectType} url={i.iconUrl ?? undefined} /></span>
      <span className="mid"><span className="ttl" translate="no">{i.title}</span><span className="sub" translate="no">{i.version || ITEM_TYPES[i.projectType as keyof typeof ITEM_TYPES]}</span></span>
      {trail}<span className="chev" aria-hidden="true">›</span>
    </Link>
  );

  return (
    <main className="page fill">
      <header className="bar"><h1>ホーム</h1><StoragePill /></header>
      <MobileSearch />
      {error && <p className="error" role="alert">{error}</p>}
      {!cat && !error && <p className="muted">読み込んでいます…</p>}
      {cat && <>
        <div className="tiles">
          <Tile to="/" icon="library" k="登録しているもの" v={<>{items.length}<small>件</small></>} s={`${files} ファイル`} />
          <Tile to={can({ storage: ["manage"] }) && cat.storage ? "/storage" : "/"} icon="disk" k="使っている容量" v={fmtSize(size)} s={cat.storage ? cat.storage.name || "ローカル" : ""} />
          <Tile to="/" search={{ f: "upd" }} icon="reload" k="更新があるもの" warn={upd.length > 0} v={<>{old ? upd.length : "—"}<small>件</small></>} s={`${linked.length} 件を確認対象にしています`} />
          <Tile to="/" icon="link" k="配布元の連携" v={<>{pct}<small>%</small></>} s={`${linked.length} / ${items.length} 件`} />
        </div>
        <div className="dash">
          <div className="dcol">
            <section className="card glass">
              <div className="card-h"><h4>更新があるもの</h4></div>
              <div className="card-b">
                {upd.length > 0 ? <div className="group flat">{upd.slice(0, SHOW).map((i) => itemRow(i, <span className="badge upd">{`${old!.get(i.id)!.length} 台`}</span>))}</div>
                  : <p className="dash-empty">{!old ? "確かめると、ここに更新が出ます" : linked.length ? "すべて最新です" : "配布元のあるものを足すと、ここに更新が出ます"}</p>}
                {upd.length > SHOW && <Link to="/" search={{ f: "upd" }} className="kv linkish"><span>もっと見る</span><span>{`残り ${upd.length - SHOW} 件 ›`}</span></Link>}
                <div className="chips"><Btn kind="tint" sm disabled={checking} onClick={check}><Icon name="reload" />{checking ? "確かめています…" : "今すぐ確認"}</Btn></div>
              </div>
            </section>
            <section className="card glass">
              <div className="card-h"><h4>最近追加したもの</h4></div>
              <div className="card-b">
                {recent.length ? <div className="group flat">{recent.slice(0, SHOW).map((i) => itemRow(i, <span className="sub">{new Date(i.createdAt).toLocaleDateString("ja-JP")}</span>))}</div>
                  : <p className="dash-empty">まだ何も登録されていません</p>}
                {recent.length > SHOW && <Link to="/" className="kv linkish"><span>もっと見る</span><span>{`残り ${recent.length - SHOW} 件 ›`}</span></Link>}
              </div>
            </section>
            {admin && cat.storage && (
              <section className="card glass">
                <div className="card-h"><h4>保存先とバックアップ</h4><Link to="/storage" className="btn sm">設定</Link></div>
                <div className="card-b">
                  <div className="kv"><span>保存先</span><span translate={cat.storage.name ? "no" : undefined}>{cat.storage.name || "ローカル"}</span></div>
                  <div className="kv"><span>自動バックアップ</span><span>{backup?.enabled ? `毎日 ${backup.time}` : "設定されていません"}</span></div>
                </div>
              </section>
            )}
          </div>
          <div className="dcol">
            <section className="card glass">
              <div className="card-h"><h4>種類ごとの件数</h4></div>
              <div className="card-b">
                {counts.length ? counts.map(([t, n]) => (
                  <Link key={t} to="/" search={{ type: t }} className="barrow" title={`${ITEM_TYPES[t]}: ${n} 件`}>
                    <span className="lab"><span className="ic sm"><ItemIcon type={t} /></span><span>{ITEM_TYPES[t]}</span></span>
                    <span className="track"><span className="fill" style={{ width: `${(n / max) * 100}%` }} /></span><span className="n">{n}</span>
                  </Link>
                )) : <p className="dash-empty">まだ何も登録されていません</p>}
              </div>
            </section>
            <section className="card glass">
              <div className="card-h"><h4>確認が必要なもの</h4>{edit && <Link to="/cleanup" className="btn sm tint"><Icon name="wand" />整理</Link>}</div>
              <div className="card-b">
                {noMc > 0 && <Link to="/" search={{ f: "nomc" }} className="kv linkish"><span>対応 MC が不明</span><span>{`${noMc} 件 ›`}</span></Link>}
                <Link to="/" search={{ f: "deps" }} className="kv linkish"><span>前提不足</span><span>確かめる ›</span></Link>
                {items.length > linked.length && <div className="kv"><span>配布元が未設定</span><span>{`${items.length - linked.length} 件`}</span></div>}
              </div>
            </section>
            <section className="card glass">
              <div className="card-h"><h4>サーバー</h4></div>
              <div className="card-b">
                {cat.servers.length === 0 && <p className="dash-empty">まだサーバーがありません</p>}
                {cat.servers.length > 0 && (
                  <div className="group flat">
                    {cat.servers.map((s) => {
                      const n = items.filter((i) => i.installs.some((x) => x.serverId === s.id)).length;
                      const behind = old ? [...old.values()].filter((ids) => ids.includes(s.id)).length : null;
                      return (
                        <Link key={s.id} to="/servers/$id" params={{ id: s.id }} className="row click">
                          <span className="ic"><span className="icon-ph t-server"><Icon name="servers" /></span></span>
                          <span className="mid"><span className="ttl" translate="no">{s.name}</span><span className="sub">{`${n} 件を管理中`}</span></span>
                          {behind !== null && (behind ? <span className="badge upd">{`未同期 ${behind}`}</span> : <span className="badge ok">同期済み</span>)}
                          <span className="chev" aria-hidden="true">›</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
            <section className="card glass">
              <div className="card-h"><h4>配布元の連携</h4></div>
              <div className="card-b">
                <div className="meter" title={`${linked.length} / ${items.length} 件`}><i style={{ width: `${pct}%` }} /></div>
                <div className="kv"><span>連携済み</span><span>{`${linked.length} 件`}</span></div>
                <div className="kv"><span>未連携</span><span>{`${items.length - linked.length} 件`}</span></div>
              </div>
            </section>
          </div>
        </div>
      </>}
    </main>
  );
}

// 数のカード(押すとその一覧へ)
function Tile({ to, search, icon, k, v, s, warn }: { to: string; search?: { f: "upd" }; icon: IconName; k: string; v: ReactNode; s: string; warn?: boolean }) {
  return (
    <Link to={to as "/"} search={search} className={`tile glass${warn ? " warn" : ""}`}>
      <span className="k"><Icon name={icon} />{k}</span>
      <span className="v">{v}</span>
      <span className="s">{s}</span>
    </Link>
  );
}
