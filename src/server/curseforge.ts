// CurseForge(https://docs.curseforge.com/)からプラグイン・Mod を探し、入れるファイルを決める(自分用の版だけ。API キーは利用者のもの)。
// ファイルはこのアプリを通さず、サーバーが CurseForge の CDN(forgecdn.net)から直接取り込む。
// 作者が外部からのダウンロードを許していないもの(downloadUrl が無い)は、取り込めないので扱わない
import { PLATFORMS, type Platform } from "~/lib/platforms";
import { type FileChoice, type Hit, SAFE_JAR, type VersionChoice, pickVersion } from "./modrinth";
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
  async function get(path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetch(API + path, {
        method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        headers: { "x-api-key": apiKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CurseForgeError("CurseForge に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new CurseForgeError("CurseForge の API キーが使えません(キーを確かめてください)");
    if (res.status === 429) throw new CurseForgeError("CurseForge へのリクエストが多すぎます。しばらく待ってからお試しください");
    if (!res.ok) throw new CurseForgeError(`CurseForge からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }
  // このサーバーの種類・バージョンに合い、取り込めるファイル(作者が外部からのダウンロードを許していなければ空)
  async function rawFiles(projectId: string, platform: Platform, mcVersion: string | null): Promise<File[]> {
    if (!CF_ID.test(projectId)) return [];
    const mod = (await get(`/mods/${projectId}`))?.data as Mod | undefined;
    if (!mod || kind(mod.classId) !== PLATFORMS[platform].type || mod.allowModDistribution === false) return [];
    const q = new URLSearchParams({ pageSize: "50" });
    if (LOADER_TYPE[platform]) q.set("modLoaderType", String(LOADER_TYPE[platform]));
    if (mcVersion) q.set("gameVersion", mcVersion);
    return (((await get(`/mods/${projectId}/files?${q}`))?.data ?? []) as File[])
      .filter((f) => f.downloadUrl && CF_HOSTS.includes(new URL(f.downloadUrl).host) && SAFE_JAR.test(f.fileName));
  }
  const choiceOf = (projectId: string, f: File): FileChoice => ({
    projectId, versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), filename: f.fileName, url: f.downloadUrl!, sha512: "", size: f.fileLength, deps: depsOf(f, projectId),
  });
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
      const files = await rawFiles(projectId, platform, mcVersion);
      const releases = files.filter((f) => f.releaseType === 1);
      // 作り(loaders)は CurseForge では gameVersions に入る(Fabric・Forge など)。プラグインは種類で絞れないので日付だけで選ぶ
      const pool = (releases.length ? releases : files).map((f) => ({ ...f, date_published: f.fileDate, loaders: f.gameVersions.map((g) => g.toLowerCase()) }));
      const f = pickVersion(pool, PLATFORMS[platform].type === "mod" ? PLATFORMS[platform].loaders : []);
      return f ? choiceOf(projectId, f) : null;
    },

    /** このサーバーの種類・バージョンに合うファイル(新しい順・30 個まで。版を選んで入れるとき) */
    async files(projectId: string, platform: Platform, mcVersion: string | null): Promise<VersionChoice[]> {
      const files = await rawFiles(projectId, platform, mcVersion);
      return files.sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate)).slice(0, 30)
        .map((f) => ({ ...choiceOf(projectId, f), date: f.fileDate, release: f.releaseType === 1 }));
    },

    /** ファイルのフィンガープリントから探す(見つかったものだけ。フィンガープリント → ファイル) */
    async byFingerprints(fps: number[]): Promise<Map<number, { projectId: string; versionId: string; versionNumber: string }>> {
      const out = new Map<number, { projectId: string; versionId: string; versionNumber: string }>();
      if (!fps.length) return out;
      const d = (await get("/fingerprints", { fingerprints: fps }))?.data;
      for (const m of (d?.exactMatches ?? []) as { file: File & { modId: number; fileFingerprint: number } }[]) {
        out.set(m.file.fileFingerprint, { projectId: String(m.file.modId), versionId: String(m.file.id), versionNumber: m.file.displayName.replace(/\.jar$/i, "").slice(0, 60) });
      }
      return out;
    },

    /** 決まったファイル(前の版に戻すとき) */
    async file(projectId: string, fileId: string): Promise<FileChoice | null> {
      if (!CF_ID.test(projectId) || !CF_ID.test(fileId)) return null;
      const f = (await get(`/mods/${projectId}/files/${fileId}`))?.data as File | undefined;
      if (!f?.downloadUrl || !CF_HOSTS.includes(new URL(f.downloadUrl).host) || !SAFE_JAR.test(f.fileName)) return null;
      return { projectId, versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), filename: f.fileName, url: f.downloadUrl, sha512: "", size: f.fileLength };
    },

    /** プロジェクトの名前などを、まとめて取る(ID → 中身) */
    async projects(ids: string[]): Promise<Map<string, { title: string; slug: string; iconUrl: string }>> {
      const out = new Map<string, { title: string; slug: string; iconUrl: string }>();
      const modIds = ids.filter((x) => CF_ID.test(x)).map(Number);
      for (let i = 0; i < modIds.length; i += 100) {
        for (const m of ((await get("/mods", { modIds: modIds.slice(i, i + 100) }))?.data ?? []) as Mod[]) {
          out.set(String(m.id), { title: m.name, slug: pathOf(m), iconUrl: icon(m) });
        }
      }
      return out;
    },

    async project(projectId: string) {
      if (!CF_ID.test(projectId)) return null;
      const m = (await get(`/mods/${projectId}`))?.data as Mod | undefined;
      return m ? { title: m.name, slug: pathOf(m), projectType: m.allowModDistribution === false ? "" : kind(m.classId), iconUrl: icon(m) } : null;
    },
  };
}
