// CurseForge(https://docs.curseforge.com/)からプラグイン・Mod を探し、入れるファイルを決める(自分用の版だけ。API キーは利用者のもの)。
// ファイルはこのアプリを通さず、サーバーが CurseForge の CDN(forgecdn.net)から直接取り込む。
// 作者が外部からのダウンロードを許していないもの(downloadUrl が無い)は、取り込めないので扱わない
import { type ItemType, MC_VERSION, PLATFORMS, type Platform, mcClean } from "~/lib/platforms";
import { type FileChoice, type Hit, type ItemVersion, type PickOpts, SAFE_FILE, type UpRow, releaseType } from "./modrinth";
import { htmlToText } from "./html-text";
import type { FetchLike } from "./net";

const API = "https://api.curseforge.com/v1";
const GAME = 432; // Minecraft
// 種類 → CurseForge の分類(classId)と、ページの URL の分類
const CLASS: Record<ItemType, number> = { mod: 6, plugin: 5, resourcepack: 12, modpack: 4471, shader: 6552, datapack: 6945 };
const PATH: Record<ItemType, string> = { mod: "mc-mods", plugin: "bukkit-plugins", resourcepack: "texture-packs", modpack: "modpacks", shader: "shaders", datapack: "data-packs" };
// サーバーの種類 → CurseForge の modLoaderType(プラグインは分けない)
const LOADER_TYPE: Partial<Record<string, number>> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const RELEASE_TYPE = ["", "release", "beta", "alpha"];
export const CF_ID = /^\d{1,9}$/;
export const CF_HOSTS = ["edge.forgecdn.net", "mediafilez.forgecdn.net"];
export const CF_KEY = /^\S{20,120}$/;

export class CurseForgeError extends Error {}

type Mod = { id: number; name: string; slug: string; summary: string; downloadCount: number; classId: number; logo?: { thumbnailUrl?: string } | null; allowModDistribution?: boolean | null;
  latestFilesIndexes?: { gameVersion?: string }[]; dateModified?: string };
type File = { id: number; displayName: string; fileName: string; downloadUrl: string | null; fileDate: string; releaseType: number; gameVersions: string[]; fileLength: number;
  dependencies?: { modId: number; relationType: number }[] };
const REQUIRED = 3; // relationType: 3 = 必須の前提
const depsOf = (f: File, self: string) => [...new Set((f.dependencies ?? []).filter((d) => d.relationType === REQUIRED && Number.isInteger(d.modId)).map((d) => String(d.modId)))].filter((d) => d !== self);

