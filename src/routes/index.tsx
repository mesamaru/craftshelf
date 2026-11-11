import { useEffect, useRef, useState } from "react";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { authClient } from "~/lib/auth-client";
import { editLibraryItem, favoriteLibraryItem, installMod, libraryCatalog, libraryItemChangelog, libraryItemVersions, libraryMissingDeps,
  linkLibraryDep, modpackFromItem, outdatedLibraryServers, relinkLibraryItem, removeLibraryItem, tagLibraryItems } from "~/lib/library-api";
import { LIBRARY_CHANGED, UploadResults, droppedFiles, libraryChanged, useUploader } from "~/lib/library-add";
import { ITEM_TYPES, ITEM_TYPE_IDS, type ItemType, mcCompare, mcCovers, mcRange } from "~/lib/platforms";
import { AddonIcon } from "~/lib/type-icon";
import { localEnabled } from "~/lib/servers-api";
import { listBackups } from "~/lib/backup-api";
import { notifySettings } from "~/lib/events-api";
import { CHANNELS, SOURCE_LABEL, type Channel, type ItemSource, isItemSource, pageUrl } from "~/lib/sources";
import { removeUploadedFile, uploadedFiles } from "~/lib/uploads-api";
import { ShareMaker } from "~/lib/share-maker";
import { saveVersion, setItemSaved, zipPlan } from "~/lib/saved-api";
import { downloadZip } from "~/lib/zip-download";
import { useCan } from "~/lib/use-can";
import { MobileSearch, OPEN_ADD, StoragePill } from "~/lib/shell";
import { listSets, toggleSetItem } from "~/lib/sets-api";
import { ActionBar, Btn, Chip, Icon, Info, Menu, Sheet, fmtSize } from "~/lib/ui";

// ?item= で開いているアイテム(戻るボタンで閉じる)。?type= ?f= はホームから来たときの絞り込み
type Search = { item?: string; type?: string; f?: "upd" | "deps" | "nomc" };
export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.item === "string" && s.item ? { item: s.item } : {}),
    ...(typeof s.type === "string" && s.type in ITEM_TYPES ? { type: s.type } : {}),
    ...(s.f === "upd" || s.f === "deps" || s.f === "nomc" ? { f: s.f } : {}),
  }),
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Library,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = ITEM_TYPES;
const sourceLabel = (s: string) => (isItemSource(s) ? SOURCE_LABEL[s] : s);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("ja-JP");

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type CatItem = Catalog["items"][number];
type DepInfo = Awaited<ReturnType<typeof libraryMissingDeps>>["items"][number]["servers"];
/** 一覧の小さな説明(v02 と同じ「版 · N バージョン · 大きさ · 日付」。無いものは出さない) */
const subOf = (i: CatItem, date = true) =>
  [i.version, i.files ? `${i.files} バージョン` : "", i.size ? fmtSize(i.size) : "", date ? fmtDate(i.createdAt) : ""].filter(Boolean).join(" · ");

// 一覧の絞り込み・並べ替え。oldIds は「更新あり」(アイテム → 古い版のサーバー)、depIds は「前提不足」を確かめた結果(確かめるまでは null)
type Sort = "fav" | "name" | "new" | "old" | "size" | "count";
type Filter = { q: string; type: string; source: string; tag: string; mc: string; sort: Sort; fav: boolean; nomc: boolean; old: boolean; oldIds: Map<string, Set<string>> | null;
  deps: boolean; depIds: Map<string, DepInfo> | null };
const NO_FILTER: Filter = { q: "", type: "", source: "", tag: "", mc: "", sort: "fav", fav: false, nomc: false, old: false, oldIds: null, deps: false, depIds: null };
const SORTS: [Sort, string][] = [["fav", "お気に入りを上に"], ["name", "名前順"], ["new", "追加が新しい順"], ["old", "更新があるものを上に"], ["size", "大きい順"], ["count", "バージョンが多い順"]];

// 名前順で来たものを、選んだ並べ方に
function filterItems(items: CatItem[], f: Filter) {
  const q = f.q.trim().toLowerCase();
  const by: Record<Sort, (a: CatItem, b: CatItem) => number> = {
    fav: (a, b) => Number(b.favorite) - Number(a.favorite),
    name: () => 0,
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => Number(!!f.oldIds?.has(b.id)) - Number(!!f.oldIds?.has(a.id)),
    size: (a, b) => b.size - a.size,
    count: (a, b) => b.files - a.files,
  };
  return items
    .filter((i) => (!q || i.title.toLowerCase().includes(q)) && (!f.type || i.projectType === f.type) && (!f.source || i.source === f.source) && (!f.fav || i.favorite)
      && (!f.tag || i.tags.includes(f.tag)) && (!f.old || !!f.oldIds?.has(i.id)) && (!f.mc || mcCovers(i.mc, f.mc)) && (!f.deps || !!f.depIds?.has(i.id)) && (!f.nomc || !i.mc.length))
    .sort(by[f.sort]);
}

