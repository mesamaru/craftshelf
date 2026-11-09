// Modrinth(https://docs.modrinth.com/api/)から Mod・プラグインを探し、入れるファイルを決める。
// ファイルそのものはこのアプリを通さず、Pterodactyl に直接取り込ませる
import { type ItemType, PLATFORMS, type Platform, isItemType, mcClean } from "~/lib/platforms";
import type { Channel } from "~/lib/sources";
import type { FetchLike } from "./net";

const API = "https://api.modrinth.com/v2";
const UA = "mesamaru/craftshelf (https://github.com/mesamaru/craftshelf)";

export class ModrinthError extends Error {}

export type Hit = { projectId: string; slug: string; title: string; summary: string; downloads: number; iconUrl: string; author: string };
// deps: 一緒に入れる必要がある前提(Modrinth の required)のプロジェクトの ID
export type FileChoice = { projectId: string; versionId: string; versionNumber: string; filename: string; url: string; sha512: string; size: number; deps?: string[] };

// Modrinth の版 → 入れるファイル(CDN の外・安全でない名前のものは null)
function fileOf(projectId: string, v: Record<string, unknown>): FileChoice | null {
  const files = (v.files as Record<string, unknown>[]) ?? [];
  const f = files.find((x) => x.primary) ?? files[0];
  const url = String(f?.url ?? "");
  const filename = String(f?.filename ?? "");
  if (!url.startsWith("https://cdn.modrinth.com/") || !SAFE_FILE.test(filename)) return null;
  const deps = ((v.dependencies as Record<string, unknown>[]) ?? [])
    .filter((d) => d.dependency_type === "required" && typeof d.project_id === "string" && PROJECT_ID.test(d.project_id))
    .map((d) => String(d.project_id));
  return {
    projectId, versionId: String(v.id), versionNumber: String(v.version_number ?? ""), filename, url,
    sha512: String((f.hashes as Record<string, string>)?.sha512 ?? ""), size: Number(f.size ?? 0), deps: [...new Set(deps)].filter((d) => d !== projectId),
  };
}

const PROJECT_ID = /^[A-Za-z0-9]{8}$/;
// URL から足すときの slug(ID もこの形に入る)
const SLUG = /^[A-Za-z0-9._-]{2,64}$/;
// 入れる版の選び方: loaders = 動く作り(管理者が直したもの。無ければサーバーの種類のもの)・channel = 受け取る版
// type = 入れる種類(サーバーの種類と違うとき。データパック)
export type PickOpts = { loaders?: readonly string[]; channel?: Channel; type?: ItemType };
// アイテムの版の一覧(サーバーを決めずに。変更内容を読むとき)の 1 行。url・filename はダウンロードできるファイル(配布元の CDN のもの。無ければ "")
export type ItemVersion = { versionId: string; versionNumber: string; date: string; type: string; mcVersions: string[]; loaders: string[]; changelog?: string; url?: string; filename?: string };
const icon = (v: unknown) => (typeof v === "string" && v.startsWith("https://cdn.modrinth.com/") ? v : "");
export type ProjectType = ItemType;
export const isProjectType = isItemType;
// 置くファイルの名前として安全なもの(フォルダーをまたがない .jar)。SAFE_FILE はデータパック・リソースパックなどの .zip と Modパックの .mrpack も
export const SAFE_JAR = /^[A-Za-z0-9][A-Za-z0-9._+\- ]{0,120}\.jar$/;
export const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+\- ]{0,120}\.(jar|zip|mrpack)$/i;
// サーバーで動くものだけを探す種類(リソースパック・シェーダーはクライアントで使う。Modパックはクライアント用のものも持てるように)
const SERVER_SIDE = new Set<string>(["plugin", "mod", "datapack"]);

// 版を選ぶときの一覧の 1 行
export type VersionChoice = FileChoice & { date: string; release: boolean };
const VERSIONS_SHOWN = 30;

