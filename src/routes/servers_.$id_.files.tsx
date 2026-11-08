import { useEffect, useRef, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { fileHistory, filesAccess, listFiles, readServerFile, saveServerFile, sendCommand, serverLogs } from "~/lib/files-api";
import { confirmSyntax } from "~/lib/syntax";
import { serverDetail } from "~/lib/library-api";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/servers_/$id_/files")({
  beforeLoad: ({ context, params }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: `/servers/${params.id}/files` } });
    return { user: context.user };
  },
  loader: ({ params }) => serverDetail({ data: { id: params.id } }),
  component: FilesPage,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

// サーバーの操作: コンソールへのコマンド・設定ファイルの編集(履歴から戻せる)
function FilesPage() {
  const { user } = Route.useRouteContext();
  const server = Route.useLoaderData();
  const { can, me } = useCan(user.id);
  const access = useServerFn(filesAccess);
  const [files, setFiles] = useState<boolean | null>(null);
  useEffect(() => { access().then((a) => setFiles(a.allowed), () => setFiles(false)); }, []);
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/servers/$id" params={{ id: server.id }} className="capsule">‹ <span translate="no">{server.name}</span></Link>
        <h1>ファイルとコマンド</h1>
      </header>
      {me && can({ server: ["control"] }) && <Logs id={server.id} local={server.kind === "local"} />}
      {me && can({ server: ["control"] }) && <Command id={server.id} />}
      {files !== null && (files ? <Files id={server.id} />
        : <section className="group"><div className="row muted">設定ファイルを見る・直すのは、チームの管理者とオーナーだけです(チームの設定で、編集者にも許せます)。</div></section>)}
    </main>
  );
}

// 最近のログ。「自動で読み直す」のあいだは、Pterodactyl は 15 秒・フォルダのサーバーは 4 秒ごとに読み直す
function Logs({ id, local }: { id: string; local: boolean }) {
  const load = useServerFn(serverLogs);
  const [data, setData] = useState<Awaited<ReturnType<typeof serverLogs>> | null>(null);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const reload = () => load({ data: { id } }).then((d) => { setData(d); setError(""); }, (e) => setError(message(e)));
  useEffect(() => {
    reload();
    if (!follow) return;
    const t = setInterval(() => { if (!document.hidden) reload(); }, local ? 4000 : 15000);
    return () => clearInterval(t);
  }, [id, follow]);
  useEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [data, follow]);
  const q = filter.trim().toLowerCase();
  const lines = (data?.lines ?? []).filter((l) => !q || l.toLowerCase().includes(q));
  return (
    <>
      <div className="group-title">最近のログ <span className="muted small" translate="no">{data?.file ?? "logs/latest.log"}</span></div>
      <section className="group form">
        <div className="row">
          <input className="main" placeholder="絞り込み(例 ERROR)" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="ログの絞り込み" />
          <label className="trail small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 自動で読み直す</label>
          <button className="trail link" type="button" onClick={reload}>読み直す</button>
        </div>
        <pre className="row log" ref={box} translate="no" tabIndex={0}>
          {error ? <span className="err">{error}</span>
            : !data ? <span className="muted">読み込み中…</span>
            : !data.found ? <span className="muted">ログのファイルが見つかりません。サーバーを一度起動すると作られます。</span>
            : lines.length === 0 ? <span className="muted">{q ? "一致する行はありません" : "ログはまだありません"}</span>
            : lines.map((l, i) => <span key={i} className={/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(l) ? "err" : /\bWARN(ING)?\b/.test(l) ? "warn" : ""}>{l + "\n"}</span>)}
        </pre>
      </section>
    </>
  );
}

