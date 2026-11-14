// サーバーの詳細の「ファイル」「コンソール」タブ: 設定ファイルを直す(履歴から戻せる)・最近のログ・コマンドを送る
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { extractCancel, extractPlan, extractStart, extractState, fileHistory, listFiles, readServerFile, saveServerFile, sendCommand, serverLogs } from "./files-api";
import { looksLikeArchive } from "./archive";
import { fmtSize } from "./format";
import { confirmSyntax, syntaxError } from "./syntax";
import { Btn, Info, Seg, Sheet } from "./ui";
import { confirmDialog } from "~/lib/dialog-queue";

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
  const [unzip, setUnzip] = useState(""); // 展開の確認を開いている圧縮ファイル(サーバーのフォルダからのパス)
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
          <Btn sm onClick={async () => (!changed || (await confirmDialog({ message: "保存していない変更を捨てますか?", ok: "捨てる", danger: true }))) && setOpened(null)}>‹ 戻る</Btn>
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
        <Info>テキストの設定ファイル(.properties・.yml・.json・.toml など、512 KB まで)を開いて直せます。保存する前の中身は履歴に残り、そこから戻せます。圧縮ファイル(.zip・.tar・.tar.gz・.tgz)は「展開」で、安全を確かめてから展開できます。</Info>
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
              {looksLikeArchive(e.name) && <Btn sm kind="tint" disabled={!!busy} onClick={(ev) => { ev.stopPropagation(); setUnzip(path); }}>展開</Btn>}
            </div>
          );
        })}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {unzip && <ExtractSheet id={id} path={unzip} onClose={() => setUnzip("")} onOpen={(dir) => { setUnzip(""); go(dir); }} onDone={() => go(listing?.dir ?? "")} />}
    </>
  );
}

type Plan = Awaited<ReturnType<typeof extractPlan>>;
type JobS = Awaited<ReturnType<typeof extractState>>;
const ENDED = ["done", "failed", "cancelled"];

/** 断る理由・エラーの文。「: 「名前」「名前」」の名前(圧縮ファイルの中の名前。見えない文字は \uXXXX の形で来る)は、英語表示でも訳さない(translate="no") */
function Reason({ text }: { text: string }) {
  const parts = text.split(/(: (?:「[^」]*」)+)/);
  return <>{parts.map((x, i) => (i % 2 ? <span key={i}>{": "}<span translate="no">{x.slice(2)}</span></span> : x))}</>;
}

/**
 * 圧縮ファイルの展開(src/server/extract.ts): 中身を確かめて(読むだけ。ディスクには書かない)、OK のときだけ「展開する」。
 * 展開中は進みと「キャンセル」。失敗・キャンセルのときは何も残らない。展開したものは、変更の履歴(「保存」タブ)から元に戻せる
 */