export function modrinthClient(fetch: FetchLike) {
  async function get(path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetch(API + path, {
        method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        headers: { "User-Agent": UA, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ModrinthError("Modrinth に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new ModrinthError("Modrinth へのリクエストが多すぎます。しばらく待ってからお試しください");
    if (!res.ok) throw new ModrinthError(`Modrinth からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }

  async function rawVersions(projectId: string, platform: Platform, mcVersion: string | null, loaders?: readonly string[]): Promise<Record<string, unknown>[]> {
    if (!PROJECT_ID.test(projectId)) throw new ModrinthError("プロジェクトの ID が正しくありません");
    const q = new URLSearchParams({ loaders: JSON.stringify(loaders ?? PLATFORMS[platform].loaders), include_changelog: "false" });
    if (mcVersion) q.set("game_versions", JSON.stringify([mcVersion]));
    return (await get(`/project/${projectId}/version?${q}`)) ?? [];
  }

  async function find(query: string, facets: string[][]): Promise<Hit[]> {
      const q = new URLSearchParams({ query: query.slice(0, 100), limit: "20", index: query.trim() ? "relevance" : "downloads", facets: JSON.stringify(facets) });
      const d = await get(`/search?${q}`);
      return (d?.hits ?? []).filter((h: { project_id?: string }) => PROJECT_ID.test(h.project_id ?? "")).map((h: Record<string, unknown>) => ({
        projectId: String(h.project_id), slug: String(h.slug ?? ""), title: String(h.title ?? ""), summary: String(h.description ?? ""),
        downloads: Number(h.downloads ?? 0), iconUrl: icon(h.icon_url), author: String(h.author ?? ""),
      }));
  }

  return {
    /** サーバーの種類とバージョンに合うものを探す */
    async search(query: string, platform: Platform, mcVersion: string | null, type?: "datapack"): Promise<Hit[]> {
      const p = PLATFORMS[platform];
      const facets: string[][] = type ? [[`project_type:${type}`], ["server_side!=unsupported"]]
        : [[`project_type:${p.type}`], p.loaders.map((l) => `categories:${l}`), ["server_side!=unsupported"]];
      if (mcVersion) facets.push([`versions:${mcVersion}`]);
      return find(query, facets);
    },

    /** 種類だけで探す(ライブラリに足すとき) */
    async searchType(query: string, type: ProjectType): Promise<Hit[]> {
      return find(query, [[`project_type:${type}`], ...(SERVER_SIDE.has(type) ? [["server_side!=unsupported"]] : [])]);
    },

    // サーバーの種類とバージョンに合う、いちばん新しい安定版のファイル(無ければ null)。
    // 同じ時期に作りの違う版(Paper 向けと Bukkit 向けなど)が出ていれば、サーバーの種類向けのもの(loaders の前のほう)を選ぶ
    // channel が all なら、ベータ・アルファも含めていちばん新しいもの
    async latestFile(projectId: string, platform: Platform, mcVersion: string | null, opts: PickOpts = {}): Promise<FileChoice | null> {
      const versions = await rawVersions(projectId, platform, mcVersion, opts.loaders);
      const releases = opts.channel === "all" ? [] : versions.filter((x) => x.version_type === "release");
      const v = pickVersion(releases.length ? releases : versions, opts.loaders ?? PLATFORMS[platform].loaders);
      return v ? fileOf(projectId, v) : null;
    },

    /** サーバーの種類とバージョンに合う版(新しい順・${VERSIONS_SHOWN} 個まで。版を選んで入れるとき) */
    async versions(projectId: string, platform: Platform, mcVersion: string | null, opts: PickOpts = {}): Promise<VersionChoice[]> {
      const time = (v: Record<string, unknown>) => Date.parse(String(v.date_published)) || 0;
      return (await rawVersions(projectId, platform, mcVersion, opts.loaders)).sort((a, b) => time(b) - time(a)).flatMap((v) => {
        const f = fileOf(projectId, v);
        return f ? [{ ...f, date: String(v.date_published ?? ""), release: v.version_type === "release" }] : [];
      }).slice(0, VERSIONS_SHOWN);
    },

    /** プロジェクトの名前などを、まとめて取る(ID → 中身) */
    async projects(ids: string[]): Promise<Map<string, { title: string; slug: string; iconUrl: string; mcVersions: string[] }>> {
      const out = new Map<string, { title: string; slug: string; iconUrl: string; mcVersions: string[] }>();
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100).filter((x) => PROJECT_ID.test(x));
        if (!part.length) continue;
        for (const p of ((await get(`/projects?ids=${encodeURIComponent(JSON.stringify(part))}`)) ?? []) as Record<string, unknown>[]) {
          out.set(String(p.id), { title: String(p.title ?? ""), slug: String(p.slug ?? ""), iconUrl: icon(p.icon_url), mcVersions: mcClean(p.game_versions) });
        }
      }
      return out;
    },

    /** ファイルの SHA-1 から、Modrinth の版を探す(見つかったものだけ。SHA-1 → 版) */
    async byHashes(sha1s: string[]): Promise<Map<string, { projectId: string; versionId: string; versionNumber: string }>> {
      const out = new Map<string, { projectId: string; versionId: string; versionNumber: string }>();
      if (!sha1s.length) return out;
      const r = ((await get("/version_files", { hashes: sha1s, algorithm: "sha1" })) ?? {}) as Record<string, Record<string, unknown>>;
      for (const [h, v] of Object.entries(r)) {
        if (typeof v?.project_id === "string" && PROJECT_ID.test(v.project_id)) out.set(h, { projectId: v.project_id, versionId: String(v.id), versionNumber: String(v.version_number ?? "") });
      }
      return out;
    },

    /** 決まった版のファイル(前の版に戻すとき) */
    async version(projectId: string, versionId: string): Promise<FileChoice | null> {
      if (!/^[A-Za-z0-9]{8}$/.test(versionId)) return null;
      const v = await get(`/version/${versionId}`);
      return v && v.project_id === projectId ? fileOf(projectId, v) : null;
    },

    /** プロジェクト(ID か slug で。id は ID) */
    async project(projectId: string) {
      if (!SLUG.test(projectId)) return null;
      const p = await get(`/project/${projectId}`);
      return p && PROJECT_ID.test(String(p.id ?? projectId))
        ? { id: String(p.id ?? projectId), title: String(p.title ?? ""), slug: String(p.slug ?? ""), projectType: String(p.project_type ?? ""), iconUrl: icon(p.icon_url) } : null;
    },

    /** すべての版(サーバーを決めずに、新しい順・${VERSIONS_SHOWN} 個まで。アイテムの版と変更内容を見るとき) */
    async allVersions(projectId: string): Promise<ItemVersion[]> {
      if (!PROJECT_ID.test(projectId)) return [];
      const list = ((await get(`/project/${projectId}/version?include_changelog=false`)) ?? []) as Record<string, unknown>[];
      const time = (v: Record<string, unknown>) => Date.parse(String(v.date_published)) || 0;
      return list.sort((a, b) => time(b) - time(a)).slice(0, VERSIONS_SHOWN).map((v) => {
        const f = fileOf(projectId, v);
        return {
          versionId: String(v.id), versionNumber: String(v.version_number ?? ""), date: String(v.date_published ?? ""), type: String(v.version_type ?? ""),
          mcVersions: mcClean(v.game_versions), loaders: Array.isArray(v.loaders) ? v.loaders.map(String) : [], url: f?.url ?? "", filename: f?.filename ?? "",
        };
      });
    },

    /** 版の変更内容(Markdown の文。このプロジェクトの版でなければ null) */
    async changelog(projectId: string, versionId: string): Promise<string | null> {
      if (!PROJECT_ID.test(versionId)) return null;
      const v = await get(`/version/${versionId}`);
      return v && v.project_id === projectId ? String(v.changelog ?? "").slice(0, 20_000) : null;
    },
  };
}

// 同じ時期(いちばん新しい版から 3 日以内)に出た版の中で、サーバーの種類向けの作りを選ぶ。
// それより古い版には戻らない(作者が Paper 向けの印を付けなくなっただけ、ということがあるため)
const SAME_RELEASE_DAYS = 3;
export function pickVersion<T extends Record<string, unknown>>(versions: T[], loaders: readonly string[]): T | undefined {
  const time = (v: T) => Date.parse(String(v.date_published)) || 0;
  const sorted = [...versions].sort((a, b) => time(b) - time(a));
  if (!sorted.length) return undefined;
  const recent = sorted.filter((v) => time(v) >= time(sorted[0]) - SAME_RELEASE_DAYS * 86_400_000);
  const rank = (v: T) => {
    const ls = Array.isArray(v.loaders) ? (v.loaders as unknown[]).map(String) : [];
    const i = loaders.findIndex((l) => ls.includes(l));
    return i < 0 ? loaders.length : i;
  };
  return recent.reduce((best, v) => (rank(v) < rank(best) ? v : best));
}
