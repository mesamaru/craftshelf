import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { libraryCatalog, outdatedLibraryServers } from "~/lib/library-api";
import { listBackups } from "~/lib/backup-api";
import { CUSTOM_TYPES, type Custom, type CustomType, DASH_DEFAULT, DASH_LIMITS, DASH_WIDGETS, type DashLayout, cleanDash, newCustomId } from "~/lib/dash";
import { CustomWidget, customName } from "~/lib/dash-widgets";
import { LIBRARY_CHANGED } from "~/lib/library-add";
import { saveMyDash } from "~/lib/prefs-api";
import { ITEM_TYPES, ITEM_TYPE_IDS } from "~/lib/platforms";
import { MobileSearch, StoragePill } from "~/lib/shell";
import { AddonIcon } from "~/lib/type-icon";
import { Btn, Chip, Icon, type IconName, fmtSize } from "~/lib/ui";
import { useCan, useTeamKey } from "~/lib/use-can";

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
const NAMES = Object.fromEntries(DASH_WIDGETS) as Record<string, string>;

// ホーム(v02 のダッシュボード): 数のカード・更新があるもの・最近追加したもの・種類ごとの件数・確認が必要なもの・サーバー・配布元の連携。
// 「ウィジェットを編集」で、並べ替え・表示 / 非表示・全幅・メモ / ToDo / 時計 / 今日の日付の追加ができる(並びはアカウントに保存)
function Home() {
  const { user } = Route.useRouteContext();
  const teamKey = useTeamKey();
  const { can } = useCan(user.id);
  const load = useServerFn(libraryCatalog);
  const outdated = useServerFn(outdatedLibraryServers);
  const save = useServerFn(saveMyDash);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [old, setOld] = useState<Map<string, string[]> | null>(null); // 古い版のあるアイテム → サーバー(「今すぐ確認」で配布元に問い合わせる)
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<DashLayout>(() => cleanDash(user.dash ?? DASH_DEFAULT));
  const [edit, setEdit] = useState(false);
  const [drag, setDrag] = useState("");
  const [adding, setAdding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reload = () => { load().then((c) => { setCat(c); setError(""); }, (e) => setError(message(e))); };
  useEffect(() => { if (teamKey !== null) reload(); }, [teamKey]); // チームが分かってから 1 回だけ
  useEffect(() => {
    window.addEventListener(LIBRARY_CHANGED, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED, reload);
  }, []);
  // 並びを直す: すぐ画面に出し、少し待ってから(続けて直すときは最後の 1 回を)アカウントに保存する
  const put = (next: DashLayout, delay = 0) => {
    const v = cleanDash(next);
    setLayout(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save({ data: { layout: v } }).then(() => setError(""), (e) => setError(message(e))), delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const check = () => {
    setChecking(true);
    setError("");
    outdated({ data: { fresh: true } }).then((r) => setOld(new Map(r.map((x) => [x.itemId, x.serverIds]))), (e) => setError(message(e))).finally(() => setChecking(false));
  };
  const editor = can({ library: ["edit"] });
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
      <AddonIcon type={i.projectType} url={i.iconUrl} />
      <span className="mid"><span className="ttl" translate="no">{i.title}</span><span className="sub" translate="no">{i.version || ITEM_TYPES[i.projectType as keyof typeof ITEM_TYPES]}</span></span>
      {trail}<span className="chev" aria-hidden="true">›</span>
    </Link>
  );

  // 標準のウィジェット(ライブラリを読んだあとで作る)。出さないもの(保存先が無いときの「保存先とバックアップ」)は入れない
  const nodes: Record<string, ReactNode> = cat ? {
    tiles: (
      <div className="tiles">
        <Tile to="/" icon="library" k="登録しているもの" v={<>{items.length}<small>件</small></>} s={`${files} ファイル`} />
        <Tile to={admin && cat.storage ? "/storage" : "/"} icon="disk" k="使っている容量" v={fmtSize(size)} s={cat.storage ? cat.storage.name || "ローカル" : ""} />
        <Tile to="/" search={{ f: "upd" }} icon="reload" k="更新があるもの" warn={upd.length > 0} v={<>{old ? upd.length : "—"}<small>件</small></>} s={`${linked.length} 件を確認対象にしています`} />
        <Tile to="/" icon="link" k="配布元の連携" v={<>{pct}<small>%</small></>} s={`${linked.length} / ${items.length} 件`} />
      </div>
    ),
    updates: (
      <section className="card glass">
        <div className="card-h"><h4>更新があるもの</h4></div>
        <div className="card-b">
          {upd.length > 0 ? <div className="group flat">{upd.slice(0, SHOW).map((i) => itemRow(i, <span className="badge upd">{`${old!.get(i.id)!.length} 台`}</span>))}</div>
            : <p className="dash-empty">{!old ? "確かめると、ここに更新が出ます" : linked.length ? "すべて最新です" : "配布元のあるものを足すと、ここに更新が出ます"}</p>}
          {upd.length > SHOW && <Link to="/" search={{ f: "upd" }} className="kv linkish"><span>もっと見る</span><span>{`残り ${upd.length - SHOW} 件 ›`}</span></Link>}
          <div className="chips"><Btn kind="tint" sm disabled={checking} onClick={check}><Icon name="reload" />{checking ? "確かめています…" : "今すぐ確認"}</Btn></div>
        </div>
      </section>
    ),
    recent: (
      <section className="card glass">
        <div className="card-h"><h4>最近追加したもの</h4></div>
        <div className="card-b">
          {recent.length ? <div className="group flat">{recent.slice(0, SHOW).map((i) => itemRow(i, <span className="sub">{new Date(i.createdAt).toLocaleDateString("ja-JP")}</span>))}</div>
            : <p className="dash-empty">まだ何も登録されていません</p>}
          {recent.length > SHOW && <Link to="/" className="kv linkish"><span>もっと見る</span><span>{`残り ${recent.length - SHOW} 件 ›`}</span></Link>}
        </div>
      </section>
    ),
    cats: (
      <section className="card glass">
        <div className="card-h"><h4>種類ごとの件数</h4></div>
        <div className="card-b">
          {counts.length ? counts.map(([t, n]) => (
            <Link key={t} to="/" search={{ type: t }} className="barrow" title={`${ITEM_TYPES[t]}: ${n} 件`}>
              <span className="lab"><AddonIcon type={t} size="sm" /><span>{ITEM_TYPES[t]}</span></span>
              <span className="track"><span className="fill" style={{ width: `${(n / max) * 100}%` }} /></span><span className="n">{n}</span>
            </Link>
          )) : <p className="dash-empty">まだ何も登録されていません</p>}
        </div>
      </section>
    ),
    attention: (
      <section className="card glass">
        <div className="card-h"><h4>確認が必要なもの</h4>{editor && <Link to="/cleanup" className="btn sm tint"><Icon name="wand" />整理</Link>}</div>
        <div className="card-b">
          {noMc > 0 && <Link to="/" search={{ f: "nomc" }} className="kv linkish"><span>対応 MC が不明</span><span>{`${noMc} 件 ›`}</span></Link>}
          <Link to="/" search={{ f: "deps" }} className="kv linkish"><span>前提不足</span><span>確かめる ›</span></Link>
          {items.length > linked.length && <div className="kv"><span>配布元が未設定</span><span>{`${items.length - linked.length} 件`}</span></div>}
        </div>
      </section>
    ),
    servers: (
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
    ),
    links: (
      <section className="card glass">
        <div className="card-h"><h4>配布元の連携</h4></div>
        <div className="card-b">
          <div className="meter" title={`${linked.length} / ${items.length} 件`}><i style={{ width: `${pct}%` }} /></div>
          <div className="kv"><span>連携済み</span><span>{`${linked.length} 件`}</span></div>
          <div className="kv"><span>未連携</span><span>{`${items.length - linked.length} 件`}</span></div>
        </div>
      </section>
    ),
    ...(admin && cat.storage ? { storage: (
      <section className="card glass">
        <div className="card-h"><h4>保存先とバックアップ</h4><Link to="/storage" className="btn sm">設定</Link></div>
        <div className="card-b">
          <div className="kv"><span>保存先</span><span translate={cat.storage.name ? "no" : undefined}>{cat.storage.name || "ローカル"}</span></div>
          <div className="kv"><span>自動バックアップ</span><span>{backup?.enabled ? `毎日 ${backup.time}` : "設定されていません"}</span></div>
        </div>
      </section>
    ) } : {}),
  } : {};
  for (const c of layout.custom) nodes[c.id] = <CustomWidget c={c} change={(fn, delay) => put({ ...layout, custom: layout.custom.map((x) => (x.id === c.id ? fn(x) : x)) }, delay ?? 400)} />;

  // 並び替え・表示 / 非表示・幅・削除
  const nameOf = (k: string) => NAMES[k] ?? customName(layout.custom.find((c) => c.id === k) ?? { title: "", type: "memo" } as Custom);
  const move = (k: string, to: number) => {
    const order = layout.order.filter((x) => x !== k);
    order.splice(Math.max(0, Math.min(order.length, to)), 0, k);
    put({ ...layout, order });
  };
  const toggle = (list: "hidden" | "full", k: string) => put({ ...layout, [list]: layout[list].includes(k) ? layout[list].filter((x) => x !== k) : [...layout[list], k] });
  const remove = (k: string) => {
    if (!confirm(`「${nameOf(k)}」を消しますか?`)) return;
    put({ ...layout, custom: layout.custom.filter((c) => c.id !== k), order: layout.order.filter((x) => x !== k) });
  };
  const add = (type: CustomType) => {
    if (layout.custom.length >= DASH_LIMITS.custom) return setError(`足せるウィジェットは ${DASH_LIMITS.custom} 個までです`);
    const id = newCustomId();
    const c: Custom = { id, type, title: "", text: "", md: type === "memo", items: [], style: "digital" };
    put({ ...layout, custom: [...layout.custom, c], order: [id, ...layout.order] });
  };
  const shown = layout.order.filter((k) => nodes[k] && (edit || !layout.hidden.includes(k)));
  const wrap = (k: string) => {
    const off = layout.hidden.includes(k);
    const i = layout.order.indexOf(k);
    return (
      <div key={k} className={`widget${off ? " off" : ""}${edit ? " editing" : ""}${drag === k ? " dragging" : ""}`}
        draggable={edit} onDragStart={(e) => { if (edit) { setDrag(k); e.dataTransfer.effectAllowed = "move"; } }} onDragEnd={() => setDrag("")}
        onDragOver={(e) => { if (drag && drag !== k) e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); if (drag && drag !== k) move(drag, layout.order.indexOf(k)); setDrag(""); }}>
        {edit && (
          <div className="wbar">
            <span className="whandle" title="ドラッグで並べ替え" aria-hidden="true"><Icon name="grip" /></span>
            <span className="wname" translate={layout.custom.find((c) => c.id === k)?.title ? "no" : undefined}>{nameOf(k)}</span>
            <span className="grow" />
            <button type="button" className="rbtn sm" aria-label="前へ" title="前へ" disabled={i === 0} onClick={() => move(k, i - 1)}><Icon name="up" /></button>
            <button type="button" className="rbtn sm" aria-label="後ろへ" title="後ろへ" disabled={i === layout.order.length - 1} onClick={() => move(k, i + 1)}><Icon name="down" /></button>
            <button type="button" className="rbtn sm" aria-pressed={layout.full.includes(k)} aria-label={layout.full.includes(k) ? "半分の幅にする" : "全幅にする"} title={layout.full.includes(k) ? "半分の幅にする" : "全幅にする"} onClick={() => toggle("full", k)}><Icon name={layout.full.includes(k) ? "shrink" : "expand"} /></button>
            <button type="button" className="rbtn sm" aria-pressed={off} aria-label={off ? "表示する" : "非表示にする"} title={off ? "表示する" : "非表示にする"} onClick={() => toggle("hidden", k)}><Icon name={off ? "eyeoff" : "eye"} /></button>
            {layout.custom.some((c) => c.id === k) && <button type="button" className="rbtn sm red" aria-label="消す" title="消す" onClick={() => remove(k)}><Icon name="trash" /></button>}
          </div>
        )}
        {nodes[k]}
      </div>
    );
  };
  // 全幅のウィジェットは 1 本ずつ、ほかは続くものを 2 列にまとめて(CSS の columns。狭いときは 1 列)並べる
  const blocks: ReactNode[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length) blocks.push(<div className="dash" key={`r${run[0]}`}>{run.map(wrap)}</div>); run = []; };
  for (const k of shown) { if (layout.full.includes(k)) { flush(); blocks.push(wrap(k)); } else run.push(k); }
  flush();

  return (
    <main className="page fill">
      <header className="bar"><h1>ホーム</h1><StoragePill /></header>
      <MobileSearch />
      {error && <p className="error" role="alert">{error}</p>}
      {!cat && !error && <p className="muted">読み込んでいます…</p>}
      {cat && <>
        <div className="dash-top">
          {edit ? <>
            <Btn kind="tint" sm aria-expanded={adding} onClick={() => setAdding(!adding)}>＋ ウィジェットを追加</Btn>
            <Btn sm onClick={() => put(cleanDash({ ...DASH_DEFAULT, custom: layout.custom }))}>初期状態に戻す</Btn>
            <Btn kind="pri" sm onClick={() => { setEdit(false); setAdding(false); }}>完了</Btn>
          </> : <Btn sm onClick={() => setEdit(true)}><Icon name="edit" />ウィジェットを編集</Btn>}
        </div>
        {edit && adding && <div className="chips" role="group" aria-label="足すウィジェット">{Object.entries(CUSTOM_TYPES).map(([t, n]) => <Chip key={t} onClick={() => { add(t as CustomType); setAdding(false); }}>{n}</Chip>)}</div>}
        <div className={`widgets${edit ? " editing" : ""}`}>{blocks}</div>
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
