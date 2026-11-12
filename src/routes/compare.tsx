import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ActionBar, Btn, Chip, ChipBar, Info, Sheet, Tabs } from "~/lib/ui";
import { adoptMod, identifyMods, installMod, installedMods, libraryCatalog, removeMod, setModEnabled, setModHold } from "~/lib/library-api";
import { VersionChooser } from "~/lib/version-picker";
import { useCan } from "~/lib/use-can";
import { AddonIcon } from "~/lib/type-icon";
import { pageTitle } from "~/lib/titles";
import { confirmDialog } from "~/lib/dialog-queue";

export const Route = createFileRoute("/compare")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/compare" } });
    return { user: context.user };
  },
  loader: () => libraryCatalog(),
  head: () => ({ meta: [{ title: pageTitle("比較") }] }),
  component: Compare,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

type Item = Awaited<ReturnType<typeof libraryCatalog>>["items"][number];
// 入れるものとして選んだもの("サーバーID:アイテムID" → 版。versionId が null なら、そのサーバーに合う最新版。unsupported = 対応しない版を確かめたうえで選んだ)
type Pick = { versionId: string | null; versionNumber: string; unsupported?: boolean };
const LATEST: Pick = { versionId: null, versionNumber: "合う最新版" };
const COMPARE_TABS = [["addons", "アドオン"], ["files", "ファイル"]] as const;

