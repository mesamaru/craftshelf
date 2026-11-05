// アップロードしたアドオン(自分用の版だけ): 保存先の管理・アップロード(jar を調べてライブラリに載せる)・版の一覧・削除・ダウンロード。
// サーバーへ送るのは library.ts の installInto(Pterodactyl にはアップロード、フォルダのサーバーにはコピー)
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { PLATFORMS, type Platform, isPlatform } from "~/lib/platforms";
import { libraryFile, libraryItem, storageTarget, installedMod, serverProfile } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import { remote, serverOf } from "./servers";
import { analyzeJar } from "./jar";
import { SAFE_JAR, pickVersion } from "./modrinth";
import { open, seal } from "./secrets";
import type { Deps } from "./servers";
import { type StorageConfig, StorageError, storeFor } from "./storage";

export const UPLOAD_LIMITS = { fileBytes: 100 * 1024 * 1024, targetsPerTeam: 10 };
type FileRow = typeof libraryFile.$inferSelect;
const sealContext = (teamId: string, id: string) => `storage:${teamId}:${id}`;
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "item";
const safeFilename = (name: string) => {
  const n = name.replace(/[^A-Za-z0-9._+\- ]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return SAFE_JAR.test(n) ? n : `upload-${Date.now()}.jar`;
};

async function fromStorage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StorageError) throw new HttpError(502, e.message);
    throw e;
  }
}

// 保存先を開く・ファイルを選ぶ(ライブラリ・セットから使う。権限の確認は呼ぶ側で行う)
export function fileStore(deps: Deps) {
  const { db, secret, fetch } = deps;
  const defaultConfig = (): StorageConfig => {
    if (!deps.local) throw new HttpError(400, "アップロードしたアドオンは、自分用の版だけで使えます");
    return { kind: "local", path: join(deps.local.dataDir, "v03", "library") };
  };
  const configOf = (t: typeof storageTarget.$inferSelect) => JSON.parse(open(secret, t.configSealed, sealContext(t.teamId, t.id))) as StorageConfig;

  /** ファイルの保存先(targetId が null なら、パネルの中の既定のフォルダ) */
  async function storeOf(teamId: string, targetId: string | null) {
    if (!targetId) return storeFor(defaultConfig(), fetch);
    const [t] = await db.select().from(storageTarget).where(and(eq(storageTarget.id, targetId), eq(storageTarget.teamId, teamId)));
    if (!t) throw new HttpError(404, "保存先が見つかりません");
    return storeFor(configOf(t), fetch);
  }

  /** このサーバーの種類に合う版(新しい順) */
  async function choices(teamId: string, projectId: string, platform: Platform) {
    const [item] = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, "upload"), eq(libraryItem.projectId, projectId)));
    if (!item || item.projectType !== PLATFORMS[platform].type) return { item, files: [] };
    const want = PLATFORMS[platform].loaders as readonly string[];
    const files = (await db.select().from(libraryFile).where(eq(libraryFile.itemId, item.id)).orderBy(desc(libraryFile.createdAt)))
      .map((f) => ({ ...f, loaders: JSON.parse(f.loaders) as string[], date_published: f.createdAt.toISOString() }))
      .filter((f) => !f.loaders.length || f.loaders.some((l) => want.includes(l))); // 調べられなかったものは、種類が合えば使う
    return { item, files };
  }

  /** このサーバーの種類に合う、いちばん新しい版(無ければ null) */
  async function pick(teamId: string, projectId: string, platform: Platform) {
    const { item, files } = await choices(teamId, projectId, platform);
    const f = pickVersion(files, PLATFORMS[platform].loaders);
    return item && f ? { item, file: f as unknown as FileRow } : null;
  }

  const read = async (teamId: string, f: FileRow) => fromStorage(async () => (await storeOf(teamId, f.targetId)).get(f.storageKey));
  return { storeOf, pick, choices, read, configOf, defaultConfig };
}

