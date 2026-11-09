import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { authClient } from "~/lib/auth-client";
import { addLibraryItem, addLibraryItemFromUrl, editLibraryItem, favoriteLibraryItem, installMod, libraryCatalog, libraryItemChangelog, libraryItemVersions, libraryMissingDeps,
  linkLibraryDep, modpackFromItem, outdatedLibraryItems, relinkLibraryItem, removeLibraryItem, searchCatalog, setLibraryChannel, tagLibraryItems } from "~/lib/library-api";
import { ITEM_TYPES, ITEM_TYPE_IDS, type ItemType, mcCompare, mcCovers, mcRange } from "~/lib/platforms";
import { ItemIcon } from "~/lib/type-icon";
import { localEnabled } from "~/lib/servers-api";
import { CHANNELS, SOURCE_LABEL, type Channel, type ItemSource, type Source, isItemSource, pageUrl } from "~/lib/sources";
import { removeUploadedFile, uploadedFiles } from "~/lib/uploads-api";
import { ShareMaker } from "~/lib/share-maker";
import { saveVersion, setItemSaved, zipPlan } from "~/lib/saved-api";
import { downloadZip } from "~/lib/zip-download";
import { useCan } from "~/lib/use-can";
import { Bell } from "~/lib/bell";
import { OPEN_PALETTE } from "~/lib/palette";
import { markNoticesSeen, recentEvents } from "~/lib/events-api";
import { listSets, toggleSetItem } from "~/lib/sets-api";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Home,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = ITEM_TYPES;

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type CatItem = Catalog["items"][number];
type DepInfo = Awaited<ReturnType<typeof libraryMissingDeps>>["items"][number]["servers"];

// 一覧の絞り込み・並べ替え。oldIds は「更新あり」、depIds は「前提が足りない」を確かめた結果(確かめるまでは null)。mc は対応 MC で絞る
type Filter = { q: string; type: string; source: string; tag: string; mc: string; sort: "name" | "new"; old: boolean; oldIds: Set<string> | null;
  deps: boolean; depIds: Map<string, DepInfo> | null };
const NO_FILTER: Filter = { q: "", type: "", source: "", tag: "", mc: "", sort: "name", old: false, oldIds: null, deps: false, depIds: null };

