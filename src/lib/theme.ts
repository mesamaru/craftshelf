// 見た目の設定: 明るさ・アクセントの色・テーマ(v02 のテーマの背景と色)・背景の暗さとぼかし・背景画像。
// 背景画像のほかはアカウントに保存して、どの端末でも同じにする(サーバーにまだ無いときだけ、このブラウザの値を使う)。
// 背景画像は大きいので、このブラウザだけに置く(サーバーに送らない)
export type Mode = "auto" | "light" | "dark";
export const ACCENTS = { blue: "#0a84ff", green: "#30d158", purple: "#bf5af2", orange: "#ff9f0a", pink: "#ff375f" } as const;
export type Accent = keyof typeof ACCENTS | "auto";
export const ACCENT_LABELS: Record<Accent, string> = { auto: "テーマの色", blue: "青", green: "緑", purple: "紫", orange: "オレンジ", pink: "ピンク" };

const PIXELS = "repeating-conic-gradient(rgba(0,0,0,.05) 0 25%, transparent 0 50%) 0 0 / 32px 32px";
const STARS = [
  "radial-gradient(1.4px 1.4px at 20px 30px, rgba(255,255,255,.9), transparent) 0 0 / 140px 140px",
  "radial-gradient(1px 1px at 90px 70px, rgba(255,255,255,.7), transparent) 0 0 / 190px 190px",
  "radial-gradient(1.8px 1.8px at 50px 160px, rgba(220,200,255,.8), transparent) 0 0 / 230px 230px",
].join(", ");
// v02 のテーマ(tone = 明るさを決めるもの。accent = 「テーマの色」のときのアクセント)。standard は v03 のいつもの見た目
export const PRESETS = {
  standard: { name: "標準", tone: null, accent: null, bg: null },
  aurora: { name: "オーロラ", tone: "dark", accent: "#30d18a", bg: "radial-gradient(60% 50% at 20% 15%, rgba(61,255,170,.55), transparent 70%), radial-gradient(50% 45% at 85% 25%, rgba(138,92,255,.6), transparent 70%), radial-gradient(60% 50% at 55% 95%, rgba(0,180,255,.4), transparent 70%), linear-gradient(160deg, #050b1f, #0b1a33 50%, #06201f)" },
  sunset: { name: "サンセット", tone: "dark", accent: "#ff6f91", bg: "radial-gradient(70% 60% at 15% 5%, #ffc27a, transparent 60%), radial-gradient(60% 55% at 90% 20%, #ff6f91, transparent 65%), radial-gradient(80% 60% at 50% 105%, #5b3cff, transparent 70%), linear-gradient(180deg, #ff9a7b, #ff5f86 50%, #6e45d6)" },
  ocean: { name: "オーシャン", tone: "dark", accent: "#22d3ee", bg: "radial-gradient(60% 50% at 85% 5%, rgba(0,229,255,.5), transparent 70%), radial-gradient(70% 60% at 5% 95%, rgba(0,114,255,.55), transparent 70%), linear-gradient(170deg, #021b33, #063d5c 55%, #0a6b7a)" },
  overworld: { name: "オーバーワールド", tone: "light", accent: "#4c9a2a", bg: "linear-gradient(180deg, #6fbfff 0%, #a9dcff 48%, #d3f0ff 64%, #6cc24a 64%, #57a43a 76%, #7a5230 76%, #5e3e22 100%)" },
  nether: { name: "ネザー", tone: "dark", accent: "#ff8a3d", bg: `${PIXELS}, radial-gradient(55% 45% at 20% 90%, rgba(255,110,0,.7), transparent 70%), radial-gradient(45% 40% at 85% 75%, rgba(255,40,40,.5), transparent 70%), radial-gradient(60% 50% at 50% 0%, rgba(130,0,40,.65), transparent 70%), linear-gradient(180deg, #1a0508, #3a0a0a 60%, #5a1405)` },
  end: { name: "ジ・エンド", tone: "dark", accent: "#b388ff", bg: `${STARS}, radial-gradient(60% 50% at 70% 25%, rgba(170,90,255,.45), transparent 70%), radial-gradient(50% 40% at 15% 85%, rgba(230,220,140,.18), transparent 70%), linear-gradient(180deg, #07040f, #140a26 60%, #1e1036)` },
  pastel: { name: "パステル", tone: "light", accent: "#b05cd6", bg: "radial-gradient(50% 50% at 10% 10%, #ffcfe6, transparent 70%), radial-gradient(50% 50% at 90% 15%, #c6e2ff, transparent 70%), radial-gradient(60% 60% at 25% 90%, #d3f6e2, transparent 70%), radial-gradient(50% 50% at 90% 90%, #fff0bf, transparent 70%), #f8f6ff" },
  graphite: { name: "グラファイト", tone: "dark", accent: "#8e8e93", bg: "radial-gradient(60% 50% at 30% 0%, rgba(255,255,255,.12), transparent 70%), radial-gradient(40% 40% at 90% 90%, rgba(255,255,255,.05), transparent 70%), linear-gradient(180deg, #232326, #0c0c0e)" },
} as const satisfies Record<string, { name: string; tone: Mode | null; accent: string | null; bg: string | null }>;
export type Preset = keyof typeof PRESETS;
export const LIMITS = { dim: 80, blur: 40 };

