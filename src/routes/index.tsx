import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { authClient } from "~/lib/auth-client";
import { editLibraryItem, favoriteLibraryItem, installMod, libraryCatalog, libraryItemChangelog, libraryItemVersions, libraryMissingDeps,
  linkLibraryDep, modpackFromItem, outdatedLibraryServers, relinkLibraryItem, removeLibraryItem, tagLibraryItems } from "~/lib/library-api";
import { LIBRARY_CHANGED, libraryChanged } from "~/lib/library-add";
import { ITEM_TYPES, ITEM_TYPE_IDS, type ItemType, mcCompare, mcCovers, mcRange } from "~/lib/platforms";
import { ItemIcon } from "~/lib/type-icon";
import { localEnabled } from "~/lib/servers-api";
import { CHANNELS, SOURCE_LABEL, type Channel, type ItemSource, isItemSource, pageUrl } from "~/lib/sources";
import { removeUploadedFile, uploadedFiles } from "~/lib/uploads-api";
import { ShareMaker } from "~/lib/share-maker";
import { saveVersion, setItemSaved, zipPlan } from "~/lib/saved-api";
import { downloadZip } from "~/lib/zip-download";
import { useCan } from "~/lib/use-can";
import { OPEN_ADD } from "~/lib/shell";
import { listSets, toggleSetItem } from "~/lib/sets-api";
import { ActionBar, Btn, Chip, ChipBar, Info, Seg, Sheet, Tool } from "~/lib/ui";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Home,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = ITEM_TYPES;
const sourceLabel = (s: string) => (isItemSource(s) ? SOURCE_LABEL[s] : s);

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type CatItem = Catalog["items"][number];
type DepInfo = Awaited<ReturnType<typeof libraryMissingDeps>>["items"][number]["servers"];

// 一覧の絞り込み・並べ替え。oldIds は「更新あり」(アイテム → 古い版のサーバー)、depIds は「前提不足」を確かめた結果(確かめるまでは null)。mc は対応 MC で絞る
type Sort = "name" | "new" | "old";
type Filter = { q: string; type: string; source: string; tag: string; mc: string; sort: Sort; fav: boolean; old: boolean; oldIds: Map<string, Set<string>> | null;
  deps: boolean; depIds: Map<string, DepInfo> | null };
const NO_FILTER: Filter = { q: "", type: "", source: "", tag: "", mc: "", sort: "name", fav: false, old: false, oldIds: null, deps: false, depIds: null };
const SORTS = [["name", "名前順"], ["new", "新しい順"], ["old", "更新あり順"]] as const;

