// サーバーの Mod・プラグイン: 一覧・配布元(Modrinth・SpigotMC)での検索・入れる(更新を含む)・外す。
// ファイルはこのアプリを通さず、Pterodactyl に配布元から直接取り込ませる
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { PLATFORMS, MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { installedMod, libraryItem, server, serverHold, serverProfile } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { type ItemSource, SOURCE_LABEL, isItemSource } from "~/lib/sources";
import { ModrinthError, type ProjectType, isProjectType, modrinthClient } from "./modrinth";
import { SpigetError, spigetClient } from "./spiget";
import { CF_KEY, CurseForgeError, curseforgeClient } from "./curseforge";
import { installHistory, libraryFile, teamCurseforge } from "./db/schema";
import { hint, open, seal } from "./secrets";
import { fileStore } from "./uploads";
import { eventService } from "./events";
import { type Deps, remote, serverOf } from "./servers";

// 無料で使える範囲
export const LIBRARY_LIMITS = { itemsPerTeam: 500 };

// 配布元からのエラーは、画面に出せる言葉にして返す
export async function fromSource<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ModrinthError || e instanceof SpigetError || e instanceof CurseForgeError) throw new HttpError(502, e.message);
    throw e;
  }
}

type Target = Awaited<ReturnType<typeof serverOf>>;
type Profile = { platform: Platform; mcVersion: string | null };

