// 共有リンクを作る(アップロードしたもの。ライブラリの版の一覧と、選んだものから使う)。期限・回数の上限を選び、URL と wget・curl のコマンドを出す
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { createShare } from "~/lib/shares-api";

const HOURS: [number, string][] = [[1, "1 時間"], [24, "1 日"], [168, "7 日"], [720, "30 日"], [0, "無期限"]];
const MAX: [number, string][] = [[0, "上限なし"], [1, "1 回"], [5, "5 回"], [10, "10 回"], [100, "100 回"]];
// シェルに貼るので、シングルクォートで囲む
const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function ShareMaker({ itemIds, name, label }: { itemIds: string[]; name: string; label: string }) {
  const share = useServerFn(createShare);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(168);
  const [max, setMax] = useState(0);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Awaited<ReturnType<typeof createShare>> | null>(null);
  const [error, setError] = useState("");
  if (!open) return <button className="link small" type="button" onClick={() => setOpen(true)}>{label}</button>;
  const make = async () => {
    setBusy(true);
    setError("");
    try {
      setMade(await share({ data: { itemIds, hours, name, maxDownloads: max || null } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "うまくいきませんでした");
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text);
  const lines = made ? [
    { label: "URL", text: made.url },
    { label: "wget", text: `wget -O ${sq(made.filename)} ${sq(made.url)}` },
    { label: "curl", text: `curl -fL -o ${sq(made.filename)} ${sq(made.url)}` },
  ] : [];
  return (
    <span className="share-maker">
      {!made && (
        <span className="actions">
          <select value={hours} aria-label="共有リンクの期限" onChange={(e) => setHours(Number(e.target.value))}>
            {HOURS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
          </select>
          <select value={max} aria-label="ダウンロードできる回数" onChange={(e) => setMax(Number(e.target.value))}>
            {MAX.map(([n, l]) => <option key={n} value={n}>{l}</option>)}
          </select>
          <button className="link small" type="button" disabled={busy} onClick={make}>{busy ? "作っています…" : "リンクを作る"}</button>
          <button className="link small" type="button" onClick={() => setOpen(false)}>やめる</button>
        </span>
      )}
      {made && <span className="muted">{`${made.expiresAt ? `${new Date(made.expiresAt).toLocaleString("ja-JP")} まで使えます` : "期限はありません"}${max ? `(${max} 回まで)` : ""}。この URL は今だけ表示します。`}</span>}
      {lines.map((l) => (
        <span key={l.label} className="actions">
          <input className="codes share-url" readOnly value={l.text} translate="no" onFocus={(e) => e.currentTarget.select()} aria-label={`共有リンクの ${l.label}`} />
          <button className="link small" type="button" onClick={() => copy(l.text)}>コピー</button>
        </span>
      ))}
      {made && <span className="muted small">wget・curl は、サーバーのプラグイン・Mod のフォルダで実行すると、そのまま置けます。止める・消すのは「チーム」→「共有リンク」から。</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
