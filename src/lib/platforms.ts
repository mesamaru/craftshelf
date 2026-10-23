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

// 例 1.21.1・1.20・1.8.9
export const MC_VERSION = /^1\.\d{1,2}(\.\d{1,2})?$/;
