import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ApplyResults } from "~/lib/apply-results";
import { libraryCatalog, libraryItemVersions } from "~/lib/library-api";
import { uploadedFiles } from "~/lib/uploads-api";
import { getSchedule, setSchedule } from "~/lib/schedule-api";
import { ITEM_TYPES, PLATFORMS, PLATFORM_IDS, mcRange } from "~/lib/platforms";
import { localDate } from "~/lib/format";
import { AddonIcon } from "~/lib/type-icon";
import { addSetDeps, applySet, bindServerSet, createSet, listSets, pinSetItem, removeSet, renameSet, saveSetServerPicks, setMissingDeps, setServerPicks, syncServerSet, toggleSetItem } from "~/lib/sets-api";
import { Btn, Chip, Icon, Info, Menu, Seg, Sheet, fmtSize } from "~/lib/ui";
import { sourceLabel } from "~/lib/sources";
import { useCan } from "~/lib/use-can";
import { sharedLocalEnabled } from "~/lib/servers-api";
import { zipPlan } from "~/lib/saved-api";
import { MobileSearch, StoragePill } from "~/lib/shell";
import { downloadZip } from "~/lib/zip-download";
import { pageTitle } from "~/lib/titles";
import { confirmDialog, promptDialog } from "~/lib/dialog-queue";
import { jobsChanged } from "~/lib/jobs-ui";

export const Route = createFileRoute("/sets")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/sets" } });
    return { user: context.user };
  },
  loader: async () => ({ sets: await listSets(), catalog: await libraryCatalog() }),
  head: () => ({ meta: [{ title: pageTitle("セット") }] }),
  component: Sets,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = ITEM_TYPES;

type SetRow = Awaited<ReturnType<typeof listSets>>[number];
type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type Result = Awaited<ReturnType<typeof applySet>>;

// セット(v02 と同じ形): 見出しの下に一言と「＋ セットを作る」、2 列のカード(名前・件数・中身・操作)。編集・サーバーに入れるは右のシートで、中身・前提・版の固定・サーバーを扱う
function Sets() {
  const { user } = Route.useRouteContext();
  const { sets, catalog } = Route.useLoaderData();
  const { can } = useCan(user.id);
  const router = useRouter();
  const reload = () => router.invalidate();
  const edit = can({ library: ["edit"] });
  const [local, setLocal] = useState(false); // zip は保存した版から作るので、自分用の版だけ
  const [sheet, setSheet] = useState<"" | "new" | "schedule">("");
  const [open, setOpen] = useState("");
  useEffect(() => { sharedLocalEnabled().then(setLocal, () => setLocal(false)); }, []);
  const opened = sets.find((s) => s.id === open);

  return (
    <main className="page fill">
      <header className="bar">
        <h1>セット<small>{`${sets.length} 個`}</small>
          <Info>
            <span>セットは、ライブラリから選んだ Mod・プラグインの組み合わせです。「サーバーに入れる」で、サーバーの種類に合うもののうち、まだ入っていないものをまとめて入れます(Paper のサーバーに Mod は入れません)。「前提を確かめる」は、選んだ種類のサーバーに入るいちばん新しい版の前提(Modrinth・CurseForge の必須)が、セットに入っているかを見ます。</span>
            <span>「版を選ぶ」で版を固定すると、セットを入れる・そろえる・予約・自動更新で、新しい版ではなくその版を入れます(サーバーの種類・バージョンに合わない版は、結果に知らせて飛ばします)。セットを結び付けたすべてのサーバーで同じ版になります。サーバーの画面の「更新を止める」は、そのサーバーだけいま入っている版のままにするもので、固定より先に効きます。SpigotMC のものは固定できません(いちばん新しい版だけを入れられます)。</span>
          </Info>
        </h1>
        <StoragePill />
      </header>
      <MobileSearch />
      <div className="view-head">
        <p className="muted">よく使う組み合わせをセットにして、サーバーにまとめて入れます。</p>
        <span className="grow" />
        <Btn sm onClick={() => setSheet("schedule")}>そろえる予約</Btn>
        {edit && <Btn kind="pri" onClick={() => setSheet("new")}>＋ セットを作る</Btn>}
      </div>
      {sets.length === 0 && (
        <section className="card glass empty"><span className="big" aria-hidden="true">🧺</span><p>まだセットがありません</p>{edit && <Btn kind="tint" onClick={() => setSheet("new")}>最初のセットを作る</Btn>}</section>
      )}
      <div className="cards">
        {sets.map((s) => <SetCard key={s.id} set={s} edit={edit} local={local} onOpen={() => setOpen(s.id)} onChange={reload} />)}
      </div>
      {opened && <SetSheet set={opened} catalog={catalog} elsewhere={new Map(sets.filter((x) => x.id !== opened.id).flatMap((x) => x.servers.map((v) => [v.id, x.name] as const)))} edit={edit} local={local} onChange={reload} onClose={() => setOpen("")} />}
      {sheet === "new" && (
        <Sheet title="セットを作る" onClose={() => setSheet("")}>
          <NewSet onCreated={() => { reload(); setSheet(""); }} />
          <FromModpack onCreated={reload} servers={can({ server: ["update"] }) ? catalog.servers : []} />
        </Sheet>
      )}
      {sheet === "schedule" && <Sheet title="そろえる予約" onClose={() => setSheet("")}><Schedule editable={can({ server: ["update"] })} /></Sheet>}
    </main>
  );
}