// お気に入りを上に。あとは名前順(サーバーから名前順で来る)か、追加日が新しい順か、更新があるものを先に
function filterItems(items: CatItem[], f: Filter) {
  const q = f.q.trim().toLowerCase();
  return items
    .filter((i) => (!q || i.title.toLowerCase().includes(q)) && (!f.type || i.projectType === f.type) && (!f.source || i.source === f.source) && (!f.fav || i.favorite)
      && (!f.tag || i.tags.includes(f.tag)) && (!f.old || !!f.oldIds?.has(i.id)) && (!f.mc || mcCovers(i.mc, f.mc)) && (!f.deps || !!f.depIds?.has(i.id)))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite)
      || (f.sort === "new" ? b.createdAt.localeCompare(a.createdAt) : f.sort === "old" ? Number(!!f.oldIds?.has(b.id)) - Number(!!f.oldIds?.has(a.id)) : 0));
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
  useEffect(() => {
    window.addEventListener(LIBRARY_CHANGED, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED, reload);
  }, []);
  const isLocal = useServerFn(localEnabled);
  const [uploads, setUploads] = useState(false); // アップロード・保存した版は自分用の版だけ
  useEffect(() => { isLocal().then(setUploads, () => setUploads(false)); }, []);

  const edit = can({ library: ["edit"] });
  const admin = can({ member: ["update"] });
  const [f, setF] = useState<Filter>(NO_FILTER);
  const set = (p: Partial<Filter>) => setF((x) => ({ ...x, ...p }));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null); // 詳しく見ているアイテム
  const [filterSheet, setFilterSheet] = useState(false);
  const shown = cat ? filterItems(cat.items, f) : [];
  const favorite = useServerFn(favoriteLibraryItem);
  const outdated = useServerFn(outdatedLibraryServers);
  const missing = useServerFn(libraryMissingDeps);
  // 「更新あり」「前提不足」は配布元に問い合わせるので、押したときだけ確かめる
  const checkOld = (then: Partial<Filter> = {}) => {
    set(then);
    setError("");
    if (!f.oldIds) outdated().then((r) => set({ oldIds: new Map(r.map((x) => [x.itemId, new Set(x.serverIds)])) }), (e) => { setError(message(e)); set({ old: false, sort: "name" }); });
  };
  const refreshDeps = () => missing({ data: {} }).then((r) => set({ depIds: new Map(r.items.map((d) => [d.itemId, d.servers])) }), (e) => { setError(message(e)); set({ deps: false }); });
  const toggleOld = () => (f.old ? set({ old: false }) : checkOld({ old: true }));
  const toggleDeps = () => {
    if (f.deps) return set({ deps: false });
    set({ deps: true });
    setError("");
    if (!f.depIds) refreshDeps();
  };
  // 先に画面を変え、うまくいかなければ読み直す
  const toggleFavorite = (item: CatItem) => {
    setCat((c) => c && { ...c, items: c.items.map((x) => (x.id === item.id ? { ...x, favorite: !item.favorite } : x)) });
    favorite({ data: { itemId: item.id, on: !item.favorite } }).catch((e) => { setError(message(e)); reload(); });
  };
  const quiet = !f.fav && !f.old && !f.deps && !f.type;
  const more = [f.q.trim(), f.tag, f.mc, f.source].filter(Boolean).length; // シートで決めた絞り込みの数
  const item = open ? cat?.items.find((i) => i.id === open) : undefined;

  return (
    <main className="page fill">
      <header className="bar">
        <h1>ライブラリ{cat && <small>{`${cat.items.length} 件`}</small>}
          <Info>
            <span>チームで使う Mod・プラグインの一覧です。Modrinth・SpigotMC のものは、サーバーが配布元から直接取り込みます(アップロードしたもの・保存した版は、保存先から送ります)。入れる版は、サーバーの種類とバージョンに合うものを選びます(Paper のサーバーには Paper 向けの作りを優先)。</span>
            <span>データパックは、サーバーのワールド(server.properties の level-name)の datapacks に入れます。リソースパック・シェーダーはクライアントで使うものなので、ライブラリで持ち、「詳しく」の版からダウンロードできます。Modパックからは、セットを作ったり、サーバーに中の Mod と設定ファイルを入れたりできます(新しい版が出たらお知らせします)。</span>
          </Info>
        </h1>
        {edit && <Link to="/cleanup" className="btn sm" title="アドオンの整理(古い版・重複・使っていないもの)">整理</Link>}
      </header>

      {cat && cat.items.length > 0 && (
        <ChipBar label="絞り込み" tools={<>
          <Tool icon="filter" label="絞り込み" count={more} onClick={() => setFilterSheet(true)} />
          <Tool icon="sort" label={SORTS.find(([v]) => v === f.sort)![1]} onClick={() => setFilterSheet(true)} />
        </>}>
          <Chip on={quiet} onClick={() => set({ fav: false, old: false, deps: false, type: "" })}>すべて</Chip>
          <Chip on={f.fav} onClick={() => set({ fav: !f.fav })}>お気に入り</Chip>
          <Chip on={f.old} warn onClick={toggleOld} title="どこかのサーバーに古い版が入っているもの(配布元に問い合わせます。更新を止めたものは除きます)">
            更新あり{f.oldIds && <span className="n">{f.oldIds.size}</span>}
          </Chip>
          <Chip on={f.deps} warn onClick={toggleDeps} title="入っているサーバーに、必須の前提が無いもの(配布元に問い合わせます)">
            前提不足{f.depIds && <span className="n">{f.depIds.size}</span>}
          </Chip>
          <span className="vsep" />
          {ITEM_TYPE_IDS.map((t) => <Chip key={t} on={f.type === t} onClick={() => set({ type: f.type === t ? "" : t })}>{ITEM_TYPES[t]}</Chip>)}
        </ChipBar>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <section className="group">
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
          <ItemRow key={i.id} item={i} servers={cat.servers} edit={edit} old={f.oldIds?.get(i.id)} dep={!!f.depIds?.has(i.id)}
            onOpen={() => setOpen(i.id)} onFavorite={() => toggleFavorite(i)}
            picked={picked.has(i.id)} onPick={(on) => setPicked((p) => { const n = new Set(p); if (on) n.add(i.id); else n.delete(i.id); return n; })} />
        ))}
      </section>

      {edit && cat && picked.size > 0 && (
        <Bulk ids={[...picked]} cat={cat} share={uploads} allShown={shown.every((i) => picked.has(i.id))}
          onAll={() => setPicked(new Set(shown.map((i) => i.id)))} onClear={() => setPicked(new Set())}
          onDone={(clear) => { if (clear) setPicked(new Set()); reload(); libraryChanged(); }} />
      )}
      {cat && item && (
        <ItemSheet key={item.id} item={item} cat={cat} edit={edit} admin={admin} local={uploads} old={f.oldIds?.get(item.id)} depInfo={f.depIds?.get(item.id)}
          onChange={reload} onDeps={() => { if (f.depIds) refreshDeps(); }} onFavorite={() => toggleFavorite(item)} onClose={() => setOpen(null)}
          onRemoved={() => { setOpen(null); reload(); libraryChanged(); }} />
      )}
      {cat && filterSheet && <FilterSheet cat={cat} f={f} set={set} count={shown.length} onOld={() => checkOld({ sort: "old" })} onClose={() => setFilterSheet(false)} />}
    </main>
  );
}