const icon = (m: Mod) => {
  const u = m.logo?.thumbnailUrl ?? "";
  return /^https:\/\/media\.forgecdn\.net\//.test(u) ? u : "";
};
const kind = (classId: number) => (Object.keys(CLASS) as ItemType[]).find((k) => CLASS[k] === classId) ?? "";
// 画面のリンク(curseforge.com/minecraft/<分類>/<slug>)に使う
const pathOf = (m: Mod) => `${PATH[kind(m.classId) || "mod"]}/${m.slug}`;

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
  // loaders は管理者が直した動く作り(Mod のときだけ、そのうちの CurseForge にあるもので絞る)
  // type はサーバーの種類と違うものを入れるとき(データパック。作りでは絞らない)
  async function rawFiles(projectId: string, platform: Platform, mcVersion: string | null, loaders?: readonly string[], type?: ItemType): Promise<File[]> {
    if (!CF_ID.test(projectId)) return [];
    const mod = (await get(`/mods/${projectId}`))?.data as Mod | undefined;
    if (!mod || kind(mod.classId) !== (type ?? PLATFORMS[platform].type) || mod.allowModDistribution === false) return [];
    const q = new URLSearchParams({ pageSize: "50" });
    const loaderType = type ? undefined : loaders ? loaders.map((l) => LOADER_TYPE[l]).find(Boolean) : LOADER_TYPE[platform];
    if (loaderType) q.set("modLoaderType", String(loaderType));
    if (mcVersion) q.set("gameVersion", mcVersion);
    return (((await get(`/mods/${projectId}/files?${q}`))?.data ?? []) as File[]).filter(okFile);
  }
  // 取り込めるファイル(CurseForge の CDN にあり、名前が安全なもの)
  const okFile = (f: File) => !!f.downloadUrl && CF_HOSTS.includes(new URL(f.downloadUrl).host) && SAFE_FILE.test(f.fileName);
  const choiceOf = (projectId: string, f: File): FileChoice => ({
    projectId, versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), filename: f.fileName, url: f.downloadUrl!, sha512: "", size: f.fileLength, deps: depsOf(f, projectId),
  });
  const hit = (m: Mod): Hit => ({ projectId: String(m.id), slug: pathOf(m), title: m.name, summary: m.summary ?? "", downloads: Number(m.downloadCount ?? 0), iconUrl: icon(m), author: "" });

  async function find(query: string, type: ItemType, platform?: Platform, mcVersion?: string | null): Promise<Hit[]> {
    const q = new URLSearchParams({ gameId: String(GAME), classId: String(CLASS[type]), pageSize: "20", sortField: query.trim() ? "1" : "2", sortOrder: "desc" });
    if (query.trim()) q.set("searchFilter", query.trim().slice(0, 100));
    if (type === "mod" && platform && LOADER_TYPE[platform]) q.set("modLoaderType", String(LOADER_TYPE[platform]));
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
    search: (query: string, platform: Platform, mcVersion: string | null, type?: "datapack") => find(query, type ?? PLATFORMS[platform].type, platform, mcVersion),

    /** 種類だけで探す(ライブラリに足すとき) */
    searchType: (query: string, type: ItemType) => find(query, type),

    /**
     * このサーバーの種類の、取り込めるファイル(Minecraft のバージョンでは絞らない。対応は mcVersions で見る)。
     * CurseForge の一覧は 1 ページ(新しい 50 個)までなので、mcVersion があれば、そのバージョンのファイルも別に問い合わせて足す(古いサーバーの版が 51 個目より後でも見つかるように)
     */
    async rows(projectId: string, platform: Platform, mcVersion: string | null, opts: PickOpts = {}): Promise<UpRow[]> {
      const all = await rawFiles(projectId, platform, null, opts.loaders, opts.type);
      const mine = mcVersion ? (await rawFiles(projectId, platform, mcVersion, opts.loaders, opts.type)).filter((f) => !all.some((x) => x.id === f.id)) : [];
      return [...all, ...mine].map((f) => ({
        ...choiceOf(projectId, f), date: f.fileDate, type: releaseType(RELEASE_TYPE[f.releaseType]),
        mcVersions: mcClean(f.gameVersions), loaders: f.gameVersions.map((g) => g.toLowerCase()),
      }));
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
      if (!f || !okFile(f)) return null;
      return { projectId, versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), filename: f.fileName, url: f.downloadUrl!, sha512: "", size: f.fileLength };
    },

    /** プロジェクトの名前などを、まとめて取る(ID → 中身) */
    async projects(ids: string[]): Promise<Map<string, { title: string; slug: string; iconUrl: string; mcVersions: string[]; updated: string }>> {
      const out = new Map<string, { title: string; slug: string; iconUrl: string; mcVersions: string[]; updated: string }>();
      const modIds = ids.filter((x) => CF_ID.test(x)).map(Number);
      for (let i = 0; i < modIds.length; i += 100) {
        for (const m of ((await get("/mods", { modIds: modIds.slice(i, i + 100) }))?.data ?? []) as Mod[]) {
          out.set(String(m.id), { title: m.name, slug: pathOf(m), iconUrl: icon(m), mcVersions: mcClean((m.latestFilesIndexes ?? []).map((x) => x.gameVersion)), updated: m.dateModified ?? "" });
        }
      }
      return out;
    },

    /** すべてのファイル(サーバーを決めずに、新しい順・30 個まで。アイテムの版と変更内容を見るとき) */
    async allFiles(projectId: string): Promise<ItemVersion[]> {
      if (!CF_ID.test(projectId)) return [];
      const files = (((await get(`/mods/${projectId}/files?pageSize=30`))?.data ?? []) as File[]);
      return files.sort((a, b) => Date.parse(b.fileDate) - Date.parse(a.fileDate)).slice(0, 30).map((f) => ({
        versionId: String(f.id), versionNumber: f.displayName.replace(/\.jar$/i, "").slice(0, 60), date: f.fileDate, type: RELEASE_TYPE[f.releaseType] ?? "",
        mcVersions: mcClean(f.gameVersions), loaders: f.gameVersions.filter((g) => !MC_VERSION.test(g)).map((g) => g.toLowerCase()),
        url: okFile(f) ? f.downloadUrl! : "", filename: okFile(f) ? f.fileName : "",
      }));
    },

    /** ファイルの変更内容(HTML を文字にしたもの) */
    async changelog(projectId: string, fileId: string): Promise<string | null> {
      if (!CF_ID.test(projectId) || !CF_ID.test(fileId)) return null;
      const d = await get(`/mods/${projectId}/files/${fileId}/changelog`);
      return d ? htmlToText(String(d.data ?? ""), 20_000) : null;
    },

    /** ページの slug からプロジェクトの ID を探す(URL から足すとき) */
    async bySlug(slug: string, type?: ItemType): Promise<string | null> {
      const q = new URLSearchParams({ gameId: String(GAME), slug });
      if (type) q.set("classId", String(CLASS[type]));
      const m = (((await get(`/mods/search?${q}`))?.data ?? []) as Mod[]).find((x) => x.slug === slug && Number.isInteger(x.id));
      return m ? String(m.id) : null;
    },

    async project(projectId: string) {
      if (!CF_ID.test(projectId)) return null;
      const m = (await get(`/mods/${projectId}`))?.data as Mod | undefined;
      return m ? { title: m.name, slug: pathOf(m), projectType: m.allowModDistribution === false ? "" : kind(m.classId), iconUrl: icon(m) } : null;
    },
  };
}
