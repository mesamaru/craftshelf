import { useEffect, useRef, useState } from "react";
import { Link, Outlet, createFileRoute, redirect, useParams, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  addConnection, addLocalServer, addServers, browseHost, listConnections, listServers, remoteServers, sharedLocalEnabled, sharedServers, removeConnection,
} from "~/lib/servers-api";
import { useCan, useTeamKey } from "~/lib/use-can";
import { shared } from "~/lib/shared";
import { ApplyResults } from "~/lib/apply-results";
import { updateServers } from "~/lib/sets-api";
import { outdatedLibraryServers } from "~/lib/library-api";
import { filesAccess } from "~/lib/files-api";
import { addAgentServer, createAgent, listAgents, removeAgent } from "~/lib/agents-api";
import { STATE_LABELS, kindLabel } from "~/lib/platforms";
import { type Status, ServerStatusCtx, refreshStatus, useStatuses } from "~/lib/server-status";
import { Btn, Chip, ChipBar, Icon, type IconName, Info, Seg, Sheet } from "~/lib/ui";
import { SERVER_FILTERS, SERVER_SORTS, type ServerFilter, type ServerItem, type ServerSort, arrange, isServerSort } from "~/lib/server-list";
import { MobileSearch, StoragePill } from "~/lib/shell";
import { pageTitle } from "~/lib/titles";
import { confirmDialog } from "~/lib/dialog-queue";

export const Route = createFileRoute("/servers")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/servers" } });
    return { user: context.user };
  },
  loader: async () => ({ servers: await sharedServers(), connections: await listConnections(), local: await sharedLocalEnabled() }),
  head: () => ({ meta: [{ title: pageTitle("サーバー") }] }),
  component: Servers,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

type Server = Awaited<ReturnType<typeof listServers>>[number];
// 更新の確かめは配布元に問い合わせるので、開くたびにはしない(10 分は前の結果を使う。「更新」の数を押すと、いつでも確かめ直す)
const SORT_KEY = "craftshelf.servers.sort";
const GROUP_KEY = "craftshelf.servers.group";
const OLD_TTL = 10 * 60_000;
let lastOld: { team: string; at: number; map: Map<string, number> } | null = null;

