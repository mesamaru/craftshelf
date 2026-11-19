import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Btn, Icon, Info, fmtSize } from "~/lib/ui";
import { jobsChanged } from "~/lib/jobs-ui";
import { SettingsFrame } from "~/lib/settings-frame";
import { activateStorageTarget, addStorageTarget, moveStorageFiles, removeStorageTarget, storageTargets } from "~/lib/uploads-api";
import { savedOptions, scanStorage, setSavedOptions, storageContents, storageStatus } from "~/lib/saved-api";
import { settingsTitle } from "~/lib/titles";
import { confirmDialog } from "~/lib/dialog-queue";

export const Route = createFileRoute("/storage")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/storage" } });
    return { user: context.user };
  },
  head: () => ({ meta: [{ title: settingsTitle("storage") }] }),
  component: Storage,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const KIND_LABEL: Record<string, string> = { local: "フォルダ", webdav: "WebDAV", smb: "SMB" };
type Target = { id: string | null; name: string; kind: string; summary: string; active: boolean };

// アップロードしたアドオンの保存先(自分用の版・管理者以上)。保存先を並べ、押すとその保存先の状況・中身・操作が開く
function Storage() {
  const load = useServerFn(storageTargets);
  const [data, setData] = useState<Awaited<ReturnType<typeof storageTargets>> | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null | undefined>(undefined); // 開いている保存先(null はパネルの中、undefined は閉じている)
  const [adding, setAdding] = useState(false);
  const reload = () => load().then((d) => { setData(d); setError(""); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);
  const all: Target[] = data ? [{ id: null, name: "パネルの中", kind: "panel", summary: "/data/v03/library", active: data.usingDefault }, ...data.targets] : [];

  return (
    <SettingsFrame at="storage">
      <div className="gtitle">保存先<Info>アップロードしたアドオン・保存した版の置き場所です。「使用中」の保存先に、これから保存します。切り替えても、いままでのファイルは元の保存先に置いたまま使えます(移すときは、保存先を開いて「ファイルを移す」)。NAS は、SMB で直接つなぐか、パネルのコンテナにマウントして「フォルダ」として足してください。</Info></div>
      <section className="group">
        {!data && !error && <div className="row muted">読み込んでいます…</div>}
        {all.map((t) => [
          <button key={t.id ?? "panel"} type="button" className="row click st-row" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? undefined : t.id)}>
            <span className={`cicon ${t.kind === "panel" ? "c-mod" : t.kind === "webdav" ? "c-teal" : t.kind === "smb" ? "c-plugin" : "c-datapack"}`} aria-hidden="true"><Icon name={t.kind === "webdav" ? "globe" : "disk"} /></span>
            <span className="mid">
              <span className="ttl"><span translate={t.id ? "no" : undefined}>{t.name}</span>{t.active && <span className="badge ok">使用中</span>}</span>
              <span className="sub" translate="no">{t.kind === "panel" ? `既定 · ${t.summary}` : `${KIND_LABEL[t.kind] ?? t.kind} · ${t.summary}`}</span>
            </span>
            <span className="chev" aria-hidden="true">{open === t.id ? "▾" : "›"}</span>
          </button>,
          open === t.id && <TargetDetail key={`d-${t.id ?? "panel"}`} target={t} others={all.filter((x) => x.id !== t.id)} onChanged={reload} onRemoved={() => { setOpen(undefined); reload(); }} />,
        ])}
        {data && !adding && <button type="button" className="row link" onClick={() => setAdding(true)}>＋ 保存先を足す</button>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      {adding && <NewTarget onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />}
      <SavedOptions />
    </SettingsFrame>
  );
}

