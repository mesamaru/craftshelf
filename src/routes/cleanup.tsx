import { useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ITEM_TYPES } from "~/lib/platforms";
import { cleanupFind, cleanupRemove } from "~/lib/saved-api";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/cleanup")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/cleanup" } });
    return { user: context.user };
  },
  component: Cleanup,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = ITEM_TYPES;
const size = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n > 0 ? `${Math.max(1, Math.round(n / 1024))} KB` : "");
type Cond = "old" | "dup" | "stale" | "unused";
// 条件と、数を入れるもの(既定の数と単位)
const CONDS: Record<Cond, { label: string; param?: [string, number, string] }> = {
  old: { label: "古い版(新しく保存した方から決まった数だけ残す)", param: ["残す数", 3, "個"] },
  dup: { label: "同じ版の重複(同じ版のファイルがいくつもある)" },
  stale: { label: "長く更新の無いもの(配布元の最後の更新・最後に版を足した日)", param: ["期間", 12, "か月以上"] },
  unused: { label: "どのサーバーにも入っていないもの(プラグイン・Mod・データパック)" },
};
type Row = Awaited<ReturnType<typeof cleanupFind>>[number];

// アドオンの整理(v02 と同じ): 条件で抜き出し、確かめてから選んだものを消す
function Cleanup() {
  const { user } = Route.useRouteContext();
  const { can } = useCan(user.id);
  const find = useServerFn(cleanupFind);
  const remove = useServerFn(cleanupRemove);
  const [cond, setCond] = useState<Cond>("old");
  const [n, setN] = useState(3);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const keyOf = (r: Row) => r.fileId ?? r.itemId;
  const run = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await find({ data: { cond, n } });
      setRows(r);
      setPicked(new Set(r.flatMap((x, i) => (x.checked ? [i] : []))));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const doRemove = async () => {
    const list = (rows ?? []).filter((_, i) => picked.has(i));
    if (!list.length) return setError("消すものを選んでください");
    const items = list.filter((r) => r.kind === "item").length;
    if (!confirm(`${list.length} 件を消しますか?(版は保存先からも消えます。アドオンごとのものは、ライブラリから外します。サーバーに入っているファイルはそのままです)${items ? `\nアドオンごと: ${items} 件` : ""}`)) return;
    setBusy(true);
    setError("");
    try {
      const r = await remove({ data: { fileIds: list.flatMap((x) => (x.fileId ? [x.fileId] : [])), itemIds: list.flatMap((x) => (x.kind === "item" ? [x.itemId] : [])) } });
      setNote(`版 ${r.files} 個・アドオン ${r.items} 件を消しました${r.failed.length ? `。消せなかったもの: ${r.failed.join("、")}` : ""}`);
      setRows(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const c = CONDS[cond];
  const total = (rows ?? []).filter((_, i) => picked.has(i)).reduce((s, r) => s + r.size, 0);
  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ ライブラリ</Link>
        <h1>アドオンの整理</h1>
      </header>
      {!can({ library: ["edit"] }) && <section className="group"><div className="row muted">整理できるのは、編集者以上の人です。</div></section>}
      <section className="group form">
        <label className="row">
          <span style={{ whiteSpace: "nowrap" }}>条件</span>
          <select className="trail" style={{ maxWidth: "70%" }} value={cond} aria-label="条件" onChange={(e) => { const v = e.target.value as Cond; setCond(v); setN(CONDS[v].param?.[1] ?? 1); setRows(null); }}>
            {(Object.keys(CONDS) as Cond[]).map((k) => <option key={k} value={k}>{CONDS[k].label}</option>)}
          </select>
        </label>
        {c.param && (
          <label className="row">
            <span>{c.param[0]}</span>
            <span className="trail"><input type="number" min={1} max={120} value={n} aria-label={c.param[0]} onChange={(e) => setN(Math.max(1, Math.min(120, Math.floor(Number(e.target.value) || 1))))} /> {c.param[2]}</span>
          </label>
        )}
        <button className="row link" type="button" disabled={busy} onClick={run}>{busy && !rows ? "抜き出しています…" : "抜き出す"}</button>
      </section>
      <p className="foot">条件に当てはまるものを抜き出して、確かめてから消せます。サーバーで使っている版・セットで固定した版は「古い版」「重複」に出しません。「どのサーバーにも入っていない」もののうち、セットに入っているものは最初は選んでいません。</p>
      {rows && (
        <>
          <div className="group-title">{rows.length ? `${rows.length} 件が見つかりました${total ? `(選んだもの ${size(total)})` : ""}` : "条件に当てはまるものはありません"}</div>
          {rows.length > 0 && (
            <section className="group">
              <div className="row actions">
                <button className="link small" type="button" onClick={() => setPicked(new Set(rows.map((_, i) => i)))}>すべて選ぶ</button>
                <button className="link small" type="button" onClick={() => setPicked(new Set())}>すべて外す</button>
              </div>
              {rows.map((r, i) => (
                <label className="row" key={`${keyOf(r)}:${i}`}>
                  <input type="checkbox" checked={picked.has(i)} aria-label={`${r.title} を選ぶ`}
                    onChange={(e) => setPicked((p) => { const x = new Set(p); if (e.target.checked) x.add(i); else x.delete(i); return x; })} />
                  <span className="main">
                    <span>
                      <span translate="no" className="strong">{r.title}</span>
                      {r.kind === "version" ? <span className="badge muted-badge"><span translate="no">{r.version}</span></span> : <span className="badge miss">アドオンごと</span>}
                    </span>
                    <span className="muted">{TYPE_LABEL[r.projectType] ?? r.projectType}{" · "}{r.reason}{r.size ? ` · ${size(r.size)}` : ""}</span>
                  </span>
                </label>
              ))}
              <button className="row link danger" type="button" disabled={busy || !picked.size || !can({ library: ["edit"] })} onClick={doRemove}>{busy ? "消しています…" : "選んだものを消す"}</button>
            </section>
          )}
        </>
      )}
      {note && <section className="group"><p className="row muted" role="status" translate="no">{note}</p></section>}
      {error && <section className="group"><p className="row error" role="alert">{error}</p></section>}
    </main>
  );
}
