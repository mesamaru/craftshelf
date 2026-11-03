// 配布元(画面とサーバーで共有)。Modrinth・SpigotMC は、ファイルをこのアプリを通さず Pterodactyl に直接取り込ませる。
// upload は利用者がアップロードしたもの(自分用の版だけ。保存先に置いて、サーバーに送る)
export const SOURCES = ["modrinth", "spigot", "curseforge"] as const; // 探せる配布元(CurseForge は API キーを設定したチームだけ)
export type Source = (typeof SOURCES)[number];
export type ItemSource = Source | "upload";
export const isSource = (v: unknown): v is Source => v === "modrinth" || v === "spigot" || v === "curseforge";
export const isItemSource = (v: unknown): v is ItemSource => isSource(v) || v === "upload";
export const SOURCE_LABEL: Record<ItemSource, string> = { modrinth: "Modrinth", spigot: "SpigotMC", curseforge: "CurseForge", upload: "アップロード" };

/** 配布元のページ(アップロードしたものには無い) */
export const pageUrl = (source: string, projectId: string, slug = "") =>
  source === "upload" ? "" : source === "spigot" ? `https://www.spigotmc.org/resources/${projectId}/`
    : source === "curseforge" ? (slug ? `https://www.curseforge.com/minecraft/${slug}` : "") : `https://modrinth.com/project/${slug || projectId}`;
