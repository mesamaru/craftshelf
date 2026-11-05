// ベル(お知らせ・ポートの知らせ)。押すと下に一覧を開く。外を押す・Esc で閉じる
import { type ReactNode, useEffect, useRef } from "react";

export function Bell({ open, setOpen, count, label, children }: { open: boolean; setOpen: (v: boolean) => void; count: number; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="bell-wrap" ref={ref}>
      <button className="bell" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && <span className="bell-n">{count}</span>}
      </button>
      {open && <div className="bell-pop group">{children}</div>}
    </div>
  );
}
