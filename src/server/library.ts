// サーバーの Mod・プラグイン: 一覧・配布元(Modrinth・SpigotMC)での検索・入れる(更新を含む)・外す。
// ファイルはこのアプリを通さず、Pterodactyl に配布元から直接取り込ませる
import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { PLATFORMS, MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { installedMod, libraryItem, server, serverHold, serverProfile } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { type Source, SOURCE_LABEL, isSource } from "~/lib/sources";
import { ModrinthError, type ProjectType, isProjectType, modrinthClient } from "./modrinth";
import { SpigetError, spigetClient } from "./spiget";
import { eventService } from "./events";
import { type Deps, remote, serverOf } from "./servers";

// 無料で使える範囲
export const LIBRARY_LIMITS = { itemsPerTeam: 500 };

// 配布元からのエラーは、画面に出せる言葉にして返す
export async function fromSource<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ModrinthError || e instanceof SpigetError) throw new HttpError(502, e.message);
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

  // 配布元ごとの、入れる版・プロジェクトの名前
  const latestFile = (source: Source, projectId: string, p: Profile) =>
    fromSource(() => (source === "spigot" ? spiget.latestFile(projectId, p.platform) : modrinth.latestFile(projectId, p.platform, p.mcVersion)));
  const project = (source: Source, projectId: string) => fromSource(() => (source === "spigot" ? spiget.project(projectId) : modrinth.project(projectId)));

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
  async function remember(teamId: string, userId: string | null, source: Source, projectId: string, p: { title: string; slug: string; projectType: ProjectType; iconUrl: string }) {
    const set = { title: p.title, slug: p.slug, iconUrl: p.iconUrl };
    const [row] = await db.insert(libraryItem)
      .values({ id: randomUUID(), teamId, source, projectId, projectType: p.projectType, addedBy: userId, ...set })
      .onConflictDoUpdate({ target: [libraryItem.teamId, libraryItem.source, libraryItem.projectId], set })
      .returning({ id: libraryItem.id });
    return row.id;
  }

  // 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新)
  async function installInto(teamId: string, userId: string | null, { row, client, remoteId }: Target, p: Profile, source: Source, projectId: string) {
    const file = await latestFile(source, projectId, p);
    if (!file) {
      throw new HttpError(404, source === "spigot"
        ? "このサーバーの種類で動く版がありません(SpigotMC の外で配っているもの・有料のものは入れられません)"
        : "このサーバーの種類・バージョンに合う版がありません");
    }
    const info = await project(source, projectId);
    const dir = PLATFORMS[p.platform].dir;

    await remote(() => client.pull(remoteId, file.url, dir, file.filename));

    const old = await db.select().from(installedMod)
      .where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, source), eq(installedMod.projectId, projectId)));
    const stale = old.filter((o) => o.filename !== file.filename);
    if (stale.length) {
      await remote(() => client.deleteFiles(remoteId, dir, stale.map((o) => o.filename)));
      for (const o of stale) await db.delete(installedMod).where(eq(installedMod.id, o.id));
    }
    const values = {
      id: randomUUID(), serverId: row.id, source, projectId, versionId: file.versionId, versionNumber: file.versionNumber,
      title: info?.title || file.filename, filename: file.filename, installedBy: userId, installedAt: new Date(),
    };
    const { id: _, ...update } = values;
    await db.insert(installedMod).values(values).onConflictDoUpdate({ target: [installedMod.serverId, installedMod.filename], set: update });
    await remember(teamId, userId, source, projectId, {
      title: values.title, slug: info?.slug ?? "", iconUrl: info?.iconUrl ?? "",
      projectType: isProjectType(info?.projectType) ? info.projectType : PLATFORMS[p.platform].type,
    });
    return { title: values.title, filename: file.filename, versionNumber: file.versionNumber, replaced: stale.map((o) => o.filename) };
  }

  // 更新を止めているもの("配布元:ID" の集合)
  const holdsOf = async (serverId: string) =>
    new Set((await db.select().from(serverHold).where(eq(serverHold.serverId, serverId))).map((h) => `${h.source}:${h.projectId}`));

  return { modrinth, spiget, latestFile, project, profileOf, needProfile, remember, installInto, holdsOf };
}

