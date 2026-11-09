// サーバー本体(jar)の版の確認と入れ替え(v02 の「サーバー本体」)。jar はこのアプリを通さず、サーバーに配布元から直接取り込ませる。
// 入れ替える前の jar は名前を変えてサーバーのフォルダに 5 つまで残し、そこへ戻せる。入れ替えたあとは、サーバーを再起動すると新しい jar で動く
import { eq } from "drizzle-orm";
import { MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { BUILD_HOSTS, SOFTWARE, type Software, isProxy, isSoftware } from "~/lib/software";
import { serverProfile, serverSoftware } from "./db/schema";
import { eventService } from "./events";
import { jobService } from "./jobs";
import { HttpError, requireTeam } from "./guard";
import type { FetchLike } from "./net";
import type { PteroClient } from "./ptero";
import { type Deps, type Who, remote, serverOf } from "./servers";

export { BUILD_HOSTS };
const UA = "mesamaru/craftshelf (https://github.com/mesamaru/craftshelf)";
const FILL = "https://fill.papermc.io/v3/projects";
const LEAF = "https://api.leafmc.one/v2/projects/leaf";
const MOHIST = "https://api.mohistmc.com/project/mohist";
const SPONGE = "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla";
const MOJANG = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const JENKINS: Partial<Record<Software, (mc: string) => string>> = {
  bungeecord: () => "https://hub.spigotmc.org/jenkins/job/BungeeCord",
  pufferfish: (mc) => `https://ci.pufferfish.host/job/Pufferfish-${mc.match(/^\d+\.\d+/)?.[0] ?? ""}`,
};
export const KEEP_JARS = 5;
const OLD = ".craftshelf-old"; // 入れ替える前の jar の名前の後ろ(03.53.00 までは 1 つだけで、この名前のまま)
const LIMIT = 25;
const PROXY_VERSION = /^\d+\.\d+(\.\d+)?$/;

// auto: jar を取ってきて入れ替えられる(false は新しい版があるかの確認だけ)。stable: 配布元が安定版としているもの
export type Build = { build: string; mc: string; url: string; file: string; auto: boolean; stable: boolean };
type OldJar = { file: string; build: string; mc: string; at: string };

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

/** jar・egg の名前から、サーバー本体の種類(わからなければ null)。並びは、ほかの名前を含むものが先(pufferfish-paperclip など) */
export function softwareOfName(name: string | undefined | null): Software | null {
  const n = String(name ?? "").toLowerCase();
  for (const [key, sw] of [["velocity", "velocity"], ["waterfall", "waterfall"], ["bungee", "bungeecord"], ["purpur", "purpur"], ["folia", "folia"],
    ["leaf", "leaf"], ["pufferfish", "pufferfish"], ["mohist", "mohist"], ["arclight", "arclight"], ["paper", "paper"], ["spigot", "spigot"],
    ["craftbukkit", "spigot"], ["quilt", "quilt"], ["fabric", "fabric"], ["neoforge", "neoforge"], ["forge", "forge"], ["sponge", "sponge"],
    ["minecraft_server", "vanilla"], ["vanilla", "vanilla"]] as const) if (n.includes(key)) return sw;
  return null;
}

const newer = (a: string, b: string) => {
  const x = a.match(/\d+/g)?.map(Number) ?? [], y = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const byNewest = (list: string[]) => [...new Set(list)].sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
const enc = encodeURIComponent;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 配布元の JSON

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
  const fillVersions = async (project: string) => (Object.values((await get(`${FILL}/${project}`))?.versions ?? {}) as string[][]).flat();
  const proxyVersions = async (sw: Software) => (sw === "velocity" || sw === "waterfall" ? (await fillVersions(sw)).filter((v) => PROXY_VERSION.test(v)) : []);

  /** そのサーバー本体で選べる Minecraft のバージョン(プロキシはプロキシの版。正式版だけ・新しい順。わからないものは空) */
  async function mcVersions(sw: Software): Promise<string[]> {
    if (isProxy(sw)) return byNewest(await proxyVersions(sw));
    let list: string[] = [];
    if (sw === "paper" || sw === "folia") list = await fillVersions(sw);
    else if (sw === "purpur") list = (await get("https://api.purpurmc.org/v2/purpur"))?.versions ?? [];
    else if (sw === "leaf") list = (await get(LEAF))?.versions ?? [];
    else if (sw === "fabric") list = (((await get("https://meta.fabricmc.net/v2/versions/game")) ?? []) as J[]).filter((v) => v.stable).map((v) => v.version);
    else if (sw === "vanilla") list = (((await get(MOJANG))?.versions ?? []) as J[]).filter((v) => v.type === "release").map((v) => v.id);
    else if (sw === "mohist") list = (((await get(`${MOHIST}/versions`)) ?? []) as J[]).map((v) => v.name);
    else if (sw === "sponge") list = (await get(SPONGE))?.tags?.minecraft ?? [];
    return byNewest(list.map(String).filter((v) => MC_VERSION.test(v)));
  }

  /** そのサーバー本体・バージョンのビルド(新しい順に 25 個まで)。取ってこられないものは url が空 */
  async function builds(sw: Software, mc: string): Promise<Build[]> {
    const mk = (build: unknown, url: string, file: string, v = mc, stable = true): Build =>
      ({ build: String(build ?? ""), mc: v, url, file, auto: SOFTWARE[sw].auto && !!url, stable });
    if (sw === "paper" || sw === "folia" || sw === "velocity" || sw === "waterfall") {
      const proxies = await proxyVersions(sw);
      const v = isProxy(sw) ? (proxies.includes(mc) ? mc : proxies[0] ?? "") : mc;
      if (!v) return [];
      const list = ((await get(`${FILL}/${sw}/versions/${enc(v)}/builds`)) ?? []) as J[];
      return list.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, LIMIT).map((d) => {
        const dl = d.downloads?.["server:default"] ?? {};
        return mk(d.id, String(dl.url ?? ""), String(dl.name ?? ""), v, String(d.channel ?? "").toUpperCase() === "STABLE");
      });
    }
    const jenkins = JENKINS[sw];
    if (jenkins) {
      if (sw === "pufferfish" && !mc) return [];
      const job = jenkins(mc);
      const d = await get(`${job}/api/json?tree=builds%5Bnumber,result,artifacts%5BfileName,relativePath%5D%5D%7B0,${LIMIT}%7D`);
      const out: Build[] = [];
      for (const b of (d?.builds ?? []) as J[]) {
        if (b.result && b.result !== "SUCCESS") continue;
        const art = ((b.artifacts ?? []) as J[]).find((a) => (sw === "bungeecord" ? a.fileName === "BungeeCord.jar" : String(a.fileName).endsWith(".jar")));
        // Pufferfish は 1 つの作業で 1.21.x をまとめて作るので、jar の名前の版が違うものは出さない
        const v = sw === "pufferfish" ? String(art?.fileName ?? "").match(/-(\d+\.\d+(?:\.\d+)?)-R/)?.[1] ?? "" : "";
        if (sw === "pufferfish" && v !== mc) continue;
        out.push(mk(b.number, art ? `${job}/${Number(b.number)}/artifact/${String(art.relativePath).split("/").map(enc).join("/")}` : "", String(art?.fileName ?? ""), sw === "pufferfish" ? mc : ""));
      }
      return out;
    }
    if (sw === "quilt") {
      const v = (((await get("https://meta.quiltmc.org/v3/versions/loader")) ?? []) as J[]).find((x) => !String(x.version).includes("-"));
      return v ? [mk(v.version, "", "")] : [];
    }
    if (sw === "arclight") {
      const r = ((await get("https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=1")) ?? []) as J[];
      return r[0]?.tag_name ? [mk(r[0].tag_name, "", "")] : [];
    }
    if (!mc) return [];
    if (sw === "purpur") {
      const d = await get(`https://api.purpurmc.org/v2/purpur/${enc(mc)}`);
      return byNewest(((d?.builds?.all ?? []) as unknown[]).map(String)).slice(0, LIMIT)
        .map((b) => mk(b, `https://api.purpurmc.org/v2/purpur/${enc(mc)}/${enc(b)}/download`, `purpur-${mc}-${b}.jar`));
    }
    if (sw === "leaf") {
      const d = await get(`${LEAF}/versions/${enc(mc)}/builds`);
      return ((d?.builds ?? []) as J[]).reverse().slice(0, LIMIT).map((b) => {
        const name = String(b.downloads?.primary?.name ?? `leaf-${mc}-${b.build}.jar`);
        return mk(b.build, `${LEAF}/versions/${enc(mc)}/builds/${enc(String(b.build))}/downloads/${enc(name)}`, name, mc, b.channel !== "experimental");
      });
    }
    if (sw === "fabric") {
      const loaders = ((await get("https://meta.fabricmc.net/v2/versions/loader?limit=40")) ?? []) as J[];
      const installers = ((await get("https://meta.fabricmc.net/v2/versions/installer")) ?? []) as J[];
      const iv = (installers.find((x) => x.stable) ?? installers[0])?.version;
      if (!iv) return [];
      return loaders.slice(0, LIMIT).map((l) => mk(l.version, `https://meta.fabricmc.net/v2/versions/loader/${enc(mc)}/${enc(l.version)}/${enc(iv)}/server/jar`,
        `fabric-server-mc.${mc}-loader.${l.version}-launcher.${iv}.jar`, mc, !!l.stable));
    }
    if (sw === "vanilla") {
      const v = (((await get(MOJANG))?.versions ?? []) as J[]).find((x) => x.id === mc);
      if (!v || new URL(String(v.url)).host !== "piston-meta.mojang.com") return [];
      const server = (await get(String(v.url)))?.downloads?.server;
      return [mk(mc, String(server?.url ?? ""), `minecraft_server.${mc}.jar`)];
    }
    if (sw === "mohist") {
      const d = ((await get(`${MOHIST}/${enc(mc)}/builds`)) ?? []) as J[];
      return d.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, LIMIT).map((b) => mk(b.id, `${MOHIST}/${enc(mc)}/builds/${Number(b.id)}/download`, `mohist-${mc}-${b.id}-server.jar`));
    }
    if (sw === "sponge") {
      // 取得先は、選んだときに版ごとに確かめる(resolve)
      const d = await get(`${SPONGE}/versions?tags=minecraft:${enc(mc)}&offset=0&limit=10`);
      return Object.keys(d?.artifacts ?? {}).map((v) => ({ ...mk(v, "", `spongevanilla-${v}-universal.jar`), auto: true, stable: !/RC/i.test(v) }));
    }
    if (sw === "forge") {
      const p = (await get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"))?.promos ?? {};
      const v = p[`${mc}-recommended`] ?? p[`${mc}-latest`];
      return v ? [mk(v, "", "")] : [];
    }
    if (sw === "neoforge") {
      const [major, minor, patch] = mc.split(".");
      if (major !== "1" || !minor) return [];
      const d = await get(`https://maven.neoforged.net/api/maven/latest/version/releases/net/neoforged/neoforge?filter=${minor}.${patch ?? 0}.`);
      return d?.version ? [mk(d.version, "", "")] : [];
    }
    return [];
  }

  /** 選んだビルドの取得先を確かめる(SpongeVanilla は版ごとに引く) */
  async function resolve(sw: Software, b: Build): Promise<Build> {
    if (sw !== "sponge" || b.url) return b;
    const a = (((await get(`${SPONGE}/versions/${enc(b.build)}`))?.assets ?? []) as J[]).find((x) => x.classifier === "universal" && x.extension === "jar");
    return { ...b, url: String(a?.downloadUrl ?? ""), auto: !!a?.downloadUrl };
  }

  return {
    mcVersions, builds, resolve,
    /** いちばん新しいビルド(安定版があればその中で。わからなければ null) */
    async latest(sw: Software, mc: string): Promise<Build | null> {
      const list = await builds(sw, mc);
      const b = list.find((x) => x.stable) ?? list[0];
      return b ? resolve(sw, b) : null;
    },
  };
}

