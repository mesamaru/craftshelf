// 「＋ 追加」のシート: 配布元で探す / ページの URL から / ファイルをアップロード(自分用の版だけ)してライブラリに足す
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { addLibraryItem, addLibraryItemFromUrl, type libraryCatalog, searchCatalog } from "./library-api";
import { ITEM_TYPES, ITEM_TYPE_IDS, type ItemType } from "./platforms";
import { SOURCE_LABEL, type Source, pageUrl } from "./sources";
import { ItemIcon } from "./type-icon";
import { Btn, Chip, Info, Seg, Sheet } from "./ui";

const message = (e: unknown) => (e instanceof Error ? e.message : "うまくいきませんでした");
type Catalog = Awaited<ReturnType<typeof libraryCatalog>>;
type Mode = "find" | "url" | "upload";

/** ライブラリが変わったとき(足した・外した)に送る。枠の数と、ライブラリの画面が読み直す */
export const LIBRARY_CHANGED = "craftshelf:library";
export const libraryChanged = () => window.dispatchEvent(new Event(LIBRARY_CHANGED));

export function AddSheet({ cat, local, onClose }: { cat: Catalog | null; local: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("find");
  const modes: [Mode, string][] = [["find", "探す"], ["url", "URL"], ...(local ? [["upload", "アップロード"] as [Mode, string]] : [])];
  return (
    <Sheet title="追加" onClose={onClose}>
      <Seg label="足し方" value={mode} options={modes} onChange={setMode} />
      {mode === "find" && <AddFromSource sources={(cat?.sources as Source[] | undefined) ?? ["modrinth", "spigot"]} have={new Set(cat?.items.map((i) => `${i.source}:${i.projectId}`))} />}
      {mode === "url" && <AddFromUrl />}
      {mode === "upload" && <Upload />}
    </Sheet>
  );
}

// 配布元で探して足す
function AddFromSource({ sources, have }: { sources: Source[]; have: Set<string> }) {
  const search = useServerFn(searchCatalog);
  const add = useServerFn(addLibraryItem);
  const [source, setSource] = useState<Source>("modrinth");
  const [type, setType] = useState<ItemType>("plugin");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchCatalog>> | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const find = async (t = type, src = source) => {
    setError("");
    setBusy("find");
    try {
      setHits(await search({ data: { query, type: t, source: src } }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const pick = async (projectId: string) => {
    setBusy(projectId);
    setError("");
    try {
      await add({ data: { projectId, source, type } });
      setAdded((x) => new Set(x).add(`${source}:${projectId}`));
      libraryChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const pickSource = (src: Source) => { const t = src === "spigot" ? "plugin" : type; setSource(src); setType(t); if (hits) find(t, src); };
  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); find(); }}>
        <input className="input" type="search" placeholder="名前(空なら人気順)" aria-label="名前で探す" value={query} onChange={(e) => setQuery(e.target.value)} />
      </form>
      <div className="chips">
        {sources.map((x) => <Chip key={x} on={x === source} onClick={() => pickSource(x)}>{SOURCE_LABEL[x]}</Chip>)}
        <select className="chip" value={type} aria-label="種類" disabled={source === "spigot"} onChange={(e) => { const t = e.target.value as ItemType; setType(t); if (hits) find(t); }}>
          {ITEM_TYPE_IDS.map((t) => <option key={t} value={t}>{ITEM_TYPES[t]}</option>)}
        </select>
        <Btn kind="pri" sm disabled={busy === "find"} onClick={() => find()}>{busy === "find" ? "探しています…" : "探す"}</Btn>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {hits && (
        <section className="group">
          {hits.length === 0 && <p className="row muted">見つかりませんでした。</p>}
          {hits.map((h) => {
            const key = `${source}:${h.projectId}`;
            return (
              <div className="row" key={h.projectId}>
                <span className="ic"><ItemIcon type={type} url={h.iconUrl} /></span>
                <span className="mid">
                  <a className="ttl name" href={pageUrl(source, h.projectId, h.slug)} target="_blank" rel="noreferrer noopener" translate="no">{h.title}</a>
                  <span className="sub" translate="no">{h.summary}</span>
                </span>
                {have.has(key) || added.has(key) ? <span className="trail muted small">登録済み</span>
                  : <Btn kind="tint" sm disabled={!!busy} onClick={() => pick(h.projectId)}>{busy === h.projectId ? "足しています…" : "足す"}</Btn>}
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}

// 配布元のページの URL から足す
function AddFromUrl() {
  const add = useServerFn(addLibraryItemFromUrl);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await add({ data: { url } });
      setNote(`${r.title} を足しました`);
      setUrl("");
      libraryChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="chips" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input className="input" type="url" placeholder="ページの URL(Modrinth・SpigotMC・CurseForge)" aria-label="配布元のページの URL" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn pri" type="submit" disabled={busy || !url.trim()}>{busy ? "足しています…" : "足す"}</button>
      {note && <p className="muted" role="status" translate="no">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

// ファイルをアップロード(自分用の版だけ)。jar を調べて、名前と版・動くサーバーの種類を読み取る。
// いくつでも・フォルダごと(中の .jar だけ)・ドラッグ&ドロップでも選べる。1 つずつ順に送る
const isAddon = (f: File) => /[.](jar|zip|mrpack)$/i.test(f.name);
async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void, ng: () => void) => void;
    createReader?: () => { readEntries: (ok: (l: Entry[]) => void, ng: () => void) => void } };
  const out: File[] = [];
  const walk = async (e: Entry, inDir: boolean): Promise<void> => {
    if (e.isFile && e.file) {
      const f = await new Promise<File | null>((ok) => e.file!(ok, () => ok(null)));
      if (f && (!inDir || isAddon(f))) out.push(f);
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((ok) => reader.readEntries(ok, () => ok([])));
        if (!batch.length) break;
        for (const x of batch) await walk(x, true);
      }
    }
  };
  const entries = Array.from(dt.items ?? []).filter((i) => i.kind === "file")
    .map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((e) => !e)) return Array.from(dt.files ?? []);
  for (const e of entries) await walk(e!, false);
  return out;
}

function Upload() {
  const [busy, setBusy] = useState("");
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  const send = async (list: File[]) => {
    if (!list.length) {
      setResults([{ name: "", ok: false, text: "jar・zip のファイルが見つかりませんでした" }]);
      return;
    }
    const out: typeof results = [];
    for (const [i, f] of list.entries()) {
      setBusy(`送っています… ${i + 1} / ${list.length}`);
      try {
        const res = await fetch(`/api/library/upload?filename=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        const j = await res.json();
        out.push(res.ok ? { name: f.name, ok: true, text: `${j.title} ${j.version}(${(ITEM_TYPES as Record<string, string>)[j.projectType] ?? j.projectType})` } : { name: f.name, ok: false, text: j.message });
      } catch {
        out.push({ name: f.name, ok: false, text: "送れませんでした" });
      }
      setResults([...out]);
    }
    setBusy("");
    libraryChanged();
  };
  const pick = (files: FileList | null, folder: boolean) => {
    const l = Array.from(files ?? []);
    if (l.length) send(folder ? l.filter(isAddon) : l);
  };
  const ok = results.filter((r) => r.ok).length;
  return (
    <>
      <div className={`drop${over ? " on" : ""}`}
        onDragOver={(e) => { if (busy || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (busy) return; e.preventDefault(); setOver(false); droppedFiles(e.dataTransfer).then(send); }}>
        <span>{busy || (over ? "ここで離すと送ります" : "ここにドロップ")}</span>
        <span className="chips">
          <label className="btn sm">ファイル<input type="file" accept=".jar,.zip,.mrpack" multiple hidden disabled={!!busy} onChange={(e) => { pick(e.target.files, false); e.target.value = ""; }} /></label>
          <label className="btn sm">フォルダ<input type="file" multiple hidden disabled={!!busy} {...{ webkitdirectory: "" }} onChange={(e) => { pick(e.target.files, true); e.target.value = ""; }} /></label>
        </span>
      </div>
      <p className="muted small">jar・zip・mrpack、1 つ 1 GB まで
        <Info><span>配布元に無いプラグイン・Mod(jar)と、データパック・リソースパック・シェーダー・Modパック(zip・mrpack)を、ファイルのままライブラリに載せます。jar は中の plugin.yml・fabric.mod.json などから名前・版・動くサーバーの種類を、zip は pack.mcmeta・shaders/ などから種類を読み取り、同じ名前のものは新しい版として足します。置き場所は「チーム」→「保存先」で決められます(1 つ 1 GB まで)。</span></Info>
      </p>
      {results.length > 1 && <p className="muted">{`${results.length} 個のうち ${ok} 個を載せました`}</p>}
      {results.length > 0 && (
        <section className="group">
          {results.map((r, i) => <p key={i} className={`row ${r.ok ? "muted" : "error"}`} translate="no">{r.name ? `${r.name}: ` : ""}{r.ok ? `載せました — ${r.text}` : r.text}</p>)}
        </section>
      )}
    </>
  );
}
