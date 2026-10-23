// サーバーの Mod・プラグイン: 一覧・Modrinth での検索・入れる(更新を含む)・外す。
// ファイルはこのアプリを通さず、Pterodactyl に Modrinth から直接取り込ませる
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { PLATFORMS, MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { installedMod, serverProfile } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { ModrinthError, modrinthClient } from "./modrinth";
import { type Deps, remote, serverOf } from "./servers";

async function fromModrinth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ModrinthError) throw new HttpError(502, e.message);
    throw e;
  }
}

export function libraryService(deps: Deps) {
  const { db, auth } = deps;
  const modrinth = modrinthClient(deps.fetch);

  async function profileOf(serverId: string) {
    const [p] = await db.select().from(serverProfile).where(eq(serverProfile.serverId, serverId));
    return p && isPlatform(p.platform) ? { platform: p.platform as Platform, mcVersion: p.mcVersion } : null;
  }
  async function needProfile(serverId: string) {
    const p = await profileOf(serverId);
    if (!p) throw new HttpError(400, "先にサーバーの種類を選んでください");
    return p;
  }

  return {
    /** サーバーの名前・種類・バージョン */
    async detail(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      return { id: row.id, name: row.name, profile: await profileOf(row.id) };
    },

    /** サーバーの種類(paper・fabric など)とバージョンを決める */
    async setProfile(headers: Headers, id: string, input: { platform: string; mcVersion: string }) {
      const { teamId } = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, teamId, id);
      if (!isPlatform(input.platform)) throw new HttpError(400, "サーバーの種類を選んでください");
      const mcVersion = input.mcVersion.trim() || null;
      if (mcVersion && !MC_VERSION.test(mcVersion)) throw new HttpError(400, "バージョンは 1.21.1 のように入力してください");
      const values = { serverId: row.id, platform: input.platform, mcVersion, updatedAt: new Date() };
      await db.insert(serverProfile).values(values).onConflictDoUpdate({ target: serverProfile.serverId, set: values });
    },

    /** 入っている Mod・プラグイン(サーバーのフォルダーの中身と、このアプリで入れた記録を合わせる) */
    async installed(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      const profile = await needProfile(row.id);
      const dir = PLATFORMS[profile.platform].dir;
      const files = (await remote(() => client.listFiles(remoteId, dir))).filter((f) => f.isFile && f.name.toLowerCase().endsWith(".jar"));
      const records = new Map((await db.select().from(installedMod).where(eq(installedMod.serverId, row.id))).map((r) => [r.filename, r]));
      return {
        dir,
        items: files.map((f) => {
          const r = records.get(f.name);
          return {
            filename: f.name, size: f.size,
            ...(r ? { source: r.source, projectId: r.projectId, versionId: r.versionId, versionNumber: r.versionNumber, title: r.title } : {}),
          };
        }).sort((a, b) => (a.title ?? a.filename).localeCompare(b.title ?? b.filename)),
      };
    },

    /** Modrinth で、このサーバーの種類とバージョンに合うものを探す */
    async search(headers: Headers, id: string, query: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      return fromModrinth(() => modrinth.search(query, p.platform, p.mcVersion));
    },

    /** 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新) */
    async install(headers: Headers, id: string, projectId: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      const file = await fromModrinth(() => modrinth.latestFile(projectId, p.platform, p.mcVersion));
      if (!file) throw new HttpError(404, "このサーバーの種類・バージョンに合う版がありません");
      const project = await fromModrinth(() => modrinth.project(projectId));
      const dir = PLATFORMS[p.platform].dir;

      await remote(() => client.pull(remoteId, file.url, dir, file.filename));

      const old = await db.select().from(installedMod)
        .where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, "modrinth"), eq(installedMod.projectId, projectId)));
      const stale = old.filter((o) => o.filename !== file.filename);
      if (stale.length) {
        await remote(() => client.deleteFiles(remoteId, dir, stale.map((o) => o.filename)));
        for (const o of stale) await db.delete(installedMod).where(eq(installedMod.id, o.id));
      }
      const values = {
        id: randomUUID(), serverId: row.id, source: "modrinth", projectId, versionId: file.versionId, versionNumber: file.versionNumber,
        title: project?.title || file.filename, filename: file.filename, installedBy: user.id, installedAt: new Date(),
      };
      const { id: _, ...update } = values;
      await db.insert(installedMod).values(values).onConflictDoUpdate({ target: [installedMod.serverId, installedMod.filename], set: update });
      return { filename: file.filename, versionNumber: file.versionNumber, replaced: stale.map((o) => o.filename) };
    },

    /** 外す(サーバーのフォルダーからファイルを消す) */
    async remove(headers: Headers, id: string, filename: string) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      const { row, client, remoteId } = await serverOf(deps, teamId, id);
      // フォルダーをまたぐ名前は受け付けず、いまフォルダーにある .jar だけを消す
      if (/[\\/]|^\.\.?$/.test(filename) || !filename.toLowerCase().endsWith(".jar")) throw new HttpError(400, "ファイルの名前が正しくありません");
      const p = await needProfile(row.id);
      const dir = PLATFORMS[p.platform].dir;
      const present = (await remote(() => client.listFiles(remoteId, dir))).some((f) => f.isFile && f.name === filename);
      if (!present) throw new HttpError(404, "ファイルが見つかりません");
      await remote(() => client.deleteFiles(remoteId, dir, [filename]));
      await db.delete(installedMod).where(and(eq(installedMod.serverId, row.id), eq(installedMod.filename, filename)));
    },

    /** このアプリで入れたものに、新しい版があるか */
    async updates(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, teamId, id);
      const p = await needProfile(row.id);
      const records = await db.select().from(installedMod).where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, "modrinth")));
      const out: { projectId: string; filename: string; current: string; latest: string }[] = [];
      for (const r of records) {
        const f = await fromModrinth(() => modrinth.latestFile(r.projectId, p.platform, p.mcVersion));
        if (f && f.versionId !== r.versionId) out.push({ projectId: r.projectId, filename: r.filename, current: r.versionNumber, latest: f.versionNumber });
      }
      return out;
    },
  };
}