// Mod・プラグインを扱う共通の処理(ライブラリ・セットで使う)。権限の確認は呼ぶ側で行う
export function modTools(deps: Deps) {
  const { db } = deps;
  const modrinth = modrinthClient(deps.fetch);
  const spiget = spigetClient(deps.fetch);

  const files = fileStore(deps);

  // CurseForge は、チームが設定した API キーで使う(自分用の版だけ)
  const cfKeyOf = async (teamId: string) => {
    if (!deps.local) return null;
    const [k] = await db.select().from(teamCurseforge).where(eq(teamCurseforge.teamId, teamId));
    return k ? open(deps.secret, k.apiKeySealed, `curseforge:${teamId}`) : null;
  };
  async function curseforge(teamId: string) {
    const key = await cfKeyOf(teamId);
    if (!key) throw new HttpError(400, "CurseForge を使うには、「チーム」で CurseForge の API キーを設定してください");
    return curseforgeClient(deps.fetch, key);
  }

  // 配布元ごとの、入れる版・プロジェクトの名前。アップロードしたものは、保存先のファイル(upload)を返す
  async function latestFile(source: ItemSource, projectId: string, p: Profile, teamId: string) {
    if (source === "upload") {
      const r = await files.pick(teamId, projectId, p.platform);
      if (!r) return null;
      const f = r.file;
      return { projectId, versionId: f.id, versionNumber: f.version || f.filename, filename: f.filename, url: "", sha512: "", size: f.size, upload: f, deps: [] as string[] };
    }
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    const f = await fromSource(() => (cf ? cf.latestFile(projectId, p.platform, p.mcVersion)
      : source === "spigot" ? spiget.latestFile(projectId, p.platform) : modrinth.latestFile(projectId, p.platform, p.mcVersion)));
    return f ? { ...f, upload: undefined } : null;
  }
  async function project(source: ItemSource, projectId: string, teamId: string) {
    if (source === "upload") {
      const [i] = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, "upload"), eq(libraryItem.projectId, projectId)));
      return i ? { title: i.title, slug: "", projectType: i.projectType, iconUrl: "" } : null;
    }
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    return fromSource(() => (cf ? cf.project(projectId) : source === "spigot" ? spiget.project(projectId) : modrinth.project(projectId)));
  }

  async function profileOf(serverId: string) {
    const [p] = await db.select().from(serverProfile).where(eq(serverProfile.serverId, serverId));
    return p && isPlatform(p.platform) ? { platform: p.platform as Platform, mcVersion: p.mcVersion } : null;
  }
  async function needProfile(serverId: string) {
    const p = await profileOf(serverId);
    if (!p) throw new HttpError(400, "先にサーバーの種類を選んでください");
    return p;
  }

  // ライブラリに載せる(載っていれば名前・アイコンを新しくする)
  async function remember(teamId: string, userId: string | null, source: ItemSource, projectId: string, p: { title: string; slug: string; projectType: ProjectType; iconUrl: string }) {
    const set = { title: p.title, slug: p.slug, iconUrl: p.iconUrl };
    const [row] = await db.insert(libraryItem)
      .values({ id: randomUUID(), teamId, source, projectId, projectType: p.projectType, addedBy: userId, ...set })
      .onConflictDoUpdate({ target: [libraryItem.teamId, libraryItem.source, libraryItem.projectId], set })
      .returning({ id: libraryItem.id });
    return row.id;
  }

  // 決まった版のファイル(前の版に戻すとき)。SpigotMC は古い版を取ってこられないので null
  async function fileById(source: ItemSource, projectId: string, versionId: string, teamId: string) {
    if (source === "upload") {
      const [f] = await db.select().from(libraryFile).where(eq(libraryFile.id, versionId));
      return f ? { projectId, versionId: f.id, versionNumber: f.version || f.filename, filename: f.filename, url: "", sha512: "", size: f.size, upload: f, deps: [] as string[] } : null;
    }
    if (source === "spigot") return null;
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    const file = await fromSource(() => (cf ? cf.file(projectId, versionId) : modrinth.version(projectId, versionId)));
    return file ? { ...file, upload: undefined } : null;
  }

  // このサーバーに入れられる版(新しい順)。SpigotMC は前の版を取ってこられないので空
  async function versionsOf(source: ItemSource, projectId: string, p: Profile, teamId: string) {
    if (source === "spigot") return [];
    if (source === "upload") {
      return (await files.choices(teamId, projectId, p.platform)).files.slice(0, 30)
        .map((f) => ({ versionId: f.id, versionNumber: f.version || f.filename, date: f.date_published, release: true }));
    }
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    return fromSource(() => (cf ? cf.files(projectId, p.platform, p.mcVersion) : modrinth.versions(projectId, p.platform, p.mcVersion)));
  }

  type Installed = { title: string; filename: string; versionNumber: string; replaced: string[]; deps: { title: string; ok: boolean; detail: string }[] };

  /**
   * 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新。消した版は履歴に残す)。
   * Modrinth の前提(必須)で、まだ入っていないものも入れる(depth 段まで)。opts.file を渡すと、その版を入れる(前の版に戻すとき)
   */
  async function installInto(teamId: string, userId: string | null, target: Target, p: Profile, source: ItemSource, projectId: string,
    opts: { file?: Awaited<ReturnType<typeof fileById>>; depth?: number } = {}): Promise<Installed> {
    const { row, client, remoteId } = target;
    const file = opts.file ?? await latestFile(source, projectId, p, teamId);
    if (!file) {
      throw new HttpError(404, source === "spigot"
        ? "このサーバーの種類で動く版がありません(SpigotMC の外で配っているもの・有料のものは入れられません)"
        : source === "upload" ? "このサーバーの種類で動く版が、アップロードしたものの中にありません"
        : source === "curseforge" ? "このサーバーの種類・バージョンに合う版がありません(外部からのダウンロードを許していない版は入れられません)"
        : "このサーバーの種類・バージョンに合う版がありません");
    }
    const info = await project(source, projectId, teamId);
    const dir = PLATFORMS[p.platform].dir;

    // アップロードしたものは、保存先から読んでサーバーに送る。配布元のものは、サーバーに直接取り込ませる
    if (file.upload) {
      const data = await files.read(teamId, file.upload);
      await remote(() => client.upload(remoteId, dir, file.filename, data));
    } else {
      await remote(() => client.pull(remoteId, file.url, dir, file.filename));
    }

    const old = await db.select().from(installedMod)
      .where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, source), eq(installedMod.projectId, projectId)));
    const stale = old.filter((o) => o.filename !== file.filename);
    if (stale.length) {
      await remote(() => client.deleteFiles(remoteId, dir, stale.map((o) => o.filename)));
      for (const o of stale) {
        await db.delete(installedMod).where(eq(installedMod.id, o.id));
        if (o.versionId !== file.versionId) {
          await db.insert(installHistory).values({ id: randomUUID(), serverId: row.id, source, projectId, versionId: o.versionId, versionNumber: o.versionNumber, filename: o.filename });
        }
      }
      // 履歴は 1 つにつき新しい 10 件まで
      const hist = await db.select({ id: installHistory.id }).from(installHistory)
        .where(and(eq(installHistory.serverId, row.id), eq(installHistory.source, source), eq(installHistory.projectId, projectId))).orderBy(desc(installHistory.replacedAt)).offset(10);
      if (hist.length) await db.delete(installHistory).where(inArray(installHistory.id, hist.map((h) => h.id)));
    }
    const values = {
      id: randomUUID(), serverId: row.id, source, projectId, versionId: file.versionId, versionNumber: file.versionNumber,
      title: info?.title || file.filename, filename: file.filename, installedBy: userId, installedAt: new Date(),
    };
    const { id: _, ...update } = values;
    await db.insert(installedMod).values(values).onConflictDoUpdate({ target: [installedMod.serverId, installedMod.filename], set: update });
    await remember(teamId, userId, source, projectId, {
      title: values.title, slug: info?.slug ?? "", iconUrl: info?.iconUrl ?? "",
      projectType: PLATFORMS[p.platform].type, // 入れられたサーバーの種類(Modrinth は、プラグインでも Fabric などにも対応したものを "mod" と返す)
    });

    // 前提(Modrinth・CurseForge の必須)のうち、このサーバーにまだ無いもの。入れられなくても、もとのものは入れたまま
    const deps: Installed["deps"] = [];
    const depth = opts.depth ?? 2;
    if ((source === "modrinth" || source === "curseforge") && depth > 0 && file.deps?.length) {
      const have = new Set((await db.select({ id: installedMod.projectId }).from(installedMod)
        .where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, source)))).map((x) => x.id));
      for (const dep of file.deps.filter((d) => !have.has(d))) {
        try {
          const r = await installInto(teamId, userId, target, p, source, dep, { depth: depth - 1 });
          deps.push({ title: r.title, ok: true, detail: r.versionNumber }, ...r.deps);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          deps.push({ title: dep, ok: false, detail: e.message });
        }
      }
    }
    return { title: values.title, filename: file.filename, versionNumber: file.versionNumber, replaced: stale.map((o) => o.filename), deps };
  }

  // 更新を止めているもの("配布元:ID" の集合)
  const holdsOf = async (serverId: string) =>
    new Set((await db.select().from(serverHold).where(eq(serverHold.serverId, serverId))).map((h) => `${h.source}:${h.projectId}`));

  return { modrinth, spiget, curseforge, cfKeyOf, latestFile, fileById, versionsOf, project, profileOf, needProfile, remember, installInto, holdsOf };
}

