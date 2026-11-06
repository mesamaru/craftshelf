import { useEffect, useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { authClient } from "~/lib/auth-client";
import { addLibraryItem, installMod, libraryCatalog, removeLibraryItem, searchCatalog } from "~/lib/library-api";
import { localEnabled } from "~/lib/servers-api";
import { SOURCE_LABEL, type ItemSource, type Source, isItemSource, pageUrl } from "~/lib/sources";
import { removeUploadedFile, uploadedFiles } from "~/lib/uploads-api";
import { createShare } from "~/lib/shares-api";
import { useCan } from "~/lib/use-can";
import { Bell } from "~/lib/bell";
import { OPEN_PALETTE } from "~/lib/palette";
import { recentEvents } from "~/lib/events-api";
import { listSets } from "~/lib/sets-api";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login" });
    return { user: context.user };
  },
  component: Home,
});

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
const TYPE_LABEL: Record<string, string> = { plugin: "プラグイン", mod: "Mod" };

type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;

// ライブラリ: チームで使う Mod・プラグインの目録(どのサーバーにどの版が入っているか・サーバーに入れる)
function Home() {
  const { user } = Route.useRouteContext();
  const { data: team } = authClient.useActiveOrganization();
  const { can } = useCan(user.id);
  const load = useServerFn(libraryCatalog);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const reload = () => { load().then((c) => { setCat(c); setError(""); }, (e) => setError(message(e))); };
  useEffect(reload, [team?.id]);
  const isLocal = useServerFn(localEnabled);
  const [uploads, setUploads] = useState(false); // アップロードは自分用の版だけ
  useEffect(() => { isLocal().then(setUploads, () => setUploads(false)); }, []);

  const edit = can({ library: ["edit"] });
  return (
    <main className="page narrow">
      <header className="bar">
        <h1>ライブラリ</h1>
        <button type="button" className="capsule small" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))} title="Ctrl+K でも開けます">検索</button>
        <Link to="/team" className="capsule" aria-label="チーム">
          <span translate="no">{team?.name ?? "チーム"}</span>
        </Link>
        <Link to="/settings" className="capsule" aria-label="アカウントの設定">
          <span translate="no">{user.name}</span>
        </Link>
        <Notices />
      </header>
      {can({ member: ["update"] }) && cat && <Guide cat={cat} members={team?.members.length ?? 1} />}
      <section className="group">
        <Link to="/servers" className="row link">サーバー(起動・停止・パネルの登録)</Link>
        <Link to="/sets" className="row link">セット(まとめてサーバーに入れる)</Link>
      </section>

      <div className="group-title">Mod・プラグイン</div>
      <section className="group">
        {!cat && !error && <div className="row muted">読み込んでいます…</div>}
        {cat?.items.length === 0 && <div className="row muted">まだ何もありません。サーバーに入れたものは自動でここに載ります。下の「配布元から足す」でも登録できます。</div>}
        {cat?.items.map((i) => <Item key={i.id} item={i} servers={cat.servers} edit={edit} onChange={reload} />)}
        {error && <p className="row error" role="alert">{error}</p>}
      </section>
      <p className="foot">チームで使う Mod・プラグインの一覧です。Modrinth・SpigotMC のものは、サーバーが配布元から直接取り込みます(アップロードしたものは、保存先から送ります)。入れる版は、サーバーの種類とバージョンに合うものを選びます(Paper のサーバーには Paper 向けの作りを優先)。</p>

      {edit && uploads && <Upload onDone={reload} />}
      {edit && cat && <AddFromSource sources={cat.sources as Source[]} have={new Set(cat.items.map((i) => `${i.source}:${i.projectId}`))} onAdded={reload} />}
    </main>
  );
}