// お気に入りを上に。あとは名前順(サーバーから名前順で来る)か、追加日が新しい順
function filterItems(items: CatItem[], f: Filter) {
  const q = f.q.trim().toLowerCase();
  return items
    .filter((i) => (!q || i.title.toLowerCase().includes(q)) && (!f.type || i.projectType === f.type) && (!f.source || i.source === f.source)
      && (!f.tag || i.tags.includes(f.tag)) && (!f.old || !!f.oldIds?.has(i.id)) && (!f.mc || mcCovers(i.mc, f.mc)) && (!f.deps || !!f.depIds?.has(i.id)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (f.sort === "new" ? b.createdAt.localeCompare(a.createdAt) : 0));
}

function Filters({ cat, f, setF }: { cat: Catalog; f: Filter; setF: (fn: (f: Filter) => Filter) => void }) {
  const outdated = useServerFn(outdatedLibraryItems);
  const missing = useServerFn(libraryMissingDeps);
  const mcs = [...new Set(cat.items.flatMap((i) => i.mc))].sort(mcCompare).reverse();
  const [error, setError] = useState("");
  const tags = [...new Set(cat.items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, "ja"));
  const sources = [...new Set(cat.items.map((i) => i.source))];
  const set = (p: Partial<Filter>) => setF((x) => ({ ...x, ...p }));
  const toggleOld = () => {
    if (f.old) return set({ old: false });
    set({ old: true });
    setError("");
    if (!f.oldIds) outdated().then((ids) => set({ oldIds: new Set(ids) }), (e) => { setError(message(e)); set({ old: false }); });
  };
  const toggleDeps = () => {
    if (f.deps) return set({ deps: false });
    set({ deps: true });
    setError("");
    if (!f.depIds) missing({ data: {} }).then((r) => set({ depIds: new Map(r.items.map((x) => [x.itemId, x.servers])) }), (e) => { setError(message(e)); set({ deps: false }); });
  };
  return (
    <section className="group">
      <input className="row" type="search" placeholder="名前で絞り込む" aria-label="名前で絞り込む" value={f.q} onChange={(e) => set({ q: e.target.value })} />
      <div className="row filters">
        <select value={f.type} aria-label="種類" onChange={(e) => set({ type: e.target.value })}>
          <option value="">すべての種類</option>
          {ITEM_TYPE_IDS.map((t) => <option key={t} value={t}>{ITEM_TYPES[t]}</option>)}
        </select>
        <select value={f.source} aria-label="配布元" onChange={(e) => set({ source: e.target.value })}>
          <option value="">すべての配布元</option>
          {sources.map((s) => <option key={s} value={s}>{isItemSource(s) ? SOURCE_LABEL[s] : s}</option>)}
        </select>
        {mcs.length > 0 && (
          <select value={f.mc} aria-label="対応 MC" onChange={(e) => set({ mc: e.target.value })}>
            <option value="">すべての MC</option>
            {mcs.map((v) => <option key={v} value={v}>{`MC ${v}`}</option>)}
          </select>
        )}
        <select value={f.sort} aria-label="並べ替え" onChange={(e) => set({ sort: e.target.value as Filter["sort"] })}>
          <option value="name">名前順</option>
          <option value="new">追加日が新しい順</option>
        </select>
      </div>
      <div className="row">
        <span className="seg">
          <button type="button" className={f.old ? "on" : ""} aria-pressed={f.old} onClick={toggleOld}
            title="どこかのサーバーに古い版が入っているもの(配布元に問い合わせます。更新を止めたものは除きます)">
            {f.old && !f.oldIds ? "確かめています…" : "更新あり"}
          </button>
          <button type="button" className={f.deps ? "on" : ""} aria-pressed={f.deps} onClick={toggleDeps}
            title="入っているサーバーに、必須の前提が無いもの(配布元に問い合わせます)">
            {f.deps && !f.depIds ? "確かめています…" : "前提が足りない"}
          </button>
          {tags.map((t) => (
            <button key={t} type="button" className={f.tag === t ? "on" : ""} aria-pressed={f.tag === t} onClick={() => set({ tag: f.tag === t ? "" : t })}>
              <span translate="no">#{t}</span>
            </button>
          ))}
        </span>
      </div>
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

// チェックで選んだものをまとめて: タグを付ける・セットに足す・ライブラリから外す
function Bulk({ ids, share, onDone }: { ids: string[]; share: boolean; onDone: (clear: boolean) => void }) {
  const tag = useServerFn(tagLibraryItems);
  const plan = useServerFn(zipPlan);
  const toSet = useServerFn(toggleSetItem);
  const remove = useServerFn(removeLibraryItem);
  const loadSets = useServerFn(listSets);
  const [sets, setSets] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { loadSets().then(setSets, () => setSets([])); }, []);
  const run = async (fn: () => Promise<string>, clear: boolean) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote(await fn());
      onDone(clear);
    } catch (e) {
      setError(message(e));
      onDone(false);
    } finally {
      setBusy(false);
    }
  };
  const addTag = () => {
    const t = prompt("付けるタグ(30 文字まで)")?.trim();
    if (t) run(async () => { await tag({ data: { itemIds: ids, tag: t, on: true } }); return `タグ「${t}」を付けました`; }, false);
  };
  const addToSet = (setId: string) => {
    const s = sets.find((x) => x.id === setId);
    if (s) run(async () => { for (const itemId of ids) await toSet({ data: { id: setId, itemId, add: true } }); return `セット「${s.name}」に足しました`; }, false);
  };
  const removeAll = () => {
    if (confirm(`${ids.length} 件をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`)) {
      run(async () => { for (const itemId of ids) await remove({ data: { itemId } }); return `${ids.length} 件を外しました`; }, true);
    }
  };
  return (
    <section className="group">
      <div className="row">
        <span className="main strong">{`${ids.length} 件を選んでいます`}</span>
        {busy && <span className="trail muted">しています…</span>}
      </div>
      <div className="row filters">
        <button className="link" type="button" disabled={busy} onClick={addTag}>タグを付ける</button>
        {sets.length > 0 && (
          <select value="" disabled={busy} aria-label="セットに足す" onChange={(e) => addToSet(e.target.value)}>
            <option value="">セットに足す…</option>
            {sets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
          </select>
        )}
        {share && <button className="link" type="button" disabled={busy} onClick={() => downloadZip(plan, { itemIds: ids }).catch((e) => setError(message(e)))}>zip でダウンロード</button>}
        <button className="link danger" type="button" disabled={busy} onClick={removeAll}>ライブラリから外す</button>
      </div>
      {share && <div className="row"><ShareMaker key={ids.join()} itemIds={ids} name="" label="共有リンクを作る(アップロード・保存した版のあるものだけ。2 件以上は zip)" /></div>}
      {note && <p className="row muted" role="status">{note}</p>}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

// ライブラリ: チームで使う Mod・プラグインの目録(どのサーバーにどの版が入っているか・サーバーに入れる)
function Home() {
  const { user } = Route.useRouteContext();
  const { data: team } = authClient.useActiveOrganization();
  const { can } = useCan(user.id);
  const load = useServerFn(libraryCatalog);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const reload = () => { load().then((c) => { setCat(c); setError(""); }, (e) => setError(message(e))); };
  useEffect(reload, [team?.id]);
  const isLocal = useServerFn(localEnabled);
  const [uploads, setUploads] = useState(false); // アップロードは自分用の版だけ
  useEffect(() => { isLocal().then(setUploads, () => setUploads(false)); }, []);

  const edit = can({ library: ["edit"] });
  const [f, setF] = useState<Filter>(NO_FILTER);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const shown = cat ? filterItems(cat.items, f) : [];
  const favorite = useServerFn(favoriteLibraryItem);
  const missing = useServerFn(libraryMissingDeps);
  // 前提を入れたら、「前提が足りない」を確かめ直す
  const refreshDeps = () => { missing({ data: {} }).then((r) => setF((x) => ({ ...x, depIds: new Map(r.items.map((d) => [d.itemId, d.servers])) })), () => {}); };
  // 先に画面を変え、うまくいかなければ読み直す
  const toggleFavorite = (item: CatItem) => {
    setCat((c) => c && { ...c, items: c.items.map((x) => (x.id === item.id ? { ...x, favorite: !item.favorite } : x)) });
    favorite({ data: { itemId: item.id, on: !item.favorite } }).catch((e) => { setError(message(e)); reload(); });
  };
  return (
    <main className="page narrow">
      <header className="bar">
        <h1>ライブラリ</h1>
        <button type="button" className="capsule small" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))} title="Ctrl+K でも開けます">検索</button>
        <Link to="/team" className="capsule" aria-label="チーム">
          <span translate="no">{team?.name ?? "チーム"}</span>
        </Link>
        <Link to="/settings" className="capsule" aria-label="アカウントの設定">
          <span translate="no">{user.name}</span>
        </Link>
        <Notices />
      </header>
      {can({ member: ["update"] }) && cat && <Guide cat={cat} members={team?.members.length ?? 1} />}
      <section className="group">
        <Link to="/servers" className="row link">サーバー(起動・停止・パネルの登録)</Link>
        <Link to="/sets" className="row link">セット(まとめてサーバーに入れる)</Link>
        {edit && <Link to="/cleanup" className="row link">アドオンの整理(古い版・重複・使っていないもの)</Link>}
      </section>

      <div className="group-title">Mod・プラグインなど</div>
      {cat && cat.items.length > 0 && <Filters cat={cat} f={f} setF={setF} />}
      {edit && picked.size > 0 && <Bulk ids={[...picked]} share={uploads} onDone={(clear) => { if (clear) setPicked(new Set()); reload(); }} />}
      <section className="group">
        {!cat && !error && <div className="row muted">読み込んでいます…</div>}
        {cat?.items.length === 0 && <div className="row muted">まだ何もありません。サーバーに入れたものは自動でここに載ります。下の「配布元から足す」でも登録できます。</div>}
        {cat && cat.items.length > 0 && shown.length === 0 && <div className="row muted">{f.old && !f.oldIds ? "更新を確かめています…" : "条件に合うものはありません"}</div>}
        {edit && shown.length > 1 && (
          <button className="row link" type="button" onClick={() => setPicked(shown.every((i) => picked.has(i.id)) ? new Set() : new Set(shown.map((i) => i.id)))}>
            {shown.every((i) => picked.has(i.id)) ? "選ぶのをやめる" : `表示している ${shown.length} 件をすべて選ぶ`}
          </button>
        )}
        {cat && shown.map((i) => <Item key={i.id} item={i} cat={cat} servers={cat.servers} edit={edit} admin={can({ member: ["update"] })} local={uploads} depInfo={f.depIds?.get(i.id)}
          onChange={reload} onDeps={refreshDeps} onFavorite={() => toggleFavorite(i)}
          picked={picked.has(i.id)} onPick={(on) => setPicked((p) => { const n = new Set(p); if (on) n.add(i.id); else n.delete(i.id); return n; })} />)}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">チームで使う Mod・プラグインの一覧です。Modrinth・SpigotMC のものは、サーバーが配布元から直接取り込みます(アップロードしたもの・保存した版は、保存先から送ります)。入れる版は、サーバーの種類とバージョンに合うものを選びます(Paper のサーバーには Paper 向けの作りを優先)。</p>
      <p className="foot">データパックは、サーバーのワールド(server.properties の level-name)の datapacks に入れます。リソースパック・シェーダーはクライアントで使うものなので、ライブラリで持ち、「詳しく」の版からダウンロードできます。Modパックからは、セットを作ったり、サーバーに中の Mod と設定ファイルを入れたりできます(新しい版が出たらお知らせします)。</p>

      {can({ member: ["update"] }) && cat && <TeamChannel value={cat.channel} onDone={reload} />}
      {edit && uploads && <Upload onDone={reload} />}
      {edit && cat && <AddFromSource sources={cat.sources as Source[]} have={new Set(cat.items.map((i) => `${i.source}:${i.projectId}`))} onAdded={reload} />}
    </main>
  );
}