// 一覧の行: アイコン・名前・タグ・種類 · 配布元 · 対応 MC・印・サーバーごとの入り具合(パソコンだけ)・☆。押すと右のシートで詳しく
const PIPS = 6;
function ItemRow({ item, servers, edit, old, dep, onOpen, onFavorite, picked, onPick }:
  { item: CatItem; servers: Catalog["servers"]; edit: boolean; old?: Set<string>; dep: boolean; onOpen: () => void; onFavorite: () => void; picked: boolean; onPick: (on: boolean) => void }) {
  const at = new Map(item.installs.map((x) => [x.serverId, x]));
  // 入っているサーバーと、入れられるサーバー
  const pips = servers.filter((s) => at.has(s.id) || s.kinds.includes(item.projectType as ItemType));
  const newer = item.pack?.used && item.pack.latest && item.pack.latest.id !== item.pack.used.id;
  return (
    <div className="row click" onClick={onOpen}>
      {edit && <input type="checkbox" className="ck" checked={picked} onClick={(e) => e.stopPropagation()} onChange={(e) => onPick(e.target.checked)} aria-label={`${item.title} を選ぶ`} />}
      <span className="ic"><ItemIcon type={item.projectType} url={item.iconUrl ?? undefined} /></span>
      <button type="button" className="mid" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
        <span className="ttl"><span translate="no">{item.title}</span>{item.tags.map((t) => <span key={t} className="tag" translate="no">{t}</span>)}</span>
        <span className="sub">{TYPE_LABEL[item.projectType] ?? item.projectType} · {sourceLabel(item.source)}{item.mc.length > 0 && ` · MC ${mcRange(item.mc)}`}</span>
      </button>
      {(old || newer) && <span className="badge upd">更新あり</span>}
      {dep && <span className="badge bad">前提不足</span>}
      {pips.length > 0 && (
        <span className="srvs hide-p" title="緑 = 入っている・橙 = 古い" translate="no">
          {pips.slice(0, PIPS).map((s) => {
            const x = at.get(s.id);
            return <i key={s.id} className={x ? (old?.has(s.id) ? "old" : "in") : ""} title={`${s.name}: ${x ? x.versionNumber : "—"}`}>{s.name.slice(0, 1)}</i>;
          })}
          {pips.length > PIPS && <i>{`+${pips.length - PIPS}`}</i>}
        </span>
      )}
      <button type="button" className="link star" aria-pressed={item.favorite} onClick={(e) => { e.stopPropagation(); onFavorite(); }}
        aria-label={item.favorite ? "お気に入りから外す" : "お気に入りにする"} title={item.favorite ? "お気に入りから外す" : "お気に入りにする"}>★</button>
    </div>
  );
}

