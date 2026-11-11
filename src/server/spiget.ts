// SpigotMC(Spiget の API https://spiget.org/documentation/)からプラグインを探し、入れるファイルを決める。
// ファイルはこのアプリを通さず、Pterodactyl が Spiget の CDN(api.spiget.org → cdn.spiget.org)から直接取り込む。
// SpigotMC の外のサイトで配っているもの(external)・有料のもの(premium)は、取り込めないので扱わない
import { type Platform, mcClean } from "~/lib/platforms";
import { type FileChoice, type Hit, type ItemVersion, SAFE_JAR } from "./modrinth";
import { htmlToText } from "./html-text";
import type { FetchLike } from "./net";

const API = "https://api.spiget.org/v2";
const UA = "mesamaru/craftshelf (https://github.com/mesamaru/craftshelf)";
const FIELDS = "id,name,tag,downloads,external,premium,category,version,testedVersions";

export class SpigetError extends Error {}
export const SPIGET_ID = /^\d{1,9}$/;
// アイコンは Spiget の画像(利用者のブラウザが直接読む。無いものは画面が種類の図に戻す)
const iconOf = (id: number | string) => `${API}/resources/${id}/icon`;

// SpigotMC のカテゴリー: プロキシ用(BungeeCord)・どちらでも動く(Universal)・プラグインではないもの。ほかはサーバー用(Bukkit / Spigot)
const PROXY = new Set([3, 9, 10, 11, 12, 13]);
const UNIVERSAL = 21;
const NOT_PLUGIN = new Set([19, 20, 27, 29]); // Standalone・Premium・Web・DataPack
const BUKKIT: Platform[] = ["paper", "purpur", "spigot"];

/** そのカテゴリーのプラグインが、その種類のサーバーで動くか(Folia・Velocity は SpigotMC では見分けられないので入れない) */
export function spigetFits(category: number, platform: Platform) {
  if (NOT_PLUGIN.has(category)) return false;
  if (category === UNIVERSAL) return BUKKIT.includes(platform) || platform === "bungeecord";
  if (PROXY.has(category)) return platform === "bungeecord";
  return BUKKIT.includes(platform);
}

type Resource = { id: number; name: string; tag: string; downloads: number; external: boolean; premium: boolean; category?: { id: number }; version?: { id: number }; testedVersions?: string[]; updateDate?: number };

// 置くファイルの名前: プラグインの名前と版から、安全な文字だけで作る
const jarName = (id: number, name: string, version: string) => {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._+-]+/g, "").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60);
  const n = clean(name) ? `${clean(name)}-${clean(version) || id}.jar` : `spigot-${id}.jar`;
  return SAFE_JAR.test(n) ? n : `spigot-${id}.jar`;
};

export function spigetClient(fetch: FetchLike) {
  async function get(path: string) {
    let res: Response;
    try {
      res = await fetch(API + path, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new SpigetError("SpigotMC(Spiget)に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new SpigetError("SpigotMC(Spiget)へのリクエストが多すぎます。しばらく待ってからお試しください");
    if (!res.ok) throw new SpigetError(`SpigotMC(Spiget)からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }
  const resource = async (id: string): Promise<Resource | null> => (SPIGET_ID.test(id) ? get(`/resources/${id}?fields=${FIELDS}`) : null);
  const installable = (r: Resource) => !r.external && !r.premium && !NOT_PLUGIN.has(r.category?.id ?? 0);
  const hit = (r: Resource): Hit => ({ projectId: String(r.id), slug: "", title: String(r.name ?? ""), summary: String(r.tag ?? ""), downloads: Number(r.downloads ?? 0), iconUrl: iconOf(r.id), author: "" });

  async function find(query: string, keep: (r: Resource) => boolean): Promise<Hit[]> {
    const q = new URLSearchParams({ size: "50", fields: FIELDS, sort: "-downloads" });
    const list: Resource[] = (await get(query.trim() ? `/search/resources/${encodeURIComponent(query.trim().slice(0, 100))}?${q}` : `/resources?${q}`)) ?? [];
    return (Array.isArray(list) ? list : []).filter((r) => Number.isInteger(r.id) && installable(r) && keep(r)).slice(0, 20).map(hit);
  }

  return {
    /** このサーバーの種類で動くものを探す(Minecraft のバージョンは SpigotMC では確かめられないので絞らない) */
    search: (query: string, platform: Platform) => find(query, (r) => spigetFits(r.category?.id ?? 0, platform)),

    /** プラグインを探す(ライブラリに足すとき) */
    searchAll: (query: string) => find(query, () => true),

    /** いちばん新しい版のファイル(このサーバーの種類で動かない・取り込めないものは null) */
    async latestFile(projectId: string, platform: Platform): Promise<FileChoice | null> {
      const r = await resource(projectId);
      if (!r || !installable(r) || !spigetFits(r.category?.id ?? 0, platform)) return null;
      const v = await get(`/resources/${r.id}/versions/latest`);
      const versionId = String(v?.id ?? r.version?.id ?? "");
      if (!versionId) return null;
      const versionNumber = String(v?.name ?? versionId);
      // 取り込ませる URL は、こちらで組み立てる Spiget のものだけ(Spiget の CDN へ転送される)
      return { projectId: String(r.id), versionId, versionNumber, filename: jarName(r.id, r.name, versionNumber), url: `${API}/resources/${r.id}/download`, sha512: "", size: 0 };
    },

    // mcVersions は作者が「試した」と書いたバージョン(1.20 のように、細かい番号の無いことが多い)
    async project(projectId: string) {
      const r = await resource(projectId);
      return r ? { title: String(r.name ?? ""), slug: "", projectType: installable(r) ? "plugin" : "", iconUrl: iconOf(r.id), mcVersions: mcClean(r.testedVersions),
        updated: r.updateDate ? new Date(Number(r.updateDate) * 1000).toISOString() : "" } : null;
    },

    /** 更新のお知らせ(新しい順・15 件まで)。SpigotMC は版ごとの変更内容が無いので、これを版の一覧の代わりにする */
    async updates(projectId: string): Promise<ItemVersion[]> {
      if (!SPIGET_ID.test(projectId)) return [];
      const list = await get(`/resources/${projectId}/updates?size=15&sort=-date`);
      return (Array.isArray(list) ? list : []).map((u: Record<string, unknown>) => {
        let html = "";
        try {
          html = Buffer.from(String(u.description ?? ""), "base64").toString("utf8");
        } catch { /* 読めなければ空 */ }
        const date = Number(u.date);
        return { versionId: String(u.id ?? ""), versionNumber: String(u.title ?? "").slice(0, 120), date: date ? new Date(date * 1000).toISOString() : "", type: "release",
          mcVersions: [], loaders: [], changelog: htmlToText(html, 20_000) };
      });
    },
  };
}
