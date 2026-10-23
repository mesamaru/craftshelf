import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  addConnection, addServers, listConnections, listServers, powerServer, remoteServers, removeConnection, removeServer, serverStatus,
} from "~/lib/servers-api";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/servers")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/servers" } });
    return { user: context.user };
  },
  loader: async () => ({ servers: await listServers(), connections: await listConnections() }),
  component: Servers,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

// チームのサーバー(状態・起動と停止)と、Pterodactyl パネルの登録
function Servers() {
  const { user } = Route.useRouteContext();
  const { servers, connections } = Route.useLoaderData();
  const { can } = useCan(user.id);
  const router = useRouter();
  const reload = () => router.invalidate();

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ 戻る</Link>
        <h1>サーバー</h1>
      </header>

      <section className="group">
        {servers.length === 0 && <div className="row muted">まだサーバーがありません。下で Pterodactyl パネルをつなぐと追加できます。</div>}
        {servers.map((s) => (
          <ServerRow key={s.id} id={s.id} name={s.name} source={s.connection ?? ""}
            control={can({ server: ["control"] })} removable={can({ server: ["delete"] })} onDone={reload} />
        ))}
      </section>

      {(connections.length > 0 || can({ server: ["create"] })) && <div className="group-title">Pterodactyl パネル</div>}
      {connections.map((c) => (
        <Connection key={c.id} {...c} addable={can({ server: ["create"] })} removable={can({ server: ["delete"] })} onDone={reload} />
      ))}
      {can({ server: ["create"] }) && <NewConnection onDone={reload} />}
    </main>
  );
}

type Status = { state: string; cpu: number | null; memory: number | null };
const STATE_LABELS: Record<string, string> = { running: "動いています", starting: "起動中", stopping: "停止中", offline: "止まっています" };

function ServerRow({ id, name, source, control, removable, onDone }:
  { id: string; name: string; source: string; control: boolean; removable: boolean; onDone: () => void }) {
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
      <span className={`dot ${state}`} aria-hidden="true" />
      <span className="main">
        <span translate="no">{name}</span>
        <span className="muted">
          {st ? STATE_LABELS[state] ?? state : "確認中…"}
          {st?.memory != null && ` · メモリ ${(st.memory / 1024 ** 3).toFixed(1)} GB`}
          {source && <> · <span translate="no">{source}</span></>}
        </span>
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
