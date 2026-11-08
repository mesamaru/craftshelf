import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { identifyMods, serverChanges, undoChange, installMod, installedMods, modUpdates, removeMod, rollbackMod, searchMods, serverDetail, setModEnabled, setModHold, setProfile } from "~/lib/library-api";
import { importServerFile } from "~/lib/uploads-api";
import { ApplyResults } from "~/lib/apply-results";
import { PLATFORMS, PLATFORM_IDS } from "~/lib/platforms";
import { listServers, localSettings, serverStatus, setLocalSettings } from "~/lib/servers-api";
import { bindServerSet, copyServer, listSets, setAutoUpdate, syncServerSet } from "~/lib/sets-api";
import { SOURCE_LABEL, type Source, pageUrl } from "~/lib/sources";
import { useCan } from "~/lib/use-can";
import { detectSoftware, installSoftware, rollbackSoftware, setSoftware, softwareBuilds, softwareInfo, updateSoftware } from "~/lib/software-api";
import { SOFTWARE, SOFTWARE_IDS } from "~/lib/software";
import { createWorldBackup, removeWorldBackup, restoreWorldBackup, setWorldBackup, worldBackups } from "~/lib/worlds-api";

export const Route = createFileRoute("/servers_/$id")({
  beforeLoad: ({ context, params }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: `/servers/${params.id}` } });
    return { user: context.user };
  },
  loader: ({ params }) => serverDetail({ data: { id: params.id } }),
  component: ServerPage,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

type Installed = Awaited<ReturnType<typeof installedMods>>["items"][number];
type Update = Awaited<ReturnType<typeof modUpdates>>[number];

// サーバーの Mod・プラグイン(種類の設定・入っているもの・Modrinth / SpigotMC から探して入れる)
function ServerPage() {
  const { user, app } = Route.useRouteContext();
  const server = Route.useLoaderData();
  const { can } = useCan(user.id);
  const list = useServerFn(installedMods);
  const [items, setItems] = useState<Installed[] | null>(null);
  const [error, setError] = useState("");

  const reload = () => {
    if (!server.profile) return;
    list({ data: { id: server.id } }).then((r) => { setItems(r.items); setError(""); }, (e) => setError(message(e)));
  };
  useEffect(reload, [server.id, server.profile?.platform, server.profile?.mcVersion]);

  const edit = can({ library: ["edit"] });
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/servers" className="capsule">‹ サーバー</Link>
        <h1 translate="no">{server.name}</h1>
        <Link to="/servers/$id/files" params={{ id: server.id }} className="capsule">ファイルとコマンド</Link>
      </header>

      <Live id={server.id} />
      <Profile id={server.id} profile={server.profile} editable={can({ server: ["update"] })} />
      {server.kind === "local" && can({ server: ["update"] }) && <LocalControl id={server.id} />}
      {can({ server: ["control"] }) && <Worlds id={server.id} admin={can({ server: ["update"] })} />}

      <Software id={server.id} admin={can({ server: ["update"] })} />
      {server.profile && (
        <>
          <SetBinding id={server.id} name={server.name} edit={edit} onSynced={reload} />
          {edit && <CopyServers id={server.id} name={server.name} onDone={reload} />}
          <Installed id={server.id} items={items} error={error} edit={edit} local={app.mode === "self"} auto={server.autoUpdate}
            dir={PLATFORMS[server.profile.platform].dir} onChange={reload} />
          <Changes id={server.id} edit={edit} items={items} onChange={reload} />
          {edit && <Search id={server.id} installed={items ?? []}
            sources={(server.sources as Source[]).filter((s) => s !== "spigot" || PLATFORMS[server.profile!.platform].type === "plugin")} onInstalled={reload} />}
        </>
      )}
    </main>
  );
}

function Profile({ id, profile, editable }:
  { id: string; profile: { platform: string; mcVersion: string | null } | null; editable: boolean }) {
  const save = useServerFn(setProfile);
  const router = useRouter();
  const [platform, setPlatform] = useState(profile?.platform ?? "");
  const [mcVersion, setMcVersion] = useState(profile?.mcVersion ?? "");
  const [error, setError] = useState("");
  const [found, setFound] = useState("");
  const detect = useServerFn(detectSoftware);
  const changed = platform !== (profile?.platform ?? "") || mcVersion !== (profile?.mcVersion ?? "");
  const guess = async () => {
    setError("");
    try {
      const d = await detect({ data: { id } });
      if (d.platform) setPlatform(d.platform);
      if (d.mcVersion) setMcVersion(d.mcVersion);
      setFound(d.software ? `${SOFTWARE[d.software].label}${d.mcVersion ? ` ${d.mcVersion}` : ""} のようです${d.platform ? "(よければ保存してください)" : "(Mod・プラグインは扱えない種類です)"}` : "ファイルからは分かりませんでした");
    } catch (e) {
      setError(message(e));
    }
  };

  const submit = async () => {
    try {
      await save({ data: { id, platform, mcVersion } });
      setError("");
      await router.invalidate();
    } catch (e) {
      setError(message(e));
    }
  };

  if (!editable) {
    return (
      <section className="group">
        <div className="row"><span>種類</span><span className="trail">{profile ? PLATFORMS[profile.platform as keyof typeof PLATFORMS]?.label : "未設定"}</span></div>
        <div className="row"><span>バージョン</span><span className="trail">{profile?.mcVersion || "指定なし"}</span></div>
      </section>
    );
  }
  return (
    <section className="group form">
      {!profile && <p className="row muted">サーバーの種類を選ぶと、合う Mod・プラグインを探せるようになります。</p>}
      <div className="row">
        <span>種類</span>
        <select className="trail" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="サーバーの種類">
          <option value="" disabled>選んでください</option>
          {PLATFORM_IDS.map((p) => <option key={p} value={p}>{PLATFORMS[p].label}</option>)}
        </select>
      </div>
      <div className="row">
        <span>Minecraft のバージョン</span>
        <input className="trail version" placeholder="例 1.21.1" value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} aria-label="Minecraft のバージョン" />
      </div>
      <button className="row link" type="button" onClick={guess}>サーバーのファイルから判定する</button>
      {found && <p className="row muted" role="status">{found}</p>}
      {error && <p className="row error" role="alert">{error}</p>}
      {changed && <button className="capsule primary" type="button" onClick={submit} disabled={!platform}>保存</button>}
    </section>
  );
}

