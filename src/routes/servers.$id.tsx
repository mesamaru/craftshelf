import { type ReactNode, useEffect, useState } from "react";
import { Link, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { identifyMods, libraryCatalog, serverChanges, undoChange, installMod, installedMods, modUpdates, removeMod, rollbackMod, searchMods, serverDetail, serverMissingDeps, setModEnabled, setModHold } from "~/lib/library-api";
import { importServerFile } from "~/lib/uploads-api";
import { ApplyResults } from "~/lib/apply-results";
import { ITEM_TYPES, PLATFORMS, STATE_LABELS, kindLabel, kindsOf, supportOf } from "~/lib/platforms";
import { SupportBadge, type VArgs, VersionChooser, type VRow } from "~/lib/version-picker";
import { AddonIcon } from "~/lib/type-icon";
import { listServers, powerServer } from "~/lib/servers-api";
import { filesAccess } from "~/lib/files-api";
import { bindServerSet, copyServer, listSets, syncServerSet, updateServers } from "~/lib/sets-api";
import { SOURCE_LABEL, type Source, pageUrl } from "~/lib/sources";
import { type Status, useServerStatus } from "~/lib/server-status";
import { useCan } from "~/lib/use-can";
import { shared } from "~/lib/shared";
import { softwareInfo } from "~/lib/software-api";
import { createWorldBackup, removeWorldBackup, restoreWorldBackup, setWorldBackup, worldBackups } from "~/lib/worlds-api";
import { Console, Files } from "~/lib/server-files";
import { COPY_LABEL, CopyModeRow, type CopyMode, DAY_NAMES, type SettingKey, SettingSheet, SettingsRows, type SoftInfo } from "~/lib/server-settings";
import { pageTitle } from "~/lib/titles";
import { Btn, Chip, ChipBar, Icon, Info, Menu, Row, Seg, Sheet, Tabs, fmtSize } from "~/lib/ui";

// タブは v02 の並びと名前(「保存」= ワールドのバックアップとアドオンの変更の履歴)
const TABS = [["overview", "概要"], ["console", "コンソール"], ["addons", "アドオン"], ["files", "ファイル"], ["backup", "保存"], ["settings", "設定"]] as const;
type Tab = (typeof TABS)[number][0];
const isTab = (v: unknown): v is Tab => TABS.some(([t]) => t === v);

export const Route = createFileRoute("/servers/$id")({
  // 開いているタブは URL に残す(戻るボタンで前のタブへ)。概要は付けない
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => (isTab(s.tab) && s.tab !== "overview" ? { tab: s.tab } : {}),
  beforeLoad: ({ context, params }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: `/servers/${params.id}` } });
    return { user: context.user };
  },
  loader: ({ params }) => serverDetail({ data: { id: params.id } }),
  head: ({ loaderData }) => ({ meta: [{ title: pageTitle(loaderData ? `サーバー: ${loaderData.name}` : "サーバー") }] }),
  component: ServerPage,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

type Installed = Awaited<ReturnType<typeof installedMods>>["items"][number];
type Update = Awaited<ReturnType<typeof modUpdates>>[number];
type Deps = Awaited<ReturnType<typeof serverMissingDeps>>;
const CONNECTION: Record<string, string> = { ptero: "Pterodactyl", local: "フォルダ", agent: "エージェント" };

// サーバーの詳細(右の欄): 名前・種類 · つなぎ方・状態の印と、概要・コンソール・アドオン・ファイル・保存・設定のタブ。
// 起動・再起動・停止は概要の 3 つのボタン。状態は左の一覧が読んだものを使う(server-status.ts)
function ServerPage() {
  const { user, app } = Route.useRouteContext();
  const server = Route.useLoaderData();
  const tab = Route.useSearch().tab ?? "overview";
  const navigate = useNavigate();
  const { can, me } = useCan(user.id);
  const perms = { update: can({ server: ["update"] }), edit: can({ library: ["edit"] }), admin: can({ member: ["update"] }), remove: can({ server: ["delete"] }) };
  const control = !!me && can({ server: ["control"] });

  const { st: all, refresh } = useServerStatus();
  const st: Status | null = typeof all[server.id] === "object" ? (all[server.id] as Status) : null;
  const list = useServerFn(installedMods);
  const check = useServerFn(modUpdates);
  const missingDeps = useServerFn(serverMissingDeps);
  const loadSoft = useServerFn(softwareInfo);
  const access = useServerFn(filesAccess);
  const [items, setItems] = useState<Installed[] | null>(null);
  const [datapacks, setDatapacks] = useState<string | null>(null); // ワールドのデータパックのフォルダ
  const [updates, setUpdates] = useState<Map<string, Update> | null>(null);
  const [deps, setDeps] = useState<Deps | null>(null);
  const [soft, setSoft] = useState<SoftInfo | string | null>(null);
  const [files, setFiles] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<SettingKey | "">("");
  const [version, setVersion] = useState(0); // 設定を変えたら、設定のタブの要約を読み直す

  const reloadSoft = () => loadSoft({ data: { id: server.id } }).then(setSoft, (e) => setSoft(message(e)));
  useEffect(() => { reloadSoft(); shared("files-access", () => access(), 5000).then((a) => setFiles(a.allowed), () => setFiles(false)); }, [server.id]);
  const checkDeps = () => { if (server.profile) missingDeps({ data: { id: server.id } }).then(setDeps, () => setDeps(null)); };
  // 更新があるかは配布元に問い合わせる(開いたときと、入れたあと)
  const checkUpdates = () => check({ data: { id: server.id } }).then((u) => setUpdates(new Map(u.map((x) => [x.filename, x]))), (e) => setError(message(e)));
  const reload = () => {
    if (!server.profile) return;
    list({ data: { id: server.id } }).then((r) => { setItems(r.items); setDatapacks(r.datapacks); setError(""); }, (e) => setError(message(e)));
  };
  useEffect(() => {
    setItems(null);
    setUpdates(null);
    setDeps(null);
    reload();
    checkDeps();
    if (server.profile) checkUpdates();
  }, [server.id, server.profile?.platform, server.profile?.mcVersion]);

  const go = (t: Tab) => navigate({ to: "/servers/$id", params: { id: server.id }, search: t === "overview" ? {} : { tab: t } });
  const tabs = TABS.filter(([t]) => t !== "console" || control).map(([t, n]) => [t, t === "addons" && items ? `${n} ${items.length}` : n] as const);
  const shown = tabs.some(([t]) => t === tab) ? tab : "overview";
  const addons = { id: server.id, profile: server.profile, items, updates, deps, error, edit: perms.edit, local: app.mode === "self",
    dir: server.profile ? [PLATFORMS[server.profile.platform as keyof typeof PLATFORMS]?.dir, datapacks].filter(Boolean).map((d) => `${d}/`).join("・") : "",
    sources: server.sources as Source[], onChange: () => { reload(); checkDeps(); }, onUpdates: checkUpdates, setUpdates };
  const kind = kindLabel(server.profile?.platform, server.profile?.mcVersion);
  const state = st?.state ?? "";

  return (
    <div className="srv-page" key={server.id}>
      <Link to="/servers" className="back srv-back">‹ サーバー</Link>
      <div className="srv-hero">
        <div className="m">
          <h2 translate="no">{server.name}</h2>
          <small>{kind && <span translate="no">{`${kind} · `}</span>}{CONNECTION[server.kind] ?? server.kind}</small>
        </div>
        <span className={`spill${state === "running" ? " ok" : state === "starting" || state === "stopping" ? " warn" : ""}`}>
          <span className={`dot ${state}`} aria-hidden="true" />{!st ? "確認中…" : STATE_LABELS[state] ?? "状態がわかりません"}
        </span>
      </div>
      <Tabs label="サーバーの画面" value={shown} options={tabs} onChange={go} />
      {shown === "overview" && <Overview {...addons} st={st} state={state} control={control} server={server} soft={soft} onPower={() => refresh(server.id)}
        onSoftware={() => setSheet("software")} onProfile={() => setSheet("profile")} canProfile={perms.update} onTab={go}
        onSetup={server.kind === "local" && perms.update && perms.admin ? () => { go("settings"); setSheet("control"); } : undefined} />}
      {shown === "addons" && <Addons {...addons} onProfile={() => setSheet("profile")} canProfile={perms.update} />}
      {shown === "files" && (files === null ? <p className="muted">読み込んでいます…</p> : files ? <Files id={server.id} />
        : <section className="group"><div className="row muted">設定ファイルを見る・直すのは、チームの管理者とオーナーだけです(チームの設定で、編集者にも許せます)。</div></section>)}
      {shown === "console" && <Console id={server.id} local={server.kind === "local"} />}
      {shown === "backup" && <Backup id={server.id} control={control} admin={perms.update} edit={perms.edit} items={items} onChange={addons.onChange} />}
      {shown === "settings" && <SettingsRows server={server} perms={perms} soft={soft} version={version} onOpen={setSheet} />}
      {sheet && <SettingSheet kind={sheet} server={server} perms={perms} soft={soft} reloadSoft={reloadSoft} onChanged={() => setVersion((v) => v + 1)} onClose={() => setSheet("")} />}
    </div>
  );
}