// ライブラリ: チームのアドオン(Mod・プラグインなど)の管理。どのサーバーに入っているかは出さない(サーバーの画面で見る)
function Library() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { data: team } = authClient.useActiveOrganization();
  const { can } = useCan(user.id);
  const load = useServerFn(libraryCatalog);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const reload = () => { load().then((c) => { setCat(c); setError(""); }, (e) => setError(message(e))); };
  useEffect(reload, [team?.id]);
  useEffect(() => {
    window.addEventListener(LIBRARY_CHANGED, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED, reload);
  }, []);
  const isLocal = useServerFn(localEnabled);
  const [local, setLocal] = useState(false); // アップロード・保存した版は自分用の版だけ
  useEffect(() => { isLocal().then(setLocal, () => setLocal(false)); }, []);

  const edit = can({ library: ["edit"] });
  const admin = can({ member: ["update"] });
  const [f, setF] = useState<Filter>(() => ({ ...NO_FILTER, type: search.type ?? "", nomc: search.f === "nomc" }));
  const set = (p: Partial<Filter>) => setF((x) => ({ ...x, ...p }));
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const open = search.item ?? null; // 詳しく見ているアイテム
  // 開くと履歴に積み、閉じると 1 つ戻る(v02 と同じ。戻るボタンでも閉じる)
  const pushed = useRef(false);
  const setOpen = (id: string | null) => {
    if (!id && pushed.current) { pushed.current = false; return history.back(); }
    pushed.current = !!id;
    navigate({ to: "/", search: ({ item: _, ...s }: Search) => (id ? { ...s, item: id } : s), replace: !id });
  };
  const shown = cat ? filterItems(cat.items, f) : [];
  const favorite = useServerFn(favoriteLibraryItem);
  const outdated = useServerFn(outdatedLibraryServers);
  const missing = useServerFn(libraryMissingDeps);
  // 「更新あり」「前提不足」は配布元に問い合わせるので、押したときだけ確かめる
  const checkOld = (then: Partial<Filter> = {}) => {
    set(then);
    setError("");
    if (!f.oldIds) outdated().then((r) => set({ oldIds: new Map(r.map((x) => [x.itemId, new Set(x.serverIds)])) }), (e) => { setError(message(e)); set({ old: false, sort: "fav" }); });
  };
  const refreshDeps = () => missing({ data: {} }).then((r) => set({ depIds: new Map(r.items.map((d) => [d.itemId, d.servers])) }), (e) => { setError(message(e)); set({ deps: false }); });
  const toggleOld = () => (f.old ? set({ old: false }) : checkOld({ old: true }));
  const toggleDeps = () => {
    if (f.deps) return set({ deps: false });
    set({ deps: true });
    setError("");
    if (!f.depIds) refreshDeps();
  };
  useEffect(() => {
    if (search.f === "upd") checkOld({ old: true });
    if (search.f === "deps") toggleDeps();
  }, []);
  // 先に画面を変え、うまくいかなければ読み直す
  const toggleFavorite = (item: CatItem) => {
    setCat((c) => c && { ...c, items: c.items.map((x) => (x.id === item.id ? { ...x, favorite: !item.favorite } : x)) });
    favorite({ data: { itemId: item.id, on: !item.favorite } }).catch((e) => { setError(message(e)); reload(); });
  };
  const item = open ? cat?.items.find((i) => i.id === open) : undefined;
  const pick = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); };

  return (
    <main className="page fill">
      <header className="bar">
        <h1>ライブラリ
          <Info>
            <span>チームで使う Mod・プラグインの一覧です。Modrinth・SpigotMC のものは、サーバーが配布元から直接取り込みます(アップロードしたもの・保存した版は、保存先から送ります)。入れる版は、サーバーの種類とバージョンに合うものを選びます(Paper のサーバーには Paper 向けの作りを優先)。</span>
            <span>データパックは、サーバーのワールド(server.properties の level-name)の datapacks に入れます。リソースパック・シェーダーはクライアントで使うものなので、ライブラリで持ち、「詳しく」の版からダウンロードできます。Modパックからは、セットを作ったり、サーバーに中の Mod と設定ファイルを入れたりできます(新しい版が出たらお知らせします)。</span>
          </Info>
        </h1>
        <StoragePill />
      </header>
      <MobileSearch />

      {admin && cat && <SetupCard cat={cat} local={local} />}
      {edit && local && <DropCard />}

      {cat && cat.items.length > 0 && (
        <div className="lsum">
          <button type="button" className={`ls-tile upd${f.old ? " on" : ""}`} aria-pressed={f.old} onClick={toggleOld} title="どこかのサーバーに古い版が入っているもの(配布元に問い合わせます。更新を止めたものは除きます)">
            <span className="l"><Icon name="reload" />更新あり</span><span className="v">{f.oldIds ? f.oldIds.size : "—"}</span>
          </button>
          <button type="button" className={`ls-tile deps${f.deps ? " on" : ""}`} aria-pressed={f.deps} onClick={toggleDeps} title="入っているサーバーに、必須の前提が無いもの(配布元に問い合わせます)">
            <span className="l"><Icon name="puzzle" />前提不足</span><span className="v">{f.depIds ? f.depIds.size : "—"}</span>
          </button>
        </div>
      )}

      {cat && cat.items.length > 0 && <Toolbar cat={cat} f={f} set={set} edit={edit} selecting={selecting} onSort={(v) => (v === "old" ? checkOld({ sort: "old" }) : set({ sort: v }))} onSelect={() => (selecting ? stopSelecting() : setSelecting(true))} />}
      {error && <p className="error" role="alert">{error}</p>}

      <section className="group items">
        {!cat && !error && <div className="row muted">読み込んでいます…</div>}
        {cat?.items.length === 0 && (
          <div className="row">
            <span className="main muted">まだ何もありません。サーバーに入れたものは、ここに自動で載ります。</span>
            {edit && <Btn kind="pri" sm onClick={() => window.dispatchEvent(new Event(OPEN_ADD))}>＋ 追加</Btn>}
          </div>
        )}
        {cat && cat.items.length > 0 && shown.length === 0 && (
          <div className="row muted">{f.old && !f.oldIds ? "更新を確かめています…" : f.deps && !f.depIds ? "確かめています…" : "条件に合うものはありません"}</div>
        )}
        {cat && shown.map((i) => (
          <ItemRow key={i.id} item={i} old={!!f.oldIds?.get(i.id)} dep={!!f.depIds?.has(i.id)} selecting={selecting} picked={picked.has(i.id)} open={open === i.id}
            onOpen={() => (selecting ? pick(i.id, !picked.has(i.id)) : setOpen(i.id))} onFavorite={() => toggleFavorite(i)} onPick={(on) => pick(i.id, on)} />
        ))}
      </section>

      {edit && cat && selecting && (
        <Bulk ids={[...picked]} cat={cat} share={local} allShown={shown.length > 0 && shown.every((i) => picked.has(i.id))}
          onAll={() => setPicked(new Set(shown.map((i) => i.id)))} onClear={stopSelecting}
          onDone={(clear) => { if (clear) setPicked(new Set()); reload(); libraryChanged(); }} />
      )}
      {cat && item && (
        <ItemSheet key={item.id} item={item} cat={cat} edit={edit} admin={admin} local={local} old={f.oldIds?.get(item.id)} depInfo={f.depIds?.get(item.id)}
          onChange={reload} onDeps={() => { if (f.depIds) refreshDeps(); }} onFavorite={() => toggleFavorite(item)} onClose={() => setOpen(null)}
          onRemoved={() => { setOpen(null); reload(); libraryChanged(); }} />
      )}
    </main>
  );
}