function NewTarget({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const add = useServerFn(addStorageTarget);
  const [kind, setKind] = useState<"local" | "webdav" | "smb">("local");
  const [f, setF] = useState({ name: "", path: "", url: "", user: "", password: "", host: "", share: "", domain: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await add({ data: { kind, name: f.name, ...(kind === "local" ? { path: f.path }
        : kind === "webdav" ? { url: f.url, user: f.user, password: f.password }
        : { host: f.host, share: f.share, path: f.path, user: f.user, password: f.password, domain: f.domain }) } });
      setF({ name: "", path: "", url: "", user: "", password: "", host: "", share: "", domain: "" });
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="gtitle">保存先を足す<Info>足すと、これからのアップロードの保存先になります。パスワードは暗号化して保存し、画面には出しません。SMB は SMB 2.0・2.1 でつなぎます(通信への署名・SMB 3 を必須にしている NAS や Windows のサーバーには、つながりません。そのときはマウントしてフォルダとして足してください)。</Info></div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="row">
          <span>種類</span>
          <select className="trail" value={kind} aria-label="保存先の種類" onChange={(e) => setKind(e.target.value as "local" | "webdav" | "smb")}>
            <option value="local">フォルダ(NAS をマウントしたものも)</option>
            <option value="smb">SMB(NAS に直接)</option>
            <option value="webdav">WebDAV</option>
          </select>
        </div>
        <input className="row" placeholder="名前(例 家の NAS)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {kind === "local" && <input className="row codes" placeholder="フォルダの場所(例 /mnt/nas/craftshelf)" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} aria-label="フォルダの場所" />}
        {kind === "smb" && (
          <>
            <input className="row codes" placeholder="サーバー名か IP アドレス(例 nas.local)" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} aria-label="SMB のサーバー" />
            <input className="row codes" placeholder="共有フォルダの名前(例 share)" value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} aria-label="共有フォルダ" />
            <input className="row codes" placeholder="共有フォルダの中の場所(任意。例 craftshelf)" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} aria-label="共有フォルダの中の場所" />
            <input className="row" placeholder="ユーザー名" autoComplete="off" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
            <input className="row" type="password" placeholder="パスワード" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            <input className="row" placeholder="ドメイン(任意。ふつうは空)" autoComplete="off" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} />
          </>
        )}
        {kind === "webdav" && (
            <>
              <input className="row codes" placeholder="URL(例 https://nas.example/remote.php/dav/files/me/craftshelf)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} aria-label="WebDAV の URL" />
              <input className="row" placeholder="ユーザー名" autoComplete="off" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
              <input className="row" type="password" placeholder="パスワード" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </>
          )}
        {error && <p className="row error" role="alert">{error}</p>}
        <div className="row"><span className="grow" /><Btn sm disabled={busy} onClick={onCancel}>やめる</Btn>
          <button className="btn pri sm" type="submit" disabled={busy}>{busy ? "確かめています…" : "書き込めるか確かめて足す"}</button></div>
      </form>
    </>
  );
}

// 配布元のファイルの保存と、古い版の整理(チームの既定。アイテムごとに変えられる)
function SavedOptions() {
  const load = useServerFn(savedOptions);
  const save = useServerFn(setSavedOptions);
  const [opt, setOpt] = useState<{ keepFiles: boolean; keepVersions: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { load().then((o) => setOpt({ keepFiles: o.keepFiles, keepVersions: o.keepVersions }), (e) => setError(message(e))); }, []);
  const submit = async () => {
    if (!opt) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await save({ data: opt });
      setNote(r.removed ? `保存しました(古い版を ${r.removed} 個整理しました)` : "保存しました");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="gtitle">配布元のファイルの保存<Info>保存した版は、サーバーへ入れるときに配布元から取らず保存先から送ります(配布元が消えても・つながらなくても入れられます)。ライブラリの「保存した版」から、ダウンロード・共有リンク・まとめて zip にもできます。アイテムごとに「保存した版」で変えられます。古い版の整理では、サーバーで使っている版・セットで固定した版は消しません。</Info></div>
      <section className="group form">
        {!opt && !error && <div className="row muted">読み込んでいます…</div>}
        {opt && (
          <>
            <label className="row">
              <span className="main"><span>配布元のファイルを保存する(チームの既定)</span><span className="muted">サーバーに入れた版と、1 日 1 回いちばん新しい版を、使っている保存先にも取っておきます</span></span>
              <input className="trail switch" type="checkbox" checked={opt.keepFiles} onChange={(e) => setOpt({ ...opt, keepFiles: e.target.checked })} />
            </label>
            <label className="row">
              <span className="main"><span>古い版を残す数</span><span className="muted">新しいものから数えます。0 なら全部残します</span></span>
              <input className="trail" type="number" min={0} max={100} value={opt.keepVersions} aria-label="古い版を残す数"
                onChange={(e) => setOpt({ ...opt, keepVersions: Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))) })} />
            </label>
            <div className="row"><span className="grow" /><Btn kind="pri" sm disabled={busy} onClick={submit}>{busy ? "保存しています…" : "保存"}</Btn></div>
          </>
        )}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <section className="group"><Link to="/cleanup" className="row link">アドオンの整理(古い版・重複・使っていないもの)</Link></section>
    </>
  );
}

