import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { authClient } from "~/lib/auth-client";
import { addLibraryItem, installMod, libraryCatalog, removeLibraryItem, searchCatalog } from "~/lib/library-api";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Home,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = { plugin: "プラグイン", mod: "Mod" };

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;

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

  const edit = can({ library: ["edit"] });
  return (
    <main className="page narrow">
      <header className="bar">
        <h1>ライブラリ</h1>
        <Link to="/team" className="capsule" aria-label="チーム">
          <span translate="no">{team?.name ?? "チーム"}</span>
        </Link>
        <Link to="/settings" className="capsule" aria-label="アカウントの設定">
          <span translate="no">{user.name}</span>
        </Link>
      </header>
      <section className="group">
        <Link to="/servers" className="row link">サーバー(起動・停止・パネルの登録)</Link>
      </section>

      <div className="group-title">Mod・プラグイン</div>
      <section className="group">
        {!cat && !error && <div className="row muted">読み込んでいます…</div>}
        {cat?.items.length === 0 && <div className="row muted">まだ何もありません。サーバーに入れたものは自動でここに載ります。下の「Modrinth から足す」でも登録できます。</div>}
        {cat?.items.map((i) => <Item key={i.id} item={i} servers={cat.servers} edit={edit} onChange={reload} />)}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">チームで使う Mod・プラグインの一覧です。ファイルはこのアプリには置かず、サーバーには Modrinth から直接取り込みます。入れる版は、サーバーの種類とバージョンに合うものを選びます(Paper のサーバーには Paper 向けの作りを優先)。</p>

      {edit && cat && <AddFromModrinth have={new Set(cat.items.map((i) => i.projectId))} onAdded={reload} />}
    </main>
  );
}

function Item({ item, servers, edit, onChange }:
  { item: Catalog["items"][number]; servers: Catalog["servers"]; edit: boolean; onChange: () => void }) {
  const install = useServerFn(installMod);
  const remove = useServerFn(removeLibraryItem);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const have = new Set(item.installs.map((x) => x.serverId));
  const targets = servers.filter((s) => s.type === item.projectType && !have.has(s.id));

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
      {item.iconUrl ? <img src={item.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="icon-ph" />}
      <span className="main">
        <a href={`https://modrinth.com/project/${item.slug || item.projectId}`} target="_blank" rel="noreferrer noopener" translate="no">{item.title}</a>
        <span className="muted">
          {TYPE_LABEL[item.projectType] ?? item.projectType} · {item.installs.length
            ? <span translate="no">{item.installs.map((x) => `${x.serverName} ${x.versionNumber}`).join("、")}</span>
            : "どのサーバーにも入っていません"}
        </span>
        {busy && <span className="muted">{busy === "remove" ? "外しています…" : "サーバーに入れています…"}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      {edit && targets.length > 0 && (
        <select className="trail" value="" disabled={!!busy} aria-label={`${item.title} をサーバーに入れる`}
          onChange={(e) => { const sid = e.target.value; if (sid) run(sid, () => install({ data: { id: sid, projectId: item.projectId } })); }}>
          <option value="">サーバーに入れる…</option>
          {targets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
        </select>
      )}
      {edit && (
        <button className={`${targets.length ? "" : "trail "}link danger`} type="button" disabled={!!busy}
          onClick={() => confirm(`${item.title} をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`) && run("remove", () => remove({ data: { itemId: item.id } }))}>
          外す
        </button>
      )}
    </div>
  );
}

function AddFromModrinth({ have, onAdded }: { have: Set<string>; onAdded: () => void }) {
  const search = useServerFn(searchCatalog);
  const add = useServerFn(addLibraryItem);
  const [type, setType] = useState<"plugin" | "mod">("plugin");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchCatalog>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const find = async (t = type) => {
    setError("");
    try {
      setHits(await search({ data: { query, type: t } }));
    } catch (e) {
      setError(message(e));
    }
  };

  const pick = async (projectId: string) => {
    setBusy(projectId);
    setError("");
    try {
      await add({ data: { projectId } });
      onAdded();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="group-title">Modrinth から足す</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), find())}>
        <div className="row">
          <span>種類</span>
          <select className="trail" value={type} aria-label="種類" onChange={(e) => { const t = e.target.value as "plugin" | "mod"; setType(t); if (hits) find(t); }}>
            <option value="plugin">プラグイン</option>
            <option value="mod">Mod</option>
          </select>
        </div>
        <input className="row" type="search" placeholder="名前で探す(空なら人気順)" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!hits && <button className="row link" type="submit">探す</button>}
        {hits?.length === 0 && <p className="row muted">見つかりませんでした。</p>}
        {hits?.map((h) => (
          <div className="row hit" key={h.projectId}>
            {h.iconUrl ? <img src={h.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="icon-ph" />}
            <span className="main">
              <a href={`https://modrinth.com/project/${h.slug || h.projectId}`} target="_blank" rel="noreferrer noopener" translate="no">{h.title}</a>
              <span className="muted summary" translate="no">{h.summary}</span>
              <span className="muted">{h.downloads.toLocaleString("ja-JP")} ダウンロード</span>
            </span>
            {have.has(h.projectId) ? (
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
