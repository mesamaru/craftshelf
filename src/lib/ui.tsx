// 画面の部品(Liquid Glass 風)。見た目は src/styles.css、使い分けは docs/UI.md
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 線だけの小さなアイコン(24 × 24)
// メニューのアイコンは v02 と同じ形(ライブラリ = 箱・ホーム = 4 つの四角・セット = 重ねた板)
const ICONS = {
  library: <><path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>,
  home: <><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>,
  sets: <><path d="M12 3 3 7.5l9 4.5 9-4.5z" /><path d="M3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  reload: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  back: <path d="m15 18-6-6 6-6" />,
  fwd: <path d="m9 18 6-6-6-6" />,
  tray: <><path d="M4 13h4l2 3h4l2-3h4" /><path d="M4 13 6.5 5h11L20 13v6H4z" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  wand: <><path d="m4 20 11-11M14 4v3M18 6l-2 2M20 10h-3" /></>,
  puzzle: <path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13 7 4 4" /></>,
  download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  disk: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 15h.01M11 15h6" /></>,
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
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeoff: <><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.5 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1.1" /><path d="m3 3 18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  shrink: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  grip: <><circle cx="9" cy="6" r="1.3" /><circle cx="15" cy="6" r="1.3" /><circle cx="9" cy="12" r="1.3" /><circle cx="15" cy="12" r="1.3" /><circle cx="9" cy="18" r="1.3" /><circle cx="15" cy="18" r="1.3" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  play: <path d="M8 5v14l11-7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M16 7l3 3M14 9l2 2" /></>,
  shield: <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" />,
  chart: <path d="M5 20V10M12 20V4M19 20v-7" />,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  chat: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
  logout: <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />,
};
export type IconName = keyof typeof ICONS;
export const Icon = ({ name }: { name: IconName }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** ファイルの大きさ(v02 と同じ「2.0 KB」の形) */
export const fmtSize = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

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
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    close.current?.focus();
    // シートの上にシートを重ねたときは、いちばん上のものだけ閉じる
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && self.current === [...document.querySelectorAll(".sheet")].at(-1)) onClose(); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); back?.focus?.(); };
  }, []);
  return (
    <Over>
      <div className="scrim sheet-scrim" onMouseDown={onClose} />
      <aside ref={self} className="sheet" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
        <div className="grab" />
        <header>{head}<h3>{title}</h3>{actions}<button ref={close} type="button" className="iconbtn" aria-label="閉じる" onClick={onClose}><Icon name="close" /></button></header>
        <div className="body">{children}</div>
      </aside>
    </Over>
  );
}

/** 画面の中のタブ(サーバーの詳細の 概要・アドオン など)。シートの中は Seg */
export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs glass" role="tablist" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" role="tab" aria-selected={v === value} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean };

/** 「⋯」: 押すと出る操作の一覧(行・見出しの欄で、ボタンを並べきれないとき)。外を押す・Esc・スクロールで閉じる */
export function Menu({ items, label = "その他の操作", disabled }: { items: (MenuItem | false | "" | null | undefined)[]; label?: string; disabled?: boolean }) {
  const list = items.filter((i): i is MenuItem => !!i);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const down = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); btn.current?.focus(); } };
    pop.current?.querySelector("button")?.focus();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true); // シートの Esc より先に受ける
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [at]);
  if (!list.length) return null;
  // 下に入りきらなければ上に出す(画面の下のほうの行)
  const open = () => {
    const r = btn.current!.getBoundingClientRect();
    const right = Math.max(8, innerWidth - r.right);
    setAt(r.bottom + 44 * list.length + 16 > innerHeight ? { bottom: innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  };
  return (
    <>
      <button ref={btn} type="button" className="iconbtn more" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!at} disabled={disabled}
        onClick={(e) => { e.stopPropagation(); if (at) setAt(null); else open(); }}><Icon name="more" /></button>
      {at && (
        <Over>
          <div ref={pop} className="menu" role="menu" aria-label={label} style={at}>
            {list.map((i) => (
              <button key={i.label} type="button" role="menuitem" className={i.danger ? "danger" : undefined} disabled={i.disabled}
                onClick={() => { setAt(null); i.onClick(); }}>{i.label}</button>
            ))}
          </div>
        </Over>
      )}
    </>
  );
}

/** 一覧で選ぶと下に出る操作のバー */
export function ActionBar({ children, label }: { children: ReactNode; label: string }) {
  return <Over><div className="actionbar glass" role="toolbar" aria-label={label}>{children}</div></Over>;
}
