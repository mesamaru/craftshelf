import { useEffect, useRef, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type Group, type Kind, type Port, freePorts, isPort, rangeOf } from "~/lib/ports";
import { adoptFoundPort, portOverview, savePortRules, saveServerPorts, scanPorts, setServerPortInfo } from "~/lib/ports-api";
import { useCan } from "~/lib/use-can";
import { Bell } from "~/lib/bell";

export const Route = createFileRoute("/ports")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/ports" } });
    return { user: context.user };
  },
  loader: () => portOverview(),
  component: Ports,
});

type Overview = Awaited<ReturnType<typeof portOverview>>;
type Srv = Overview["servers"][number];
const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const SOURCE: Record<string, string> = { file: "設定ファイル", allocation: "Pterodactyl の割り当て", manual: "手入力", adopted: "見つけて追加", found: "見つかった" };
const live = (p: Port) => !p.ignored && p.source !== "found";
const rangeText = (k: Kind) => (k.mode === "group" ? `${k.start ?? "?"}+グループ番号` : k.mode === "fixed" ? `${k.rangeFrom}–${k.rangeTo}` : "自由");

// ポート管理: サーバー × 種類の表。重複・範囲外は右上のベルに出す
function Ports() {
  const { user } = Route.useRouteContext();
  const [data, setData] = useState<Overview>(Route.useLoaderData());
  const { can } = useCan(user.id);
  const edit = can({ server: ["update"] });
  const scan = useServerFn(scanPorts);
  const [panel, setPanel] = useState<{ type: "server"; id: string; focus?: string; addKind?: string } | { type: "rules" } | null>(null);
  const [bell, setBell] = useState(false);
  const [machine, setMachine] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const machines = [...new Set(data.servers.map((s) => s.machine))];
  const problemIds = new Set(data.problems.map((p) => p.portId));
  const found = data.servers.flatMap((s) => s.ports.filter((p) => p.source === "found" && !p.ignored).map((p) => ({ s, p })));
  const shown = data.servers.filter((s) => (!machine || s.machine === machine) && (!onlyProblems || s.ports.some((p) => problemIds.has(p.id))));
  const groups: (Group | null)[] = [...data.groups, null];

  const rescan = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await scan({ data: {} });
      setData(r);
      setNote(r.failed.length ? `読み取れなかったサーバー: ${r.failed.map((f) => `${f.name}(${f.message})`).join("、")}` : "読み取りました");
    } catch (e) {
      setNote(message(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (data.servers.length && data.servers.every((s) => !s.scannedAt)) rescan(); }, []);

  return (
    <main className="page wide">
      <header className="bar">
        <Link to="/servers" className="capsule">‹ サーバー</Link>
        <h1>ポート</h1>
        <Bell open={bell} setOpen={setBell} count={data.problems.length + found.length} label={`ポートの知らせ ${data.problems.length + found.length} 件`}>
          <ProblemList data={data} found={found} edit={edit} onChange={setData} />
        </Bell>
      </header>
      <div className="bar wrap">
        {machines.length > 1 && (
          <select value={machine} onChange={(e) => setMachine(e.target.value)} aria-label="マシン">
            <option value="">すべてのマシン</option>
            {machines.map((m) => <option key={m} value={m}>{m.split("/").pop() || "(不明)"}</option>)}
          </select>
        )}
        <label className="muted"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> 問題のあるものだけ</label>
        <span className="spacer" />
        {edit && <button className="capsule" type="button" onClick={() => setPanel({ type: "rules" })}>種類とグループ</button>}
        {edit && <button className="capsule" type="button" onClick={rescan} disabled={busy}>{busy ? "読み取っています…" : "再読込"}</button>}
      </div>
      {note && <p className="notice" role="status">{note}</p>}

      {data.servers.length === 0 ? (
        <section className="group"><div className="row muted">サーバーがありません。「サーバー」で Pterodactyl のサーバーを追加してください。</div></section>
      ) : (
        <div className="group ports-table">
          <table>
            <thead>
              <tr><th>サーバー</th>{data.kinds.map((k) => <th key={k.id}>{k.name}<small>{rangeText(k)} · {k.proto}</small></th>)}</tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const rows = shown.filter((s) => (g ? s.groupId === g.id : !s.groupId || !data.groups.some((x) => x.id === s.groupId)));
                if (!rows.length) return null;
                return [
                  <tr className="grp" key={g?.id ?? "none"}><td colSpan={data.kinds.length + 1}>{g ? `${g.number} ${g.name}` : "グループ未設定"} · {rows.length} 台</td></tr>,
                  ...rows.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <button className="srv-name" type="button" onClick={() => setPanel({ type: "server", id: s.id })} title="このサーバーのポートの設定">
                          <span translate="no">{s.name}</span>{s.memo && <small translate="no">{s.memo}</small>}
                        </button>
                      </td>
                      {data.kinds.map((k) => {
                        const ps = s.ports.filter((p) => live(p) && p.kindId === k.id);
                        return (
                          <td key={k.id}>
                            {ps.map((p) => {
                              const pr = data.problems.find((x) => x.portId === p.id);
                              return <button key={p.id} type="button" className={`pc ${pr?.type ?? ""}`} title={pr?.message ?? (p.memo || SOURCE[p.source])}
                                onClick={() => setPanel({ type: "server", id: s.id, focus: p.id })}>{p.port}</button>;
                            })}
                            {!ps.length && edit && <button type="button" className="pc add" aria-label={`${s.name} に ${k.name} を追加`} onClick={() => setPanel({ type: "server", id: s.id, addKind: k.id })}>＋</button>}
                          </td>
                        );
                      })}
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="foot">ポートは Pterodactyl の割り当てと、種類ごとの設定ファイルから読み取ります。重複は同じマシン(Pterodactyl のノード)の中だけで確かめます。番号を押すと、そのサーバーのポートを変えられます。</p>

      {panel && (
        <>
          <div className="scrim" onClick={() => setPanel(null)} />
          <aside className="side-panel" role="dialog" aria-label="ポートの設定">
            {panel.type === "rules"
              ? <RulesPanel data={data} onClose={() => setPanel(null)} onSaved={(d) => { setData(d); setPanel(null); }} />
              : <ServerPanel key={panel.id + (panel.focus ?? "") + (panel.addKind ?? "")} data={data} server={data.servers.find((s) => s.id === panel.id)!}
                  focus={panel.focus} addKind={panel.addKind} edit={edit} onClose={() => setPanel(null)} onSaved={setData} />}
          </aside>
        </>
      )}
    </main>
  );
}

// 右上のベル: 押すと一覧が開き、外側を押すか Esc で閉じる

function ProblemList({ data, found, edit, onChange }: { data: Overview; found: { s: Srv; p: Port }[]; edit: boolean; onChange: (d: Overview) => void }) {
  const save = useServerFn(saveServerPorts);
  const adopt = useServerFn(adoptFoundPort);
  const [error, setError] = useState("");
  const name = (id: string) => data.servers.find((s) => s.id === id)?.name ?? "";
  const run = async (fn: () => Promise<Overview>) => { try { onChange(await fn()); setError(""); } catch (e) { setError(message(e)); } };
  return (
    <>
      <div className="row"><b>重複・範囲外 {data.problems.length} 件</b></div>
      {data.problems.length === 0 && <div className="row muted">問題はありません</div>}
      {data.problems.map((pr) => (
        <div className="row" key={pr.portId}>
          <span className={`mono ${pr.type}`}>{pr.port}</span>
          <span className="main"><span translate="no">{name(pr.serverId)}</span><span className="muted">{pr.message}</span></span>
          {edit && pr.fix && <button className="trail capsule small" type="button" onClick={() => run(() => save({ data: { serverId: pr.serverId, changes: [{ id: pr.portId, port: pr.fix! }] } }))}>{`${pr.fix} に変える`}</button>}
        </div>
      ))}
      {found.length > 0 && <div className="row"><b>見つかったポート {found.length} 件</b></div>}
      {found.map(({ s, p }) => (
        <FoundRow key={p.id} server={s} port={p} kinds={data.kinds} edit={edit}
          onAdopt={(input) => run(() => adopt({ data: { portId: p.id, ...input } }))}
          onIgnore={() => run(() => save({ data: { serverId: s.id, changes: [{ id: p.id, ignore: true }] } }))} />
      ))}
      {error && <p className="row error" role="alert">{error}</p>}
    </>
  );
}

function FoundRow({ server, port, kinds, edit, onAdopt, onIgnore }:
  { server: Srv; port: Port; kinds: Kind[]; edit: boolean; onAdopt: (i: { kindId?: string; newKindName?: string }) => void; onIgnore: () => void }) {
  const [kind, setKind] = useState("__new");
  return (
    <div className="row column">
      <span>「<span translate="no">{server.name}</span>」の <span translate="no">{port.label}</span> の設定に、ポートらしい項目があります: <code>{port.file}</code> の <code>{port.key} = {port.port}</code></span>
      {edit && (
        <span className="actions">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="管理する種類">
            <option value="__new">{`新しい種類「${port.label}」を作る`}</option>
            {kinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          <button className="capsule primary small" type="button" onClick={() => onAdopt(kind === "__new" ? { newKindName: port.label } : { kindId: kind })}>管理する</button>
          <button className="capsule small" type="button" onClick={onIgnore}>いいえ(以後聞かない)</button>
        </span>
      )}
    </div>
  );
}

type Draft = { id?: string; kindId: string | null; port: string; memo: string; source: string; label: string; file: string; key: string; ignored: boolean; remove: boolean };

// 1 台のサーバー: グループ・メモと、すべてのポート
function ServerPanel({ data, server, focus, addKind, edit, onClose, onSaved }:
  { data: Overview; server: Srv; focus?: string; addKind?: string; edit: boolean; onClose: () => void; onSaved: (d: Overview) => void }) {
  const save = useServerFn(saveServerPorts);
  const setInfo = useServerFn(setServerPortInfo);
  const scan = useServerFn(scanPorts);
  const [rows, setRows] = useState<Draft[]>(() => {
    const r: Draft[] = server.ports.filter((p) => p.source !== "found" || p.ignored).map((p) => ({ ...p, port: String(p.port), remove: false }));
    if (addKind) r.push({ kindId: addKind, port: "", memo: "", source: "manual", label: "", file: "", key: "", ignored: false, remove: false });
    return r;
  });
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const group = data.groups.find((g) => g.id === server.groupId);
  const kindOf = (id: string | null) => data.kinds.find((k) => k.id === id);
  const firstFree = (kindId: string | null) => freePorts(data.servers, server.machine, rangeOf(kindOf(kindId), group), 1)[0];
  useEffect(() => {
    if (addKind) setRows((r) => r.map((x, i) => (i === r.length - 1 && !x.port ? { ...x, port: String(firstFree(addKind) ?? "") } : x)));
  }, []);

  // 入力中に確かめる: 番号の形・同じマシンの重複・範囲
  const check = (d: Draft): [string, string] => {
    const n = Number(d.port);
    if (!isPort(n)) return ["err", "1〜65535 の番号を入れてください"];
    if (d.ignored || d.remove) return ["", ""];
    const other = data.servers.filter((s) => s.machine === server.machine)
      .flatMap((s) => (s.id === server.id ? rows.filter((x) => x !== d && !x.remove && !x.ignored).map((x) => ({ s, port: Number(x.port), label: x.label })) : s.ports.filter(live).map((p) => ({ s, port: p.port, label: p.label }))))
      .find((x) => x.port === n);
    if (other) return ["dup", `「${other.s.name}」${other.label ? `の ${other.label}` : ""}が使っています`];
    const r = rangeOf(kindOf(d.kindId), group);
    if (r && (n < r[0] || n > r[1])) return ["out", `範囲 ${r[0]}–${r[1]} の外です`];
    return ["", ""];
  };
  const blocking = rows.filter((d) => !d.remove && ["err", "dup"].includes(check(d)[0])).length;
  const changed = (d: Draft) => {
    const o = server.ports.find((p) => p.id === d.id);
    return !o || d.remove || o.port !== Number(d.port) || o.memo !== d.memo || o.kindId !== d.kindId || o.ignored !== d.ignored;
  };
  const willWrite = [...new Set(rows.filter((d) => d.id && !d.remove && (d.source === "file" || d.source === "adopted") && server.ports.find((p) => p.id === d.id)?.port !== Number(d.port)).map((d) => d.file))];
  const set = (i: number, v: Partial<Draft>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...v } : x)));

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await save({ data: { serverId: server.id, changes: rows.filter(changed).map((d) => (d.id
        ? { id: d.id, ...(d.remove ? { remove: true } : { port: Number(d.port), memo: d.memo, kindId: d.kindId, ignore: d.ignored }) }
        : { kindId: d.kindId, port: Number(d.port), memo: d.memo })) } });
      onSaved(r);
      setDone(r.wroteFiles.length ? `${r.wroteFiles.join("、")} を書き換えました。サーバーを再起動すると新しい番号になります。` : "保存しました");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="bar"><h2 translate="no">{server.name}</h2><button className="capsule small" type="button" onClick={onClose} aria-label="閉じる">×</button></div>
      <section className="group">
        <label className="row">
          <span>グループ</span>
          <select className="trail" value={server.groupId ?? ""} disabled={!edit}
            onChange={async (e) => { try { onSaved(await setInfo({ data: { serverId: server.id, groupId: e.target.value || null, memo: server.memo } })); } catch (x) { setError(message(x)); } }}>
            <option value="">未設定</option>
            {data.groups.map((g) => <option key={g.id} value={g.id}>{g.number} {g.name}</option>)}
          </select>
        </label>
        <label className="row">
          <span>メモ</span>
          <input className="trail" defaultValue={server.memo} placeholder="担当・用途など" maxLength={100} disabled={!edit} translate="no"
            onBlur={async (e) => { if (e.target.value !== server.memo) try { onSaved(await setInfo({ data: { serverId: server.id, groupId: server.groupId, memo: e.target.value } })); } catch (x) { setError(message(x)); } }} />
        </label>
        <div className="row">
          <span className="main"><span>マシン</span><span className="muted">{server.machine.split("/").pop() || "(不明)"} · 自動更新 {server.scannedAt ? new Date(server.scannedAt).toLocaleString("ja-JP") : "まだ"}</span></span>
          <button className="trail capsule small" type="button" disabled={busy}
            onClick={async () => { setBusy(true); try { onSaved(await scan({ data: { serverId: server.id } })); onClose(); } catch (x) { setError(message(x)); } finally { setBusy(false); } }}>再読込</button>
        </div>
      </section>

      <div className="group-title">ポート</div>
      <section className="group">
        {rows.length === 0 && <div className="row muted">まだポートがありません。</div>}
        {rows.map((d, i) => {
          const [st, why] = check(d);
          const sugg = st ? freePorts(data.servers, server.machine, rangeOf(kindOf(d.kindId), group), 3) : [];
          const auto = d.source !== "manual";
          return (
            <div className={`row column ${d.id === focus ? "focus" : ""} ${d.remove || d.ignored ? "faded" : ""}`} key={d.id ?? `new${i}`}>
              <span className="port-line">
                <select value={d.kindId ?? ""} disabled={!edit} onChange={(e) => set(i, { kindId: e.target.value || null })} aria-label="種類">
                  <option value="">種類なし</option>
                  {data.kinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                </select>
                <input className={`num ${st}`} inputMode="numeric" value={d.port} disabled={!edit || d.source === "allocation" || d.remove}
                  autoFocus={d.id === focus || (!d.id && i === rows.length - 1)} aria-label="ポート番号" onChange={(e) => set(i, { port: e.target.value.trim() })} />
                {edit && (auto
                  ? <button className="capsule small" type="button" onClick={() => set(i, { ignored: !d.ignored })} title="次の読み取りでも出てこないようにします">{d.ignored ? "戻す" : "管理から外す"}</button>
                  : <button className="capsule small danger" type="button" onClick={() => (d.id ? set(i, { remove: !d.remove }) : setRows((r) => r.filter((_, j) => j !== i)))}>{d.remove ? "戻す" : "削除"}</button>)}
              </span>
              <span className="muted small">{SOURCE[d.source] ?? d.source}{d.file ? ` · ${d.file}${d.key ? ` の ${d.key}` : ""}` : ""}{d.source === "allocation" ? "(番号はパネルの「ネットワーク」で変えます)" : ""}</span>
              {st && <span className={`small ${st}`}>{why}{sugg.length > 0 && edit && <> → 空き: {sugg.map((n) => <button key={n} type="button" className="capsule small" onClick={() => set(i, { port: String(n) })}>{n}</button>)}</>}</span>}
              <input className="memo" placeholder="メモ(用途など)" value={d.memo} maxLength={100} disabled={!edit} translate="no" onChange={(e) => set(i, { memo: e.target.value })} />
            </div>
          );
        })}
        {edit && (
          <div className="row column">
            <span className="muted small">ポートを追加(種類を押すと、空いている番号が入ります)</span>
            <span className="actions">
              {data.kinds.map((k) => <button key={k.id} className="capsule small" type="button"
                onClick={() => setRows((r) => [...r, { kindId: k.id, port: String(firstFree(k.id) ?? ""), memo: "", source: "manual", label: "", file: "", key: "", ignored: false, remove: false }])}>{k.name}</button>)}
            </span>
          </div>
        )}
      </section>
      {edit && (
        <div className="panel-foot">
          {blocking > 0 ? <p className="error small">重複・番号の誤りが {blocking} 件あるため保存できません</p>
            : willWrite.length > 0 && <p className="muted small">保存すると書き換えるファイル: {willWrite.join("、")}(サーバーを再起動すると反映されます)</p>}
          {error && <p className="error small" role="alert">{error}</p>}
          {done && <p className="small" role="status">{done}</p>}
          <span className="actions"><button className="capsule" type="button" onClick={onClose}>閉じる</button>
            <button className="capsule primary" type="button" disabled={busy || blocking > 0 || !rows.some(changed)} onClick={submit}>{busy ? "保存しています…" : "保存"}</button></span>
        </div>
      )}
    </>
  );
}

type KindDraft = Omit<Kind, "id"> & { id?: string };
type GroupDraft = Omit<Group, "id"> & { id?: string };

// 種類(表の列)とグループ(表の行)。⠿ をドラッグするか ▲▼ で並べ替える
function RulesPanel({ data, onClose, onSaved }: { data: Overview; onClose: () => void; onSaved: (d: Overview) => void }) {
  const save = useServerFn(savePortRules);
  const [tab, setTab] = useState<"kinds" | "groups" | "catalog">("kinds");
  const [kinds, setKinds] = useState<KindDraft[]>(data.kinds.map((k) => ({ ...k })));
  const [groups, setGroups] = useState<GroupDraft[]>(data.groups.map((g) => ({ ...g })));
  const [error, setError] = useState("");
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const list = tab === "kinds" ? kinds : groups;
  const setList = (v: (KindDraft | GroupDraft)[]) => (tab === "kinds" ? setKinds(v as KindDraft[]) : setGroups(v as GroupDraft[]));
  const move = (from: number, to: number) => { if (to < 0 || to >= list.length || to === from) return; const a = [...list]; a.splice(to, 0, a.splice(from, 1)[0]); setList(a); };
  const setK = (i: number, v: Partial<KindDraft>) => setKinds((r) => r.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const setG = (i: number, v: Partial<GroupDraft>) => setGroups((r) => r.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const num = (v: string) => (v === "" ? null : Number(v));
  const inUse = (id?: string) => data.servers.filter((s) => s.groupId === id).length;

  // マウスでもタッチでも動くよう、pointer のイベントで並べ替える
  const grip = (i: number) => ({
    className: "grip", title: "ドラッグで並べ替え", "aria-hidden": true,
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      setDrag({ from: i, over: i });
      const over = (ev: PointerEvent) => {
        const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-idx]") as HTMLElement | null;
        if (row) setDrag({ from: i, over: Number(row.dataset.idx) });
      };
      const up = () => {
        document.removeEventListener("pointermove", over);
        document.removeEventListener("pointerup", up);
        setDrag((d) => { if (d) move(d.from, d.over); return null; });
      };
      document.addEventListener("pointermove", over);
      document.addEventListener("pointerup", up);
    },
  });
  const order = (i: number) => (
    <span className="order">
      <span {...grip(i)}>⠿</span>
      <button type="button" className="link" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="上へ">▲</button>
      <button type="button" className="link" disabled={i === list.length - 1} onClick={() => move(i, i + 1)} aria-label="下へ">▼</button>
    </span>
  );
  const rowClass = (i: number) => `row column ${drag?.from === i ? "faded" : ""} ${drag && drag.over === i && drag.from !== i ? "drop" : ""}`;

  return (
    <>
      <div className="bar"><h2>種類とグループ</h2><button className="capsule small" type="button" onClick={onClose} aria-label="閉じる">×</button></div>
      <div className="seg">
        {([["kinds", "ポートの種類(列)"], ["groups", "グループ(行)"], ["catalog", "プラグインの一覧"]] as const).map(([k, l]) =>
          <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "catalog" ? (
        <section className="group">
          {data.catalog.map((c) => (
            <div className="row column" key={c.file + c.key}>
              <b>{c.plugin}</b><span className="muted small"><code>{c.file}</code> の <code>{c.key}</code> · {c.proto}</span>
            </div>
          ))}
          <div className="row muted small">この一覧は CraftShelf が最初から知っているものです。種類の「ファイル」「項目」にそのまま書けます。一覧に無いプラグインは、再読込のときに plugins/*/config.yml からポートらしい項目を探して、ベルで聞きます。</div>
        </section>
      ) : tab === "kinds" ? (
        <section className="group">
          {kinds.map((k, i) => (
            <div className={rowClass(i)} data-idx={i} key={k.id ?? `n${i}`}>
              <span className="port-line">{order(i)}
                <input value={k.name} maxLength={40} aria-label="種類の名前" onChange={(e) => setK(i, { name: e.target.value })} />
                <select value={k.proto} onChange={(e) => setK(i, { proto: e.target.value })} aria-label="プロトコル">{["TCP", "UDP", "両方"].map((x) => <option key={x}>{x}</option>)}</select>
                <button className="link danger" type="button" onClick={() => setKinds((r) => r.filter((_, j) => j !== i))} aria-label="消す">×</button>
              </span>
              <span className="port-line">
                <select value={k.mode} onChange={(e) => setK(i, { mode: e.target.value })} aria-label="範囲の決め方">
                  <option value="group">グループごとに分ける</option><option value="fixed">決まった範囲</option><option value="free">自由</option>
                </select>
                {k.mode === "group" && <>開始 <input className="num" value={k.start ?? ""} onChange={(e) => setK(i, { start: num(e.target.value) })} aria-label="開始番号" /> から
                  <input className="num short" value={k.size ?? ""} onChange={(e) => setK(i, { size: num(e.target.value) })} aria-label="個数" /> 個ずつ</>}
                {k.mode === "fixed" && <><input className="num" value={k.rangeFrom ?? ""} onChange={(e) => setK(i, { rangeFrom: num(e.target.value) })} aria-label="範囲の始め" /> –
                  <input className="num" value={k.rangeTo ?? ""} onChange={(e) => setK(i, { rangeTo: num(e.target.value) })} aria-label="範囲の終わり" /></>}
              </span>
              {k.mode === "group" && k.start != null && k.size && groups[0] && /^\d+$/.test(groups[0].number) &&
                <span className="muted small">例: {groups[0].number} {groups[0].name} は {k.start + Number(groups[0].number)}–{k.start + Number(groups[0].number) + k.size - 1}</span>}
              <span className="port-line">
                <input list="port-files" value={k.file} placeholder="読み書きするファイル(空 = 記録だけ)" aria-label="ファイル" onChange={(e) => setK(i, { file: e.target.value })} />
                <input value={k.key} placeholder="項目(例 Webserver.Port)" aria-label="項目" onChange={(e) => setK(i, { key: e.target.value })} disabled={!k.file} />
              </span>
            </div>
          ))}
          <datalist id="port-files">{[...new Set(data.catalog.map((c) => c.file))].map((f) => <option key={f} value={f} />)}</datalist>
          <button className="row link" type="button" onClick={() => setKinds((r) => [...r, { name: "新しい種類", mode: "free", start: null, size: null, rangeFrom: null, rangeTo: null, proto: "TCP", file: "", key: "" }])}>＋ 種類を追加</button>
          <div className="row muted small">「グループごとに分ける」の範囲は、開始番号 + グループ番号 から個数ぶんです(例: 開始 20500・10 個ずつ → 90 のグループは 20590–20599)。</div>
        </section>
      ) : (
        <section className="group">
          {groups.map((g, i) => (
            <div className={rowClass(i)} data-idx={i} key={g.id ?? `n${i}`}>
              <span className="port-line">{order(i)}
                <input className="num short" value={g.number} maxLength={6} aria-label="番号" onChange={(e) => setG(i, { number: e.target.value })} />
                <input value={g.name} maxLength={40} aria-label="名前" onChange={(e) => setG(i, { name: e.target.value })} />
                <span className="muted small">{inUse(g.id)} 台</span>
                <button className="link danger" type="button" disabled={inUse(g.id) > 0} title={inUse(g.id) ? "サーバーがあるグループは消せません" : "消す"}
                  onClick={() => setGroups((r) => r.filter((_, j) => j !== i))} aria-label="消す">×</button>
              </span>
            </div>
          ))}
          <button className="row link" type="button" onClick={() => setGroups((r) => [...r, { number: "", name: "" }])}>＋ グループを追加</button>
          <div className="row muted small">サーバーをどのグループに入れるかは、表のサーバー名を押して選びます。</div>
        </section>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="panel-foot"><span className="actions">
        <button className="capsule" type="button" onClick={onClose}>キャンセル</button>
        <button className="capsule primary" type="button" onClick={async () => { try { onSaved(await save({ data: { kinds, groups } })); } catch (e) { setError(message(e)); } }}>保存</button>
      </span></div>
    </>
  );
}