function Installed({ id, items, error, edit, local, auto, dir, onChange }:
  { id: string; items: Installed[] | null; error: string; edit: boolean; local: boolean; auto: boolean; dir: string; onChange: () => void }) {
  const router = useRouter();
  const identify = useServerFn(identifyMods);
  const toggle = useServerFn(setModEnabled);
  const setAuto = useServerFn(setAutoUpdate);
  const importFile = useServerFn(importServerFile);
  const [found, setFound] = useState("");
  const check = useServerFn(modUpdates);
  const install = useServerFn(installMod);
  const remove = useServerFn(removeMod);
  const hold = useServerFn(setModHold);
  const rollback = useServerFn(rollbackMod);
  const [updates, setUpdates] = useState<Map<string, Update> | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy("");
    }
  };
  const checkUpdates = () => run("check", async () => {
    const u = await check({ data: { id } });
    setUpdates(new Map(u.map((x) => [x.filename, x])));
  });

  return (
    <>
      <div className="group-title">{`入っているもの(${dir}/)`}</div>
      <section className="group">
        {!items && !error && <div className="row muted">サーバーに問い合わせています…</div>}
        {items?.length === 0 && <div className="row muted">まだ何も入っていません。</div>}
        {items?.map((m) => {
          const u = m.disabled ? undefined : updates?.get(m.filename);
          // 押せるもの(はじめのものを右に寄せる)
          const acts: { key: string; label: string; danger?: boolean; fn: () => void }[] = !edit ? [] : [
            ...(u ? [{ key: m.filename, label: busy === m.filename ? "更新中…" : "更新",
              fn: () => run(m.filename, async () => { await install({ data: { id, projectId: u.projectId, source: u.source } }); setUpdates((p) => { const n = new Map(p); n.delete(m.filename); return n; }); }) }] : []),
            ...(m.canRollback && m.projectId && m.source && !m.disabled ? [{ key: `rb:${m.filename}`, label: busy === `rb:${m.filename}` ? "戻しています…" : "前の版に戻す",
              fn: () => confirm(`${m.title} を前の版に戻しますか?(戻したあとは「更新を止める」になります)`) && run(`rb:${m.filename}`, () => rollback({ data: { id, projectId: m.projectId!, source: m.source as Source } })) }] : []),
            ...(m.projectId && m.source ? [{ key: `hold:${m.filename}`, label: m.held ? "止めるのをやめる" : "更新を止める",
              fn: () => run(`hold:${m.filename}`, () => hold({ data: { id, projectId: m.projectId!, source: m.source as Source, hold: !m.held } })) }] : []),
            ...(local && !m.projectId ? [{ key: `imp:${m.filename}`, label: busy === `imp:${m.filename}` ? "取り込んでいます…" : "ライブラリに取り込む",
              fn: () => run(`imp:${m.filename}`, () => importFile({ data: { id, filename: m.filename } })) }] : []),
            { key: `tg:${m.filename}`, label: m.disabled ? "有効にする" : "無効にする",
              fn: () => run(`tg:${m.filename}`, () => toggle({ data: { id, filename: m.filename, enable: m.disabled } })) },
            { key: `rm:${m.filename}`, label: "外す", danger: true,
              fn: () => confirm(`${m.title ?? m.filename} を外しますか?(「変更の履歴」から元に戻せます)`) && run(m.filename, () => remove({ data: { id, filename: m.filename } })) },
          ];
          return (
            <div className="row" key={m.filename}>
              <span className="main">
                <span>
                  <span translate="no">{m.title ?? m.filename}</span>
                  {m.disabled && <span className="badge muted-badge">無効</span>}
                </span>
                {m.title && (
                  <span className="muted" translate="no">
                    {m.versionNumber} · {m.filename}
                    {u && <span className="badge">新しい版 {u.latest}</span>}
                    {m.held && <span className="badge muted-badge">更新を止めています</span>}
                  </span>
                )}
              </span>
              {acts.map((a, i) => (
                <button key={a.key} className={`${i === 0 ? "trail " : ""}link${a.danger ? " danger" : ""}`} type="button" disabled={!!busy} onClick={a.fn}>{a.label}</button>
              ))}
            </div>
          );
        })}
        {edit && items && items.some((m) => !m.projectId) && (
          <button className="row link" type="button" disabled={!!busy} onClick={() => run("identify", async () => {
            const r = await identify({ data: { id } });
            setFound(`${r.checked} 個を調べ、${r.found.length} 個の配布元が見つかりました${r.missing.length ? `。見つからなかったもの: ${r.missing.join("、")}` : ""}${r.curseforge ? "" : "(CurseForge は、API キーを設定すると探せます)"}`);
          })}>
            {busy === "identify" ? "ファイルの中身から探しています…" : `配布元を探す(わからないもの ${items.filter((m) => !m.projectId).length} 個)`}
          </button>
        )}
        {found && <p className="row muted" role="status" translate="no">{found}</p>}
        {items && items.some((m) => m.projectId) && (
          <button className="row link" type="button" onClick={checkUpdates} disabled={!!busy}>
            {busy === "check" ? "確かめています…" : updates ? `更新を確かめる(${updates.size} 件あり)` : "更新を確かめる"}
          </button>
        )}
        {items && (edit ? (
          <label className="row">
            <span>自動更新(6 時間ごとに、新しい版があれば入れる)</span>
            <input className="trail" type="checkbox" checked={auto} disabled={!!busy}
              onChange={(e) => { const on = e.target.checked; run("auto", async () => { await setAuto({ data: { serverId: id, on } }); await router.invalidate(); }); }} />
          </label>
        ) : auto && <div className="row"><span>自動更新</span><span className="trail">オン</span></div>)}
        {(error || err) && <p className="row error" role="alert">{error || err}</p>}
      </section>
      <p className="foot">「無効にする」と、ファイルを消さずに名前の最後に .disabled を付けて止めます(更新・自動更新の対象からも外れます)。自動更新は、ライブラリ(配布元・アップロード)に新しい版が出たら入れます。「更新を止める」にしたもの・無効にしたものは入れ替えません。</p>
      <p className="foot">Modrinth・SpigotMC から入れたものは、版と更新がわかります。それ以外のファイルは名前だけを表示します(「配布元を探す」で、ファイルの中身から Modrinth・CurseForge のものかを確かめられます)。「更新を止める」にしたものは、セットでそろえる・予約・更新の確認で新しい版にしません。変更はサーバーの再起動で反映されます。</p>
    </>
  );
}

