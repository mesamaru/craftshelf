import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { alignAll, splitLines, takeBase } from "~/lib/diff";
import { configFiles, readServerFile, saveServerFile } from "~/lib/files-api";
import { listServers } from "~/lib/servers-api";

export const Route = createFileRoute("/compare_/files")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/compare/files" } });
    return { user: context.user };
  },
  loader: () => listServers(),
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
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

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
    <main className="page wide">
      <header className="bar wrap">
        <Link to="/compare" className="capsule">‹ 比較</Link>
        <h1>ファイル比較</h1>
      </header>
      <p className="foot">比べるサーバーを 2 台以上選んでください(8 台まで)。設定ファイル(server.properties・plugins・config の中など)を並べて見比べ、左のサーバーの中身をほかのサーバーへ写せます。見る・直すのは管理者以上です。</p>
      <div className="seg" role="group" aria-label="比べるサーバー">
        {servers.map((s) => (
          <button key={s.id} type="button" className={sel.includes(s.id) ? "on" : ""} aria-pressed={sel.includes(s.id)} translate="no" onClick={() => toggle(s.id)}>{s.name}</button>
        ))}
      </div>
      {sel.length >= 2 && !list && (
        <section className="group spaced">
          <button className="row link" type="button" disabled={busy} onClick={() => run(async () => setList(await load({ data: { ids: sel } })))}>
            {busy ? "設定ファイルを集めています…" : "設定ファイルを集める"}
          </button>
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {list && !opened && <FileList list={list} onlyDiff={onlyDiff} setOnlyDiff={setOnlyDiff} busy={busy} onOpen={(p) => { setNote(""); open(p); }} />}
      {opened && (
        <Compare opened={opened} onlyDiff={onlyDiff} setOnlyDiff={setOnlyDiff} busy={busy} note={note} onBack={() => setOpened(null)}
          onSave={(to, content) => run(async () => {
            const target = opened.servers.find((s) => s.id === to)!;
            if (target.content === null) return;
            await save({ data: { id: to, path: opened.path, content, base: target.content } });
            setNote(`「${target.name}」の ${opened.path} を保存しました。反映にはサーバーの再起動が要ります`);
            await open(opened.path);
          })} />
      )}
    </main>
  );
}

function FileList({ list, onlyDiff, setOnlyDiff, busy, onOpen }:
  { list: List; onlyDiff: boolean; setOnlyDiff: (v: boolean) => void; busy: boolean; onOpen: (path: string) => void }) {
  const total = list.servers.length;
  const files = list.files.filter((f) => !onlyDiff || !f.same);
  return (
    <>
      {list.servers.filter((s) => s.error).map((s) => <p key={s.id} className="error" role="alert"><span translate="no">{s.name}</span>: {s.error}</p>)}
      <label className="capsule small"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> 違うかもしれないものだけ</label>
      <section className="group spaced">
        {files.length === 0 && <div className="row muted">{onlyDiff ? "どのファイルも、すべてのサーバーで同じ大きさです" : "設定ファイルが見つかりませんでした"}</div>}
        {files.map((f) => (
          <button key={f.path} type="button" className="row link" disabled={busy} onClick={() => onOpen(f.path)}>
            <span className="main" translate="no">{f.path}</span>
            <span className="trail muted small">{f.on.length < total ? `${total - f.on.length} 台にない` : f.same ? "大きさは同じ" : "違う"}</span>
          </button>
        ))}
      </section>
      <p className="foot">中身までは読まずに大きさで見ています(大きさが同じでも、開くと違うことがあります)。</p>
    </>
  );
}

// 行をつなぐ(元のファイルの改行コードと、最後の改行を保つ)
function joinLines(lines: string[], original: string) {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const last = original === "" || original.endsWith("\n");
  return lines.join(eol) + (lines.length && last ? eol : "");
}

// 並べて比べる。違う行の「←」で基準の行にし、「直す」でその場で書き換える。変えたサーバーだけ「保存」を出す
function Compare({ opened, onlyDiff, setOnlyDiff, busy, note, onBack, onSave }:
  { opened: Opened; onlyDiff: boolean; setOnlyDiff: (v: boolean) => void; busy: boolean; note: string; onBack: () => void; onSave: (id: string, content: string) => void }) {
  const [drafts, setDrafts] = useState<(string | null)[]>(() => opened.servers.map((s) => s.content));
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => { setDrafts(opened.servers.map((s) => s.content)); setEditing(null); }, [opened]);
  const [base, ...others] = opened.servers;
  const lines = useMemo(() => drafts.map((d) => splitLines(d ?? "")), [drafts]);
  const rows = useMemo(() => alignAll(lines[0], lines.slice(1)).map((r, idx) => ({ ...r, idx })), [lines]);
  const shown = onlyDiff ? rows.filter((r) => r.diff) : rows;
  const setCol = (col: number, text: string) => setDrafts((d) => d.map((x, i) => (i === col ? text : x)));
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
        <button type="button" className="capsule small" onClick={onBack}>‹ ファイルの一覧</button>
        <strong translate="no">{opened.path}</strong>
        <span className="spacer" />
        <label className="capsule small"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> 違う行だけ</label>
      </div>
      {note && <p className="notice" role="status">{note}</p>}
      {editing !== null && drafts[editing] !== null && (
        <section className="group form">
          <div className="row"><span translate="no">{opened.servers[editing].name}</span><span className="trail muted small">を直しています(下の表にもすぐに出ます)</span></div>
          <textarea className="row codes" rows={14} spellCheck={false} value={drafts[editing]!} onChange={(e) => setCol(editing, e.target.value)} aria-label="ファイルの中身" translate="no" />
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
      <p className="foot">黄色は違う行、赤は基準にあってこのサーバーに無い行、緑はこのサーバーだけにある行です。「←」で基準の行にし(緑の行は「×」で消し)、「直す」でその場で書き換えられます。「保存」を押すまでサーバーは変わりません(保存する前の中身は履歴に残ります)。基準は、上で最初に選んだサーバーです。</p>
    </>
  );
}