// サーバーを横に並べて、ライブラリのものがどのサーバーにどの版で入っているかを見比べる。入っていないところには入れられる
function Compare() {
  const { user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const { can } = useCan(user.id);
  const edit = can({ library: ["edit"] });
  const router = useRouter();
  const navigate = useNavigate();
  const install = useServerFn(installMod);
  const [sel, setSel] = useState(() => data.servers.slice(0, 4).map((s) => s.id));
  const [diffOnly, setDiffOnly] = useState(false);
  const [picks, setPicks] = useState(() => new Map<string, Pick>());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const servers = data.servers.filter((s) => sel.includes(s.id));
  // サーバーにある、配布元のわからない jar(このアプリの記録が無いもの)。選んだサーバーごとに読む
  const listFiles = useServerFn(installedMods);
  const identify = useServerFn(identifyMods);
  type Unknown = { filename: string; name: string; key: string };
  const [unknown, setUnknown] = useState<Record<string, Unknown[]>>({});
  const [tick, setTick] = useState(0); // 増やすと、読み直す
  useEffect(() => {
    for (const id of sel) {
      if (id in unknown) continue;
      listFiles({ data: { id } }).then(
        (r) => setUnknown((u) => ({ ...u, [id]: r.items.filter((i) => !i.projectId).map((i) => ({ filename: i.filename, name: i.name ?? "", key: i.key ?? "" })) })),
        () => setUnknown((u) => ({ ...u, [id]: [] })), // 種類を決めていない・つながらないサーバーは出さない
      );
    }
  }, [sel.join(), tick]);
  // 手で置いた jar は、中の説明ファイルの名前(plugin.yml の name など)で同じものを並べる。読めなければ、ファイル名から版を除いた名前
  const groupOf = (f: Unknown) => f.key || `f:${baseName(f.filename)}`;
  const labels = new Map(servers.flatMap((s) => (unknown[s.id] ?? []).map((f) => [groupOf(f), f.name || baseName(f.filename)] as const)));
  const unknownRows = [...labels.keys()].sort((a, b) => labels.get(a)!.localeCompare(labels.get(b)!))
    .map((g) => ({ g, name: labels.get(g)!, files: Object.fromEntries(servers.map((s) => [s.id, (unknown[s.id] ?? []).find((f) => groupOf(f) === g)?.filename ?? ""])) }))
    .filter((r) => !diffOnly || new Set(servers.map((s) => r.files[s.id])).size > 1);
  const installOf = (i: Item, serverId: string) => i.installs.find((x) => x.serverId === serverId);
  const verOf = (i: Item, serverId: string) => { const x = installOf(i, serverId); return x && `${x.versionNumber}${x.disabled ? " 無効" : ""}`; };
  // 配布元はわかっているが、ライブラリに無いもの(ライブラリから外したものなど)。配布元・ID ごとに 1 行
  const orphanRows = [...new Map(data.orphans.filter((o) => sel.includes(o.serverId)).map((o) => [`${o.source}:${o.projectId}`, o.title])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, title]) => ({ key, title, files: Object.fromEntries(servers.map((s) => [s.id, data.orphans.find((o) => o.serverId === s.id && `${o.source}:${o.projectId}` === key)])) }))
    .filter((r) => !diffOnly || new Set(servers.map((s) => r.files[s.id]?.versionNumber ?? "")).size > 1);
  // 取り込んだ・切り替えたあと: ライブラリと、配布元のわからないものを読み直す
  const refresh = () => { setUnknown({}); setTick((x) => x + 1); router.invalidate(); };
  // サーバーに入れるもの(プラグイン・Mod・データパック)だけを並べる
  const rows = data.items.filter((i) => ["plugin", "mod", "datapack"].includes(i.projectType)).filter((i) => !diffOnly || new Set(servers.map((s) => verOf(i, s.id) ?? "")).size > 1);
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
        await install({ data: { id: serverId, projectId: item.projectId, source: item.source as never, versionId: p.versionId ?? undefined, unsupported: p.unsupported } });
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
    <main className="page fill wide">
      <header className="bar">
        <h1>比較<Info><span>入っているもの・ライブラリに無いものを押すと、無効にする(消さずに止める)・有効にする・ライブラリに取り込むもできます。配布元のわからないものは、ファイルの中身から探し、見つからなければ、サーバーから取り込んだものとしてライブラリに載せます(自分用の版)。</span><span>「導入」を押すと、そのサーバーに入れるものとして選べます(そのサーバーの Minecraft に合う最新版。タグのボタンで別の版も選べます。もう一度押すと選ぶのをやめます)。入っている版を押すと、版を変える・外すができます。古い版を選んだものは「更新を止める」にします。サーバーの種類に合わないところは「—」です。</span></Info></h1>
      </header>
      <Tabs value="addons" options={COMPARE_TABS} label="比較" onChange={(v) => v === "files" && navigate({ to: "/compare/files" })} />

      {data.servers.length < 2 ? (
        <section className="group"><div className="row muted">比較するには 2 台以上のサーバーを追加してください</div></section>
      ) : (
        <>
          <ChipBar label="比較するサーバー" tools={<Chip on={diffOnly} onClick={() => setDiffOnly(!diffOnly)}>違いだけ</Chip>}>
            {data.servers.map((s) => (
              <Chip key={s.id} on={sel.includes(s.id)} translate="no"
                onClick={() => setSel((x) => (x.includes(s.id) ? x.filter((y) => y !== s.id) : [...x, s.id]))}>{s.name}</Chip>
            ))}
          </ChipBar>
          <section className="group ports-table">
            <table>
              <thead>
                <tr>
                  <th />
                  {servers.map((s) => <th key={s.id}><Link to="/servers/$id" params={{ id: s.id }} className="srv-name" translate="no">{s.name}</Link></th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && unknownRows.length === 0 && orphanRows.length === 0 && <tr><td colSpan={servers.length + 1} className="muted">{diffOnly ? "違いはありません" : "ライブラリに何もありません"}</td></tr>}
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td><span className="nm"><AddonIcon type={i.projectType} url={i.iconUrl} size="sm" /><span translate="no">{i.title}</span></span></td>
                    {servers.map((s) => {
                      const key = `${s.id}:${i.id}`;
                      const inst = installOf(i, s.id);
                      if (inst) {
                        return (
                          <td key={s.id}>
                            {edit ? <Installed serverId={s.id} mc={s.mc} item={i} version={inst.versionNumber} filename={inst.filename} onDone={() => router.invalidate()} />
                              : <span className="mono" translate="no">{inst.versionNumber}</span>}
                            {inst.disabled && <span className="badge muted-badge">無効</span>}
                          </td>
                        );
                      }
                      if (!edit || !s.kinds.includes(i.projectType as never)) return <td key={s.id} className="muted">—</td>;
                      const p = picks.get(key);
                      return (
                        <td key={s.id}>
                          {p ? <Picked serverId={s.id} mc={s.mc} item={i} pick={p} onPick={(x) => setPick(key, x)} />
                            : <button type="button" className="pc add" aria-pressed="false" onClick={() => setPick(key, LATEST)} title="このサーバーに入れる">＋ 導入</button>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {orphanRows.length > 0 && <tr className="grp"><td colSpan={servers.length + 1}>ライブラリに無いもの(配布元はわかっています)</td></tr>}
                {orphanRows.map((r) => (
                  <tr key={`o:${r.key}`}>
                    <td><span className="nm"><AddonIcon type={servers[0]?.type ?? "plugin"} size="sm" /><span translate="no">{r.title}</span></span></td>
                    {servers.map((s) => {
                      const f = r.files[s.id];
                      if (!f) return <td key={s.id} className="muted">—</td>;
                      return <td key={s.id}>{edit ? <FileCell serverId={s.id} filename={f.filename} label={f.versionNumber} onDone={refresh} />
                        : <span className="mono" translate="no">{f.versionNumber}</span>}</td>;
                    })}
                  </tr>
                ))}
                {unknownRows.length > 0 && <tr className="grp"><td colSpan={servers.length + 1}>配布元がわからないもの(手で置いた jar など)</td></tr>}
                {unknownRows.map((r) => (
                  <tr key={`n:${r.g}`}>
                    <td><span className="nm"><AddonIcon type={servers[0]?.type ?? "plugin"} size="sm" /><span translate="no">{r.name}</span></span></td>
                    {servers.map((s) => {
                      const f = r.files[s.id];
                      if (!f) return <td key={s.id} className="muted">—</td>;
                      return <td key={s.id} className="small mono" translate="no">{edit ? <FileCell serverId={s.id} filename={f} label={f} onDone={refresh} /> : f}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {edit && unknownRows.length > 0 && (
            <section className="group">
              <button className="row link" type="button" disabled={busy} onClick={async () => {
                setBusy(true);
                setError("");
                setNote("");
                try {
                  let found = 0;
                  for (const s of servers.filter((x) => (unknown[x.id] ?? []).length)) found += (await identify({ data: { id: s.id } })).found.length;
                  setNote(`${found} 個の配布元が見つかりました`);
                  refresh();
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}>{busy ? "ファイルの中身から探しています…" : "配布元がわからないものを、ファイルの中身から探す"}</button>
            </section>
          )}
          {picks.size > 0 && (
            <ActionBar label="選んだもの">
              <strong>{`${picks.size} 件`}</strong>
              <Btn kind="pri" sm disabled={busy} onClick={run}>{busy ? "入れています…" : "導入する"}</Btn>
              <Btn sm disabled={busy} aria-label="選択を解除" onClick={() => setPicks(new Map())}>✕</Btn>
            </ActionBar>
          )}
          {note && <p className="notice" role="status">{note}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </main>
  );
}

// 選んだマス: 入れる版・版を選ぶボタン・解除
function Picked({ serverId, mc, item, pick, onPick }: { serverId: string; mc: string; item: Item; pick: Pick; onPick: (p: Pick | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="port-line">
      {/* もう一度押すと、選ぶのをやめる */}
      <button type="button" className="pc on" aria-pressed="true" title="もう一度押すと、導入をやめます" onClick={() => onPick(null)}>
        <svg className="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>導入
      </button>
      <button type="button" className="link small" title="版を選ぶ" aria-label="版を選ぶ" aria-expanded={open} onClick={() => setOpen((x) => !x)}><TagIcon /></button>
      <span className="small mono" translate={pick.versionId ? "no" : undefined}>{pick.versionNumber}</span>
      {open && <VersionSheet serverId={serverId} mc={mc} item={item} current={pick.versionId ?? undefined} onPick={(p) => { onPick(p); setOpen(false); }} onClose={() => setOpen(false)} />}
    </span>
  );
}

// 入っているマス: 版を押すと、版を変える・外す
function Installed({ serverId, mc, item, version, filename, onDone }: { serverId: string; mc: string; item: Item; version: string; filename: string; onDone: () => void }) {
  const install = useServerFn(installMod);
  const remove = useServerFn(removeMod);
  const hold = useServerFn(setModHold);
  const toggle = useServerFn(setModEnabled);
  const off = filename.toLowerCase().endsWith(".disabled");
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState(false);
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
      <button type="button" className="pc" translate="no" aria-expanded={open} title="版を変える・無効にする・外す" disabled={busy} onClick={() => setOpen((x) => !x)}>{version}</button>
      {open && !busy && (
        <>
          <button type="button" className="link small" onClick={() => setVersions(true)}>版を変える</button>
          <button type="button" className="link small" onClick={() => act(() => toggle({ data: { id: serverId, filename, enable: off } }))}>{off ? "有効にする" : "無効にする"}</button>
          <button type="button" className="link small danger" onClick={async () => {
            if ((await confirmDialog({ message: `${item.title} を外しますか?(「変更の履歴」から元に戻せます)`, ok: "外す", danger: true }))) act(() => remove({ data: { id: serverId, filename } }));
          }}>外す</button>
        </>
      )}
      {versions && <VersionSheet serverId={serverId} mc={mc} item={item} onClose={() => setVersions(false)} onPick={async (p) => {
        setVersions(false);
        if ((await confirmDialog({ message: `${item.title} を ${p.versionNumber} にしますか?(反映にはサーバーの再起動が要ります)`, ok: "変える" }))) {
          const key = { id: serverId, projectId: item.projectId, source: item.source as never };
          act(async () => {
            await install({ data: { ...key, versionId: p.versionId ?? undefined, unsupported: p.unsupported } });
            if (!p.versionId) await hold({ data: { ...key, hold: false } }); // 合う最新版にしたら、止めていた更新も戻す
          });
        }
      }} />}
      {busy && <span className="small muted">変えています…</span>}
      {error && <span className="small err" role="alert">{error}</span>}
    </span>
  );
}

// ライブラリに無いもののマス(配布元のわからない jar・ライブラリから外したもの): 押すと、ライブラリに取り込む・無効にする・外す
function FileCell({ serverId, filename, label, onDone }: { serverId: string; filename: string; label: string; onDone: () => void }) {
  const adopt = useServerFn(adoptMod);
  const toggle = useServerFn(setModEnabled);
  const remove = useServerFn(removeMod);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const off = filename.toLowerCase().endsWith(".disabled");
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
      <button type="button" className="pc" translate="no" aria-expanded={open} title="ライブラリに取り込む・無効にする・外す" disabled={busy} onClick={() => setOpen((x) => !x)}>{label}</button>
      {off && <span className="badge muted-badge">無効</span>}
      {open && !busy && (
        <>
          <button type="button" className="link small" onClick={() => act(() => adopt({ data: { id: serverId, filename } }))}>ライブラリに取り込む</button>
          <button type="button" className="link small" onClick={() => act(() => toggle({ data: { id: serverId, filename, enable: off } }))}>{off ? "有効にする" : "無効にする"}</button>
          <button type="button" className="link small danger" onClick={async () => {
            if ((await confirmDialog({ message: `${filename} を外しますか?(「変更の履歴」から元に戻せます)`, ok: "外す", danger: true }))) act(() => remove({ data: { id: serverId, filename } }));
          }}>外す</button>
        </>
      )}
      {busy && <span className="small muted">変えています…</span>}
      {error && <span className="small err" role="alert">{error}</span>}
    </span>
  );
}

// 版を選ぶシート(版の一覧は src/lib/version-picker.tsx。サーバーごとに対応の印が違う)。合う最新版のままなら versionId は null
function VersionSheet({ serverId, mc, item, current, onPick, onClose }: { serverId: string; mc: string; item: Item; current?: string; onPick: (p: Pick) => void; onClose: () => void }) {
  return (
    <Sheet title={<span translate="no">{item.title}</span>} label={item.title} onClose={onClose}>
      <VersionChooser args={{ id: serverId, projectId: item.projectId, source: item.source as never }} mc={mc} current={current} label="この版にする"
        onChoose={(v, auto) => onPick(auto ? LATEST : { versionId: v.versionId, versionNumber: v.versionNumber, unsupported: v.support === "no" })} />
    </Sheet>
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

// jar の名前から版を除いた名前(サーバーどうしで同じものを並べるため。例 LuckPerms-Bukkit-5.5.71.jar → LuckPerms-Bukkit)
function baseName(filename: string) {
  return filename.replace(/\.disabled$/i, "").replace(/\.jar$/i, "").replace(/[-_ ]v?\d+(\.\d+)*([-+.][\w.]*)?$/i, "") || filename;
}