function Search({ id, installed, sources, onInstalled }: { id: string; installed: Installed[]; sources: Source[]; onInstalled: () => void }) {
  const search = useServerFn(searchMods);
  const install = useServerFn(installMod);
  const [source, setSource] = useState<Source>("modrinth");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchMods>> | null>(null);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const key = (src: string, projectId: string) => `${src}:${projectId}`;
  const have = new Set(installed.filter((m) => m.projectId).map((m) => key(m.source ?? "", m.projectId!)));

  const find = async (src = source) => {
    setError("");
    try {
      setHits(await search({ data: { id, query, source: src } }));
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => { find(); }, [id]);

  const add = async (projectId: string) => {
    setBusy(projectId);
    setError("");
    try {
      const r = await install({ data: { id, projectId, source } });
      setDone((d) => new Set(d).add(key(source, projectId)));
      if (r.deps.length) setNote(`前提も入れました: ${r.deps.map((d) => (d.ok ? `${d.title} ${d.detail}` : `${d.title}(入れられません: ${d.detail})`)).join("、")}`);
      onInstalled();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="group-title">{`${SOURCE_LABEL[source]} から探す`}</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), find())}>
        {sources.length > 1 && (
          <div className="row">
            <span>配布元</span>
            <select className="trail" value={source} aria-label="配布元"
              onChange={(e) => { const s = e.target.value as Source; setSource(s); setHits(null); find(s); }}>
              {sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
            </select>
          </div>
        )}
        <input className="row" type="search" placeholder="名前で探す(空なら人気順)" value={query} onChange={(e) => setQuery(e.target.value)} />
        {hits?.length === 0 && <p className="row muted">見つかりませんでした。</p>}
        {hits?.map((h) => (
          <div className="row hit" key={h.projectId}>
            {h.iconUrl ? <img src={h.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="icon-ph" />}
            <span className="main">
              <a href={pageUrl(source, h.projectId, h.slug)} target="_blank" rel="noreferrer noopener" translate="no">{h.title}</a>
              <span className="muted summary" translate="no">{h.summary}</span>
              <span className="muted">{h.downloads.toLocaleString("ja-JP")} ダウンロード</span>
            </span>
            {have.has(key(source, h.projectId)) || done.has(key(source, h.projectId)) ? (
              <span className="trail muted">入っています</span>
            ) : (
              <button className="trail capsule" type="button" disabled={!!busy} onClick={() => add(h.projectId)}>
                {busy === h.projectId ? "入れています…" : "入れる"}
              </button>
            )}
          </div>
        ))}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
    </>
  );
}

// このサーバーに結び付けたセット。「セットでそろえる」で、足りないものを入れ、新しい版があれば更新する
function SetBinding({ id, name, edit, onSynced }: { id: string; name: string; edit: boolean; onSynced: () => void }) {
  const load = useServerFn(listSets);
  const bind = useServerFn(bindServerSet);
  const sync = useServerFn(syncServerSet);
  const [sets, setSets] = useState<Awaited<ReturnType<typeof listSets>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof syncServerSet>> | null>(null);
  const [removeExtra, setRemoveExtra] = useState(false);
  const reload = () => { load().then(setSets, (e) => setError(message(e))); };
  useEffect(reload, [id]);
  const current = sets?.find((x) => x.servers.some((v) => v.id === id)) ?? null;

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

  if (!sets || (!edit && !current)) return null;
  return (
    <>
      <div className="group-title">セット</div>
      <section className="group">
        <div className="row">
          <span>結び付けるセット</span>
          {edit ? (
            <select className="trail" value={current?.id ?? ""} disabled={!!busy} aria-label="結び付けるセット"
              onChange={(e) => { const setId = e.target.value || null; run("bind", async () => { await bind({ data: { serverId: id, setId } }); setResults(null); reload(); }); }}>
              <option value="">なし</option>
              {sets.map((x) => <option key={x.id} value={x.id} translate="no">{x.name}({x.items.length} 件)</option>)}
            </select>
          ) : <span className="trail" translate="no">{current?.name}</span>}
        </div>
        {edit && current && (
          <button className="row link" type="button" disabled={!!busy}
            onClick={() => (!removeExtra || confirm("セットに無いもの(このアプリで入れたもの)をサーバーから外します。よろしいですか?"))
              && run("sync", async () => { setResults(await sync({ data: { serverId: id, removeExtra } })); onSynced(); })}>
            {busy === "sync" ? "そろえています…" : "セットでそろえる"}
          </button>
        )}
        {edit && current && (
          <label className="row">
            <span>セットに無いものを外す(このアプリで入れたものだけ)</span>
            <input className="trail" type="checkbox" checked={removeExtra} onChange={(e) => setRemoveExtra(e.target.checked)} />
          </label>
        )}
        {edit && sets.length === 0 && <div className="row muted">まだセットがありません。トップの「セット」で作れます。</div>}
        {results && <ApplyResults server={name} verb="そろえた" list={results} />}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">「セットでそろえる」は、セットのうちこのサーバーの種類に合うもので、足りないものを入れ、入っているものに新しい版があれば更新します。セットに無いものは外しません。</p>
    </>
  );
}

// ほかのサーバーとそろえる: このサーバーを、ほかのサーバーの構成に合わせる / このサーバー(検証用)の構成を、本番のサーバーへ反映する
function CopyServers({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const load = useServerFn(listServers);
  const copy = useServerFn(copyServer);
  const [others, setOthers] = useState<{ id: string; name: string }[] | null>(null);
  const [mode, setMode] = useState<"update" | "add" | "mirror">("add");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof copyServer>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then((l) => setOthers(l.filter((s) => s.id !== id)), (e) => setError(message(e))); }, [id]);
  if (!others?.length) return null;

  const run = async (key: string, ask: string, data: { from: string; to: string[] }) => {
    if (!confirm(ask)) return;
    setBusy(key);
    setError("");
    setResults(null);
    try {
      setResults(await copy({ data: { ...data, mode } }));
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const nameOf = (x: string) => others.find((o) => o.id === x)?.name ?? "";
  return (
    <>
      <div className="group-title">ほかのサーバーとそろえる</div>
      <section className="group form">
        <div className="row">
          <span>そろえ方</span>
          <select className="trail" value={mode} aria-label="そろえ方" onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="update">入っているものだけ合わせる</option>
            <option value="add">足りないものも入れる</option>
            <option value="mirror">まったく同じにする</option>
          </select>
        </div>
        <div className="row">
          <span>このサーバーを、次のサーバーにそろえる</span>
          <select className="trail" value={from} aria-label="そろえる元のサーバー" onChange={(e) => setFrom(e.target.value)}>
            <option value="">選んでください…</option>
            {others.map((o) => <option key={o.id} value={o.id} translate="no">{o.name}</option>)}
          </select>
        </div>
        <button className="row link" type="button" disabled={!from || !!busy}
          onClick={() => run("from", `「${name}」を「${nameOf(from)}」にそろえますか?`, { from, to: [id] })}>
          {busy === "from" ? "そろえています…" : "そろえる"}
        </button>
        <div className="row muted">検証用から本番へ反映(このサーバーの構成を、選んだサーバーへそろえる)</div>
        {others.map((o) => (
          <label className="row" key={o.id}>
            <span translate="no">{o.name}</span>
            <input className="trail" type="checkbox" checked={to.has(o.id)}
              onChange={(e) => setTo((x) => { const n = new Set(x); if (e.target.checked) n.add(o.id); else n.delete(o.id); return n; })} />
          </label>
        ))}
        <button className="row link" type="button" disabled={!to.size || !!busy}
          onClick={() => run("to", `「${name}」の構成を、選んだ ${to.size} 台へ反映しますか?`, { from: id, to: [...to] })}>
          {busy === "to" ? "反映しています…" : `選んだ ${to.size} 台へ反映`}
        </button>
        {results?.map((r) => (r.error
          ? <p className="row error" key={r.serverId}><span translate="no">{r.server}</span>: {r.error}</p>
          : <ApplyResults key={r.serverId} server={r.server} verb="そろえた" list={r.results} empty="変えるものはありませんでした。" />))}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">そろえる元のサーバーに、このアプリで入れたもの(無効にしたものは除く)と同じ版を入れます。「まったく同じにする」は、そろえる元に無いもの(このアプリで入れたもの)を外します。「更新を止める」にしたもの・無効にしたものは変えません。外したもの・入れ替えたものは「変更の履歴」から元に戻せます。</p>
    </>
  );
}

// フォルダのサーバーの起動・停止・RCON(パネルの PC でコマンドを実行するので、管理者以上だけ)
function LocalControl({ id }: { id: string }) {
  const load = useServerFn(localSettings);
  const save = useServerFn(setLocalSettings);
  const [s, setS] = useState<Awaited<ReturnType<typeof localSettings>> | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { load({ data: { id } }).then(setS, (e) => setError(message(e))); }, [id]);
  if (!s) return error ? <p className="row error" role="alert">{error}</p> : null;

  const submit = async (clearPassword = false) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await save({ data: { id, control: s.control, startCmd: s.startCmd, stopCmd: s.stopCmd, container: s.container, rconPort: s.rconPort,
        ...(clearPassword ? { rconPassword: "" } : password ? { rconPassword: password } : {}) } });
      setPassword("");
      setS(await load({ data: { id } }));
      setNote("保存しました");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="group-title">起動・停止と RCON(フォルダ <span translate="no">{s.rootDir}</span>)</div>
      <section className="group form">
        <div className="row">
          <span>起動・停止</span>
          <select className="trail" value={s.control} aria-label="起動・停止の方法" onChange={(e) => setS({ ...s, control: e.target.value })}>
            <option value="none">このパネルからはしない</option>
            <option value="command">コマンドを実行する</option>
            <option value="docker">Docker のコンテナ</option>
          </select>
        </div>
        {s.control === "command" && (
          <>
            <input className="row codes" placeholder="起動のコマンド(例 systemctl start minecraft)" value={s.startCmd} onChange={(e) => setS({ ...s, startCmd: e.target.value })} aria-label="起動のコマンド" />
            <input className="row codes" placeholder="停止のコマンド(空なら RCON の stop)" value={s.stopCmd} onChange={(e) => setS({ ...s, stopCmd: e.target.value })} aria-label="停止のコマンド" />
          </>
        )}
        {s.control === "docker" && (
          <input className="row codes" placeholder="コンテナの名前(例 minecraft)" value={s.container} onChange={(e) => setS({ ...s, container: e.target.value })} aria-label="コンテナの名前" />
        )}
        <input className="row" inputMode="numeric" placeholder="RCON のポート(空なら server.properties の rcon.port)" value={s.rconPort ?? ""}
          onChange={(e) => setS({ ...s, rconPort: e.target.value.trim() ? Number(e.target.value) : null })} aria-label="RCON のポート" />
        <input className="row" type="password" autoComplete="off" placeholder={s.hasRconPassword ? "RCON のパスワード(設定済み。変えるときだけ入力)" : "RCON のパスワード(コマンド・停止・状態に使う)"}
          value={password} onChange={(e) => setPassword(e.target.value)} aria-label="RCON のパスワード" />
        <div className="row actions">
          <button className="link" type="button" disabled={busy} onClick={() => submit()}>{busy ? "保存しています…" : "保存"}</button>
          {s.hasRconPassword && <button className="trail link danger" type="button" disabled={busy} onClick={() => submit(true)}>RCON のパスワードを消す</button>}
        </div>
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">コマンドは、パネルを動かしている PC の、サーバーのフォルダで実行します。Docker のコンテナを使うときは、パネルのコンテナに /var/run/docker.sock をマウントしてください(ほかのコンテナも操作できるようになるので、要るときだけ)。RCON は server.properties で enable-rcon=true にしてください。</p>
    </>
  );
}

