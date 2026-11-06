// 見た目の設定(ブラウザごと): ライト・ダーク・自動、アクセントの色、背景画像(v02 のテーマと背景画像)
export type Mode = "auto" | "light" | "dark";
export const ACCENTS = { blue: "#0a84ff", green: "#30d158", purple: "#bf5af2", orange: "#ff9f0a", pink: "#ff375f" } as const;
export type Accent = keyof typeof ACCENTS;
export const ACCENT_LABELS: Record<Accent, string> = { blue: "青", green: "緑", purple: "紫", orange: "オレンジ", pink: "ピンク" };
const KEY = "craftshelf.theme";
// 背景画像は、長い辺を 1920 px までに縮めた JPEG(localStorage に入る大きさにする)
const MAX_SIDE = 1920;

export type Theme = { mode: Mode; accent: Accent; background: string };
const DEFAULT: Theme = { mode: "auto", accent: "blue", background: "" };

export function getTheme(): Theme {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      mode: ["auto", "light", "dark"].includes(t.mode) ? t.mode : "auto",
      accent: t.accent in ACCENTS ? t.accent : "blue",
      background: typeof t.background === "string" && t.background.startsWith("data:image/") ? t.background : "",
    };
  } catch {
    return DEFAULT;
  }
}

/** 画面に当てる(読み込んだとき・変えたとき) */
export function applyTheme(t: Theme = getTheme()) {
  const root = document.documentElement;
  if (t.mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t.mode);
  root.style.setProperty("--accent", ACCENTS[t.accent]);
  if (t.background) {
    // 文字が読めるよう、画像の上に薄いガラスを重ねる
    root.style.setProperty("--bg", `linear-gradient(var(--bg-veil), var(--bg-veil)), url("${t.background}") center / cover no-repeat`);
  } else {
    root.style.removeProperty("--bg");
  }
}

/** 保存して当てる。背景画像が大きすぎて保存できないときは例外 */
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
