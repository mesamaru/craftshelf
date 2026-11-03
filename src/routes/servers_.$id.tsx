import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { installMod, installedMods, modUpdates, removeMod, searchMods, serverDetail, setProfile } from "~/lib/library-api";
import { ApplyResults } from "~/lib/apply-results";
import { PLATFORMS, PLATFORM_IDS } from "~/lib/platforms";
import { bindServerSet, listSets, syncServerSet } from "~/lib/sets-api";
import { SOURCES, SOURCE_LABEL, type Source, pageUrl } from "~/lib/sources";
import { useCan } from "~/lib/use-can";

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
  const { user } = Route.useRouteContext();
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

      {server.profile && (
        <>
          <SetBinding id={server.id} name={server.name} edit={edit} onSynced={reload} />
          <Installed id={server.id} items={items} error={error} edit={edit}
            dir={PLATFORMS[server.profile.platform].dir} onChange={reload} />
          {edit && <Search id={server.id} installed={items ?? []} plugins={PLATFORMS[server.profile.platform].type === "plugin"} onInstalled={reload} />}
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

function Installed({ id, items, error, edit, dir, onChange }:
  { id: string; items: Installed[] | null; error: string; edit: boolean; dir: string; onChange: () => void }) {
  const check = useServerFn(modUpdates);
  const install = useServerFn(installMod);
  const remove = useServerFn(removeMod);
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
                  </span>
                )}
              </span>
              {edit && u && (
                <button className="trail link" type="button" disabled={!!busy}
                  onClick={() => run(m.filename, async () => { await install({ data: { id, projectId: u.projectId, source: u.source } }); setUpdates((p) => { const n = new Map(p); n.delete(m.filename); return n; }); })}>
                  {busy === m.filename ? "更新中…" : "更新"}
                </button>
              )}
              {edit && (
                <button className={`${u ? "" : "trail "}link danger`} type="button" disabled={!!busy}
                  onClick={() => confirm(`${m.title ?? m.filename} を外しますか?(サーバーからファイルを消します)`) && run(m.filename, () => remove({ data: { id, filename: m.filename } }))}>
                  外す
                </button>
              )}
            </div>
          );
        })}
        {items && items.some((m) => m.projectId) && (
          <button className="row link" type="button" onClick={checkUpdates} disabled={!!busy}>
            {busy === "check" ? "確かめています…" : updates ? `更新を確かめる(${updates.size} 件あり)` : "更新を確かめる"}
          </button>
        )}
        {(error || err) && <p className="row error" role="alert">{error || err}</p>}
      </section>
      <p className="foot">Modrinth・SpigotMC から入れたものは、版と更新がわかります。それ以外のファイルは名前だけを表示します。変更はサーバーの再起動で反映されます。</p>
    </>
  );
}

function Search({ id, installed, plugins, onInstalled }: { id: string; installed: Installed[]; plugins: boolean; onInstalled: () => void }) {
  const search = useServerFn(searchMods);
  const install = useServerFn(installMod);
  const [source, setSource] = useState<Source>("modrinth");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchMods>> | null>(null);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Set<string>>(new Set());
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
      await install({ data: { id, projectId, source } });
      setDone((d) => new Set(d).add(key(source, projectId)));
      onInstalled();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="group-title">{SOURCE_LABEL[source]} から探す</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), find())}>
        {plugins && (
          <div className="row">
            <span>配布元</span>
            <select className="trail" value={source} aria-label="配布元"
              onChange={(e) => { const s = e.target.value as Source; setSource(s); setHits(null); find(s); }}>
              {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
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
            onClick={() => run("sync", async () => { setResults(await sync({ data: { serverId: id } })); onSynced(); })}>
            {busy === "sync" ? "そろえています…" : "セットでそろえる"}
          </button>
        )}
        {edit && sets.length === 0 && <div className="row muted">まだセットがありません。トップの「セット」で作れます。</div>}
        {results && <ApplyResults server={name} verb="そろえた" list={results} />}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">「セットでそろえる」は、セットのうちこのサーバーの種類に合うもので、足りないものを入れ、入っているものに新しい版があれば更新します。セットに無いものは外しません。</p>
    </>
  );
}