const SHOW_ITEMS = 5;
// セットのカード: 名前・件数・中身(版の固定 / 常に最新)・結び付けたサーバー・操作
function SetCard({ set, edit, local, onOpen, onChange }: { set: SetRow; edit: boolean; local: boolean; onOpen: () => void; onChange: () => void }) {
  const plan = useServerFn(zipPlan);
  const remove = useServerFn(removeSet);
  const [error, setError] = useState("");
  return (
    <section className="card glass set-card">
      <div className="card-h">
        <h4 translate="no">{set.name}</h4>
        <span className="badge cat">{`${set.items.length} 件`}</span>
      </div>
      <div className="card-b">
        {set.items.length === 0 && <p className="dash-empty">まだ何も入っていません</p>}
        {set.items.length > 0 && (
          <div className="group flat">
            {set.items.slice(0, SHOW_ITEMS).map((i) => (
              <Link key={i.id} to="/" search={{ item: i.id }} className="row click">
                <AddonIcon type={i.projectType} url={i.iconUrl} />
                <span className="mid">
                  <span className="ttl" translate="no">{i.title}</span>
                  <span className="sub">{i.versionId ? <><b translate="no">{i.versionNumber}</b>(固定)</> : "常に最新"}</span>
                </span>
                <span className="chev" aria-hidden="true">›</span>
              </Link>
            ))}
            {set.items.length > SHOW_ITEMS && <button type="button" className="row link" onClick={onOpen}>{`ほか ${set.items.length - SHOW_ITEMS} 件`}</button>}
          </div>
        )}
        {set.servers.length > 0 && <p className="sub" translate="no">{set.servers.map((x) => x.name).join("・")}</p>}
        <div className="chips">
          {local && set.items.length > 0 && <Btn kind="tint" sm onClick={() => { downloadZip(plan, { setId: set.id }).catch((e) => setError(message(e))); }}>zip でダウンロード</Btn>}
          {edit && <Btn sm onClick={onOpen}>サーバーに入れる</Btn>}
          <Btn sm onClick={onOpen}>{edit ? "編集" : "開く"}</Btn>
          {edit && <Btn kind="red" sm onClick={async () => {
            if (!(await confirmDialog({ message: `セット「${set.name}」を消しますか?(ライブラリとサーバーはそのままです)`, ok: "消す", danger: true }))) return;
            try {
              await remove({ data: { id: set.id } });
              onChange();
            } catch (e) {
              setError(message(e));
            }
          }}>消す</Btn>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

// セットのシート: 中身(版の固定・外す・足す)・前提・サーバー(そろえる・入れる)
function SetSheet({ set, catalog, elsewhere, edit, local, onChange, onClose }: { set: SetRow; catalog: Catalog; elsewhere: Map<string, string>; edit: boolean; local: boolean; onChange: () => void; onClose: () => void }) {
  const toggle = useServerFn(toggleSetItem);
  const plan = useServerFn(zipPlan);
  const rename = useServerFn(renameSet);
  const remove = useServerFn(removeSet);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [type, setType] = useState(""); // 種類での絞り込み(空 = すべて)
  const [pinning, setPinning] = useState<string | null>(null); // 版を選ぶ欄を開いているアイテム
  const [adding, setAdding] = useState(set.items.length === 0); // ライブラリから選ぶ欄(中身が空なら初めから開く)
  const inSet = new Set(set.items.map((i) => i.id));
  const fits = (i: { projectType: string }) => !type || i.projectType === type;
  const addable = catalog.items.filter((i) => !inSet.has(i.id) && fits(i));
  const types = [...new Set([...set.items, ...catalog.items].map((i) => i.projectType))];

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
    <Sheet title={<span translate="no">{set.name}</span>} label={set.name} onClose={onClose} actions={edit || local ? (
      <Menu disabled={!!busy} items={[
        edit && { label: "名前を変える", onClick: async () => { const n = await promptDialog({ title: "名前を変える", placeholder: "セットの新しい名前", value: set.name, max: 60 }); if (n && n !== set.name) run("rename", () => rename({ data: { id: set.id, name: n } })); } },
        local && set.items.length > 0 && { label: "zip でダウンロード(保存した版から)", onClick: () => { downloadZip(plan, { setId: set.id }).catch((e) => setError(message(e))); } },
        edit && { label: "セットを消す", danger: true, onClick: async () => { if ((await confirmDialog({ message: `セット「${set.name}」を消しますか?(ライブラリとサーバーはそのままです)`, ok: "消す", danger: true }))) run("remove", async () => { await remove({ data: { id: set.id } }); onClose(); }); } },
      ]} />
    ) : undefined}>
      <div className="gtitle">{`中身(${set.items.length} 件)`}</div>
      {types.length > 1 && (
        <div className="chips" role="group" aria-label="種類で絞り込む">
          <Chip on={!type} onClick={() => setType("")}>すべて</Chip>
          {types.map((k) => <Chip key={k} on={type === k} onClick={() => setType(type === k ? "" : k)}>{TYPE_LABEL[k] ?? k}</Chip>)}
        </div>
      )}
      <section className="group">
        {set.items.length === 0 && <div className="row muted">まだ何も入っていません。{edit && catalog.items.length === 0 ? "先にライブラリに Mod・プラグインを登録すると、ここに足せます。" : ""}</div>}
        {set.items.filter(fits).map((i) => [
          <div className="row" key={i.id}>
            <AddonIcon type={i.projectType} url={i.iconUrl} />
            <span className="mid">
              <span className="ttl" translate="no">{i.title}</span>
              <span className="sub">{sourceLabel(i.source, i.origin)} · {i.versionId ? <><b translate="no">{i.versionNumber}</b> に固定</> : "いつも新しい版"}</span>
            </span>
            {edit && i.source !== "spigot" && (
              <button className="trail link" type="button" disabled={!!busy} aria-expanded={pinning === i.id} onClick={() => setPinning(pinning === i.id ? null : i.id)}>
                {pinning === i.id ? "閉じる" : i.versionId ? "版を変える" : "版を選ぶ"}
              </button>
            )}
            {edit && <Btn kind="red" sm disabled={!!busy} onClick={() => run(i.id, () => toggle({ data: { id: set.id, itemId: i.id, add: false } }))}>外す</Btn>}
          </div>,
          pinning === i.id && <PinPanel key={`pin-${i.id}`} setId={set.id} item={i} onDone={onChange} onClose={() => setPinning(null)} />,
        ])}
        {edit && addable.length > 0 && !adding && (
          <button className="row link" type="button" disabled={!!busy} onClick={() => setAdding(true)}>{`＋ ライブラリから足す(${addable.length} 件から選ぶ)`}</button>
        )}
      </section>
      {edit && addable.length > 0 && adding && (
        <AddPicker items={addable} busy={!!busy} onClose={() => setAdding(false)}
          onAdd={(ids) => run("add", async () => { for (const itemId of ids) await toggle({ data: { id: set.id, itemId, add: true } }); setAdding(false); })} />
      )}
      {set.items.some((i) => i.source === "modrinth" || i.source === "curseforge") && <>
        <div className="gtitle">前提<Info>セットの Mod・プラグインが必要とするもの(Modrinth・CurseForge の「必須」)のうち、セットに入っていないものを探します。必要なものはサーバーの種類で変わるので、入れる先の種類を選んでから確かめます。</Info></div>
        <section className="group"><Deps set={set} edit={edit} onChange={onChange} /></section>
      </>}
      {edit && set.items.length > 0 && <SetServers set={set} catalog={catalog} elsewhere={elsewhere} onChange={onChange} />}
      {error && <p className="error" role="alert">{error}</p>}
    </Sheet>
  );
}

// セットのサーバー: このセットを結び付けたサーバーを並べ、「＋ サーバーを追加」で 1 台ずつ足す(結び付けるのは 1 台に 1 つ)。
// 「編集」でアイテムごとに入れる版(最新・ライブラリに保存した版)を選び、「入れる」で足りないものを入れて、選んだ版にそろえる
function SetServers({ set, catalog, elsewhere, onChange }: { set: SetRow; catalog: Catalog; elsewhere: Map<string, string>; onChange: () => void }) {
  const bind = useServerFn(bindServerSet);
  const sync = useServerFn(syncServerSet);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ server: string; list: Result } | null>(null);
  const info = (id: string) => catalog.servers.find((s) => s.id === id);
  const candidates = catalog.servers.filter((s) => !set.servers.some((b) => b.id === s.id));
  const kinds = new Set(set.items.map((i) => i.projectType));
  // 入れられるか: 種類を決めていて、セットの中にそのサーバーの種類のもの(またはデータパック)がある
  const fitsSet = (s: Catalog["servers"][number]) => !!s.type && (kinds.has(s.type) || (kinds.has("datapack") && s.kinds.includes("datapack")));
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const add = (id: string) => run(`add:${id}`, async () => {
    const from = elsewhere.get(id);
    if (from && !(await confirmDialog({ message: `このサーバーは、いまセット「${from}」を結び付けています。「${set.name}」に付け替えますか?(サーバーに入っているものはそのままです)`, ok: "付け替える" }))) return;
    await bind({ data: { serverId: id, setId: set.id } });
    setPicking(false);
    setEditing(id);
    onChange();
  });
  return (
    <>
      <div className="gtitle">サーバー<Info>このセットを入れるサーバーです。「＋ サーバーを追加」で 1 台ずつ足します(1 台のサーバーに結び付けるセットは 1 つ)。「編集」で、アドオンごとに「最新」(このサーバーに合う、配布元のいちばん新しい版)か「ライブラリ」(保存した版。その版に固定)を選べます。「入れる」は、足りないものを入れ、選んだ版にそろえます。</Info></div>
      <section className="group">
        {set.servers.length === 0 && !picking && <div className="row muted">このセットを入れるサーバーは、まだありません。</div>}
        {set.servers.map((b) => {
          const s = info(b.id);
          const open = editing === b.id;
          return [
            <div className="row" key={b.id}>
              <span className="cicon c-teal" aria-hidden="true"><Icon name="servers" /></span>
              <span className="mid">
                <span className="ttl" translate="no">{b.name}</span>
                <span className="sub">{[s?.type === "mod" ? "Mod" : s?.type ? "プラグイン" : "種類を決めていません", s?.mc && `MC ${s.mc}`].filter(Boolean).join(" · ")}</span>
              </span>
              <Btn sm disabled={!!busy} aria-expanded={open} onClick={() => setEditing(open ? null : b.id)}>{open ? "閉じる" : "編集"}</Btn>
              <Btn kind="tint" sm disabled={!!busy} onClick={async () => {
                if (await confirmDialog({ message: `「${b.name}」に「${set.name}」を入れますか?(足りないものを入れ、選んだ版にそろえます)`, ok: "入れる" })) {
                  run(`sync:${b.id}`, async () => { jobsChanged(); setResults({ server: b.name, list: await sync({ data: { serverId: b.id, mode: "add" } }) }); });
                }
              }}>{busy === `sync:${b.id}` ? "入れています…" : "入れる"}</Btn>
            </div>,
            open && <PicksPanel key={`p-${b.id}`} set={set} serverId={b.id} serverName={b.name} busy={!!busy}
              onClose={() => setEditing(null)}
              onRemove={() => run(`rm:${b.id}`, async () => {
                if (!(await confirmDialog({ message: `「${b.name}」をこのセットから外しますか?(サーバーに入っているものはそのままです)`, ok: "外す", danger: true }))) return;
                await bind({ data: { serverId: b.id, setId: null } });
                setEditing(null);
                onChange();
              })} />,
          ];
        })}
        {picking && (
          <div className="row column set-pick">
            <span className="pick-head"><span className="muted small">追加するサーバーを選ぶ</span><Btn sm onClick={() => setPicking(false)}>やめる</Btn></span>
            {candidates.length === 0 && <span className="muted small">追加できるサーバーは、もうありません。</span>}
            <div className="group flat">
              {candidates.map((s) => {
                const ok = fitsSet(s);
                return (
                  <button key={s.id} type="button" className="row click" disabled={!ok || !!busy} onClick={() => add(s.id)}>
                    <span className="cicon c-teal" aria-hidden="true"><Icon name="servers" /></span>
                    <span className="mid">
                      <span className="ttl" translate="no">{s.name}</span>
                      <span className="sub">{!s.type ? "種類を決めていないので選べません" : !ok ? "このセットに、このサーバーの種類のものがありません"
                        : [s.type === "mod" ? "Mod のサーバー" : "プラグインのサーバー", s.mc && `Minecraft ${s.mc}`, elsewhere.get(s.id) && `いまは「${elsewhere.get(s.id)}」`].filter(Boolean).join(" · ")}</span>
                    </span>
                    {ok && <span className="trail link">選ぶ</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {!picking && <button type="button" className="row link add-row" disabled={!!busy} onClick={() => { setPicking(true); setEditing(null); }}>＋ サーバーを追加</button>}
        {busy.startsWith("sync:") && <div className="row muted">サーバーに入れています…(上のバーの処理のしるしでも見られます)</div>}
        {results && <ApplyResults server={results.server} verb="入れた" list={results.list} />}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

const SUPPORT_TAG: Record<string, [string, string]> = { ok: ["対応", "ok"], unknown: ["対応不明", "muted-badge"], no: ["非対応", "bad"] };
type Picks = Awaited<ReturnType<typeof setServerPicks>>;

// サーバーで入れる版を、アドオンごとに「最新」か「ライブラリ(保存した版)」から選ぶ(行の下に開く)。保存した版が 2 つ以上あれば、どの版かも選ぶ
function PicksPanel({ set, serverId, serverName, busy, onClose, onRemove }: { set: SetRow; serverId: string; serverName: string; busy: boolean; onClose: () => void; onRemove: () => void }) {
  const load = useServerFn(setServerPicks);
  const save = useServerFn(saveSetServerPicks);
  const [data, setData] = useState<Picks | null>(null);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    load({ data: { id: set.id, serverId } }).then((d) => { setData(d); setDraft(Object.fromEntries(d.items.map((i) => [i.itemId, i.pick]))); }, (e) => setError(message(e)));
  }, [serverId, set.items.length]);
  const tag = (s: string) => <span className={`badge ${SUPPORT_TAG[s]?.[1] ?? "muted-badge"}`}>{SUPPORT_TAG[s]?.[0] ?? s}</span>;
  const range = (mc: string[]) => (mc.length ? `MC ${mcRange(mc)}` : "MC 不明");
  const items = data?.items.filter((i) => !i.unfit) ?? [];
  const setAll = (lib: boolean) => setDraft((d) => Object.fromEntries(items.map((i) => [i.itemId, lib ? (i.saved[0]?.versionId ?? d[i.itemId]) : i.latest ? null : d[i.itemId]])));
  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await save({ data: { id: set.id, serverId, picks: items.map((i) => ({ itemId: i.itemId, versionId: draft[i.itemId] ?? null })) } });
      onClose();
    } catch (e) {
      setError(message(e));
      setSaving(false);
    }
  };
  return (
    <div className="row column picks-panel">
      {!data && !error && <span className="muted">版を読み込んでいます…(配布元に問い合わせます)</span>}
      {data && (
        <span className="picks-head">
          <span className="muted small">{`サーバー ${serverName} · Minecraft ${data.server.mcVersion ?? "不明"}`}</span>
          <span className="actions"><Btn sm disabled={saving} onClick={() => setAll(false)}>すべて最新</Btn><Btn sm disabled={saving} onClick={() => setAll(true)}>すべてライブラリ</Btn></span>
        </span>
      )}
      {data?.items.map((i) => {
        const lib = draft[i.itemId] != null;
        const chosen = lib ? i.saved.find((v) => v.versionId === draft[i.itemId]) : null;
        const now = lib ? chosen : i.latest;
        return (
          <div className="pick-card" key={i.itemId}>
            <span className="pick-top">
              <AddonIcon type={i.projectType} url={i.iconUrl} />
              <span className="mid"><span className="ttl" translate="no">{i.title}</span><span className="sub">{sourceLabel(i.source)}</span></span>
            </span>
            {i.unfit ? <span className="muted small">このサーバーの種類には入れないので、飛ばします</span> : (
              <>
                <Seg label={`${i.title} の入れる版`} value={lib ? "lib" : "latest"} options={[["latest", i.latest ? "最新" : "最新(なし)"], ["lib", i.saved.length ? "ライブラリ" : "ライブラリ(保存なし)"]] as const}
                  onChange={(v) => setDraft((d) => ({ ...d, [i.itemId]: v === "lib" ? (i.saved[0]?.versionId ?? d[i.itemId] ?? null) : null }))} />
                {lib && i.saved.length > 1 && (
                  <select value={draft[i.itemId] ?? ""} disabled={saving} aria-label={`${i.title} の保存した版`} onChange={(e) => setDraft((d) => ({ ...d, [i.itemId]: e.target.value }))}>
                    {i.saved.map((v) => <option key={v.versionId} value={v.versionId} translate="no">{`${v.versionNumber}(${range(v.mcVersions)})`}</option>)}
                  </select>
                )}
                <dl className="pick-info">
                  <dt>最新</dt><dd className={lib ? "dim" : ""}>{i.latest ? <><span translate="no">{i.latest.versionNumber}</span> · {range(i.latest.mcVersions)} {tag(i.latest.support)}</> : i.source === "upload" ? "配布元が無い(アップロードしたもの)" : i.error || "このサーバーに合う版がありません"}</dd>
                  <dt>ライブラリ</dt><dd className={lib ? "" : "dim"}>{(lib ? chosen : i.saved[0]) ? <><span translate="no">{(lib ? chosen : i.saved[0])!.versionNumber}</span> · {range((lib ? chosen : i.saved[0])!.mcVersions)} {tag((lib ? chosen : i.saved[0])!.support)}{i.saved.length > 1 && !lib ? ` ほか ${i.saved.length - 1} 個` : ""}</> : "保存した版がありません"}</dd>
                </dl>
                {now && now.support === "no" && <span className="small warn-text">{`選んでいる版は、このサーバー(Minecraft ${data.server.mcVersion ?? "不明"})に対応していません`}</span>}
                {!now && <span className="small warn-text">入れられる版がありません(入れるときに飛ばします)</span>}
              </>
            )}
          </div>
        );
      })}
      {error && <p className="error small" role="alert">{error}</p>}
      <span className="actions picks-foot">
        <Btn kind="red" sm disabled={saving || busy} onClick={onRemove}>このサーバーを外す</Btn>
        <span className="grow" />
        <Btn sm disabled={saving} onClick={onClose}>やめる</Btn>
        <Btn kind="pri" sm disabled={saving || !data} onClick={submit}>{saving ? "保存しています…" : "保存"}</Btn>
      </span>
    </div>
  );
}

// ライブラリから選んでセットに足す: 名前で探し、アイコン・種類・配布元を見て、チェックしたものをまとめて足す
function AddPicker({ items, busy, onAdd, onClose }: { items: Catalog["items"]; busy: boolean; onAdd: (ids: string[]) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const word = q.trim().toLowerCase();
  const shown = items.filter((i) => !word || i.title.toLowerCase().includes(word)).sort((a, b) => a.title.localeCompare(b.title));
  const pick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <div className="gtitle">ライブラリから足す</div>
      <section className="group">
        <div className="row sfilter pick-q">
          <label className="q"><Icon name="search" /><input type="search" placeholder="名前で探す" aria-label="ライブラリのアイテムを名前で探す" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></label>
        </div>
        <div className="pick-list">
          {shown.length === 0 && <div className="row muted">見つかりません。</div>}
          {shown.map((i) => (
            <label className="row click" key={i.id}>
              <input type="checkbox" className="ck" checked={picked.has(i.id)} disabled={busy} onChange={() => pick(i.id)} />
              <AddonIcon type={i.projectType} url={i.iconUrl} />
              <span className="mid">
                <span className="ttl" translate="no">{i.title}</span>
                <span className="sub">{TYPE_LABEL[i.projectType] ?? i.projectType} · {sourceLabel(i.source, i.origin)}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="row pick-foot">
          <span className="muted small">{picked.size ? `${picked.size} 件を選んでいます` : "足すものにチェックを入れます"}</span>
          <span className="grow" />
          <Btn sm disabled={busy} onClick={onClose}>閉じる</Btn>
          <Btn kind="pri" sm disabled={busy || picked.size === 0} onClick={() => onAdd([...picked])}>{busy ? "足しています…" : `${picked.size || ""} 件を足す`.trim()}</Btn>
        </div>
      </section>
    </>
  );
}

// セットのアイテムの版を固定する欄(アイテムの行の下に開く): 「いつも新しい版」と、配布元の版(新しい順)・アップロードした版を並べ、
// 選んで「この版にする」。版の一覧は、開いたときに配布元から読む
function PinPanel({ setId, item, onDone, onClose }: { setId: string; item: SetRow["items"][number]; onDone: () => void; onClose: () => void }) {
  const versions = useServerFn(libraryItemVersions);
  const uploads = useServerFn(uploadedFiles);
  const pin = useServerFn(pinSetItem);
  const [list, setList] = useState<{ id: string; label: string; sub: string; tag?: string }[] | null>(null);
  const [sel, setSel] = useState(item.versionId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = item.source === "upload"
      ? uploads({ data: { itemId: item.id } }).then((fs) => fs.map((f) => ({ id: f.id, label: f.version || f.filename, sub: [localDate(f.createdAt), fmtSize(f.size)].join(" · ") })))
      : versions({ data: { itemId: item.id } }).then((vs) => vs.map((v) => ({ id: v.versionId, label: v.versionNumber, tag: V_TYPE[v.type],
        sub: [loaderNames(v.loaders), v.mcVersions.length ? `MC ${mcRange(v.mcVersions)}` : "", v.date ? localDate(v.date) : ""].filter(Boolean).join(" · ") })));
    load.then((l) => setList(item.versionId && !l.some((v) => v.id === item.versionId) ? [{ id: item.versionId, label: item.versionNumber ?? "", sub: "いま固定している版" }, ...l] : l),
      (e) => setError(message(e)));
  }, [item.id]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await pin({ data: { id: setId, itemId: item.id, versionId: sel || null } });
      onDone();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const choice = (id: string, label: string, sub: string, tag?: string) => (
    <button key={id || "latest"} type="button" className={`row link vrow${sel === id ? " sel" : ""}`} role="radio" aria-checked={sel === id} disabled={busy} onClick={() => setSel(id)}>
      <span className="vdot" aria-hidden="true" />
      <span className="mid">
        <span className="ttl"><span translate={id ? "no" : undefined}>{label}</span>{tag && <span className="tag">{tag}</span>}{id && id === item.versionId && <span className="tag">いまの固定</span>}</span>
        {sub && <span className="sub">{sub}</span>}
      </span>
    </button>
  );
  const changed = sel !== (item.versionId ?? "");
  return (
    <div className="row column pin-panel">
      <div className="group vlist pin-list" role="radiogroup" aria-label={`${item.title} の版`}>
        {choice("", "いつも新しい版(固定しない)", "新しい版が出たら、そろえるときにそれを入れます")}
        {!list && !error && <div className="row muted">版を読み込んでいます…</div>}
        {list?.length === 0 && <div className="row muted">選べる版がありません</div>}
        {list?.map((v) => choice(v.id, v.label, v.sub, v.tag))}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      <span className="actions pin-foot">
        <span className="grow" />
        <Btn sm disabled={busy} onClick={onClose}>やめる</Btn>
        <Btn kind="pri" sm disabled={busy || !changed} onClick={save}>{busy ? "変えています…" : sel ? "この版にする" : "固定をやめる"}</Btn>
      </span>
    </div>
  );
}
const V_TYPE: Record<string, string> = { beta: "ベータ", alpha: "アルファ" };
// 動く作り(同じ版番号が Paper 向け・Bukkit 向けのように分かれていることがあるので、見分けられるように出す)
const loaderNames = (ls: string[]) => ls.slice(0, 3).map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join("・") + (ls.length > 3 ? " ほか" : "");

// セットの前提(Modrinth・CurseForge の必須)のうち、セットに入っていないものを確かめて足す
function Deps({ set, edit, onChange }: { set: SetRow; edit: boolean; onChange: () => void }) {
  const check = useServerFn(setMissingDeps);
  const add = useServerFn(addSetDeps);
  const [platform, setPlatform] = useState<string>(set.items.some((i) => i.projectType === "mod") && !set.items.some((i) => i.projectType === "plugin") ? "fabric" : "paper");
  const [r, setR] = useState<Awaited<ReturnType<typeof setMissingDeps>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const recheck = () => run(async () => setR(await check({ data: { id: set.id, platform } })));
  const addSome = (list: { source: string; projectId: string }[]) => run(async () => {
    await add({ data: { id: set.id, platform, list: list.map((x) => ({ source: x.source as "modrinth", projectId: x.projectId })) } });
    onChange();
    setR(await check({ data: { id: set.id, platform } }));
  });
  return (
    <>
      <label className="row">
        <span>入れる先のサーバーの種類</span>
        <select className="trail" value={platform} disabled={busy} aria-label="前提を確かめるサーバーの種類" onChange={(e) => { setPlatform(e.target.value); setR(null); }}>
          {PLATFORM_IDS.map((k) => <option key={k} value={k}>{PLATFORMS[k].label}</option>)}
        </select>
      </label>
      {!r && <button className="row link" type="button" disabled={busy} onClick={recheck}>{busy ? "確かめています…" : "前提を確かめる"}</button>}
      {r && (
        <div className="row">
          {r.missing.length ? <span className="badge upd">{`足りない ${r.missing.length} 件`}</span> : <span className="badge ok">そろっています</span>}
          <span className="grow" />
          <button className="trail link" type="button" disabled={busy} onClick={recheck}>もう一度確かめる</button>
        </div>
      )}
      {r?.missing.map((m) => (
        <div className="row" key={`${m.source}:${m.projectId}`}>
          <AddonIcon type={m.projectType} url={m.iconUrl} />
          <span className="mid">
            <span className="ttl" translate="no">{m.title}</span>
            <span className="sub">{`「${m.by.join("」「")}」に必要です`}</span>
          </span>
          {edit && <Btn kind="tint" sm disabled={busy} onClick={() => addSome([m])}>＋ 足す</Btn>}
        </div>
      ))}
      {edit && r && r.missing.length > 1 && (
        <div className="row"><span className="grow" /><Btn kind="pri" sm disabled={busy} onClick={() => addSome(r.missing)}>{busy ? "足しています…" : `${r.missing.length} 件をすべて足す`}</Btn></div>
      )}
      {r && r.errors.length > 0 && <div className="row muted small" translate="no">{`確かめられなかったもの: ${r.errors.join("、")}`}</div>}
      {error && <p className="row error" role="alert">{error}</p>}
    </>
  );
}

function NewSet({ onCreated }: { onCreated: () => void }) {
  const create = useServerFn(createSet);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    try {
      await create({ data: { name } });
      setName("");
      setError("");
      onCreated();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <div className="gtitle">新しいセット</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row" placeholder="セットの名前(例 ロビー用)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        {error && <p className="row error" role="alert">{error}</p>}
        <button className="row link" type="submit" disabled={!name.trim()}>作る</button>
      </form>
    </>
  );
}

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

// 予約: 決めた曜日・時刻に、セットを結び付けたサーバーをそろえる(または確かめるだけ)
function Schedule({ editable }: { editable: boolean }) {
  const load = useServerFn(getSchedule);
  const save = useServerFn(setSchedule);
  const [s, setS] = useState<Awaited<ReturnType<typeof getSchedule>> | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; mode: string; time: string; days: number[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load().then((x) => { setS(x); setDraft({ enabled: x.enabled, mode: x.mode, time: x.time, days: x.days }); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);
  if (!s || !draft) return error ? <p className="row error" role="alert">{error}</p> : null;

  const submit = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await save({ data: draft });
      setNote("保存しました");
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleDay = (d: number) => setDraft({ ...draft, days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d] });

  return (
    <>
      <div className="gtitle">曜日と時刻<Info>決めた曜日・時刻に、セットを結び付けたすべてのサーバーをそろえる(足りないものを入れ、新しい版があれば更新する)か、何も変えずに更新があるかを確かめます。結果は設定の「操作の記録と通知」に残り、Discord の「予約の結果」を選んでいれば知らせます。決められるのは管理者以上です。サーバーごとの予約(毎日・毎週・変えたら再起動)は、それぞれのサーバーの画面で決められます。</Info></div>
      <section className="group form">
        <label className="row">
          <span>予約を使う</span>
          <input className="trail switch" type="checkbox" checked={draft.enabled} disabled={!editable} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        </label>
        <div className="row">
          <span>すること</span>
          <select className="trail" value={draft.mode} disabled={!editable} aria-label="予約ですること" onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
            {Object.entries(s.modes).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <div className="row">
          <span>時刻(日本時間)</span>
          <input className="trail" type="time" value={draft.time} disabled={!editable} aria-label="予約の時刻" onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
        </div>
        <div className="row actions" role="group" aria-label="予約の曜日">
          {DAY_NAMES.map((n, d) => (
            <label key={d}><input type="checkbox" checked={draft.days.includes(d)} disabled={!editable} onChange={() => toggleDay(d)} /> {n}</label>
          ))}
        </div>
        {s.lastRunAt && <div className="row muted">前に動いたとき: {new Date(s.lastRunAt).toLocaleString("ja-JP")}</div>}
        {editable && <button className="row link" type="button" disabled={busy} onClick={submit}>{busy ? "保存しています…" : "保存"}</button>}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

// Modパック(.mrpack・CurseForge の zip)から、ライブラリとセットを作る
function FromModpack({ onCreated, servers }: { onCreated: () => void; servers: { id: string; name: string }[] }) {
  const [server, setServer] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const send = async (file: File) => {
    setBusy(true);
    setNote("");
    setError("");
    try {
      const res = await fetch(`/api/modpack?filename=${encodeURIComponent(file.name)}${server ? `&server=${encodeURIComponent(server)}` : ""}`, { method: "POST", body: file });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message ?? "読み込めませんでした");
      setNote(`セット「${j.name}」を作りました(${j.added} 件)${j.skipped ? `。サーバーでは動かないもの ${j.skipped} 件は飛ばしました` : ""}${j.missing.length ? `。見つからなかったもの: ${j.missing.join("、")}` : ""}${j.overrides ? `。設定ファイルを ${j.overrides.written} 個書き込みました` : ""}`);
      onCreated();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="gtitle">Modパックから作る<Info>Modパックに入っている Mod をライブラリに載せ、Modパックの名前のセットを作ります。Modrinth のものはファイルの中身(SHA-1)で探し、CurseForge のものは設定の「CurseForge API キー」で API キーを設定すると読めます。設定ファイル(overrides)は、サーバーを選んだときだけ、そのサーバーに書き込みます(テキストの設定ファイルだけ。上書きする前の中身は履歴に残ります。管理者以上)。</Info></div>
      <section className="group">
        {servers.length > 0 && (
          <div className="row">
            <span>設定ファイル(overrides)を書き込むサーバー</span>
            <select className="trail" value={server} onChange={(e) => setServer(e.target.value)} aria-label="設定ファイルも書き込むサーバー">
              <option value="">書き込まない</option>
              {servers.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
            </select>
          </div>
        )}
        <label className="row link">
          {busy ? "読み込んでいます…" : "Modパックのファイル(.mrpack・CurseForge の zip)を選ぶ"}
          <input type="file" accept=".mrpack,.zip" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) send(f); }} />
        </label>
        {note && <p className="row muted" role="status" translate="no">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}