// 絞り込みと並べ替え(タグ・Minecraft・配布元・名前)
function FilterSheet({ cat, f, set, count, onOld, onClose }: { cat: Catalog; f: Filter; set: (p: Partial<Filter>) => void; count: number; onOld: () => void; onClose: () => void }) {
  const tags = [...new Set(cat.items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, "ja"));
  const mcs = [...new Set(cat.items.flatMap((i) => i.mc))].sort(mcCompare).reverse();
  const sources = [...new Set(cat.items.map((i) => i.source))];
  return (
    <Sheet title="絞り込みと並べ替え" onClose={onClose}>
      <input className="input" type="search" placeholder="名前で絞り込む" aria-label="名前で絞り込む" value={f.q} onChange={(e) => set({ q: e.target.value })} />
      {tags.length > 0 && <>
        <div className="gtitle">タグ</div>
        <div className="chips">{tags.map((t) => <Chip key={t} on={f.tag === t} onClick={() => set({ tag: f.tag === t ? "" : t })}><span translate="no">{t}</span></Chip>)}</div>
      </>}
      {mcs.length > 0 && <>
        <div className="gtitle">Minecraft</div>
        <div className="chips">
          <Chip on={!f.mc} onClick={() => set({ mc: "" })}>すべて</Chip>
          {mcs.map((v) => <Chip key={v} on={f.mc === v} onClick={() => set({ mc: v })}>{v}</Chip>)}
        </div>
      </>}
      <div className="gtitle">配布元</div>
      <div className="chips">
        <Chip on={!f.source} onClick={() => set({ source: "" })}>すべて</Chip>
        {sources.map((s) => <Chip key={s} on={f.source === s} onClick={() => set({ source: s })}>{sourceLabel(s)}</Chip>)}
      </div>
      <div className="gtitle">並べ替え</div>
      <Seg label="並べ替え" value={f.sort} options={SORTS} onChange={(v) => (v === "old" ? onOld() : set({ sort: v }))} />
      <div className="sheet-foot">
        <Btn onClick={() => set({ q: "", tag: "", mc: "", source: "", sort: "name" })}>元に戻す</Btn>
        <span className="grow" />
        <Btn kind="pri" onClick={onClose}>{`${count} 件を表示`}</Btn>
      </div>
    </Sheet>
  );
}

// チェックで選んだものをまとめて: タグを付ける・セットに足す・サーバーに入れる・zip・共有リンク・ライブラリから外す
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
        <Btn sm disabled={busy} onClick={addTag}>タグ</Btn>
        {sets.length > 0 && <Btn sm disabled={busy} onClick={() => setSheet("sets")}>セットへ</Btn>}
        {cat.servers.length > 0 && <Btn kind="tint" sm disabled={busy} onClick={() => setSheet("install")}>入れる</Btn>}
        {share && <Btn sm disabled={busy} onClick={() => downloadZip(plan, { itemIds: ids }).catch((e) => setError(message(e)))}>zip</Btn>}
        {share && <Btn sm disabled={busy} onClick={() => setSheet("share")}>共有</Btn>}
        <Btn kind="red" sm disabled={busy} onClick={removeAll}>外す</Btn>
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

// アイテムの詳しい情報(右のシート): サーバー / 版 / 前提 / 情報
type Tab = "servers" | "versions" | "deps" | "info";
function ItemSheet({ item, cat, edit, admin, local, old, depInfo, onChange, onDeps, onFavorite, onClose, onRemoved }:
  { item: CatItem; cat: Catalog; edit: boolean; admin: boolean; local: boolean; old?: Set<string>; depInfo?: DepInfo;
    onChange: () => void; onDeps: () => void; onFavorite: () => void; onClose: () => void; onRemoved: () => void }) {
  const [tab, setTab] = useState<Tab>("servers");
  return (
    <Sheet title={<span translate="no">{item.title}</span>} label={item.title} onClose={onClose}
      head={<span className="ic"><ItemIcon type={item.projectType} url={item.iconUrl ?? undefined} /></span>}
      actions={<button type="button" className="link star" aria-pressed={item.favorite} onClick={onFavorite}
        aria-label={item.favorite ? "お気に入りから外す" : "お気に入りにする"} title={item.favorite ? "お気に入りから外す" : "お気に入りにする"}>★</button>}>
      <div className="sub">{TYPE_LABEL[item.projectType] ?? item.projectType} · {sourceLabel(item.source)}{item.mc.length > 0 && ` · MC ${mcRange(item.mc)}`}</div>
      <Seg label="詳しく" value={tab} options={[["servers", "サーバー"], ["versions", "版"], ["deps", "前提"], ["info", "情報"]]} onChange={setTab} />
      {tab === "servers" && <ServersTab item={item} cat={cat} edit={edit} admin={admin} old={old} depInfo={depInfo} onChange={onChange} onDeps={onDeps} onRemoved={onRemoved} />}
      {tab === "versions" && <>
        {item.source !== "upload" && <Versions item={item} canSave={edit && local && item.source !== "spigot"} onSaved={onChange} />}
        {(item.source === "upload" || local) && <>
          <div className="gtitle">{item.source === "upload" ? "アップロードした版" : item.files ? `保存した版(${item.files})` : "保存した版"}</div>
          <Files item={item} keep={cat.keep} edit={edit} local={local} onChange={onChange} />
        </>}
      </>}
      {tab === "deps" && <Deps item={item} cat={cat} edit={edit} onChange={onChange} />}
      {tab === "info" && <ItemInfo item={item} cat={cat} admin={admin} onChange={onChange} />}
    </Sheet>
  );
}

