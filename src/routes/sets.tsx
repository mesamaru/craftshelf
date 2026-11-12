import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ApplyResults } from "~/lib/apply-results";
import { libraryCatalog, libraryItemVersions } from "~/lib/library-api";
import { uploadedFiles } from "~/lib/uploads-api";
import { getSchedule, setSchedule } from "~/lib/schedule-api";
import { ITEM_TYPES, PLATFORMS, PLATFORM_IDS } from "~/lib/platforms";
import { AddonIcon } from "~/lib/type-icon";
import { addSetDeps, applySet, createSet, listSets, pinSetItem, removeSet, renameSet, setMissingDeps, syncServerSet, toggleSetItem } from "~/lib/sets-api";
import { Btn, Chip, Info, Menu, Sheet } from "~/lib/ui";
import { sourceLabel } from "~/lib/sources";
import { useCan } from "~/lib/use-can";
import { sharedLocalEnabled } from "~/lib/servers-api";
import { zipPlan } from "~/lib/saved-api";
import { MobileSearch, StoragePill } from "~/lib/shell";
import { downloadZip } from "~/lib/zip-download";
import { pageTitle } from "~/lib/titles";
import { confirmDialog, promptDialog } from "~/lib/dialog-queue";

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

// セット(v02 と同じ形): 見出しの下に一言と「＋ セットを作成」、2 列のカード(名前・件数・中身・操作)。編集・サーバーに入れるは右のシートで、中身・前提・版の固定・サーバーを扱う
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
            <span>「版を選ぶ」で版を固定すると、セットを入れる・そろえる・予約・自動更新で、新しい版ではなくその版を入れます(サーバーの種類・バージョンに合わない版は、結果に知らせて飛ばします)。セットを結び付けたすべてのサーバーで同じ版になります。サーバーの画面の「更新を止める」は、そのサーバーだけ今入っている版のままにするもので、固定より先に効きます。SpigotMC のものは固定できません(いちばん新しい版だけを入れられます)。</span>
          </Info>
        </h1>
        <StoragePill />
      </header>
      <MobileSearch />
      <div className="view-head">
        <p className="muted">よく使う組み合わせをセットにして、サーバーにまとめて入れます。</p>
        <span className="grow" />
        <Btn sm onClick={() => setSheet("schedule")}>予約</Btn>
        {edit && <Btn kind="pri" onClick={() => setSheet("new")}>＋ セットを作成</Btn>}
      </div>
      {sets.length === 0 && (
        <section className="card glass empty"><span className="big" aria-hidden="true">🧺</span><p>まだセットがありません</p></section>
      )}
      <div className="cards">
        {sets.map((s) => <SetCard key={s.id} set={s} edit={edit} local={local} onOpen={() => setOpen(s.id)} onChange={reload} />)}
      </div>
      {opened && <SetSheet set={opened} catalog={catalog} edit={edit} local={local} onChange={reload} onClose={() => setOpen("")} />}
      {sheet === "new" && (
        <Sheet title="セットを作成" onClose={() => setSheet("")}>
          <NewSet onCreated={() => { reload(); setSheet(""); }} />
          <FromModpack onCreated={reload} servers={can({ server: ["update"] }) ? catalog.servers : []} />
        </Sheet>
      )}
      {sheet === "schedule" && <Sheet title="予約" onClose={() => setSheet("")}><Schedule editable={can({ server: ["update"] })} /></Sheet>}
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
          }}>削除</Btn>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

