import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Btn, Chip, ChipBar, Info, Tabs } from "~/lib/ui";
import { alignAll, splitLines, takeBase } from "~/lib/diff";
import { configFiles, readServerFile, saveServerFile } from "~/lib/files-api";
import { sharedServers } from "~/lib/servers-api";
import { confirmSyntax } from "~/lib/syntax";

export const Route = createFileRoute("/compare_/files")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/compare/files" } });
    return { user: context.user };
  },
  loader: () => sharedServers(),
  component: FileCompare,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
type List = Awaited<ReturnType<typeof configFiles>>;
type Opened = { path: string; servers: { id: string; name: string; content: string | null; error: string }[] };

// サーバーの設定ファイルを並べて見比べる(v02 のファイル比較)。基準(左)の中身を、ほかのサーバーへ写せる
function FileCompare() {
  const servers = Route.useLoaderData();
  const load = useServerFn(configFiles);
  const read = useServerFn(readServerFile);
  const save = useServerFn(saveServerFile);
  const [sel, setSel] = useState<string[]>([]);
  const [list, setList] = useState<List | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [view, setView] = useState<View>({ mode: "tree", showSame: true, open: new Set() });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => {
    setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
    setList(null);
    setOpened(null);
  };
  const open = (path: string) => run(async () => {
    const names = new Map(list!.servers.map((s) => [s.id, s.name]));
    const got = await Promise.all(sel.map(async (id) => {
      if (!list!.files.find((f) => f.path === path)?.on.includes(id)) return { id, name: names.get(id) ?? "", content: null, error: "" };
      try {
        return { id, name: names.get(id) ?? "", content: (await read({ data: { id, path } })).content, error: "" };
      } catch (e) {
        return { id, name: names.get(id) ?? "", content: null, error: message(e) };
      }
    }));
    setOpened({ path, servers: got });
  });

  return (
    <main className="page fill wide">
      <header className="bar">
        <h1>比較<Info>比べるサーバーを 2 台以上選んでください(8 台まで)。設定ファイル(server.properties・plugins・config の中など)を並べて見比べ、左のサーバーの中身をほかのサーバーへ写せます。見る・直すのは管理者以上です(チームの設定で、編集者にも許せます)。</Info></h1>
      </header>
      <Tabs value="files" options={[["addons", "アドオン"], ["files", "ファイル"]] as const} label="比較" onChange={(v) => v === "addons" && navigate({ to: "/compare" })} />
      <ChipBar label="比べるサーバー">
        {servers.map((s) => <Chip key={s.id} on={sel.includes(s.id)} translate="no" onClick={() => toggle(s.id)}>{s.name}</Chip>)}
      </ChipBar>
      {sel.length < 2 && <section className="group"><div className="row muted">比べるサーバーを 2 台以上選んでください</div></section>}
      {sel.length >= 2 && !list && (
        <section className="group spaced">
          <button className="row link" type="button" disabled={busy} onClick={() => run(async () => setList(await load({ data: { ids: sel } })))}>
            {busy ? "設定ファイルを集めています…" : "設定ファイルを集める"}
          </button>
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {list && !opened && <FileList list={list} view={view} setView={setView} busy={busy} onOpen={(p) => { setNote(""); open(p); }} />}
      {opened && (
        <Compare opened={opened} onlyDiff={onlyDiff} setOnlyDiff={setOnlyDiff} busy={busy} note={note} onBack={() => setOpened(null)}
          onSave={(to, content) => run(async () => {
            const target = opened.servers.find((s) => s.id === to)!;
            if (target.content === null || !(await confirmSyntax(opened.path, content))) return;
            await save({ data: { id: to, path: opened.path, content, base: target.content } });
            setNote(`「${target.name}」の ${opened.path} を保存しました。反映にはサーバーの再起動が要ります`);
            await open(opened.path);
          })} />
      )}
    </main>
  );
}

type View = { mode: "list" | "tree"; showSame: boolean; open: Set<string> };
type File = List["files"][number];
type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: (File & { name: string })[] };

// 違いがあるか(無いサーバーがある・中身が違う)
const changed = (f: File, total: number) => f.on.length < total || !f.same;
const kb = (n: number) => `${n < 1024 ? n : (n / 1024).toFixed(1)} ${n < 1024 ? "B" : "KB"}`;
function treeOf(files: File[]) {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.slice(0, -1).forEach((name, i) => {
      if (!node.dirs.has(name)) node.dirs.set(name, { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      node = node.dirs.get(name)!;
    });
    node.files.push({ ...f, name: parts.at(-1)! });
  }
  return root;
}
const filesIn = (d: Dir): File[] => [...d.files, ...[...d.dirs.values()].flatMap(filesIn)];

// 比較の結果のひとこと(違う行の数がわかれば数も)
function Result({ f, total, count = true }: { f: File; total: number; count?: boolean }) {
  const miss = total - f.on.length;
  return (
    <>
      {miss > 0 && <span className="badge miss">{miss} 台にない</span>}
      {!f.same && f.on.length > 1 && <span className="badge chg">{count && f.lines ? `違う行 ${f.lines}` : "違う"}</span>}
      {f.same && f.lines === null && <span className="muted small">大きさは同じ</span>}
      {f.same && f.lines === 0 && <span className="muted small">同じ</span>}
    </>
  );
}

// 一覧: 「違いだけ」は違いのあるファイルをパスのまま、「すべて(ツリー)」はフォルダーの構造のまま(WinMerge のフォルダー比較のように)
function FileList({ list, view, setView, busy, onOpen }:
  { list: List; view: View; setView: (v: View) => void; busy: boolean; onOpen: (path: string) => void }) {
  const total = list.servers.length;
  const diffs = list.files.filter((f) => changed(f, total));
  const toggle = (path: string) => {
    const open = new Set(view.open);
    if (open.has(path)) open.delete(path);
    else open.add(path);
    setView({ ...view, open });
  };
  const rows: ReactNode[] = [];
  const walk = (node: Dir, depth: number) => {
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const all = filesIn(d);
      const n = all.filter((f) => changed(f, total)).length;
      if (!view.showSame && !n) continue;
      const isOpen = view.open.has(d.path);
      rows.push(
        <tr key={"d:" + d.path} className={"dir" + (n ? "" : " same")} onClick={() => toggle(d.path)}>
          <td><button type="button" className="tree-name" style={{ paddingLeft: depth * 18 }} aria-expanded={isOpen}>
            <span className="tw" aria-hidden>{isOpen ? "▾" : "▸"}</span><span className="ic dir" aria-hidden>▤</span><span translate="no">{d.name}/</span>
          </button></td>
          <td>{n ? <span className="badge dirc">{`変更のあるファイル ${n}`}</span> : <span className="muted small">すべて同じ</span>}</td>
          <td className="muted small">{`${all.length} 件中`}</td>
          {list.servers.map((s) => <td key={s.id} />)}
        </tr>,
      );
      if (isOpen) walk(d, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!view.showSame && !changed(f, total)) continue;
      const kind = f.on.length < total ? "miss" : f.same ? "same" : "chg";
      rows.push(
        <tr key={f.path} className={kind}>
          <td><button type="button" className="tree-name" style={{ paddingLeft: depth * 18 }} disabled={busy} onClick={() => onOpen(f.path)}>
            <span className="tw" aria-hidden /><span className={"ic " + kind} aria-hidden>{kind === "miss" ? "!" : kind === "chg" ? "≠" : "="}</span><span translate="no">{f.name}</span>
          </button></td>
          <td><Result f={f} total={total} count={false} /></td>
          <td className="small">{f.lines ? <b>{`違う行 ${f.lines}`}</b> : ""}</td>
          {f.sizes.map((n, i) => <td key={i} className={"small " + (n === null ? "no" : "muted")}>{n === null ? "ない" : kb(n)}</td>)}
        </tr>,
      );
    }
  };
  if (view.mode === "tree") walk(treeOf(list.files), 0);
  return (
    <>
      {list.servers.filter((s) => s.error).map((s) => <p key={s.id} className="error" role="alert"><span translate="no">{s.name}</span>: {s.error}</p>)}
      <div className="chips" role="group" aria-label="一覧の表示">
        <Chip on={view.mode === "list"} onClick={() => setView({ ...view, mode: "list" })}>違いだけ</Chip>
        <Chip on={view.mode === "tree"} onClick={() => setView({ ...view, mode: "tree" })}>すべて(ツリー)</Chip>
        {view.mode === "tree" && <Chip on={view.showSame} onClick={() => setView({ ...view, showSame: !view.showSame })}>同じものも出す</Chip>}
        <Info>違う行は、基準(最初に選んだサーバー)と比べた行の数です(ファイルを開いて「違う行だけ」にしたときの行数)。Pterodactyl のサーバーは、API の回数に上限があるので大きさが違うファイルだけ中身を読みます(「大きさは同じ」は中身を読んでいません)。</Info>
      </div>
      {view.mode === "list" ? (
        <section className="group spaced">
          {diffs.length === 0 && <div className="row muted">{list.files.length ? "違いのあるファイルはありません" : "設定ファイルが見つかりませんでした"}</div>}
          {diffs.map((f) => (
            <button key={f.path} type="button" className="row link" disabled={busy} onClick={() => onOpen(f.path)}>
              <span className="main" translate="no">{f.path}</span>
              <span className="trail"><Result f={f} total={total} /></span>
            </button>
          ))}
        </section>
      ) : (
        <section className="group ports-table tree-table">
          <table>
            <thead>
              <tr>
                <th>名前</th><th>比較結果</th><th>違い</th>
                {list.servers.map((s, i) => <th key={s.id}><span translate="no">{s.name}</span>{i === 0 && <small>基準</small>}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={total + 3} className="muted">{list.files.length ? "違いのあるファイルはありません" : "設定ファイルが見つかりませんでした"}</td></tr>}
              {rows}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

// 行をつなぐ(元のファイルの改行コードと、最後の改行を保つ)
function joinLines(lines: string[], original: string) {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const last = original === "" || original.endsWith("\n");
  return lines.join(eol) + (lines.length && last ? eol : "");
}

// 並べて比べる。違う行の「←」で基準の行にし、「直す」でその場で書き換える。変えたサーバーだけ「保存」を出す。
// 変えたことは Ctrl+Z で戻し、Ctrl+Y(Ctrl+Shift+Z)でやり直せる(続けて打った文字は 1 回で戻す。保存・開き直すと消える)
function Compare({ opened, onlyDiff, setOnlyDiff, busy, note, onBack, onSave }:
  { opened: Opened; onlyDiff: boolean; setOnlyDiff: (v: boolean) => void; busy: boolean; note: string; onBack: () => void; onSave: (id: string, content: string) => void }) {
  const [drafts, setDrafts] = useState<(string | null)[]>(() => opened.servers.map((s) => s.content));
  const [editing, setEditing] = useState<number | null>(null);
  const [past, setPast] = useState<(string | null)[][]>([]);
  const [future, setFuture] = useState<(string | null)[][]>([]);
  const typing = useRef<number | null>(null); // 続けて打っている列
  useEffect(() => { setDrafts(opened.servers.map((s) => s.content)); setEditing(null); setPast([]); setFuture([]); typing.current = null; }, [opened]);
  const [base, ...others] = opened.servers;
  const lines = useMemo(() => drafts.map((d) => splitLines(d ?? "")), [drafts]);
  const rows = useMemo(() => alignAll(lines[0], lines.slice(1)).map((r, idx) => ({ ...r, idx })), [lines]);
  const shown = onlyDiff ? rows.filter((r) => r.diff) : rows;
  const setCol = (col: number, text: string, typed = false) => {
    if (drafts[col] === text) return;
    if (!typed || typing.current !== col) setPast((p) => [...p.slice(-99), drafts]);
    typing.current = typed ? col : null;
    setFuture([]);
    setDrafts(drafts.map((x, i) => (i === col ? text : x)));
  };
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [drafts, ...f]);
    setDrafts(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    typing.current = null;
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, drafts]);
    setDrafts(future[0]);
    setFuture((f) => f.slice(1));
    typing.current = null;
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || busy) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) (e.preventDefault(), undo());
      else if (k === "y" || (k === "z" && e.shiftKey)) (e.preventDefault(), redo());
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  const changed = (col: number) => drafts[col] !== null && drafts[col] !== opened.servers[col].content;
  // ほかのサーバー(k)の、その行を基準の行にする: 違う → 書き換える / 無い → 入れる / そのサーバーだけ → 消す
  const take = (idx: number, k: number) => setCol(k + 1, joinLines(takeBase(lines[0], lines[k + 1], rows, idx, k), opened.servers[k + 1].content ?? ""));
  const head = (col: number) => {
    const s = opened.servers[col];
    if (s.content === null) return null;
    return (
      <>
        <button type="button" className="link small" disabled={busy} onClick={() => setEditing(editing === col ? null : col)}>{editing === col ? "直すのをやめる" : "直す"}</button>
        {col > 0 && drafts[0] !== null && drafts[col] !== drafts[0] && (
          <button type="button" className="link small" disabled={busy} onClick={() => setCol(col, drafts[0]!)}>基準と同じにする</button>
        )}
        {changed(col) && (
          <>
            <button type="button" className="link small" disabled={busy} onClick={() => onSave(s.id, drafts[col]!)}>保存</button>
            <button type="button" className="link small" disabled={busy} onClick={() => setCol(col, s.content!)}>取り消す</button>
          </>
        )}
      </>
    );
  };
  return (
    <>
      <div className="bar wrap">
        <Btn sm onClick={onBack}>‹ ファイルの一覧</Btn>
        <strong className="path" translate="no">{opened.path}</strong>
        <Info>黄色は違う行、赤は基準にあってこのサーバーに無い行、緑はこのサーバーだけにある行です。「←」で基準の行にし(緑の行は「×」で消し)、「直す」でその場で書き換えられます。「保存」を押すまでサーバーは変わりません(保存する前の中身は履歴に残ります)。変えたことは「元に戻す」(Ctrl+Z)・「やり直す」(Ctrl+Y)で戻せます。基準は、上で最初に選んだサーバーです。</Info>
        <span className="spacer" />
        <Chip on={onlyDiff} onClick={() => setOnlyDiff(!onlyDiff)}>違う行だけ</Chip>
        <Btn sm disabled={busy || !past.length} onClick={undo} title="元に戻す(Ctrl+Z)">元に戻す</Btn>
        <Btn sm disabled={busy || !future.length} onClick={redo} title="やり直す(Ctrl+Y)">やり直す</Btn>
      </div>
      {note && <p className="notice" role="status">{note}</p>}
      {editing !== null && drafts[editing] !== null && (
        <section className="group form">
          <div className="row"><span translate="no">{opened.servers[editing].name}</span><span className="trail muted small">を直しています(下の表にもすぐに出ます)</span></div>
          <textarea className="row codes" rows={14} spellCheck={false} value={drafts[editing]!} onChange={(e) => setCol(editing, e.target.value, true)} aria-label="ファイルの中身" translate="no" />
        </section>
      )}
      <section className="group ports-table diff-table">
        <table>
          <thead>
            <tr>
              <th><span translate="no">{base.name}</span><small>基準</small>{head(0)}</th>
              {others.map((s, k) => <th key={s.id}><span translate="no">{s.name}</span>{changed(k + 1) && <small>変更あり</small>}{head(k + 1)}</th>)}
            </tr>
          </thead>
          <tbody>
            {base.content === null && <tr><td colSpan={opened.servers.length} className="muted">{base.error || "基準のサーバーにこのファイルがありません。基準にしたいサーバーを先に選んでください"}</td></tr>}
            {shown.length === 0 && base.content !== null && <tr><td colSpan={opened.servers.length} className="muted">違いはありません</td></tr>}
            {base.content !== null && shown.map((r) => (
              <tr key={r.idx}>
                <td className={r.base === null ? "gap" : r.diff ? "base-diff" : ""} translate="no"><code>{r.base === null ? "" : lines[0][r.base]}</code></td>
                {r.cells.map((c, k) => (
                  <td key={k} className={c.kind} translate="no">
                    {others[k].content === null ? <span className="muted small">{others[k].error || "このファイルはありません"}</span> : (
                      <>
                        {(c.kind === "chg" || c.kind === "miss" || c.kind === "extra") && (
                          <button type="button" className="take" disabled={busy} title={c.kind === "extra" ? "この行を消す" : "基準の行にする"} aria-label={c.kind === "extra" ? "この行を消す" : "基準の行にする"} onClick={() => take(r.idx, k)}>{c.kind === "extra" ? "×" : "←"}</button>
                        )}
                        <code>{c.i === null ? "" : lines[k + 1][c.i]}</code>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