export function libraryService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const { modrinth, spiget, latestFile, project, profileOf, needProfile, remember, installInto, holdsOf } = modTools(deps);
  const sourceOf = (v: string) => {
    if (!isSource(v)) throw new HttpError(400, "配布元を選んでください");
    return v;
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
      };
    },

    /** 配布元で、プラグイン・Mod を種類だけで探す(ライブラリに足すとき)。SpigotMC はプラグインだけ */
    async searchCatalog(headers: Headers, query: string, type: string, source = "modrinth") {
      await requireTeam(auth, headers);
      if (!isProjectType(type)) throw new HttpError(400, "種類を選んでください");
      const src = sourceOf(source);
      if (src === "spigot" && type !== "plugin") throw new HttpError(400, "SpigotMC で探せるのはプラグインだけです");
      return fromSource(() => (src === "spigot" ? spiget.searchAll(query) : modrinth.searchType(query, type)));
    },

    /** ライブラリに足す */
    async addItem(headers: Headers, projectId: string, source = "modrinth") {
      const src = sourceOf(source);
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const [{ n }] = await db.select({ n: count() }).from(libraryItem).where(eq(libraryItem.teamId, teamId));
      if (n >= LIBRARY_LIMITS.itemsPerTeam) throw new HttpError(400, `ライブラリに登録できるのは ${LIBRARY_LIMITS.itemsPerTeam} 件までです`);
      const p = await project(src, projectId);
      if (!p) throw new HttpError(404, `${SOURCE_LABEL[src]} にこのプロジェクトが見つかりません`);
      if (!isProjectType(p.projectType)) {
        throw new HttpError(400, src === "spigot"
          ? "SpigotMC の外で配っているもの・有料のもの・プラグインではないものは登録できません"
          : "ライブラリに登録できるのは、プラグインと Mod だけです");
      }
      const itemId = await remember(teamId, user.id, src, projectId, { ...p, projectType: p.projectType, title: p.title || projectId });
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
      return { id: row.id, name: row.name, profile: await profileOf(row.id) };
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
      return {
        dir,
        items: files.map((f) => {
          const r = records.get(f.name);
          return {
            filename: f.name, size: f.size,
            ...(r ? { source: r.source, projectId: r.projectId, versionId: r.versionId, versionNumber: r.versionNumber, title: r.title, held: holds.has(`${r.source}:${r.projectId}`) } : {}),
          };
        }).sort((a, b) => (a.title ?? a.filename).localeCompare(b.title ?? b.filename)),
      };
    },

    /** 配布元で、このサーバーの種類とバージョンに合うものを探す */
    async search(headers: Headers, id: string, query: string, source = "modrinth") {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      const src = sourceOf(source);
      if (src === "spigot" && PLATFORMS[p.platform].type !== "plugin") throw new HttpError(400, "SpigotMC にあるのはプラグインだけです");
      return fromSource(() => (src === "spigot" ? spiget.search(query, p.platform) : modrinth.search(query, p.platform, p.mcVersion)));
    },

    /** 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新) */
    async install(headers: Headers, id: string, projectId: string, source = "modrinth") {
      const src = sourceOf(source);
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      const r = await installInto(teamId, user.id, { row, client, remoteId }, p, src, projectId);
      await record({ teamId, userId: user.id, kind: "changes", action: r.replaced.length ? "更新" : "入れる", target: row.name, detail: `${r.title} ${r.versionNumber}(${SOURCE_LABEL[src]})` });
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
      const out: { source: Source; projectId: string; filename: string; current: string; latest: string }[] = [];
      for (const r of records) {
        if (!isSource(r.source) || holds.has(`${r.source}:${r.projectId}`)) continue; // 止めているものは確かめない
        const f = await latestFile(r.source, r.projectId, p);
        if (f && f.versionId !== r.versionId) out.push({ source: r.source, projectId: r.projectId, filename: r.filename, current: r.versionNumber, latest: f.versionNumber });
      }
      return out;
    },
  };
}