// セットのシート: 中身(版の固定・外す・足す)・前提・サーバー(そろえる・入れる)
function SetSheet({ set, catalog, edit, local, onChange, onClose }: { set: SetRow; catalog: Catalog; edit: boolean; local: boolean; onChange: () => void; onClose: () => void }) {
  const toggle = useServerFn(toggleSetItem);
  const plan = useServerFn(zipPlan);
  const apply = useServerFn(applySet);
  const sync = useServerFn(syncServerSet);
  const rename = useServerFn(renameSet);
  const remove = useServerFn(removeSet);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ server: string; verb: string; list: Result } | null>(null);
  const [type, setType] = useState(""); // 種類での絞り込み(空 = すべて)
  const inSet = new Set(set.items.map((i) => i.id));
  const fits = (i: { projectType: string }) => !type || i.projectType === type;
  const addable = catalog.items.filter((i) => !inSet.has(i.id) && fits(i));
  const types = [...new Set([...set.items, ...catalog.items].map((i) => i.projectType))];
  const bound = new Set(set.servers.map((s) => s.id));
  const targets = catalog.servers.filter((s) => s.type && !bound.has(s.id));

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
        {set.items.filter(fits).map((i) => (
          <div className="row" key={i.id}>
            <AddonIcon type={i.projectType} url={i.iconUrl} />
            <span className="mid">
              <span className="ttl" translate="no">{i.title}</span>
              <span className="sub">{TYPE_LABEL[i.projectType] ?? i.projectType} · {sourceLabel(i.source)}{i.versionId && <> · <b translate="no">{i.versionNumber}</b></>}</span>
            </span>
            {edit && i.source !== "spigot" && <Pin setId={set.id} item={i} disabled={!!busy} onDone={onChange} />}
            {edit && <Btn kind="red" sm disabled={!!busy} onClick={() => run(i.id, () => toggle({ data: { id: set.id, itemId: i.id, add: false } }))}>外す</Btn>}
          </div>
        ))}
        {edit && addable.length > 0 && (
          <div className="row">
            <span>ライブラリから足す</span>
            <select className="trail" value="" disabled={!!busy} aria-label={`${set.name} にライブラリから足す`}
              onChange={(e) => { const itemId = e.target.value; if (itemId) run(itemId, () => toggle({ data: { id: set.id, itemId, add: true } })); }}>
              <option value="">選んでください…</option>
              {addable.map((i) => <option key={i.id} value={i.id} translate="no">{i.title}({TYPE_LABEL[i.projectType] ?? i.projectType})</option>)}
            </select>
          </div>
        )}
      </section>
      {set.items.some((i) => i.source === "modrinth" || i.source === "curseforge") && <>
        <div className="gtitle">前提</div>
        <section className="group"><Deps set={set} edit={edit} onChange={onChange} /></section>
      </>}
      {edit && set.items.length > 0 && <>
        <div className="gtitle">サーバー<Info>「そろえる」は、結び付けたサーバーに足りないものを入れ、新しい版があれば更新します(セットを結び付けるのは、サーバーの画面の「アドオン」の「そろえる」)。「サーバーに入れる」は、選んだサーバーにまだ入っていないものだけを入れます。</Info></div>
        <section className="group">
          {set.servers.map((s) => (
            <div className="row" key={s.id}>
              <span className="mid"><span className="ttl" translate="no">{s.name}</span><span className="sub">結び付けています</span></span>
              <Btn kind="tint" sm disabled={!!busy} onClick={async () => {
                if ((await confirmDialog({ message: `「${s.name}」を「${set.name}」にそろえますか?(足りないものも入れる)`, ok: "そろえる" }))) run("sync", async () => setResults({ server: s.name, verb: "そろえた", list: await sync({ data: { serverId: s.id, mode: "add" } }) }));
              }}>そろえる</Btn>
            </div>
          ))}
          <div className="row">
            <span>サーバーに入れる</span>
            {targets.length ? (
              <select className="trail" value="" disabled={!!busy} aria-label={`${set.name} をサーバーに入れる`}
                onChange={(e) => {
                  const s = targets.find((x) => x.id === e.target.value);
                  if (s) run("apply", async () => setResults({ server: s.name, verb: "入れた", list: await apply({ data: { id: set.id, serverId: s.id } }) }));
                }}>
                <option value="">サーバーを選ぶ…</option>
                {targets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
              </select>
            ) : <span className="trail muted">{set.servers.length ? "ほかに種類を決めたサーバーはありません" : "種類を決めたサーバーがありません"}</span>}
          </div>
          {(busy === "apply" || busy === "sync") && <div className="row muted">サーバーに入れています…</div>}
          {results && <ApplyResults server={results.server} verb={results.verb} list={results.list} />}
        </section>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </Sheet>
  );
}