function ExtractSheet({ id, path, onClose, onOpen, onDone }: { id: string; path: string; onClose: () => void; onOpen: (dir: string) => void; onDone: () => void }) {
  const plan = useServerFn(extractPlan);
  const start = useServerFn(extractStart);
  const state = useServerFn(extractState);
  const cancel = useServerFn(extractCancel);
  const [mode, setMode] = useState<"folder" | "here">("folder");
  const [p, setP] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [job, setJob] = useState<{ id: string; s: JobS | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const name = path.slice(path.lastIndexOf("/") + 1);
  // 展開を始めるまでは、選び方を変えるたびに確かめ直す
  useEffect(() => {
    if (job) return;
    let live = true;
    setP(null);
    setError("");
    plan({ data: { id, path, mode } }).then((r) => live && setP(r), (e) => live && setError(message(e)));
    return () => { live = false; };
  }, [mode, !!job]);
  // 進み
  const phase = job?.s?.phase ?? "";
  useEffect(() => {
    if (!job || ENDED.includes(phase)) return;
    const t = setInterval(() => { state({ data: { id, job: job.id } }).then((s) => setJob((j) => j && { ...j, s }), (e) => setError(message(e))); }, 700);
    return () => clearInterval(t);
  }, [job?.id, phase]);
  useEffect(() => { if (phase === "done") onDone(); }, [phase]);

  const go = async () => {
    if (!p?.ok) return;
    const where = p.dest ? `${p.dest}/` : "/";
    if (!(await confirmDialog({ message: `${name} を ${where} に展開しますか?(${p.files} 個のファイル・${fmtSize(p.bytes)}。展開したものは、「保存」タブの変更の履歴から元に戻せます)`, ok: "展開する" }))) return;
    setBusy(true);
    setError("");
    try {
      const r = await start({ data: { id, path, mode } });
      setJob({ id: r.jobId, s: null });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const s = job?.s;
  const running = !!job && !ENDED.includes(phase);
  const sp = p?.space;
  const ratio = sp?.usable ? Math.min(1, sp.need / sp.usable) : sp?.unknown ? 1 : 0;
  return (
    <Sheet title="圧縮ファイルを展開" onClose={onClose}>
      <section className="group">
        <div className="row"><span className="mid"><span className="ttl" translate="no">{name}</span><span className="sub" translate="no">{p ? `${p.format ?? "?"} · ${fmtSize(p.archiveBytes)}` : path}</span></span></div>
        {!job && <div className="row"><div style={{ flex: 1 }}><Seg label="展開先" value={mode} options={[["folder", "新しいフォルダ(既定)"], ["here", "ここに展開"]] as const} onChange={setMode} /></div></div>}
      </section>
      {!job && !p && !error && <p className="muted" role="status">中身を確かめています…</p>}
      {!job && p && (
        <>
          <section className="group">
            {p.files + p.dirs > 0 && (
              <div className="row"><span className="mid">
                <span className="ttl">{`${p.files} 個のファイル · 合計 ${fmtSize(p.bytes)}`}</span>
                <span className="sub">{`最大 ${fmtSize(p.maxFile)} · 深さ ${p.depth} · 圧縮率 ${p.ratio >= 1 ? `${p.ratio.toFixed(1)} 倍` : "—"}`}</span>
              </span></div>
            )}
            <div className="row"><span className="mid"><span className="ttl">展開先</span><span className="sub" translate="no">{p.dest ? `${p.dest}/` : "/"}</span></span></div>
            {sp && (
              <div className="row"><span className="mid">
                <span className="ttl">展開後の空き容量</span>
                <span className="sub wrap">{sp.unknown ? "空き容量が分からないので展開しません" : sp.unlimited ? `ディスクの上限なし(展開は合計 ${fmtSize(sp.usable ?? 0)} まで)` : `${fmtSize(Math.max(0, sp.after ?? 0))}(予約領域 ${fmtSize(sp.reserve)} を残します。展開に使えるのは ${fmtSize(sp.usable ?? 0)} まで)`}</span>
                <div className="meter" role="img" aria-label="展開に使う量"><i style={{ width: `${Math.round(ratio * 100)}%`, background: ratio >= 1 ? "var(--danger)" : ratio > 0.7 ? "var(--warn)" : undefined }} /></div>
              </span></div>
            )}
            {p.conflictCount > 0 && (
              <div className="row"><span className="mid"><span className="ttl error wrap">同じ名前があります(上書きはしません)</span><span className="sub wrap" translate="no">{p.conflicts.join("、")}{p.conflictCount > p.conflicts.length ? " …" : ""}</span></span></div>
            )}
          </section>
          {p.how === "panel" && <p className="muted">Pterodactyl は、パネル側で展開します。事前の確かめだけが働きます(途中の見張り・キャンセルはできません)。</p>}
          {p.busy && <p className="error" role="alert">このサーバーでは、すでに展開しています。終わるまでお待ちください</p>}
          {p.reasons.map((r, i) => <p key={i} className="error" role="alert"><Reason text={r} /></p>)}
          {p.ok && !p.busy && <p className="muted">{p.how === "panel" ? "確かめは通りました。" : "確かめは通りました。一時フォルダに展開してから置くので、途中で止めても何も残りません。"}</p>}
        </>
      )}
      {job && (
        <section className="group">
          <div className="row"><span className="mid">
            <span className="ttl">{!s || s.phase === "checking" ? "中身を確かめています…" : s.phase === "placing" ? "展開先に置いています…" : s.phase === "extracting" ? (p?.how === "panel" ? "パネルが展開しています…" : "展開しています…") : s.phase === "done" ? `${s.result?.files ?? 0} 個のファイルを展開しました` : s.phase === "cancelled" ? "キャンセルしました" : "展開できませんでした"}</span>
            {s && s.phase !== "failed" && s.phase !== "cancelled" && <span className="sub">{`${fmtSize(s.written)} / ${fmtSize(s.total)} · ${s.files} / ${s.filesTotal}`}</span>}
            {s && !ENDED.includes(s.phase) && <div className="meter"><i style={{ width: `${s.total ? Math.min(100, Math.round((s.written / s.total) * 100)) : 0}%` }} /></div>}
          </span></div>
        </section>
      )}
      {s?.phase === "done" && <p className="muted">展開したものは、「保存」タブの変更の履歴から元に戻せます。元の圧縮ファイルは残してあります。</p>}
      {(s?.phase === "failed" || s?.phase === "cancelled") && <p className="muted">{s.phase === "failed" && p?.how === "panel" ? "作ったものは消しました。パネルで確かめてください。" : "展開先には何も残していません。"}</p>}
      {s?.phase === "failed" && <p className="error" role="alert"><Reason text={s.error} /></p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-foot">
        <span className="grow" />
        {running && !(p?.how === "panel" && phase === "extracting") && <Btn kind="red" onClick={() => cancel({ data: { id, job: job!.id } }).catch((e) => setError(message(e)))}>キャンセル</Btn>}
        {s?.phase === "done" && s.result && <Btn kind="pri" onClick={() => onOpen(s.result!.base)}>展開先を開く</Btn>}
        {!job && <Btn kind="pri" disabled={!p?.ok || !!p?.busy || busy} onClick={go}>{busy ? "始めています…" : "展開する"}</Btn>}
        {job && ENDED.includes(phase) && phase !== "done" && <Btn onClick={onClose}>閉じる</Btn>}
      </div>
    </Sheet>
  );
}
