// Hangar(PaperMC のプラグインの配布元。API https://hangar.papermc.io/api-docs)からプラグインを探し、入れるファイルを決める。
// ファイルはこのアプリを通さず、Pterodactyl が Hangar の CDN(hangarcdn.papermc.io)から直接取り込む。
// Hangar の外のサイトで配っている版(externalUrl だけのもの)は、取り込めないので扱わない
import { type Platform, mcClean } from "~/lib/platforms";
import { type FileChoice, type Hit, type ItemVersion, SAFE_JAR, type ReleaseType, type UpRow } from "./modrinth";
import type { FetchLike } from "./net";

const API = "https://hangar.papermc.io/api/v1";
const UA = "mesamaru/craftshelf (https://github.com/mesamaru/craftshelf)";
const CDN = "https://hangarcdn.papermc.io/";
export const HANGAR_HOSTS = ["hangarcdn.papermc.io"];
export const HANGAR_ID = /^\d{1,9}$/;
const SLUG = /^[A-Za-z0-9._-]{1,80}$/;
const PAGE = 25; // Hangar の一覧は 1 回に 25 個まで

export class HangarError extends Error {}

// Hangar の作り(platform)→ 入れられるサーバーの種類。Paper 向けは Paper と、Paper から派生した Purpur。
// Spigot(Paper の API が無い)・Folia(対応の印が Hangar に無い)には入れない
type HPlatform = "PAPER" | "VELOCITY" | "WATERFALL";
const PLATFORM_OF: Partial<Record<Platform, HPlatform>> = { paper: "PAPER", purpur: "PAPER", velocity: "VELOCITY", bungeecord: "WATERFALL" };
export const hangarPlatform = (p: Platform): HPlatform | null => PLATFORM_OF[p] ?? null;
const ALL: HPlatform[] = ["PAPER", "VELOCITY", "WATERFALL"];

type Download = { fileInfo?: { name?: string; sizeBytes?: number } | null; externalUrl?: string | null; downloadUrl?: string | null };
type Version = {
  id: number; projectId: number; name: string; createdAt: string; description?: string; channel?: { name?: string; flags?: string[] };
  downloads?: Partial<Record<string, Download>>; pluginDependencies?: Partial<Record<string, { projectId?: number | null; required?: boolean }[]>>;
  platformDependencies?: Partial<Record<string, string[]>>;
};
type Project = { id: number; name: string; namespace?: { owner?: string; slug?: string }; description?: string; stats?: { downloads?: number }; avatarUrl?: string; lastUpdated?: string;
  supportedPlatforms?: Partial<Record<string, string[]>> };

const icon = (v: unknown) => (typeof v === "string" && v.startsWith(CDN) ? v : "");
// ページの場所(hangar.papermc.io/<作者>/<slug>)
const pathOf = (p: Project) => (p.namespace?.owner && p.namespace.slug ? `${p.namespace.owner}/${p.namespace.slug}` : "");
// チャンネルは作者が名前を付けるので、名前で分ける(Release・Stable = 正式版、Alpha = アルファ、ほか Snapshot・Beta など = ベータ)
const typeOf = (c: Version["channel"]): ReleaseType =>
  /alpha/i.test(c?.name ?? "") ? "alpha" : /^(release|stable)$/i.test(c?.name ?? "") && !c?.flags?.includes("UNSTABLE") ? "release" : "beta";
// 置くファイルの名前: 版ごとに同じ名前(SkinsRestorer.jar など)のものは、版を足して分ける(同じ名前だと、更新で前の版を残せない)
const jarName = (name: string, version: string) => {
  const v = version.replace(/[^A-Za-z0-9._+-]+/g, "").slice(0, 60);
  if (!v || name.includes(v)) return name;
  const n = `${name.replace(/\.jar$/i, "")}-${v}.jar`;
  return SAFE_JAR.test(n) ? n : name;
};

// その作り(hp)の版のファイル(Hangar の CDN にあり、名前が安全なものだけ)。deps = 必須の前提のうち Hangar にあるもの
function fileOf(v: Version, hp: HPlatform): FileChoice | null {
  const d = v.downloads?.[hp];
  const url = String(d?.downloadUrl ?? "");
  const name = String(d?.fileInfo?.name ?? "");
  if (!url.startsWith(CDN) || !SAFE_JAR.test(name)) return null;
  const projectId = String(v.projectId);
  const deps = (v.pluginDependencies?.[hp] ?? []).filter((x) => x.required && Number.isInteger(x.projectId)).map((x) => String(x.projectId));
  return { projectId, versionId: String(v.id), versionNumber: String(v.name ?? "").slice(0, 60), filename: jarName(name, String(v.name ?? "")), url, sha512: "",
    size: Number(d?.fileInfo?.sizeBytes ?? 0), deps: [...new Set(deps)].filter((x) => x !== projectId) };
}
// 対応する Minecraft(Paper 向けのものだけ。プロキシの platformDependencies はプロキシの版なので使わない)
const mcOf = (v: Version, hp: HPlatform) => (hp === "PAPER" ? mcClean(v.platformDependencies?.PAPER) : []);