function Item({ item, servers, edit, onChange }:
  { item: Catalog["items"][number]; servers: Catalog["servers"]; edit: boolean; onChange: () => void }) {
  const install = useServerFn(installMod);
  const remove = useServerFn(removeLibraryItem);
  const [busy, setBusy] = useState("");
  const [showFiles, setShowFiles] = useState(false);
  const [error, setError] = useState("");
  const have = new Set(item.installs.map((x) => x.serverId));
  const targets = servers.filter((s) => s.type === item.projectType && !have.has(s.id));

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
    <div className="row hit">
      {item.iconUrl ? <img src={item.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="icon-ph" />}
      <span className="main">
        {pageUrl(item.source, item.projectId, item.slug)
          ? <a href={pageUrl(item.source, item.projectId, item.slug)} target="_blank" rel="noreferrer noopener" translate="no">{item.title}</a>
          : <span translate="no" className="strong">{item.title}</span>}
        <span className="muted">
          {TYPE_LABEL[item.projectType] ?? item.projectType} · {isItemSource(item.source) ? SOURCE_LABEL[item.source] : item.source} · {item.installs.length
            ? <span translate="no">{item.installs.map((x) => `${x.serverName} ${x.versionNumber}`).join("、")}</span>
            : "どのサーバーにも入っていません"}
        </span>
        {busy && <span className="muted">{busy === "remove" ? "外しています…" : "サーバーに入れています…"}</span>}
        {error && <span className="error" role="alert">{error}</span>}
        {item.source === "upload" && <button className="link small" type="button" onClick={() => setShowFiles((v) => !v)}>{showFiles ? "版を閉じる" : "版を見る"}</button>}
        {showFiles && <Files itemId={item.id} title={item.title} edit={edit} />}
      </span>
      {edit && targets.length > 0 && (
        <select className="trail" value="" disabled={!!busy} aria-label={`${item.title} をサーバーに入れる`}
          onChange={(e) => { const sid = e.target.value; if (sid && isItemSource(item.source)) run(sid, () => install({ data: { id: sid, projectId: item.projectId, source: item.source as ItemSource } })); }}>
          <option value="">サーバーに入れる…</option>
          {targets.map((s) => <option key={s.id} value={s.id} translate="no">{s.name}</option>)}
        </select>
      )}
      {edit && (
        <button className={`${targets.length ? "" : "trail "}link danger`} type="button" disabled={!!busy}
          onClick={() => confirm(`${item.title} をライブラリから外しますか?(サーバーに入っているファイルはそのままです)`) && run("remove", () => remove({ data: { itemId: item.id } }))}>
          外す
        </button>
      )}
    </div>
  );
}

function AddFromSource({ sources, have, onAdded }: { sources: Source[]; have: Set<string>; onAdded: () => void }) {
  const search = useServerFn(searchCatalog);
  const add = useServerFn(addLibraryItem);
  const [source, setSource] = useState<Source>("modrinth");
  const [type, setType] = useState<"plugin" | "mod">("plugin");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchCatalog>> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const find = async (t = type, src = source) => {
    setError("");
    try {
      setHits(await search({ data: { query, type: t, source: src } }));
    } catch (e) {
      setError(message(e));
    }
  };

  const pick = async (projectId: string) => {
    setBusy(projectId);
    setError("");
    try {
      await add({ data: { projectId, source, type } });
      onAdded();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="group-title">配布元から足す</div>
      <form className="group form" onSubmit={(e) => (e.preventDefault(), find())}>
        <div className="row">
          <span>配布元</span>
          <select className="trail" value={source} aria-label="配布元"
            onChange={(e) => { const src = e.target.value as Source; const t = src === "spigot" ? "plugin" : type; setSource(src); setType(t); if (hits) find(t, src); }}>
            {sources.map((x) => <option key={x} value={x}>{SOURCE_LABEL[x]}</option>)}
          </select>
        </div>
        <div className="row">
          <span>種類</span>
          <select className="trail" value={type} aria-label="種類" disabled={source === "spigot"} onChange={(e) => { const t = e.target.value as "plugin" | "mod"; setType(t); if (hits) find(t); }}>
            <option value="plugin">プラグイン</option>
            <option value="mod">Mod</option>
          </select>
        </div>
        <input className="row" type="search" placeholder="名前で探す(空なら人気順)" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!hits && <button className="row link" type="submit">探す</button>}
        {hits?.length === 0 && <p className="row muted">見つかりませんでした。</p>}
        {hits?.map((h) => (
          <div className="row hit" key={h.projectId}>
            {h.iconUrl ? <img src={h.iconUrl} alt="" width={40} height={40} loading="lazy" /> : <span className="icon-ph" />}
            <span className="main">
              <a href={pageUrl(source, h.projectId, h.slug)} target="_blank" rel="noreferrer noopener" translate="no">{h.title}</a>
              <span className="muted summary" translate="no">{h.summary}</span>
              <span className="muted">{h.downloads.toLocaleString("ja-JP")} ダウンロード</span>
            </span>
            {have.has(`${source}:${h.projectId}`) ? (
              <span className="trail muted">登録済み</span>
            ) : (
              <button className="trail capsule" type="button" disabled={!!busy} onClick={() => pick(h.projectId)}>
                {busy === h.projectId ? "足しています…" : "足す"}
              </button>
            )}
          </div>
        ))}
        {error && <p className="row error" role="alert">{error}</p>}
      </form>
    </>
  );
}