// セットのアイテムの版を固定する・やめる(版の一覧は、押したときに配布元から読む)
function Pin({ setId, item, disabled, onDone }: { setId: string; item: SetRow["items"][number]; disabled: boolean; onDone: () => void }) {
  const versions = useServerFn(libraryItemVersions);
  const uploads = useServerFn(uploadedFiles);
  const pin = useServerFn(pinSetItem);
  const [list, setList] = useState<{ id: string; label: string }[] | null>(null);
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
  const open = () => run(async () => setList(item.source === "upload"
    ? (await uploads({ data: { itemId: item.id } })).map((f) => ({ id: f.id, label: f.version || f.filename }))
    : (await versions({ data: { itemId: item.id } })).map((v) => ({ id: v.versionId, label: v.mcVersions.length ? `${v.versionNumber}(${v.mcVersions.slice(0, 3).join("・")})` : v.versionNumber }))));
  if (error) return <span className="trail error small" role="alert">{error}</span>;
  if (!list) return <button className="trail link" type="button" disabled={disabled || busy} onClick={open}>{busy ? "読み込んでいます…" : "版を選ぶ"}</button>;
  return (
    <select className="trail" value={item.versionId ?? ""} disabled={disabled || busy} aria-label={`${item.title} の版`}
      onChange={(e) => run(async () => { await pin({ data: { id: setId, itemId: item.id, versionId: e.target.value || null } }); setList(null); onDone(); })}>
      <option value="">いつも新しい版(固定しない)</option>
      {item.versionId && !list.some((v) => v.id === item.versionId) && <option value={item.versionId} translate="no">{item.versionNumber}</option>}
      {list.map((v) => <option key={v.id} value={v.id} translate="no">{v.label}</option>)}
    </select>
  );
}

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
      <div className="row">
        <span>前提を確かめる</span>
        <span className="trail actions">
          <select value={platform} disabled={busy} aria-label="前提を確かめるサーバーの種類" onChange={(e) => { setPlatform(e.target.value); setR(null); }}>
            {PLATFORM_IDS.map((k) => <option key={k} value={k}>{PLATFORMS[k].label}</option>)}
          </select>
          <button className="link" type="button" disabled={busy} onClick={recheck}>{busy && !r ? "確かめています…" : "確かめる"}</button>
        </span>
      </div>
      {r && r.missing.length === 0 && <div className="row muted">前提はそろっています。</div>}
      {r && r.missing.length > 0 && <div className="row error">{`前提が足りません(${r.missing.length} 件)`}</div>}
      {r?.missing.map((m) => (
        <div className="row" key={`${m.source}:${m.projectId}`}>
          <AddonIcon type={m.projectType} url={m.iconUrl} size="sm" />
          <span className="main">
            <span translate="no">{m.title}</span>
            <span className="muted small"><span translate="no">{m.by.join("、")}</span> が使います</span>
          </span>
          {edit && <button className="trail link" type="button" disabled={busy} onClick={() => addSome([m])}>セットに足す</button>}
        </div>
      ))}
      {edit && r && r.missing.length > 1 && <button className="row link" type="button" disabled={busy} onClick={() => addSome(r.missing)}>{`足りない ${r.missing.length} 件をすべて足す`}</button>}
      {r?.errors.map((x) => <div className="row muted small" key={x} translate="no">{x}</div>)}
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

// Modpack(.mrpack・CurseForge の zip)から、ライブラリとセットを作る
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
      <div className="gtitle">Modpack から作る<Info>Modpack に入っている Mod をライブラリに載せ、Modpack の名前のセットを作ります。Modrinth のものはファイルの中身(SHA-1)で探し、CurseForge のものは設定の「CurseForge API キー」で API キーを設定すると読めます。設定ファイル(overrides)は、サーバーを選んだときだけ、そのサーバーに書き込みます(テキストの設定ファイルだけ。上書きする前の中身は履歴に残ります。管理者以上)。</Info></div>
      <section className="group">
        {servers.length > 0 && (
          <div className="row">
            <span>設定ファイル(overrides)も書き込むサーバー</span>
            <select className="trail" value={server} onChange={(e) => setServer(e.target.value)} aria-label="設定ファイルも書き込むサーバー">
              <option value="">書き込まない</option>
              {servers.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
            </select>
          </div>
        )}
        <label className="row link">
          {busy ? "読み込んでいます…" : "Modpack のファイル(.mrpack・CurseForge の zip)を選ぶ"}
          <input type="file" accept=".mrpack,.zip" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) send(f); }} />
        </label>
        {note && <p className="row muted" role="status" translate="no">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}