export function hangarClient(fetch: FetchLike) {
  async function get(path: string) {
    let res: Response;
    try {
      res = await fetch(API + path, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new HangarError("Hangar に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new HangarError("Hangar へのリクエストが多すぎます。しばらく待ってからお試しください");
    if (!res.ok) throw new HangarError(`Hangar からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }
  const versions = async (projectId: string, q: Record<string, string>): Promise<Version[]> =>
    ((await get(`/projects/${projectId}/versions?${new URLSearchParams({ limit: String(PAGE), ...q })}`))?.result ?? []) as Version[];
  const hit = (p: Project): Hit => ({ projectId: String(p.id), slug: pathOf(p), title: String(p.name ?? ""), summary: String(p.description ?? ""),
    downloads: Number(p.stats?.downloads ?? 0), iconUrl: icon(p.avatarUrl), author: String(p.namespace?.owner ?? "") });

  async function find(query: string, q: Record<string, string>): Promise<Hit[]> {
    const params = new URLSearchParams({ limit: String(PAGE), ...q, ...(query.trim() ? { query: query.trim().slice(0, 100) } : { sort: "-downloads" }) });
    return (((await get(`/projects?${params}`))?.result ?? []) as Project[]).filter((p) => Number.isInteger(p.id)).map(hit);
  }

  return {
    /** このサーバーの種類で動くものを探す(Paper 向けは mcVersion でも絞る) */
    async search(query: string, platform: Platform, mcVersion: string | null): Promise<Hit[]> {
      const hp = hangarPlatform(platform);
      if (!hp) return [];
      return find(query, { platform: hp, ...(mcVersion && hp === "PAPER" ? { version: mcVersion } : {}) });
    },

    /** プラグインを探す(ライブラリに足すとき) */
    searchAll: (query: string) => find(query, {}),

    /**
     * このサーバーの種類の、取り込める版(Minecraft のバージョンでは絞らない。対応は mcVersions で見る)。
     * 一覧は 25 個ずつなので、新しい版に正式版が無ければ Release の版を、(Paper 向けは)このバージョンに合う正式版が無ければこのバージョンの版を、続けて問い合わせて合わせる
     * (スナップショットばかり出すもの・古い Minecraft のサーバーでも合う版が見つかるように。足りているときは 1 回だけ)
     */
    async rows(projectId: string, platform: Platform, mcVersion: string | null): Promise<UpRow[]> {
      const hp = hangarPlatform(platform);
      if (!hp || !HANGAR_ID.test(projectId)) return [];
      const list = await versions(projectId, { platform: hp });
      const release = (v: Version) => typeOf(v.channel) === "release";
      if (!list.some(release)) list.push(...await versions(projectId, { platform: hp, channel: "Release" }));
      if (mcVersion && hp === "PAPER" && !list.some((v) => release(v) && mcOf(v, hp).includes(mcVersion))) list.push(...await versions(projectId, { platform: hp, platformVersion: mcVersion }));
      const seen = new Set<number>();
      return list.filter((v) => !seen.has(v.id) && !!seen.add(v.id)).flatMap((v) => {
        const f = fileOf(v, hp);
        return f ? [{ ...f, date: String(v.createdAt ?? ""), type: typeOf(v.channel), mcVersions: mcOf(v, hp), loaders: [hp.toLowerCase()] }] : [];
      });
    },

    /** 決まった版のファイル(前の版に戻す・版を固定するとき)。platform を決めなければ、ファイルのある最初の作り */
    async version(projectId: string, versionId: string, platform?: Platform): Promise<FileChoice | null> {
      if (!HANGAR_ID.test(projectId) || !HANGAR_ID.test(versionId)) return null;
      const v = (await get(`/versions/${versionId}`)) as Version | null;
      if (!v || String(v.projectId) !== projectId) return null;
      const hp = platform ? hangarPlatform(platform) : ALL.find((x) => fileOf(v, x));
      return hp ? fileOf(v, hp) : null;
    },

    /** プロジェクト(数字の ID か slug で。id は数字の ID)。mcVersions は Paper 向けの対応 MC */
    async project(projectId: string) {
      if (!SLUG.test(projectId)) return null;
      const p = (await get(`/projects/${projectId}`)) as Project | null;
      return p && Number.isInteger(p.id) ? { id: String(p.id), title: String(p.name ?? ""), slug: pathOf(p), projectType: "plugin", iconUrl: icon(p.avatarUrl),
        mcVersions: mcClean(p.supportedPlatforms?.PAPER), updated: String(p.lastUpdated ?? "") } : null;
    },

    /** すべての版(サーバーを決めずに、新しい順・25 個まで。アイテムの版と変更内容を見るとき)。ファイルは Paper 向けを先に選ぶ */
    async allVersions(projectId: string): Promise<ItemVersion[]> {
      if (!HANGAR_ID.test(projectId)) return [];
      return (await versions(projectId, {})).map((v) => {
        const hp = ALL.find((x) => fileOf(v, x));
        const f = hp ? fileOf(v, hp) : null;
        return { versionId: String(v.id), versionNumber: String(v.name ?? "").slice(0, 60), date: String(v.createdAt ?? ""), type: typeOf(v.channel),
          mcVersions: mcClean(v.platformDependencies?.PAPER), loaders: ALL.filter((x) => v.downloads?.[x]).map((x) => x.toLowerCase()),
          changelog: String(v.description ?? "").slice(0, 20_000), url: f?.url ?? "", filename: f?.filename ?? "" };
      });
    },
  };
}
