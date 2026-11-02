// 配布元(画面とサーバーで共有)。どちらも、ファイルはこのアプリを通さず、Pterodactyl に直接取り込ませる
export const SOURCES = ["modrinth", "spigot"] as const;
export type Source = (typeof SOURCES)[number];
export const isSource = (v: unknown): v is Source => v === "modrinth" || v === "spigot";
export const SOURCE_LABEL: Record<Source, string> = { modrinth: "Modrinth", spigot: "SpigotMC" };

/** 配布元のページ */
export const pageUrl = (source: string, projectId: string, slug = "") =>
  source === "spigot" ? `https://www.spigotmc.org/resources/${projectId}/` : `https://modrinth.com/project/${slug || projectId}`;
