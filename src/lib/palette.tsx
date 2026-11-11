// どの画面からでも Ctrl+K(Mac は ⌘K)で開く検索(v02 の検索)。画面・サーバー・セット・ライブラリのものを探して開く
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { libraryCatalog } from "./library-api";
import { listServers } from "./servers-api";
import { listSets } from "./sets-api";

type Hit = { label: string; sub: string; to: string; params?: Record<string, string>; search?: Record<string, string> };
const PAGES: Hit[] = [
  { label: "ライブラリ", sub: "画面", to: "/" },
  { label: "ホーム", sub: "画面", to: "/home" },
  { label: "アドオンの整理", sub: "画面", to: "/cleanup" },
  { label: "サーバー", sub: "画面", to: "/servers" },
  { label: "セット", sub: "画面", to: "/sets" },
  { label: "サーバーの比較", sub: "画面", to: "/compare" },
  { label: "ファイル比較", sub: "画面", to: "/compare/files" },
  { label: "ポート", sub: "画面", to: "/ports" },
  { label: "チーム", sub: "画面", to: "/team" },
  { label: "アカウントの設定", sub: "画面", to: "/settings" },
  { label: "操作の記録と Discord への通知", sub: "画面", to: "/activity" },
  { label: "保存先", sub: "画面", to: "/storage" },
  { label: "共有リンク", sub: "画面", to: "/shares" },
  { label: "利用状況", sub: "画面", to: "/usage" },
  { label: "バックアップ", sub: "画面", to: "/backup" },
  { label: "処理の一覧", sub: "画面", to: "/jobs" },
  { label: "API の説明", sub: "画面", to: "/api-docs" },
];
export const OPEN_PALETTE = "craftshelf:palette";

export function Palette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [data, setData] = useState<Hit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((x) => !x);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener("keydown", key);
    window.addEventListener(OPEN_PALETTE, show);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener(OPEN_PALETTE, show); };
  }, []);
  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setTimeout(() => input.current?.focus(), 0);
    // 開くたびに読み直す(読めないものは飛ばす)
    Promise.all([listServers().catch(() => []), listSets().catch(() => []), libraryCatalog().catch(() => null)]).then(([servers, sets, cat]) => {
      setData([
        ...servers.map((s) => ({ label: s.name, sub: "サーバー", to: "/servers/$id", params: { id: s.id } })),
        ...sets.map((s) => ({ label: s.name, sub: "セット", to: "/sets" })),
        // ライブラリのものは、ライブラリの詳しくを開く(どのサーバーに入っているかはライブラリには出さない。03.68.00 から)
        ...(cat?.items ?? []).map((i) => ({ label: i.title, sub: "ライブラリ", to: "/", search: { item: i.id } })),
      ]);
    });
  }, [open]);

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    const all = [...PAGES, ...(data ?? [])];
    return (t ? all.filter((h) => h.label.toLowerCase().includes(t) || h.sub.toLowerCase().includes(t)) : all).slice(0, 30);
  }, [q, data]);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    setOpen(false);
    router.navigate({ to: h.to as never, params: h.params as never, search: h.search as never });
  };
  if (!open) return null;
  return (
    <div className="scrim palette-scrim" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="検索" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="palette-input" placeholder="画面・サーバー・セット・ライブラリを探す" value={q} aria-label="検索"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(x + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); go(hits[sel]); }
          }} />
        <div className="palette-list" role="listbox">
          {hits.length === 0 && <div className="row muted">見つかりませんでした。</div>}
          {hits.map((h, i) => (
            <button key={`${h.sub}:${h.label}:${i}`} type="button" role="option" aria-selected={i === sel} className={`row palette-hit${i === sel ? " on" : ""}`}
              onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <span className="main" translate={h.sub === "画面" ? undefined : "no"}>{h.label}</span>
              <span className="trail muted small" translate="no">{h.sub}</span>
            </button>
          ))}
        </div>
        <p className="foot">↑↓ で選び、Enter で開きます。Esc で閉じます。</p>
      </div>
    </div>
  );
}
