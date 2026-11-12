// サーバーの詳細の「ファイル」「コンソール」タブ: 設定ファイルを直す(履歴から戻せる)・最近のログ・コマンドを送る
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { fileHistory, listFiles, readServerFile, saveServerFile, sendCommand, serverLogs } from "./files-api";
import { confirmSyntax, syntaxError } from "./syntax";
import { Btn, Info, Sheet } from "./ui";

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

/** 最近のログとコマンド。「自動で読み直す」のあいだは、Pterodactyl は 15 秒・フォルダのサーバーは 4 秒ごとに読み直す */
export function Console({ id, local }: { id: string; local: boolean }) {
  const load = useServerFn(serverLogs);
  const send = useServerFn(sendCommand);
  const [data, setData] = useState<Awaited<ReturnType<typeof serverLogs>> | null>(null);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
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
  const submit = async () => {
    setBusy(true);
    setSendError("");
    setNote("");
    try {
      await send({ data: { id, command: cmd } });
      setNote(`送りました: ${cmd}`);
      setCmd("");
      setTimeout(reload, 1500);
    } catch (e) {
      setSendError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const q = filter.trim().toLowerCase();
  const lines = (data?.lines ?? []).filter((l) => !q || l.toLowerCase().includes(q));
  return (
    <>
      <div className="cmd">
        <input className="input" type="search" placeholder="絞り込み(例 ERROR)" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="ログの絞り込み" />
        <label className="small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 自動で読み直す</label>
        <Btn sm onClick={reload}>読み直す</Btn>
      </div>
      <pre className="console" ref={box} tabIndex={0} aria-label={data?.file ?? "logs/latest.log"}>
        {error ? <span className="err">{error}</span>
          : !data ? <span className="muted">読み込み中…</span>
          : !data.found ? <span className="muted">ログのファイルが見つかりません。サーバーを一度起動すると作られます。</span>
          : lines.length === 0 ? <span className="muted">{q ? "一致する行はありません" : "ログはまだありません"}</span>
          : lines.map((l, i) => <span key={i} translate="no" className={/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(l) ? "err" : /\bWARN(ING)?\b/.test(l) ? "warn" : ""}>{l + "\n"}</span>)}
      </pre>
      <form className="cmd" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="input" placeholder="例 say こんにちは(先頭の / は要りません)" value={cmd} maxLength={500} onChange={(e) => setCmd(e.target.value)} aria-label="コマンド" />
        <button className="btn pri" type="submit" disabled={busy || !cmd.trim()}>{busy ? "送っています…" : "送る"}</button>
        <Info>サーバーが動いているときだけ送れます。結果は上のログに出ます(少し遅れて読み直します)。</Info>
      </form>
      {note && <p className="muted" role="status" translate="no">{note}</p>}
      {sendError && <p className="error" role="alert">{sendError}</p>}
    </>
  );
}

// 外したアドオン(.craftshelf-removed)・戻す前のワールド(.craftshelf-before-restore-…)は、消さずに名前を変えて残したもの
const ASIDE = /\.craftshelf-(removed|before-restore-.*)$/;
const Aside = () => <span className="tag" title="CraftShelf が、外したり戻したりするときに、消さずに名前を変えて残したものです。「変更の履歴」から元に戻せます。要らなければ消しても構いません。">退避</span>;

type Listing = Awaited<ReturnType<typeof listFiles>>;
type Opened = Awaited<ReturnType<typeof readServerFile>>;

/** 設定ファイル: フォルダをたどって開き、広く直す(保存の前に書き方を確かめる。保存する前の中身は履歴に残る) */
export function Files({ id }: { id: string }) {
  const list = useServerFn(listFiles);
  const read = useServerFn(readServerFile);
  const save = useServerFn(saveServerFile);
  const history = useServerFn(fileHistory);
  const [listing, setListing] = useState<Listing | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [text, setText] = useState("");
  const [hist, setHist] = useState(false);
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
        <div className="cmd">
          <Btn sm onClick={() => (!changed || confirm("保存していない変更を捨てますか?")) && setOpened(null)}>‹ 戻る</Btn>
          <span className="path grow" translate="no">{opened.path}</span>
        </div>
        <textarea className="codes editor wide" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`${opened.path} の中身`} />
        <div className="cmd">
          <Btn sm disabled={!!busy} onClick={() => run("check", async () => { const e = await syntaxError(opened.path, text); if (e) throw new Error(e); setNote("書き方に問題はありません"); })}>書き方を確かめる</Btn>
          <Btn sm disabled={!!busy} onClick={() => setHist(true)}>{`履歴(${opened.history.length})`}</Btn>
          <Link to="/compare/files" className="btn sm">ファイル比較</Link>
          <span className="grow" />
          <Btn sm disabled={!!busy || !changed} onClick={() => setText(opened.content)}>元に戻す</Btn>
          <Btn kind="pri" sm disabled={!!busy || !changed}
            onClick={() => run("save", async () => {
              if (!(await confirmSyntax(opened.path, text))) return;
              await save({ data: { id, path: opened.path, content: text, base: opened.content } });
              const f = await read({ data: { id, path: opened.path } }); // 履歴と、保存した中身を読み直す
              setOpened(f);
              setText(f.content);
              setNote("保存しました(サーバーの再起動で反映されます)");
            })}>
            {busy === "save" ? "保存しています…" : "保存"}
          </Btn>
        </div>
        {note && <p className="muted" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {hist && (
          <Sheet title="保存する前の中身(新しい順)" onClose={() => setHist(false)}>
            <section className="group">
              {opened.history.length === 0 && <div className="row muted">まだありません。ここで保存すると、保存する前の中身が残ります。</div>}
              {opened.history.map((h) => (
                <div className="row" key={h.id}>
                  <span className="mid">
                    <span className="ttl">{new Date(h.savedAt).toLocaleString("ja-JP")}</span>
                    <span className="sub" translate="no">{h.savedBy}</span>
                  </span>
                  <Btn sm disabled={!!busy}
                    onClick={() => run("hist", async () => { const r = await history({ data: { id, historyId: h.id } }); setText(r.content); setHist(false); setNote("この時点の中身を読み込みました。よければ「保存」を押してください"); })}>
                    この中身にする
                  </Btn>
                </div>
              ))}
            </section>
          </Sheet>
        )}
      </>
    );
  }

  const parts = listing?.dir ? listing.dir.split("/") : [];
  return (
    <>
      <div className="chips">
        <button className="chip" type="button" translate="no" onClick={() => go("")}>/</button>
        {parts.map((p, i) => <button key={i} className="chip" type="button" translate="no" onClick={() => go(parts.slice(0, i + 1).join("/"))}>{p}/</button>)}
        <Info>テキストの設定ファイル(.properties・.yml・.json・.toml など、512 KB まで)を開いて直せます。保存する前の中身は履歴に残り、そこから戻せます。</Info>
      </div>
      <section className="group">
        {!listing && !error && <div className="row muted">読み込んでいます…</div>}
        {listing?.entries.length === 0 && <div className="row muted">空のフォルダーです。</div>}
        {listing?.entries.map((e) => {
          const path = [listing.dir, e.name].filter(Boolean).join("/");
          const aside = ASIDE.test(e.name); // 外した・戻す前に退避したもの(消さずに名前を変えて残している)
          if (!e.isFile) {
            return (
              <button key={e.name} className={`row click${aside ? " aside" : ""}`} type="button" onClick={() => go(path)}>
                <span aria-hidden="true">📁</span><span className="mid"><span className={aside ? "ttl wrapname" : "ttl"} translate="no">{e.name}</span></span>{aside && <Aside />}<span className="chev">›</span>
              </button>
            );
          }
          return (
            <div key={e.name} className={`row${e.editable ? " click" : ""}${aside ? " aside" : ""}`} onClick={e.editable ? () => open(path) : undefined}>
              <span aria-hidden="true">📄</span>
              <span className="mid"><span className={`${e.editable ? "ttl" : "ttl muted"}${aside ? " wrapname" : ""}`} translate="no">{e.name}</span></span>
              {aside && <Aside />}
              {e.editable && <Btn sm disabled={!!busy} onClick={(ev) => { ev.stopPropagation(); open(path); }}>開く</Btn>}
            </div>
          );
        })}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