export function libraryService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const { modrinth, spiget, curseforge, cfKeyOf, latestFile, fileById, versionsOf, project, profileOf, needProfile, remember, installInto, holdsOf } = modTools(deps);
  // このチームで探せる配布元(CurseForge は API キーを設定したときだけ)
  const sourcesOf = async (teamId: string) => ["modrinth", "spigot", ...((await cfKeyOf(teamId)) ? ["curseforge"] : [])];
  const sourceOf = (v: string) => {
    if (!isItemSource(v)) throw new HttpError(400, "配布元を選んでください");
    return v;
  };
  // 探す・足すのは配布元(Modrinth・SpigotMC)だけ。アップロードしたものは、アップロードで足す
  const searchable = (v: string) => {
    const s = sourceOf(v);
    if (s === "upload") throw new HttpError(400, "アップロードしたものは、「ファイルをアップロード」から足してください");
    return s;
  };

  return {
    /** チームのライブラリ: 登録したもの・それぞれが入っているサーバーと版・入れられるサーバー */
    async catalog(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      const items = await db.select().from(libraryItem).where(eq(libraryItem.teamId, teamId)).orderBy(asc(libraryItem.title));
      const installs = await db.select({ serverId: server.id, serverName: server.name, source: installedMod.source, projectId: installedMod.projectId, versionNumber: installedMod.versionNumber })
        .from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id))
        .where(eq(server.teamId, teamId)).orderBy(asc(server.name));
      const servers = await db.select({ id: server.id, name: server.name, platform: serverProfile.platform })
        .from(server).leftJoin(serverProfile, eq(serverProfile.serverId, server.id)).where(eq(server.teamId, teamId)).orderBy(asc(server.name));
      return {
        items: items.map((i) => ({
          id: i.id, source: i.source, projectId: i.projectId, title: i.title, slug: i.slug, projectType: i.projectType, iconUrl: i.iconUrl,
          installs: installs.filter((r) => r.source === i.source && r.projectId === i.projectId).map(({ serverId, serverName, versionNumber }) => ({ serverId, serverName, versionNumber })),
        })),
        // 種類を決めていないサーバーには入れられない(type が null)
        servers: servers.map((x) => ({ id: x.id, name: x.name, type: isPlatform(x.platform) ? PLATFORMS[x.platform].type : null })),
        sources: await sourcesOf(teamId),
      };
    },

    /** 配布元で、プラグイン・Mod を種類だけで探す(ライブラリに足すとき)。SpigotMC はプラグインだけ */
    async searchCatalog(headers: Headers, query: string, type: string, source = "modrinth") {
      const { teamId } = await requireTeam(auth, headers);
      if (!isProjectType(type)) throw new HttpError(400, "種類を選んでください");
      const src = searchable(source);
      if (src === "spigot" && type !== "plugin") throw new HttpError(400, "SpigotMC で探せるのはプラグインだけです");
      const cf = src === "curseforge" ? await curseforge(teamId) : null;
      return fromSource(() => (cf ? cf.searchType(query, type) : src === "spigot" ? spiget.searchAll(query) : modrinth.searchType(query, type)));
    },

    /** CurseForge の API キーの設定(自分用の版・管理者以上。キーは最後の 4 文字だけ) */
    async curseforgeKey(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      if (!deps.local) return { enabled: false, hint: "" };
      const [k] = await db.select({ hint: teamCurseforge.apiKeyHint }).from(teamCurseforge).where(eq(teamCurseforge.teamId, teamId));
      return { enabled: true, hint: k?.hint ?? "" };
    },

    /** CurseForge の API キーを設定する(使えることを確かめてから保存)。null なら消す */
    async setCurseforgeKey(headers: Headers, key: string | null) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      if (!deps.local) throw new HttpError(400, "CurseForge は、自分用の版だけで使えます");
      if (key === null) {
        await db.delete(teamCurseforge).where(eq(teamCurseforge.teamId, teamId));
        await record({ teamId, userId: user.id, kind: "admin", action: "CurseForge の API キーを消す" });
        return;
      }
      const k = key.trim();
      if (!CF_KEY.test(k)) throw new HttpError(400, "CurseForge の API キー(console.curseforge.com で作ったもの)を入力してください");
      await fromSource(() => curseforgeClient(deps.fetch, k).check());
      const values = { teamId, apiKeySealed: seal(deps.secret, k, `curseforge:${teamId}`), apiKeyHint: hint(k), updatedAt: new Date() };
      await db.insert(teamCurseforge).values(values).onConflictDoUpdate({ target: teamCurseforge.teamId, set: values });
      await record({ teamId, userId: user.id, kind: "admin", action: "CurseForge の API キーを設定" });
    },

    /** ライブラリに足す */
    async addItem(headers: Headers, projectId: string, source = "modrinth", type?: string) {
      const src = searchable(source);
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const [{ n }] = await db.select({ n: count() }).from(libraryItem).where(eq(libraryItem.teamId, teamId));
      if (n >= LIBRARY_LIMITS.itemsPerTeam) throw new HttpError(400, `ライブラリに登録できるのは ${LIBRARY_LIMITS.itemsPerTeam} 件までです`);
      const p = await project(src, projectId, teamId);
      if (!p) throw new HttpError(404, `${SOURCE_LABEL[src]} にこのプロジェクトが見つかりません`);
      if (!isProjectType(p.projectType)) {
        throw new HttpError(400, src === "spigot"
          ? "SpigotMC の外で配っているもの・有料のもの・プラグインではないものは登録できません"
          : src === "curseforge" ? "外部からのダウンロードを許していないもの・プラグインと Mod 以外は登録できません"
          : "ライブラリに登録できるのは、プラグインと Mod だけです");
      }
      // 探したときの種類を優先する(Modrinth は、プラグインでも Fabric などにも対応したものを "mod" と返す)
      const itemId = await remember(teamId, user.id, src, projectId, { ...p, projectType: isProjectType(type) ? type : p.projectType, title: p.title || projectId });
      await record({ teamId, userId: user.id, kind: "admin", action: "ライブラリに足す", target: p.title || projectId, detail: SOURCE_LABEL[src] });
      return { id: itemId };
    },

    /** ライブラリから外す(サーバーに入っているファイルはそのまま) */
    async removeItem(headers: Headers, itemId: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const gone = await db.delete(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId))).returning({ title: libraryItem.title });
      if (!gone.length) throw new HttpError(404, "見つかりません");
      await record({ teamId, userId: user.id, kind: "admin", action: "ライブラリから外す", target: gone[0].title });
    },

    /** サーバーの名前・種類・バージョン */
    async detail(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      return { id: row.id, name: row.name, kind: row.kind, profile: await profileOf(row.id), sources: await sourcesOf(teamId) };
    },

    /** サーバーの種類(paper・fabric など)とバージョンを決める */
    async setProfile(headers: Headers, id: string, input: { platform: string; mcVersion: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, teamId, id);
      if (!isPlatform(input.platform)) throw new HttpError(400, "サーバーの種類を選んでください");
      const mcVersion = input.mcVersion.trim() || null;
      if (mcVersion && !MC_VERSION.test(mcVersion)) throw new HttpError(400, "バージョンは 1.21.1 や 26.3 のように入力してください");
      const values = { serverId: row.id, platform: input.platform, mcVersion, updatedAt: new Date() };
      await db.insert(serverProfile).values(values).onConflictDoUpdate({ target: serverProfile.serverId, set: values });
      await record({ teamId, userId: user.id, kind: "admin", action: "サーバーの種類を設定", target: row.name, detail: `${PLATFORMS[input.platform].label}${mcVersion ? ` ${mcVersion}` : ""}` });
    },

    /** 入っている Mod・プラグイン(サーバーのフォルダーの中身と、このアプリで入れた記録を合わせる) */
    async installed(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      const profile = await needProfile(row.id);
      const dir = PLATFORMS[profile.platform].dir;
      const files = (await remote(() => client.listFiles(remoteId, dir))).filter((f) => f.isFile && f.name.toLowerCase().endsWith(".jar"));
      const records = new Map((await db.select().from(installedMod).where(eq(installedMod.serverId, row.id))).map((r) => [r.filename, r]));
      const holds = await holdsOf(row.id);
      const history = new Set((await db.select({ source: installHistory.source, projectId: installHistory.projectId }).from(installHistory)
        .where(eq(installHistory.serverId, row.id))).filter((h) => h.source !== "spigot").map((h) => `${h.source}:${h.projectId}`));
      return {
        dir,
        items: files.map((f) => {
          const r = records.get(f.name);
          return {
            filename: f.name, size: f.size,
            ...(r ? { source: r.source, projectId: r.projectId, versionId: r.versionId, versionNumber: r.versionNumber, title: r.title, held: holds.has(`${r.source}:${r.projectId}`), canRollback: history.has(`${r.source}:${r.projectId}`) } : {}),
          };
        }).sort((a, b) => (a.title ?? a.filename).localeCompare(b.title ?? b.filename)),
      };
    },

    /** 配布元で、このサーバーの種類とバージョンに合うものを探す */
    async search(headers: Headers, id: string, query: string, source = "modrinth") {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      const src = searchable(source);
      if (src === "spigot" && PLATFORMS[p.platform].type !== "plugin") throw new HttpError(400, "SpigotMC にあるのはプラグインだけです");
      const cf = src === "curseforge" ? await curseforge(teamId) : null;
      return fromSource(() => (cf ? cf.search(query, p.platform, p.mcVersion) : src === "spigot" ? spiget.search(query, p.platform) : modrinth.search(query, p.platform, p.mcVersion)));
    },

    /** このサーバーに入れられる版(新しい順・30 個まで)。SpigotMC は、いちばん新しい版しか取ってこられないので空 */
    async versions(headers: Headers, id: string, source: string, projectId: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      return (await versionsOf(sourceOf(source), projectId, p, teamId))
        .map(({ versionId, versionNumber, date, release }) => ({ versionId, versionNumber, date, release }));
    },

    /**
     * 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新)。
     * versionId を渡すとその版を入れ、いちばん新しい版でなければ「更新を止める」にする(そろえる・予約で戻されないように)
     */
    async install(headers: Headers, id: string, projectId: string, source = "modrinth", versionId?: string) {
      const src = sourceOf(source);
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      let file: Awaited<ReturnType<typeof fileById>> = null;
      let hold = false;
      if (versionId) {
        if (src === "spigot") throw new HttpError(400, "SpigotMC のものは版を選べません(いちばん新しい版だけを入れられます)");
        // 一覧に出した版(このサーバーの種類・バージョンに合うもの)だけを受け付ける
        if (!(await versionsOf(src, projectId, p, teamId)).some((v) => v.versionId === versionId)) throw new HttpError(400, "この版は、このサーバーの種類・バージョンに合いません");
        file = await fileById(src, projectId, versionId, teamId);
        if (!file) throw new HttpError(404, "その版は見つかりません");
        hold = (await latestFile(src, projectId, p, teamId))?.versionId !== versionId;
      }
      const r = await installInto(teamId, user.id, { row, client, remoteId }, p, src, projectId, file ? { file } : {});
      if (hold) await db.insert(serverHold).values({ serverId: row.id, source: src, projectId, createdBy: user.id }).onConflictDoNothing();
      await record({ teamId, userId: user.id, kind: "changes", action: r.replaced.length ? "更新" : "入れる", target: row.name,
        detail: `${r.title} ${r.versionNumber}(${SOURCE_LABEL[src]})${hold ? "・版を選んだので更新を止めました" : ""}${r.deps.length ? `\n前提: ${r.deps.map((d) => `${d.title} ${d.ok ? d.detail : `(入れられません: ${d.detail})`}`).join("、")}` : ""}` });
      return { ...r, held: hold };
    },

    /** 前の版に戻す(更新で入れ替えた、いちばん新しい前の版を入れ直す)。戻したものは「更新を止める」にする */
    async rollback(headers: Headers, id: string, source: string, projectId: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const target = await serverOf(deps, teamId, id);
      const src = sourceOf(source);
      if (src === "spigot") throw new HttpError(400, "SpigotMC のものは、前の版を取ってこられないので戻せません");
      const p = await needProfile(target.row.id);
      const [prev] = await db.select().from(installHistory)
        .where(and(eq(installHistory.serverId, target.row.id), eq(installHistory.source, src), eq(installHistory.projectId, projectId)))
        .orderBy(desc(installHistory.replacedAt)).limit(1);
      if (!prev) throw new HttpError(404, "前の版の記録がありません");
      const file = await fileById(src, projectId, prev.versionId, teamId);
      if (!file) throw new HttpError(404, "前の版のファイルが、もう取ってこられません");
      const now = await db.select({ versionId: installedMod.versionId }).from(installedMod)
        .where(and(eq(installedMod.serverId, target.row.id), eq(installedMod.source, src), eq(installedMod.projectId, projectId)));
      const r = await installInto(teamId, user.id, target, p, src, projectId, { file, depth: 0 });
      // いま使った前の版の記録と、入れ替えで残った「戻す前の(新しい)版」の記録は消す(続けて押すと、さらに前の版に戻るように)
      await db.delete(installHistory).where(and(eq(installHistory.serverId, target.row.id), eq(installHistory.source, src), eq(installHistory.projectId, projectId),
        inArray(installHistory.versionId, [prev.versionId, ...now.map((x) => x.versionId)])));
      await db.insert(serverHold).values({ serverId: target.row.id, source: src, projectId, createdBy: user.id }).onConflictDoNothing();
      await record({ teamId, userId: user.id, kind: "changes", action: "前の版に戻す", target: target.row.name, detail: `${r.title} → ${r.versionNumber}(更新を止めました)` });
      return r;
    },

    /** 外す(サーバーのフォルダーからファイルを消す) */
    async remove(headers: Headers, id: string, filename: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      // フォルダーをまたぐ名前は受け付けず、いまフォルダーにある .jar だけを消す
      if (/[\\/]|^\.\.?$/.test(filename) || !filename.toLowerCase().endsWith(".jar")) throw new HttpError(400, "ファイルの名前が正しくありません");
      const p = await needProfile(row.id);
      const dir = PLATFORMS[p.platform].dir;
      const present = (await remote(() => client.listFiles(remoteId, dir))).some((f) => f.isFile && f.name === filename);
      if (!present) throw new HttpError(404, "ファイルが見つかりません");
      await remote(() => client.deleteFiles(remoteId, dir, [filename]));
      await db.delete(installedMod).where(and(eq(installedMod.serverId, row.id), eq(installedMod.filename, filename)));
      await record({ teamId, userId: user.id, kind: "changes", action: "外す", target: row.name, detail: filename });
    },

    /** 更新を止める・止めるのをやめる(そろえる・予約・更新の確認で、新しい版にしない) */
    async setHold(headers: Headers, id: string, source: string, projectId: string, hold: boolean) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const { row } = await serverOf(deps, teamId, id);
      const src = sourceOf(source);
      const [rec] = await db.select({ title: installedMod.title, versionNumber: installedMod.versionNumber }).from(installedMod)
        .where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, src), eq(installedMod.projectId, projectId)));
      if (!rec) throw new HttpError(404, "このアプリで入れたものではありません");
      if (hold) await db.insert(serverHold).values({ serverId: row.id, source: src, projectId, createdBy: user.id }).onConflictDoNothing();
      else await db.delete(serverHold).where(and(eq(serverHold.serverId, row.id), eq(serverHold.source, src), eq(serverHold.projectId, projectId)));
      await record({ teamId, userId: user.id, kind: "changes", action: hold ? "更新を止める" : "更新を止めるのをやめる", target: row.name, detail: `${rec.title} ${rec.versionNumber}` });
    },

    /** このアプリで入れたものに、新しい版があるか */
    async updates(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      const records = await db.select().from(installedMod).where(eq(installedMod.serverId, row.id));
      const holds = await holdsOf(row.id);
      const out: { source: ItemSource; projectId: string; filename: string; current: string; latest: string }[] = [];
      for (const r of records) {
        if (!isItemSource(r.source) || holds.has(`${r.source}:${r.projectId}`)) continue; // 止めているものは確かめない
        const f = await latestFile(r.source, r.projectId, p, teamId);
        if (f && f.versionId !== r.versionId) out.push({ source: r.source, projectId: r.projectId, filename: r.filename, current: r.versionNumber, latest: f.versionNumber });
      }
      return out;
    },
  };
}