function Item({ item, cat, servers, edit, admin, local, depInfo, onChange, onDeps, onFavorite, picked, onPick }:
  { item: CatItem; cat: Catalog; servers: Catalog["servers"]; edit: boolean; admin: boolean; local: boolean; depInfo?: DepInfo; onChange: () => void; onDeps: () => void; onFavorite: () => void;
    picked: boolean; onPick: (on: boolean) => void }) {
  const [detail, setDetail] = useState(false);
  const channel: Channel = item.channel || cat.channel;
  const install = useServerFn(installMod);
  const remove = useServerFn(removeLibraryItem);
  const tag = useServerFn(tagLibraryItems);
  const [busy, setBusy] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const [error, setError] = useState("");
  const have = new Set(item.installs.map((x) => x.serverId));
  // データパックはワールドのあるサーバーに。リソースパック・シェーダーはサーバーに入れない。Modパックは Mod のサーバーに中身を入れる(設定ファイルも書くので管理者以上)
  const pack = item.projectType === "modpack";
  const targets = pack ? (admin ? servers.filter((s) => s.type === "mod") : []) : servers.filter((s) => s.kinds.includes(item.projectType as ItemType) && !have.has(s.id));
  const fromPack = useServerFn(modpackFromItem);
  const [note, setNote] = useState("");
  const packRun = (serverId?: string) => run(serverId ?? "pack", async () => {
    const r = await fromPack({ data: { itemId: item.id, serverId } });
    const failed = r.applied?.filter((x) => x.status === "failed").length ?? 0;
    setNote(`セット「${r.name}」を作りました(${r.added} 件)${r.applied ? `。サーバーに入れました(失敗 ${failed} 件)` : ""}`);
  });
  const newer = item.pack?.used && item.pack.latest && item.pack.latest.id !== item.pack.used.id ? item.pack.latest : null;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="row hit">
      {edit && <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`${item.title} を選ぶ`} />}
      <ItemIcon type={item.projectType} url={item.iconUrl} />
      <span className="main">
        {pageUrl(item.source, item.projectId, item.slug)
          ? <a href={pageUrl(item.source, item.projectId, item.slug)} target="_blank" rel="noreferrer noopener" translate="no">{item.title}</a>
          : <span translate="no" className="strong">{item.title}</span>}
        <span className="muted">
          {TYPE_LABEL[item.projectType] ?? item.projectType} · {isItemSource(item.source) ? SOURCE_LABEL[item.source] : item.source}{item.mc.length > 0 && ` · MC ${mcRange(item.mc)}`}
          {pack ? (item.pack?.used ? <> · <span translate="no">{`使った版 ${item.pack.used.number}`}</span></> : "")
            : item.projectType === "resourcepack" || item.projectType === "shader" ? " · クライアントで使うもの"
            : <> · {item.installs.length
              ? <span translate="no">{item.installs.map((x) => `${x.serverName} ${x.versionNumber}`).join("、")}</span>
              : "どのサーバーにも入っていません"}</>}
        </span>
        {newer && <span><span className="badge" translate="no">{`新しい版 ${newer.number}`}</span></span>}
        {(item.tags.length > 0 || edit) && (
          <span>
            {item.tags.map((t) => edit
              ? <button key={t} type="button" className="badge muted-badge" title="押すとタグを外します" disabled={!!busy}
                  onClick={() => run("tag", () => tag({ data: { itemIds: [item.id], tag: t, on: false } }))}><span translate="no">#{t}</span> ×</button>
              : <span key={t} className="badge muted-badge" translate="no">#{t}</span>)}
            {edit && <button className="link small" type="button" disabled={!!busy}
              onClick={() => { const t = prompt("付けるタグ(30 文字まで)")?.trim(); if (t) run("tag", () => tag({ data: { itemIds: [item.id], tag: t, on: true } })); }}>+ タグ</button>}
          </span>
        )}
        {channel === "all" && <span><span className="badge muted-badge">ベータ版も受け取る</span></span>}
        {busy && busy !== "tag" && <span className="muted">{busy === "remove" ? "外しています…" : busy === "pack" ? "Modパックを読んでいます…" : "サーバーに入れています…"}</span>}
        {note && <span className="muted" role="status" translate="no">{note}</span>}
        {error && <span className="error" role="alert">{error}</span>}
        {pack && edit && <button className="link small" type="button" disabled={!!busy} onClick={() => packRun()}>{newer ? "新しい版でセットを作る" : "セットを作る"}</button>}
        {item.source === "upload" && <button className="link small" type="button" onClick={() => setShowFiles((v) => !v)}>{showFiles ? "版を閉じる" : "版を見る"}</button>}
        {item.source !== "upload" && local && <button className="link small" type="button" onClick={() => setShowFiles((v) => !v)}>
          {showFiles ? "保存した版を閉じる" : item.files ? `保存した版(${item.files})` : "保存した版"}</button>}
        {showFiles && <Files item={item} keep={cat.keep} edit={edit} local={local} onChange={onChange} />}
        <button className="link small" type="button" onClick={() => setDetail((v) => !v)}>{detail ? "詳しくを閉じる" : "詳しく(前提・版と変更内容・情報)"}</button>
      </span>
      <button type="button" className="link star" aria-pressed={item.favorite} onClick={onFavorite}
        aria-label={item.favorite ? "お気に入りから外す" : "お気に入りにする"} title={item.favorite ? "お気に入りから外す" : "お気に入りにする"}>
        {item.favorite ? "★" : "☆"}
      </button>
      {edit && targets.length > 0 && (
        <select className="trail" value="" disabled={!!busy} aria-label={`${item.title} をサーバーに入れる`}
          onChange={(e) => {
            const sid = e.target.value;
            if (!sid || !isItemSource(item.source)) return;
            if (pack) {
              if (confirm("Modパックの中の Mod と設定ファイル(overrides)を、このサーバーに入れますか?(同じ名前のセットも作ります。上書きした設定ファイルは履歴から戻せます)")) packRun(sid);
            } else run(sid, () => install({ data: { id: sid, projectId: item.projectId, source: item.source as ItemSource } }));
          }}>
          <option value="">{pack ? "Modパックをサーバーに入れる…" : "サーバーに入れる…"}</option>
          {targets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
        </select>
      )}
      {edit && (
        <button className={`${targets.length ? "" : "trail "}link danger`} type="button" disabled={!!busy}
          onClick={() => confirm(`${item.title} をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`) && run("remove", () => remove({ data: { itemId: item.id } }))}>
          外す
        </button>
      )}
      {/* 前提の警告・詳しくは、行の下に全幅で出す */}
      {depInfo && <div className="full"><DepWarnings servers={depInfo} edit={edit} onInstalled={() => { onChange(); onDeps(); }} /></div>}
      {detail && <div className="full"><Detail item={item} cat={cat} edit={edit} admin={admin} local={local} onChange={onChange} /></div>}
    </div>
  );
}

// 必須の前提が無いサーバーと前提(ワンクリックで、そのサーバーに入れる)
function DepWarnings({ servers, edit, onInstalled }: { servers: DepInfo; edit: boolean; onInstalled: () => void }) {
  const install = useServerFn(installMod);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const add = async (serverId: string, d: DepInfo[number]["deps"][number]) => {
    setBusy(`${serverId}:${d.projectId}`);
    setError("");
    try {
      await install({ data: { id: serverId, projectId: d.projectId, source: d.source } });
      onInstalled();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <span className="files">
      {servers.flatMap((s) => s.deps.map((d) => (
        <span key={`${s.serverId}:${d.source}:${d.projectId}`} className="error">
          <span translate="no">{`${s.serverName}: ${d.title}`}</span> — 前提が入っていません
          {edit && <>{" "}<button className="link small" type="button" disabled={!!busy} onClick={() => add(s.serverId, d)}>
            {busy === `${s.serverId}:${d.projectId}` ? "入れています…" : "入れる"}</button></>}
        </span>
      )))}
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}

// アイテムの詳しい情報: 前提(手で決めたもの・サーバーに足りないもの)・版と変更内容・情報を直す(管理者以上)
function Detail({ item, cat, edit, admin, local, onChange }: { item: CatItem; cat: Catalog; edit: boolean; admin: boolean; local: boolean; onChange: () => void }) {
  const check = useServerFn(libraryMissingDeps);
  const link = useServerFn(linkLibraryDep);
  const [miss, setMiss] = useState<DepInfo | null>(null);
  const [error, setError] = useState("");
  // 前提はサーバーに入れるもの(プラグイン・Mod・データパック)だけ
  const onServer = item.projectType === "plugin" || item.projectType === "mod" || item.projectType === "datapack";
  const recheck = () => { if (onServer) check({ data: { itemId: item.id } }).then((r) => setMiss(r.items[0]?.servers ?? []), (e) => setError(message(e))); };
  useEffect(recheck, [item.id]);
  const titleOf = (id: string) => cat.items.find((i) => i.id === id)?.title ?? id;
  const others = cat.items.filter((i) => i.id !== item.id && !item.deps.includes(i.id));
  const setLink = (depItemId: string, on: boolean) => link({ data: { itemId: item.id, depItemId, on } }).then(() => { onChange(); recheck(); }, (e) => setError(message(e)));
  return (
    <span className="files detail">
      {onServer && <>
      <span className="strong">前提</span>
      <span>
        <span className="muted">手で決めた前提: </span>
        {item.deps.length === 0 && <span className="muted">なし</span>}
        {item.deps.map((id) => edit
          ? <button key={id} type="button" className="badge muted-badge" title="押すと前提から外します" onClick={() => setLink(id, false)}><span translate="no">{titleOf(id)}</span> ×</button>
          : <span key={id} className="badge muted-badge" translate="no">{titleOf(id)}</span>)}
        {edit && others.length > 0 && (
          <select value="" aria-label="前提を足す" onChange={(e) => e.target.value && setLink(e.target.value, true)}>
            <option value="">前提を足す…</option>
            {others.map((i) => <option key={i.id} value={i.id} translate="no">{i.title}</option>)}
          </select>
        )}
      </span>
      {miss === null && !error && <span className="muted">入っているサーバーの前提を確かめています…</span>}
      {miss?.length === 0 && <span className="muted">{item.installs.length ? "入っているサーバーに、前提はそろっています" : "どのサーバーにも入っていません"}</span>}
      {miss && miss.length > 0 && <DepWarnings servers={miss} edit={edit} onInstalled={() => { onChange(); recheck(); }} />}
      </>}
      {error && <span className="error" role="alert">{error}</span>}
      {item.source !== "upload" && <Versions item={item} canSave={edit && local && item.source !== "spigot"} onSaved={onChange} />}
      {admin && <EditInfo item={item} teamChannel={cat.channel} onDone={onChange} />}
    </span>
  );
}

// 配布元の版(新しい順)と、版ごとの変更内容(文字として出す)
const VERSION_TYPE: Record<string, string> = { beta: "ベータ", alpha: "アルファ" };
function Versions({ item, canSave, onSaved }: { item: CatItem; canSave: boolean; onSaved: () => void }) {
  const load = useServerFn(libraryItemVersions);
  const changelog = useServerFn(libraryItemChangelog);
  const save = useServerFn(saveVersion);
  const [saving, setSaving] = useState("");
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const doSave = (versionId: string) => {
    setSaving(versionId);
    setError("");
    save({ data: { itemId: item.id, versionId } }).then(() => { setSavedIds((x) => new Set(x).add(versionId)); onSaved(); }, (e) => setError(message(e))).finally(() => setSaving(""));
  };
  const [list, setList] = useState<Awaited<ReturnType<typeof libraryItemVersions>> | null>(null);
  const [open, setOpen] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => { load({ data: { itemId: item.id } }).then(setList, (e) => setError(message(e))); }, [item.id]);
  const toggle = async (v: NonNullable<typeof list>[number]) => {
    if (v.versionId in open) return setOpen(({ [v.versionId]: _, ...rest }) => rest);
    try {
      const text = v.changelog ?? (await changelog({ data: { itemId: item.id, versionId: v.versionId } })).text;
      setOpen((o) => ({ ...o, [v.versionId]: text.trim() || "(変更内容の記載はありません)" }));
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <span className="strong">{item.source === "spigot" ? "更新のお知らせ" : "版と変更内容"}</span>
      {!list && !error && <span className="muted">読み込んでいます…</span>}
      {list?.length === 0 && <span className="muted">版がありません</span>}
      {list?.map((v) => (
        <span key={v.versionId}>
          <span translate="no">{v.versionNumber}</span>
          {VERSION_TYPE[v.type] && <span className="badge muted-badge">{VERSION_TYPE[v.type]}</span>}
          <span className="muted small">{" "}{v.date ? new Date(v.date).toLocaleDateString("ja-JP") : ""}{v.mcVersions.length ? ` · MC ${mcRange(v.mcVersions)}` : ""}{v.loaders.length ? ` · ${v.loaders.join(" / ")}` : ""}</span>
          {" "}<button className="link small" type="button" aria-expanded={v.versionId in open} onClick={() => toggle(v)}>{v.versionId in open ? "閉じる" : "変更内容"}</button>
          {"url" in v && v.url && <>{" "}<a className="small" href={v.url} target="_blank" rel="noreferrer noopener">ダウンロード</a></>}
          {canSave && "url" in v && v.url && <>{" "}{savedIds.has(v.versionId) ? <span className="muted small">保存しました</span>
            : <button className="link small" type="button" disabled={!!saving} onClick={() => doSave(v.versionId)}>{saving === v.versionId ? "保存しています…" : "保存先に保存"}</button>}</>}
          {v.versionId in open && <pre className="changelog" translate="no">{open[v.versionId]}</pre>}
        </span>
      ))}
      {error && <span className="error" role="alert">{error}</span>}
    </>
  );
}

// アイテムの情報を直す(管理者以上): 種類・動く作り・対応 MC・受け取る版・配布元の付け替え
const listOf = (s: string) => (s.trim() ? s.split(/[,、\s]+/).filter(Boolean) : null);
function EditInfo({ item, teamChannel, onDone }: { item: CatItem; teamChannel: Channel; onDone: () => void }) {
  const save = useServerFn(editLibraryItem);
  const relink = useServerFn(relinkLibraryItem);
  const [type, setType] = useState(item.projectType);
  const [loaders, setLoaders] = useState((item.loaders ?? []).join(", "));
  const [mc, setMc] = useState((item.mcVersions ?? []).join(", "));
  const [channel, setChannel] = useState<string>(item.channel);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote(await fn());
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const doRelink = () => {
    if (!url.trim() || !confirm("配布元を付け替えますか?(サーバーに入っているものは、次の更新で新しいプロジェクトの版に入れ替わります)")) return;
    run(async () => { const r = await relink({ data: { itemId: item.id, url } }); setUrl(""); return `${r.title} に付け替えました`; });
  };
  return (
    <>
      <span className="strong">情報を直す</span>
      <label className="edit-field">
        <span className="muted small">種類</span>
        <select value={type} disabled={busy} onChange={(e) => setType(e.target.value)}>
          {ITEM_TYPE_IDS.map((t) => <option key={t} value={t}>{ITEM_TYPES[t]}</option>)}
        </select>
      </label>
      <label className="edit-field">
        <span className="muted small">動く作り(カンマで区切る。空なら配布元のとおり)</span>
        <input value={loaders} disabled={busy} placeholder="例: paper, spigot" onChange={(e) => setLoaders(e.target.value)} />
      </label>
      <label className="edit-field">
        <span className="muted small">対応 MC(カンマで区切る。空なら配布元のとおり)</span>
        <input value={mc} disabled={busy} placeholder="例: 1.20, 1.21.4" onChange={(e) => setMc(e.target.value)} />
      </label>
      <label className="edit-field">
        <span className="muted small">受け取る版(更新・入れるとき)</span>
        <select value={channel} disabled={busy} onChange={(e) => setChannel(e.target.value)}>
          <option value="">{`チームの既定(${CHANNELS[teamChannel]})`}</option>
          {(Object.keys(CHANNELS) as Channel[]).map((c) => <option key={c} value={c}>{CHANNELS[c]}</option>)}
        </select>
      </label>
      <button className="link small" type="button" disabled={busy}
        onClick={() => run(async () => { await save({ data: { itemId: item.id, projectType: type, loaders: listOf(loaders), mcVersions: listOf(mc), channel } }); return "保存しました"; })}>
        {busy ? "保存しています…" : "保存"}
      </button>
      {item.source !== "upload" && (
        <label className="edit-field">
          <span className="muted small">配布元を付け替える(別のプロジェクトのページの URL)</span>
          <input type="url" value={url} disabled={busy} placeholder="https://modrinth.com/plugin/…" onChange={(e) => setUrl(e.target.value)} />
        </label>
      )}
      {item.source !== "upload" && <button className="link small" type="button" disabled={busy || !url.trim()} onClick={doRelink}>付け替える</button>}
      {note && <span className="muted" role="status" translate="no">{note}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </>
  );
}

// 受け取る版のチームの既定(管理者以上)
function TeamChannel({ value, onDone }: { value: Channel; onDone: () => void }) {
  const save = useServerFn(setLibraryChannel);
  const [error, setError] = useState("");
  const change = (channel: string) => save({ data: { channel } }).then(() => { setError(""); onDone(); }, (e) => setError(message(e)));
  return (
    <>
      <div className="group-title">受け取る版</div>
      <section className="group">
        <label className="row">
          <span>チームの既定</span>
          <select className="trail" value={value} aria-label="受け取る版のチームの既定" onChange={(e) => change(e.target.value)}>
            {(Object.keys(CHANNELS) as Channel[]).map((c) => <option key={c} value={c}>{CHANNELS[c]}</option>)}
          </select>
        </label>
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">更新・サーバーに入れるときに、どの版を選ぶかです。「正式版だけ」でも、正式版が 1 つも無いものはベータ版を使います。アイテムごとに「詳しく」→「情報を直す」で変えられます。</p>
    </>
  );
}

// 配布元のページの URL から足す
function AddFromUrl({ onAdded }: { onAdded: () => void }) {
  const add = useServerFn(addLibraryItemFromUrl);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await add({ data: { url } });
      setNote(`${r.title} を足しました`);
      setUrl("");
      onAdded();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="group form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input className="row" type="url" placeholder="ページの URL(Modrinth・SpigotMC・CurseForge)" aria-label="配布元のページの URL" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      <button className="row link" type="submit" disabled={busy || !url.trim()}>{busy ? "足しています…" : "URL から足す"}</button>
      {note && <p className="row muted" role="status" translate="no">{note}</p>}
      {error && <p className="row error" role="alert">{error}</p>}
    </form>
  );
}

function AddFromSource({ sources, have, onAdded }: { sources: Source[]; have: Set<string>; onAdded: () => void }) {
  const search = useServerFn(searchCatalog);
  const add = useServerFn(addLibraryItem);
  const [source, setSource] = useState<Source>("modrinth");
  const [type, setType] = useState<ItemType>("plugin");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchCatalog>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const find = async (t = type, src = source) => {
    setError("");
    try {
      setHits(await search({ data: { query, type: t, source: src } }));
    } catch (e) {
      setError(message(e));
    }
  };

  const pick = async (projectId: string) => {
    setBusy(projectId);
    setError("");
    try {
      await add({ data: { projectId, source, type } });
      onAdded();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="group-title">配布元から足す</div>
      <AddFromUrl onAdded={onAdded} />
      <form className="group form" onSubmit={(e) => (e.preventDefault(), find())}>
        <div className="row">
          <span>配布元</span>
          <select className="trail" value={source} aria-label="配布元"
            onChange={(e) => { const src = e.target.value as Source; const t = src === "spigot" ? "plugin" : type; setSource(src); setType(t); if (hits) find(t, src); }}>
            {sources.map((x) => <option key={x} value={x}>{SOURCE_LABEL[x]}</option>)}
          </select>
        </div>
        <div className="row">
          <span>種類</span>
          <select className="trail" value={type} aria-label="種類" disabled={source === "spigot"} onChange={(e) => { const t = e.target.value as ItemType; setType(t); if (hits) find(t); }}>
            {ITEM_TYPE_IDS.map((t) => <option key={t} value={t}>{ITEM_TYPES[t]}</option>)}
          </select>
        </div>
        <input className="row" type="search" placeholder="名前で探す(空なら人気順)" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!hits && <button className="row link" type="submit">探す</button>}
        {hits?.length === 0 && <p className="row muted">見つかりませんでした。</p>}
        {hits?.map((h) => (
          <div className="row hit" key={h.projectId}>
            <ItemIcon type={type} url={h.iconUrl} />
            <span className="main">
              <a href={pageUrl(source, h.projectId, h.slug)} target="_blank" rel="noreferrer noopener" translate="no">{h.title}</a>
              <span className="muted summary" translate="no">{h.summary}</span>
              <span className="muted">{h.downloads.toLocaleString("ja-JP")} ダウンロード</span>
            </span>
            {have.has(`${source}:${h.projectId}`) ? (
              <span className="trail muted">登録済み</span>
            ) : (
              <button className="trail capsule" type="button" disabled={!!busy} onClick={() => pick(h.projectId)}>
                {busy === h.projectId ? "足しています…" : "足す"}
              </button>
            )}
          </div>
        ))}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
    </>
  );
}

// アップロードしたもの・保存した配布元の版(ダウンロード・消す・共有リンク)と、保存の設定(保存するか・古い版を残す数)
function Files({ item, keep, edit, local, onChange }: { item: CatItem; keep: Catalog["keep"]; edit: boolean; local: boolean; onChange: () => void }) {
  const itemId = item.id;
  const title = item.title;
  const load = useServerFn(uploadedFiles);
  const remove = useServerFn(removeUploadedFile);
  const save = useServerFn(saveVersion);
  const setKeep = useServerFn(setItemSaved);
  const [files, setFiles] = useState<Awaited<ReturnType<typeof uploadedFiles>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => { load({ data: { itemId } }).then(setFiles, (e) => setError(message(e))); };
  useEffect(reload, [itemId]);
  const upstream = item.source !== "upload";
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote(await fn());
      reload();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const changeKeep = (keepFiles: string, keepVersions: number | null) => run(async () => {
    const r = await setKeep({ data: { itemId, keepFiles: keepFiles as "" | "on" | "off", keepVersions } });
    return r.removed.length ? `保存しました(古い版 ${r.removed.join("、")} を整理しました)` : "保存しました";
  });
  return (
    <span className="files">
      {files?.length === 0 && <span className="muted">{upstream ? "まだ保存した版はありません" : "版がありません"}</span>}
      {files?.map((f) => (
        <span key={f.id} className="muted">
          <span translate="no">{f.version || f.filename}</span>({(f.size / 1024).toFixed(0)} KB・{new Date(f.createdAt).toLocaleDateString("ja-JP")}{f.loaders.length ? `・${f.loaders.join(" / ")}` : ""})
          {" "}<a href={`/api/library/files/${f.id}`} download>ダウンロード</a>
          {edit && <>{" "}<button className="link danger small" type="button"
            onClick={() => confirm(`${f.filename} を消しますか?(保存先からも消えます。サーバーに入っているものはそのままです)`) && remove({ data: { fileId: f.id } }).then(reload, (e) => setError(message(e)))}>消す</button></>}
        </span>
      ))}
      {edit && files && files.length > 0 && <ShareMaker itemIds={[itemId]} name={title} label="共有リンクを作る(いちばん新しい版)" />}
      {edit && local && upstream && <button className="link small" type="button" disabled={busy} onClick={() => run(async () => {
        const r = await save({ data: { itemId } });
        return `${r.version || r.filename} を保存しました`;
      })}>{busy ? "しています…" : "いちばん新しい版を保存先に保存"}</button>}
      {edit && local && (
        <span className="actions">
          {upstream && (
            <select value={item.keepFiles} disabled={busy} aria-label="配布元のファイルを保存するか" onChange={(e) => changeKeep(e.target.value, item.keepVersions)}>
              <option value="">{`チームの既定(${keep.files ? "保存する" : "保存しない"})`}</option>
              <option value="on">入れた版を保存する</option>
              <option value="off">保存しない</option>
            </select>
          )}
          <select value={item.keepVersions === null ? "" : String(item.keepVersions)} disabled={busy} aria-label="古い版を残す数"
            onChange={(e) => changeKeep(item.keepFiles, e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">{`古い版: チームの既定(${keep.versions ? `${keep.versions} 個残す` : "整理しない"})`}</option>
            <option value="0">古い版を整理しない</option>
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{`新しい方から ${n} 個残す`}</option>)}
          </select>
        </span>
      )}
      {note && <span className="muted" role="status" translate="no">{note}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}

// ファイルをアップロード(自分用の版だけ)。jar を調べて、名前と版・動くサーバーの種類を読み取る。
// いくつでも・フォルダごと(中の .jar だけ)・ドラッグ&ドロップでも選べる。1 つずつ順に送る
const isAddon = (f: File) => /[.](jar|zip|mrpack)$/i.test(f.name);
async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void, ng: () => void) => void;
    createReader?: () => { readEntries: (ok: (l: Entry[]) => void, ng: () => void) => void } };
  const out: File[] = [];
  const walk = async (e: Entry, inDir: boolean): Promise<void> => {
    if (e.isFile && e.file) {
      const f = await new Promise<File | null>((ok) => e.file!(ok, () => ok(null)));
      if (f && (!inDir || isAddon(f))) out.push(f);
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((ok) => reader.readEntries(ok, () => ok([])));
        if (!batch.length) break;
        for (const x of batch) await walk(x, true);
      }
    }
  };
  const entries = Array.from(dt.items ?? []).filter((i) => i.kind === "file")
    .map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((e) => !e)) return Array.from(dt.files ?? []);
  for (const e of entries) await walk(e!, false);
  return out;
}

