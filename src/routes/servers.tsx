import { useEffect, useRef, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  addConnection, addLocalServer, addServers, browseHost, listConnections, listServers, localEnabled, powerServer, remoteServers, removeConnection, removeServer, serverStatus,
} from "~/lib/servers-api";
import { useCan } from "~/lib/use-can";
import { ApplyResults } from "~/lib/apply-results";
import { updateServers } from "~/lib/sets-api";
import { addAgentServer, createAgent, listAgents, removeAgent } from "~/lib/agents-api";

export const Route = createFileRoute("/servers")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/servers" } });
    return { user: context.user };
  },
  loader: async () => ({ servers: await listServers(), connections: await listConnections(), local: await localEnabled() }),
  component: Servers,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

// チームのサーバー(状態・起動と停止)と、Pterodactyl パネルの登録
function Servers() {
  const { user } = Route.useRouteContext();
  const { servers, connections, local } = Route.useLoaderData();
  const { can } = useCan(user.id);
  const router = useRouter();
  const reload = () => router.invalidate();
  const edit = can({ library: ["edit"] });
  const [picked, setPicked] = useState<Set<string>>(new Set());

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ 戻る</Link>
        <h1>サーバー</h1>
        <Link to="/software" className="capsule">本体</Link>
        <Link to="/compare" className="capsule">比較</Link>
        <Link to="/ports" className="capsule">ポート</Link>
        <Link to="/jobs" className="capsule">処理</Link>
      </header>

      <section className="group">
        {servers.length === 0 && <div className="row muted">まだサーバーがありません。下で Pterodactyl パネルをつなぐと追加できます。</div>}
        {servers.map((s) => (
          <ServerRow key={s.id} id={s.id} name={s.name} source={s.connection ?? ""}
            control={can({ server: ["control"] })} removable={can({ server: ["delete"] })} onDone={reload}
            picked={edit ? picked.has(s.id) : null} onPick={(on) => setPicked((p) => { const n = new Set(p); if (on) n.add(s.id); else n.delete(s.id); return n; })} />
        ))}
      </section>
      {edit && servers.length > 0 && <UpdateAll ids={[...picked]} all={servers.length} onPickAll={(on) => setPicked(on ? new Set(servers.map((s) => s.id)) : new Set())} />}

      {(connections.length > 0 || can({ server: ["create"] })) && <div className="group-title">Pterodactyl パネル</div>}
      {connections.map((c) => (
        <Connection key={c.id} {...c} addable={can({ server: ["create"] })} removable={can({ server: ["delete"] })} onDone={reload} />
      ))}
      {can({ server: ["create"] }) && <NewConnection onDone={reload} />}
      {local && can({ server: ["create"] }) && <NewLocal onDone={reload} />}
      {can({ server: ["create"] }) && <Agents onDone={reload} />}
    </main>
  );
}

type Status = { state: string; cpu: number | null; memory: number | null; ping: { online: number; max: number; latency: number; sample: string[] } | null };
const STATE_LABELS: Record<string, string> = { running: "動いています", starting: "起動中", stopping: "停止中", offline: "止まっています" };