/** サーバーのフォルダ(と Pterodactyl の egg・起動の変数)から、サーバー本体の種類と Minecraft のバージョンを推し量る(v02 の detect_server) */
export async function detectServer(client: PteroClient, remoteId: string, extra?: { egg: string; vars: Record<string, string> }) {
  const root = await client.listFiles(remoteId, "/");
  const names = new Set(root.map((f) => f.name.toLowerCase()));
  const jars = root.filter((f) => f.isFile && f.name.toLowerCase().endsWith(".jar")).map((f) => f.name);
  const sub = async (dir: string) => new Set((await client.listFiles(remoteId, dir).catch(() => [])).map((f) => f.name.toLowerCase()));
  let sw: Software | null = softwareOfName(extra?.vars.SERVER_JARFILE) ?? jars.map(softwareOfName).find((x) => x) ?? null;
  if (!sw) {
    sw = names.has("velocity.toml") ? "velocity" : names.has("waterfall.yml") ? "waterfall" : names.has("modules.yml") ? "bungeecord"
      : names.has("purpur.yml") ? "purpur" : names.has("paper.yml") || (names.has("config") && (await sub("config")).has("paper-global.yml")) ? "paper"
      : names.has("spigot.yml") || names.has("bukkit.yml") ? "spigot" : names.has(".quilt") ? "quilt" : names.has(".fabric") ? "fabric" : null;
  }
  if (!sw && names.has("libraries")) {
    const net = await sub("libraries/net");
    sw = net.has("neoforged") ? "neoforge" : net.has("minecraftforge") ? "forge" : null;
  }
  sw ??= softwareOfName(extra?.egg);
  let mc = "";
  const vh = await client.readFile(remoteId, "version_history.json").catch(() => null);
  try {
    if (vh) mc = parseBuild(String(JSON.parse(vh).currentVersion ?? "")).mc;
  } catch { /* 読めなければ jar の名前から */ }
  mc ||= jars.map((j) => parseBuild(j).mc || j.match(/(?:mc\.?|[-_.])((?:1\.\d{1,2}|\d{2}\.\d{1,2})(?:\.\d{1,2})?)(?=[-_.]|$)/i)?.[1] || "").find((v) => MC_VERSION.test(v)) ?? "";
  mc ||= [extra?.vars.MINECRAFT_VERSION, extra?.vars.MC_VERSION, extra?.vars.VERSION].find((v) => v && MC_VERSION.test(v)) ?? "";
  if (sw && isProxy(sw)) mc = "";
  return { software: sw, platform: sw ? SOFTWARE[sw].platform : null, mcVersion: MC_VERSION.test(mc) ? mc : null };
}