// はじめの設定(v02 と同じ。管理者だけ・閉じられる): 保存先・アドオン・サーバー・バックアップ・通知。「あとで」「使わない」とどこまで閉じたかは、この端末に残す
const SETUP = "craftshelf.setup";
type SetupState = { closed?: boolean; skip?: string[] };
type Step = { k: string; t: string; done: boolean; later?: string; to?: string; go?: string; info?: string };
function SetupCard({ cat, local }: { cat: Catalog; local: boolean }) {
  const backups = useServerFn(listBackups);
  const notify = useServerFn(notifySettings);
  const [st, setSt] = useState<SetupState | null>(null);
  const [backup, setBackup] = useState(false);
  const [notified, setNotified] = useState(false);
  useEffect(() => {
    try { setSt(JSON.parse(localStorage.getItem(SETUP) ?? "{}")); } catch { setSt({}); }
    if (local) backups().then((b) => setBackup(b.schedule.enabled), () => {});
    notify().then((n) => setNotified(n.configured), () => {});
  }, [local]);
  if (!st || st.closed) return null;
  const save = (s: SetupState) => { setSt(s); try { localStorage.setItem(SETUP, JSON.stringify(s)); } catch {} };
  const skip = (k: string) => save({ ...st, skip: [...(st.skip ?? []), k] });
  const skipped = (k: string) => !!st.skip?.includes(k);
  const steps = ([
    local && { k: "storage", t: "保存先を決める", done: !!cat.storage?.name || skipped("storage"), later: "ローカルのままにする", to: "/storage", go: "保存先を開く",
      info: "初めはこのパネルの中(ローカル)に保存します。NAS などに置くなら、保存先を足します。" },
    { k: "addon", t: "アドオンを追加する", done: cat.items.length > 0 },
    { k: "server", t: "サーバーをつなぐ", done: cat.servers.length > 0, to: "/servers", go: "サーバーを開く" },
    local && { k: "backup", t: "バックアップを設定する", done: backup || skipped("backup"), later: "あとで", to: "/backup", go: "バックアップを開く" },
    { k: "notify", t: "通知を受け取る", done: notified || skipped("notify"), later: "使わない", to: "/activity", go: "Discord 通知を開く" },
  ] as (Step | false)[]).filter((s): s is Step => !!s);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done)?.k;
  return (
    <section className="setup glass">
      <div className="sg-head">
        <div><h3>はじめの設定</h3><small>{`${done} / ${steps.length} 済み`}</small></div>
        <button type="button" className="rbtn sm" aria-label="閉じる" title="閉じる" onClick={() => save({ ...st, closed: true })}><Icon name="close" /></button>
      </div>
      <div className="meter"><i style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ul className="sg-steps">
        {steps.map((s) => (
          <li key={s.k} className={s.done ? "done" : s.k === next ? "next" : ""}>
            <span className="sg-dot" aria-hidden="true">{s.done ? "✓" : ""}</span>
            <span className="sg-t">{s.t}{s.info && <Info>{s.info}</Info>}</span>
            {!s.done && (
              <span className="sg-acts">
                {s.later && <button type="button" className="link small" onClick={() => skip(s.k)}>{s.later}</button>}
                {s.k === "addon" ? <Btn kind="pri" sm onClick={() => window.dispatchEvent(new Event(OPEN_ADD))}>＋ 追加</Btn>
                  : s.to && <Link to={s.to as "/"} className={`btn sm ${s.k === next ? "pri" : "tint"}`}>{s.go}</Link>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ドラッグ&ドロップで追加の欄(自分用の版・編集者以上): ファイル・フォルダを送る / 配布サイトで探す(「＋ 追加」のシート)
function DropCard() {
  const { busy, results, send, pick, clear } = useUploader();
  const [over, setOver] = useState(false);
  return (
    <>
      <section className={`dropcard${over ? " on" : ""}`}
        onDragOver={(e) => { if (busy || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (busy) return; e.preventDefault(); setOver(false); droppedFiles(e.dataTransfer).then(send); }}>
        <div className="dz">
          <span className="dic" aria-hidden="true"><Icon name="tray" /></span>
          <div>
            <strong>{busy || (over ? "ここで離すと送ります" : "ドラッグ&ドロップで追加")}</strong>
            <span className="s">.jar / .zip / フォルダ
              <Info>配布元に無いプラグイン・Mod(jar)と、データパック・リソースパック・シェーダー・Modパック(zip・mrpack)を、ファイルのままライブラリに載せます。名前・版・種類は中身から読み取り、同じ名前のものは新しい版として足します(1 つ 1 GB まで)。</Info>
            </span>
          </div>
        </div>
        <div className="acts">
          <label className="btn pri sm">ファイルを選択<input type="file" accept=".jar,.zip,.mrpack" multiple hidden disabled={!!busy} onChange={(e) => { pick(e.target.files, false); e.target.value = ""; }} /></label>
          <label className="btn sm hide-p">フォルダ<input type="file" multiple hidden disabled={!!busy} {...{ webkitdirectory: "" }} onChange={(e) => { pick(e.target.files, true); e.target.value = ""; }} /></label>
          <Btn kind="tint" sm onClick={() => window.dispatchEvent(new Event(OPEN_ADD))}>配布サイトで探す</Btn>
        </div>
      </section>
      {results.length > 0 && !busy && <div className="chips"><UploadResults results={results} /><Btn sm onClick={clear}>閉じる</Btn></div>}
    </>
  );
}

// 絞り込みの欄(v02 と同じ): 検索・配布元・MC・選択・並べ替え、その下に種類ごとの件数・お気に入り・タグ
function Toolbar({ cat, f, set, edit, selecting, onSort, onSelect }:
  { cat: Catalog; f: Filter; set: (p: Partial<Filter>) => void; edit: boolean; selecting: boolean; onSort: (v: Sort) => void; onSelect: () => void }) {
  const tags = [...new Set(cat.items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, "ja"));
  const mcs = [...new Set(cat.items.flatMap((i) => i.mc))].sort(mcCompare).reverse();
  const sources = [...new Set(cat.items.map((i) => i.source))];
  const types = ITEM_TYPE_IDS.map((t) => [t, cat.items.filter((i) => i.projectType === t).length] as const).filter(([, n]) => n > 0);
  const favs = cat.items.filter((i) => i.favorite).length;
  return (
    <div className="toolbar glass">
      <div className="row1">
        <label className="q"><Icon name="search" /><input type="search" placeholder="検索" aria-label="名前で絞り込む" value={f.q} onChange={(e) => set({ q: e.target.value })} /></label>
        {sources.length > 1 && (
          <select className="sel" value={f.source} aria-label="配布元で絞り込む" onChange={(e) => set({ source: e.target.value })}>
            <option value="">配布元: すべて</option>
            {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
          </select>
        )}
        {mcs.length > 0 && (
          <select className="sel" value={f.mc} aria-label="対応 MC で絞り込む" onChange={(e) => set({ mc: e.target.value })}>
            <option value="">MC: すべて</option>
            {mcs.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        {edit && <Btn kind="tint" sm onClick={onSelect}>{selecting ? "やめる" : "選択"}</Btn>}
        <select className="sel" value={f.sort} aria-label="並べ替え" onChange={(e) => onSort(e.target.value as Sort)}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="segs" role="group" aria-label="種類で絞り込む">
        <button type="button" className="seg" aria-pressed={!f.type && !f.fav} onClick={() => set({ type: "", fav: false })}>すべて<span className="n">{cat.items.length}</span></button>
        {types.map(([t, n]) => (
          <button key={t} type="button" className="seg" aria-pressed={f.type === t} onClick={() => set({ type: f.type === t ? "" : t })}>
            <AddonIcon type={t} size="sm" />{ITEM_TYPES[t]}<span className="n">{n}</span>
          </button>
        ))}
        {favs > 0 && <button type="button" className="seg" aria-pressed={f.fav} onClick={() => set({ fav: !f.fav })}><span aria-hidden="true">★</span>お気に入り<span className="n">{favs}</span></button>}
        {f.nomc && <Chip on onClick={() => set({ nomc: false })}>対応 MC が不明 ✕</Chip>}
      </div>
      {tags.length > 0 && (
        <div className="segs" role="group" aria-label="タグで絞り込む">
          {tags.map((t) => <Chip key={t} on={f.tag === t} onClick={() => set({ tag: f.tag === t ? "" : t })}><span translate="no">{t}</span></Chip>)}
        </div>
      )}
    </div>
  );
}

// 一覧の行(v02 と同じ): アイコン・名前 ☆・タグ・「版 · N バージョン · 大きさ · 日付」・印・›。押すと右のシートで詳しく
function ItemRow({ item, old, dep, selecting, picked, open, onOpen, onFavorite, onPick }:
  { item: CatItem; old: boolean; dep: boolean; selecting: boolean; picked: boolean; open: boolean; onOpen: () => void; onFavorite: () => void; onPick: (on: boolean) => void }) {
  const newer = item.pack?.used && item.pack.latest && item.pack.latest.id !== item.pack.used.id;
  return (
    <div className={`row click${picked ? " sel" : ""}`} role="button" tabIndex={0} aria-label={item.title} aria-current={open || undefined} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}>
      {selecting && <input type="checkbox" className="ck" checked={picked} onClick={(e) => e.stopPropagation()} onChange={(e) => onPick(e.target.checked)} aria-label={`${item.title} を選ぶ`} />}
      <AddonIcon type={item.projectType} url={item.iconUrl} />
      <span className="mid">
        <span className="ttl"><span translate="no">{item.title}</span><Star on={item.favorite} onClick={onFavorite} />{item.tags.map((t) => <span key={t} className="tag" translate="no">{t}</span>)}</span>
        <span className="sub">{subOf(item)}</span>
      </span>
      {(old || newer) && <span className="badge upd">更新あり</span>}
      {dep && <span className="badge bad">前提不足</span>}
      <span className="chev" aria-hidden="true">›</span>
    </div>
  );
}

const Star = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
  <button type="button" className="star" aria-pressed={on} onClick={(e) => { e.stopPropagation(); onClick(); }}
    aria-label={on ? "お気に入りから外す" : "お気に入りにする"} title={on ? "お気に入りから外す" : "お気に入りにする"}>{on ? "★" : "☆"}</button>
);

// チェックで選んだものをまとめて: タグを付ける・セットに足す・サーバーに入れる(入れる先を選ぶ)・zip・共有リンク・ライブラリから外す
function Bulk({ ids, cat, share, allShown, onAll, onClear, onDone }:
  { ids: string[]; cat: Catalog; share: boolean; allShown: boolean; onAll: () => void; onClear: () => void; onDone: (clear: boolean) => void }) {
  const tag = useServerFn(tagLibraryItems);
  const plan = useServerFn(zipPlan);
  const toSet = useServerFn(toggleSetItem);
  const remove = useServerFn(removeLibraryItem);
  const install = useServerFn(installMod);
  const loadSets = useServerFn(listSets);
  const [sets, setSets] = useState<{ id: string; name: string }[]>([]);
  const [sheet, setSheet] = useState<"" | "sets" | "install" | "share">("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { loadSets().then(setSets, () => setSets([])); }, []);
  const items = cat.items.filter((i) => ids.includes(i.id));
  const none = busy || !ids.length;
  const run = async (fn: () => Promise<string>, clear: boolean) => {
    setSheet("");
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
  const addToSet = (s: { id: string; name: string }) =>
    run(async () => { for (const itemId of ids) await toSet({ data: { id: s.id, itemId, add: true } }); return `セット「${s.name}」に足しました`; }, false);
  // そのサーバーに入れられるもの(種類が合い、まだ入っていない。Modパックはアイテムのシートから)
  const fits = (s: Catalog["servers"][number]) => items.filter((i) => isItemSource(i.source) && i.projectType !== "modpack"
    && s.kinds.includes(i.projectType as ItemType) && !i.installs.some((x) => x.serverId === s.id));
  const installAll = (s: Catalog["servers"][number]) => run(async () => {
    let ok = 0;
    for (const i of fits(s)) {
      try {
        await install({ data: { id: s.id, projectId: i.projectId, source: i.source as ItemSource } });
        ok++;
      } catch {}
    }
    const failed = fits(s).length - ok;
    return failed ? `${ok} 件を入れました。${failed} 件は入れられませんでした` : `${ok} 件を入れました`;
  }, false);
  const removeAll = () => {
    if (confirm(`${ids.length} 件をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`)) {
      run(async () => { for (const itemId of ids) await remove({ data: { itemId } }); return `${ids.length} 件を外しました`; }, true);
    }
  };
  return (
    <>
      <ActionBar label="選んだもの">
        <strong>{`${ids.length} 件`}</strong>
        {!allShown && <Btn sm disabled={busy} onClick={onAll}>すべて選ぶ</Btn>}
        <Btn sm disabled={none} onClick={addTag}>タグ</Btn>
        {sets.length > 0 && <Btn sm disabled={none} onClick={() => setSheet("sets")}>セットへ</Btn>}
        {cat.servers.length > 0 && <Btn kind="tint" sm disabled={none} onClick={() => setSheet("install")}>入れる</Btn>}
        {share && <Btn sm disabled={none} onClick={() => downloadZip(plan, { itemIds: ids }).catch((e) => setError(message(e)))}>zip</Btn>}
        {share && <Btn sm disabled={none} onClick={() => setSheet("share")}>共有</Btn>}
        <Btn kind="red" sm disabled={none} onClick={removeAll}>外す</Btn>
        <Btn sm aria-label="選ぶのをやめる" title="選ぶのをやめる" onClick={onClear}>✕</Btn>
        {busy && <span className="msg">しています…</span>}
        {!busy && note && <span className="msg" role="status" translate="no">{note}</span>}
        {!busy && error && <span className="msg error" role="alert">{error}</span>}
      </ActionBar>
      {sheet === "sets" && (
        <Sheet title="セットへ" onClose={() => setSheet("")}>
          <section className="group">
            {sets.map((s) => <button key={s.id} type="button" className="row link" onClick={() => addToSet(s)}><span className="main" translate="no">{s.name}</span><span className="trail">＋</span></button>)}
          </section>
        </Sheet>
      )}
      {sheet === "install" && (
        <Sheet title="サーバーに入れる" onClose={() => setSheet("")}>
          <section className="group">
            {cat.servers.map((s) => {
              const n = fits(s).length;
              return (
                <div key={s.id} className="row">
                  <span className="mid"><span className="ttl" translate="no">{s.name}</span><span className="sub">{`${n} 件`}</span></span>
                  <Btn kind="tint" sm disabled={!n} onClick={() => installAll(s)}>入れる</Btn>
                </div>
              );
            })}
          </section>
        </Sheet>
      )}
      {sheet === "share" && (
        <Sheet title="共有" onClose={() => setSheet("")}>
          <section className="group"><div className="row"><ShareMaker key={ids.join()} itemIds={ids} name="" label="共有リンクを作る(アップロード・保存した版のあるものだけ。2 件以上は zip)" /></div></section>
        </Sheet>
      )}
    </>
  );
}

// アイテムの詳しい情報(右のシート。v02 と同じ並び): 種類の印・名前 ☆・版の情報・編集・⋯ / タグ / 配布元 / 共有 / 保存しているバージョン / 前提 / 変更内容 / 情報。
// どのサーバーに入っているかは出さない(入れる・更新は ⋯ から、入れる先を選ぶ)
function ItemSheet({ item, cat, edit, admin, local, old, depInfo, onChange, onDeps, onFavorite, onClose, onRemoved }:
  { item: CatItem; cat: Catalog; edit: boolean; admin: boolean; local: boolean; old?: Set<string>; depInfo?: DepInfo;
    onChange: () => void; onDeps: () => void; onFavorite: () => void; onClose: () => void; onRemoved: () => void }) {
  const install = useServerFn(installMod);
  const remove = useServerFn(removeLibraryItem);
  const tag = useServerFn(tagLibraryItems);
  const fromPack = useServerFn(modpackFromItem);
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState(false); // 入れる先を選ぶ
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>, after = onChange) => {
    setBusy(key);
    setError("");
    setNote("");
    try {
      await fn();
      after();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const url = pageUrl(item.source, item.projectId, item.slug);
  // データパックはワールドのあるサーバーに。リソースパック・シェーダーはサーバーに入れない。Modパックは Mod のサーバーに中身を入れる(設定ファイルも書くので管理者以上)
  const pack = item.projectType === "modpack";
  const client = item.projectType === "resourcepack" || item.projectType === "shader";
  const newer = item.pack?.used && item.pack.latest && item.pack.latest.id !== item.pack.used.id ? item.pack.latest : null;
  const packRun = (serverId?: string) => run(serverId ?? "pack", async () => {
    const r = await fromPack({ data: { itemId: item.id, serverId } });
    const failed = r.applied?.filter((x) => x.status === "failed").length ?? 0;
    setNote(`セット「${r.name}」を作りました(${r.added} 件)${r.applied ? `。サーバーに入れました(失敗 ${failed} 件)` : ""}`);
  });
  const canInstall = edit && isItemSource(item.source) && !client && (!pack || admin) && cat.servers.length > 0;
  // 古い版が入っているサーバーを、まとめて新しい版に(どのサーバーかは出さない)
  const updateAll = () => run("update", async () => {
    for (const id of old ?? []) await install({ data: { id, projectId: item.projectId, source: item.source as ItemSource } });
    setNote(`${old?.size ?? 0} 台を更新しました`);
  }, () => { onChange(); onDeps(); });
  const addTag = () => { const t = prompt("付けるタグ(30 文字まで)")?.trim(); if (t) run("tag", () => tag({ data: { itemIds: [item.id], tag: t, on: true } })); };
  return (
    <Sheet title={<span className="badge cat">{TYPE_LABEL[item.projectType] ?? item.projectType}</span>} label={item.title} onClose={onClose}
      actions={<>
        {admin && <button type="button" className="rbtn sm" aria-pressed={editing} aria-label="情報を直す" title="情報を直す" onClick={() => setEditing(!editing)}><Icon name="edit" /></button>}
        <Menu items={[
          url && { label: "配布元のページを開く", onClick: () => window.open(url, "_blank", "noopener") },
          canInstall && { label: "サーバーに入れる…", onClick: () => setSheet(true) },
          edit && !pack && !!old?.size && { label: "すべて更新", onClick: updateAll },
          edit && pack && { label: newer ? "新しい版でセットを作る" : "セットを作る", onClick: () => packRun() },
          edit && { label: "タグを付ける", onClick: addTag },
          edit && { label: "ライブラリから外す", danger: true, onClick: () => { if (confirm(`${item.title} をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`)) run("remove", () => remove({ data: { itemId: item.id } }), onRemoved); } },
        ]} />
      </>}>
      <div className="item-head">
        <AddonIcon type={item.projectType} url={item.iconUrl} size="lg" />
        <div className="who">
          <h2><span translate="no">{item.title}</span><Star on={item.favorite} onClick={onFavorite} /></h2>
          <div className="sub">{subOf(item, false) || sourceLabel(item.source)}</div>
        </div>
      </div>
      {(item.tags.length > 0 || item.channel === "all" || newer || item.pack?.used) && (
        <div className="chips">
          {item.tags.map((t) => edit
            ? <Chip key={t} on disabled={!!busy} title="押すとタグを外します" onClick={() => run("tag", () => tag({ data: { itemIds: [item.id], tag: t, on: false } }))}><span translate="no">{t}</span> ✕</Chip>
            : <span key={t} className="chip" translate="no">{t}</span>)}
          {item.channel === "all" && <span className="badge muted-badge">ベータ版も受け取る</span>}
          {item.pack?.used && <span className="badge muted-badge" translate="no">{`使った版 ${item.pack.used.number}`}</span>}
          {newer && <span className="badge upd" translate="no">{`新しい版 ${newer.number}`}</span>}
        </div>
      )}
      {!!old?.size && !pack && <p className="notice">{`古い版が入っているサーバーがあります(${old.size} 台)`}{edit && <> <button type="button" className="link" disabled={!!busy} onClick={updateAll}>すべて更新</button></>}</p>}
      {busy && <p className="muted">{busy === "pack" ? "Modパックを読んでいます…" : busy === "remove" ? "外しています…" : "しています…"}</p>}
      {note && <p className="muted" role="status" translate="no">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {editing ? <EditInfo item={item} teamChannel={cat.channel} onDone={onChange} onClose={() => setEditing(false)} /> : <>
        <div className="gtitle">配布元</div>
        <SourceBox item={item} url={url} />
        {local && edit && item.files > 0 && <>
          <div className="gtitle">共有</div>
          <section className="group"><div className="row"><ShareMaker itemIds={[item.id]} name={item.title} label="共有リンクを作る(いちばん新しい版)" /></div></section>
        </>}
        {(item.source === "upload" || local) && <>
          <div className="gtitle">{`保存しているバージョン(${item.files})`}</div>
          <Files item={item} keep={cat.keep} edit={edit} local={local} onChange={onChange} />
        </>}
        <div className="gtitle">前提</div>
        <Deps item={item} cat={cat} edit={edit} depInfo={depInfo} onChange={() => { onChange(); onDeps(); }} />
        {item.source !== "upload" && <Versions item={item} canSave={edit && local && item.source !== "spigot"} onSaved={onChange} />}
        <div className="gtitle">情報</div>
        <ItemInfo item={item} cat={cat} />
      </>}
      {sheet && <InstallSheet item={item} cat={cat} pack={pack} onPack={(id) => { setSheet(false); packRun(id); }}
        onInstalled={() => { onChange(); onDeps(); }} onClose={() => setSheet(false)} />}
    </Sheet>
  );
}

// 配布元: 紐づいている配布元とページ。アップロードしたものは未設定(付け替えはできない)
function SourceBox({ item, url }: { item: CatItem; url: string | null }) {
  if (item.source === "upload") {
    return (
      <section className="group">
        <div className="row">
          <span className="ic"><span className="icon-ph t-link"><Icon name="link" /></span></span>
          <span className="mid"><span className="ttl">配布元が未設定です</span><span className="sub">アップロードしたもの</span></span>
          <Info>アップロードしたものは、ファイルのまま扱います(配布元からは更新しません)。配布元のものを使うときは、「＋ 追加」で配布元から足してください。</Info>
        </div>
      </section>
    );
  }
  return (
    <section className="group">
      <div className="row">
        <span className="ic"><span className="icon-ph t-link"><Icon name="link" /></span></span>
        <span className="mid"><span className="ttl">{sourceLabel(item.source)}</span><span className="sub" translate="no">{item.slug || item.projectId}</span></span>
        {url && <a className="btn sm tint" href={url} target="_blank" rel="noreferrer noopener">ページを開く</a>}
      </div>
    </section>
  );
}

// 入れる先を選ぶ(種類が合うサーバー。Modパックは Mod のサーバーに中身と設定ファイル)
function InstallSheet({ item, cat, pack, onPack, onInstalled, onClose }:
  { item: CatItem; cat: Catalog; pack: boolean; onPack: (serverId: string) => void; onInstalled: () => void; onClose: () => void }) {
  const install = useServerFn(installMod);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const rows = pack ? cat.servers.filter((s) => s.type === "mod") : cat.servers.filter((s) => s.kinds.includes(item.projectType as ItemType));
  const put = async (serverId: string) => {
    if (pack) {
      if (confirm("Modパックの中の Mod と設定ファイル(overrides)を、このサーバーに入れますか?(同じ名前のセットも作ります。上書きした設定ファイルは履歴から戻せます)")) onPack(serverId);
      return;
    }
    setBusy(serverId);
    setError("");
    try {
      await install({ data: { id: serverId, projectId: item.projectId, source: item.source as ItemSource } });
      setDone((d) => new Set(d).add(serverId));
      onInstalled();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <Sheet title="サーバーに入れる" onClose={onClose}>
      <section className="group">
        {rows.length === 0 && <div className="row muted">入れられるサーバーがありません</div>}
        {rows.map((s) => (
          <div key={s.id} className="row">
            <span className="mid"><span className="ttl" translate="no">{s.name}</span></span>
            {done.has(s.id) ? <span className="badge ok">入れました</span>
              : <Btn kind="tint" sm disabled={!!busy} onClick={() => put(s.id)}>{busy === s.id ? "入れています…" : "入れる"}</Btn>}
          </div>
        ))}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </Sheet>
  );
}

// 足りない前提(前提ごとにまとめる。どのサーバーかは出さず、足りないサーバーすべてに入れる)
function DepWarnings({ servers, edit, onInstalled }: { servers: DepInfo; edit: boolean; onInstalled: () => void }) {
  const install = useServerFn(installMod);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const deps = new Map<string, { dep: DepInfo[number]["deps"][number]; serverIds: string[] }>();
  for (const s of servers) for (const d of s.deps) {
    const k = `${d.source}:${d.projectId}`;
    deps.set(k, { dep: d, serverIds: [...(deps.get(k)?.serverIds ?? []), s.serverId] });
  }
  const add = async (k: string) => {
    const x = deps.get(k)!;
    setBusy(k);
    setError("");
    try {
      for (const id of x.serverIds) await install({ data: { id, projectId: x.dep.projectId, source: x.dep.source } });
      onInstalled();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="group">
      {[...deps].map(([k, { dep, serverIds }]) => (
        <div key={k} className="row">
          <span className="badge bad">前提</span>
          <AddonIcon type={dep.projectType} url={dep.iconUrl} />
          <span className="mid"><span className="ttl" translate="no">{dep.title}</span><span className="sub">{`${serverIds.length} 台に足りません`}</span></span>
          {edit && <Btn kind="tint" sm disabled={!!busy} onClick={() => add(k)}>{busy === k ? "入れています…" : "入れる"}</Btn>}
        </div>
      ))}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

// 前提: 手で決めたもの(紐付け)と、入っているサーバーに足りないもの
function Deps({ item, cat, edit, depInfo, onChange }: { item: CatItem; cat: Catalog; edit: boolean; depInfo?: DepInfo; onChange: () => void }) {
  const check = useServerFn(libraryMissingDeps);
  const link = useServerFn(linkLibraryDep);
  const [miss, setMiss] = useState<DepInfo | null>(depInfo ?? null);
  const [error, setError] = useState("");
  // 前提はサーバーに入れるもの(プラグイン・Mod・データパック)だけ
  const onServer = item.projectType === "plugin" || item.projectType === "mod" || item.projectType === "datapack";
  const recheck = () => { if (onServer) check({ data: { itemId: item.id } }).then((r) => setMiss(r.items[0]?.servers ?? []), (e) => setError(message(e))); };
  useEffect(recheck, [item.id]);
  if (!onServer) return <p className="muted small">サーバーに入れないものなので、前提はありません</p>;
  const titleOf = (id: string) => cat.items.find((i) => i.id === id)?.title ?? id;
  const others = cat.items.filter((i) => i.id !== item.id && !item.deps.includes(i.id));
  const setLink = (depItemId: string, on: boolean) => link({ data: { itemId: item.id, depItemId, on } }).then(() => { onChange(); recheck(); }, (e) => setError(message(e)));
  return (
    <>
      <div className="chips">
        {item.deps.length === 0 && !edit && <span className="muted small">なし</span>}
        {item.deps.map((id) => edit
          ? <Chip key={id} on title="押すと前提から外します" onClick={() => setLink(id, false)}><span translate="no">{titleOf(id)}</span> ✕</Chip>
          : <span key={id} className="chip" translate="no">{titleOf(id)}</span>)}
        {edit && others.length > 0 && (
          <select className="chip" value="" aria-label="前提を足す" onChange={(e) => e.target.value && setLink(e.target.value, true)}>
            <option value="">前提を足す…</option>
            {others.map((i) => <option key={i.id} value={i.id} translate="no">{i.title}</option>)}
          </select>
        )}
        <Info>手で決めた前提は、このアドオンを入れるサーバーに一緒に入れます。配布元の前提(必須)が、入っているサーバーに無ければ下に出します。</Info>
      </div>
      {miss && miss.length > 0 && <DepWarnings servers={miss} edit={edit} onInstalled={() => { onChange(); recheck(); }} />}
      {miss?.length === 0 && item.installs.length > 0 && <p className="muted small">前提はそろっています</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// 変更内容: 配布元の版(新しい順)と、版ごとの変更内容(文字として出す)
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
      <div className="gtitle">{item.source === "spigot" ? "更新のお知らせ" : "変更内容"}</div>
      <section className="group">
        {!list && !error && <div className="row muted">読み込んでいます…</div>}
        {list?.length === 0 && <div className="row muted">版がありません</div>}
        {list?.map((v) => (
          <div key={v.versionId} className="row column ver">
            <div className="chips">
              <span className="vnum" translate="no">{v.versionNumber}</span>
              {VERSION_TYPE[v.type] && <span className="badge muted-badge">{VERSION_TYPE[v.type]}</span>}
              <span className="sub">{v.date ? new Date(v.date).toLocaleDateString("ja-JP") : ""}{v.mcVersions.length ? ` · MC ${mcRange(v.mcVersions)}` : ""}{v.loaders.length ? ` · ${v.loaders.join(" / ")}` : ""}</span>
            </div>
            <div className="chips">
              <Btn sm aria-expanded={v.versionId in open} onClick={() => toggle(v)}>{v.versionId in open ? "閉じる" : "変更内容"}</Btn>
              {"url" in v && v.url && <a className="btn sm" href={v.url} target="_blank" rel="noreferrer noopener">ダウンロード</a>}
              {canSave && "url" in v && v.url && (savedIds.has(v.versionId) ? <span className="muted small">保存しました</span>
                : <Btn sm disabled={!!saving} onClick={() => doSave(v.versionId)}>{saving === v.versionId ? "保存しています…" : "保存先に保存"}</Btn>)}
            </div>
            {v.versionId in open && <pre className="changelog" translate="no">{open[v.versionId]}</pre>}
          </div>
        ))}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

// 情報: 種類・対応 MC・受け取る版・追加日
function ItemInfo({ item, cat }: { item: CatItem; cat: Catalog }) {
  const channel: Channel = item.channel || cat.channel;
  return (
    <section className="group">
      <div className="row"><span>種類</span><span className="trail">{TYPE_LABEL[item.projectType] ?? item.projectType}</span></div>
      <div className="row"><span>対応 MC</span><span className="trail" translate="no">{item.mc.length > 0 ? mcRange(item.mc) : "—"}</span></div>
      <div className="row"><span>受け取る版</span><span className="trail">{CHANNELS[channel]}</span></div>
      <div className="row"><span>追加日</span><span className="trail">{fmtDate(item.createdAt)}</span></div>
    </section>
  );
}

// アイテムの情報を直す(管理者以上。✎ で開く): 種類・動く作り・対応 MC・受け取る版・配布元の付け替え
const listOf = (s: string) => (s.trim() ? s.split(/[,、\s]+/).filter(Boolean) : null);
function EditInfo({ item, teamChannel, onDone, onClose }: { item: CatItem; teamChannel: Channel; onDone: () => void; onClose: () => void }) {
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
      <div className="gtitle">情報を直す</div>
      <section className="group">
        <div className="row column files">
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
          <span className="chips"><Btn kind="pri" sm disabled={busy}
            onClick={() => run(async () => { await save({ data: { itemId: item.id, projectType: type, loaders: listOf(loaders), mcVersions: listOf(mc), channel } }); return "保存しました"; })}>
            {busy ? "保存しています…" : "保存"}
          </Btn><Btn sm onClick={onClose}>閉じる</Btn></span>
          {item.source !== "upload" && <>
            <label className="edit-field">
              <span className="muted small">配布元を付け替える(別のプロジェクトのページの URL)</span>
              <input type="url" value={url} disabled={busy} placeholder="https://modrinth.com/plugin/…" onChange={(e) => setUrl(e.target.value)} />
            </label>
            <span><Btn sm disabled={busy || !url.trim()} onClick={doRelink}>付け替える</Btn></span>
          </>}
          {note && <span className="muted" role="status" translate="no">{note}</span>}
          {error && <span className="error" role="alert">{error}</span>}
        </div>
      </section>
    </>
  );
}

// 保存しているバージョン(アップロードしたもの・保存した配布元の版。新しい順): ダウンロード・削除と、保存の設定(保存するか・古い版を残す数)
function Files({ item, keep, edit, local, onChange }: { item: CatItem; keep: Catalog["keep"]; edit: boolean; local: boolean; onChange: () => void }) {
  const itemId = item.id;
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
    <section className="group">
      {files?.length === 0 && <div className="row muted">{upstream ? "まだ保存した版はありません" : "版がありません"}</div>}
      {files?.map((f, n) => (
        <div key={f.id} className="row ver">
          <span className="mid">
            <span className="ttl"><span className="vnum" translate="no">{f.version || f.filename}</span>{n === 0 && <span className="badge ok">最新</span>}</span>
            <span className="sub"><span translate="no">{f.filename}</span> · {fmtSize(f.size)} · {new Date(f.createdAt).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" })}{f.loaders.length ? ` · ${f.loaders.join(" / ")}` : ""}</span>
          </span>
          <a className="rbtn sm" href={`/api/library/files/${f.id}`} download aria-label="ダウンロード" title="ダウンロード"><Icon name="download" /></a>
          {edit && <button type="button" className="rbtn sm red" aria-label="削除" title="削除"
            onClick={() => confirm(`${f.filename} を消しますか?(保存先からも消えます。サーバーに入っているものはそのままです)`) && remove({ data: { fileId: f.id } }).then(() => { reload(); onChange(); }, (e) => setError(message(e)))}><Icon name="trash" /></button>}
        </div>
      ))}
      {edit && local && upstream && <button className="row link" type="button" disabled={busy} onClick={() => run(async () => {
        const r = await save({ data: { itemId } });
        return `${r.version || r.filename} を保存しました`;
      })}>{busy ? "しています…" : "いちばん新しい版を保存先に保存"}</button>}
      {edit && local && (
        <div className="row filters">
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
        </div>
      )}
      {note && <p className="row muted" role="status" translate="no">{note}</p>}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}