// 保存先の中身(開いたとき): 状況(つながるか・応答・容量)・操作(使う・ファイルを移す・消す)・中身(アドオンごとにダウンロード)・inbox/ からの取り込み
function TargetDetail({ target, others, onChanged, onRemoved }: { target: Target; others: Target[]; onChanged: () => void; onRemoved: () => void }) {
  const status = useServerFn(storageStatus);
  const contents = useServerFn(storageContents);
  const scan = useServerFn(scanStorage);
  const activate = useServerFn(activateStorageTarget);
  const remove = useServerFn(removeStorageTarget);
  const move = useServerFn(moveStorageFiles);
  const id = target.id;
  const [st, setSt] = useState<Awaited<ReturnType<typeof storageStatus>> | null>(null);
  const [list, setList] = useState<Awaited<ReturnType<typeof storageContents>> | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [moveTo, setMoveTo] = useState<string | null | undefined>(undefined); // 移す先を選んでいるとき(undefined は閉じている)
  const reload = () => {
    setError("");
    status({ data: { id } }).then(setSt, (e) => setError(message(e)));
    contents({ data: { id } }).then(setList, (e) => setError(message(e)));
  };
  useEffect(reload, [id]);
  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setNote("");
    try {
      const n = await fn();
      if (n) setNote(n);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const doMove = async () => {
    const dest = others.find((o) => o.id === moveTo);
    if (!dest || !(await confirmDialog({ message: `「${target.name}」のファイルを「${dest.name}」へ移しますか?(1 つずつ、移した先で中身を確かめてから元を消します。数が多いと時間がかかります)`, ok: "移す" }))) return;
    jobsChanged();
    await run("move", async () => {
      const r = await move({ data: { from: id, to: dest.id } });
      setMoveTo(undefined);
      reload();
      onChanged();
      return `${r.moved} 個を移しました${r.failed.length ? `。移せなかったもの: ${r.failed.map((f) => `${f.filename}(${f.message})`).join("、")}` : ""}`;
    });
  };
  const files = list?.entries.filter((e) => !e.dir) ?? [];
  const unknown = files.filter((e) => !e.item && !e.inbox).length;
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const used = st?.space ? st.space.total - st.space.free : 0;
  return (
    <div className="row column st-detail">
      {!st && !error && <span className="muted">確かめています…</span>}
      {st && (
        <div className="st-status">
          <span>{st.connected ? <span className="badge state-done">つながります</span> : <span className="badge state-failed">つながりません</span>}
            <span className="muted small">{st.connected ? ` 応答 ${st.latencyMs} ms` : ` ${st.error}`}</span></span>
          {st.space && (
            <span className="st-space">
              <span className="meter" aria-hidden="true"><i style={{ width: `${Math.min(100, (used / Math.max(1, st.space.total)) * 100)}%` }} /></span>
              <span className="muted small">{`空き ${fmtSize(st.space.free)} / 全体 ${fmtSize(st.space.total)}`}</span>
            </span>
          )}
          <span className="muted small">{`登録しているファイル ${st.files} 個 · ${fmtSize(st.bytes)}${st.saved ? ` · うち保存した版 ${st.saved} 個` : ""}`}</span>
        </div>
      )}
      <span className="st-acts">
        {!target.active && <Btn kind="tint" sm disabled={!!busy} onClick={() => run("use", async () => { await activate({ data: { id } }); onChanged(); return "これからは、この保存先に保存します"; })}>これを使う</Btn>}
        {others.length > 0 && <Btn sm disabled={!!busy} aria-expanded={moveTo !== undefined} onClick={() => setMoveTo(moveTo === undefined ? others[0].id : undefined)}>ファイルを移す…</Btn>}
        <Btn sm disabled={!!busy} onClick={reload}>読み直す</Btn>
        {id && <Btn kind="red" sm disabled={!!busy} onClick={async () => {
          if (await confirmDialog({ message: `保存先「${target.name}」を消しますか?(ファイルが残っていると消せません。保存先の中のファイルは消しません)`, ok: "消す", danger: true })) {
            run("rm", async () => { await remove({ data: { id } }); onRemoved(); });
          }
        }}>消す</Btn>}
      </span>
      {moveTo !== undefined && (
        <div className="st-move">
          <span>移す先</span>
          <select value={moveTo ?? ""} disabled={!!busy} aria-label="移す先" onChange={(e) => setMoveTo(e.target.value || null)}>
            {others.map((o) => <option key={o.id ?? "panel"} value={o.id ?? ""} translate="no">{o.name}</option>)}
          </select>
          <Btn kind="pri" sm disabled={!!busy} onClick={doMove}>{busy === "move" ? "移しています…" : "移す"}</Btn>
        </div>
      )}
      {note && <span className="muted small" role="status" translate="no">{note}</span>}
      {error && <span className="error small" role="alert">{error}</span>}
      {list && (
        <>
          <span className="st-sub">{`中身(ファイル ${files.length} 個${list.truncated ? "。多いので途中まで" : ""})`}</span>
          <div className="group flat st-files">
            {files.length === 0 && <div className="row muted">ファイルはありません</div>}
            {files.map((e) => (
              <div className="row" key={e.path}>
                <span className="mid">
                  <span className="ttl" translate="no">{e.item ?? nameOf(e.path)}</span>
                  <span className="sub"><span translate="no">{e.item ? nameOf(e.path) : e.path}</span>{` · ${fmtSize(e.size)}`}
                    {e.saved && " · 保存した版"}{!e.item && (e.inbox ? " · 取り込み待ち" : " · 記録なし")}</span>
                </span>
                {e.fileId && <a className="btn sm tint" href={`/api/library/files/${e.fileId}`} download>ダウンロード</a>}
              </div>
            ))}
          </div>
          {unknown > 0 && <span className="muted small">「記録なし」は、このアプリが登録していないファイルです(バックアップ・ほかのアプリのものなど)。ライブラリに取り込むときは、保存先の inbox/ に移してから下の「inbox/ から取り込む」を押します。</span>}
        </>
      )}
      <span className="st-acts">
        <Btn sm disabled={!!busy} onClick={() => run("scan", async () => {
          const r = await scan({ data: { id } });
          reload();
          return `${r.checked} 個を調べ、${r.added.length} 個を取り込みました${r.failed.length ? `。取り込めなかったもの: ${r.failed.map((f) => `${f.name}(${f.message})`).join("、")}` : ""}`;
        })}>{busy === "scan" ? "取り込んでいます…" : "inbox/ から取り込む"}</Btn>
        <Info>保存先の inbox/ に .jar・.zip・.mrpack を置いて押すと、中身から配布元を探して(Modrinth・CurseForge)ライブラリに載せます。見つからないものは、アップロードしたものとして載せます。取り込んだものは inbox/ から消します。</Info>
      </span>
    </div>
  );
}