// サーバーの一覧の「すべて最新にする」(v02): 選んだ(選んでいなければすべての)サーバーの Mod・プラグインを新しい版にする
function UpdateAll({ ids, all, onPickAll }: { ids: string[]; all: number; onPickAll: (on: boolean) => void }) {
  const run = useServerFn(updateServers);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof updateServers>> | null>(null);
  const [error, setError] = useState("");
  const go = async () => {
    if (!confirm(ids.length ? `選んだ ${ids.length} 台の Mod・プラグインを最新にしますか?` : `すべてのサーバー(${all} 台)の Mod・プラグインを最新にしますか?`)) return;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      setResults(await run({ data: { ids } }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="group">
        <button className="row link" type="button" disabled={busy} onClick={() => onPickAll(ids.length < all)}>{ids.length < all ? "すべて選ぶ" : "選ぶのをやめる"}</button>
        <button className="row link" type="button" disabled={busy} onClick={go}>
          {busy ? "最新にしています…" : ids.length ? `選んだ ${ids.length} 台を最新にする` : "すべてのサーバーを最新にする"}
        </button>
        {results?.map((r) => (r.error
          ? <p className="row error" key={r.serverId}><span translate="no">{r.server}</span>: {r.error}</p>
          : <ApplyResults key={r.serverId} server={r.server} verb="最新にした" list={r.results} empty="新しい版はありませんでした。" />))}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">このアプリで入れた Mod・プラグインに新しい版があれば入れます。「更新を止める」にしたもの・無効にしたもの・種類を決めていないサーバーは変えません。変更はサーバーの再起動で反映されます。</p>
    </>
  );
}

function ServerRow({ id, name, source, control, removable, onDone, picked, onPick }:
  { id: string; name: string; source: string; control: boolean; removable: boolean; onDone: () => void; picked: boolean | null; onPick: (on: boolean) => void }) {
  const status = useServerFn(serverStatus);
  const power = useServerFn(powerServer);
  const remove = useServerFn(removeServer);
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => status({ data: { id } }).then((s) => { setSt(s); setError(""); }, (e) => setError(message(e)));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [id]);

  const send = async (signal: "start" | "stop" | "restart") => {
    setBusy(true);
    try {
      await power({ data: { id, signal } });
      setTimeout(refresh, 1500);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const drop = async () => {
    if (!confirm(`${name} を一覧から外しますか?(Pterodactyl のサーバーは消えません)`)) return;
    try {
      await remove({ data: { id } });
      onDone();
    } catch (e) {
      setError(message(e));
    }
  };

  const state = st?.state ?? "unknown";
  return (
    <div className="row server">
      {picked !== null && <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`${name} を選ぶ`} />}
      <span className={`dot ${state}`} aria-hidden="true" />
      <span className="main">
        <Link to="/servers/$id" params={{ id }} className="name" translate="no">{name}</Link>
        <span className="muted">
          {st ? STATE_LABELS[state] ?? state : "確認中…"}
          {st?.ping && ` · ${st.ping.online} / ${st.ping.max} 人 · ${st.ping.latency} ms`}
          {st?.memory != null && ` · メモリ ${(st.memory / 1024 ** 3).toFixed(1)} GB`}
          {source && <> · <span translate="no">{source}</span></>}
        </span>
        {st?.ping && st.ping.sample.length > 0 && <span className="muted small" translate="no">{st.ping.sample.join("、")}{st.ping.online > st.ping.sample.length ? " …" : ""}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </span>
      {control && (
        <span className="trail actions">
          {state === "offline" ? (
            <button className="link" type="button" disabled={busy} onClick={() => send("start")}>起動</button>
          ) : (
            <>
              <button className="link" type="button" disabled={busy} onClick={() => send("restart")}>再起動</button>
              <button className="link danger" type="button" disabled={busy} onClick={() => send("stop")}>停止</button>
            </>
          )}
        </span>
      )}
      {removable && <button className="link danger" type="button" onClick={drop} aria-label="一覧から外す">外す</button>}
    </div>
  );
}

function Connection({ id, name, url, apiKeyHint, addable, removable, onDone }:
  { id: string; name: string; url: string; apiKeyHint: string; addable: boolean; removable: boolean; onDone: () => void }) {
  const remove = useServerFn(removeConnection);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const drop = async () => {
    if (!confirm(`${name} の登録を消しますか?このパネルから追加したサーバーも一覧から外れます。`)) return;
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
        <span className="main">
          <span translate="no">{name}</span>
          <span className="muted" translate="no">{url} · キー {apiKeyHint}</span>
        </span>
        {removable && <button className="trail link danger" type="button" onClick={drop}>登録を消す</button>}
      </div>
      {addable && !open && <button className="row link" type="button" onClick={() => setOpen(true)}>このパネルのサーバーを追加</button>}
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
          <input type="checkbox" disabled={s.added} checked={s.added || picked.has(s.identifier)} onChange={() => toggle(s.identifier)} />
          <span className="main">
            <span translate="no">{s.name}</span>
            <span className="muted" translate="no">{s.node}{s.added ? "(追加済み)" : ""}</span>
          </span>
        </label>
      ))}
      {items && items.length > 0 && (
        <div className="row">
          <button className="capsule primary" type="button" onClick={submit} disabled={picked.size === 0}>選んだサーバーを追加</button>
          <button className="capsule" type="button" onClick={onDone}>やめる</button>
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
    <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
      <p className="row muted">
        パネルの「アカウント → API 認証情報」で作った Client API キー(ptlc_…)を使います。キーは暗号化して保存し、画面には最後の 4 文字だけを出します。
      </p>
      <input className="row" placeholder="名前(例 いつものホスティング)" translate="no" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="row" placeholder="パネルの URL(https://…)" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
      <input className="row" type="password" autoComplete="off" placeholder="Client API キー(ptlc_…)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
      {error && <p className="row error" role="alert">{error}</p>}
      <button className="capsule primary" disabled={busy || !url || !apiKey}>{busy ? "確かめています…" : "パネルをつなぐ"}</button>
    </form>
  );
}

// フォルダのサーバーを追加(自分用の版だけ): パネルから見えるフォルダをたどり、サーバーの jar か、フォルダを選ぶ
function NewLocal({ onDone }: { onDone: () => void }) {
  const browse = useServerFn(browseHost);
  const add = useServerFn(addLocalServer);
  const [open, setOpen] = useState(false);
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
  const submit = async (rootDir: string, jar?: string) => {
    setBusy(true);
    setError("");
    try {
      await add({ data: { rootDir, name, ...(jar ? { jar } : {}) } });
      setOpen(false);
      setView(null);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const join = (a: string, b: string) => (a.endsWith("/") || a.endsWith("\\") ? a + b : `${a}/${b}`);

  if (!open) {
    return (
      <>
        <div className="group-title">フォルダのサーバー</div>
        <section className="group"><button className="row link" type="button" onClick={() => { setOpen(true); go(path); }}>フォルダのサーバーを追加</button></section>
        <p className="foot">パネルから見えるフォルダ(同じ PC・NAS・Docker でマウントしたフォルダ)にあるサーバーを、Pterodactyl を通さずに管理します。</p>
      </>
    );
  }
  return (
    <>
      <div className="group-title">フォルダのサーバーを追加</div>
      <section className="group form">
        <input className="row" placeholder="名前(空ならフォルダの名前)" translate="no" value={name} onChange={(e) => setName(e.target.value)} />
        <form className="row" onSubmit={(e) => (e.preventDefault(), go(path))}>
          <input className="main codes" value={path} onChange={(e) => { latest.current++; setPath(e.target.value); }} aria-label="フォルダの場所" />
          <button className="trail link" type="submit">開く</button>
        </form>
        {view?.parent && <button className="row link" type="button" onClick={() => go(view.parent!)}>‹ 上のフォルダ</button>}
        {view?.entries.map((e) => e.isDir
          ? <button key={e.name} className="row link" type="button" translate="no" onClick={() => go(join(view.path, e.name))}>📁 {e.name}</button>
          : <button key={e.name} className="row link" type="button" translate="no" disabled={busy} onClick={() => submit(view.path, e.name)}>☕ {e.name}(このサーバーにする)</button>)}
        {view && <button className="row link" type="button" disabled={busy} onClick={() => submit(view.path)}>このフォルダを使う</button>}
        {error && <p className="row error" role="alert">{error}</p>}
        <button className="row link" type="button" onClick={() => setOpen(false)}>やめる</button>
      </section>
      <p className="foot">サーバーの jar(例 paper-1.21.4.jar)を選ぶと、そのフォルダをサーバーにして、名前から種類と Minecraft のバージョンを決めます。Docker で動かしている場合は、サーバーのフォルダをパネルのコンテナにマウントしてください。</p>
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
      <div className="group-title">エージェント(家の中のサーバー)</div>
      {list?.map((a) => (
        <section className="group" key={a.id}>
          <div className="row">
            <span className="main"><span translate="no">{a.name}</span>
              <span className="muted small">{a.online ? "つながっています" : a.lastSeenAt ? `最後につながった日時 ${new Date(a.lastSeenAt).toLocaleString("ja-JP")}` : "まだつながっていません"}{a.version ? ` · v${a.version}` : ""} · トークン …{a.tokenHint}</span>
            </span>
            <button className="trail link danger" type="button" disabled={busy}
              onClick={() => confirm(`エージェント「${a.name}」を消しますか?(このエージェントのサーバーも一覧から外れます。家のサーバーのファイルは消えません)`) && run(() => remove({ data: { id: a.id } }))}>消す</button>
          </div>
          {a.servers.map((s) => (
            <div className="row" key={s.key}>
              <span className="main"><span translate="no">{s.name}</span><span className="muted small" translate="no">{s.key}{s.platform ? ` · ${s.platform}${s.mcVersion ? ` ${s.mcVersion}` : ""}` : ""}</span></span>
              {s.added ? <span className="trail muted small">追加済み</span>
                : <button className="trail link" type="button" disabled={busy} onClick={() => run(() => add({ data: { agentId: a.id, key: s.key } }))}>追加</button>}
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
        <form className="group form" onSubmit={(e) => { e.preventDefault(); run(async () => { setMade(await create({ data: { name } })); setName(""); }); }}>
          <input className="row" placeholder="エージェントの名前(例 家のサーバー機)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <button className="row link" type="submit" disabled={busy || !name.trim()}>エージェントを登録</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="foot">エージェントは、家の中のサーバー機から CraftShelf へ外向きにつなぐので、家のポートを開けずに使えます。CraftShelf から操作できるのは、エージェントの設定ファイルに書いたサーバーのフォルダと、そこに書いた起動・停止の方法だけです。詳しくは <a href="https://github.com/mesamaru/craftshelf/blob/dev/docs/AGENT.md" target="_blank" rel="noopener noreferrer">エージェントの使い方</a>。</p>
    </>
  );
}
