// サーバーの詳細の「設定」タブ: めったに変えないものを 1 行ずつ並べ、押すと右のシートで変える
import { useEffect, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { setProfile } from "./library-api";
import { localSettings, listServers, removeServer, serverAssignments, setLocalSettings, setServerAssignment } from "./servers-api";
import { copyServer, setAutoUpdate } from "./sets-api";
import { detectSoftware, installSoftware, rollbackSoftware, setSoftware, softwareBuilds, softwareInfo, updateSoftware } from "./software-api";
import { SOFTWARE, SOFTWARE_IDS } from "./software";
import { PLATFORMS, PLATFORM_IDS } from "./platforms";
import { createWorldBackup } from "./worlds-api";
import { getServerSchedule, setServerSchedule } from "./schedule-api";
import { ApplyResults } from "./apply-results";
import { roleLabel } from "./permissions";
import { Btn, Info, Row, Sheet } from "./ui";

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");

export type SettingKey = "software" | "schedule" | "control" | "members" | "profile" | "promote";
export type SoftInfo = Awaited<ReturnType<typeof softwareInfo>>;
export type Perms = { update: boolean; edit: boolean; admin: boolean; remove: boolean };
type Detail = { id: string; name: string; kind: string; profile: { platform: string; mcVersion: string | null } | null; autoUpdate: boolean };

export const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
export const CONTROL_LABEL: Record<string, string> = { none: "このパネルからはしない", command: "コマンドを実行する", docker: "Docker のコンテナ" };

// 予約の要約(例 毎日 05:00 · 新しい版にする · 再起動)
const scheduleText = (d: Awaited<ReturnType<typeof getServerSchedule>>) => d.mode === "off" ? "しない"
  : [`${d.mode === "weekly" ? `毎週 ${DAY_NAMES[d.dow]}曜日` : "毎日"} ${d.time}`, d.actions[d.action as keyof typeof d.actions] ?? d.action, d.restart ? "再起動" : ""].filter(Boolean).join(" · ");

/** 設定のタブの行。summary は行の右下の小さな説明 */
export function SettingsRows({ server, perms, soft, version, onOpen }: { server: Detail; perms: Perms; soft: SoftInfo | string | null; version: number; onOpen: (k: SettingKey) => void }) {
  const router = useRouter();
  const navigate = useNavigate();
  const loadSchedule = useServerFn(getServerSchedule);
  const loadLocal = useServerFn(localSettings);
  const loadMembers = useServerFn(serverAssignments);
  const loadServers = useServerFn(listServers);
  const setAuto = useServerFn(setAutoUpdate);
  const remove = useServerFn(removeServer);
  const [schedule, setSchedule] = useState<Awaited<ReturnType<typeof getServerSchedule>> | null>(null);
  const [control, setControl] = useState("");
  const [members, setMembers] = useState<number | null>(null);
  const [others, setOthers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const local = server.kind === "local" && perms.update && perms.admin; // パネルの PC でコマンドが動くので管理者以上だけ
  useEffect(() => {
    if (server.profile) loadSchedule({ data: { id: server.id } }).then(setSchedule, () => setSchedule(null));
    if (local) loadLocal({ data: { id: server.id } }).then((s) => setControl(s.control), () => setControl(""));
    if (perms.admin) loadMembers().then((a) => setMembers(a.members.filter((m) => !m.limited || m.serverIds.includes(server.id)).length), () => setMembers(null));
    if (perms.edit) loadServers().then((l) => setOthers(l.filter((s) => s.id !== server.id).length), () => setOthers(0));
  }, [server.id, version, perms.admin, perms.edit, local, !!server.profile]);

  const run = async (fn: () => Promise<unknown>) => {
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
  const row = (k: SettingKey, title: string, sub: string) => (
    <Row onClick={() => onOpen(k)}>
      <span className="mid"><span className="ttl">{title}</span><span className="sub">{sub}</span></span>
      <span className="chev" aria-hidden="true">›</span>
    </Row>
  );
  const p = server.profile;
  return (
    <>
      <section className="group">
        {row("software", "サーバー本体", !soft ? "確かめています…" : typeof soft === "string" ? soft
          : `${soft.label}${soft.build ? ` · ${soft.mc ? `${soft.mc} · ` : ""}${soft.build}` : ""}`)}
        {p && (perms.edit ? (
          <label className="row">
            <span className="mid"><span className="ttl">自動更新</span><span className="sub">6 時間ごとに、新しい版があれば入れる</span></span>
            <input type="checkbox" className="switch" checked={server.autoUpdate} disabled={busy} aria-label="自動更新"
              onChange={(e) => { const on = e.target.checked; run(async () => { await setAuto({ data: { serverId: server.id, on } }); await router.invalidate(); }); }} />
          </label>
        ) : <div className="row"><span className="mid"><span className="ttl">自動更新</span></span><span className="trail">{server.autoUpdate ? "オン" : "オフ"}</span></div>)}
        {p && schedule && (perms.update || schedule.mode !== "off") && row("schedule", "予約", scheduleText(schedule))}
        {local && row("control", "起動・停止・RCON", CONTROL_LABEL[control] ?? "確かめています…")}
        {perms.admin && members !== null && row("members", "割り当てるメンバー", `${members} 人`)}
        {row("profile", "アドオンの種類とバージョン", p ? `${PLATFORMS[p.platform as keyof typeof PLATFORMS]?.label ?? p.platform} · ${p.mcVersion || "指定なし"} · ${PLATFORMS[p.platform as keyof typeof PLATFORMS]?.dir ?? "plugins"}/` : "未設定")}
        {p && perms.edit && others > 0 && row("promote", "検証用から本番へ反映", "このサーバーの構成をほかのサーバーへ")}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {perms.remove && <>
        <div className="gtitle">危ない操作</div>
        <section className="group">
          <Row onClick={() => {
            if (!confirm(`${server.name} を一覧から外しますか?(Pterodactyl のサーバー・フォルダのファイルは消えません)`)) return;
            run(async () => { await remove({ data: { id: server.id } }); await navigate({ to: "/servers" }); });
          }}><span className="mid"><span className="ttl danger">一覧から外す</span></span></Row>
        </section>
      </>}
    </>
  );
}

/** 設定の行を押すと出るシート */
export function SettingSheet({ kind, server, perms, soft, reloadSoft, onChanged, onClose }:
  { kind: SettingKey; server: Detail; perms: Perms; soft: SoftInfo | string | null; reloadSoft: () => Promise<unknown>; onChanged: () => void; onClose: () => void }) {
  const title = { software: "サーバー本体", schedule: "予約", control: "起動・停止・RCON", members: "割り当てるメンバー", profile: "アドオンの種類とバージョン", promote: "検証用から本番へ反映" }[kind];
  return (
    <Sheet title={title} onClose={onClose}>
      {kind === "software" && <Software id={server.id} admin={perms.update} info={soft} reload={reloadSoft} />}
      {kind === "schedule" && <ServerSchedule id={server.id} admin={perms.update} onSaved={onChanged} />}
      {kind === "control" && <LocalControl id={server.id} onSaved={onChanged} />}
      {kind === "members" && <Members id={server.id} onSaved={onChanged} />}
      {kind === "profile" && <Profile id={server.id} profile={server.profile} editable={perms.update} onSaved={onChanged} />}
      {kind === "promote" && <CopyServers id={server.id} name={server.name} onDone={onChanged} />}
    </Sheet>
  );
}

function Profile({ id, profile, editable, onSaved }:
  { id: string; profile: { platform: string; mcVersion: string | null } | null; editable: boolean; onSaved: () => void }) {
  const save = useServerFn(setProfile);
  const router = useRouter();
  const [platform, setPlatform] = useState(profile?.platform ?? "");
  const [mcVersion, setMcVersion] = useState(profile?.mcVersion ?? "");
  const [error, setError] = useState("");
  const [found, setFound] = useState("");
  const [note, setNote] = useState("");
  const detect = useServerFn(detectSoftware);
  const changed = platform !== (profile?.platform ?? "") || mcVersion !== (profile?.mcVersion ?? "");
  const guess = async () => {
    setError("");
    try {
      const d = await detect({ data: { id } });
      if (d.platform) setPlatform(d.platform);
      if (d.mcVersion) setMcVersion(d.mcVersion);
      setFound(d.software ? `${SOFTWARE[d.software].label}${d.mcVersion ? ` ${d.mcVersion}` : ""} のようです${d.platform ? "(よければ保存してください)" : "(Mod・プラグインは扱えない種類です)"}` : "ファイルからは分かりませんでした");
    } catch (e) {
      setError(message(e));
    }
  };
  const submit = async () => {
    try {
      await save({ data: { id, platform, mcVersion } });
      setError("");
      setNote("保存しました");
      await router.invalidate();
      onSaved();
    } catch (e) {
      setError(message(e));
    }
  };

  if (!editable) {
    return (
      <section className="group">
        <div className="row"><span>種類</span><span className="trail">{profile ? PLATFORMS[profile.platform as keyof typeof PLATFORMS]?.label : "未設定"}</span></div>
        <div className="row"><span>バージョン</span><span className="trail">{profile?.mcVersion || "指定なし"}</span></div>
      </section>
    );
  }
  return (
    <>
      <p className="sub">サーバーの種類を選ぶと、合う Mod・プラグインを探せるようになります。
        <Info>アドオン(プラグイン・Mod)を探す・入れるときの条件です。「サーバー本体」(動かしている jar の種類。選べる種類が多く、Leaf・Pufferfish は Paper として扱うなど)とは別に決められます。ふつうはどちらも同じ種類にします。</Info>
      </p>
      <section className="group">
        <div className="row">
          <span>種類</span>
          <select className="trail" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="サーバーの種類">
            <option value="" disabled>選んでください</option>
            {PLATFORM_IDS.map((p) => <option key={p} value={p}>{PLATFORMS[p].label}</option>)}
          </select>
        </div>
        <div className="row">
          <span>Minecraft のバージョン</span>
          <input className="trail version" placeholder="例 1.21.1" value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} aria-label="Minecraft のバージョン" />
        </div>
        <button className="row link" type="button" onClick={guess}>サーバーのファイルから判定する</button>
      </section>
      {found && <p className="muted" role="status">{found}</p>}
      {note && !changed && <p className="muted" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-foot"><span className="grow" /><Btn kind="pri" onClick={submit} disabled={!platform || !changed}>保存</Btn></div>
    </>
  );
}

// このサーバーを使えるメンバー(閲覧者・編集者。管理者・オーナーはいつでもすべて)。チームの「サーバーの割り当て」と同じもの
function Members({ id, onSaved }: { id: string; onSaved: () => void }) {
  const load = useServerFn(serverAssignments);
  const save = useServerFn(setServerAssignment);
  const [data, setData] = useState<Awaited<ReturnType<typeof serverAssignments>> | null>(null);
  const [error, setError] = useState("");
  const reload = () => load().then(setData, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);
  if (!data) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">読み込んでいます…</p>;
  const change = async (m: (typeof data.members)[number], on: boolean) => {
    // 「すべて使える」の人を外すときは、ほかのサーバーは使えるままにする
    const ids = m.limited ? m.serverIds : data.servers.map((s) => s.id);
    const serverIds = on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id);
    const limited = on ? m.limited : true;
    setError("");
    setData((d) => d && { ...d, members: d.members.map((x) => (x.userId === m.userId ? { ...x, limited, serverIds } : x)) }); // 先に画面を変える
    try {
      await save({ data: { userId: m.userId, limited, serverIds } });
      onSaved();
    } catch (e) {
      setError(message(e));
      await reload();
    }
  };
  return (
    <>
      <p className="sub">このサーバーを見る・操作できる人
        <Info>管理者とオーナーは、いつでもすべてのサーバーを使えます。オフにした人には、一覧・比較・セット・ポートにもこのサーバーが出ません。チームの「サーバーの割り当て」でも決められます。</Info>
      </p>
      <section className="group">
        {data.members.length === 0 && <div className="row muted">閲覧者・編集者がいません</div>}
        {data.members.map((m) => (
          <label className="row" key={m.userId}>
            <span className="mid"><span className="ttl" translate="no">{m.name}</span><span className="sub">{m.limited ? roleLabel(m.role) : `${roleLabel(m.role)} · すべてのサーバーを使える`}</span></span>
            <input type="checkbox" className="switch" checked={!m.limited || m.serverIds.includes(id)} aria-label={`${m.name} を割り当てる`} onChange={(e) => change(m, e.target.checked)} />
          </label>
        ))}
      </section>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// そろえ方は 3 通り(入っているものだけ合わせる・足りないものも入れる・まったく同じにする)
export type CopyMode = "update" | "add" | "mirror";
export const COPY_LABEL: Record<CopyMode, string> = { update: "入っているものだけ合わせる", add: "足りないものも入れる", mirror: "まったく同じにする" };
const COPY_HELP: Record<CopyMode, string> = { update: "入っているものの版だけ、元と同じにする", add: "無いものも入れ、入っているものは版を同じにする", mirror: "元と同じ構成にする(足りないものは入れ、元に無いものは外す)" };

/** 「そろえ方」の行: 選んでいる方法の説明を 1 行、3 つの違いは ⓘ に */
export function CopyModeRow({ mode, onChange, disabled, label = "そろえ方" }: { mode: CopyMode; onChange: (m: CopyMode) => void; disabled?: boolean; label?: string }) {
  return (
    <div className="row column">
      <span className="cm-line">
        <span className="ttl">そろえ方</span>
        <Info>{(Object.keys(COPY_LABEL) as CopyMode[]).map((k) => <span key={k}>{`${COPY_LABEL[k]}: ${COPY_HELP[k]}`}</span>)}</Info>
        <select className="trail" value={mode} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value as CopyMode)}>
          {(Object.keys(COPY_LABEL) as CopyMode[]).map((k) => <option key={k} value={k}>{COPY_LABEL[k]}</option>)}
        </select>
      </span>
      <span className="muted small">{COPY_HELP[mode]}</span>
    </div>
  );
}

// 検証用から本番へ反映: このサーバーの構成を、選んだほかのサーバーへそろえる
function CopyServers({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const load = useServerFn(listServers);
  const copy = useServerFn(copyServer);
  const [others, setOthers] = useState<{ id: string; name: string }[] | null>(null);
  const [mode, setMode] = useState<CopyMode>("add");
  const [to, setTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof copyServer>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then((l) => setOthers(l.filter((s) => s.id !== id)), (e) => setError(message(e))); }, [id]);
  if (!others) return error ? <p className="error" role="alert">{error}</p> : null;

  const run = async () => {
    if (!confirm(`「${name}」の構成を、選んだ ${to.size} 台へ反映しますか?`)) return;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      setResults(await copy({ data: { from: id, to: [...to], mode } }));
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="sub">このサーバーと同じ版を、選んだサーバーに入れます
        <Info>このサーバーに、このアプリで入れたもの(無効にしたものは除く)と同じ版を、選んだサーバーに入れます。そろえ方はアドオンの「そろえる」と同じです。</Info>
      </p>
      <section className="group">
        <CopyModeRow mode={mode} onChange={setMode} label="反映するときのそろえ方" />
        {others.map((o) => (
          <label className="row" key={o.id}>
            <input type="checkbox" className="ck" checked={to.has(o.id)}
              onChange={(e) => setTo((x) => { const n = new Set(x); if (e.target.checked) n.add(o.id); else n.delete(o.id); return n; })} />
            <span className="mid"><span className="ttl" translate="no">{o.name}</span></span>
          </label>
        ))}
      </section>
      {results && (
        <section className="group">
          {results.map((r) => (r.error
            ? <p className="row error" key={r.serverId}><span translate="no">{r.server}</span>: {r.error}</p>
            : <ApplyResults key={r.serverId} server={r.server} verb="そろえた" list={r.results} empty="変えるものはありませんでした。" />))}
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-foot"><span className="grow" /><Btn kind="pri" disabled={!to.size || busy} onClick={run}>{busy ? "反映しています…" : `選んだ ${to.size} 台へ反映`}</Btn></div>
    </>
  );
}

// サーバーごとの予約(v02 の予約同期): 毎日・毎週の時刻に、入っているものを最新にする・結び付けたセットでそろえる。変えたら再起動もできる
function ServerSchedule({ id, admin, onSaved }: { id: string; admin: boolean; onSaved: () => void }) {
  const load = useServerFn(getServerSchedule);
  const save = useServerFn(setServerSchedule);
  const [d, setD] = useState<Awaited<ReturnType<typeof getServerSchedule>> | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof getServerSchedule>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => load({ data: { id } }).then((x) => { setD(x); setDraft(x); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, [id]);
  if (!d || !draft) return error ? <p className="error" role="alert">{error}</p> : null;
  const submit = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await save({ data: { id, mode: draft.mode, action: draft.action, time: draft.time, dow: draft.dow, restart: draft.restart, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      setNote("保存しました");
      await reload();
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="sub">決めた時刻に、新しい版にするか、セットでそろえます
        <Info>決めた時刻に、このサーバーの Mod・プラグインを新しい版にする(「更新を止める」にしたもの・無効にしたものは除く)か、結び付けたセットでそろえます。何か変えて「変えたら再起動する」を選んでいれば、サーバーを再起動します。セットの画面の予約(チームで 1 つ)とは別に動きます。時刻は保存したときのブラウザの時間帯です。決められるのは管理者以上です。</Info>
      </p>
      <section className="group">
        <div className="row">
          <span>予約</span>
          <select className="trail" value={draft.mode} disabled={!admin} aria-label="このサーバーの予約" onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
            <option value="off">しない</option>
            <option value="daily">毎日</option>
            <option value="weekly">毎週</option>
          </select>
        </div>
        {draft.mode === "weekly" && (
          <div className="row">
            <span>曜日</span>
            <select className="trail" value={draft.dow} disabled={!admin} aria-label="予約の曜日" onChange={(e) => setDraft({ ...draft, dow: Number(e.target.value) })}>
              {DAY_NAMES.map((n, i) => <option key={i} value={i}>{`${n}曜日`}</option>)}
            </select>
          </div>
        )}
        {draft.mode !== "off" && (
          <>
            <div className="row">
              <span>時刻</span>
              <input className="trail" type="time" value={draft.time} disabled={!admin} aria-label="予約の時刻" onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
            </div>
            <div className="row">
              <span>すること</span>
              <select className="trail" value={draft.action} disabled={!admin} aria-label="予約ですること" onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
                {Object.entries(d.actions).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </div>
            <label className="row">
              <span className="mid">変えたら再起動する</span>
              <input type="checkbox" className="switch" checked={draft.restart} disabled={!admin} onChange={(e) => setDraft({ ...draft, restart: e.target.checked })} />
            </label>
          </>
        )}
        {d.lastRunAt && <div className="row muted">{`前に動いたとき: ${new Date(d.lastRunAt).toLocaleString("ja-JP")}`}</div>}
      </section>
      {note && <p className="muted" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {admin && <div className="sheet-foot"><span className="grow" /><Btn kind="pri" disabled={busy} onClick={submit}>{busy ? "保存しています…" : "保存"}</Btn></div>}
    </>
  );
}

// フォルダのサーバーの起動・停止・RCON(パネルの PC でコマンドを実行するので、管理者以上だけ)
function LocalControl({ id, onSaved }: { id: string; onSaved: () => void }) {
  const load = useServerFn(localSettings);
  const save = useServerFn(setLocalSettings);
  const [s, setS] = useState<Awaited<ReturnType<typeof localSettings>> | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { load({ data: { id } }).then(setS, (e) => setError(message(e))); }, [id]);
  if (!s) return error ? <p className="error" role="alert">{error}</p> : null;

  const submit = async (clearPassword = false) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await save({ data: { id, control: s.control, startCmd: s.startCmd, stopCmd: s.stopCmd, container: s.container, rconPort: s.rconPort,
        ...(clearPassword ? { rconPassword: "" } : password ? { rconPassword: password } : {}) } });
      setPassword("");
      setS(await load({ data: { id } }));
      setNote("保存しました");
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="sub"><span>フォルダ </span><span className="path" translate="no">{s.rootDir}</span>
        <Info>コマンドは、パネルを動かしている PC の、サーバーのフォルダで実行します。Docker のコンテナを使うときは、パネルのコンテナに /var/run/docker.sock をマウントしてください(ほかのコンテナも操作できるようになるので、要るときだけ)。RCON は server.properties で enable-rcon=true にしてください。</Info>
      </p>
      <section className="group">
        <div className="row">
          <span>起動・停止</span>
          <select className="trail" value={s.control} aria-label="起動・停止の方法" onChange={(e) => setS({ ...s, control: e.target.value })}>
            {Object.entries(CONTROL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {s.control === "command" && (
          <>
            <input className="row codes" placeholder="起動のコマンド(例 systemctl start minecraft)" value={s.startCmd} onChange={(e) => setS({ ...s, startCmd: e.target.value })} aria-label="起動のコマンド" />
            <input className="row codes" placeholder="停止のコマンド(空なら RCON の stop)" value={s.stopCmd} onChange={(e) => setS({ ...s, stopCmd: e.target.value })} aria-label="停止のコマンド" />
          </>
        )}
        {s.control === "docker" && (
          <input className="row codes" placeholder="コンテナの名前(例 minecraft)" value={s.container} onChange={(e) => setS({ ...s, container: e.target.value })} aria-label="コンテナの名前" />
        )}
        <input className="row" inputMode="numeric" placeholder="RCON のポート(空なら server.properties の rcon.port)" value={s.rconPort ?? ""}
          onChange={(e) => setS({ ...s, rconPort: e.target.value.trim() ? Number(e.target.value) : null })} aria-label="RCON のポート" />
        <input className="row" type="password" autoComplete="off" placeholder={s.hasRconPassword ? "RCON のパスワード(設定済み。変えるときだけ入力)" : "RCON のパスワード(コマンド・停止・状態に使う)"}
          value={password} onChange={(e) => setPassword(e.target.value)} aria-label="RCON のパスワード" />
      </section>
      {note && <p className="muted" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-foot">
        {s.hasRconPassword && <Btn kind="red" sm disabled={busy} onClick={() => submit(true)}>RCON のパスワードを消す</Btn>}
        <span className="grow" />
        <Btn kind="pri" disabled={busy} onClick={() => submit()}>{busy ? "保存しています…" : "保存"}</Btn>
      </div>
    </>
  );
}

// a が b より古いバージョンか(1.21.10 は 1.21.4 より新しい)
const older = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

// サーバー本体(jar): 今のビルドといちばん新しいビルド。入れ替える(ビルド・Minecraft のバージョンを選べる)・残した jar に戻すのは管理者以上
function Software({ id, admin, info: loaded, reload: reloadInfo }: { id: string; admin: boolean; info: SoftInfo | string | null; reload: () => Promise<unknown> }) {
  const update = useServerFn(updateSoftware);
  const install = useServerFn(installSoftware);
  const listBuilds = useServerFn(softwareBuilds);
  const back = useServerFn(rollbackSoftware);
  const choose = useServerFn(setSoftware);
  const backupWorld = useServerFn(createWorldBackup);
  const [builds, setBuilds] = useState<Awaited<ReturnType<typeof softwareBuilds>> | null>(null);
  const [pick, setPick] = useState({ mc: "", build: "" });
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const info = typeof loaded === "object" ? loaded : null;
  const run = async (ask: string | null, fn: () => Promise<string>) => {
    if (ask && !confirm(ask)) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote(await fn());
      await reloadInfo();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const after = (r: { restarted: boolean }) => (r.restarted ? "。再起動しています" : "。サーバーを再起動すると新しい jar で動きます");
  const openBuilds = (mc?: string) => listBuilds({ data: { id, mc } }).then((b) => { setBuilds(b); setPick({ mc: b.mc, build: "" }); }, (e) => setError(message(e)));
  const mcChanged = !!(info && pick.mc && info.mc && pick.mc !== info.mc && !info.proxy);
  return (
    <>
      <p className="sub">今のビルドと、いちばん新しいビルド
        <Info>動かしている jar(本体)の種類とビルドです。アドオンを探す条件(「アドオンの種類とバージョン」)とは別です。入れ替えるときは、サーバーが配布元から直接 jar を取り込みます。入れ替える前の jar はサーバーのフォルダに 5 つまで残し、そこへ戻せます。Paper・Folia・Purpur・Leaf・Pufferfish・Velocity・Waterfall・BungeeCord・Fabric・Vanilla・Mohist・SpongeVanilla は入れ替えられ、Forge・NeoForge・Quilt・Arclight は新しい版があるかだけを確かめます。</Info>
      </p>
      <section className="group">
        {!loaded && <div className="row muted">確かめています…</div>}
        {typeof loaded === "string" && <div className="row error" role="alert">{loaded}</div>}
        {admin && (
          <div className="row">
            <span>サーバー本体の種類</span>
            <select className="trail" value={info?.software ?? ""} disabled={busy} aria-label="サーバー本体の種類" onChange={(e) => run(null, async () => {
              await choose({ data: { id, software: e.target.value } });
              setBuilds(null);
              return "サーバー本体の種類を変えました";
            })}>
              <option value="" disabled>選んでください</option>
              {SOFTWARE_IDS.map((x) => <option key={x} value={x}>{SOFTWARE[x].label}</option>)}
            </select>
          </div>
        )}
        {info && (
          <>
            <div className="row"><span>{info.label}</span><span className="trail muted" translate={info.jar ? "no" : undefined}>{info.jar || "jar がわかりません"}</span></div>
            <div className="row"><span>今のビルド</span><span className="trail" translate={info.build ? "no" : undefined}>{info.build ? `${info.mc ? `${info.mc} · ` : ""}${info.build}` : "わかりません"}</span></div>
            <div className="row">
              <span>いちばん新しいビルド</span>
              {info.update && <span className="badge upd">更新あり</span>}
              <span className="trail" translate={info.latest ? "no" : undefined}>{info.latest ? info.latest.build : "確かめられません"}</span>
            </div>
            <a className="row link" href={info.page} target="_blank" rel="noopener noreferrer">配布ページで確かめる</a>
            {admin && info.auto && (
              <label className="row"><span className="mid">入れ替えたら再起動する</span><input type="checkbox" className="switch" checked={restart} onChange={(e) => setRestart(e.target.checked)} /></label>
            )}
          </>
        )}
      </section>
      {info && admin && (info.update && info.latest?.auto || info.auto && !builds) && (
        <div className="chips">
          {info.update && info.latest?.auto && (
            <Btn kind="tint" sm disabled={busy || !info.jar} onClick={() => run(
              `${info.jar} を ${info.latest!.build} に入れ替えますか?(今の jar は残し、あとで戻せます)`,
              async () => { const r = await update({ data: { id, restart } }); return `${r.build} に入れ替えました${after(r)}`; },
            )}>{busy ? "入れ替えています…" : "いちばん新しいビルドに入れ替える"}</Btn>
          )}
          {info.auto && !builds && <Btn sm disabled={busy || !info.jar} onClick={() => openBuilds()}>バージョンを選んで入れ替える…</Btn>}
        </div>
      )}
      {info && admin && builds && (
        <section className="group">
          {builds.mcVersions.length > 0 && (
            <div className="row">
              <span>{info.proxy ? "版" : "Minecraft のバージョン"}</span>
              <select className="trail" value={pick.mc} aria-label="入れる Minecraft のバージョン" onChange={(e) => openBuilds(e.target.value)}>
                {!builds.mcVersions.includes(pick.mc) && <option value={pick.mc} translate="no">{pick.mc || "選んでください…"}</option>}
                {builds.mcVersions.map((v) => <option key={v} value={v} translate="no">{v === info.mc ? `${v}(今)` : v}</option>)}
              </select>
            </div>
          )}
          <div className="row">
            <span>ビルド</span>
            <select className="trail" value={pick.build} aria-label="入れるビルド" onChange={(e) => setPick({ ...pick, build: e.target.value })}>
              <option value="">{builds.builds.length ? "選んでください…" : "見つかりません"}</option>
              {builds.builds.map((b) => <option key={b.build} value={b.build} disabled={!b.auto} translate="no">{`${b.build}${b.stable ? "" : "(試験版)"}${b.build === info.build && pick.mc === info.mc ? "(今)" : ""}`}</option>)}
            </select>
          </div>
          {mcChanged && (
            <>
              <div className="row">
                <span className="notice small">{`Minecraft のバージョンを ${info.mc} から ${pick.mc} に${older(pick.mc, info.mc) ? "下げると、ワールドが読めなくなったり壊れたりすることがあります" : "上げると、ワールドは新しいバージョンに変換され、元には戻せません"}。先にワールドをバックアップしてください。`}</span>
              </div>
              <button className="row link" type="button" disabled={busy} onClick={() => run(null, async () => { await backupWorld({ data: { id } }); return "ワールドのバックアップを始めました(終わると「ワールドのバックアップ」に出ます)"; })}>先にワールドをバックアップする</button>
            </>
          )}
          <div className="row">
            <Btn sm onClick={() => setBuilds(null)}>閉じる</Btn>
            <span className="grow" />
            <Btn kind="pri" sm disabled={busy || !pick.build} onClick={() => run(
              mcChanged
                ? `Minecraft を ${info.mc} から ${pick.mc}(ビルド ${pick.build})に変えますか?ワールドのバックアップを取ったか、プラグイン・Mod が ${pick.mc} に対応しているかを確かめてください。`
                : `${info.jar} を ${pick.build} に入れ替えますか?(今の jar は残し、あとで戻せます)`,
              async () => { const r = await install({ data: { id, mc: pick.mc || undefined, build: pick.build, restart } }); setBuilds(null); return `${r.mc ? `${r.mc} ` : ""}${r.build} に入れ替えました${after(r)}`; },
            )}>{busy ? "入れ替えています…" : "選んだビルドに入れ替える"}</Btn>
          </div>
        </section>
      )}
      {info && info.backups.length > 0 && <>
        <div className="gtitle">{`残している前の jar(新しい順・${info.backups.length} 個)`}</div>
        <section className="group">
          {info.backups.map((b) => (
            <div className="row" key={b.file}>
              <span className="mid">
                <span className="ttl" translate="no">{`${b.mc ? `${b.mc} · ` : ""}${b.build || "ビルド不明"}`}</span>
                <span className="sub" translate="no">{b.file}</span>
              </span>
              {admin && (
                <Btn sm disabled={busy} onClick={() => run(
                  `${b.build || "前の jar"} に戻しますか?(今の jar は代わりに残します)`,
                  async () => { const r = await back({ data: { id, file: b.file } }); return `${r.build || "前の jar"} に戻しました。サーバーを再起動すると戻した jar で動きます`; },
                )}>戻す</Btn>
              )}
            </div>
          ))}
        </section>
      </>}
      {note && <p className="muted" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