function Upload({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState("");
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  const send = async (list: File[]) => {
    if (!list.length) {
      setResults([{ name: "", ok: false, text: "jar・zip のファイルが見つかりませんでした" }]);
      return;
    }
    const out: typeof results = [];
    for (const [i, f] of list.entries()) {
      setBusy(`送っています… ${i + 1} / ${list.length}`);
      try {
        const res = await fetch(`/api/library/upload?filename=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        const j = await res.json();
        out.push(res.ok ? { name: f.name, ok: true, text: `${j.title} ${j.version}(${TYPE_LABEL[j.projectType] ?? j.projectType})` } : { name: f.name, ok: false, text: j.message });
      } catch {
        out.push({ name: f.name, ok: false, text: "送れませんでした" });
      }
      setResults([...out]);
    }
    setBusy("");
    onDone();
  };
  const pick = (files: FileList | null, folder: boolean) => {
    const l = Array.from(files ?? []);
    if (l.length) send(folder ? l.filter(isAddon) : l);
  };
  const ok = results.filter((r) => r.ok).length;
  return (
    <>
      <div className="group-title">ファイルをアップロード</div>
      <section className={`group form${over ? " drop-on" : ""}`}
        onDragOver={(e) => { if (busy || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (busy) return; e.preventDefault(); setOver(false); droppedFiles(e.dataTransfer).then(send); }}>
        <label className="row link">
          {busy || "ファイルを選ぶ(jar・zip・mrpack。いくつでも)"}
          <input type="file" accept=".jar,.zip,.mrpack" multiple hidden disabled={!!busy} onChange={(e) => { pick(e.target.files, false); e.target.value = ""; }} />
        </label>
        <label className="row link">
          {busy ? "" : "フォルダを選ぶ(中の jar・zip をまとめて)"}
          <input type="file" multiple hidden disabled={!!busy} {...{ webkitdirectory: "" }} onChange={(e) => { pick(e.target.files, true); e.target.value = ""; }} />
        </label>
        <div className="row muted">{over ? "ここで離すと送ります" : "ここにファイルかフォルダをドラッグしても送れます"}</div>
        {results.length > 1 && <p className="row muted">{`${results.length} 個のうち ${ok} 個を載せました`}</p>}
        {results.map((r, i) => <p key={i} className={`row ${r.ok ? "muted" : "error"}`} translate="no">{r.name ? `${r.name}: ` : ""}{r.ok ? `載せました — ${r.text}` : r.text}</p>)}
      </section>
      <p className="foot">配布元に無いプラグイン・Mod(jar)と、データパック・リソースパック・シェーダー・Modパック(zip・mrpack)を、ファイルのままライブラリに載せます。jar は中の plugin.yml・fabric.mod.json などから名前・版・動くサーバーの種類を、zip は pack.mcmeta・shaders/ などから種類を読み取り、同じ名前のものは新しい版として足します。置き場所は「チーム」→「保存先」で決められます(1 つ 1 GB まで)。</p>
    </>
  );
}

// お知らせ: 最近の出来事。前に開いたあとのものを数える(どこまで読んだかはサーバーに残し、どの端末でも同じ)
const SEEN = "craftshelf.notices-seen"; // 03.50.00 まではブラウザごとに残していた(サーバーにまだ無いときだけ使う)
function Notices() {
  const load = useServerFn(recentEvents);
  const mark = useServerFn(markNoticesSeen);
  const [list, setList] = useState<Awaited<ReturnType<typeof recentEvents>>["items"] | null>(null);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState("");
  useEffect(() => {
    load().then((r) => { setList(r.items); setSeen(r.seenAt ?? localStorage.getItem(SEEN) ?? ""); }, () => setList([]));
  }, []);
  const unread = (list ?? []).filter((e) => e.at > seen).length;
  const toggle = (v: boolean) => {
    setOpen(v);
    if (v && list?.length && list[0].at > seen) {
      setSeen(list[0].at);
      mark({ data: { at: list[0].at } }).catch(() => {});
    }
  };
  return (
    <Bell open={open} setOpen={toggle} count={unread} label={`お知らせ ${unread} 件`}>
      {!list?.length && <div className="row muted">お知らせはありません</div>}
      {list?.map((e) => (
        <div className="row" key={e.id}>
          <span className="main">
            <span>{e.action}{e.target ? <>: <span translate="no">{e.target}</span></> : null}</span>
            <span className="muted small" translate="no">{new Date(e.at).toLocaleString("ja-JP")}{e.userName ? ` · ${e.userName}` : ""}{e.detail ? ` · ${e.detail.split("\n")[0].slice(0, 80)}` : ""}</span>
          </span>
        </div>
      ))}
    </Bell>
  );
}

// はじめての設定(管理者以上)。すべて済んだら・「閉じる」を押したら出さない(ブラウザごと)
const GUIDE = "craftshelf.guide-hidden";
function Guide({ cat, members }: { cat: Catalog; members: number }) {
  const sets = useServerFn(listSets);
  const [setCount, setSetCount] = useState<number | null>(null);
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    setHidden(localStorage.getItem(GUIDE) === "1");
    sets().then((s) => setSetCount(s.length), () => setSetCount(0));
  }, []);
  const steps = [
    { done: cat.servers.length > 0, label: "サーバーをつなぐ(Pterodactyl パネル・フォルダ)", to: "/servers" as const },
    { done: cat.servers.length > 0 && cat.servers.every((s) => s.type), label: "サーバーの種類(Paper・Fabric など)を選ぶ", to: "/servers" as const },
    { done: cat.items.length > 0, label: "ライブラリに Mod・プラグインを足す(下の「配布元から足す」)", to: null },
    { done: (setCount ?? 0) > 0, label: "セットを作って、まとめて入れる", to: "/sets" as const },
    { done: members > 1, label: "チームの人を招待する", to: "/team" as const },
  ];
  if (hidden || setCount === null || steps.every((s) => s.done)) return null;
  return (
    <>
      <div className="group-title">はじめての設定</div>
      <section className="group">
        {steps.map((s) => (
          <div className="row" key={s.label}>
            <span className={`main${s.done ? " muted" : ""}`}>{s.done ? "✓ " : "・"}{s.label}</span>
            {!s.done && s.to && <Link to={s.to} className="trail link">開く</Link>}
          </div>
        ))}
        <button className="row link" type="button" onClick={() => { localStorage.setItem(GUIDE, "1"); setHidden(true); }}>このガイドを閉じる</button>
      </section>
    </>
  );
}