const KEY = "craftshelf.theme";
// 背景画像は、長い辺を 1920 px までに縮めた JPEG(localStorage に入る大きさにする)
const MAX_SIDE = 1920;

/** アカウントに保存する部分 */
export type SavedTheme = { mode: Mode; accent: Accent; preset: Preset; dim: number; blur: number };
export type Theme = SavedTheme & { background: string };
export const DEFAULT_THEME: SavedTheme = { mode: "auto", accent: "auto", preset: "standard", dim: 0, blur: 0 };

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
/** 保存できる形にそろえる(知らない値は既定に。サーバーでも使う) */
export function cleanTheme(t: unknown): SavedTheme {
  const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
  return {
    mode: o.mode === "light" || o.mode === "dark" ? o.mode : "auto",
    accent: typeof o.accent === "string" && (o.accent === "auto" || o.accent in ACCENTS) ? (o.accent as Accent) : "auto",
    preset: typeof o.preset === "string" && o.preset in PRESETS ? (o.preset as Preset) : "standard",
    dim: num(o.dim, LIMITS.dim),
    blur: num(o.blur, LIMITS.blur),
  };
}

/** このブラウザに保存した見た目(無ければ null) */
export function localTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    return { ...cleanTheme(t), background: typeof t.background === "string" && t.background.startsWith("data:image/") ? t.background : "" };
  } catch {
    return null;
  }
}

export const getTheme = (): Theme => localTheme() ?? { ...DEFAULT_THEME, background: "" };

/** 画面に当てる(読み込んだとき・変えたとき) */
export function applyTheme(t: Theme = getTheme()) {
  const root = document.documentElement;
  const p = PRESETS[t.preset];
  const mode = p.tone ?? t.mode;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  root.style.setProperty("--accent", t.accent === "auto" ? p.accent ?? ACCENTS.blue : ACCENTS[t.accent]);
  if (t.background) {
    // 文字が読めるよう、画像の上に薄いガラスを重ねる
    root.style.setProperty("--bg", `linear-gradient(var(--bg-veil), var(--bg-veil)), url("${t.background}") center / cover no-repeat`);
  } else if (p.bg) {
    root.style.setProperty("--bg", p.bg);
  } else {
    root.style.removeProperty("--bg");
  }
  root.style.setProperty("--bg-dim", String(t.dim / 100));
  root.style.setProperty("--bg-blur", `${t.blur}px`);
}

/** このブラウザに保存して当てる。背景画像が大きすぎて保存できないときは例外 */
export function saveTheme(t: Theme) {
  localStorage.setItem(KEY, JSON.stringify(t));
  applyTheme(t);
}

/** 画像のファイルを、背景に使える大きさの data URL にする */
export async function backgroundFrom(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}
