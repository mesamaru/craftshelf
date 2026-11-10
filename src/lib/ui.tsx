// 画面の部品(Liquid Glass 風)。見た目は src/styles.css、使い分けは docs/UI.md
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 線だけの小さなアイコン(24 × 24)
const ICONS = {
  library: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M8 4v16" /></>,
  sets: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="8" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /><rect x="13" y="13" width="8" height="8" rx="2" /></>,
  servers: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  compare: <path d="M8 3v18M16 3v18M3 8h5M16 16h5" />,
  team: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.5A5 5 0 0 1 21.5 19" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  more: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  jobs: <><path d="M12 6v6l4 2" /><circle cx="12" cy="12" r="9" /></>,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  sort: <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};
export type IconName = keyof typeof ICONS;
export const Icon = ({ name }: { name: IconName }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** カプセル型のボタン。kind: pri = いちばん大事な 1 つ / sec = ふつう / tint = すすめる操作 / red = 消す・外す */
export function Btn({ kind = "sec", sm, className, ...p }: ButtonProps & { kind?: "pri" | "sec" | "tint" | "red"; sm?: boolean }) {
  return <button type="button" className={`btn ${kind}${sm ? " sm" : ""}${className ? ` ${className}` : ""}`} {...p} />;
}

/** 丸いボタン(絞り込み・選ぶもの)。on = 選んでいる、warn = 気を付けるもの(更新あり・前提不足) */
export function Chip({ on, warn, className, ...p }: ButtonProps & { on?: boolean; warn?: boolean }) {
  return <button type="button" aria-pressed={!!on} className={`chip${on ? " on" : ""}${warn ? " warn" : ""}${className ? ` ${className}` : ""}`} {...p} />;
}

/** 絞り込みの欄: 丸いボタンを 1 行に並べ(入りきらない分は横に流す。マウスのホイールでも横に動く)、右に tools を固定する */
export function ChipBar({ children, tools, label }: { children: ReactNode; tools?: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 縦のホイールを横に。横に動けないとき(端・入りきっている)はページを動かす
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div className="fbar">
      <div className="chips" ref={ref} role="group" aria-label={label}>{children}</div>
      {tools && <div className="tools">{tools}</div>}
    </div>
  );
}

/** 絞り込みの欄の右の道具(アイコンと短い名前。スマホはアイコンだけ) */
export function Tool({ icon, label, count, ...p }: ButtonProps & { icon: IconName; label: string; count?: number }) {
  return (
    <button type="button" className="tool glass" aria-label={label} title={label} {...p}>
      <Icon name={icon} /><span className="lbl">{label}</span>{!!count && <span className="cnt">{count}</span>}
    </button>
  );
}

/** 切り替え(シートの中のタブ・並べ替え) */
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg-ctl" role="tablist" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" role="tab" aria-selected={v === value} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

/** グループの中の押せる行 */
export function Row({ onClick, className, children }: { onClick?: () => void; className?: string; children: ReactNode }) {
  return <div className={`row${onClick ? " click" : ""}${className ? ` ${className}` : ""}`} onClick={onClick}>{children}</div>;
}

/** ⓘ: 押すと出る小さな説明(画面に長い説明を出しっぱなしにしない)。外を押す・Esc で閉じる */
export function Info({ children, label = "説明" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <span className="info-wrap" ref={ref}>
      <button type="button" className="info" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>i</button>
      {open && <span className="tip" role="tooltip">{children}</span>}
    </span>
  );
}

// 画面の上に重ねるもの(シート・操作のバー)は body の直下に置く(ガラスの中だと、ぼかしのせいで位置がずれるため)
const Over = ({ children }: { children: ReactNode }) => (typeof document === "undefined" ? null : createPortal(children, document.body));

/** 右から出るシート(スマホは下から)。外を押す・Esc・✕ で閉じる。head は題の前(アイコン)、actions は題の後ろ(☆ など)に置く */
export function Sheet({ title, label, head, actions, onClose, children }: { title: ReactNode; label?: string; head?: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); back?.focus?.(); };
  }, []);
  return (
    <Over>
      <div className="scrim sheet-scrim" onMouseDown={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
        <div className="grab" />
        <header>{head}<h3>{title}</h3>{actions}<button ref={close} type="button" className="iconbtn" aria-label="閉じる" onClick={onClose}><Icon name="close" /></button></header>
        <div className="body">{children}</div>
      </aside>
    </Over>
  );
}

/** 一覧で選ぶと下に出る操作のバー */
export function ActionBar({ children, label }: { children: ReactNode; label: string }) {
  return <Over><div className="actionbar glass" role="toolbar" aria-label={label}>{children}</div></Over>;
}