// a が b より古いバージョンか(1.21.10 は 1.21.4 より新しい)
const older = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

// サーバー本体(jar): 今のビルドといちばん新しいビルド。入れ替える(ビルド・Minecraft のバージョンを選べる)・残した jar に戻すのは管理者以上
function Software({ id, admin }: { id: string; admin: boolean }) {
  const load = useServerFn(softwareInfo);
  const update = useServerFn(updateSoftware);
  const install = useServerFn(installSoftware);
  const listBuilds = useServerFn(softwareBuilds);
  const back = useServerFn(rollbackSoftware);
  const choose = useServerFn(setSoftware);
  const backupWorld = useServerFn(createWorldBackup);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof softwareInfo>> | null>(null);
  const [builds, setBuilds] = useState<Awaited<ReturnType<typeof softwareBuilds>> | null>(null);
  const [pick, setPick] = useState({ mc: "", build: "" });
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load({ data: { id } }).then((d) => { setInfo(d); setError(""); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, [id]);
  const run = async (ask: string | null, fn: () => Promise<string>) => {
    if (ask && !confirm(ask)) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote(await fn());
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const after = (r: { restarted: boolean }) => (r.restarted ? "。再起動しています" : "。サーバーを再起動すると新しい jar で動きます");
  const openBuilds = (mc?: string) => listBuilds({ data: { id, mc } }).then((b) => { setBuilds(b); setPick({ mc: b.mc, build: "" }); }, (e) => setError(message(e)));
  const mcChanged = !!(info && pick.mc && info.mc && pick.mc !== info.mc && !info.proxy);
  return (
    <>
      <div className="group-title">サーバー本体</div>
      <section className="group">
        {!info && !error && <div className="row muted">確かめています…</div>}
        {admin && (
          <div className="row">
            <span>サーバー本体の種類</span>
            <select className="trail" value={info?.software ?? ""} disabled={busy} aria-label="サーバー本体の種類" onChange={(e) => run(null, async () => {
              await choose({ data: { id, software: e.target.value } });
              setBuilds(null);
              return "サーバー本体の種類を変えました";
            })}>
              <option value="" disabled>選んでください</option>
              {SOFTWARE_IDS.map((x) => <option key={x} value={x}>{SOFTWARE[x].label}</option>)}
            </select>
          </div>
        )}
        {info && (
          <>
            <div className="row"><span>{info.label}</span><span className="trail muted" translate="no">{info.jar || "jar がわかりません"}</span></div>
            <div className="row"><span>今のビルド</span><span className="trail" translate="no">{info.build ? `${info.mc ? `${info.mc} · ` : ""}${info.build}` : "わかりません"}</span></div>
            <div className="row">
              <span>いちばん新しいビルド</span>
              <span className="trail" translate="no">{info.latest ? info.latest.build : "確かめられません"}</span>
            </div>
            {info.update && <div className="row"><span className="notice small">新しいビルドがあります</span></div>}
            <a className="row link" href={info.page} target="_blank" rel="noopener noreferrer">配布ページで確かめる</a>
            {admin && info.auto && (
              <label className="row"><span>入れ替えたら再起動する</span><input className="trail" type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /></label>
            )}
            {admin && info.update && info.latest?.auto && (
              <button className="row link" type="button" disabled={busy || !info.jar} onClick={() => run(
                `${info.jar} を ${info.latest!.build} に入れ替えますか?(今の jar は残し、あとで戻せます)`,
                async () => { const r = await update({ data: { id, restart } }); return `${r.build} に入れ替えました${after(r)}`; },
              )}>{busy ? "入れ替えています…" : "いちばん新しいビルドに入れ替える"}</button>
            )}
            {admin && info.auto && !builds && (
              <button className="row link" type="button" disabled={busy || !info.jar} onClick={() => openBuilds()}>バージョンを選んで入れ替える…</button>
            )}
            {admin && builds && (
              <>
                {builds.mcVersions.length > 0 && (
                  <div className="row">
                    <span>{info.proxy ? "版" : "Minecraft のバージョン"}</span>
                    <select className="trail" value={pick.mc} aria-label="入れる Minecraft のバージョン" onChange={(e) => openBuilds(e.target.value)}>
                      {!builds.mcVersions.includes(pick.mc) && <option value={pick.mc} translate="no">{pick.mc || "選んでください…"}</option>}
                      {builds.mcVersions.map((v) => <option key={v} value={v} translate="no">{v === info.mc ? `${v}(今)` : v}</option>)}
                    </select>
                  </div>
                )}
                <div className="row">
                  <span>ビルド</span>
                  <select className="trail" value={pick.build} aria-label="入れるビルド" onChange={(e) => setPick({ ...pick, build: e.target.value })}>
                    <option value="">{builds.builds.length ? "選んでください…" : "見つかりません"}</option>
                    {builds.builds.map((b) => <option key={b.build} value={b.build} disabled={!b.auto} translate="no">{`${b.build}${b.stable ? "" : "(試験版)"}${b.build === info.build && pick.mc === info.mc ? "(今)" : ""}`}</option>)}
                  </select>
                </div>
                {mcChanged && (
                  <>
                  <div className="row">
                    <span className="notice small">{`Minecraft のバージョンを ${info.mc} から ${pick.mc} に${older(pick.mc, info.mc) ? "下げると、ワールドが読めなくなったり壊れたりすることがあります" : "上げると、ワールドは新しいバージョンに変換され、元には戻せません"}。先にワールドをバックアップしてください。`}</span>
                  </div>
                    <button className="row link" type="button" disabled={busy} onClick={() => run(null, async () => { await backupWorld({ data: { id } }); return "ワールドのバックアップを始めました(終わると「ワールドのバックアップ」に出ます)"; })}>先にワールドをバックアップする</button>
                  </>
                )}
                <button className="row link" type="button" disabled={busy || !pick.build} onClick={() => run(
                  mcChanged
                    ? `Minecraft を ${info.mc} から ${pick.mc}(ビルド ${pick.build})に変えますか?ワールドのバックアップを取ったか、プラグイン・Mod が ${pick.mc} に対応しているかを確かめてください。`
                    : `${info.jar} を ${pick.build} に入れ替えますか?(今の jar は残し、あとで戻せます)`,
                  async () => { const r = await install({ data: { id, mc: pick.mc || undefined, build: pick.build, restart } }); setBuilds(null); return `${r.mc ? `${r.mc} ` : ""}${r.build} に入れ替えました${after(r)}`; },
                )}>{busy ? "入れ替えています…" : "選んだビルドに入れ替える"}</button>
                <button className="row link" type="button" onClick={() => setBuilds(null)}>閉じる</button>
              </>
            )}
            {info.backups.length > 0 && <div className="row muted small">{`残している前の jar(新しい順・${info.backups.length} 個)`}</div>}
            {info.backups.map((b) => (
              <div className="row" key={b.file}>
                <span className="main">
                  <span translate="no">{`${b.mc ? `${b.mc} · ` : ""}${b.build || "ビルド不明"}`}</span>
                  <span className="muted small" translate="no">{b.file}</span>
                </span>
                {admin && (
                  <button className="trail link" type="button" disabled={busy} onClick={() => run(
                    `${b.build || "前の jar"} に戻しますか?(今の jar は代わりに残します)`,
                    async () => { const r = await back({ data: { id, file: b.file } }); return `${r.build || "前の jar"} に戻しました。サーバーを再起動すると戻した jar で動きます`; },
                  )}>戻す</button>
                )}
              </div>
            ))}
          </>
        )}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">入れ替えるときは、サーバーが配布元から直接 jar を取り込みます。入れ替える前の jar はサーバーのフォルダに 5 つまで残し、そこへ戻せます。Paper・Folia・Purpur・Leaf・Pufferfish・Velocity・Waterfall・BungeeCord・Fabric・Vanilla・Mohist・SpongeVanilla は入れ替えられ、Forge・NeoForge・Quilt・Arclight は新しい版があるかだけを確かめます。</p>
    </>
  );
}

// 今の状態と、Minecraft のサーバーの人数・名前の一部・応答の速さ(Server List Ping)
function Live({ id }: { id: string }) {
  const status = useServerFn(serverStatus);
  const [st, setSt] = useState<Awaited<ReturnType<typeof serverStatus>> | null>(null);
  useEffect(() => {
    const read = () => status({ data: { id } }).then(setSt, () => setSt(null));
    read();
    const t = setInterval(read, 15_000);
    return () => clearInterval(t);
  }, [id]);
  if (!st?.ping) return null;
  const p = st.ping;
  return (
    <section className="group">
      <div className="row"><span>プレイヤー</span><span className="trail">{`${p.online} / ${p.max} 人`}</span></div>
      {p.sample.length > 0 && <div className="row"><span className="muted small" translate="no">{p.sample.join("、")}{p.online > p.sample.length ? " …" : ""}</span></div>}
      <div className="row"><span>応答の速さ</span><span className="trail">{`${p.latency} ms`}</span></div>
      {p.version && <div className="row"><span>バージョン</span><span className="trail muted" translate="no">{p.version}</span></div>}
    </section>
  );
}

// アドオンの変更の履歴(新しい順)。外したもの・入れたもの・更新を元に戻せる(編集者以上)
function Changes({ id, edit, items, onChange }: { id: string; edit: boolean; items: Installed[] | null; onChange: () => void }) {
  const load = useServerFn(serverChanges);
  const undo = useServerFn(undoChange);
  const [list, setList] = useState<Awaited<ReturnType<typeof serverChanges>> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { load({ data: { id } }).then(setList, (e) => setError(message(e))); }, [id, items]);
  if (!list?.length) return null;
  const shown = open ? list : list.slice(0, 5);
  return (
    <>
      <div className="group-title">変更の履歴</div>
      <section className="group">
        {shown.map((c) => (
          <div className={`row${c.undone ? " faded" : ""}`} key={c.id}>
            <span className="main">
              <span><span translate="no">{c.title}</span>{` を${({ 外す: "外した", 更新: "更新した", 無効にする: "無効にした", 有効にする: "有効にした" } as Record<string, string>)[c.action] ?? "入れた"}`}{c.config && <span className="badge muted-badge">設定も退避</span>}</span>
              <span className="muted small" translate="no">{new Date(c.at).toLocaleString("ja-JP")}{c.by ? ` · ${c.by}` : ""}{c.action === "更新" && c.version ? ` · 前の版 ${c.version}` : ""}{c.undone ? " · 元に戻しました" : ""}</span>
            </span>
            {edit && c.undoable && (
              <button className="trail link" type="button" disabled={!!busy} onClick={async () => {
                if (!confirm(c.action === "外す" ? `${c.title} を元に戻しますか?(外したファイルを戻します)` : c.action === "入れる" ? `${c.title} を外しますか?(入れる前に戻します)`
                  : c.action === "無効にする" ? `${c.title} を有効に戻しますか?` : c.action === "有効にする" ? `${c.title} を無効に戻しますか?`
                  : `${c.title} を前の版(${c.version})に戻しますか?(戻したあとは「更新を止める」になります)`)) return;
                setBusy(c.id);
                setError("");
                try {
                  await undo({ data: { id, changeId: c.id } });
                  onChange();
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy("");
                }
              }}>{busy === c.id ? "戻しています…" : "元に戻す"}</button>
            )}
          </div>
        ))}
        {list.length > 5 && <button className="row link" type="button" onClick={() => setOpen((x) => !x)}>{open ? "閉じる" : `すべて見る(${list.length} 件)`}</button>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">外したファイルは消さずに名前を変えて残すので、元に戻せます(1 台につき新しい 30 件まで)。変更はサーバーの再起動で反映されます。</p>
      <p className="foot">プラグインを外す・入れ替えるときは、設定フォルダ(plugins/〈名前〉/)も plugins/.craftshelf-config に退避し、元に戻すと設定も戻します(ファイルが 100 個・20 MB を超えるフォルダは退避しません)。</p>
    </>
  );
}

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
const sizeOf = (n: number | null) => (n === null ? "" : n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

// ワールドのバックアップ(編集者以上が作る・消す・ダウンロード。予約・残す数・置き場所は管理者以上)
function Worlds({ id, admin }: { id: string; admin: boolean }) {
  const load = useServerFn(worldBackups);
  const create = useServerFn(createWorldBackup);
  const remove = useServerFn(removeWorldBackup);
  const save = useServerFn(setWorldBackup);
  const restore = useServerFn(restoreWorldBackup);
  const [opt, setOpt] = useState({ stop: false, truncate: false });
  const [d, setD] = useState<Awaited<ReturnType<typeof worldBackups>> | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof worldBackups>>["settings"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load({ data: { id } }).then((x) => { setD(x); setDraft((old) => old ?? x.settings); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, [id]);
  // 作っている間は、終わるまで一覧を読み直す
  useEffect(() => {
    if (!d?.running) return;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [d]);
  if (!d || !draft) return error ? <p className="row error" role="alert">{error}</p> : null;

  const act = async (fn: () => Promise<unknown>, done = "") => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await fn();
      setNote(typeof r === "string" ? r : done);
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const ptero = d.kind === "ptero";
  return (
    <>
      <div className="group-title">ワールドのバックアップ</div>
      <section className="group">
        {!d.available && <div className="row muted">フォルダのサーバー・エージェントのワールドのバックアップは、自分用の版だけで使えます。</div>}
        {d.available && (
          <button className="row link" type="button" disabled={busy || d.running} onClick={() => act(() => create({ data: { id } }), "")}>
            {d.running ? "バックアップしています…(終わると下に出ます)" : "いまバックアップする"}
          </button>
        )}
        {!d.running && d.last && (d.last.ok
          ? <div className="row muted" role="status">{`作りました: ${new Date(d.last.at).toLocaleString("ja-JP")}`}</div>
          : <div className="row error" role="alert">{`作れませんでした: ${d.last.message}`}</div>)}
        {d.error && <div className="row error" role="alert">{d.error}</div>}
        {d.available && !d.error && d.backups.length === 0 && <div className="row muted">まだありません。</div>}
        {d.backups.map((b) => (
          <div className="row" key={b.name}>
            <span className="main">
              <span>{b.at ? new Date(b.at).toLocaleString("ja-JP") : ""}</span>
              <span className="muted small" translate="no">{b.label}{b.size !== null ? ` · ${sizeOf(b.size)}` : ""}</span>
            </span>
            {!b.done && <span className="badge">作っています</span>}
            {b.done && !b.ok && <span className="badge muted-badge">失敗</span>}
            {b.locked && <span className="badge muted-badge">鍵つき</span>}
            {b.done && b.ok && <a className="trail link" href={`/api/worlds/${id}/${b.name}`} download>ダウンロード</a>}
            {admin && b.done && b.ok && (
              <button className="link danger" type="button" disabled={busy || d.running} onClick={() => {
                const what = new Date(b.at).toLocaleString("ja-JP");
                if (!confirm(ptero
                  ? `${what} のバックアップから戻しますか?サーバーは止まり、サーバー全体がこのときの状態に戻ります${opt.truncate ? "(今のファイルはすべて消えます)" : ""}。`
                  : `${what} のバックアップからワールドを戻しますか?今のワールドは名前を変えて残します。`)) return;
                if (!confirm(ptero ? "もう一度確かめます。本当に戻しますか?" : `もう一度確かめます。サーバーが止まっていることを確かめましたか?${opt.stop ? "(動いていたら止めます)" : "(動いていれば戻しません)"}`)) return;
                act(async () => {
                  const r = await restore({ data: { id, name: b.name, ...opt } });
                  return (ptero ? "パネルが戻しています(終わるとサーバーを起動できます)" : `戻しました(${r.files} ファイル)${r.aside.length ? `。前のワールドは ${r.aside.join("・")} に残しています` : ""}`);
                });
              }}>戻す</button>
            )}
            {!b.locked && b.done && (
              <button className="link danger" type="button" disabled={busy} onClick={() => {
                if (confirm(`${b.label} を消しますか?`)) act(() => remove({ data: { id, name: b.name } }), "消しました");
              }}>消す</button>
            )}
          </div>
        ))}
        {admin && d.backups.length > 0 && (ptero
          ? <label className="row"><span>戻すときに、今のファイルを消してから戻す</span><input className="trail" type="checkbox" checked={opt.truncate} onChange={(e) => setOpt({ ...opt, truncate: e.target.checked })} /></label>
          : <label className="row"><span>戻すときに、動いていたら止める</span><input className="trail" type="checkbox" checked={opt.stop} onChange={(e) => setOpt({ ...opt, stop: e.target.checked })} /></label>)}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      {admin && d.available && (
        <section className="group form">
          <div className="row">
            <span>予約</span>
            <select className="trail" value={draft.mode} aria-label="ワールドのバックアップの予約" onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
              <option value="off">しない</option>
              <option value="daily">毎日</option>
              <option value="weekly">毎週</option>
            </select>
          </div>
          {draft.mode === "weekly" && (
            <div className="row">
              <span>曜日</span>
              <select className="trail" value={draft.dow} aria-label="バックアップする曜日" onChange={(e) => setDraft({ ...draft, dow: Number(e.target.value) })}>
                {DAY_NAMES.map((n, i) => <option key={i} value={i}>{`${n}曜日`}</option>)}
              </select>
            </div>
          )}
          {draft.mode !== "off" && (
            <div className="row">
              <span>時刻</span>
              <input className="trail" type="time" value={draft.time} aria-label="バックアップする時刻" onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
            </div>
          )}
          <div className="row">
            <span>残す数</span>
            <select className="trail" value={draft.keep} aria-label="残すバックアップの数" onChange={(e) => setDraft({ ...draft, keep: Number(e.target.value) })}>
              {[1, 2, 3, 5, 7, 10, 14, 20, 30].map((n) => <option key={n} value={n}>{`${n} 個`}</option>)}
            </select>
          </div>
          {!ptero && (
            <div className="row">
              <span>置き場所</span>
              <select className="trail" value={draft.targetId ?? ""} aria-label="バックアップの置き場所" onChange={(e) => setDraft({ ...draft, targetId: e.target.value || null })}>
                <option value="">パネルの中</option>
                {d.targets.map((t) => <option key={t.id} value={t.id} translate="no">{t.name}</option>)}
              </select>
            </div>
          )}
          {d.settings.lastRunAt && <div className="row muted">{`前に予約で動いたとき: ${new Date(d.settings.lastRunAt).toLocaleString("ja-JP")}`}</div>}
          <button className="row link" type="button" disabled={busy} onClick={() => act(async () => {
            await save({ data: { id, ...draft, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
            setDraft(null);
          }, "保存しました")}>保存</button>
        </section>
      )}
      <p className="foot">{ptero
        ? "Pterodactyl のパネルのバックアップを使います。ワールドだけでなく、サーバー全体(.pteroignore で除いたものを除く)が入り、パネルの置き場所に残ります。作れる数の上限はパネルの設定しだいです。残す数を超えたら、このパネルが作った古いもの(鍵つきを除く)を消します。"
        : "ワールド(server.properties の level-name と、その _nether・_the_end のフォルダ)を tar.gz にまとめます。RCON が使えれば、まとめる間はワールドの保存を止めます(save-off)。1 つ 100 MB を超えるファイルと読めなかったファイルは飛ばし、操作の記録に書きます。"}
        {" 予約の時刻は、保存したときのブラウザの時間帯です。結果は操作の記録に残り、失敗したらお知らせと Discord(「エラー」「バックアップ」を選んでいれば)で知らせます。予約・残す数・置き場所を決められるのは管理者以上です。"}</p>
    </>
  );
}
