import { useMemo, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { alignAll, splitLines } from "~/lib/diff";
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
          onCopy={(to) => run(async () => {
            const base = opened.servers[0];
            const target = opened.servers.find((s) => s.id === to)!;
            if (base.content === null || target.content === null) return;
            if (!confirm(`「${target.name}」の ${opened.path} を「${base.name}」と同じ中身にしますか?(前の中身は履歴に残ります)`)) return;
            await save({ data: { id: to, path: opened.path, content: base.content, base: target.content } });
            setNote(`「${target.name}」の ${opened.path} を写しました。反映にはサーバーの再起動が要ります`);
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

function Compare({ opened, onlyDiff, setOnlyDiff, busy, note, onBack, onCopy }:
  { opened: Opened; onlyDiff: boolean; setOnlyDiff: (v: boolean) => void; busy: boolean; note: string; onBack: () => void; onCopy: (id: string) => void }) {
  const [base, ...others] = opened.servers;
  const lines = useMemo(() => opened.servers.map((s) => splitLines(s.content ?? "")), [opened]);
  const rows = useMemo(() => alignAll(lines[0], lines.slice(1)), [lines]);
  const shown = onlyDiff ? rows.filter((r) => r.diff) : rows;
  return (
    <>
      <div className="bar wrap">
        <button type="button" className="capsule small" onClick={onBack}>‹ ファイルの一覧</button>
        <strong translate="no">{opened.path}</strong>
        <span className="spacer" />
        <label className="capsule small"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> 違う行だけ</label>
      </div>
      {note && <p className="notice" role="status">{note}</p>}
      <section className="group ports-table diff-table">
        <table>
          <thead>
            <tr>
              <th translate="no">{base.name}<small>基準</small></th>
              {others.map((s) => (
                <th key={s.id}>
                  <span translate="no">{s.name}</span>
                  {s.content !== null && base.content !== null && s.content !== base.content && (
                    <button type="button" className="link small" disabled={busy} onClick={() => onCopy(s.id)}>基準と同じにする</button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {base.content === null && <tr><td colSpan={opened.servers.length} className="muted">{base.error || "基準のサーバーにこのファイルがありません。基準にしたいサーバーを先に選んでください"}</td></tr>}
            {shown.length === 0 && base.content !== null && <tr><td colSpan={opened.servers.length} className="muted">違いはありません</td></tr>}
            {base.content !== null && shown.map((r, n) => (
              <tr key={n}>
                <td className={r.base === null ? "gap" : r.diff ? "base-diff" : ""} translate="no"><code>{r.base === null ? "" : lines[0][r.base]}</code></td>
                {r.cells.map((c, k) => (
                  <td key={k} className={c.kind} translate="no">
                    {others[k].content === null ? <span className="muted small">{others[k].error || "このファイルはありません"}</span> : <code>{c.i === null ? "" : lines[k + 1][c.i]}</code>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="foot">黄色は違う行、赤は基準にあってこのサーバーに無い行、緑はこのサーバーだけにある行です。基準は、上で最初に選んだサーバーです。</p>
    </>
  );
}
