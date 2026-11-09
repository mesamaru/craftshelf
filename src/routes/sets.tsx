import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ApplyResults } from "~/lib/apply-results";
import { libraryCatalog, libraryItemVersions } from "~/lib/library-api";
import { uploadedFiles } from "~/lib/uploads-api";
import { getSchedule, setSchedule } from "~/lib/schedule-api";
import { ITEM_TYPES, PLATFORMS, PLATFORM_IDS } from "~/lib/platforms";
import { ItemIcon } from "~/lib/type-icon";
import { addSetDeps, applySet, createSet, listSets, pinSetItem, removeSet, renameSet, setMissingDeps, toggleSetItem } from "~/lib/sets-api";
import { SOURCE_LABEL, isSource } from "~/lib/sources";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/sets")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/sets" } });
    return { user: context.user };
  },
  loader: async () => ({ sets: await listSets(), catalog: await libraryCatalog() }),
  component: Sets,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = ITEM_TYPES;

type SetRow = Awaited<ReturnType<typeof listSets>>[number];
type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type Result = Awaited<ReturnType<typeof applySet>>;

// セット: ライブラリから選んだものの組み合わせを、サーバーにまとめて入れる
function Sets() {
  const { user } = Route.useRouteContext();
  const { sets, catalog } = Route.useLoaderData();
  const { can } = useCan(user.id);
  const router = useRouter();
  const reload = () => router.invalidate();
  const edit = can({ library: ["edit"] });

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ ライブラリ</Link>
        <h1>セット</h1>
      </header>
      <Schedule editable={can({ server: ["update"] })} />
      {sets.length === 0 && (
        <section className="group"><div className="row muted">まだセットがありません。{edit ? "下で作れます。" : ""}</div></section>
      )}
      {sets.map((s) => <SetCard key={s.id} set={s} catalog={catalog} edit={edit} onChange={reload} />)}
      <p className="foot">セットは、ライブラリから選んだ Mod・プラグインの組み合わせです。「サーバーに入れる」で、サーバーの種類に合うもののうち、まだ入っていないものをまとめて入れます(Paper のサーバーに Mod は入れません)。「前提を確かめる」は、選んだ種類のサーバーに入るいちばん新しい版の前提(Modrinth・CurseForge の必須)が、セットに入っているかを見ます。</p>
      <p className="foot">「版を選ぶ」で版を固定すると、セットを入れる・そろえる・予約・自動更新で、新しい版ではなくその版を入れます(サーバーの種類・バージョンに合わない版は、結果に知らせて飛ばします)。セットを結び付けたすべてのサーバーで同じ版になります。サーバーの画面の「更新を止める」は、そのサーバーだけ今入っている版のままにするもので、固定より先に効きます。SpigotMC のものは固定できません(いちばん新しい版だけを入れられます)。</p>
      {edit && <NewSet onCreated={reload} />}
      {edit && <FromModpack onCreated={reload} servers={can({ server: ["update"] }) ? catalog.servers : []} />}
    </main>
  );
}

