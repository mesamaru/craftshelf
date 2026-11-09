import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { activateStorageTarget, addStorageTarget, moveStorageFiles, removeStorageTarget, storageTargets } from "~/lib/uploads-api";
import { savedOptions, scanStorage, setSavedOptions, storageContents, storageStatus } from "~/lib/saved-api";

export const Route = createFileRoute("/storage")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: "/storage" } });
    return { user: context.user };
  },
  component: Storage,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const KIND_LABEL: Record<string, string> = { local: "フォルダ", webdav: "WebDAV", smb: "SMB" };
const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// アップロードしたアドオンの保存先(自分用の版・管理者以上)
function Storage() {
  const load = useServerFn(storageTargets);
  const activate = useServerFn(activateStorageTarget);
  const remove = useServerFn(removeStorageTarget);
  const [data, setData] = useState<Awaited<ReturnType<typeof storageTargets>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null); // 状況と中身を開いている保存先("" はパネルの中)
  const reload = () => load().then((d) => { setData(d); setError(""); }, (e) => setError(message(e)));
  useEffect(() => { reload(); }, []);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <main className="page narrow">
      <header className="bar">
        <Link to="/team" className="capsule">‹ チーム</Link>
        <h1>保存先</h1>
      </header>
      <div className="group-title">アップロードしたアドオンの保存先</div>
      <section className="group">
        {!data && !error && <div className="row muted">読み込んでいます…</div>}
        {data && (
          <div className="row">
            <span className="main"><span>パネルの中(既定)</span><span className="muted">/data/v03/library</span></span>
            {data.usingDefault ? <span className="trail muted">使っています</span>
              : <button className="trail link" type="button" disabled={!!busy} onClick={() => run("default", () => activate({ data: { id: null } }))}>これを使う</button>}
            <button className="link" type="button" aria-expanded={open === ""} onClick={() => setOpen(open === "" ? null : "")}>{open === "" ? "閉じる" : "状況と中身"}</button>
          </div>
        )}
        {data && open === "" && <div className="row column"><TargetDetail id={null} /></div>}
        {data?.targets.map((t) => (
          <div className="row" key={t.id}>
            <span className="main">
              <span translate="no">{t.name}</span>
              <span className="muted" translate="no">{KIND_LABEL[t.kind] ?? t.kind} · {t.summary}</span>
            </span>
            {t.active ? <span className="trail muted">使っています</span>
              : <button className="trail link" type="button" disabled={!!busy} onClick={() => run(t.id, () => activate({ data: { id: t.id } }))}>これを使う</button>}
            <button className="link" type="button" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? "閉じる" : "状況と中身"}</button>
            <button className="link danger" type="button" disabled={!!busy}
              onClick={() => confirm(`保存先「${t.name}」を消しますか?(ファイルが残っていると消せません)`) && run(`rm:${t.id}`, () => remove({ data: { id: t.id } }))}>消す</button>
          </div>
        ))}
        {data && open && <div className="row column"><TargetDetail id={open} /></div>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">これからアップロードするものの置き場所です。切り替えても、いままでのファイルは元の保存先に置いたまま使えます。NAS は、SMB で直接つなぐか、パネルのコンテナにマウントして「フォルダ」として足してください。</p>
      <SavedOptions />
      {data && data.targets.length > 0 && <MoveFiles targets={data.targets} onDone={reload} />}
      <NewTarget onDone={reload} />
    </main>
  );
}

function NewTarget({ onDone }: { onDone: () => void }) {
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
      <div className="group-title">保存先を足す</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="row">
          <span>種類</span>
          <select className="trail" value={kind} aria-label="保存先の種類" onChange={(e) => setKind(e.target.value as "local" | "webdav" | "smb")}>
            <option value="local">フォルダ(NAS をマウントしたものも)</option>
            <option value="smb">SMB(NAS に直接)</option>
            <option value="webdav">WebDAV</option>
          </select>
        </div>
        <input className="row" placeholder="名前(例 家の NAS)" translate="no" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
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
        <button className="row link" type="submit" disabled={busy}>{busy ? "確かめています…" : "書き込めるか確かめて足す"}</button>
      </form>
      <p className="foot">足すと、これからのアップロードの保存先になります。パスワードは暗号化して保存し、画面には出しません。SMB は SMB 2.0・2.1 でつなぎます(通信への署名・SMB 3 を必須にしている NAS や Windows のサーバーには、つながりません。そのときはマウントしてフォルダとして足してください)。</p>
    </>
  );
}