// サーバー(v02 と同じ 1 つの画面): 上に 比較・サーバー本体・ファイル比較・ポート・処理と「＋ サーバーを追加」、
// 左に 稼働・更新・人数の数と「対応が必要」「問題なし」のサーバーの一覧と「すべて更新」、右に選んだサーバーの詳細(servers.$id.tsx)。
// 幅 900 px まで(スマホ)は一覧 → 詳細の 2 画面
function Servers() {
  const { user } = Route.useRouteContext();
  const { servers, connections, local } = Route.useLoaderData();
  const { can } = useCan(user.id);
  const teamKey = useTeamKey(); // 選んでいるチームが分かる(null = まだ)まで、チームごとの読み込みはしない
  const id = (useParams({ strict: false }) as { id?: string }).id;
  const router = useRouter();
  const reload = () => router.invalidate();
  const edit = can({ library: ["edit"] });
  const create = can({ server: ["create"] });
  const outdated = useServerFn(outdatedLibraryServers);
  const access = useServerFn(filesAccess);
  const [old, setOld] = useState<Map<string, number> | null>(() => (lastOld && lastOld.team === teamKey && Date.now() - lastOld.at < OLD_TTL ? lastOld.map : null)); // サーバー → 古い版の数
  const [checking, setChecking] = useState(false);
  const [files, setFiles] = useState(false);
  const [sheet, setSheet] = useState<"" | "add" | "update">("");
  const [error, setError] = useState("");

  // 状態は 15 秒ごとに、権限のあるサーバーぶんを 1 回でまとめて取る(メニューの点・詳細も同じ結果。src/lib/server-status.ts)
  const st = useStatuses(servers.map((s) => s.id), 15_000, true);
  useEffect(() => { if (teamKey !== null) shared("files-access", () => access(), 5000).then((a) => setFiles(a.allowed), () => setFiles(false)); }, [teamKey]);
  // 「更新あり」は配布元に問い合わせる。開いたとき(前の結果が新しければそれを使う)と、「更新」の数を押したときに確かめる
  const checkOld = (fresh = false) => {
    setChecking(true);
    setError("");
    outdated({ data: { fresh } }).then((r) => {
      const n = new Map<string, number>();
      for (const x of r) for (const sid of x.serverIds) n.set(sid, (n.get(sid) ?? 0) + 1);
      lastOld = { team: teamKey ?? "", at: Date.now(), map: n };
      setOld(n);
    }, (e) => setError(message(e))).finally(() => setChecking(false));
  };
  useEffect(() => { if (teamKey !== null && servers.length && !old) checkOld(); }, [teamKey, servers.length]); // チームが分かってから 1 回だけ

  const stateOf = (sid: string) => { const x = st[sid]; return typeof x === "object" ? x.state : ""; };
  const running = servers.filter((s) => stateOf(s.id) === "running").length;
  const players = servers.reduce((n, s) => { const x = st[s.id]; return n + (typeof x === "object" ? x.ping?.online ?? 0 : 0); }, 0);
  const updates = old ? servers.reduce((n, s) => n + (old.get(s.id) ?? 0), 0) : null;
  const behind = servers.filter((s) => old?.get(s.id));
  // 並べ替え・グループ分けはこの端末に覚える(読み込むまで、いちばん上のサーバーは決めない)
  const [pref, setPref] = useState<{ sort: ServerSort; group: boolean }>({ sort: "name", group: true });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const sort = localStorage.getItem(SORT_KEY);
      setPref({ sort: isServerSort(sort) ? sort : "name", group: localStorage.getItem(GROUP_KEY) !== "0" });
    } catch {}
    setLoaded(true);
  }, []);
  const save = (p: Partial<typeof pref>) => {
    setPref((x) => ({ ...x, ...p }));
    try { if (p.sort) localStorage.setItem(SORT_KEY, p.sort); if (p.group !== undefined) localStorage.setItem(GROUP_KEY, p.group ? "1" : "0"); } catch {}
  };
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<ServerFilter>("all");
  const many = servers.length > 4; // 少ないときは絞り込みを出さない(並べ替えだけ)
  const items = servers.map((s, index) => {
    const x = st[s.id];
    return { ...s, index, state: stateOf(s.id), old: old?.get(s.id) ?? 0, online: typeof x === "object" ? x.ping?.online ?? 0 : 0 };
  });
  const { need, ok, first } = arrange(items, { sort: pref.sort, q: many ? q : "", filter: many ? filter : "all", group: pref.group });
  const nothing = servers.length > 0 && need.length + ok.length === 0;
  const group = (title: string, list: (Server & ServerItem)[]) => list.length > 0 && (
    <div key={title || "all"}>
      {title && <div className="sgrp">{title}</div>}
      <section className="group slist">{list.map((s) => <ServerRow key={s.id} server={s} st={st[s.id]} old={old?.get(s.id) ?? 0} checked={!!old} on={s.id === id} />)}</section>
    </div>
  );
  const link = (to: string, icon: IconName, label: string) => <Link to={to as "/"} className="btn tint sm"><Icon name={icon} />{label}</Link>;

  return (
    <ServerStatusCtx.Provider value={{ st, refresh: refreshStatus, first: loaded ? first : null, old }}>
      <main className={`page fill srv${id ? " has-id" : ""}`}>
        <header className="bar">
          <h1>サーバー
            <Info>
              <span>Pterodactyl パネル・パネルから見えるフォルダ・エージェント(家の中のサーバー機)のサーバーをまとめて扱います。左の一覧から選ぶと、状態・コンソール・アドオン・ファイル・保存(バックアップ)・設定を開きます。</span>
              <span>「すべて更新」は、このアプリで入れた Mod・プラグインに新しい版があれば入れます。「更新を止める」にしたもの・無効にしたもの・種類を決めていないサーバーは変えません。変更はサーバーの再起動で反映されます。</span>
            </Info>
          </h1>
          <StoragePill />
        </header>
        <MobileSearch />
        <div className="srv-top">
          {link("/compare", "compare", "比較")}
          {link("/software", "servers", "サーバー本体")}
          {files && link("/compare/files", "file", "ファイル比較")}
          {link("/ports", "tray", "ポート")}
          {link("/jobs", "jobs", "処理")}
          <span className="grow" />
          {create && <Btn kind="pri" onClick={() => setSheet("add")}>＋ サーバーを追加</Btn>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="srv-split">
          <aside className="srv-side" aria-label="サーバーの一覧">
            <div className="sstats">
              <div className="glass"><small>稼働</small><b>{running}<i>{`/${servers.length}`}</i></b></div>
              <button type="button" className={`glass${updates ? " warn" : ""}`} disabled={checking} onClick={() => checkOld(true)} title="押すと、配布元に問い合わせて確かめ直します">
                <small>更新</small><b>{checking && updates === null ? "…" : updates ?? "—"}</b>
              </button>
              <div className="glass"><small>人数</small><b>{players}</b></div>
            </div>
            {servers.length === 0 && <section className="group"><div className="row muted">まだサーバーがありません。</div></section>}
            {servers.length > 0 && (
              <div className="sfilter">
                {many && <label className="q"><Icon name="search" /><input type="search" placeholder="検索" aria-label="名前で絞り込む" value={q} onChange={(e) => setQ(e.target.value)} /></label>}
                <select className="sel" value={pref.sort} aria-label="並べ替え" onChange={(e) => save({ sort: e.target.value as ServerSort })}>
                  {SERVER_SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            )}
            {many && (
              <ChipBar label="絞り込み">
                {SERVER_FILTERS.map(([v, l]) => <Chip key={v} on={filter === v} warn={v === "update"} onClick={() => setFilter(v)}>{l}</Chip>)}
                {behind.length > 0 && <Chip on={pref.group} onClick={() => save({ group: !pref.group })}>グループ分け</Chip>}
              </ChipBar>
            )}
            {nothing && <section className="group"><div className="row muted">条件に合うサーバーはありません</div></section>}
            {group(need.length ? "対応が必要" : "", need)}
            {group(need.length ? "問題なし" : "", ok)}
            {edit && servers.length > 0 && (
              <button type="button" className="sall glass" onClick={() => setSheet("update")}>
                <Icon name="reload" />
                <span className="mid"><span className="ttl">すべて更新</span>{updates ? <span className="sub">{`${behind.length} 台・${updates} 件`}</span> : null}</span>
                <span className="btn tint sm">更新</span>
              </button>
            )}
          </aside>
          <div className="srv-main"><Outlet /></div>
        </div>
        {sheet === "update" && <UpdateAll servers={servers} onClose={() => setSheet("")} />}
        {sheet === "add" && <AddServer connections={connections} local={local && can({ member: ["update"] })} admin={can({ server: ["delete"] })} onDone={reload} onClose={() => setSheet("")} />}
      </main>
    </ServerStatusCtx.Provider>
  );
}

// 一覧の 1 行: 稼働の点・名前・「種類 · 状態」・印(更新 N / 最新)
function ServerRow({ server, st, old, checked, on }: { server: Server; st: Status | string | undefined; old: number; checked: boolean; on: boolean }) {
  const s = typeof st === "object" ? st : null;
  const state = s?.state ?? (typeof st === "string" ? "unknown" : "");
  const kind = kindLabel(server.platform, server.mcVersion);
  return (
    <Link to="/servers/$id" params={{ id: server.id }} className="row click" aria-current={on ? "true" : undefined}>
      <span className={`dot ${state}`} aria-hidden="true" />
      <span className="mid">
        <span className="ttl" translate="no">{server.name}</span>
        <span className="sub">
          <span translate="no">{kind || server.connection || ""}</span>
          {" · "}
          {typeof st === "string" ? <span className="error">つながりません</span>
            : !s ? "確認中…"
            : s.state === "running" && s.ping ? `${s.ping.online} / ${s.ping.max} 人`
            : STATE_LABELS[s.state] ?? "状態がわかりません"}
        </span>
      </span>
      {old > 0 ? <span className="badge upd" title={`アドオン: 更新 ${old} 件`}>{`更新 ${old}`}</span> : checked && server.platform ? <span className="badge ok" title="アドオン: 最新(サーバー本体の新しいビルドは、サーバーの画面で確かめます)">最新</span> : null}
      <span className="chev" aria-hidden="true">›</span>
    </Link>
  );
}

// すべて更新(v02 の「すべて最新にする」): 選んだサーバーの Mod・プラグインを新しい版にする
function UpdateAll({ servers, onClose }: { servers: Server[]; onClose: () => void }) {
  const run = useServerFn(updateServers);
  const [picked, setPicked] = useState<Set<string>>(new Set(servers.map((s) => s.id)));
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof updateServers>> | null>(null);
  const [error, setError] = useState("");
  const all = picked.size === servers.length;
  const go = async () => {
    if (!(await confirmDialog({ message: all ? `すべてのサーバー(${servers.length} 台)の Mod・プラグインを最新にしますか?` : `選んだ ${picked.size} 台の Mod・プラグインを最新にしますか?`, ok: "更新" }))) return;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      setResults(await run({ data: { ids: all ? [] : [...picked] } }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="すべて更新" onClose={onClose}>
      <p className="sub">このアプリで入れた Mod・プラグインに新しい版があれば入れます(止めたもの・無効にしたものは除く)。</p>
      <section className="group">
        {servers.map((s) => (
          <label className="row" key={s.id}>
            <input type="checkbox" className="ck" checked={picked.has(s.id)} disabled={busy}
              onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
            <span className="mid"><span className="ttl" translate="no">{s.name}</span><span className="sub" translate="no">{kindLabel(s.platform, s.mcVersion) || "—"}</span></span>
          </label>
        ))}
      </section>
      {results && (
        <section className="group">
          {results.map((r) => (r.error
            ? <p className="row error" key={r.serverId}><span translate="no">{r.server}</span>: {r.error}</p>
            : <ApplyResults key={r.serverId} server={r.server} verb="最新にした" list={r.results} empty="新しい版はありませんでした。" />))}
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-foot">
        <Btn onClick={() => setPicked(all ? new Set() : new Set(servers.map((s) => s.id)))} disabled={busy}>{all ? "選ぶのをやめる" : "すべて選ぶ"}</Btn>
        <span className="grow" />
        <Btn kind="pri" disabled={busy || !picked.size} onClick={go}>{busy ? "最新にしています…" : `${picked.size} 台を更新`}</Btn>
      </div>
    </Sheet>
  );
}

// 「＋ 追加」: Pterodactyl パネル・フォルダのサーバー(自分用の版だけ)・エージェントのつなぎ方
type AddMode = "ptero" | "local" | "agent";
function AddServer({ connections, local, admin, onDone, onClose }:
  { connections: Awaited<ReturnType<typeof listConnections>>; local: boolean; admin: boolean; onDone: () => void; onClose: () => void }) {
  const [mode, setMode] = useState<AddMode>("ptero");
  const modes: [AddMode, string][] = [["ptero", "Pterodactyl"], ...(local ? [["local", "フォルダ"] as [AddMode, string]] : []), ["agent", "エージェント"]];
  return (
    <Sheet title="サーバーを追加" onClose={onClose}>
      <Seg label="つなぎ方" value={mode} options={modes} onChange={setMode} />
      {mode === "ptero" && <>
        {connections.map((c) => <Connection key={c.id} {...c} removable={admin} onDone={onDone} />)}
        <NewConnection onDone={onDone} />
      </>}
      {mode === "local" && <NewLocal onDone={() => { onDone(); onClose(); }} />}
      {mode === "agent" && <Agents onDone={onDone} />}
    </Sheet>
  );
}

function Connection({ id, name, url, apiKeyHint, removable, onDone }:
  { id: string; name: string; url: string; apiKeyHint: string; removable: boolean; onDone: () => void }) {
  const remove = useServerFn(removeConnection);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const drop = async () => {
    if (!(await confirmDialog({ message: `${name} の登録を消しますか?このパネルから追加したサーバーも一覧から外れます。`, ok: "消す", danger: true }))) return;
    try {
      await remove({ data: { id } });
      onDone();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section className="group">
      <div className="row">
        <span className="mid">
          <span className="ttl" translate="no">{name}</span>
          <span className="sub" translate="no">{url} · キー {apiKeyHint}</span>
        </span>
        {removable && <Btn kind="red" sm onClick={drop}>登録を消す</Btn>}
      </div>
      {!open && <button className="row link" type="button" onClick={() => setOpen(true)}>このパネルのサーバーを追加</button>}
      {open && <PickServers connectionId={id} onDone={() => { setOpen(false); onDone(); }} />}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}

function PickServers({ connectionId, onDone }: { connectionId: string; onDone: () => void }) {
  const list = useServerFn(remoteServers);
  const add = useServerFn(addServers);
  const [items, setItems] = useState<{ identifier: string; name: string; node: string; added: boolean }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    list({ data: { id: connectionId } }).then(setItems, (e) => setError(message(e)));
  }, [connectionId]);

  const toggle = (r: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(r)) n.delete(r);
    else n.add(r);
    return n;
  });
  const submit = async () => {
    try {
      await add({ data: { connectionId, remoteIds: [...picked] } });
      onDone();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <>
      {!items && !error && <p className="row muted">パネルに問い合わせています…</p>}
      {items?.length === 0 && <p className="row muted">このキーで操作できるサーバーがありません。</p>}
      {items?.map((s) => (
        <label key={s.identifier} className="row">
          <input type="checkbox" className="ck" disabled={s.added} checked={s.added || picked.has(s.identifier)} onChange={() => toggle(s.identifier)} />
          <span className="mid">
            <span className="ttl" translate="no">{s.name}</span>
            <span className="sub" translate="no">{s.node}{s.added ? "(追加済み)" : ""}</span>
          </span>
        </label>
      ))}
      {items && items.length > 0 && (
        <div className="row">
          <span className="grow" />
          <Btn sm onClick={onDone}>やめる</Btn>
          <Btn kind="pri" sm onClick={submit} disabled={picked.size === 0}>選んだサーバーを追加</Btn>
        </div>
      )}
      {error && <p className="row error" role="alert">{error}</p>}
    </>
  );
}

function NewConnection({ onDone }: { onDone: () => void }) {
  const save = useServerFn(addConnection);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await save({ data: { name, url, apiKey } });
      setName("");
      setUrl("");
      setApiKey("");
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={(e) => (e.preventDefault(), submit())}>
      <div className="gtitle">パネルをつなぐ
        <Info>パネルの「アカウント → API 認証情報」で作った Client API キー(ptlc_…)を使います。キーは暗号化して保存し、画面には最後の 4 文字だけを出します。</Info>
      </div>
      <input className="input" placeholder="名前(例 いつものホスティング)" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input" placeholder="パネルの URL(https://…)" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
      <input className="input" type="password" autoComplete="off" placeholder="Client API キー(ptlc_…)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-foot"><span className="grow" /><button className="btn pri" disabled={busy || !url || !apiKey}>{busy ? "確かめています…" : "パネルをつなぐ"}</button></div>
    </form>
  );
}

// フォルダのサーバーを追加(自分用の版だけ): パネルから見えるフォルダをたどり、サーバーの jar か、フォルダを選ぶ
function NewLocal({ onDone }: { onDone: () => void }) {
  const browse = useServerFn(browseHost);
  const add = useServerFn(addLocalServer);
  const [view, setView] = useState<Awaited<ReturnType<typeof browseHost>> | null>(null);
  const [path, setPath] = useState("/");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0); // 後から届いた古い返事で、表示を上書きしない

  const go = async (p: string) => {
    setError("");
    const n = ++latest.current;
    try {
      const v = await browse({ data: { path: p } });
      if (n !== latest.current) return;
      setView(v);
      setPath(v.path);
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => { go(path); }, []);
  const submit = async (rootDir: string, jar?: string) => {
    setBusy(true);
    setError("");
    try {
      await add({ data: { rootDir, name, ...(jar ? { jar } : {}) } });
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const join = (a: string, b: string) => (a.endsWith("/") || a.endsWith("\\") ? a + b : `${a}/${b}`);

  return (
    <>
      <div className="gtitle">フォルダのサーバーを追加
        <Info>
          <span>パネルから見えるフォルダ(同じ PC・NAS・Docker でマウントしたフォルダ)にあるサーバーを、Pterodactyl を通さずに管理します。</span>
          <span>サーバーの jar(例 paper-1.21.4.jar)を選ぶと、そのフォルダをサーバーにして、名前から種類と Minecraft のバージョンを決めます。Docker で動かしている場合は、サーバーのフォルダをパネルのコンテナにマウントしてください。</span>
        </Info>
      </div>
      <input className="input" placeholder="名前(空ならフォルダの名前)" value={name} onChange={(e) => setName(e.target.value)} />
      <form className="cmd" onSubmit={(e) => (e.preventDefault(), go(path))}>
        <input className="input" value={path} onChange={(e) => { latest.current++; setPath(e.target.value); }} aria-label="フォルダの場所" />
        <button className="btn sm" type="submit">開く</button>
      </form>
      <section className="group">
        {!view && !error && <div className="row muted">読み込んでいます…</div>}
        {view?.parent && <button className="row link" type="button" onClick={() => go(view.parent!)}>‹ 上のフォルダ</button>}
        {view?.entries.map((e) => e.isDir
          ? <button key={e.name} className="row link" type="button" translate="no" onClick={() => go(join(view.path, e.name))}>📁 {e.name}</button>
          : <button key={e.name} className="row link" type="button" translate="no" disabled={busy} onClick={() => submit(view.path, e.name)}>☕ {e.name}(このサーバーにする)</button>)}
        {view && <button className="row link" type="button" disabled={busy} onClick={() => submit(view.path)}>このフォルダを使う</button>}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// エージェント: 家の中のサーバー機で動かし、外向きにつないでくる小さなプログラム(家のポートは開けない)
function Agents({ onDone }: { onDone: () => void }) {
  const load = useServerFn(listAgents);
  const create = useServerFn(createAgent);
  const remove = useServerFn(removeAgent);
  const add = useServerFn(addAgentServer);
  const [list, setList] = useState<Awaited<ReturnType<typeof listAgents>> | null>(null);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = () => load().then(setList, (e) => setError(message(e)));
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000); // つながったかを見られるように
    return () => clearInterval(t);
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const origin = typeof location === "undefined" ? "" : location.origin;
  return (
    <>
      <div className="gtitle">エージェント(家の中のサーバー)
        <Info>
          <span>エージェントは、家の中のサーバー機から CraftShelf へ外向きにつなぐので、家のポートを開けずに使えます。CraftShelf から操作できるのは、エージェントの設定ファイルに書いたサーバーのフォルダと、そこに書いた起動・停止の方法だけです。詳しくは <a href="https://github.com/mesamaru/craftshelf/blob/dev/docs/AGENT.md" target="_blank" rel="noopener noreferrer">エージェントの使い方</a>。</span>
        </Info>
      </div>
      {list?.map((a) => (
        <section className="group" key={a.id}>
          <div className="row">
            <span className="mid"><span className="ttl" translate="no">{a.name}</span>
              <span className="sub">{a.online ? "つながっています" : a.lastSeenAt ? `最後につながった日時 ${new Date(a.lastSeenAt).toLocaleString("ja-JP")}` : "まだつながっていません"}{a.version ? ` · v${a.version}` : ""} · トークン …{a.tokenHint}</span>
            </span>
            <Btn kind="red" sm disabled={busy}
              onClick={async () => (await confirmDialog({ message: `エージェント「${a.name}」を消しますか?(このエージェントのサーバーも一覧から外れます。家のサーバーのファイルは消えません)`, ok: "消す", danger: true })) && run(() => remove({ data: { id: a.id } }))}>消す</Btn>
          </div>
          {a.servers.map((s) => (
            <div className="row" key={s.key}>
              <span className="mid"><span className="ttl" translate="no">{s.name}</span><span className="sub" translate="no">{s.key}{s.platform ? ` · ${s.platform}${s.mcVersion ? ` ${s.mcVersion}` : ""}` : ""}</span></span>
              {s.added ? <span className="muted small">追加済み</span>
                : <Btn kind="tint" sm disabled={busy} onClick={() => run(() => add({ data: { agentId: a.id, key: s.key } }))}>追加</Btn>}
            </div>
          ))}
          {a.servers.length === 0 && <div className="row muted small">エージェントがつながると、設定ファイルに書いたサーバーがここに出ます。</div>}
        </section>
      ))}
      {made ? (
        <section className="group">
          <p className="row" role="status">エージェントを登録しました。トークンはいまだけ表示します。</p>
          <pre className="row log" translate="no">{JSON.stringify({ url: origin, token: made.token, servers: [{ key: "lobby", name: "ロビー", root: "/srv/minecraft/lobby", control: "none" }] }, null, 2)}</pre>
          <p className="row muted small">家のサーバー機で、上の内容を craftshelf-agent.json として保存し(servers は自分のサーバーに合わせて書き換える)、Node.js 22 以上で次のように動かします。</p>
          <pre className="row log" translate="no">{`curl -O ${origin}/agent/craftshelf-agent.mjs\nnode craftshelf-agent.mjs craftshelf-agent.json`}</pre>
          <button className="row link" type="button" onClick={() => setMade(null)}>閉じる</button>
        </section>
      ) : (
        <form className="cmd" onSubmit={(e) => { e.preventDefault(); run(async () => { setMade(await create({ data: { name } })); setName(""); }); }}>
          <input className="input" placeholder="エージェントの名前(例 家のサーバー機)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button className="btn pri sm" type="submit" disabled={busy || !name.trim()}>登録</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
