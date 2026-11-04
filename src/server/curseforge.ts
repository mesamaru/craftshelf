// CurseForge(https://docs.curseforge.com/)からプラグイン・Mod を探し、入れるファイルを決める(自分用の版だけ。API キーは利用者のもの)。
// ファイルはこのアプリを通さず、サーバーが CurseForge の CDN(forgecdn.net)から直接取り込む。
// 作者が外部からのダウンロードを許していないもの(downloadUrl が無い)は、取り込めないので扱わない
import { PLATFORMS, type Platform } from "~/lib/platforms";
import { type FileChoice, type Hit, SAFE_JAR, pickVersion } from "./modrinth";
import type { FetchLike } from "./net";

const API = "https://api.curseforge.com/v1";
const GAME = 432; // Minecraft
const CLASS = { mod: 6, plugin: 5 } as const;
// サーバーの種類 → CurseForge の modLoaderType(プラグインは分けない)
const LOADER_TYPE: Partial<Record<Platform, number>> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
export const CF_ID = /^\d{1,9}$/;
export const CF_HOSTS = ["edge.forgecdn.net", "mediafilez.forgecdn.net"];
export const CF_KEY = /^\S{20,120}$/;

export class CurseForgeError extends Error {}

type Mod = { id: number; name: string; slug: string; summary: string; downloadCount: number; classId: number; logo?: { thumbnailUrl?: string } | null; allowModDistribution?: boolean | null };
type File = { id: number; displayName: string; fileName: string; downloadUrl: string | null; fileDate: string; releaseType: number; gameVersions: string[]; fileLength: number;
  dependencies?: { modId: number; relationType: number }[] };
const REQUIRED = 3; // relationType: 3 = 必須の前提
const depsOf = (f: File, self: string) => [...new Set((f.dependencies ?? []).filter((d) => d.relationType === REQUIRED && Number.isInteger(d.modId)).map((d) => String(d.modId)))].filter((d) => d !== self);

const icon = (m: Mod) => {
  const u = m.logo?.thumbnailUrl ?? "";
  return /^https:\/\/media\.forgecdn\.net\//.test(u) ? u : "";
};
const kind = (classId: number) => (classId === CLASS.mod ? "mod" : classId === CLASS.plugin ? "plugin" : "");
// 画面のリンク(curseforge.com/minecraft/<分類>/<slug>)に使う
const pathOf = (m: Mod) => `${m.classId === CLASS.plugin ? "bukkit-plugins" : "mc-mods"}/${m.slug}`;

export function curseforgeClient(fetch: FetchLike, apiKey: string) {
  async function get(path: string) {
    let res: Response;
    try {
      res = await fetch(API + path, { headers: { "x-api-key": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new CurseForgeError("CurseForge に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new CurseForgeError("CurseForge の API キーが使えません(キーを確かめてください)");
    if (res.status === 429) throw new CurseForgeError("CurseForge へのリクエストが多すぎます。しばらく待ってからお試しください");
    if (!res.ok) throw new CurseForgeError(`CurseForge からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }
  const hit = (m: Mod): Hit => ({ projectId: String(m.id), slug: pathOf(m), title: m.name, summary: m.summary ?? "", downloads: Number(m.downloadCount ?? 0), iconUrl: icon(m), author: "" });

  async function find(query: string, type: "plugin" | "mod", platform?: Platform, mcVersion?: string | null): Promise<Hit[]> {
    const q = new URLSearchParams({ gameId: String(GAME), classId: String(CLASS[type]), pageSize: "20", sortField: query.trim() ? "1" : "2", sortOrder: "desc" });
    if (query.trim()) q.set("searchFilter", query.trim().slice(0, 100));
    if (platform && LOADER_TYPE[platform]) q.set("modLoaderType", String(LOADER_TYPE[platform]));
    if (mcVersion) q.set("gameVersion", mcVersion);
    const d = await get(`/mods/search?${q}`);
    return ((d?.data ?? []) as Mod[]).filter((m) => Number.isInteger(m.id) && m.allowModDistribution !== false).map(hit);
  }

  return {
    /** キーが使えるか(設定するときに確かめる) */
    async check() {
      await get(`/games/${GAME}`);
    },

    /** このサーバーの種類とバージョンに合うものを探す */
    search: (query: string, platform: Platform, mcVersion: string | null) => find(query, PLATFORMS[platform].type, platform, mcVersion),

    /** 種類だけで探す(ライブラリに足すとき) */
    searchType: (query: string, type: "plugin" | "mod") => find(query, type),

    /** このサーバーの種類・バージョンに合う、いちばん新しい安定版のファイル(取り込めないものは null) */
    async latestFile(projectId: string, platform: Platform, mcVersion: string | null): Promise<FileChoice | null> {
      if (!CF_ID.test(projectId)) return null;
      const mod = (await get(`/mods/${projectId}`))?.data as Mod | undefined;
      if (!mod || kind(mod.classId) !== PLATFORMS[platform].type || mod.allowModDistribution === false) return null;
      const q = new URLSearchParams({ pageSize: "50" });
      if (LOADER_TYPE[platform]) q.set("modLoaderType", String(LOADER_TYPE[platform]));
      if (mcVersion) q.set("gameVersion", mcVersion);
      const files = (((await get(`/mods/${projectId}/files?${q}`))?.data ?? []) as File[])
        .filter((f) => f.downloadUrl && CF_HOSTS.includes(new URL(f.downloadUrl).host) && SAFE_JAR.test(f.fileName));
      const releases = files.filter((f) => f.releaseType === 1);
      // 作り(loaders)は CurseForge では gameVersions に入る(Fabric・Forge など)。プラグインは種類で絞れないので日付だけで選ぶ
      const pool = (releases.length ? releases : files).map((f) => ({ ...f, date_published: f.fileDate, loaders: f.gameVersions.map((g) => g.toLowerCase()) }));
      const f = pickVersion(pool, PLATFORMS[platform].type === "mod" ? PLATFORMS[platform].loaders : []);
      if (!f) return null;
      return { projectId, versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), filename: f.fileName, url: f.downloadUrl!, sha512: "", size: f.fileLength, deps: depsOf(f, projectId) };
    },

    /** 決まったファイル(前の版に戻すとき) */
    async file(projectId: string, fileId: string): Promise<FileChoice | null> {
      if (!CF_ID.test(projectId) || !CF_ID.test(fileId)) return null;
      const f = (await get(`/mods/${projectId}/files/${fileId}`))?.data as File | undefined;
      if (!f?.downloadUrl || !CF_HOSTS.includes(new URL(f.downloadUrl).host) || !SAFE_JAR.test(f.fileName)) return null;
      return { projectId, versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), filename: f.fileName, url: f.downloadUrl, sha512: "", size: f.fileLength };
    },

    async project(projectId: string) {
      if (!CF_ID.test(projectId)) return null;
      const m = (await get(`/mods/${projectId}`))?.data as Mod | undefined;
      return m ? { title: m.name, slug: pathOf(m), projectType: m.allowModDistribution === false ? "" : kind(m.classId), iconUrl: icon(m) } : null;
    },
  };
}
