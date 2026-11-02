import { useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ApplyResults } from "~/lib/apply-results";
import { libraryCatalog } from "~/lib/library-api";
import { applySet, createSet, listSets, removeSet, renameSet, toggleSetItem } from "~/lib/sets-api";
import { SOURCE_LABEL, isSource } from "~/lib/sources";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/sets")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/sets" } });
    return { user: context.user };
  },
  loader: async () => ({ sets: await listSets(), catalog: await libraryCatalog() }),
  component: Sets,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = { plugin: "プラグイン", mod: "Mod" };

type SetRow = Awaited<ReturnType<typeof listSets>>[number];
type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type Result = Awaited<ReturnType<typeof applySet>>;

// セット: ライブラリから選んだものの組み合わせを、サーバーにまとめて入れる
function Sets() {
  const { user } = Route.useRouteContext();
  const { sets, catalog } = Route.useLoaderData();
  const { can } = useCan(user.id);
  const router = useRouter();
  const reload = () => router.invalidate();
  const edit = can({ library: ["edit"] });

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/" className="capsule">‹ ライブラリ</Link>
        <h1>セット</h1>
      </header>
      {sets.length === 0 && (
        <section className="group"><div className="row muted">まだセットがありません。{edit ? "下で作れます。" : ""}</div></section>
      )}
      {sets.map((s) => <SetCard key={s.id} set={s} catalog={catalog} edit={edit} onChange={reload} />)}
      <p className="foot">セットは、ライブラリから選んだ Mod・プラグインの組み合わせです。「サーバーに入れる」で、サーバーの種類に合うもののうち、まだ入っていないものをまとめて入れます(Paper のサーバーに Mod は入れません)。</p>
      {edit && <NewSet onCreated={reload} />}
    </main>
  );
}

function SetCard({ set, catalog, edit, onChange }: { set: SetRow; catalog: Catalog; edit: boolean; onChange: () => void }) {
  const toggle = useServerFn(toggleSetItem);
  const apply = useServerFn(applySet);
  const rename = useServerFn(renameSet);
  const remove = useServerFn(removeSet);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ server: string; list: Result } | null>(null);
  const inSet = new Set(set.items.map((i) => i.id));
  const addable = catalog.items.filter((i) => !inSet.has(i.id));
  const targets = catalog.servers.filter((s) => s.type);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="group-title" translate="no">{set.name}</div>
      <section className="group">
        {set.servers.length > 0 && (
          <div className="row"><span>結び付けているサーバー</span><span className="trail" translate="no">{set.servers.map((x) => x.name).join("、")}</span></div>
        )}
        {set.items.length === 0 && <div className="row muted">まだ何も入っていません。{edit && catalog.items.length === 0 ? "先にライブラリに Mod・プラグインを登録すると、ここに足せます。" : ""}</div>}
        {set.items.map((i) => (
          <div className="row hit" key={i.id}>
            {i.iconUrl ? <img src={i.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="icon-ph" />}
            <span className="main">
              <span translate="no">{i.title}</span>
              <span className="muted">{TYPE_LABEL[i.projectType] ?? i.projectType} · {isSource(i.source) ? SOURCE_LABEL[i.source] : i.source}</span>
            </span>
            {edit && (
              <button className="trail link danger" type="button" disabled={!!busy}
                onClick={() => run(i.id, () => toggle({ data: { id: set.id, itemId: i.id, add: false } }))}>外す</button>
            )}
          </div>
        ))}
        {edit && addable.length > 0 && (
          <div className="row">
            <span>ライブラリから足す</span>
            <select className="trail" value="" disabled={!!busy} aria-label={`${set.name} にライブラリから足す`}
              onChange={(e) => { const itemId = e.target.value; if (itemId) run(itemId, () => toggle({ data: { id: set.id, itemId, add: true } })); }}>
              <option value="">選んでください…</option>
              {addable.map((i) => <option key={i.id} value={i.id} translate="no">{i.title}({TYPE_LABEL[i.projectType] ?? i.projectType})</option>)}
            </select>
          </div>
        )}
        {edit && set.items.length > 0 && (
          <div className="row">
            <span>サーバーに入れる</span>
            {targets.length ? (
              <select className="trail" value="" disabled={!!busy} aria-label={`${set.name} をサーバーに入れる`}
                onChange={(e) => {
                  const s = targets.find((x) => x.id === e.target.value);
                  if (s) run("apply", async () => setResults({ server: s.name, list: await apply({ data: { id: set.id, serverId: s.id } }) }));
                }}>
                <option value="">サーバーを選ぶ…</option>
                {targets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
              </select>
            ) : <span className="trail muted">種類を決めたサーバーがありません</span>}
          </div>
        )}
        {busy === "apply" && <div className="row muted">サーバーに入れています…</div>}
        {results && <ApplyResults server={results.server} verb="入れた" list={results.list} />}
        {edit && (
          <div className="row actions">
            <button className="link" type="button" disabled={!!busy} onClick={() => {
              const n = prompt("セットの新しい名前", set.name);
              if (n && n !== set.name) run("rename", () => rename({ data: { id: set.id, name: n } }));
            }}>名前を変える</button>
            <button className="trail link danger" type="button" disabled={!!busy}
              onClick={() => confirm(`セット「${set.name}」を消しますか?(ライブラリとサーバーはそのままです)`) && run("remove", () => remove({ data: { id: set.id } }))}>
              セットを消す
            </button>
          </div>
        )}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
    </>
  );
}

function NewSet({ onCreated }: { onCreated: () => void }) {
  const create = useServerFn(createSet);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    try {
      await create({ data: { name } });
      setName("");
      setError("");
      onCreated();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <>
      <div className="group-title">新しいセット</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <input className="row" placeholder="セットの名前(例 ロビー用)" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        {error && <p className="row error" role="alert">{error}</p>}
        <button className="row link" type="submit" disabled={!name.trim()}>作る</button>
      </form>
    </>
  );
}
