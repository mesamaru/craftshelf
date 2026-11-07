// サーバー本体(jar)の版の確認と入れ替え(v02 の「サーバー本体」)。jar はこのアプリを通さず、サーバーに配布元から直接取り込ませる。
// 入れ替える前の jar は名前を変えて 1 つだけ残し、そこへ戻せる。入れ替えたあとは、サーバーを再起動すると新しい jar で動く
import { eq } from "drizzle-orm";
import { MC_VERSION, PLATFORMS, type Platform, isPlatform } from "~/lib/platforms";
import { serverProfile, serverSoftware } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import type { FetchLike } from "./net";
import { type Deps, remote, serverOf } from "./servers";

const UA = "mesamaru/craftshelf (https://github.com/mesamaru/craftshelf)";
const FILL = "https://fill.papermc.io/v3/projects";
const FILL_PROJECT: Partial<Record<Platform, string>> = { paper: "paper", folia: "folia", velocity: "velocity" };
// 入れ替えに使ってよい取得先(配布元の公式のもの)
export const BUILD_HOSTS = ["fill-data.papermc.io", "api.purpurmc.org", "meta.fabricmc.net"];
// 配布ページ(手で取得するとき・確かめるとき)
export const SOFTWARE_PAGES: Record<Platform, string> = {
  paper: "https://papermc.io/downloads/paper", folia: "https://papermc.io/downloads/folia", velocity: "https://papermc.io/downloads/velocity",
  purpur: "https://purpurmc.org/downloads", spigot: "https://www.spigotmc.org/wiki/buildtools/", bungeecord: "https://ci.md-5.net/job/BungeeCord/",
  fabric: "https://fabricmc.net/use/server/", quilt: "https://quiltmc.org/en/install/server/", forge: "https://files.minecraftforge.net/", neoforge: "https://neoforged.net/",
};
const BACKUP_SUFFIX = ".craftshelf-old";

// auto: jar を取ってきて入れ替えられる(false は新しい版があるかの確認だけ。インストーラーが要るもの)
export type Build = { build: string; mc: string; url: string; file: string; auto: boolean };

/** "git-Paper-232 (MC: 1.21.4)"・"1.21.4-232-abcdef (MC: 1.21.4)"・"paper-1.21.4-232.jar" → { mc, build } */
export function parseBuild(text: string) {
  const t = String(text ?? "");
  let mc = t.match(/\(MC: ([\d.]+)\)/)?.[1] ?? "";
  let build = "";
  const git = t.match(/git-[A-Za-z]+-(\d+)/);
  const m = git ? null : t.match(/^([\d.]+)-(\d+)(?:-|\s|$)/) ?? t.match(/^[a-z]+-([\d.]+(?:-SNAPSHOT)?)-(\d+)\.jar$/i);
  if (git) build = git[1];
  else if (m) {
    mc ||= m[1];
    build = m[2];
  }
  const fabric = t.match(/^fabric-server-mc\.([\d.]+)-loader\.([\d.]+)/);
  if (fabric) return { mc: fabric[1], build: fabric[2] };
  return { mc, build };
}

