// アップロードしたアドオン(自分用の版だけ): 保存先の管理・アップロード(jar を調べてライブラリに載せる)・版の一覧・削除・ダウンロード。
// サーバーへ送るのは library.ts の installInto(Pterodactyl にはアップロード、フォルダのサーバーにはコピー)
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { PLATFORMS, type Platform, isPlatform } from "~/lib/platforms";
import { addonSetItem, backupSchedule, libraryFile, libraryItem, storageTarget, installedMod, server, serverProfile, teamOption, worldBackup } from "./db/schema";
import { CF_HOSTS } from "./curseforge";
import { eventService } from "./events";
import { HttpError, isHttpError, requireTeam } from "./guard";
import { remote, serverOf, worldOf } from "./servers";
import { analyzeJar, analyzePack, fileSource } from "./jar";
import { SAFE_FILE, pickVersion } from "./modrinth";
import { open, seal } from "./secrets";
import type { Deps } from "./servers";
import { type StorageConfig, StorageError, storeFor } from "./storage";

// fileBytes はアップロード 1 つの上限(v02 と同じ 1 GB。受け取るときはディスクに少しずつ書き、メモリに全部を載せない)。
// serverFileBytes はサーバーにある jar を取り込むときの上限(こちらも一時フォルダに少しずつ書く。エージェントのサーバーは AGENT_LIMITS.fileBytes まで)
export const UPLOAD_LIMITS = { fileBytes: 1024 * 1024 * 1024, serverFileBytes: 1024 * 1024 * 1024, targetsPerTeam: 10 };
type FileRow = typeof libraryFile.$inferSelect;
const sealContext = (teamId: string, id: string) => `storage:${teamId}:${id}`;
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "item";
const safeFilename = (name: string) => {
  const n = name.replace(/[^A-Za-z0-9._+\- ]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return SAFE_FILE.test(n) ? n : `upload-${Date.now()}${name.match(/\.(jar|zip|mrpack)$/i)?.[0].toLowerCase() ?? ".jar"}`;
};

export async function fromStorage<T>(fn: () => Promise<T>): Promise<T> {
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
  const { record } = eventService(deps);
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

  /** このサーバーの種類に合う版(新しい順)。kind = "datapack" ならデータパック(作りでは絞らない) */
  async function choices(teamId: string, projectId: string, platform: Platform, kind?: "datapack") {
    const [item] = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, "upload"), eq(libraryItem.projectId, projectId)));
    if (!item || item.projectType !== (kind ?? PLATFORMS[platform].type)) return { item, files: [] };
    const want: readonly string[] = kind ? [] : PLATFORMS[platform].loaders;
    const files = (await db.select().from(libraryFile).where(eq(libraryFile.itemId, item.id)).orderBy(desc(libraryFile.createdAt)))
      .map((f) => ({ ...f, loaders: JSON.parse(f.loaders) as string[], date_published: f.createdAt.toISOString() }))
      .filter((f) => !want.length || !f.loaders.length || f.loaders.some((l) => want.includes(l))); // 調べられなかったものは、種類が合えば使う
    return { item, files };
  }

  /** このサーバーの種類に合う、いちばん新しい版(無ければ null) */
  async function pick(teamId: string, projectId: string, platform: Platform, kind?: "datapack") {
    const { item, files } = await choices(teamId, projectId, platform, kind);
    const f = pickVersion(files, kind ? [] : PLATFORMS[platform].loaders);
    return item && f ? { item, file: f as unknown as FileRow } : null;
  }

  const read = async (teamId: string, f: FileRow) => fromStorage(async () => (await storeOf(teamId, f.targetId)).get(f.storageKey));
  const stream = async (teamId: string, f: FileRow) => fromStorage(async () => (await storeOf(teamId, f.targetId)).read(f.storageKey));
  const tempPath = (what: string) => {
    if (!deps.local) throw new HttpError(400, "アップロードしたアドオンは、自分用の版だけで使えます");
    const dir = join(deps.local.dataDir, "v03", "tmp");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${what}-${randomUUID()}.part`);
  };
  /** 保存先のファイルを、パネルの一時フォルダに少しずつ写して fn に渡す(終わったら消す。大きいファイルをメモリに載せずにサーバーへ送るため) */
  async function withTemp<T>(teamId: string, f: FileRow, fn: (path: string) => Promise<T>): Promise<T> {
    const tmp = tempPath("send");
    try {
      await pipeline(await stream(teamId, f), createWriteStream(tmp));
      return await fn(tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const activeOf = async (teamId: string) => (await db.select().from(storageTarget).where(and(eq(storageTarget.teamId, teamId), eq(storageTarget.active, true))))[0] ?? null;
  const optionOf = async (teamId: string) => (await db.select({ keepFiles: teamOption.keepFiles, keepVersions: teamOption.keepVersions }).from(teamOption)
    .where(eq(teamOption.teamId, teamId)))[0] ?? { keepFiles: false, keepVersions: 0 };
  const itemBy = async (teamId: string, source: string, projectId: string) =>
    (await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, source), eq(libraryItem.projectId, projectId))))[0] ?? null;

  /** 配布元のファイルを保存先に保存するか(アイテムの設定、無ければチームの既定。自分用の版だけ) */
  async function keepOf(teamId: string, source: string, projectId: string) {
    if (!deps.local || source === "upload") return false;
    const i = await itemBy(teamId, source, projectId);
    if (i?.keepFiles === "on" || i?.keepFiles === "off") return i.keepFiles === "on";
    return (await optionOf(teamId)).keepFiles;
  }

  /** 配布元の版を保存したもの(無ければ null) */
  async function savedOf(teamId: string, source: string, projectId: string, versionId: string) {
    const i = await itemBy(teamId, source, projectId);
    if (!i || !versionId) return null;
    return (await db.select().from(libraryFile).where(and(eq(libraryFile.itemId, i.id), eq(libraryFile.upstreamVersionId, versionId))))[0] ?? null;
  }

  /** 保存した版(配布元のもの)のうち、このサーバーの種類に合うもの(新しい順。配布元につながらない・版が消えたときにも入れられるように) */
  async function savedAll(teamId: string, source: string, projectId: string, platform: Platform, kind?: "datapack") {
    const i = await itemBy(teamId, source, projectId);
    if (!i) return [];
    const want: readonly string[] = kind ? [] : PLATFORMS[platform].loaders;
    const ext = kind ? /.zip$/i : /.jar$/i;
    const rows = await db.select().from(libraryFile).where(and(eq(libraryFile.itemId, i.id), ne(libraryFile.upstreamVersionId, ""))).orderBy(desc(libraryFile.createdAt));
    return rows.filter((f) => ext.test(f.filename)).filter((f) => {
      const loaders = JSON.parse(f.loaders) as string[];
      return !want.length || !loaders.length || loaders.some((l) => want.includes(l)); // 調べられなかったものは、種類が合えば使う
    });
  }

  /**
   * 配布元の版のファイルを取ってきて、保存先(使っている保存先か targetId)に保存する(自分用の版だけ)。
   * 取ってくるのは配布元の CDN からだけ(転送も CDN の中だけ)、パネルの一時フォルダに少しずつ書く。保存してあれば、それを返す
   */
  async function saveUpstream(teamId: string, userId: string | null, item: typeof libraryItem.$inferSelect,
    file: { versionId: string; versionNumber: string; filename: string; url: string }, opts: { targetId?: string | null } = {}) {
    if (!deps.local) throw new HttpError(400, "配布元のファイルの保存は、自分用の版だけで使えます");
    const have = await savedOf(teamId, item.source, item.projectId, file.versionId);
    if (have) return have;
    if (!file.url || !SAFE_FILE.test(file.filename)) throw new HttpError(400, "この版は、配布元からファイルを取ってこられません");
    const dir = join(deps.local.dataDir, "v03", "tmp");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `save-${randomUUID()}.part`);
    try {
      await downloadTo(deps.fetch, file.url, tmp);
      return await keepSaved(teamId, userId, item, tmp, file, opts.targetId);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** 一時フォルダのファイル(配布元の版そのもの)を、保存した版として保存先に置く(同じ中身があればそれを返す) */
  async function keepSaved(teamId: string, userId: string | null, item: typeof libraryItem.$inferSelect, tmp: string,
    file: { versionId: string; versionNumber: string; filename: string }, target?: string | null) {
    const src = fileSource(tmp);
    let info;
    try {
      info = /\.jar$/i.test(file.filename) ? analyzeJar(src, file.filename) : analyzePack(src, file.filename);
    } finally {
      src.close();
    }
    const sha256 = await sha256Of(tmp);
    const same = (await db.select().from(libraryFile).where(and(eq(libraryFile.itemId, item.id), eq(libraryFile.sha256, sha256))))[0];
    if (same) return same;
    const targetId = target !== undefined ? target : (await activeOf(teamId))?.id ?? null;
    const fileId = randomUUID();
    const filename = safeFilename(file.filename);
    const key = `${item.projectType}/${slug(item.title)}/${fileId.slice(0, 8)}-${filename}`;
    await fromStorage(async () => (await storeOf(teamId, targetId)).putFile(key, tmp));
    const [row] = await db.insert(libraryFile).values({
      id: fileId, itemId: item.id, targetId, storageKey: key, filename, size: statSync(tmp).size, sha256, version: file.versionNumber || info.version,
      loaders: JSON.stringify(info.loaders), mcVersions: JSON.stringify(info.mcVersions), uploadedBy: userId, upstreamVersionId: file.versionId,
    }).returning();
    await record({ teamId, userId, kind: "changes", action: "配布元の版を保存", target: item.title, detail: file.versionNumber || file.filename });
    await prune(teamId, item.id, userId);
    return row;
  }

  /** 消さない版(サーバーに入っている版・セットで固定した版の ID。アップロードしたものはファイルの ID、配布元のものは配布元の版の ID) */
  async function keptVersions(teamId: string, item: { id: string; source: string; projectId: string }) {
    const used = await db.select({ v: installedMod.versionId }).from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id))
      .where(and(eq(server.teamId, teamId), eq(installedMod.source, item.source), eq(installedMod.projectId, item.projectId)));
    const pinned = await db.select({ v: addonSetItem.versionId }).from(addonSetItem).where(and(eq(addonSetItem.itemId, item.id), isNotNull(addonSetItem.versionId)));
    return new Set([...used.map((r) => r.v), ...pinned.map((r) => r.v!)]);
  }

  /**
   * 保存先のファイルを消す。v02 から取り込んだ保存先(v02 と同じ場所を指す)のファイルは、保存先には触らない
   * (コピーせずに指しているだけなので、消すと v02 のライブラリからも無くなる。記録だけ消す)
   */
  async function removeStored(teamId: string, f: FileRow) {
    if (f.targetId) {
      const [t] = await db.select({ v02: storageTarget.v02 }).from(storageTarget).where(and(eq(storageTarget.id, f.targetId), eq(storageTarget.teamId, teamId)));
      if (t?.v02) return;
    }
    await (await storeOf(teamId, f.targetId)).remove(f.storageKey);
  }

  /** 版を消す(保存先のファイルも。保存先につながらなくても記録は消す) */
  async function dropFile(teamId: string, f: FileRow) {
    try {
      await removeStored(teamId, f);
    } catch { /* ファイルは保存先に残る(保存先の中身の一覧に「記録の無いもの」として出る) */ }
    await db.delete(libraryFile).where(eq(libraryFile.id, f.id));
  }

  /**
   * 古い版の整理: アイテムの「残す数」(無ければチームの既定。0 は整理しない)を超えた古い版を、保存先からも消す。
   * サーバーに入っている版・セットで固定した版は残す。消したものの名前を返す
   */
  async function prune(teamId: string, itemId: string, userId: string | null) {
    const [item] = await db.select().from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
    if (!item) return [];
    const keep = item.keepVersions ?? (await optionOf(teamId)).keepVersions;
    if (!(keep > 0)) return [];
    const old = (await db.select().from(libraryFile).where(eq(libraryFile.itemId, itemId)).orderBy(desc(libraryFile.createdAt))).slice(keep);
    if (!old.length) return [];
    const kept = await keptVersions(teamId, item);
    const removed: string[] = [];
    for (const f of old.filter((x) => !kept.has(x.upstreamVersionId || x.id))) {
      await dropFile(teamId, f);
      removed.push(f.version || f.filename);
    }
    if (removed.length) await record({ teamId, userId, kind: "changes", action: "古い版を整理", target: item.title, detail: removed.join("、") });
    return removed;
  }

  return { storeOf, pick, choices, read, stream, withTemp, tempPath, configOf, defaultConfig, activeOf, optionOf, keepOf, savedOf, savedAll, saveUpstream, keepSaved, prune, keptVersions, dropFile, removeStored };
}

export async function sha256Of(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// 配布元のファイルを取ってくる先(配布元の CDN だけ。SpigotMC は spiget の転送の先も)
const SAVE_HOSTS = new Set(["cdn.modrinth.com", "api.spiget.org", "cdn.spiget.org", ...CF_HOSTS]);

/** 配布元の CDN から、ファイルに少しずつ書く(転送は CDN の中だけ・3 回まで。UPLOAD_LIMITS.fileBytes を超えたらやめる) */
export async function downloadTo(fetch: Deps["fetch"], url: string, path: string) {
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new HttpError(502, "配布元のファイルの場所が正しくありません");
    }
    if (u.protocol !== "https:" || !SAVE_HOSTS.has(u.host)) throw new HttpError(502, "配布元の外のファイルは取ってきません");
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30 * 60_000) });
    } catch {
      throw new HttpError(502, "配布元からファイルを取ってこられませんでした");
    }
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (to) {
      url = new URL(to, url).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new HttpError(502, `配布元からファイルを取ってこられませんでした(HTTP ${res.status})`);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > UPLOAD_LIMITS.fileBytes ? new HttpError(400, `ファイルは ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB までです`) : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as WebStream<Uint8Array>), limit, createWriteStream(path));
    } catch (e) {
      if (isHttpError(e)) throw e;
      throw new HttpError(502, "配布元からファイルを取ってこられませんでした(途中で切れました)");
    }
    return;
  }
  throw new HttpError(502, "配布元からファイルを取ってこられませんでした(転送が多すぎます)");
}

export function uploadService(deps: Deps) {
  const { db, auth, secret } = deps;
  const { storeOf, stream, tempPath, configOf, activeOf, prune, removeStored } = fileStore(deps);
  const { record } = eventService(deps);
  const needLocal = () => {
    if (!deps.local) throw new HttpError(400, "アップロードしたアドオンは、自分用の版だけで使えます");
  };

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
      const { teamId } = await requireTeam(auth, headers, { storage: ["manage"] });
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
      const { teamId, user } = await requireTeam(auth, headers, { storage: ["manage"] });
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
      const { teamId, user } = await requireTeam(auth, headers, { storage: ["manage"] });
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
      const { teamId, user } = await requireTeam(auth, headers, { storage: ["manage"] });
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
      // v02 から取り込んだ保存先からは、写すだけ(元は v02 も使っているので消さない)
      const keepSrc = !!from && !!(await db.select({ id: storageTarget.id }).from(storageTarget).where(and(eq(storageTarget.id, from), eq(storageTarget.v02, true)))).length;
      let moved = 0;
      const failed: { filename: string; message: string }[] = [];
      for (const { f } of rows) {
        try {
          const data = await src.get(f.storageKey);
          await dst.put(f.storageKey, data);
          const back = await dst.get(f.storageKey);
          if (createHash("sha256").update(back).digest("hex") !== f.sha256) throw new StorageError("移した先の中身が元と違います");
          await db.update(libraryFile).set({ targetId: to }).where(eq(libraryFile.id, f.id));
          if (!keepSrc) await src.remove(f.storageKey).catch(() => {}); // 元が消せなくても、移した先は使える
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
      const { teamId, user } = await requireTeam(auth, headers, { storage: ["manage"] });
      const [t] = await db.select().from(storageTarget).where(and(eq(storageTarget.id, id), eq(storageTarget.teamId, teamId)));
      if (!t) throw new HttpError(404, "保存先が見つかりません");
      const used = await db.select({ id: libraryFile.id }).from(libraryFile).where(eq(libraryFile.targetId, id)).limit(1);
      if (used.length) throw new HttpError(400, "この保存先にはファイルが残っているので消せません");
      // バックアップの置き場所に選んでいる保存先を消すと、置いたバックアップが一覧から見えなくなる(消すと、置き場所が「パネルの中」に戻るため)
      const [bk] = await db.select({ id: backupSchedule.teamId }).from(backupSchedule).where(and(eq(backupSchedule.teamId, teamId), eq(backupSchedule.targetId, id)));
      if (bk) throw new HttpError(400, "パネルのバックアップの置き場所に使っているので消せません(先に置き場所を変えてください)");
      const [wb] = await db.select({ id: worldBackup.serverId }).from(worldBackup).innerJoin(server, eq(worldBackup.serverId, server.id))
        .where(and(eq(server.teamId, teamId), eq(worldBackup.targetId, id))).limit(1);
      if (wb) throw new HttpError(400, "ワールドのバックアップの置き場所に使っているので消せません(先に置き場所を変えてください)");
      await db.delete(storageTarget).where(eq(storageTarget.id, id));
      await record({ teamId, userId: user.id, kind: "admin", action: "保存先を消す", target: t.name });
    },

    /**
     * アップロードの本文を、パネルの一時フォルダに少しずつ書いてから取り込む(上限を超えたらそこでやめる)。
     * 書く前に権限を確かめる(ログインしていない人に、ディスクへ書かせない)
     */
    async receive(headers: Headers, filename: string, body: WebStream<Uint8Array> | null) {
      await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      if (!body) throw new HttpError(400, "ファイルが空です");
      const dir = join(deps.local!.dataDir, "v03", "tmp");
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `upload-${randomUUID()}.part`);
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          done(size > UPLOAD_LIMITS.fileBytes ? new HttpError(400, `ファイルは ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB までです`) : null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(body), limit, createWriteStream(tmp));
        return await this.ingest(headers, filename, tmp);
      } catch (e) {
        if (isHttpError(e)) throw e;
        throw new HttpError(400, "ファイルを受け取れませんでした(途中で切れました)");
      } finally {
        rmSync(tmp, { force: true });
      }
    },

    /**
     * アップロードを受け取る(data は中身か、一時フォルダのファイルの場所)。jar を調べ、同じ種類・同じ名前のものがライブラリにあればその新しい版として、無ければ新しく載せる。
     * 同じ中身のファイルは 2 度入れない。targetId を渡すと、その保存先に置く(保存先から取り込むとき)
     */
    async ingest(headers: Headers, filename: string, data: Uint8Array | string, opts: { targetId?: string | null } = {}) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      const size = typeof data === "string" ? statSync(data).size : data.byteLength;
      if (size > UPLOAD_LIMITS.fileBytes) throw new HttpError(400, `ファイルは ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB までです`);
      if (!/\.(jar|zip|mrpack)$/i.test(filename)) throw new HttpError(400, "アップロードできるのは .jar・.zip・.mrpack のファイルだけです");
      // jar はプラグイン・Mod、zip・mrpack はデータパック・リソースパック・シェーダー・Modパック
      const jar = /\.jar$/i.test(filename);
      const analyze = (src: Parameters<typeof analyzeJar>[0]) => (jar ? analyzeJar(src, filename) : analyzePack(src, filename));
      let info;
      if (typeof data === "string") {
        const src = fileSource(data);
        try {
          info = analyze(src);
        } finally {
          src.close();
        }
      } else info = analyze(data);
      if (!info.projectType) {
        throw new HttpError(400, jar ? `${filename} はプラグイン・Mod として読めませんでした(plugin.yml・fabric.mod.json などがありません)`
          : `${filename} はデータパック・リソースパック・シェーダー・Modパックとして読めませんでした(pack.mcmeta・shaders/・modrinth.index.json などがありません)`);
      }
      const hash = createHash("sha256");
      if (typeof data === "string") for await (const chunk of createReadStream(data)) hash.update(chunk as Buffer);
      else hash.update(data);
      const sha256 = hash.digest("hex");
      const dup = await db.select({ title: libraryItem.title }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryItem.teamId, teamId), eq(libraryFile.sha256, sha256))).limit(1);
      if (dup.length) throw new HttpError(400, `${filename} は、もう「${dup[0].title}」として登録しています`);

      const items = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, "upload"), eq(libraryItem.projectType, info.projectType)));
      let item = items.find((i) => i.title.toLowerCase() === info.name.toLowerCase());
      if (!item) {
        const [row] = await db.insert(libraryItem).values({ id: randomUUID(), teamId, source: "upload", projectId: randomUUID().replace(/-/g, "").slice(0, 16), title: info.name, projectType: info.projectType, addedBy: user.id }).returning();
        item = row;
      }
      const targetId = opts.targetId !== undefined ? opts.targetId : (await activeOf(teamId))?.id ?? null;
      const fileId = randomUUID();
      const key = `${info.projectType}/${slug(info.name)}/${fileId.slice(0, 8)}-${safeFilename(filename)}`;
      await fromStorage(async () => {
        const store = await storeOf(teamId, targetId);
        await (typeof data === "string" ? store.putFile(key, data) : store.put(key, data));
      });
      await db.insert(libraryFile).values({
        id: fileId, itemId: item.id, targetId, storageKey: key, filename: safeFilename(filename), size, sha256,
        version: info.version, loaders: JSON.stringify(info.loaders), mcVersions: JSON.stringify(info.mcVersions), uploadedBy: user.id,
      });
      await record({ teamId, userId: user.id, kind: "changes", action: "アップロード", target: info.name, detail: `${info.version || filename}(${info.loaders.join("・") || "種類不明"})` });
      await prune(teamId, item.id, user.id);
      return { itemId: item.id, projectId: item.projectId, fileId, title: info.name, version: info.version, projectType: info.projectType, loaders: info.loaders };
    },

    /**
     * サーバーにある jar(配布元のわからないもの)を、アップロードしたものとしてライブラリに取り込み、
     * このアプリで入れたものとして記録する(編集者以上・自分用の版だけ)
     */
    async fromServer(headers: Headers, serverId: string, filename: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      if (/[\\/]/.test(filename) || !/\.(jar|zip)(\.disabled)?$/i.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
      const { row, client, remoteId } = await serverOf(deps, who, serverId);
      const [p] = await db.select().from(serverProfile).where(eq(serverProfile.serverId, row.id));
      if (!p || !isPlatform(p.platform)) throw new HttpError(400, "先にサーバーの種類を選んでください");
      // .zip はワールドのデータパック(<level-name>/datapacks/)
      const dir = /\.zip(\.disabled)?$/i.test(filename) ? `${await remote(() => worldOf(client, remoteId))}/datapacks` : PLATFORMS[p.platform].dir;
      // 一時フォルダに少しずつ書いてから取り込む(大きい jar をメモリに載せない)
      const tmp = tempPath("server");
      let r;
      try {
        await remote(() => client.readToFile(remoteId, `${dir}/${filename}`, UPLOAD_LIMITS.serverFileBytes, tmp));
        r = await this.ingest(headers, filename.replace(/\.disabled$/i, ""), tmp); // 無効にしたものも取り込む
      } finally {
        rmSync(tmp, { force: true });
      }
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
      return rows.map((f) => ({ id: f.id, filename: f.filename, version: f.version, size: f.size, loaders: JSON.parse(f.loaders) as string[], createdAt: f.createdAt.toISOString(),
        saved: !!f.upstreamVersionId })); // saved = 配布元の版を保存したもの
    },

    /** 版を消す(保存先のファイルも消す。サーバーに入っているものはそのまま) */
    async removeFile(headers: Headers, fileId: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const [r] = await db.select({ f: libraryFile, title: libraryItem.title }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryFile.id, fileId), eq(libraryItem.teamId, teamId)));
      if (!r) throw new HttpError(404, "見つかりません");
      await fromStorage(() => removeStored(teamId, r.f));
      await db.delete(libraryFile).where(eq(libraryFile.id, fileId));
      await record({ teamId, userId: user.id, kind: "changes", action: "アップロードした版を消す", target: r.title, detail: r.f.filename });
    },

    /** ダウンロード(チームのメンバー)。大きいものもあるので、保存先から少しずつ読んで返す */
    async download(headers: Headers, fileId: string) {
      const { teamId } = await requireTeam(auth, headers);
      const [r] = await db.select({ f: libraryFile }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryFile.id, fileId), eq(libraryItem.teamId, teamId)));
      if (!r) throw new HttpError(404, "見つかりません");
      return { filename: r.f.filename, size: r.f.size, stream: await stream(teamId, r.f) };
    },
  };
}
