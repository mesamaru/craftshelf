import { isOrigin, ORIGIN_LABEL } from "./origin";
import type { ItemType } from "./platforms";
// 配布元(画面とサーバーで共有)。Modrinth・SpigotMC は、ファイルをこのアプリを通さず Pterodactyl に直接取り込ませる。
// upload は利用者がアップロードしたもの(自分用の版だけ。保存先に置いて、サーバーに送る)
export const SOURCES = ["modrinth", "spigot", "curseforge"] as const; // 探せる配布元(CurseForge は API キーを設定したチームだけ)
export type Source = (typeof SOURCES)[number];
export type ItemSource = Source | "upload";
export const isSource = (v: unknown): v is Source => v === "modrinth" || v === "spigot" || v === "curseforge";
export const isItemSource = (v: unknown): v is ItemSource => isSource(v) || v === "upload";
export const SOURCE_LABEL: Record<ItemSource, string> = { modrinth: "Modrinth", spigot: "SpigotMC", curseforge: "CurseForge", upload: "アップロード" };

/** 配布元の名前(画面に出すとき。知らないものはそのまま)。アップロードしたもの(upload)は、origin(ファイルの出どころ。src/lib/origin.ts)があれば、それで言い分ける */
export const sourceLabel = (s: string, origin = "") => (s === "upload" && isOrigin(origin) ? ORIGIN_LABEL[origin] : isItemSource(s) ? SOURCE_LABEL[s] : s);

/** 配布元のページ(アップロードしたものには無い) */
export const pageUrl = (source: string, projectId: string, slug = "") =>
  source === "upload" ? "" : source === "spigot" ? `https://www.spigotmc.org/resources/${projectId}/`
    : source === "curseforge" ? (slug ? `https://www.curseforge.com/minecraft/${slug}` : "") : `https://modrinth.com/project/${slug || projectId}`;

// 受け取る版(03.56.00 から): release = 正式版だけ(正式版が無いときだけベータを使う)/ all = ベータ・アルファも
export const CHANNELS = { release: "正式版だけ", all: "ベータ版・アルファ版も" } as const;
export type Channel = keyof typeof CHANNELS;
export const isChannel = (v: unknown): v is Channel => v === "release" || v === "all";

// ページの分類(Modrinth・CurseForge の URL の 1 つ目の区切り)→ 種類
const URL_KINDS: Record<string, ItemType | undefined> = {
  plugin: "plugin", "bukkit-plugins": "plugin", mod: "mod", "mc-mods": "mod", datapack: "datapack", "data-packs": "datapack",
  resourcepack: "resourcepack", "texture-packs": "resourcepack", shader: "shader", shaders: "shader", modpack: "modpack", modpacks: "modpack",
};

/**
 * 配布元のページの URL を読む(Modrinth は ID か slug、SpigotMC は番号、CurseForge と Hangar は slug)。
 * type はページの分類から分かったときだけ。読めなければ null
 */
export function parseSourceUrl(input: string): { source: Source | "hangar"; ref: string; type?: ItemType } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const kind = (k: string | undefined) => URL_KINDS[k ?? ""];
  const safe = (s: string | undefined) => (s && /^[A-Za-z0-9._-]{1,80}$/.test(s) ? s : null);
  if (host === "modrinth.com" && safe(parts[1])) return { source: "modrinth", ref: parts[1], type: kind(parts[0]) };
  if (host === "spigotmc.org" && parts[0] === "resources") {
    const m = parts[1]?.match(/(?:^|\.)(\d{1,9})$/);
    return m ? { source: "spigot", ref: m[1], type: "plugin" } : null;
  }
  if (host === "curseforge.com" && parts[0] === "minecraft" && safe(parts[2])) return { source: "curseforge", ref: parts[2], type: kind(parts[1]) };
  if (host === "hangar.papermc.io" && safe(parts[1])) return { source: "hangar", ref: parts[1], type: "plugin" };
  return null;
}
