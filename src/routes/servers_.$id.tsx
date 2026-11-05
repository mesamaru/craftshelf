import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { identifyMods, serverChanges, undoChange, installMod, installedMods, modUpdates, removeMod, rollbackMod, searchMods, serverDetail, setModHold, setProfile } from "~/lib/library-api";
import { importServerFile } from "~/lib/uploads-api";
import { ApplyResults } from "~/lib/apply-results";
import { PLATFORMS, PLATFORM_IDS } from "~/lib/platforms";
import { localSettings, setLocalSettings } from "~/lib/servers-api";
import { bindServerSet, listSets, syncServerSet } from "~/lib/sets-api";
import { SOURCE_LABEL, type Source, pageUrl } from "~/lib/sources";
import { useCan } from "~/lib/use-can";
import { rollbackSoftware, softwareInfo, updateSoftware } from "~/lib/software-api";

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

      <Profile id={server.id} profile={server.profile} editable={can({ server: ["update"] })} />
      {server.kind === "local" && can({ server: ["update"] }) && <LocalControl id={server.id} />}

      {server.profile && (
        <>
          <Software id={server.id} admin={can({ server: ["update"] })} />
          <SetBinding id={server.id} name={server.name} edit={edit} onSynced={reload} />
          <Installed id={server.id} items={items} error={error} edit={edit} local={app.mode === "self"}
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
  const changed = platform !== (profile?.platform ?? "") || mcVersion !== (profile?.mcVersion ?? "");

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
      {error && <p className="row error" role="alert">{error}</p>}
      {changed && <button className="capsule primary" type="button" onClick={submit} disabled={!platform}>保存</button>}
    </section>
  );
}