// サーバーごとの入り具合(入れる・更新する)・タグ・ライブラリから外す
function ServersTab({ item, cat, edit, admin, old, depInfo, onChange, onDeps, onRemoved }:
  { item: CatItem; cat: Catalog; edit: boolean; admin: boolean; old?: Set<string>; depInfo?: DepInfo; onChange: () => void; onDeps: () => void; onRemoved: () => void }) {
  const install = useServerFn(installMod);
  const remove = useServerFn(removeLibraryItem);
  const tag = useServerFn(tagLibraryItems);
  const fromPack = useServerFn(modpackFromItem);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const run = async (key: string, fn: () => Promise<unknown>, after = onChange) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      after();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const at = new Map(item.installs.map((x) => [x.serverId, x]));
  // データパックはワールドのあるサーバーに。リソースパック・シェーダーはサーバーに入れない。Modパックは Mod のサーバーに中身を入れる(設定ファイルも書くので管理者以上)
  const pack = item.projectType === "modpack";
  const client = item.projectType === "resourcepack" || item.projectType === "shader";
  const rows = pack ? (admin ? cat.servers.filter((s) => s.type === "mod") : []) : cat.servers.filter((s) => at.has(s.id) || s.kinds.includes(item.projectType as ItemType));
  const newer = item.pack?.used && item.pack.latest && item.pack.latest.id !== item.pack.used.id ? item.pack.latest : null;
  const packRun = (serverId?: string) => run(serverId ?? "pack", async () => {
    const r = await fromPack({ data: { itemId: item.id, serverId } });
    const failed = r.applied?.filter((x) => x.status === "failed").length ?? 0;
    setNote(`セット「${r.name}」を作りました(${r.added} 件)${r.applied ? `。サーバーに入れました(失敗 ${failed} 件)` : ""}`);
  });
  const put = (serverId: string) => {
    if (!isItemSource(item.source)) return;
    if (pack) {
      if (confirm("Modパックの中の Mod と設定ファイル(overrides)を、このサーバーに入れますか?(同じ名前のセットも作ります。上書きした設定ファイルは履歴から戻せます)")) packRun(serverId);
    } else run(serverId, () => install({ data: { id: serverId, projectId: item.projectId, source: item.source as ItemSource } }), () => { onChange(); onDeps(); });
  };
  return (
    <>
      {pack && (
        <div className="chips">
          {item.pack?.used && <span className="muted small" translate="no">{`使った版 ${item.pack.used.number}`}</span>}
          {newer && <span className="badge upd" translate="no">{`新しい版 ${newer.number}`}</span>}
          {edit && <Btn kind="tint" sm disabled={!!busy} onClick={() => packRun()}>{newer ? "新しい版でセットを作る" : "セットを作る"}</Btn>}
        </div>
      )}
      {client ? <p className="muted">クライアントで使うもの</p> : (
        <section className="group">
          {rows.length === 0 && <div className="row muted">{item.installs.length ? "" : "どのサーバーにも入っていません"}</div>}
          {rows.map((s) => {
            const x = at.get(s.id);
            const isOld = !!x && !!old?.has(s.id);
            return (
              <div key={s.id} className="row">
                <span className="mid">
                  <span className="ttl" translate="no">{s.name}</span>
                  <span className="sub">{x ? <><span translate="no">{x.versionNumber}</span>{x.disabled && <> · <span>無効</span></>}{isOld && <> · <span>古い版</span></>}</> : "—"}</span>
                </span>
                {busy === s.id && <span className="muted small">しています…</span>}
                {edit && !pack && isOld && <Btn kind="tint" sm disabled={!!busy} onClick={() => put(s.id)}>更新</Btn>}
                {edit && (pack || !x) && <Btn sm disabled={!!busy} onClick={() => put(s.id)}>入れる</Btn>}
              </div>
            );
          })}
        </section>
      )}
      {depInfo && <DepWarnings servers={depInfo} edit={edit} onInstalled={() => { onChange(); onDeps(); }} />}
      {item.channel === "all" && <span><span className="badge muted-badge">ベータ版も受け取る</span></span>}
      {(item.tags.length > 0 || edit) && <>
        <div className="gtitle">タグ</div>
        <div className="chips">
          {item.tags.map((t) => edit
            ? <Chip key={t} on disabled={!!busy} title="押すとタグを外します" onClick={() => run("tag", () => tag({ data: { itemIds: [item.id], tag: t, on: false } }))}><span translate="no">{t}</span> ✕</Chip>
            : <span key={t} className="chip" translate="no">{t}</span>)}
          {edit && <Chip disabled={!!busy} onClick={() => { const t = prompt("付けるタグ(30 文字まで)")?.trim(); if (t) run("tag", () => tag({ data: { itemIds: [item.id], tag: t, on: true } })); }}>＋ タグ</Chip>}
        </div>
      </>}
      {busy === "pack" && <p className="muted">Modパックを読んでいます…</p>}
      {busy === "remove" && <p className="muted">外しています…</p>}
      {note && <p className="muted" role="status" translate="no">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {edit && (
        <div className="sheet-foot">
          <Btn kind="red" sm disabled={!!busy}
            onClick={() => confirm(`${item.title} をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`) && run("remove", () => remove({ data: { itemId: item.id } }), onRemoved)}>
            ライブラリから外す
          </Btn>
        </div>
      )}
    </>
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
    <section className="group">
      {servers.flatMap((s) => s.deps.map((d) => (
        <div key={`${s.serverId}:${d.source}:${d.projectId}`} className="row">
          <span className="badge bad">前提</span>
          <span className="mid"><span className="ttl" translate="no">{d.title}</span><span className="sub"><span translate="no">{s.serverName}</span> — 前提が入っていません</span></span>
          {edit && <Btn kind="tint" sm disabled={!!busy} onClick={() => add(s.serverId, d)}>{busy === `${s.serverId}:${d.projectId}` ? "入れています…" : "入れる"}</Btn>}
        </div>
      )))}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

// 前提(手で決めたもの・サーバーに足りないもの)
function Deps({ item, cat, edit, onChange }: { item: CatItem; cat: Catalog; edit: boolean; onChange: () => void }) {
  const check = useServerFn(libraryMissingDeps);
  const link = useServerFn(linkLibraryDep);
  const [miss, setMiss] = useState<DepInfo | null>(null);
  const [error, setError] = useState("");
  // 前提はサーバーに入れるもの(プラグイン・Mod・データパック)だけ
  const onServer = item.projectType === "plugin" || item.projectType === "mod" || item.projectType === "datapack";
  const recheck = () => { if (onServer) check({ data: { itemId: item.id } }).then((r) => setMiss(r.items[0]?.servers ?? []), (e) => setError(message(e))); };
  useEffect(recheck, [item.id]);
  if (!onServer) return <p className="muted">サーバーに入れないものなので、前提はありません</p>;
  const titleOf = (id: string) => cat.items.find((i) => i.id === id)?.title ?? id;
  const others = cat.items.filter((i) => i.id !== item.id && !item.deps.includes(i.id));
  const setLink = (depItemId: string, on: boolean) => link({ data: { itemId: item.id, depItemId, on } }).then(() => { onChange(); recheck(); }, (e) => setError(message(e)));
  return (
    <>
      <div className="gtitle">手で決めた前提</div>
      <div className="chips">
        {item.deps.length === 0 && <span className="muted small">なし</span>}
        {item.deps.map((id) => edit
          ? <Chip key={id} on title="押すと前提から外します" onClick={() => setLink(id, false)}><span translate="no">{titleOf(id)}</span> ✕</Chip>
          : <span key={id} className="chip" translate="no">{titleOf(id)}</span>)}
        {edit && others.length > 0 && (
          <select className="chip" value="" aria-label="前提を足す" onChange={(e) => e.target.value && setLink(e.target.value, true)}>
            <option value="">前提を足す…</option>
            {others.map((i) => <option key={i.id} value={i.id} translate="no">{i.title}</option>)}
          </select>
        )}
      </div>
      <div className="gtitle">サーバー</div>
      {miss === null && !error && <p className="muted">入っているサーバーの前提を確かめています…</p>}
      {miss?.length === 0 && <p className="muted">{item.installs.length ? "入っているサーバーに、前提はそろっています" : "どのサーバーにも入っていません"}</p>}
      {miss && miss.length > 0 && <DepWarnings servers={miss} edit={edit} onInstalled={() => { onChange(); recheck(); }} />}
      {error && <p className="error" role="alert">{error}</p>}
    </>
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
      <div className="gtitle">{item.source === "spigot" ? "更新のお知らせ" : "版と変更内容"}</div>
      <section className="group">
        {!list && !error && <div className="row muted">読み込んでいます…</div>}
        {list?.length === 0 && <div className="row muted">版がありません</div>}
        {list?.map((v) => (
          <div key={v.versionId} className="row column">
            <div className="chips">
              <span className="ttl" translate="no">{v.versionNumber}</span>
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

// 情報: 種類・配布元・対応 MC・受け取る版。管理者以上は直せる
function ItemInfo({ item, cat, admin, onChange }: { item: CatItem; cat: Catalog; admin: boolean; onChange: () => void }) {
  const url = pageUrl(item.source, item.projectId, item.slug);
  const channel: Channel = item.channel || cat.channel;
  return (
    <>
      <section className="group">
        <div className="row"><span>種類</span><span className="trail">{TYPE_LABEL[item.projectType] ?? item.projectType}</span></div>
        <div className="row"><span>配布元</span><span className="trail">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{sourceLabel(item.source)}</a> : sourceLabel(item.source)}</span></div>
        {item.mc.length > 0 && <div className="row"><span>対応 MC</span><span className="trail" translate="no">{mcRange(item.mc)}</span></div>}
        <div className="row"><span>受け取る版</span><span className="trail">{CHANNELS[channel]}</span></div>
        <div className="row"><span>追加日</span><span className="trail">{new Date(item.createdAt).toLocaleDateString("ja-JP")}</span></div>
      </section>
      {admin && <EditInfo item={item} teamChannel={cat.channel} onDone={onChange} />}
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
          <span><Btn kind="pri" sm disabled={busy}
            onClick={() => run(async () => { await save({ data: { itemId: item.id, projectType: type, loaders: listOf(loaders), mcVersions: listOf(mc), channel } }); return "保存しました"; })}>
            {busy ? "保存しています…" : "保存"}
          </Btn></span>
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
    <section className="group">
      {files?.length === 0 && <div className="row muted">{upstream ? "まだ保存した版はありません" : "版がありません"}</div>}
      {files?.map((f) => (
        <div key={f.id} className="row">
          <span className="mid">
            <span className="ttl" translate="no">{f.version || f.filename}</span>
            <span className="sub">{(f.size / 1024).toFixed(0)} KB・{new Date(f.createdAt).toLocaleDateString("ja-JP")}{f.loaders.length ? `・${f.loaders.join(" / ")}` : ""}</span>
          </span>
          <a className="btn sm" href={`/api/library/files/${f.id}`} download>ダウンロード</a>
          {edit && <Btn kind="red" sm
            onClick={() => confirm(`${f.filename} を消しますか?(保存先からも消えます。サーバーに入っているものはそのままです)`) && remove({ data: { fileId: f.id } }).then(reload, (e) => setError(message(e)))}>消す</Btn>}
        </div>
      ))}
      {edit && files && files.length > 0 && <div className="row"><ShareMaker itemIds={[itemId]} name={title} label="共有リンクを作る(いちばん新しい版)" /></div>}
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