const newer = (a: string, b: string) => {
  const x = a.match(/\d+/g)?.map(Number) ?? [], y = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

export function softwareClient(fetch: FetchLike) {
  async function get(url: string) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new HttpError(502, "配布元に接続できません。しばらくしてからお試しください");
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(502, `配布元からエラーが返りました(HTTP ${res.status})`);
    return res.json();
  }
  return {
    /** そのサーバーの種類で選べる Minecraft のバージョン(正式版だけ・新しい順)。プロキシ・わからないものは空 */
    async mcVersions(platform: Platform): Promise<string[]> {
      let list: string[] = [];
      if (platform === "paper" || platform === "folia") {
        list = (Object.values((await get(`${FILL}/${platform}`))?.versions ?? {}) as string[][]).flat();
      } else if (platform === "purpur") {
        list = ((await get("https://api.purpurmc.org/v2/purpur"))?.versions ?? []) as string[];
      } else if (platform === "fabric") {
        list = (((await get("https://meta.fabricmc.net/v2/versions/game")) ?? []) as { version: string; stable: boolean }[]).filter((v) => v.stable).map((v) => v.version);
      }
      return [...new Set(list.filter((v) => MC_VERSION.test(v)))].sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
    },

    /** そのサーバーの種類・バージョンのいちばん新しいビルド(わからなければ null) */
    async latest(platform: Platform, mc: string): Promise<Build | null> {
      const project = FILL_PROJECT[platform];
      if (project) {
        let v = mc;
        if (!v && platform === "velocity") {
          // Velocity はプロキシの版。わからなければ、いちばん新しい正式版
          const p = await get(`${FILL}/velocity`);
          v = (Object.values(p?.versions ?? {}) as string[][]).flat().find((x) => !x.includes("SNAPSHOT")) ?? "";
        }
        if (!v) return null;
        const d = await get(`${FILL}/${project}/versions/${encodeURIComponent(v)}/builds/latest`);
        const dl = d?.downloads?.["server:default"];
        return d ? { build: String(d.id ?? ""), mc: v, url: String(dl?.url ?? ""), file: String(dl?.name ?? ""), auto: !!dl?.url } : null;
      }
      if (platform === "purpur" && mc) {
        const d = await get(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(mc)}`);
        const b = String(d?.builds?.latest ?? "");
        return b ? { build: b, mc, url: `https://api.purpurmc.org/v2/purpur/${mc}/${b}/download`, file: `purpur-${mc}-${b}.jar`, auto: true } : null;
      }
      if (platform === "fabric" && mc) {
        const loaders = ((await get("https://meta.fabricmc.net/v2/versions/loader?limit=20")) ?? []) as { version: string; stable: boolean }[];
        const installers = ((await get("https://meta.fabricmc.net/v2/versions/installer")) ?? []) as { version: string; stable: boolean }[];
        const lv = (loaders.find((x) => x.stable) ?? loaders[0])?.version;
        const iv = (installers.find((x) => x.stable) ?? installers[0])?.version;
        if (!lv || !iv) return null;
        return { build: lv, mc, url: `https://meta.fabricmc.net/v2/versions/loader/${mc}/${lv}/${iv}/server/jar`, file: `fabric-server-mc.${mc}-loader.${lv}-launcher.${iv}.jar`, auto: true };
      }
      if (platform === "forge" && mc) {
        const p = (await get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"))?.promos ?? {};
        const v = p[`${mc}-recommended`] ?? p[`${mc}-latest`];
        return v ? { build: String(v), mc, url: "", file: "", auto: false } : null;
      }
      return null;
    },
  };
}

export function softwareService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const client = softwareClient(deps.fetch);

  // サーバー本体の jar: 記録したもの → 種類の名前が付いたもの → server.jar など → 1 つだけの jar
  function pickJar(jars: string[], platform: Platform, recorded?: string) {
    if (recorded && jars.includes(recorded)) return recorded;
    const named = jars.filter((n) => n.toLowerCase().startsWith(platform) || (platform === "bungeecord" && /waterfall|bungee/i.test(n)));
    if (named.length === 1) return named[0];
    for (const n of ["server.jar", `${platform}.jar`, "fabric-server-launch.jar"]) if (jars.includes(n)) return n;
    return jars.length === 1 ? jars[0] : "";
  }

  async function look(who: Parameters<typeof serverOf>[1], serverId: string) {
    const target = await serverOf(deps, who, serverId);
    const [p] = await db.select().from(serverProfile).where(eq(serverProfile.serverId, target.row.id));
    if (!p || !isPlatform(p.platform)) throw new HttpError(400, "先にサーバーの種類を選んでください");
    const platform = p.platform;
    const [rec] = await db.select().from(serverSoftware).where(eq(serverSoftware.serverId, target.row.id));
    const root = await remote(() => target.client.listFiles(target.remoteId, "/"));
    const jars = root.filter((f) => f.isFile && f.name.toLowerCase().endsWith(".jar")).map((f) => f.name);
    const jar = pickJar(jars, platform, rec?.jar);
    // 今のビルド: 入れ替えた記録(jar の大きさが同じなら) → version_history.json(Paper 系) → jar の名前
    let now = { mc: "", build: "" };
    const size = root.find((f) => f.name === jar)?.size;
    if (rec && rec.jar === jar && rec.size === size) now = { mc: rec.mc, build: rec.build };
    else {
      const vh = await remote(() => target.client.readFile(target.remoteId, "version_history.json")).catch(() => null);
      if (vh) {
        try {
          now = parseBuild(String(JSON.parse(vh).currentVersion ?? ""));
        } catch { /* 読めなければ jar の名前から */ }
      }
      if (!now.build) now = jars.map(parseBuild).find((x) => x.build) ?? now;
    }
    const mc = now.mc || p.mcVersion || "";
    const backup = rec?.backupJar && root.some((f) => f.name === rec.backupJar) ? { jar: rec.backupJar, build: rec.backupBuild } : null;
    return { target, platform, jar, jars, now: { mc, build: now.build }, backup, rec };
  }

  return {
    /** サーバー本体の今のビルドと、いちばん新しいビルド */
    async info(headers: Headers, serverId: string) {
      const who = await requireTeam(auth, headers);
      const l = await look(who, serverId);
      const latest = await client.latest(l.platform, l.now.mc);
      const mcNewer = l.now.mc ? (await client.mcVersions(l.platform)).filter((v) => newer(v, l.now.mc)).slice(0, 10) : [];
      return {
        platform: l.platform, label: PLATFORMS[l.platform].label, page: SOFTWARE_PAGES[l.platform], mcNewer,
        jar: l.jar, mc: l.now.mc, build: l.now.build, latest,
        update: !!(latest && latest.build && latest.build !== l.now.build && (!l.now.build || newer(latest.build, l.now.build))),
        backup: l.backup,
      };
    },

    /**
     * いちばん新しいビルドに入れ替える(管理者以上)。今の jar は名前を変えて残し(前に残したものは消す)、
     * 新しい jar を同じ名前で取り込ませる。取り込めなければ元に戻す。restart なら最後に再起動する
     */
    async update(headers: Headers, serverId: string, restart = false, mc?: string) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const l = await look(who, serverId);
      const { client: c, remoteId, row } = l.target;
      if (!l.jar) throw new HttpError(400, "サーバー本体の jar が分かりません(サーバーのフォルダに jar が 1 つだけになるようにしてください)");
      if (mc && !(await client.mcVersions(l.platform)).includes(mc)) throw new HttpError(400, "この Minecraft のバージョンには上げられません");
      const latest = await client.latest(l.platform, mc || l.now.mc);
      if (!latest) throw new HttpError(404, "新しいビルドが見つかりません(Minecraft のバージョンを設定してください)");
      if (!latest.auto || !latest.url) throw new HttpError(400, `${PLATFORMS[l.platform].label} は自動で入れ替えられません(配布ページで確かめてください)`);
      if (!BUILD_HOSTS.includes(new URL(latest.url).host)) throw new HttpError(400, "配布元の外の URL なので、取り込みませんでした");
      const backupJar = l.jar + BACKUP_SUFFIX;
      await remote(async () => {
        if (l.backup || l.jars.includes(backupJar)) await c.deleteFiles(remoteId, "/", [l.backup?.jar ?? backupJar]);
        await c.rename(remoteId, "/", l.jar, backupJar);
        try {
          await c.pull(remoteId, latest.url, "/", l.jar);
        } catch (e) {
          await c.rename(remoteId, "/", backupJar, l.jar).catch(() => {}); // 元に戻す
          throw e;
        }
      });
      const size = (await remote(() => c.listFiles(remoteId, "/"))).find((f) => f.name === l.jar)?.size ?? 0;
      const values = { serverId: row.id, jar: l.jar, build: latest.build, mc: latest.mc, size, backupJar, backupBuild: l.now.build, updatedAt: new Date() };
      await db.insert(serverSoftware).values(values).onConflictDoUpdate({ target: serverSoftware.serverId, set: values });
      if (mc && mc !== l.now.mc) await db.update(serverProfile).set({ mcVersion: mc, updatedAt: new Date() }).where(eq(serverProfile.serverId, row.id));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "changes", action: mc && mc !== l.now.mc ? "Minecraft のバージョンを上げる" : "サーバー本体を更新", target: row.name,
        detail: `${l.now.mc && mc && mc !== l.now.mc ? `${l.now.mc} → ${mc}・` : ""}${l.now.build || "?"} → ${latest.build}` });
      if (restart) await remote(() => c.power(remoteId, "restart"));
      return { build: latest.build, restarted: restart };
    },

    /** 入れ替える前の jar に戻す(管理者以上)。今の jar は、戻したものの代わりに残す(もう一度押すと元に戻る) */
    async rollback(headers: Headers, serverId: string) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const l = await look(who, serverId);
      const { client: c, remoteId, row } = l.target;
      if (!l.backup || !l.rec) throw new HttpError(404, "入れ替える前の jar がありません");
      const tmp = l.jar + ".craftshelf-tmp";
      await remote(async () => {
        await c.rename(remoteId, "/", l.jar, tmp);
        await c.rename(remoteId, "/", l.backup!.jar, l.jar);
        await c.rename(remoteId, "/", tmp, l.backup!.jar);
      });
      const size = (await remote(() => c.listFiles(remoteId, "/"))).find((f) => f.name === l.jar)?.size ?? 0;
      await db.update(serverSoftware).set({ build: l.backup.build, size, backupBuild: l.now.build, updatedAt: new Date() }).where(eq(serverSoftware.serverId, row.id));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "changes", action: "サーバー本体を戻す", target: row.name, detail: `${l.now.build || "?"} → ${l.backup.build || "?"}` });
      return { build: l.backup.build };
    },
  };
}