function SetCard({ set, catalog, edit, onChange }: { set: SetRow; catalog: Catalog; edit: boolean; onChange: () => void }) {
  const toggle = useServerFn(toggleSetItem);
  const apply = useServerFn(applySet);
  const rename = useServerFn(renameSet);
  const remove = useServerFn(removeSet);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ server: string; list: Result } | null>(null);
  const [type, setType] = useState(""); // 種類での絞り込み(空 = すべて)
  const inSet = new Set(set.items.map((i) => i.id));
  const fits = (i: { projectType: string }) => !type || i.projectType === type;
  const addable = catalog.items.filter((i) => !inSet.has(i.id) && fits(i));
  const types = [...new Set([...set.items, ...catalog.items].map((i) => i.projectType))];
  const targets = catalog.servers.filter((s) => s.type);

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
    <>
      <div className="group-title" translate="no">{set.name}</div>
      <section className="group">
        {set.servers.length > 0 && (
          <div className="row"><span>結び付けているサーバー</span><span className="trail" translate="no">{set.servers.map((x) => x.name).join("、")}</span></div>
        )}
        {types.length > 1 && (
          <div className="row">
            <span>種類で絞り込む</span>
            <select className="trail" value={type} aria-label={`${set.name} を種類で絞り込む`} onChange={(e) => setType(e.target.value)}>
              <option value="">すべて</option>
              {types.map((k) => <option key={k} value={k}>{TYPE_LABEL[k] ?? k}</option>)}
            </select>
          </div>
        )}
        {set.items.length === 0 && <div className="row muted">まだ何も入っていません。{edit && catalog.items.length === 0 ? "先にライブラリに Mod・プラグインを登録すると、ここに足せます。" : ""}</div>}
        {set.items.filter(fits).map((i) => (
          <div className="row hit" key={i.id}>
            <ItemIcon type={i.projectType} url={i.iconUrl} />
            <span className="main">
              <span translate="no">{i.title}</span>
              <span className="muted">{TYPE_LABEL[i.projectType] ?? i.projectType} · {isSource(i.source) ? SOURCE_LABEL[i.source] : i.source}</span>
              {i.versionId && <span className="muted small"><span className="badge">版を固定</span> <span translate="no">{i.versionNumber}</span></span>}
            </span>
            {edit && i.source !== "spigot" && <Pin setId={set.id} item={i} disabled={!!busy} onDone={onChange} />}
            {edit && (
              <button className={`${i.source === "spigot" ? "trail " : ""}link danger`} type="button" disabled={!!busy}
                onClick={() => run(i.id, () => toggle({ data: { id: set.id, itemId: i.id, add: false } }))}>外す</button>
            )}
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
        {edit && set.items.length > 0 && (
          <div className="row">
            <span>サーバーに入れる</span>
            {targets.length ? (
              <select className="trail" value="" disabled={!!busy} aria-label={`${set.name} をサーバーに入れる`}
                onChange={(e) => {
                  const s = targets.find((x) => x.id === e.target.value);
                  if (s) run("apply", async () => setResults({ server: s.name, list: await apply({ data: { id: set.id, serverId: s.id } }) }));
                }}>
                <option value="">サーバーを選ぶ…</option>
                {targets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
              </select>
            ) : <span className="trail muted">種類を決めたサーバーがありません</span>}
          </div>
        )}
        {set.items.some((i) => i.source === "modrinth" || i.source === "curseforge") && <Deps set={set} edit={edit} onChange={onChange} />}
        {busy === "apply" && <div className="row muted">サーバーに入れています…</div>}
        {results && <ApplyResults server={results.server} verb="入れた" list={results.list} />}
        {edit && (
          <div className="row actions">
            <button className="link" type="button" disabled={!!busy} onClick={() => {
              const n = prompt("セットの新しい名前", set.name);
              if (n && n !== set.name) run("rename", () => rename({ data: { id: set.id, name: n } }));
            }}>名前を変える</button>
            <button className="trail link danger" type="button" disabled={!!busy}
              onClick={() => confirm(`セット「${set.name}」を消しますか?(ライブラリとサーバーはそのままです)`) && run("remove", () => remove({ data: { id: set.id } }))}>
              セットを消す
            </button>
          </div>
        )}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
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
      <div className="group-title">新しいセット</div>
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
      <div className="group-title">予約</div>
      <section className="group form">
        <label className="row">
          <span>予約を使う</span>
          <input className="trail" type="checkbox" checked={draft.enabled} disabled={!editable} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
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
      <p className="foot">決めた曜日・時刻に、セットを結び付けたすべてのサーバーをそろえる(足りないものを入れ、新しい版があれば更新する)か、何も変えずに更新があるかを確かめます。結果は「チーム」→「操作の記録と Discord への通知」に残り、Discord の「予約の結果」を選んでいれば知らせます。決められるのは管理者以上です。サーバーごとの予約(毎日・毎週・変えたら再起動)は、それぞれのサーバーの画面で決められます。</p>
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
      <div className="group-title">Modpack から作る</div>
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
      <p className="foot">Modpack に入っている Mod をライブラリに載せ、Modpack の名前のセットを作ります。Modrinth のものはファイルの中身(SHA-1)で探し、CurseForge のものは「チーム」で API キーを設定すると読めます。設定ファイル(overrides)は、サーバーを選んだときだけ、そのサーバーに書き込みます(テキストの設定ファイルだけ。上書きする前の中身は履歴に残ります。管理者以上)。</p>
    </>
  );
}