export function uploadService(deps: Deps) {
  const { db, auth, secret } = deps;
  const { storeOf, read, configOf } = fileStore(deps);
  const { record } = eventService(deps);
  const needLocal = () => {
    if (!deps.local) throw new HttpError(400, "アップロードしたアドオンは、自分用の版だけで使えます");
  };
  const activeOf = async (teamId: string) => (await db.select().from(storageTarget).where(and(eq(storageTarget.teamId, teamId), eq(storageTarget.active, true))))[0] ?? null;

  function cleanConfig(input: { kind: string; path?: string; url?: string; user?: string; password?: string; host?: string; share?: string; domain?: string }): { config: StorageConfig; summary: string } {
    if (input.kind === "local") {
      const path = String(input.path ?? "").trim();
      return { config: { kind: "local", path }, summary: path };
    }
    if (input.kind === "webdav") {
      const url = String(input.url ?? "").trim();
      return { config: { kind: "webdav", url, user: String(input.user ?? ""), password: String(input.password ?? "") }, summary: `${url}${input.user ? `(${input.user})` : ""}` };
    }
    if (input.kind === "smb") {
      const c = { kind: "smb" as const, host: String(input.host ?? "").trim(), share: String(input.share ?? "").trim(), path: String(input.path ?? "").trim(),
        user: String(input.user ?? ""), password: String(input.password ?? ""), domain: String(input.domain ?? "") };
      return { config: c, summary: `\\\\${c.host}\\${c.share}${c.path ? `\\${c.path.replace(/\//g, "\\")}` : ""}${c.user ? `(${c.user})` : ""}` };
    }
    throw new HttpError(400, "保存先の種類を選んでください");
  }

  return {
    /** 保存先の一覧(パスワードは返さない。見るのは管理者以上) */
    async targets(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      needLocal();
      const rows = await db.select().from(storageTarget).where(eq(storageTarget.teamId, teamId)).orderBy(storageTarget.createdAt);
      const active = rows.find((r) => r.active);
      return {
        targets: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, summary: r.summary, active: r.active })),
        usingDefault: !active,
      };
    },

    /** 保存先を足す。つながる・書き込めることを確かめてから保存し、これからのアップロードの保存先にする */
    async addTarget(headers: Headers, input: { name: string; kind: string; path?: string; url?: string; user?: string; password?: string; host?: string; share?: string; domain?: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      needLocal();
      const n = await db.select({ id: storageTarget.id }).from(storageTarget).where(eq(storageTarget.teamId, teamId));
      if (n.length >= UPLOAD_LIMITS.targetsPerTeam) throw new HttpError(400, `保存先は ${UPLOAD_LIMITS.targetsPerTeam} 個までです`);
      const { config, summary } = cleanConfig(input);
      await fromStorage(async () => storeFor(config, deps.fetch).test());
      const id = randomUUID();
      const name = String(input.name ?? "").trim().slice(0, 60) || { local: "フォルダ", webdav: "WebDAV", smb: "SMB" }[config.kind];
      await db.transaction(async (tx) => {
        await tx.update(storageTarget).set({ active: false }).where(eq(storageTarget.teamId, teamId));
        await tx.insert(storageTarget).values({ id, teamId, name, kind: config.kind, configSealed: seal(secret, JSON.stringify(config), sealContext(teamId, id)), summary, active: true });
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "保存先を足す", target: name, detail: summary });
      return { id };
    },

    /** これからのアップロードの保存先にする(id が null なら、パネルの中の既定のフォルダ)。いまあるファイルは動かさない */
    async activate(headers: Headers, id: string | null) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      needLocal();
      if (id) {
        const [t] = await db.select().from(storageTarget).where(and(eq(storageTarget.id, id), eq(storageTarget.teamId, teamId)));
        if (!t) throw new HttpError(404, "保存先が見つかりません");
        await fromStorage(async () => storeFor(configOf(t), deps.fetch).test());
      }
      await db.transaction(async (tx) => {
        await tx.update(storageTarget).set({ active: false }).where(eq(storageTarget.teamId, teamId));
        if (id) await tx.update(storageTarget).set({ active: true }).where(eq(storageTarget.id, id));
      });
      await record({ teamId, userId: user.id, kind: "admin", action: "保存先を切り替える" });
    },

    /**
     * 保存先のファイルを、別の保存先へ移す(null はパネルの中の既定のフォルダ)。1 つずつ、移した先で中身を確かめてから元を消す。
     * 失敗したものは元の保存先に残し、理由を返す
     */
    async moveFiles(headers: Headers, from: string | null, to: string | null) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      needLocal();
      if (from === to) throw new HttpError(400, "移す先を、移す元と別の保存先にしてください");
      for (const id of [from, to]) {
        if (id && !(await db.select({ id: storageTarget.id }).from(storageTarget).where(and(eq(storageTarget.id, id), eq(storageTarget.teamId, teamId)))).length) {
          throw new HttpError(404, "保存先が見つかりません");
        }
      }
      const rows = await db.select({ f: libraryFile }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryItem.teamId, teamId), from ? eq(libraryFile.targetId, from) : isNull(libraryFile.targetId)));
      const src = await storeOf(teamId, from);
      const dst = await storeOf(teamId, to);
      let moved = 0;
      const failed: { filename: string; message: string }[] = [];
      for (const { f } of rows) {
        try {
          const data = await src.get(f.storageKey);
          await dst.put(f.storageKey, data);
          const back = await dst.get(f.storageKey);
          if (createHash("sha256").update(back).digest("hex") !== f.sha256) throw new StorageError("移した先の中身が元と違います");
          await db.update(libraryFile).set({ targetId: to }).where(eq(libraryFile.id, f.id));
          await src.remove(f.storageKey).catch(() => {}); // 元が消せなくても、移した先は使える
          moved++;
        } catch (e) {
          failed.push({ filename: f.filename, message: e instanceof Error ? e.message : "移せませんでした" });
        }
      }
      await record({ teamId, userId: user.id, kind: "admin", action: "保存先のファイルを移す", detail: `${moved} 個を移しました${failed.length ? `・${failed.length} 個は移せませんでした` : ""}` });
      return { moved, failed };
    },

    /** 保存先を消す(ファイルが残っているものは消せない) */
    async removeTarget(headers: Headers, id: string) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      const [t] = await db.select().from(storageTarget).where(and(eq(storageTarget.id, id), eq(storageTarget.teamId, teamId)));
      if (!t) throw new HttpError(404, "保存先が見つかりません");
      const used = await db.select({ id: libraryFile.id }).from(libraryFile).where(eq(libraryFile.targetId, id)).limit(1);
      if (used.length) throw new HttpError(400, "この保存先にはファイルが残っているので消せません");
      await db.delete(storageTarget).where(eq(storageTarget.id, id));
      await record({ teamId, userId: user.id, kind: "admin", action: "保存先を消す", target: t.name });
    },

    /**
     * アップロードを受け取る。jar を調べ、同じ種類・同じ名前のものがライブラリにあればその新しい版として、無ければ新しく載せる。
     * 同じ中身のファイルは 2 度入れない
     */
    async ingest(headers: Headers, filename: string, data: Uint8Array) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      if (data.byteLength > UPLOAD_LIMITS.fileBytes) throw new HttpError(400, `ファイルは ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB までです`);
      if (!/\.jar$/i.test(filename)) throw new HttpError(400, "アップロードできるのは .jar のファイルだけです");
      const info = analyzeJar(data, filename);
      if (!info.projectType) throw new HttpError(400, `${filename} はプラグイン・Mod として読めませんでした(plugin.yml・fabric.mod.json などがありません)`);
      const sha256 = createHash("sha256").update(data).digest("hex");
      const dup = await db.select({ title: libraryItem.title }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryItem.teamId, teamId), eq(libraryFile.sha256, sha256))).limit(1);
      if (dup.length) throw new HttpError(400, `${filename} は、もう「${dup[0].title}」として登録しています`);

      const items = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, "upload"), eq(libraryItem.projectType, info.projectType)));
      let item = items.find((i) => i.title.toLowerCase() === info.name.toLowerCase());
      if (!item) {
        const [row] = await db.insert(libraryItem).values({ id: randomUUID(), teamId, source: "upload", projectId: randomUUID().replace(/-/g, "").slice(0, 16), title: info.name, projectType: info.projectType, addedBy: user.id }).returning();
        item = row;
      }
      const active = await activeOf(teamId);
      const fileId = randomUUID();
      const key = `${info.projectType}/${slug(info.name)}/${fileId.slice(0, 8)}-${safeFilename(filename)}`;
      await fromStorage(async () => (await storeOf(teamId, active?.id ?? null)).put(key, data));
      await db.insert(libraryFile).values({
        id: fileId, itemId: item.id, targetId: active?.id ?? null, storageKey: key, filename: safeFilename(filename), size: data.byteLength, sha256,
        version: info.version, loaders: JSON.stringify(info.loaders), mcVersions: JSON.stringify(info.mcVersions), uploadedBy: user.id,
      });
      await record({ teamId, userId: user.id, kind: "changes", action: "アップロード", target: info.name, detail: `${info.version || filename}(${info.loaders.join("・") || "種類不明"})` });
      return { itemId: item.id, projectId: item.projectId, fileId, title: info.name, version: info.version, projectType: info.projectType, loaders: info.loaders };
    },

    /**
     * サーバーにある jar(配布元のわからないもの)を、アップロードしたものとしてライブラリに取り込み、
     * このアプリで入れたものとして記録する(編集者以上・自分用の版だけ)
     */
    async fromServer(headers: Headers, serverId: string, filename: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      if (/[\\/]/.test(filename) || !/\.jar$/i.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
      const { row, client, remoteId } = await serverOf(deps, who, serverId);
      const [p] = await db.select().from(serverProfile).where(eq(serverProfile.serverId, row.id));
      if (!p || !isPlatform(p.platform)) throw new HttpError(400, "先にサーバーの種類を選んでください");
      const dir = PLATFORMS[p.platform].dir;
      const data = await remote(() => client.readBytes(remoteId, `${dir}/${filename}`, UPLOAD_LIMITS.fileBytes));
      const r = await this.ingest(headers, filename, data);
      const values = { serverId: row.id, source: "upload", projectId: r.projectId, versionId: r.fileId, versionNumber: r.version || filename, title: r.title, filename, installedBy: who.user.id, installedAt: new Date() };
      await db.insert(installedMod).values({ id: randomUUID(), ...values }).onConflictDoUpdate({ target: [installedMod.serverId, installedMod.filename], set: values });
      return r;
    },

    /** アップロードしたものの版の一覧 */
    async files(headers: Headers, itemId: string) {
      const { teamId } = await requireTeam(auth, headers);
      const [item] = await db.select().from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
      if (!item) throw new HttpError(404, "見つかりません");
      const rows = await db.select().from(libraryFile).where(eq(libraryFile.itemId, itemId)).orderBy(desc(libraryFile.createdAt));
      return rows.map((f) => ({ id: f.id, filename: f.filename, version: f.version, size: f.size, loaders: JSON.parse(f.loaders) as string[], createdAt: f.createdAt.toISOString() }));
    },

    /** 版を消す(保存先のファイルも消す。サーバーに入っているものはそのまま) */
    async removeFile(headers: Headers, fileId: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const [r] = await db.select({ f: libraryFile, title: libraryItem.title }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryFile.id, fileId), eq(libraryItem.teamId, teamId)));
      if (!r) throw new HttpError(404, "見つかりません");
      await fromStorage(async () => (await storeOf(teamId, r.f.targetId)).remove(r.f.storageKey));
      await db.delete(libraryFile).where(eq(libraryFile.id, fileId));
      await record({ teamId, userId: user.id, kind: "changes", action: "アップロードした版を消す", target: r.title, detail: r.f.filename });
    },

    /** ダウンロード(チームのメンバー) */
    async download(headers: Headers, fileId: string) {
      const { teamId } = await requireTeam(auth, headers);
      const [r] = await db.select({ f: libraryFile }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryFile.id, fileId), eq(libraryItem.teamId, teamId)));
      if (!r) throw new HttpError(404, "見つかりません");
      return { filename: r.f.filename, data: await read(teamId, r.f) };
    },
  };
}
