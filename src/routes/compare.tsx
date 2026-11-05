import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { installMod, libraryCatalog, modVersions, removeMod, setModHold } from "~/lib/library-api";
import { useCan } from "~/lib/use-can";

export const Route = createFileRoute("/compare")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/compare" } });
    return { user: context.user };
  },
  loader: () => libraryCatalog(),
  component: Compare,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

type Item = Awaited<ReturnType<typeof libraryCatalog>>["items"][number];
// 入れるものとして選んだもの("サーバーID:アイテムID" → 版。versionId が null なら、いちばん新しい版)
type Pick = { versionId: string | null; versionNumber: string };
const LATEST: Pick = { versionId: null, versionNumber: "最新" };

// サーバーを横に並べて、ライブラリのものがどのサーバーにどの版で入っているかを見比べる。入っていないところには入れられる
function Compare() {
  const { user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const { can } = useCan(user.id);
  const edit = can({ library: ["edit"] });
  const router = useRouter();
  const install = useServerFn(installMod);
  const [sel, setSel] = useState(() => data.servers.slice(0, 4).map((s) => s.id));
  const [diffOnly, setDiffOnly] = useState(false);
  const [picks, setPicks] = useState(() => new Map<string, Pick>());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const servers = data.servers.filter((s) => sel.includes(s.id));
  const installOf = (i: Item, serverId: string) => i.installs.find((x) => x.serverId === serverId);
  const verOf = (i: Item, serverId: string) => installOf(i, serverId)?.versionNumber;
  const rows = data.items.filter((i) => !diffOnly || new Set(servers.map((s) => verOf(i, s.id) ?? "")).size > 1);
  const setPick = (key: string, p: Pick | null) => setPicks((m) => {
    const n = new Map(m);
    if (p) n.set(key, p);
    else n.delete(key);
    return n;
  });

  const run = async () => {
    setBusy(true);
    setNote("");
    setError("");
    const failed: string[] = [];
    let done = 0;
    for (const [key, p] of picks) {
      const [serverId, itemId] = key.split(":");
      const item = data.items.find((i) => i.id === itemId);
      if (!item) continue;
      try {
        await install({ data: { id: serverId, projectId: item.projectId, source: item.source as never, versionId: p.versionId ?? undefined } });
        done++;
      } catch (e) {
        failed.push(`${item.title}(${data.servers.find((s) => s.id === serverId)?.name}): ${message(e)}`);
      }
    }
    setPicks(new Map());
    setNote(`${done} 件を入れました。反映にはサーバーの再起動が要ります`);
    if (failed.length) setError(`入れられなかったもの: ${failed.join("、")}`);
    setBusy(false);
    await router.invalidate();
  };

  return (
    <main className="page wide">
      <header className="bar wrap">
        <Link to="/servers" className="capsule">‹ サーバー</Link>
        <h1>サーバーの比較</h1>
        <span className="spacer" />
        <Link to="/compare/files" className="capsule small">ファイル比較</Link>
        <label className="capsule small"><input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} /> 違いだけ表示</label>
      </header>

      {data.servers.length < 2 ? (
        <section className="group"><div className="row muted">比較するには 2 台以上のサーバーを追加してください</div></section>
      ) : (
        <>
          <div className="seg" role="group" aria-label="比較するサーバー">
            {data.servers.map((s) => (
              <button key={s.id} type="button" className={sel.includes(s.id) ? "on" : ""} aria-pressed={sel.includes(s.id)} translate="no"
                onClick={() => setSel((x) => (x.includes(s.id) ? x.filter((y) => y !== s.id) : [...x, s.id]))}>{s.name}</button>
            ))}
          </div>
          <section className="group ports-table">
            <table>
              <thead>
                <tr>
                  <th />
                  {servers.map((s) => <th key={s.id}><Link to="/servers/$id" params={{ id: s.id }} className="srv-name" translate="no">{s.name}</Link></th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={servers.length + 1} className="muted">{diffOnly ? "違いはありません" : "ライブラリに何もありません"}</td></tr>}
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td translate="no">{i.title}</td>
                    {servers.map((s) => {
                      const key = `${s.id}:${i.id}`;
                      const inst = installOf(i, s.id);
                      if (inst) {
                        return (
                          <td key={s.id}>
                            {edit ? <Installed serverId={s.id} item={i} version={inst.versionNumber} filename={inst.filename} onDone={() => router.invalidate()} />
                              : <span className="mono" translate="no">{inst.versionNumber}</span>}
                          </td>
                        );
                      }
                      if (!edit || s.type !== i.projectType) return <td key={s.id} className="muted">—</td>;
                      const p = picks.get(key);
                      return (
                        <td key={s.id}>
                          {p ? <Picked serverId={s.id} item={i} pick={p} onPick={(x) => setPick(key, x)} />
                            : <button type="button" className="pc add" aria-pressed="false" onClick={() => setPick(key, LATEST)} title="このサーバーに入れる">＋ 導入</button>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="foot">「導入」を押すと、そのサーバーに入れるものとして選べます(いちばん新しい版。タグのボタンで別の版も選べます。もう一度押すと選ぶのをやめます)。入っている版を押すと、版を変える・外すができます。古い版を選んだものは「更新を止める」にします。サーバーの種類に合わないところは「—」です。</p>
          {picks.size > 0 && (
            <section className="group">
              <div className="row">
                <span>{`${picks.size} 件を入れます`}</span>
                <span className="actions">
                  <button type="button" className="link" disabled={busy} onClick={() => setPicks(new Map())}>選択を解除</button>
                  <button type="button" className="capsule primary small" disabled={busy} onClick={run}>{busy ? "入れています…" : "導入する"}</button>
                </span>
              </div>
            </section>
          )}
          {note && <p className="notice" role="status">{note}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </main>
  );
}

// 選んだマス: 入れる版・版を選ぶボタン・解除
function Picked({ serverId, item, pick, onPick }: { serverId: string; item: Item; pick: Pick; onPick: (p: Pick | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="port-line">
      {/* もう一度押すと、選ぶのをやめる */}
      <button type="button" className="pc on" aria-pressed="true" title="もう一度押すと、導入をやめます" onClick={() => onPick(null)}>
        <svg className="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>導入
      </button>
      <button type="button" className="link small" title="版を選ぶ" aria-label="版を選ぶ" aria-expanded={open} onClick={() => setOpen((x) => !x)}><TagIcon /></button>
      <span className="small mono" translate="no">{pick.versionNumber}</span>
      {open && <VersionSelect serverId={serverId} item={item} pick={pick} onPick={(p) => { onPick(p); setOpen(false); }} />}
    </span>
  );
}

// 入っているマス: 版を押すと、版を変える・外す
function Installed({ serverId, item, version, filename, onDone }: { serverId: string; item: Item; version: string; filename: string; onDone: () => void }) {
  const install = useServerFn(installMod);
  const remove = useServerFn(removeMod);
  const hold = useServerFn(setModHold);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setOpen(false);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="port-line">
      <button type="button" className="pc" translate="no" aria-expanded={open} title="版を変える・外す" disabled={busy} onClick={() => setOpen((x) => !x)}>{version}</button>
      {open && !busy && (
        <>
          <VersionSelect serverId={serverId} item={item} pick={null} onPick={(p) => {
            if (confirm(`${item.title} を ${p.versionNumber} にしますか?(反映にはサーバーの再起動が要ります)`)) {
              const key = { id: serverId, projectId: item.projectId, source: item.source as never };
              act(async () => {
                await install({ data: { ...key, versionId: p.versionId ?? undefined } });
                if (!p.versionId) await hold({ data: { ...key, hold: false } }); // いちばん新しい版にしたら、止めていた更新も戻す
              });
            }
          }} />
          <button type="button" className="link small danger" onClick={() => {
            if (confirm(`${item.title} を外しますか?(「変更の履歴」から元に戻せます)`)) act(() => remove({ data: { id: serverId, filename } }));
          }}>外す</button>
        </>
      )}
      {busy && <span className="small muted">変えています…</span>}
      {error && <span className="small err" role="alert">{error}</span>}
    </span>
  );
}

// pick が null なら「選んでください」から始め、どれを選んでも onPick を呼ぶ(入っているものの版を変えるとき)
function VersionSelect({ serverId, item, pick, onPick }: { serverId: string; item: Item; pick: Pick | null; onPick: (p: Pick) => void }) {
  const load = useServerFn(modVersions);
  const [list, setList] = useState<Awaited<ReturnType<typeof modVersions>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    load({ data: { id: serverId, projectId: item.projectId, source: item.source as never } }).then(setList, (e) => setError(message(e)));
  }, [serverId, item.projectId, item.source]);
  if (error) return <span className="small err">{error}</span>;
  if (!list) return <span className="small muted">読み込み中…</span>;
  if (!list.length) return <span className="small muted">選べる版がありません(SpigotMC は、いちばん新しい版だけです)</span>;
  return (
    <select aria-label="入れる版" value={pick ? pick.versionId ?? "" : "-"} onChange={(e) => {
      const v = list.find((x) => x.versionId === e.target.value);
      onPick(v ? { versionId: v.versionId, versionNumber: v.versionNumber } : { versionId: null, versionNumber: "いちばん新しい版" });
    }}>
      {!pick && <option value="-" disabled>版を選んでください…</option>}
      <option value="">いちばん新しい版</option>
      {list.map((v) => <option key={v.versionId} value={v.versionId} translate="no">{v.versionNumber}{v.release ? "" : "(テスト版)"}・{v.date.slice(0, 10)}</option>)}
    </select>
  );
}

// 版を選ぶボタンのアイコン(値札の形)
function TagIcon() {
  return (
    <svg className="tag-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}