// アップロードしたものの版(ダウンロード・消す)
function Files({ itemId, title, edit }: { itemId: string; title: string; edit: boolean }) {
  const load = useServerFn(uploadedFiles);
  const remove = useServerFn(removeUploadedFile);
  const share = useServerFn(createShare);
  const [link, setLink] = useState("");
  const [files, setFiles] = useState<Awaited<ReturnType<typeof uploadedFiles>> | null>(null);
  const [error, setError] = useState("");
  const reload = () => { load({ data: { itemId } }).then(setFiles, (e) => setError(message(e))); };
  useEffect(reload, [itemId]);
  return (
    <span className="files">
      {files?.map((f) => (
        <span key={f.id} className="muted">
          <span translate="no">{f.version || f.filename}</span>({(f.size / 1024).toFixed(0)} KB・{new Date(f.createdAt).toLocaleDateString("ja-JP")}{f.loaders.length ? `・${f.loaders.join(" / ")}` : ""})
          {" "}<a href={`/api/library/files/${f.id}`} download>ダウンロード</a>
          {edit && <>{" "}<button className="link danger small" type="button"
            onClick={() => confirm(`${f.filename} を消しますか?(保存先からも消えます。サーバーに入っているものはそのままです)`) && remove({ data: { fileId: f.id } }).then(reload, (e) => setError(message(e)))}>消す</button></>}
        </span>
      ))}
      {edit && files && files.length > 0 && (
        <button className="link small" type="button"
          onClick={() => share({ data: { itemIds: [itemId], hours: 168, name: title } }).then((r) => setLink(r.url), (e) => setError(message(e)))}>
          共有リンクを作る(いちばん新しい版・7 日)
        </button>
      )}
      {link && (
        <span className="muted">
          <input className="codes share-url" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="共有リンクの URL" />
          {" "}<button className="link small" type="button" onClick={() => navigator.clipboard?.writeText(link)}>コピー</button>
          {" "}(この URL は今だけ表示します。消すのは「チーム」→「共有リンク」から)
        </span>
      )}
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}

// ファイルをアップロード(自分用の版だけ)。jar を調べて、名前と版・動くサーバーの種類を読み取る
function Upload({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  const send = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    const out: typeof results = [];
    for (const f of Array.from(list)) {
      try {
        const res = await fetch(`/api/library/upload?filename=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        const j = await res.json();
        out.push(res.ok ? { name: f.name, ok: true, text: `${j.title} ${j.version}(${TYPE_LABEL[j.projectType] ?? j.projectType})` } : { name: f.name, ok: false, text: j.message });
      } catch {
        out.push({ name: f.name, ok: false, text: "送れませんでした" });
      }
      setResults([...out]);
    }
    setBusy(false);
    onDone();
  };
  return (
    <>
      <div className="group-title">ファイルをアップロード</div>
      <section className="group form">
        <label className="row link">
          {busy ? "送っています…" : "jar を選ぶ(いくつでも)"}
          <input type="file" accept=".jar" multiple hidden disabled={busy} onChange={(e) => { send(e.target.files); e.target.value = ""; }} />
        </label>
        {results.map((r, i) => <p key={i} className={`row ${r.ok ? "muted" : "error"}`} translate="no">{r.name}: {r.ok ? `載せました — ${r.text}` : r.text}</p>)}
      </section>
      <p className="foot">配布元に無いプラグイン・Mod を、jar のままライブラリに載せます。中の plugin.yml・fabric.mod.json などから名前・版・動くサーバーの種類を読み取り、同じ名前のものは新しい版として足します。置き場所は「チーム」→「保存先」で決められます(100 MB まで)。</p>
    </>
  );
}

// お知らせ: 最近の出来事。前に開いたあとのものを数える(ブラウザごと)
const SEEN = "craftshelf.notices-seen";
function Notices() {
  const load = useServerFn(recentEvents);
  const [list, setList] = useState<Awaited<ReturnType<typeof recentEvents>> | null>(null);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState("");
  useEffect(() => {
    setSeen(localStorage.getItem(SEEN) ?? "");
    load().then(setList, () => setList([]));
  }, []);
  const unread = (list ?? []).filter((e) => e.at > seen).length;
  const toggle = (v: boolean) => {
    setOpen(v);
    if (v && list?.length) {
      localStorage.setItem(SEEN, list[0].at);
      setSeen(list[0].at);
    }
  };
  return (
    <Bell open={open} setOpen={toggle} count={unread} label={`お知らせ ${unread} 件`}>
      {!list?.length && <div className="row muted">お知らせはありません</div>}
      {list?.map((e) => (
        <div className="row" key={e.id}>
          <span className="main">
            <span>{e.action}{e.target ? <>: <span translate="no">{e.target}</span></> : null}</span>
            <span className="muted small" translate="no">{new Date(e.at).toLocaleString("ja-JP")}{e.userName ? ` · ${e.userName}` : ""}{e.detail ? ` · ${e.detail.split("\n")[0].slice(0, 80)}` : ""}</span>
          </span>
        </div>
      ))}
    </Bell>
  );
}

// はじめての設定(管理者以上)。すべて済んだら・「閉じる」を押したら出さない(ブラウザごと)
const GUIDE = "craftshelf.guide-hidden";
function Guide({ cat, members }: { cat: Catalog; members: number }) {
  const sets = useServerFn(listSets);
  const [setCount, setSetCount] = useState<number | null>(null);
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    setHidden(localStorage.getItem(GUIDE) === "1");
    sets().then((s) => setSetCount(s.length), () => setSetCount(0));
  }, []);
  const steps = [
    { done: cat.servers.length > 0, label: "サーバーをつなぐ(Pterodactyl パネル・フォルダ)", to: "/servers" as const },
    { done: cat.servers.length > 0 && cat.servers.every((s) => s.type), label: "サーバーの種類(Paper・Fabric など)を選ぶ", to: "/servers" as const },
    { done: cat.items.length > 0, label: "ライブラリに Mod・プラグインを足す(下の「配布元から足す」)", to: null },
    { done: (setCount ?? 0) > 0, label: "セットを作って、まとめて入れる", to: "/sets" as const },
    { done: members > 1, label: "チームの人を招待する", to: "/team" as const },
  ];
  if (hidden || setCount === null || steps.every((s) => s.done)) return null;
  return (
    <>
      <div className="group-title">はじめての設定</div>
      <section className="group">
        {steps.map((s) => (
          <div className="row" key={s.label}>
            <span className={`main${s.done ? " muted" : ""}`}>{s.done ? "✓ " : "・"}{s.label}</span>
            {!s.done && s.to && <Link to={s.to} className="trail link">開く</Link>}
          </div>
        ))}
        <button className="row link" type="button" onClick={() => { localStorage.setItem(GUIDE, "1"); setHidden(true); }}>このガイドを閉じる</button>
      </section>
    </>
  );
}