function Command({ id }: { id: string }) {
  const send = useServerFn(sendCommand);
  const [cmd, setCmd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await send({ data: { id, command: cmd } });
      setNote(`送りました: ${cmd}`);
      setCmd("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="group-title">コマンドを送る</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row codes" placeholder="例 say こんにちは(先頭の / は要りません)" value={cmd} maxLength={500} onChange={(e) => setCmd(e.target.value)} aria-label="コマンド" />
        <button className="row link" type="submit" disabled={busy || !cmd.trim()}>{busy ? "送っています…" : "送る"}</button>
        {note && <p className="row muted" role="status" translate="no">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
      <p className="foot">サーバーが動いているときだけ送れます。結果は上のログに出ます(少し遅れて読み直します)。</p>
    </>
  );
}

type Listing = Awaited<ReturnType<typeof listFiles>>;
type Opened = Awaited<ReturnType<typeof readServerFile>>;

function Files({ id }: { id: string }) {
  const list = useServerFn(listFiles);
  const read = useServerFn(readServerFile);
  const save = useServerFn(saveServerFile);
  const history = useServerFn(fileHistory);
  const [listing, setListing] = useState<Listing | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const go = (dir: string) => run("list", async () => { setListing(await list({ data: { id, dir } })); });
  const open = (path: string) => run("open", async () => { const f = await read({ data: { id, path } }); setOpened(f); setText(f.content); });
  useEffect(() => { go(""); }, [id]);

  if (opened) {
    const changed = text !== opened.content;
    return (
      <>
        <div className="group-title" translate="no">{opened.path}</div>
        <section className="group form">
          <textarea className="row codes editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`${opened.path} の中身`} />
          <div className="row actions">
            <button className="link" type="button" disabled={!!busy || !changed}
              onClick={() => run("save", async () => {
                if (!(await confirmSyntax(opened.path, text))) return;
                await save({ data: { id, path: opened.path, content: text, base: opened.content } });
                const f = await read({ data: { id, path: opened.path } }); // 履歴と、保存した中身を読み直す
                setOpened(f);
                setText(f.content);
                setNote("保存しました(サーバーの再起動で反映されます)");
              })}>
              {busy === "save" ? "保存しています…" : "保存"}
            </button>
            <button className="link" type="button" disabled={!!busy || !changed} onClick={() => setText(opened.content)}>元に戻す</button>
            <button className="trail link" type="button" disabled={!!busy} onClick={() => (!changed || confirm("保存していない変更を捨てますか?")) && setOpened(null)}>閉じる</button>
          </div>
          {note && <p className="row muted" role="status">{note}</p>}
          {error && <p className="row error" role="alert">{error}</p>}
        </section>
        <div className="group-title">保存する前の中身(新しい順)</div>
        <section className="group">
          {opened.history.length === 0 && <div className="row muted">まだありません。ここで保存すると、保存する前の中身が残ります。</div>}
          {opened.history.map((h) => (
            <div className="row" key={h.id}>
              <span className="main">
                <span>{new Date(h.savedAt).toLocaleString("ja-JP")}</span>
                <span className="muted" translate="no">{h.savedBy}</span>
              </span>
              <button className="trail link" type="button" disabled={!!busy}
                onClick={() => run("hist", async () => { const r = await history({ data: { id, historyId: h.id } }); setText(r.content); setNote("この時点の中身を読み込みました。よければ「保存」を押してください"); })}>
                この中身にする
              </button>
            </div>
          ))}
        </section>
      </>
    );
  }

  const parts = listing?.dir ? listing.dir.split("/") : [];
  return (
    <>
      <div className="group-title">設定ファイル</div>
      <section className="group">
        <div className="row actions" translate="no">
          <button className="link" type="button" onClick={() => go("")}>/</button>
          {parts.map((p, i) => <button key={i} className="link" type="button" onClick={() => go(parts.slice(0, i + 1).join("/"))}>{p}/</button>)}
        </div>
        {!listing && !error && <div className="row muted">読み込んでいます…</div>}
        {listing?.entries.length === 0 && <div className="row muted">空のフォルダーです。</div>}
        {listing?.entries.map((e) => {
          const path = [listing.dir, e.name].filter(Boolean).join("/");
          if (!e.isFile) return <button key={e.name} className="row link" type="button" onClick={() => go(path)} translate="no">📁 {e.name}</button>;
          return e.editable
            ? <button key={e.name} className="row link" type="button" onClick={() => open(path)} translate="no">{e.name}</button>
            : <div key={e.name} className="row muted" translate="no">{e.name}</div>;
        })}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">テキストの設定ファイル(.properties・.yml・.json・.toml など、512 KB まで)を開いて直せます。保存する前の中身は履歴に残り、そこから戻せます。</p>
    </>
  );
}