// 保存先のあいだでファイルを移す(移した先で中身を確かめてから、元を消す)
function MoveFiles({ targets, onDone }: { targets: { id: string; name: string }[]; onDone: () => void }) {
  const move = useServerFn(moveStorageFiles);
  const options = [{ id: "", name: "パネルの中(既定)" }, ...targets];
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    if (!confirm("ファイルを移しますか?(数が多いと時間がかかります)")) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await move({ data: { from: from || null, to: to || null } });
      setNote(`${r.moved} 個を移しました${r.failed.length ? `。移せなかったもの: ${r.failed.map((f) => `${f.filename}(${f.message})`).join("、")}` : ""}`);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="group-title">ファイルを移す</div>
      <section className="group form">
        <div className="row">
          <span>移す元</span>
          <select className="trail" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="移す元">
            {options.map((o) => <option key={o.id} value={o.id} translate="no">{o.name}</option>)}
          </select>
        </div>
        <div className="row">
          <span>移す先</span>
          <select className="trail" value={to} onChange={(e) => setTo(e.target.value)} aria-label="移す先">
            {options.map((o) => <option key={o.id} value={o.id} translate="no">{o.name}</option>)}
          </select>
        </div>
        <button className="row link" type="button" disabled={busy || from === to} onClick={submit}>{busy ? "移しています…" : "移す"}</button>
        {note && <p className="row muted" role="status" translate="no">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">1 つずつ、移した先で中身を確かめてから元を消します。移せなかったものは、元の保存先に残ります。</p>
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
      <div className="group-title">配布元のファイルの保存</div>
      <section className="group form">
        {!opt && !error && <div className="row muted">読み込んでいます…</div>}
        {opt && (
          <>
            <label className="row">
              <span className="main"><span>配布元のファイルを保存する(チームの既定)</span><span className="muted">サーバーに入れた版を、使っている保存先にも取っておきます</span></span>
              <input className="trail" type="checkbox" checked={opt.keepFiles} onChange={(e) => setOpt({ ...opt, keepFiles: e.target.checked })} />
            </label>
            <label className="row">
              <span className="main"><span>古い版を残す数</span><span className="muted">新しく保存した方から。0 は整理しない</span></span>
              <input className="trail" type="number" min={0} max={100} value={opt.keepVersions} aria-label="古い版を残す数"
                onChange={(e) => setOpt({ ...opt, keepVersions: Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))) })} />
            </label>
            <button className="row link" type="button" disabled={busy} onClick={submit}>{busy ? "保存しています…" : "保存"}</button>
          </>
        )}
        {note && <p className="row muted" role="status">{note}</p>}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">保存した版は、サーバーへ入れるときに配布元から取らず保存先から送ります(配布元が消えても・つながらなくても入れられます)。ライブラリの「保存した版」から、ダウンロード・共有リンク・まとめて zip にもできます。アイテムごとに「保存した版」で変えられます。古い版の整理では、サーバーで使っている版・セットで固定した版は消しません。</p>
      <section className="group"><Link to="/cleanup" className="row link">アドオンの整理(古い版・重複・使っていないもの)</Link></section>
    </>
  );
}

// 保存先の状況(つながるか・応答の時間・容量)と中身。inbox/ に置いたファイルを取り込める
function TargetDetail({ id }: { id: string | null }) {
  const status = useServerFn(storageStatus);
  const contents = useServerFn(storageContents);
  const scan = useServerFn(scanStorage);
  const [st, setSt] = useState<Awaited<ReturnType<typeof storageStatus>> | null>(null);
  const [list, setList] = useState<Awaited<ReturnType<typeof storageContents>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const reload = () => {
    setError("");
    status({ data: { id } }).then(setSt, (e) => setError(message(e)));
    contents({ data: { id } }).then(setList, (e) => setError(message(e)));
  };
  useEffect(reload, [id]);
  const doScan = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await scan({ data: { id } });
      setNote(`${r.checked} 個を調べ、${r.added.length} 個を取り込みました${r.failed.length ? `。取り込めなかったもの: ${r.failed.map((f) => `${f.name}(${f.message})`).join("、")}` : ""}`);
      reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const unknown = list?.entries.filter((e) => !e.dir && !e.item && !e.inbox) ?? [];
  return (
    <span className="files">
      {!st && !error && <span className="muted">確かめています…</span>}
      {st && (
        <span>
          {st.connected ? <span className="badge state-done">つながります</span> : <span className="badge state-failed">つながりません</span>}
          <span className="muted">{st.connected ? ` 応答 ${st.latencyMs} ms` : ` ${st.error}`}</span>
          {st.space && <span className="muted">{` · 容量 ${size(st.space.total)}(空き ${size(st.space.free)})`}</span>}
          <span className="muted">{` · 登録しているファイル ${st.files} 個(${size(st.bytes)}、うち保存した版 ${st.saved} 個)`}</span>
        </span>
      )}
      {list && (
        <>
          <span className="strong">中身</span>
          {list.entries.length === 0 && <span className="muted">空です</span>}
          {list.entries.map((e) => (
            <span key={e.path} className={e.dir ? "muted" : ""}>
              <span className="codes" translate="no">{e.dir ? `${e.path}/` : e.path}</span>
              {!e.dir && <span className="muted small">{` ${size(e.size)}`}</span>}
              {e.item && <span className="badge muted-badge"><span translate="no">{e.item}</span></span>}
              {e.saved && <span className="badge muted-badge">保存した版</span>}
              {!e.dir && !e.item && (e.inbox ? <span className="badge">取り込み待ち</span> : <span className="badge miss">記録なし</span>)}
            </span>
          ))}
          {list.truncated && <span className="muted">多いので、ここまでを出しています</span>}
          {unknown.length > 0 && <span className="muted small">「記録なし」は、このアプリが登録していないファイルです(バックアップ・ほかのアプリのものなど)。取り込むときは inbox/ に移してください。</span>}
        </>
      )}
      <span className="actions">
        <button className="link small" type="button" disabled={busy} onClick={doScan}>{busy ? "取り込んでいます…" : "inbox/ から取り込む"}</button>
        <button className="link small" type="button" disabled={busy} onClick={reload}>読み直す</button>
      </span>
      <span className="muted small">保存先の inbox/ に .jar・.zip・.mrpack を置いて「取り込む」を押すと、中身から配布元を探して(Modrinth・CurseForge)ライブラリに載せます。見つからないものは、アップロードしたものとして載せます。取り込んだものは inbox/ から消します。</span>
      {note && <span className="muted" role="status" translate="no">{note}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
