// サーバーの種類ごとの、Mod・プラグインの置き場所と、Modrinth で絞り込む条件(画面とサーバーで共有)
export const PLATFORMS = {
  paper: { label: "Paper", dir: "plugins", type: "plugin", loaders: ["paper", "spigot", "bukkit"] },
  purpur: { label: "Purpur", dir: "plugins", type: "plugin", loaders: ["purpur", "paper", "spigot", "bukkit"] },
  spigot: { label: "Spigot", dir: "plugins", type: "plugin", loaders: ["spigot", "bukkit"] },
  folia: { label: "Folia", dir: "plugins", type: "plugin", loaders: ["folia"] },
  velocity: { label: "Velocity", dir: "plugins", type: "plugin", loaders: ["velocity"] },
  bungeecord: { label: "BungeeCord / Waterfall", dir: "plugins", type: "plugin", loaders: ["bungeecord", "waterfall"] },
  fabric: { label: "Fabric", dir: "mods", type: "mod", loaders: ["fabric"] },
  quilt: { label: "Quilt", dir: "mods", type: "mod", loaders: ["quilt", "fabric"] },
  forge: { label: "Forge", dir: "mods", type: "mod", loaders: ["forge"] },
  neoforge: { label: "NeoForge", dir: "mods", type: "mod", loaders: ["neoforge"] },
} as const;

export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_IDS = Object.keys(PLATFORMS) as Platform[];
export const isPlatform = (v: unknown): v is Platform => typeof v === "string" && v in PLATFORMS;

// ライブラリのアイテムの種類(03.58.00 から、v02 と同じくデータパック・リソースパック・シェーダー・Modパックも)
export const ITEM_TYPES = { plugin: "プラグイン", mod: "Mod", datapack: "データパック", resourcepack: "リソースパック", shader: "シェーダー", modpack: "Modパック" } as const;
export type ItemType = keyof typeof ITEM_TYPES;
export const ITEM_TYPE_IDS = Object.keys(ITEM_TYPES) as ItemType[];
export const isItemType = (v: unknown): v is ItemType => typeof v === "string" && v in ITEM_TYPES;
/** サーバーに入れられる種類: サーバーの種類のもの(プラグイン・Mod)と、ワールドのあるサーバー(プロキシ以外)ならデータパック(<level-name>/datapacks/) */
export const kindsOf = (platform: unknown): ItemType[] =>
  isPlatform(platform) ? [PLATFORMS[platform].type, ...(platform === "velocity" || platform === "bungeecord" ? [] : ["datapack" as const])] : [];

// 例 1.21.1・1.20・1.8.9、年ごとの新しい番号の 26.3・26.3.1
export const MC_VERSION = /^(1\.\d{1,2}|\d{2}\.\d{1,2})(\.\d{1,2})?$/;

// 動く作りの名前(Modrinth の loaders)。アイテムの情報を直すときに選べるもの
export const LOADERS: string[] = [...new Set(Object.values(PLATFORMS).flatMap((p) => [...p.loaders]))];

/** MC のバージョンを比べる(1.20.4 < 1.21 < 26.3) */
export function mcCompare(a: string, b: string) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
/** 対応 MC の一覧がそのバージョンを含むか(1.20 は 1.20.x をすべて含む) */
export const mcCovers = (list: readonly string[], v: string) => list.some((e) => v === e || v.startsWith(e + "."));
/** 対応 MC の一覧から、リリースの番号だけを古い順に(スナップショットなどは除く) */
export const mcClean = (list: unknown) =>
  Array.isArray(list) ? [...new Set(list.map(String).filter((v) => MC_VERSION.test(v)))].sort(mcCompare).slice(-200) : [];
export type Support = "ok" | "no" | "unknown";
/**
 * サーバーの Minecraft バージョン mc に、その版(対応 MC の一覧 list)が対応するか。
 * mc が決まっていない・一覧が空なら unknown。loose は「試した版」のような粗い一覧(1.20 が 1.20.x を含む)で、
 * 一覧にあればその版、全部より古いサーバーだけ no(新しい jar は古いサーバーで読み込めない)、あとは unknown
 */
export function supportOf(mc: string | null | undefined, list: readonly string[], loose = false): Support {
  const l = mcClean(list);
  if (!mc || !MC_VERSION.test(mc) || !l.length) return "unknown";
  if (loose ? mcCovers(l, mc) : l.includes(mc)) return "ok";
  return !loose || mcCompare(mc, l[0]) < 0 ? "no" : "unknown";
}

/** 対応 MC の範囲の表示("1.20.1〜1.21.4") */
export function mcRange(list: readonly string[]) {
  const l = mcClean(list);
  return l.length === 0 ? "" : l.length === 1 ? l[0] : `${l[0]}〜${l[l.length - 1]}`;
}

/** サーバーの種類とバージョン(例 Paper 1.21.4。決めていなければ空) */
export const kindLabel = (platform: string | null | undefined, mc: string | null | undefined) =>
  platform ? `${PLATFORMS[platform as Platform]?.label ?? platform}${mc ? ` ${mc}` : ""}` : "";

/** サーバーの状態(serverStatus の state)の表示 */
export const STATE_LABELS: Record<string, string> = { running: "稼働中", starting: "起動中", stopping: "止めています", offline: "停止中" };
