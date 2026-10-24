// Modrinth(https://docs.modrinth.com/api/)から Mod・プラグインを探し、入れるファイルを決める。
// ファイルそのものはこのアプリを通さず、Pterodactyl に直接取り込ませる
import { PLATFORMS, type Platform } from "~/lib/platforms";
import type { FetchLike } from "./net";

const API = "https://api.modrinth.com/v2";
const UA = "mesamaru/craftshelf (https://github.com/mesamaru/craftshelf)";

export class ModrinthError extends Error {}

export type Hit = { projectId: string; slug: string; title: string; summary: string; downloads: number; iconUrl: string; author: string };
export type FileChoice = { projectId: string; versionId: string; versionNumber: string; filename: string; url: string; sha512: string; size: number };

const PROJECT_ID = /^[A-Za-z0-9]{8}$/;
// 置くファイルの名前として安全なもの(フォルダーをまたがない .jar)
export const SAFE_JAR = /^[A-Za-z0-9][A-Za-z0-9._+\- ]{0,120}\.jar$/;

export function modrinthClient(fetch: FetchLike) {
  async function get(path: string) {
    let res: Response;
    try {
      res = await fetch(API + path, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ModrinthError("Modrinth に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new ModrinthError("Modrinth へのリクエストが多すぎます。しばらく待ってからお試しください");
    if (!res.ok) throw new ModrinthError(`Modrinth からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }

  return {
    async search(query: string, platform: Platform, mcVersion: string | null): Promise<Hit[]> {
      const p = PLATFORMS[platform];
      const facets: string[][] = [[`project_type:${p.type}`], p.loaders.map((l) => `categories:${l}`), ["server_side!=unsupported"]];
      if (mcVersion) facets.push([`versions:${mcVersion}`]);
      const q = new URLSearchParams({ query: query.slice(0, 100), limit: "20", index: query.trim() ? "relevance" : "downloads", facets: JSON.stringify(facets) });
      const d = await get(`/search?${q}`);
      return (d?.hits ?? []).filter((h: { project_id?: string }) => PROJECT_ID.test(h.project_id ?? "")).map((h: Record<string, unknown>) => ({
        projectId: String(h.project_id), slug: String(h.slug ?? ""), title: String(h.title ?? ""), summary: String(h.description ?? ""),
        downloads: Number(h.downloads ?? 0), iconUrl: typeof h.icon_url === "string" && h.icon_url.startsWith("https://cdn.modrinth.com/") ? h.icon_url : "",
        author: String(h.author ?? ""),
      }));
    },

    // サーバーの種類とバージョンに合う、いちばん新しい安定版のファイル(無ければ null)
    async latestFile(projectId: string, platform: Platform, mcVersion: string | null): Promise<FileChoice | null> {
      if (!PROJECT_ID.test(projectId)) throw new ModrinthError("プロジェクトの ID が正しくありません");
      const q = new URLSearchParams({ loaders: JSON.stringify(PLATFORMS[platform].loaders), include_changelog: "false" });
      if (mcVersion) q.set("game_versions", JSON.stringify([mcVersion]));
      const versions: Record<string, unknown>[] = (await get(`/project/${projectId}/version?${q}`)) ?? [];
      const sorted = [...versions].sort((a, b) => String(b.date_published).localeCompare(String(a.date_published)));
      const v = sorted.find((x) => x.version_type === "release") ?? sorted[0];
      if (!v) return null;
      const files = (v.files as Record<string, unknown>[]) ?? [];
      const f = files.find((x) => x.primary) ?? files[0];
      const url = String(f?.url ?? "");
      const filename = String(f?.filename ?? "");
      if (!url.startsWith("https://cdn.modrinth.com/") || !SAFE_JAR.test(filename)) return null;
      return {
        projectId, versionId: String(v.id), versionNumber: String(v.version_number ?? ""), filename, url,
        sha512: String((f.hashes as Record<string, string>)?.sha512 ?? ""), size: Number(f.size ?? 0),
      };
    },

    async project(projectId: string) {
      if (!PROJECT_ID.test(projectId)) return null;
      const p = await get(`/project/${projectId}`);
      return p ? { title: String(p.title ?? ""), slug: String(p.slug ?? ""), projectType: String(p.project_type ?? "") } : null;
    },
  };
}