export function softwareService(deps: Deps) {
  const jobs = jobService(deps);
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const client = softwareClient(deps.fetch);

  // サーバー本体の jar: 記録したもの → 種類の名前が付いたもの → server.jar など → 1 つだけの jar
  function pickJar(jars: string[], sw: Software, recorded?: string) {
    if (recorded && jars.includes(recorded)) return recorded;
    const named = jars.filter((n) => softwareOfName(n) === sw);
    if (named.length === 1) return named[0];
    for (const n of ["server.jar", `${sw}.jar`, "fabric-server-launch.jar"]) if (jars.includes(n)) return n;
    return jars.length === 1 ? jars[0] : "";
  }

  async function look(who: Who | string, serverId: string) {
    const target = await serverOf(deps, who, serverId);
    const [p] = await db.select().from(serverProfile).where(eq(serverProfile.serverId, target.row.id));
    const [rec] = await db.select().from(serverSoftware).where(eq(serverSoftware.serverId, target.row.id));
    const root = await remote(() => target.client.listFiles(target.remoteId, "/"));
    const jars = root.filter((f) => f.isFile && f.name.toLowerCase().endsWith(".jar")).map((f) => f.name);
    // 種類: 選んだもの → jar の名前(サーバーの種類と合うとき) → サーバーの種類
    const platform: Platform | null = p && isPlatform(p.platform) ? p.platform : null;
    const fromJar = jars.map(softwareOfName).find((x) => x && (!platform || SOFTWARE[x].platform === platform));
    const software = isSoftware(rec?.software) ? rec.software : fromJar ?? (isSoftware(platform) ? platform : null);
    if (!software) throw new HttpError(400, "先にサーバーの種類(またはサーバー本体の種類)を選んでください");
    const jar = pickJar(jars, software, rec?.jar);
    // 今のビルド: 入れ替えた記録(jar の大きさが同じなら) → version_history.json(Paper 系) → jar の名前
    let now = { mc: "", build: "" };
    const size = root.find((f) => f.name === jar)?.size;
    if (rec && rec.jar && rec.jar === jar && rec.size === size) now = { mc: rec.mc, build: rec.build };
    else {
      const vh = await remote(() => target.client.readFile(target.remoteId, "version_history.json")).catch(() => null);
      if (vh) {
        try {
          now = parseBuild(String(JSON.parse(vh).currentVersion ?? ""));
        } catch { /* 読めなければ jar の名前から */ }
      }
      if (!now.build) now = jars.map(parseBuild).find((x) => x.build) ?? now;
    }
    const mc = now.mc || (isProxy(software) ? "" : p?.mcVersion ?? "");
    const build = now.build || (software === "vanilla" ? mc : ""); // バニラはビルドが無い(Minecraft のバージョンそのもの)
    // 残した jar(サーバーのフォルダにあるものだけ)。03.53.00 までの 1 つだけのものも読む
    let olds: OldJar[] = [];
    try {
      olds = JSON.parse(rec?.oldJars ?? "[]");
    } catch { /* 壊れていれば無いものとする */ }
    if (!olds.length && rec?.backupJar) olds = [{ file: rec.backupJar, build: rec.backupBuild, mc: "", at: rec.updatedAt.toISOString() }];
    const present = new Set(root.map((f) => f.name));
    olds = olds.filter((o) => o?.file && present.has(o.file));
    return { target, software, platform, jar, present, now: { mc, build }, olds, rec };
  }

  // 今の jar を残すときの名前(重ならないように)
  const keepName = (jar: string, present: Set<string>) => {
    let n = Date.now();
    while (present.has(`${jar}${OLD}-${n}`)) n++;
    return `${jar}${OLD}-${n}`;
  };

  async function save(serverId: string, values: { jar: string; build: string; mc: string; size: number; software: Software; olds: OldJar[] }) {
    const { olds, ...rest } = values;
    const row = { serverId, ...rest, oldJars: JSON.stringify(olds), backupJar: olds[0]?.file ?? "", backupBuild: olds[0]?.build ?? "", updatedAt: new Date() };
    await db.insert(serverSoftware).values(row).onConflictDoUpdate({ target: serverSoftware.serverId, set: row });
  }

  // Minecraft のバージョンが変わったら、サーバーの種類のバージョンも変える(プロキシは変えない)
  async function setMc(serverId: string, sw: Software, before: string, after: string) {
    if (!after || after === before || isProxy(sw)) return;
    await db.update(serverProfile).set({ mcVersion: after, updatedAt: new Date() }).where(eq(serverProfile.serverId, serverId));
  }

  const mcChange = (before: string, after: string) => (before && after && before !== after ? `${before} → ${after}・` : "");

  /**
   * 配布元のビルドに入れ替える(管理者以上)。build を省くといちばん新しいもの、mc を渡すとその Minecraft のバージョンのもの(上げる・下げる)。
   * 今の jar は名前を変えて残し(5 つまで。古いものから消す)、新しい jar を同じ名前で取り込ませる。取り込めなければ元に戻す。restart なら最後に再起動する
   */
  async function installOf(headers: Headers, serverId: string, input: { mc?: string; build?: string; restart?: boolean }) {
    const who = await requireTeam(auth, headers, { server: ["update"] });
    const l = await look(who, serverId);
    const { client: c, remoteId, row } = l.target;
    if (!l.jar) throw new HttpError(400, "サーバー本体の jar が分かりません(サーバーのフォルダに jar が 1 つだけになるようにしてください)");
    const mc = input.mc || l.now.mc;
    if (input.mc && input.mc !== l.now.mc && !(await client.mcVersions(l.software)).includes(input.mc)) throw new HttpError(400, "この Minecraft のバージョンは選べません");
    const list = await client.builds(l.software, mc);
    const found = input.build ? list.find((b) => b.build === input.build) : list.find((b) => b.stable) ?? list[0];
    if (!found) throw new HttpError(404, input.build ? "そのビルドは配布元の一覧にありません" : "新しいビルドが見つかりません(Minecraft のバージョンを設定してください)");
    const target = await client.resolve(l.software, found);
    if (!target.auto || !target.url) throw new HttpError(400, `${SOFTWARE[l.software].label} は自動で入れ替えられません(配布ページで確かめてください)`);
    if (new URL(target.url).protocol !== "https:" || !BUILD_HOSTS.includes(new URL(target.url).host)) throw new HttpError(400, "配布元の外の URL なので、取り込みませんでした");
    const keep = keepName(l.jar, l.present);
    await remote(async () => {
      await c.rename(remoteId, "/", l.jar, keep);
      try {
        await c.pull(remoteId, target.url, "/", l.jar);
      } catch (e) {
        await c.rename(remoteId, "/", keep, l.jar).catch(() => {}); // 元に戻す
        throw e;
      }
    });
    const olds = [{ file: keep, build: l.now.build, mc: l.now.mc, at: new Date().toISOString() }, ...l.olds];
    const drop = olds.slice(KEEP_JARS).map((o) => o.file);
    if (drop.length) await remote(() => c.deleteFiles(remoteId, "/", drop)).catch(() => {});
    const size = (await remote(() => c.listFiles(remoteId, "/"))).find((f) => f.name === l.jar)?.size ?? 0;
    await save(row.id, { jar: l.jar, build: target.build, mc: target.mc, size, software: l.software, olds: olds.slice(0, KEEP_JARS) });
    await setMc(row.id, l.software, l.now.mc, target.mc);
    const changed = !isProxy(l.software) && target.mc && l.now.mc && target.mc !== l.now.mc;
    await record({ teamId: who.teamId, userId: who.user.id, kind: "changes", target: row.name,
      action: changed ? (newer(target.mc, l.now.mc) ? "Minecraft のバージョンを上げる" : "Minecraft のバージョンを変える") : "サーバー本体を更新",
      detail: `${changed ? mcChange(l.now.mc, target.mc) : ""}${l.now.build || "?"} → ${target.build}` });
    if (input.restart) await remote(() => c.power(remoteId, "restart"));
    return { build: target.build, mc: target.mc, restarted: !!input.restart };
  }

  /** 残した jar に戻す(管理者以上。file を省くといちばん新しいもの)。今の jar は、代わりに残す(もう一度戻すと元に戻る) */
  async function rollbackOf(headers: Headers, serverId: string, file?: string) {
    const who = await requireTeam(auth, headers, { server: ["update"] });
    const l = await look(who, serverId);
    const { client: c, remoteId, row } = l.target;
    const chosen = file ? l.olds.find((o) => o.file === file) : l.olds[0];
    if (!chosen || !l.jar) throw new HttpError(404, "入れ替える前の jar がありません");
    const keep = keepName(l.jar, l.present);
    await remote(async () => {
      await c.rename(remoteId, "/", l.jar, keep);
      try {
        await c.rename(remoteId, "/", chosen.file, l.jar);
      } catch (e) {
        await c.rename(remoteId, "/", keep, l.jar).catch(() => {});
        throw e;
      }
    });
    const size = (await remote(() => c.listFiles(remoteId, "/"))).find((f) => f.name === l.jar)?.size ?? 0;
    const olds = [{ file: keep, build: l.now.build, mc: l.now.mc, at: new Date().toISOString() }, ...l.olds.filter((o) => o !== chosen)];
    await save(row.id, { jar: l.jar, build: chosen.build, mc: chosen.mc || l.now.mc, size, software: l.software, olds: olds.slice(0, KEEP_JARS) });
    await setMc(row.id, l.software, l.now.mc, chosen.mc);
    await record({ teamId: who.teamId, userId: who.user.id, kind: "changes", action: "サーバー本体を戻す", target: row.name,
      detail: `${mcChange(l.now.mc, chosen.mc)}${l.now.build || "?"} → ${chosen.build || "?"}` });
    return { build: chosen.build };
  }

  return {
    /** サーバー本体の今のビルドと、いちばん新しいビルド・残した jar */
    async info(headers: Headers, serverId: string) {
      const who = await requireTeam(auth, headers);
      const l = await look(who, serverId);
      const latest = await client.latest(l.software, l.now.mc);
      const mcNewer = l.now.mc && !isProxy(l.software) ? (await client.mcVersions(l.software)).filter((v) => newer(v, l.now.mc)).slice(0, 10) : [];
      return {
        software: l.software, platform: l.platform, label: SOFTWARE[l.software].label, page: SOFTWARE[l.software].page, auto: SOFTWARE[l.software].auto,
        proxy: isProxy(l.software), mcNewer, jar: l.jar, mc: l.now.mc, build: l.now.build, latest,
        update: !!(latest && latest.build && latest.build !== l.now.build && (!l.now.build || newer(latest.build, l.now.build))),
        backup: l.olds[0] ? { jar: l.olds[0].file, build: l.olds[0].build } : null,
        backups: l.olds,
      };
    },

    /** 配布元のビルドの一覧(mc を渡すとそのバージョンの。見るのはメンバー全員) */
    async builds(headers: Headers, serverId: string, mc?: string) {
      const who = await requireTeam(auth, headers);
      const l = await look(who, serverId);
      const versions = await client.mcVersions(l.software);
      const v = mc && versions.includes(mc) ? mc : l.now.mc;
      return { mc: v, mcVersions: versions, builds: await client.builds(l.software, v) };
    },

    /**
     * 配布元のビルドに入れ替える(管理者以上)。中身は installOf。処理の一覧に残す
     */
    async install(headers: Headers, serverId: string, input: { mc?: string; build?: string; restart?: boolean }) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, who, serverId);
      return jobs.track({ teamId: who.teamId, userId: who.user.id, serverId: row.id, action: "サーバー本体を更新" },
        () => installOf(headers, serverId, input), (r) => `${r.mc ? `${r.mc} ` : ""}${r.build}${r.restarted ? "(再起動しました)" : ""}`);
    },

    /** いちばん新しいビルドに入れ替える(mc を渡すと、その Minecraft のバージョンの。install の短い形) */
    update(headers: Headers, serverId: string, restart = false, mc?: string) {
      return this.install(headers, serverId, { restart, mc });
    },

    /** 残した jar に戻す(管理者以上)。中身は rollbackOf。処理の一覧に残す */
    async rollback(headers: Headers, serverId: string, file?: string) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, who, serverId);
      return jobs.track({ teamId: who.teamId, userId: who.user.id, serverId: row.id, action: "サーバー本体を戻す" }, () => rollbackOf(headers, serverId, file), (r) => r.build);
    },

    /** サーバー本体の種類を決める(管理者以上。Leaf・Vanilla など、サーバーの種類だけでは分からないもの) */
    async setSoftware(headers: Headers, serverId: string, software: string) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      if (!isSoftware(software)) throw new HttpError(400, "サーバー本体の種類を選んでください");
      const { row } = await serverOf(deps, who, serverId);
      await db.insert(serverSoftware).values({ serverId: row.id, jar: "", software }).onConflictDoUpdate({ target: serverSoftware.serverId, set: { software, updatedAt: new Date() } });
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "サーバー本体の種類を設定", target: row.name, detail: SOFTWARE[software].label });
    },

    /** サーバーのファイルから、サーバーの種類と Minecraft のバージョンを推し量る(管理者以上。決めるのは画面で確かめてから) */
    async detect(headers: Headers, serverId: string) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { row, client: c, remoteId } = await serverOf(deps, who, serverId);
      const extra = row.kind === "ptero" ? await (c as unknown as { details: (id: string) => Promise<{ egg: string; vars: Record<string, string> }> }).details(remoteId).catch(() => undefined) : undefined;
      return remote(() => detectServer(c, remoteId, extra));
    },

    /** 新しい版の見回り用(人の操作ではない): 新しいビルドがあれば、知らせる 1 行。わからなければ null */
    async notice(teamId: string, serverId: string) {
      const l = await look(teamId, serverId);
      const latest = await client.latest(l.software, l.now.mc);
      if (!latest?.build || !l.now.build || latest.build === l.now.build || !newer(latest.build, l.now.build)) return null;
      return `・サーバー本体(${SOFTWARE[l.software].label}${l.now.mc ? ` ${l.now.mc}` : ""}): ${l.now.build} → ${latest.build}`;
    },
  };
}

export type SoftwareService = ReturnType<typeof softwareService>;