// 起動・再起動・停止(v02 の 3 つのボタン。いまの状態でできないものは薄くする)
function Power({ server, state, onPower, onSetup }: { server: { id: string; name: string }; state: string; onPower: () => void; onSetup?: () => void }) {
  const power = useServerFn(powerServer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async (signal: "start" | "stop" | "restart") => {
    if (signal === "stop" && !confirm(`${server.name} を停止しますか?`)) return;
    setBusy(true);
    setError("");
    try {
      await power({ data: { id: server.id, signal } });
      onPower();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const off = state === "offline";
  const tile = (signal: "start" | "restart" | "stop", icon: "play" | "reload" | "stop", label: string, disabled: boolean) => (
    <button type="button" className="glass" disabled={busy || disabled} onClick={() => send(signal)}><Icon name={icon} /><span>{label}</span></button>
  );
  return (
    <>
      <div className="srv-qacts pw3">
        {tile("start", "play", "起動", state === "running" || state === "starting")}
        {tile("restart", "reload", "再起動", off)}
        {tile("stop", "stop", "停止", off)}
      </div>
      {error && (
        <p className="error" role="alert">{error}
          {onSetup && error.includes("起動・停止の設定") && <> <button type="button" className="link small" onClick={onSetup}>起動・停止の設定を開く</button></>}
        </p>
      )}
    </>
  );
}

type AddonProps = {
  id: string; profile: { platform: string; mcVersion: string | null } | null; items: Installed[] | null; updates: Map<string, Update> | null; deps: Deps | null; error: string;
  edit: boolean; local: boolean; dir: string; sources: Source[]; onChange: () => void; onUpdates: () => Promise<unknown>; setUpdates: (u: Map<string, Update> | null) => void;
  onProfile: () => void; canProfile: boolean;
};

// 概要: 起動・再起動・停止、人数・CPU・メモリ・応答、やること(押すと直せる)、最近の変更
function Overview({ st, state, control, server, soft, onPower, onSoftware, onTab, onSetup, ...a }:
  AddonProps & { st: Status | null; state: string; control: boolean; server: { id: string; name: string }; soft: SoftInfo | string | null; onPower: () => void; onSoftware: () => void; onTab: (t: Tab) => void; onSetup?: () => void }) {
  const run = useServerFn(updateServers);
  const install = useServerFn(installMod);
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof updateServers>>[number] | null>(null);
  const [error, setError] = useState("");
  const p = st?.ping;
  const cpu = st?.cpu ?? null;
  const n = a.updates ? [...a.updates.keys()].filter((f) => !a.items?.find((m) => m.filename === f)?.disabled).length : 0;
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      a.onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const info = typeof soft === "object" ? soft : null;
  const todo = (a.profile && a.updates && n > 0 ? 1 : 0) + (a.deps?.missing.length ?? 0) + (a.deps?.unmet.length ?? 0) + (info?.update ? 1 : 0) + (a.profile ? 0 : 1);
  return (
    <>
      {control && <Power server={server} state={state} onPower={onPower} onSetup={onSetup} />}
      <div className="stats">
        <div className="stat glass"><small>プレイヤー</small><div className="v">{p ? p.online : "—"}{p && <span>{` / ${p.max}`}</span>}</div>
          {p && p.sample.length > 0 && <span className="sub" translate="no">{p.sample.join("、")}{p.online > p.sample.length ? " …" : ""}</span>}</div>
        <div className="stat glass"><small>CPU</small><div className="v">{cpu != null ? Math.round(cpu) : "—"}{cpu != null && <span> %</span>}</div>
          {cpu != null && <div className="meter"><i style={{ width: `${Math.min(100, cpu)}%` }} /></div>}</div>
        <div className="stat glass"><small>メモリ</small><div className="v">{st?.memory != null ? (st.memory / 1024 ** 3).toFixed(1) : "—"}{st?.memory != null && <span> GB</span>}</div></div>
        <div className="stat glass"><small>応答</small><div className="v">{p ? p.latency : "—"}{p && <span> ms</span>}</div>
          {p?.version && <span className="sub" translate="no">{p.version}</span>}</div>
      </div>
      <div className="two">
        <div>
          <div className="gtitle">やること</div>
          <section className="group">
            {!a.profile && (
              <div className="row">
                <span className="badge upd">種類</span>
                <span className="mid"><span className="ttl">種類が決まっていません</span><span className="sub">決めると、アドオンを探して入れられます</span></span>
                {a.canProfile && <Btn kind="tint" sm onClick={a.onProfile}>決める</Btn>}
              </div>
            )}
            {a.profile && !a.updates && <div className="row muted">更新を確かめています…</div>}
            {n > 0 && (
              <Row onClick={() => onTab("addons")}>
                <span className="badge upd">{`更新 ${n}`}</span>
                <span className="mid"><span className="ttl">{`新しい版 ${n} 件`}</span></span>
                {a.edit && <Btn kind="tint" sm disabled={!!busy} onClick={(e) => { e.stopPropagation(); act("all", async () => {
                  const [r] = await run({ data: { ids: [a.id] } });
                  if (r?.error) throw new Error(r.error);
                  setResults(r ?? null);
                  await a.onUpdates();
                }); }}>{busy === "all" ? "最新にしています…" : "最新にする"}</Btn>}
              </Row>
            )}
            {a.deps?.unmet.map((d) => (
              <div className="row" key={`unmet:${d.name}`}>
                <span className="badge bad">前提</span>
                <span className="mid"><span className="ttl" translate="no">{d.name}</span><span className="sub"><span translate="no">{d.by.join("、")}</span> が使います(入っていません)</span></span>
              </div>
            ))}
            {a.deps?.missing.map((d) => (
              <div className="row" key={`dep:${d.source}:${d.projectId}`}>
                <span className="badge bad">前提</span>
                <AddonIcon type={d.projectType} url={d.iconUrl} />
                <span className="mid"><span className="ttl" translate="no">{d.title}</span><span className="sub"><span translate="no">{d.by.join("、")}</span> が使います</span></span>
                {a.edit && <Btn kind="tint" sm disabled={!!busy} onClick={() => act(`dep:${d.projectId}`, () => install({ data: { id: a.id, projectId: d.projectId, source: d.source } }))}>
                  {busy === `dep:${d.projectId}` ? "入れています…" : "入れる"}</Btn>}
              </div>
            ))}
            {info?.update && (
              <Row onClick={onSoftware}>
                <span className="badge ok">本体</span>
                <span className="mid"><span className="ttl" translate="no">{`${info.label} ${info.latest?.build ?? ""}`}</span><span className="sub">新しいビルドがあります</span></span>
                <span className="chev" aria-hidden="true">›</span>
              </Row>
            )}
            {a.updates && todo === 0 && <div className="row muted">やることはありません</div>}
            {a.error && <p className="row error" role="alert">{a.error}</p>}
            {results && <ApplyResults server={results.server} verb="最新にした" list={results.results} empty="新しい版はありませんでした。" />}
            {error && <p className="row error" role="alert">{error}</p>}
          </section>
        </div>
        <div>
          <div className="gtitle">最近の変更</div>
          <Changes id={a.id} edit={a.edit} items={a.items} onChange={a.onChange} limit={5} onMore={() => onTab("backup")} />
        </div>
      </div>
    </>
  );
}

// アドオン: 絞り込み(入っている・更新あり・無効)、そろえる・入れる、行の「⋯」で 版を変える・更新を止める・無効にする・外す など
function Addons(a: AddonProps) {
  const { id, items, updates, edit } = a;
  const identify = useServerFn(identifyMods);
  const toggle = useServerFn(setModEnabled);
  const importFile = useServerFn(importServerFile);
  const install = useServerFn(installMod);
  const remove = useServerFn(removeMod);
  const hold = useServerFn(setModHold);
  const rollback = useServerFn(rollbackMod);
  const [filter, setFilter] = useState<"" | "old" | "off">("");
  const [sheet, setSheet] = useState<"" | "search" | "sync">("");
  const [versionsOf, setVersionsOf] = useState<Installed | null>(null);
  const [busy, setBusy] = useState("");
  const [found, setFound] = useState("");
  const [err, setErr] = useState("");
  if (!a.profile) {
    return (
      <section className="group">
        <div className="row">
          <span className="main muted">サーバーの種類を選ぶと、合う Mod・プラグインを探せるようになります。</span>
          {a.canProfile && <Btn kind="pri" sm onClick={a.onProfile}>種類を選ぶ</Btn>}
        </div>
      </section>
    );
  }
  const type = PLATFORMS[a.profile.platform as keyof typeof PLATFORMS]?.type ?? "plugin";
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr("");
    try {
      await fn();
      a.onChange();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy("");
    }
  };
  const upd = (m: Installed) => (m.disabled ? undefined : updates?.get(m.filename));
  const old = items?.filter((m) => upd(m)).length ?? 0;
  const off = items?.filter((m) => m.disabled).length ?? 0;
  const shown = (items ?? []).filter((m) => (filter === "old" ? !!upd(m) : filter === "off" ? m.disabled : true));
  const unknown = items?.filter((m) => !m.projectId).length ?? 0;

  return (
    <>
      <ChipBar label="絞り込み" tools={<>
        <Btn kind="tint" sm onClick={() => setSheet("sync")}>そろえる</Btn>
        {edit && <Btn kind="pri" sm onClick={() => setSheet("search")}>＋ 入れる</Btn>}
      </>}>
        <Chip on={!filter} onClick={() => setFilter("")}>入っている{items && <span className="n">{items.length}</span>}</Chip>
        <Chip on={filter === "old"} warn onClick={() => setFilter(filter === "old" ? "" : "old")}>更新あり{updates && <span className="n">{old}</span>}</Chip>
        <Chip on={filter === "off"} onClick={() => setFilter(filter === "off" ? "" : "off")}>無効<span className="n">{off}</span></Chip>
      </ChipBar>

      {a.deps && (a.deps.missing.length > 0 || a.deps.unmet.length > 0) && (
        <section className="group">
          {a.deps.unmet.map((d) => (
            <div className="row" key={`unmet:${d.name}`}>
              <span className="badge bad">前提不足</span>
              <span className="mid"><span className="ttl" translate="no">{d.name}</span><span className="sub"><span translate="no">{d.by.join("、")}</span> が使います(入っていません)</span></span>
            </div>
          ))}
          {a.deps.missing.map((d) => (
            <div className="row" key={`dep:${d.source}:${d.projectId}`}>
              <span className="badge bad">前提不足</span>
              <AddonIcon type={d.projectType} url={d.iconUrl} />
              <span className="mid"><span className="ttl" translate="no">{d.title}</span><span className="sub"><span translate="no">{d.by.join("、")}</span> が使います</span></span>
              {edit && <Btn kind="tint" sm disabled={!!busy} onClick={() => run(`dep:${d.projectId}`, () => install({ data: { id, projectId: d.projectId, source: d.source } }))}>
                {busy === `dep:${d.projectId}` ? "入れています…" : "入れる"}</Btn>}
            </div>
          ))}
        </section>
      )}

      <div className="gtitle">{`入っているもの(${a.dir})`}
        <Info>
          <span>Modrinth・SpigotMC から入れたものは、版と更新がわかります。それ以外のファイルは名前だけを表示します(「配布元を探す」で、ファイルの中身から Modrinth・CurseForge のものかを確かめられます)。「更新を止める」にしたものは、セットでそろえる・予約・更新の確認で新しい版にしません。変更はサーバーの再起動で反映されます。</span>
          <span>「無効にする」と、ファイルを消さずに名前の最後に .disabled を付けて止めます(更新・自動更新の対象からも外れます)。自動更新は、ライブラリ(配布元・アップロード)に新しい版が出たら入れます。「更新を止める」にしたもの・無効にしたものは入れ替えません。</span>
        </Info>
      </div>
      <section className="group">
        {!items && !a.error && <div className="row muted">サーバーに問い合わせています…</div>}
        {items?.length === 0 && <div className="row muted">まだ何も入っていません。</div>}
        {items && items.length > 0 && shown.length === 0 && <div className="row muted">条件に合うものはありません</div>}
        {shown.map((m) => {
          const u = upd(m);
          return (
            <div className="row" key={m.filename}>
              <AddonIcon type={m.datapack ? "datapack" : type} url={m.iconUrl} />
              <span className="mid">
                <span className="ttl">
                  <span translate="no">{m.title ?? m.name ?? m.filename}</span>
                  {m.datapack && <span className="tag">データパック</span>}
                  {m.disabled && <span className="tag">無効</span>}
                  {m.held && <span className="tag">更新を止めています</span>}
                  {m.pinned && <span className="tag" title="結び付けたセットで版を固定しています">固定</span>}
                </span>
                <span className="sub" translate="no">{u ? <>{m.versionNumber} → <b>{u.latest}</b></> : m.title ? `${m.versionNumber} · ${m.filename}` : m.name ? `${m.version ? `${m.version} · ` : ""}${m.filename}` : m.filename}</span>
              </span>
              {u && edit && (
                <Btn kind="tint" sm disabled={!!busy} onClick={() => run(m.filename, async () => {
                  await install({ data: { id, projectId: u.projectId, source: u.source } });
                  const n = new Map(updates);
                  n.delete(m.filename);
                  a.setUpdates(n);
                })}>{busy === m.filename ? "更新中…" : "更新"}</Btn>
              )}
              {edit && (
                <Menu label={`${m.title ?? m.filename} の操作`} disabled={!!busy} items={[
                  m.projectId && m.source && !m.disabled && { label: "版を変える", onClick: () => setVersionsOf(m) },
                  m.canRollback && m.projectId && m.source && !m.disabled && { label: "前の版に戻す", onClick: () => confirm(`${m.title} を前の版に戻しますか?(戻したあとは「更新を止める」になります)`) && run(`rb:${m.filename}`, () => rollback({ data: { id, projectId: m.projectId!, source: m.source as Source } })) },
                  m.projectId && m.source && { label: m.held ? "止めるのをやめる" : "更新を止める", onClick: () => run(`hold:${m.filename}`, () => hold({ data: { id, projectId: m.projectId!, source: m.source as Source, hold: !m.held } })) },
                  a.local && !m.projectId && { label: "ライブラリに取り込む", onClick: () => run(`imp:${m.filename}`, () => importFile({ data: { id, filename: m.filename } })) },
                  { label: m.disabled ? "有効にする" : "無効にする", onClick: () => run(`tg:${m.filename}`, () => toggle({ data: { id, filename: m.filename, enable: m.disabled } })) },
                  { label: "外す", danger: true, onClick: () => confirm(`${m.title ?? m.filename} を外しますか?(「変更の履歴」から元に戻せます)`) && run(m.filename, () => remove({ data: { id, filename: m.filename } })) },
                ]} />
              )}
            </div>
          );
        })}
        {edit && unknown > 0 && (
          <button className="row link" type="button" disabled={!!busy} onClick={() => run("identify", async () => {
            const r = await identify({ data: { id } });
            setFound(`${r.checked} 個を調べ、${r.found.length} 個の配布元が見つかりました${r.missing.length ? `。見つからなかったもの: ${r.missing.join("、")}` : ""}${r.curseforge ? "" : "(CurseForge は、API キーを設定すると探せます)"}`);
          })}>
            {busy === "identify" ? "ファイルの中身から探しています…" : `配布元を探す(わからないもの ${unknown} 個)`}
          </button>
        )}
        {items && items.some((m) => m.projectId) && (
          <button className="row link" type="button" disabled={!!busy} onClick={() => run("check", a.onUpdates)}>
            {busy === "check" ? "確かめています…" : updates ? `更新を確かめる(${old} 件あり)` : "更新を確かめる"}
          </button>
        )}
        {found && <p className="row muted" role="status" translate="no">{found}</p>}
        {(a.error || err) && <p className="row error" role="alert">{a.error || err}</p>}
      </section>

      {sheet === "search" && (
        <Sheet title="入れる" onClose={() => setSheet("")}>
          <AddSheet id={id} installed={items ?? []} datapacks={kindsOf(a.profile.platform as keyof typeof PLATFORMS).includes("datapack")} type={type} mc={a.profile.mcVersion ?? ""}
            sources={a.sources.filter((s) => s !== "spigot" || type === "plugin")} onInstalled={a.onChange} />
        </Sheet>
      )}
      {sheet === "sync" && (
        <Sheet title="そろえる" onClose={() => setSheet("")}>
          <SetBinding id={id} edit={edit} onSynced={a.onChange} />
        </Sheet>
      )}
      {versionsOf && <Versions id={id} item={versionsOf} mc={a.profile.mcVersion ?? ""} onDone={() => { a.onChange(); a.onUpdates(); }} onClose={() => setVersionsOf(null)} />}
    </>
  );
}

// 版を変える: 版の一覧(このサーバーへの対応の印つき)から選んで入れ替える
function Versions({ id, item, mc, onDone, onClose }: { id: string; item: Installed; mc: string; onDone: () => void; onClose: () => void }) {
  const install = useServerFn(installMod);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState({ id: item.versionId, number: item.versionNumber }); // 変えたら「今」の印と見出しも変える
  const args: VArgs = { id, projectId: item.projectId!, source: item.source as Source, kind: item.datapack ? "datapack" : undefined };
  const pick = async (v: VRow) => {
    setBusy(true);
    setError("");
    try {
      await install({ data: { ...args, versionId: v.versionId, unsupported: v.support === "no" } });
      setNow({ id: v.versionId, number: v.versionNumber });
      setNote(`${v.versionNumber} にしました`);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={<span translate="no">{item.title}</span>} label={item.title ?? item.filename} onClose={onClose}>
      <p className="sub">版を変える · 今 <span translate="no">{now.number}</span></p>
      <VersionChooser args={args} mc={mc} current={now.id} label={busy ? "入れています…" : "この版にする"} busy={busy} onChoose={pick} />
      {note && <p className="muted" role="status" translate="no">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Sheet>
  );
}

// 入れるもの 1 つ(1 段目で選んだもの)
type Chosen = { source: Source | "upload"; projectId: string; title: string; iconUrl: string; type: "plugin" | "mod" | "datapack" };

// 入れる(2 段): 1 段目 = プラグイン(Mod)の一覧(配布元で探す / ライブラリ)、2 段目 = そのものの版の一覧。
// 一覧の「対応」の印は、このサーバーの Minecraft に対応する版があるか
function AddSheet({ id, installed, sources, datapacks, type, mc, onInstalled }:
  { id: string; installed: Installed[]; sources: Source[]; datapacks: boolean; type: "plugin" | "mod"; mc: string; onInstalled: () => void }) {
  const [tab, setTab] = useState<"find" | "library">("find");
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const key = (src: string, projectId: string) => `${src}:${projectId}`;
  const have = new Set([...installed.filter((m) => m.projectId).map((m) => key(m.source ?? "", m.projectId!)), ...done]);
  if (chosen) {
    return <PickVersion id={id} mc={mc} chosen={chosen} onBack={() => setChosen(null)}
      onInstalled={() => { setDone((d) => new Set(d).add(key(chosen.source, chosen.projectId))); onInstalled(); }} />;
  }
  return (
    <>
      <Seg label="入れるもの" value={tab} options={[["find", "探す"], ["library", "ライブラリ"]] as const} onChange={setTab} />
      {tab === "find"
        ? <Find id={id} have={have} sources={sources} datapacks={datapacks} type={type} onChoose={setChosen} />
        : <FromLibrary have={have} mc={mc} datapacks={datapacks} type={type} onChoose={setChosen} />}
    </>
  );
}

// 1 段目の「探す」: 配布元の検索結果(合うものを先に)
function Find({ id, have, sources, datapacks, type, onChoose }:
  { id: string; have: Set<string>; sources: Source[]; datapacks: boolean; type: "plugin" | "mod"; onChoose: (c: Chosen) => void }) {
  const search = useServerFn(searchMods);
  const [source, setSource] = useState<Source>("modrinth");
  const [kind, setKind] = useState<"" | "datapack">(""); // datapack なら、ワールドのデータパックを探す
  const shown = kind ? sources.filter((s) => s !== "spigot") : sources;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchMods>> | null>(null);
  const [error, setError] = useState("");

  const find = async (src = source, k = kind) => {
    setError("");
    try {
      setHits(await search({ data: { id, query, source: src, kind: k || undefined } }));
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => { find(); }, [id]);
  const pickSource = (s: Source) => { setSource(s); setHits(null); find(s); };
  const pickKind = (k: "" | "datapack") => { const s = k && source === "spigot" ? "modrinth" : source; setKind(k); setSource(s); setHits(null); find(s, k); };

  return (
    <>
      <form onSubmit={(e) => (e.preventDefault(), find())}>
        <input className="input" type="search" placeholder="名前(空なら人気順)" aria-label="名前で探す" value={query} onChange={(e) => setQuery(e.target.value)} />
      </form>
      <div className="chips">
        {shown.length > 1 && shown.map((s) => <Chip key={s} on={source === s} onClick={() => pickSource(s)}>{SOURCE_LABEL[s]}</Chip>)}
        {datapacks && <>
          <span className="vsep" />
          <Chip on={!kind} onClick={() => pickKind("")}>{ITEM_TYPES[type]}</Chip>
          <Chip on={kind === "datapack"} onClick={() => pickKind("datapack")}>{ITEM_TYPES.datapack}</Chip>
        </>}
      </div>
      <section className="group">
        {!hits && !error && <div className="row muted">探しています…</div>}
        {hits?.length === 0 && <div className="row muted">見つかりませんでした。</div>}
        {hits?.map((h) => {
          const installed = have.has(`${source}:${h.projectId}`);
          return (
            <Row key={h.projectId} onClick={installed ? undefined : () => onChoose({ source, projectId: h.projectId, title: h.title, iconUrl: h.iconUrl, type: kind || type })}>
              <AddonIcon type={kind || type} url={h.iconUrl} />
              <span className="mid">
                <a className="ttl name" href={pageUrl(source, h.projectId, h.slug)} target="_blank" rel="noreferrer noopener" translate="no" onClick={(e) => e.stopPropagation()}>{h.title}</a>
                <span className="sub" translate="no">{h.summary}</span>
                <span className="sub">{`${SOURCE_LABEL[source]} · ${h.downloads.toLocaleString("ja-JP")} ダウンロード`}</span>
              </span>
              {installed ? <span className="badge ok">入っています</span> : <><SupportBadge s={h.support} /><span className="chev" aria-hidden="true">›</span></>}
            </Row>
          );
        })}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// 1 段目の「ライブラリ」: チームのライブラリのもののうち、このサーバーに入れられる種類で、まだ入っていないもの
function FromLibrary({ have, mc, datapacks, type, onChoose }: { have: Set<string>; mc: string; datapacks: boolean; type: "plugin" | "mod"; onChoose: (c: Chosen) => void }) {
  const load = useServerFn(libraryCatalog);
  const [items, setItems] = useState<Awaited<ReturnType<typeof libraryCatalog>>["items"] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { load().then((c) => setItems(c.items), (e) => setError(message(e))); }, []);
  const q = query.trim().toLowerCase();
  const list = (items ?? []).filter((i) => (i.projectType === type || (datapacks && i.projectType === "datapack")) && (!q || i.title.toLowerCase().includes(q)));
  return (
    <>
      <input className="input" type="search" placeholder="名前" aria-label="ライブラリから探す" value={query} onChange={(e) => setQuery(e.target.value)} />
      <section className="group">
        {!items && !error && <div className="row muted">読み込んでいます…</div>}
        {items && list.length === 0 && <div className="row muted">入れられるものがライブラリにありません</div>}
        {list.map((i) => {
          const installed = have.has(`${i.source}:${i.projectId}`);
          return (
            <Row key={i.id} onClick={installed ? undefined : () => onChoose({ source: i.source as Source | "upload", projectId: i.projectId, title: i.title, iconUrl: i.iconUrl, type: i.projectType as Chosen["type"] })}>
              <AddonIcon type={i.projectType} url={i.iconUrl} />
              <span className="mid">
                <span className="ttl" translate="no">{i.title}</span>
                <span className="sub">{[SOURCE_LABEL[i.source as Source | "upload"], i.version].filter(Boolean).join(" · ")}</span>
              </span>
              {installed ? <span className="badge ok">入っています</span> : <><SupportBadge s={supportOf(mc, i.mc, i.source === "spigot")} /><span className="chev" aria-hidden="true">›</span></>}
            </Row>
          );
        })}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// 2 段目: 選んだものの版の一覧。合う最新版を選んでおき、どの版でも選べる。入れたら前提も知らせる
function PickVersion({ id, mc, chosen, onBack, onInstalled }: { id: string; mc: string; chosen: Chosen; onBack: () => void; onInstalled: () => void }) {
  const install = useServerFn(installMod);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const kind = chosen.type === "datapack" ? "datapack" as const : undefined;
  const put = async (v: VRow, auto: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await install({ data: { id, projectId: chosen.projectId, source: chosen.source, kind, versionId: auto ? undefined : v.versionId, unsupported: v.support === "no" } });
      setDone(true);
      setNote(`${r.title} ${r.versionNumber} を入れました${r.deps.length ? `。前提も入れました: ${r.deps.map((d) => (d.ok ? `${d.title} ${d.detail}` : `${d.title}(入れられません: ${d.detail})`)).join("、")}` : ""}`);
      onInstalled();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="pick-back" onClick={onBack}>‹ 一覧へ</button>
      <div className="pick-head">
        <AddonIcon type={chosen.type} url={chosen.iconUrl} size="lg" />
        <span className="mid"><span className="ttl" translate="no">{chosen.title}</span><span className="sub">{chosen.source === "upload" ? "アップロード" : SOURCE_LABEL[chosen.source]}</span></span>
      </div>
      {done ? <p className="notice" role="status">{note}</p>
        : <VersionChooser args={{ id, projectId: chosen.projectId, source: chosen.source, kind }} mc={mc} label={busy ? "入れています…" : "入れる"} busy={busy} onChoose={put} />}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// このサーバーに結び付けたセットと、そろえる。そろえる元は結び付けたセットか、ほかのサーバー。
// そろえ方は 3 通り(入っているものだけ合わせる・足りないものも入れる・まったく同じにする)
function SetBinding({ id, edit, onSynced }: { id: string; edit: boolean; onSynced: () => void }) {
  const server = Route.useLoaderData();
  const name = server.name;
  const load = useServerFn(listSets);
  const loadServers = useServerFn(listServers);
  const bind = useServerFn(bindServerSet);
  const sync = useServerFn(syncServerSet);
  const copy = useServerFn(copyServer);
  const [sets, setSets] = useState<Awaited<ReturnType<typeof listSets>> | null>(null);
  const [others, setOthers] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ server: string; list: Awaited<ReturnType<typeof syncServerSet>> } | null>(null);
  const [mode, setMode] = useState<CopyMode>("add");
  const [from, setFrom] = useState("set");
  const reload = () => { load().then(setSets, (e) => setError(message(e))); };
  useEffect(reload, [id]);
  useEffect(() => { if (edit) loadServers().then((l) => setOthers(l.filter((x) => x.id !== id)), () => setOthers([])); }, [id, edit]);
  const current = sets?.find((x) => x.servers.some((v) => v.id === id)) ?? null;
  const source = from === "set" ? (current ? "set" : others[0]?.id ?? "") : from;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const doSync = () => {
    const what = source === "set" ? `セット「${current?.name}」` : `「${others.find((o) => o.id === source)?.name}」`;
    if (!confirm(mode === "mirror"
      ? `「${name}」を${what}にそろえ、そろえる元に無いもの(このアプリで入れたもの)を外します。よろしいですか?`
      : `「${name}」を${what}にそろえますか?(${COPY_LABEL[mode]})`)) return;
    run("sync", async () => {
      if (source === "set") setResults({ server: name, list: await sync({ data: { serverId: id, mode } }) });
      else {
        const [r] = await copy({ data: { from: source, to: [id], mode } });
        if (r?.error) throw new Error(r.error);
        setResults({ server: name, list: r?.results ?? [] });
      }
      onSynced();
    });
  };

  if (!sets) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">読み込んでいます…</p>;
  return (
    <>
      <p className="sub">セットか、ほかのサーバーと同じにします
        <Info>「入っているものだけ合わせる」は、入っているものだけを新しい版(ほかのサーバーなら同じ版)にします。「足りないものも入れる」は、無いものも入れます。「まったく同じにする」は、さらにそろえる元に無いもの(このアプリで入れたもの)を外します。セットは、このサーバーの種類に合うものだけを入れます。「更新を止める」にしたもの・無効にしたものは変えません。外したもの・入れ替えたものは「変更の履歴」から元に戻せます。</Info>
      </p>
      <section className="group">
        <div className="row">
          <span>結び付けるセット</span>
          {edit ? (
            <select className="trail" value={current?.id ?? ""} disabled={!!busy} aria-label="結び付けるセット"
              onChange={(e) => { const setId = e.target.value || null; run("bind", async () => { await bind({ data: { serverId: id, setId } }); setResults(null); reload(); }); }}>
              <option value="">なし</option>
              {sets.map((x) => <option key={x.id} value={x.id} translate="no">{x.name}({x.items.length} 件)</option>)}
            </select>
          ) : <span className="trail" translate="no">{current?.name ?? "なし"}</span>}
        </div>
        {edit && (current || others.length > 0) && (
          <>
            <div className="row">
              <span>そろえる元</span>
              <select className="trail" value={source} disabled={!!busy} aria-label="そろえる元" onChange={(e) => setFrom(e.target.value)}>
                {current && <option value="set">{`結び付けたセット(${current.name})`}</option>}
                {others.map((o) => <option key={o.id} value={o.id} translate="no">{o.name}</option>)}
              </select>
            </div>
            <CopyModeRow mode={mode} onChange={setMode} disabled={!!busy} />
          </>
        )}
        {edit && sets.length === 0 && <div className="row muted">まだセットがありません。トップの「セット」で作れます。</div>}
        {results && <ApplyResults server={results.server} verb="そろえた" list={results.list} empty="変えるものはありませんでした。" />}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {edit && (current || others.length > 0) && (
        <div className="sheet-foot"><span className="grow" /><Btn kind="pri" disabled={!!busy || !source} onClick={doSync}>{busy === "sync" ? "そろえています…" : "そろえる"}</Btn></div>
      )}
    </>
  );
}

// アドオンの変更の履歴(新しい順)。外したもの・入れたもの・更新を元に戻せる(編集者以上)。limit を付けると最近のものだけ
function Changes({ id, edit, items, onChange, limit, onMore }: { id: string; edit: boolean; items: Installed[] | null; onChange: () => void; limit?: number; onMore?: () => void }) {
  const load = useServerFn(serverChanges);
  const undo = useServerFn(undoChange);
  const [list, setList] = useState<Awaited<ReturnType<typeof serverChanges>> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // 開いた直後と、アドオンの一覧が読めたあとで 2 回走るので、続けて読むときは共有する(書き込みのあとは取り直す。src/lib/shared.ts)
  useEffect(() => { shared(`changes:${id}`, () => load({ data: { id } }), 3000).then(setList, (e) => setError(message(e))); }, [id, items]);
  const cut = limit ?? 10;
  const shown = list ? (open ? list : list.slice(0, cut)) : [];
  return (
    <section className="group">
      {!list && !error && <div className="row muted">読み込んでいます…</div>}
      {list?.length === 0 && <div className="row muted">まだありません。</div>}
      {shown.map((c) => (
        <div className={`row${c.undone ? " faded" : ""}`} key={c.id}>
          <AddonIcon type={c.type} url={c.iconUrl} />
          <span className="mid">
            <span className="ttl"><span translate="no">{c.title}</span>{` を${({ 外す: "外した", 更新: "更新した", 無効にする: "無効にした", 有効にする: "有効にした" } as Record<string, string>)[c.action] ?? "入れた"}`}{c.config && <span className="tag">設定も退避</span>}</span>
            <span className="sub" translate="no">{new Date(c.at).toLocaleString("ja-JP")}{c.by ? ` · ${c.by}` : ""}{c.action === "更新" && c.version ? ` · 前の版 ${c.version}` : ""}{c.undone ? " · 元に戻しました" : ""}</span>
          </span>
          {edit && c.undoable && (
            <Btn sm disabled={!!busy} onClick={async () => {
              if (!confirm(c.action === "外す" ? `${c.title} を元に戻しますか?(外したファイルを戻します)` : c.action === "入れる" ? `${c.title} を外しますか?(入れる前に戻します)`
                : c.action === "無効にする" ? `${c.title} を有効に戻しますか?` : c.action === "有効にする" ? `${c.title} を無効に戻しますか?`
                : `${c.title} を前の版(${c.version})に戻しますか?(戻したあとは「更新を止める」になります)`)) return;
              setBusy(c.id);
              setError("");
              try {
                await undo({ data: { id, changeId: c.id } });
                onChange();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy("");
              }
            }}>{busy === c.id ? "戻しています…" : "元に戻す"}</Btn>
          )}
        </div>
      ))}
      {list && list.length > cut && (onMore
        ? <button className="row link" type="button" onClick={onMore}>{`すべて見る(${list.length} 件)`}</button>
        : <button className="row link" type="button" onClick={() => setOpen((x) => !x)}>{open ? "閉じる" : `すべて見る(${list.length} 件)`}</button>)}
      {error && <p className="row error" role="alert">{error}</p>}
    </section>
  );
}


// バックアップ: ワールドのバックアップ(今すぐ・一覧・ダウンロード・戻す・予約)と、アドオンの変更の履歴
function Backup({ id, control, admin, edit, items, onChange }: { id: string; control: boolean; admin: boolean; edit: boolean; items: Installed[] | null; onChange: () => void }) {
  const [pick, setView] = useState<"" | "world" | "changes">(""); // 権限を読み終わる前に決めないように、選ぶまでは空
  const view = pick || (control ? "world" : "changes");
  return view === "world" && control
    ? <Worlds id={id} admin={admin} chips={<BackupChips view={view} control={control} setView={setView} />} />
    : <>
      <ChipBar label="バックアップ"><BackupChips view={view} control={control} setView={setView} /></ChipBar>
      <div className="gtitle">変更の履歴
        <Info>
          <span>外したファイルは消さずに名前を変えて残すので、元に戻せます(1 台につき新しい 30 件まで)。変更はサーバーの再起動で反映されます。</span>
          <span>プラグインを外す・入れ替えるときは、設定フォルダ(plugins/〈名前〉/)も plugins/.craftshelf-config に退避し、元に戻すと設定も戻します(ファイルが 100 個・20 MB を超えるフォルダは退避しません)。</span>
        </Info>
      </div>
      <Changes id={id} edit={edit} items={items} onChange={onChange} />
    </>;
}
function BackupChips({ view, control, setView }: { view: string; control: boolean; setView: (v: "" | "world" | "changes") => void }) {
  return <>
    {control && <Chip on={view === "world"} onClick={() => setView("world")}>ワールド</Chip>}
    <Chip on={view === "changes"} onClick={() => setView("changes")}>変更の履歴</Chip>
  </>;
}

// ワールドのバックアップ(編集者以上が作る・消す・ダウンロード。予約・残す数・置き場所は管理者以上)
function Worlds({ id, admin, chips }: { id: string; admin: boolean; chips: ReactNode }) {
  const load = useServerFn(worldBackups);
  const create = useServerFn(createWorldBackup);
  const remove = useServerFn(removeWorldBackup);
  const save = useServerFn(setWorldBackup);
  const restore = useServerFn(restoreWorldBackup);
  const [opt, setOpt] = useState({ stop: false, truncate: false });
  const [d, setD] = useState<Awaited<ReturnType<typeof worldBackups>> | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof worldBackups>>["settings"] | null>(null);
  const [plan, setPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load({ data: { id } }).then((x) => { setD(x); setDraft((old) => old ?? x.settings); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, [id]);
  // 作っている間は、終わるまで一覧を読み直す
  useEffect(() => {
    if (!d?.running) return;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [d]);

  const act = async (fn: () => Promise<unknown>, done = "") => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await fn();
      setNote(typeof r === "string" ? r : done);
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const ptero = d?.kind === "ptero";
  const s = d?.settings;
  return (
    <>
      <ChipBar label="バックアップ" tools={d?.available && (
        <Btn kind="pri" sm disabled={busy || d.running} onClick={() => act(() => create({ data: { id } }), "")}>{d.running ? "保存しています…" : "今すぐ保存"}</Btn>
      )}>{chips}</ChipBar>
      <div className="gtitle">ワールドのバックアップ
        <Info>
          <span>{ptero
            ? "Pterodactyl のパネルのバックアップを使います。ワールドだけでなく、サーバー全体(.pteroignore で除いたものを除く)が入り、パネルの置き場所に残ります。作れる数の上限はパネルの設定しだいです。残す数を超えたら、このパネルが作った古いもの(鍵つきを除く)を消します。"
            : "ワールド(server.properties の level-name と、その _nether・_the_end のフォルダ)を tar.gz にまとめます。RCON が使えれば、まとめる間はワールドの保存を止めます(save-off)。1 つ 100 MB を超えるファイルと読めなかったファイルは飛ばし、操作の記録に書きます。"}</span>
          <span>{" 予約の時刻は、保存したときのブラウザの時間帯です。結果は操作の記録に残り、失敗したらお知らせと Discord(「エラー」「バックアップ」を選んでいれば)で知らせます。予約・残す数・置き場所を決められるのは管理者以上です。"}</span>
        </Info>
      </div>
      <section className="group">
        {!d && !error && <div className="row muted">読み込んでいます…</div>}
        {d && !d.available && <div className="row muted">フォルダのサーバー・エージェントのワールドのバックアップは、自分用の版だけで使えます。</div>}
        {d && !d.running && d.last && (d.last.ok
          ? <div className="row muted" role="status">{`作りました: ${new Date(d.last.at).toLocaleString("ja-JP")}`}</div>
          : <div className="row error" role="alert">{`作れませんでした: ${d.last.message}`}</div>)}
        {d?.error && <div className="row error" role="alert">{d.error}</div>}
        {d?.available && !d.error && d.backups.length === 0 && <div className="row muted">まだありません。</div>}
        {d?.backups.map((b) => (
          <div className="row" key={b.name}>
            <span className="mid">
              <span className="ttl" title={b.label}>{b.at ? new Date(b.at).toLocaleString("ja-JP") : ""}</span>
              <span className="sub" translate="no">{b.size !== null ? fmtSize(b.size) : ""}{ptero && !b.label.startsWith("CraftShelf ") ? `${b.size !== null ? " · " : ""}${b.label}` : ""}</span>
            </span>
            {!b.done && <span className="badge upd">作っています</span>}
            {b.done && !b.ok && <span className="badge bad">失敗</span>}
            {b.locked && <span className="tag">鍵つき</span>}
            {b.done && b.ok && <a className="btn sm" href={`/api/worlds/${id}/${b.name}`} download>ダウンロード</a>}
            {admin && b.done && b.ok && (
              <Btn kind="red" sm disabled={busy || d.running} onClick={() => {
                const what = new Date(b.at).toLocaleString("ja-JP");
                if (!confirm(ptero
                  ? `${what} のバックアップから戻しますか?サーバーは止まり、サーバー全体がこのときの状態に戻ります${opt.truncate ? "(今のファイルはすべて消えます)" : ""}。`
                  : `${what} のバックアップからワールドを戻しますか?今のワールドは名前を変えて残します。`)) return;
                if (!confirm(ptero ? "もう一度確かめます。本当に戻しますか?" : `もう一度確かめます。サーバーが止まっていることを確かめましたか?${opt.stop ? "(動いていたら止めます)" : "(動いていれば戻しません)"}`)) return;
                act(async () => {
                  const r = await restore({ data: { id, name: b.name, ...opt } });
                  return (ptero ? "パネルが戻しています(終わるとサーバーを起動できます)" : `戻しました(${r.files} ファイル)${r.aside.length ? `。前のワールドは ${r.aside.join("・")} に残しています` : ""}`);
                });
              }}>戻す</Btn>
            )}
            {!b.locked && b.done && (
              <Menu label={`${b.label} の操作`} disabled={busy} items={[
                { label: "消す", danger: true, onClick: () => { if (confirm(`${b.label} を消しますか?`)) act(() => remove({ data: { id, name: b.name } }), "消しました"); } },
              ]} />
            )}
          </div>
        ))}
        {admin && d && d.backups.length > 0 && (ptero
          ? <label className="row"><span className="mid">戻すときに、今のファイルを消してから戻す</span><input type="checkbox" className="switch" checked={opt.truncate} onChange={(e) => setOpt({ ...opt, truncate: e.target.checked })} /></label>
          : <label className="row"><span className="mid">戻すときに、動いていたら止める</span><input type="checkbox" className="switch" checked={opt.stop} onChange={(e) => setOpt({ ...opt, stop: e.target.checked })} /></label>)}
      </section>
      {note && <p className="muted" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {admin && d?.available && s && <>
        <div className="gtitle">予約</div>
        <section className="group">
          <Row onClick={() => { setDraft(s); setPlan(true); }}>
            <span className="mid"><span className="ttl">{s.mode === "off" ? "しない" : `${s.mode === "weekly" ? `毎週 ${DAY_NAMES[s.dow]}曜日` : "毎日"} ${s.time}`}</span>
              <span className="sub">{`${s.keep} 個を残す`}{s.lastRunAt ? ` · ${`前に予約で動いたとき: ${new Date(s.lastRunAt).toLocaleString("ja-JP")}`}` : ""}</span></span>
            <span className="chev" aria-hidden="true">›</span>
          </Row>
        </section>
      </>}
      {plan && d && draft && (
        <Sheet title="バックアップの予約" onClose={() => setPlan(false)}>
          <section className="group">
            <div className="row">
              <span>予約</span>
              <select className="trail" value={draft.mode} aria-label="ワールドのバックアップの予約" onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
                <option value="off">しない</option>
                <option value="daily">毎日</option>
                <option value="weekly">毎週</option>
              </select>
            </div>
            {draft.mode === "weekly" && (
              <div className="row">
                <span>曜日</span>
                <select className="trail" value={draft.dow} aria-label="バックアップする曜日" onChange={(e) => setDraft({ ...draft, dow: Number(e.target.value) })}>
                  {DAY_NAMES.map((n, i) => <option key={i} value={i}>{`${n}曜日`}</option>)}
                </select>
              </div>
            )}
            {draft.mode !== "off" && (
              <div className="row">
                <span>時刻</span>
                <input className="trail" type="time" value={draft.time} aria-label="バックアップする時刻" onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
              </div>
            )}
            <div className="row">
              <span>残す数</span>
              <select className="trail" value={draft.keep} aria-label="残すバックアップの数" onChange={(e) => setDraft({ ...draft, keep: Number(e.target.value) })}>
                {[1, 2, 3, 5, 7, 10, 14, 20, 30].map((n) => <option key={n} value={n}>{`${n} 個`}</option>)}
              </select>
            </div>
            {!ptero && (
              <div className="row">
                <span>置き場所</span>
                <select className="trail" value={draft.targetId ?? ""} aria-label="バックアップの置き場所" onChange={(e) => setDraft({ ...draft, targetId: e.target.value || null })}>
                  <option value="">パネルの中</option>
                  {d.targets.map((t) => <option key={t.id} value={t.id} translate="no">{t.name}</option>)}
                </select>
              </div>
            )}
          </section>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="sheet-foot"><span className="grow" />
            <Btn kind="pri" disabled={busy} onClick={() => act(async () => {
              await save({ data: { id, ...draft, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
              setPlan(false);
            }, "保存しました")}>保存</Btn>
          </div>
        </Sheet>
      )}
    </>
  );
}