function Installed({ id, items, error, edit, local, dir, onChange }:
  { id: string; items: Installed[] | null; error: string; edit: boolean; local: boolean; dir: string; onChange: () => void }) {
  const identify = useServerFn(identifyMods);
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
      <div className="group-title">入っているもの({dir}/)</div>
      <section className="group">
        {!items && !error && <div className="row muted">サーバーに問い合わせています…</div>}
        {items?.length === 0 && <div className="row muted">まだ何も入っていません。</div>}
        {items?.map((m) => {
          const u = updates?.get(m.filename);
          return (
            <div className="row" key={m.filename}>
              <span className="main">
                <span translate="no">{m.title ?? m.filename}</span>
                {m.title && (
                  <span className="muted" translate="no">
                    {m.versionNumber} · {m.filename}
                    {u && <span className="badge">新しい版 {u.latest}</span>}
                    {m.held && <span className="badge muted-badge">更新を止めています</span>}
                  </span>
                )}
              </span>
              {edit && u && (
                <button className="trail link" type="button" disabled={!!busy}
                  onClick={() => run(m.filename, async () => { await install({ data: { id, projectId: u.projectId, source: u.source } }); setUpdates((p) => { const n = new Map(p); n.delete(m.filename); return n; }); })}>
                  {busy === m.filename ? "更新中…" : "更新"}
                </button>
              )}
              {edit && m.canRollback && m.projectId && m.source && (
                <button className={`${u ? "" : "trail "}link`} type="button" disabled={!!busy}
                  onClick={() => confirm(`${m.title} を前の版に戻しますか?(戻したあとは「更新を止める」になります)`) && run(`rb:${m.filename}`, () => rollback({ data: { id, projectId: m.projectId!, source: m.source as Source } }))}>
                  {busy === `rb:${m.filename}` ? "戻しています…" : "前の版に戻す"}
                </button>
              )}
              {edit && m.projectId && m.source && (
                <button className={`${u || m.canRollback ? "" : "trail "}link`} type="button" disabled={!!busy}
                  onClick={() => run(`hold:${m.filename}`, () => hold({ data: { id, projectId: m.projectId!, source: m.source as Source, hold: !m.held } }))}>
                  {m.held ? "止めるのをやめる" : "更新を止める"}
                </button>
              )}
              {edit && local && !m.projectId && (
                <button className="trail link" type="button" disabled={!!busy}
                  onClick={() => run(`imp:${m.filename}`, () => importFile({ data: { id, filename: m.filename } }))}>
                  {busy === `imp:${m.filename}` ? "取り込んでいます…" : "ライブラリに取り込む"}
                </button>
              )}
              {edit && (
                <button className={`${u || m.projectId || local ? "" : "trail "}link danger`} type="button" disabled={!!busy}
                  onClick={() => confirm(`${m.title ?? m.filename} を外しますか?(「変更の履歴」から元に戻せます)`) && run(m.filename, () => remove({ data: { id, filename: m.filename } }))}>
                  外す
                </button>
              )}
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
        {(error || err) && <p className="row error" role="alert">{error || err}</p>}
      </section>
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

// サーバー本体(jar): 今のビルドといちばん新しいビルド。入れ替える・入れ替える前に戻すのは管理者以上
function Software({ id, admin }: { id: string; admin: boolean }) {
  const load = useServerFn(softwareInfo);
  const update = useServerFn(updateSoftware);
  const back = useServerFn(rollbackSoftware);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof softwareInfo>> | null>(null);
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load({ data: { id } }).then((d) => { setInfo(d); setError(""); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, [id]);
  const run = async (ask: string, fn: () => Promise<string>) => {
    if (!confirm(ask)) return;
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
  return (
    <>
      <div className="group-title">サーバー本体</div>
      <section className="group">
        {!info && !error && <div className="row muted">確かめています…</div>}
        {info && (
          <>
            <div className="row"><span>{info.label}</span><span className="trail muted" translate="no">{info.jar || "jar がわかりません"}</span></div>
            <div className="row"><span>今のビルド</span><span className="trail" translate="no">{info.build ? `${info.mc ? `${info.mc} · ` : ""}${info.build}` : "わかりません"}</span></div>
            <div className="row">
              <span>いちばん新しいビルド</span>
              <span className="trail" translate="no">{info.latest ? info.latest.build : "確かめられません"}</span>
            </div>
            {info.update && <div className="row"><span className="notice small">新しいビルドがあります</span></div>}
            {info.latest && !info.latest.auto && <a className="row link" href={info.page} target="_blank" rel="noopener noreferrer">配布ページで確かめる</a>}
            {admin && info.update && info.latest?.auto && (
              <>
                <label className="row"><span>入れ替えたら再起動する</span><input className="trail" type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /></label>
                <button className="row link" type="button" disabled={busy || !info.jar} onClick={() => run(
                  `${info.jar} を ${info.latest!.build} に入れ替えますか?(今の jar は残し、あとで戻せます)`,
                  async () => { const r = await update({ data: { id, restart } }); return `${r.build} に入れ替えました${r.restarted ? "。再起動しています" : "。サーバーを再起動すると新しい jar で動きます"}`; },
                )}>{busy ? "入れ替えています…" : "いちばん新しいビルドに入れ替える"}</button>
              </>
            )}
            {admin && info.backup && (
              <button className="row link" type="button" disabled={busy} onClick={() => run(
                `入れ替える前の jar(${info.backup!.build || "ビルド不明"})に戻しますか?`,
                async () => { const r = await back({ data: { id } }); return `${r.build || "前の jar"} に戻しました。サーバーを再起動すると戻した jar で動きます`; },
              )}>{`入れ替える前の jar に戻す(${info.backup.build || "ビルド不明"})`}</button>
            )}
          </>
        )}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">入れ替えるときは、サーバーが配布元から直接 jar を取り込みます。入れ替える前の jar は 1 つだけ残し、そこへ戻せます。Paper・Folia・Velocity・Purpur・Fabric は入れ替えられ、Forge などは新しい版があるかだけを確かめます。</p>
    </>
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
              <span><span translate="no">{c.title}</span>{` を${c.action === "外す" ? "外した" : c.action === "更新" ? "更新した" : "入れた"}`}</span>
              <span className="muted small" translate="no">{new Date(c.at).toLocaleString("ja-JP")}{c.by ? ` · ${c.by}` : ""}{c.action === "更新" && c.version ? ` · 前の版 ${c.version}` : ""}{c.undone ? " · 元に戻しました" : ""}</span>
            </span>
            {edit && c.undoable && (
              <button className="trail link" type="button" disabled={!!busy} onClick={async () => {
                if (!confirm(c.action === "外す" ? `${c.title} を元に戻しますか?(外したファイルを戻します)` : c.action === "入れる" ? `${c.title} を外しますか?(入れる前に戻します)` : `${c.title} を前の版(${c.version})に戻しますか?(戻したあとは「更新を止める」になります)`)) return;
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
    </>
  );
}
