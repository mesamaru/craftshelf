// サーバーの Mod・プラグイン: 一覧・配布元(Modrinth・SpigotMC)での検索・入れる(更新を含む)・外す。
// ファイルはこのアプリを通さず、Pterodactyl に配布元から直接取り込ませる
import { createHash, randomUUID } from "node:crypto";
import { cfFingerprint } from "./fingerprint";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { ITEM_TYPES, PLATFORMS, MC_VERSION, LOADERS, type Platform, isItemType, isPlatform, kindsOf, mcClean, mcCovers } from "~/lib/platforms";
import { installedMod, libraryItem, server, serverHold, serverProfile, user as userTable } from "./db/schema";
import { HttpError, isHttpError, requireTeam } from "./guard";
import { type Channel, type ItemSource, SOURCE_LABEL, isChannel, isItemSource, parseSourceUrl } from "~/lib/sources";
import { ModrinthError, type ProjectType, modrinthClient } from "./modrinth";
import { SpigetError, spigetClient } from "./spiget";
import { CF_KEY, CurseForgeError, curseforgeClient } from "./curseforge";
import { addonSetItem, installHistory, libraryDep, libraryFavorite, libraryFile, libraryTag, serverChange, serverSet, storageTarget, teamCurseforge, teamOption } from "./db/schema";
import { hint, open, seal } from "./secrets";
import { fileStore, uploadService } from "./uploads";
import { analyzeJar, jarKey } from "./jar";
import { eventService } from "./events";
import { jobService } from "./jobs";
import { type Deps, remote, serverOf, serverScope, worldOf } from "./servers";

// 無料で使える範囲
export const LIBRARY_LIMITS = { itemsPerTeam: 500 };
// タグの長さと、1 つに付けられる数
const TAG_MAX = 30;
const TAGS_PER_ITEM = 20;
// 配布元を中身から探すとき: 1 回に調べる数と、1 つの大きさの上限
const IDENTIFY_MAX = 100;
const IDENTIFY_BYTES = 100 * 1024 * 1024;
// 変更の履歴は 1 台につき新しい 30 件まで(古いものの、外して残したファイルも消す)
const CHANGES_KEPT = 30;
const REMOVED_SUFFIX = ".craftshelf-removed";
// 無効にしたもの(消さずに、名前の最後に .disabled を付けて止める)
const DISABLED = ".disabled";
export const isDisabled = (filename: string) => filename.toLowerCase().endsWith(DISABLED);
// サーバーのアドオン(無効にしたものを含む)。フォルダーをまたぐ名前は受け付けない。
// .jar はサーバーの種類のフォルダ(plugins・mods)、.zip はワールドのデータパック(<level-name>/datapacks/。03.58.00 から)
const ADDON = /^[^\\/]+\.(jar|zip)(\.disabled)?$/i;
const JAR = /\.jar(\.disabled)?$/i;
const DATAPACK = /\.zip(\.disabled)?(\.craftshelf-removed)?$/i;
export const isDatapackFile = (filename: string) => DATAPACK.test(filename);
// プラグインの設定フォルダの退避先(<dir>/.craftshelf-config/<key>/<フォルダ名>/)と、退避する大きさの上限
// shortcut: 1 ファイルずつ読んで送る(Pterodactyl でもフォルダのサーバーでも同じ操作で動くように)。大きいフォルダは退避しない
const CONFIG_DIR = ".craftshelf-config";
const CONFIG_LIMITS = { files: 100, bytes: 20 * 1024 * 1024, depth: 6 };
// 対応 MC を配布元から取り直す間隔と、1 回に取り直す数
const INFO_EVERY = 24 * 60 * 60_000;
// 前提の確かめの結果を覚えておく長さ(入っている版ごと。Mod の多いサーバーの画面を開くたびに配布元へ問い合わせないように)。このプロセスの中だけ
export const DEPS_MEMO_MS = 24 * 60 * 60_000;
const DEPS_MEMO_MAX = 5000;
const depsMemo = new Map<string, { at: number; value: unknown }>();
const memoGet = (key: string) => {
  const m = depsMemo.get(key);
  return m && Date.now() - m.at < DEPS_MEMO_MS ? m : undefined;
};
const memoSet = (key: string, value: unknown) => {
  if (depsMemo.size >= DEPS_MEMO_MAX) for (const [k, m] of depsMemo) if (Date.now() - m.at >= DEPS_MEMO_MS || depsMemo.size >= DEPS_MEMO_MAX) depsMemo.delete(k);
  depsMemo.set(key, { at: Date.now(), value });
};
const INFO_BATCH = 50;
// 前提の確かめの結果の 1 行(have に無いもの)。byKeys は使うものの "配布元:ID"
export type MissingDep = { source: ItemSource; projectId: string; title: string; iconUrl: string; itemId: string | null; by: string[]; byKeys: string[] };
const parseList = (s: string) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
};
// Modパックの、使った版と配布元のいちばん新しい版(library_item.pack。まだ使っていなければ null)
type PackVer = { id: string; number: string };
export type PackState = { used: PackVer | null; latest: PackVer | null };
export const packOf = (s: string): PackState | null => {
  try {
    const v = s ? JSON.parse(s) : null;
    return v && typeof v === "object" ? { used: v.used ?? null, latest: v.latest ?? null } : null;
  } catch {
    return null;
  }
};
type Removed = { filename: string; source?: string; projectId?: string; versionId?: string; versionNumber?: string; title?: string };

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
// kind = "datapack" なら、サーバーの種類ではなくデータパックとして(版の選び方・置き場所)
export type Profile = { platform: Platform; mcVersion: string | null; kind?: "datapack" };
/** この種類のアイテムを、このサーバーに入れるときの選び方(入れられない種類なら null) */
export function profileFor(p: Profile, type: string): Profile | null {
  const base = { platform: p.platform, mcVersion: p.mcVersion };
  if (type === PLATFORMS[p.platform].type) return base;
  return type === "datapack" && kindsOf(p.platform).includes("datapack") ? { ...base, kind: "datapack" } : null;
}
/** サーバーにあるファイルの選び方(.zip はデータパック) */
export const fileProfile = (p: Profile, filename: string): Profile =>
  isDatapackFile(filename) ? { platform: p.platform, mcVersion: p.mcVersion, kind: "datapack" } : { platform: p.platform, mcVersion: p.mcVersion };

// Mod・プラグインを扱う共通の処理(ライブラリ・セットで使う)。権限の確認は呼ぶ側で行う
export function modTools(deps: Deps) {
  const { db } = deps;
  const modrinth = modrinthClient(deps.fetch);
  const spiget = spigetClient(deps.fetch);

  const files = fileStore(deps);
  const local = !!deps.local;

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

  /**
   * ライブラリで決めた、入れる版の選び方(受け取る版・管理者が直した動く作りと対応 MC)。
   * 対応 MC を直していて、それがサーバーのバージョンを含むなら、配布元の対応 MC では絞らない(配布元の情報が古いとき)
   */
  async function pickOf(teamId: string, source: ItemSource, projectId: string, p: Profile) {
    const [i] = await db.select({ channel: libraryItem.channel, loaders: libraryItem.loaders, mc: libraryItem.mcVersions }).from(libraryItem)
      .where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, source), eq(libraryItem.projectId, projectId)));
    const channel: Channel = isChannel(i?.channel) ? i.channel
      : ((await db.select({ c: teamOption.channel }).from(teamOption).where(eq(teamOption.teamId, teamId)))[0]?.c === "all" ? "all" : "release");
    const loaders = i?.loaders ? parseList(i.loaders) : null;
    const mc = i?.mc ? parseList(i.mc) : null;
    // データパックは、Modrinth の作り datapack の版だけ(Mod としても出しているものがあるため)
    return { channel, loaders: p.kind ? ["datapack"] : loaders?.length ? loaders : undefined, type: p.kind, mcVersion: mc && p.mcVersion && mcCovers(mc, p.mcVersion) ? null : p.mcVersion };
  }
  /** Modパックの版(Modrinth・CurseForge の、ダウンロードできるもの。新しい順)と、受け取る版のとおりのいちばん新しいもの */
  async function packVersions(teamId: string, source: "modrinth" | "curseforge", projectId: string) {
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    const list = (await fromSource(() => (cf ? cf.allFiles(projectId) : modrinth.allVersions(projectId)))).filter((v) => v.url);
    const { channel } = await pickOf(teamId, source, projectId, { platform: "fabric", mcVersion: null }); // 受け取る版だけを使う
    return { list, latest: (channel === "all" ? list[0] : list.find((v) => v.type === "release") ?? list[0]) ?? null };
  }
  // 置くファイルの形(プラグイン・Mod は .jar、データパックは .zip)
  const fits = (p: Profile, filename: string) => (p.kind ? /\.zip$/i : /\.jar$/i).test(filename);

  // 配布元ごとの、入れる版・プロジェクトの名前。アップロードしたものは、保存先のファイル(upload)を返す
  async function latestFile(source: ItemSource, projectId: string, p: Profile, teamId: string) {
    if (source === "upload") {
      const r = await files.pick(teamId, projectId, p.platform, p.kind);
      if (!r) return null;
      const f = r.file;
      return { projectId, versionId: f.id, versionNumber: f.version || f.filename, filename: f.filename, url: "", sha512: "", size: f.size, upload: f, deps: [] as string[] };
    }
    if (source === "spigot" && p.kind) return null;
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    const { mcVersion, ...opts } = await pickOf(teamId, source, projectId, p);
    const f = await fromSource(() => (cf ? cf.latestFile(projectId, p.platform, mcVersion, opts)
      : source === "spigot" ? spiget.latestFile(projectId, p.platform) : modrinth.latestFile(projectId, p.platform, mcVersion, opts)));
    return f && fits(p, f.filename) ? { ...f, upload: undefined } : null;
  }
  // 保存した版を、入れるファイルの形にする(保存先から送る)
  const savedFile = (projectId: string, s: NonNullable<Awaited<ReturnType<typeof files.savedOf>>>) =>
    ({ projectId, versionId: s.upstreamVersionId, versionNumber: s.version || s.filename, filename: s.filename, url: "", sha512: "", size: s.size, upload: s, deps: [] as string[] });
  /** 入れる版(latestFile)。配布元につながらない・合う版が無いときは、保存した版のうち合ういちばん新しいものを使う(配布元が消えても入れられる) */
  async function latestOrSaved(source: ItemSource, projectId: string, p: Profile, teamId: string) {
    if (source === "upload") return latestFile(source, projectId, p, teamId);
    let err: HttpError | null = null;
    try {
      const f = await latestFile(source, projectId, p, teamId);
      if (f) return f;
    } catch (e) {
      if (!isHttpError(e)) throw e;
      err = e;
    }
    const s = deps.local ? await files.savedPick(teamId, source, projectId, p.platform, p.kind) : null;
    if (s) return savedFile(projectId, s);
    if (err) throw err;
    return null;
  }

  /** 置き場所(サーバーの種類のフォルダか、データパックならワールドの datapacks) */
  const dirOf = async (target: Target, p: Profile) =>
    p.kind ? `${await remote(() => worldOf(target.client, target.remoteId))}/datapacks` : PLATFORMS[p.platform].dir;
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
    try {
      const file = await fromSource(() => (cf ? cf.file(projectId, versionId) : modrinth.version(projectId, versionId)));
      if (file) return { ...file, upload: undefined };
    } catch (e) {
      const s = isHttpError(e) ? await files.savedOf(teamId, source, projectId, versionId) : null;
      if (s) return savedFile(projectId, s);
      throw e;
    }
    const s = await files.savedOf(teamId, source, projectId, versionId);
    return s ? savedFile(projectId, s) : null;
  }

  // このサーバーに入れられる版(新しい順)。SpigotMC は前の版を取ってこられないので空
  async function versionsOf(source: ItemSource, projectId: string, p: Profile, teamId: string) {
    if (source === "spigot") return [];
    if (source === "upload") {
      return (await files.choices(teamId, projectId, p.platform, p.kind)).files.slice(0, 30)
        .map((f) => ({ versionId: f.id, versionNumber: f.version || f.filename, date: f.date_published, release: true }));
    }
    const cf = source === "curseforge" ? await curseforge(teamId) : null;
    const { mcVersion, ...opts } = await pickOf(teamId, source, projectId, p);
    return (await fromSource(() => (cf ? cf.files(projectId, p.platform, mcVersion, opts) : modrinth.versions(projectId, p.platform, mcVersion, opts))))
      .filter((v) => fits(p, v.filename));
  }

  // 変更の履歴に残す(古いものは消し、外して残したファイルも消す。p はサーバーの種類。ファイルの置き場所を決めるのに使う)
  async function logChange(serverId: string, userId: string | null, c: { action: string; title: string; added?: string; removed?: Removed | null; backup?: string; config?: string }, target?: Target, p?: Profile) {
    await db.insert(serverChange).values({ id: randomUUID(), serverId, userId, action: c.action, title: c.title, added: c.added ?? "", removed: c.removed ? JSON.stringify(c.removed) : "", backup: c.backup ?? "", configBackup: c.config ?? "" });
    const old = await db.select().from(serverChange).where(eq(serverChange.serverId, serverId)).orderBy(desc(serverChange.at)).offset(CHANGES_KEPT);
    if (!old.length) return;
    if (target && p) {
      for (const q of [fileProfile(p, ".jar"), fileProfile(p, ".zip")]) {
        const backups = old.filter((o) => o.backup && !o.undone && !!q.kind === isDatapackFile(o.backup)).map((o) => o.backup);
        if (backups.length) await dirOf(target, q).then((dir) => remote(() => target.client.deleteFiles(target.remoteId, dir, backups))).catch(() => {});
      }
      const dir = PLATFORMS[p.platform].dir;
      const configs = old.filter((o) => o.configBackup).map((o) => o.configBackup.split("/")[0]);
      if (configs.length) await remote(() => target.client.deleteFiles(target.remoteId, `${dir}/${CONFIG_DIR}`, configs)).catch(() => {});
    }
    await db.delete(serverChange).where(inArray(serverChange.id, old.map((o) => o.id)));
  }

  // フォルダの中のファイル(相対パス)。隠しファイルは除く。数・大きさ・深さが上限を超えたら null
  async function walk(target: Target, base: string) {
    const out: { path: string; size: number }[] = [];
    let bytes = 0;
    const visit = async (rel: string, depth: number): Promise<boolean> => {
      for (const f of await target.client.listFiles(target.remoteId, rel ? `${base}/${rel}` : base)) {
        if (f.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${f.name}` : f.name;
        if (!f.isFile) {
          if (depth >= CONFIG_LIMITS.depth || !(await visit(path, depth + 1))) return false;
          continue;
        }
        out.push({ path, size: f.size });
        bytes += f.size;
        if (out.length > CONFIG_LIMITS.files || bytes > CONFIG_LIMITS.bytes) return false;
      }
      return true;
    };
    return (await visit("", 0)) ? out : null;
  }
  // from のフォルダの中身を to のフォルダへ写す(同じ名前のファイルは上書き)
  async function copyTree(target: Target, from: string, to: string, list: { path: string }[]) {
    for (const f of list) {
      const data = await target.client.readBytes(target.remoteId, `${from}/${f.path}`, CONFIG_LIMITS.bytes);
      const i = f.path.lastIndexOf("/");
      await target.client.upload(target.remoteId, i < 0 ? to : `${to}/${f.path.slice(0, i)}`, f.path.slice(i + 1), data);
    }
  }

  /**
   * プラグインの設定フォルダ(plugins/<plugin.yml の名前>/)を plugins/.craftshelf-config/<key>/ に写しておく(元に戻すときに戻す)。
   * 退避できないとき(Mod・フォルダが無い・大きすぎる・読めない)は "" を返し、入れ替える・外すはそのまま続ける
   */
  async function saveConfig(target: Target, p: Profile, jar: string) {
    if (p.kind || PLATFORMS[p.platform].type !== "plugin") return "";
    const dir = PLATFORMS[p.platform].dir;
    try {
      const name = analyzeJar(await target.client.readBytes(target.remoteId, `${dir}/${jar}`, IDENTIFY_BYTES), jar).name.toLowerCase();
      const folder = name ? (await target.client.listFiles(target.remoteId, dir)).find((f) => !f.isFile && f.name.toLowerCase() === name)?.name : undefined;
      if (!folder || folder.startsWith(".")) return "";
      const list = await walk(target, `${dir}/${folder}`);
      if (!list?.length) return "";
      const key = `${randomUUID().slice(0, 8)}/${folder}`;
      await copyTree(target, `${dir}/${folder}`, `${dir}/${CONFIG_DIR}/${key}`, list);
      return key;
    } catch {
      return "";
    }
  }
  // 退避した設定フォルダを、もとの場所へ戻す(戻せなければ false)
  async function restoreConfig(target: Target, p: Profile, key: string) {
    const dir = PLATFORMS[p.platform].dir;
    try {
      const list = await walk(target, `${dir}/${CONFIG_DIR}/${key}`);
      if (!list?.length) return false;
      await copyTree(target, `${dir}/${CONFIG_DIR}/${key}`, `${dir}/${key.split("/")[1]}`, list);
      return true;
    } catch {
      return false;
    }
  }

  /** 外す: 消さずに名前を変えて残し(変更の履歴から元に戻せる)、プラグインの設定フォルダも退避しておく。外したものの名前を返す */
  async function removeFrom(target: Target, server: Profile, userId: string | null, filename: string) {
    const p = fileProfile(server, filename);
    const dir = await dirOf(target, p);
    const backup = filename + REMOVED_SUFFIX;
    const config = await saveConfig(target, p, filename);
    // 同じ名前で残していたものは消す
    await remote(async () => {
      await target.client.deleteFiles(target.remoteId, dir, [backup]).catch(() => {});
      await target.client.rename(target.remoteId, dir, filename, backup);
    });
    const [rec] = await db.delete(installedMod).where(and(eq(installedMod.serverId, target.row.id), eq(installedMod.filename, filename))).returning();
    await logChange(target.row.id, userId, {
      action: "外す", title: rec?.title ?? filename, backup, config,
      removed: rec ? { filename, source: rec.source, projectId: rec.projectId, versionId: rec.versionId, versionNumber: rec.versionNumber, title: rec.title } : { filename },
    }, target, server);
    return rec?.title ?? filename;
  }

  // ファイルの見分ける名前(jarKey)。サーバー・場所・大きさが同じなら読み直さない(Pterodactyl はファイルを取ってくるので)
  const keyMemo = new Map<string, string>();
  /** dir に、filename と同じ名前(plugin.yml の name・Mod の id)の jar がほかのファイル名で入っていれば、その名前(skip は除く) */
  async function sameNamed(target: Target, dir: string, filename: string, skip: string[]) {
    const read = (name: string) => target.client.readBytes(target.remoteId, `${dir}/${name}`, IDENTIFY_BYTES).then(jarKey, () => "");
    const mine = await read(filename);
    if (!mine) return [];
    const out: string[] = [];
    for (const f of await remote(() => target.client.listFiles(target.remoteId, dir))) {
      if (!f.isFile || f.name === filename || skip.includes(f.name) || !/\.jar$/i.test(f.name)) continue; // 無効・外したものは読み込まれないので見ない
      const k = `${target.row.id}:${dir}/${f.name}:${f.size}`;
      let key = keyMemo.get(k);
      if (key === undefined) {
        key = await read(f.name);
        if (keyMemo.size >= 5000) keyMemo.clear();
        keyMemo.set(k, key);
      }
      if (key === mine) out.push(f.name);
    }
    return out;
  }

  type Installed = { title: string; filename: string; versionNumber: string; replaced: string[]; deps: { title: string; ok: boolean; detail: string }[] };

  /**
   * 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新。消した版は履歴に残す)。
   * Modrinth の前提(必須)で、まだ入っていないものも入れる(depth 段まで)。opts.file を渡すと、その版を入れる(前の版に戻すとき)
   */
  async function installInto(teamId: string, userId: string | null, target: Target, p: Profile, source: ItemSource, projectId: string,
    opts: { file?: Awaited<ReturnType<typeof fileById>>; depth?: number } = {}): Promise<Installed> {
    const { row, client, remoteId } = target;
    const first = opts.file ?? await latestOrSaved(source, projectId, p, teamId);
    if (!first) {
      throw new HttpError(404, source === "spigot"
        ? "このサーバーの種類で動く版がありません(SpigotMC の外で配っているもの・有料のものは入れられません)"
        : source === "upload" ? "このサーバーの種類で動く版が、アップロードしたものの中にありません"
        : source === "curseforge" ? "このサーバーの種類・バージョンに合う版がありません(外部からのダウンロードを許していない版は入れられません)"
        : "このサーバーの種類・バージョンに合う版がありません");
    }
    // 保存した版があれば、配布元から取らずに保存先から送る
    const saved = !first.upload && source !== "upload" && local ? await files.savedOf(teamId, source, projectId, first.versionId) : null;
    const file = saved ? { ...first, upload: saved } : first;
    const info = await project(source, projectId, teamId).catch(async (e) => {
      // 保存した版を送るときは、配布元につながらなくてもライブラリの名前で続ける
      const [i] = file.upload && isHttpError(e) ? await db.select().from(libraryItem)
        .where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, source), eq(libraryItem.projectId, projectId))) : [];
      if (!i) throw e;
      return { title: i.title, slug: i.slug, projectType: i.projectType as ProjectType, iconUrl: i.iconUrl };
    });
    const dir = await dirOf(target, p);
    const old = await db.select().from(installedMod)
      .where(and(eq(installedMod.serverId, row.id), eq(installedMod.source, source), eq(installedMod.projectId, projectId)));
    const stale = old.filter((o) => o.filename !== file.filename);
    // 入れ替えるときは、古い jar を消す前にプラグインの設定フォルダを退避しておく(元に戻すときに戻す)
    const config = stale.length ? await saveConfig(target, p, stale[0].filename) : "";

    // アップロードしたものは、保存先から読んでサーバーに送る。配布元のものは、サーバーに直接取り込ませる
    if (file.upload) {
      // 一時フォルダに少しずつ写してから送る(1 GB の jar もメモリに全部を載せない)
      await files.withTemp(teamId, file.upload, (path) => remote(() => client.upload(remoteId, dir, file.filename, path)));
    } else {
      await remote(() => client.pull(remoteId, file.url, dir, file.filename));
    }

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
    // 同じ名前のプラグイン・Mod が別のファイル名で入っていれば(手で置いたもの・ほかの配布元から入れたもの)外す。
    // Paper は同じ名前のものが 2 つあると読み込めない。外したものは「外す」と同じく、変更の履歴から元に戻せる
    const dupes = p.kind ? [] : await sameNamed(target, dir, file.filename, stale.map((o) => o.filename));
    for (const f of dupes) await removeFrom(target, p, userId, f);
    const values = {
      id: randomUUID(), serverId: row.id, source, projectId, versionId: file.versionId, versionNumber: file.versionNumber,
      title: info?.title || file.filename, filename: file.filename, installedBy: userId, installedAt: new Date(),
    };
    const { id: _, ...update } = values;
    await db.insert(installedMod).values(values).onConflictDoUpdate({ target: [installedMod.serverId, installedMod.filename], set: update });
    const was = stale[0];
    await logChange(row.id, userId, {
      action: stale.length ? "更新" : "入れる", title: values.title, added: file.filename, config,
      removed: was ? { filename: was.filename, source: was.source, projectId: was.projectId, versionId: was.versionId, versionNumber: was.versionNumber, title: was.title } : null,
    }, target, p);
    await remember(teamId, userId, source, projectId, {
      title: values.title, slug: info?.slug ?? "", iconUrl: info?.iconUrl ?? "",
      projectType: p.kind ?? PLATFORMS[p.platform].type, // 入れられたサーバーの種類(Modrinth は、プラグインでも Fabric などにも対応したものを "mod" と返す)
    });
    // 「保存する」にしているものは、配布元から入れた版を保存先にも取っておく(保存できなくても、入れたまま)
    if (!file.upload && await files.keepOf(teamId, source, projectId)) {
      const [item] = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, source), eq(libraryItem.projectId, projectId)));
      if (item) await files.saveUpstream(teamId, userId, item, file).catch((e) => console.error("[保存] 配布元の版を保存できませんでした:", e instanceof Error ? e.message : e));
    }

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
          if (!isHttpError(e)) throw e;
          deps.push({ title: dep, ok: false, detail: e.message });
        }
      }
    }
    return { title: values.title, filename: file.filename, versionNumber: file.versionNumber, replaced: [...stale.map((o) => o.filename), ...dupes], deps };
  }

  // 更新を止めているもの("配布元:ID" の集合)
  const holdsOf = async (serverId: string) =>
    new Set((await db.select().from(serverHold).where(eq(serverHold.serverId, serverId))).map((h) => `${h.source}:${h.projectId}`));

  // 結び付けたセットで版を固定しているもの("配布元:ID" → 版)。結び付けていないサーバーは空
  const pinsOf = async (serverId: string) =>
    new Map((await db.select({ source: libraryItem.source, projectId: libraryItem.projectId, versionId: addonSetItem.versionId, versionNumber: addonSetItem.versionNumber })
      .from(serverSet).innerJoin(addonSetItem, eq(addonSetItem.setId, serverSet.setId)).innerJoin(libraryItem, eq(addonSetItem.itemId, libraryItem.id))
      .where(and(eq(serverSet.serverId, serverId), isNotNull(addonSetItem.versionId))))
      .map((r) => [`${r.source}:${r.projectId}`, { versionId: r.versionId!, versionNumber: r.versionNumber }]));

  // チームのサーバーごとの、結び付けたセットで固定した版("サーバー:配布元:ID" → 版)
  const teamPinsOf = async (teamId: string) =>
    new Map((await db.select({ serverId: serverSet.serverId, source: libraryItem.source, projectId: libraryItem.projectId, versionNumber: addonSetItem.versionNumber })
      .from(serverSet).innerJoin(server, eq(serverSet.serverId, server.id)).innerJoin(addonSetItem, eq(addonSetItem.setId, serverSet.setId)).innerJoin(libraryItem, eq(addonSetItem.itemId, libraryItem.id))
      .where(and(eq(server.teamId, teamId), isNotNull(addonSetItem.versionId))))
      .map((r) => [`${r.serverId}:${r.source}:${r.projectId}`, r.versionNumber]));

  // このアプリで入れたものの新しい版(止めているもの・セットで版を固定しているもの・無効にしたものは確かめない)。skipFailed なら確かめられないものを飛ばす
  async function updatesOf(serverId: string, p: Profile, teamId: string, skipFailed = false) {
    const records = await db.select().from(installedMod).where(eq(installedMod.serverId, serverId));
    const holds = await holdsOf(serverId);
    const pins = await pinsOf(serverId);
    const out: { source: ItemSource; projectId: string; title: string; filename: string; current: string; latest: string }[] = [];
    for (const r of records) {
      if (!isItemSource(r.source) || holds.has(`${r.source}:${r.projectId}`) || pins.has(`${r.source}:${r.projectId}`) || isDisabled(r.filename)) continue;
      let f;
      try {
        f = await latestFile(r.source, r.projectId, fileProfile(p, r.filename), teamId);
      } catch (e) {
        if (skipFailed && isHttpError(e)) continue;
        throw e;
      }
      if (f && f.versionId !== r.versionId) out.push({ source: r.source, projectId: r.projectId, title: r.title, filename: r.filename, current: r.versionNumber, latest: f.versionNumber });
    }
    return out;
  }

  /** サーバーにあるアドオン(サーバーの種類のフォルダの .jar と、ワールドの datapacks の .zip。無効にしたものも) */
  async function addonsIn(target: Target, p: Profile) {
    const out: { name: string; size: number; dir: string; datapack: boolean }[] = [];
    for (const q of [fileProfile(p, ".jar"), ...(kindsOf(p.platform).includes("datapack") ? [fileProfile(p, ".zip")] : [])]) {
      const dir = await dirOf(target, q);
      for (const f of await remote(() => target.client.listFiles(target.remoteId, dir))) {
        if (f.isFile && ADDON.test(f.name) && (q.kind ? DATAPACK : JAR).test(f.name)) out.push({ name: f.name, size: f.size, dir, datapack: !!q.kind });
      }
    }
    return out;
  }

  /**
   * このアプリで入れていない jar・データパック(only を渡すとその名前だけ)の配布元を、中身から探す(Modrinth は SHA-1、CurseForge はフィンガープリント)。
   * 見つかったものは、このアプリで入れたものとして記録し、ライブラリにも載せる
   */
  async function identifyIn(teamId: string, userId: string, target: Target, p: Profile, only?: string) {
    const { row, client, remoteId } = target;
    const known = new Set((await db.select({ f: installedMod.filename }).from(installedMod).where(eq(installedMod.serverId, row.id))).map((r) => r.f));
    const unknown = (await addonsIn(target, p)).filter((f) => !known.has(f.name) && (!only || f.name === only)).slice(0, IDENTIFY_MAX);
    const hashes: { filename: string; sha1: string; fp: number }[] = [];
    for (const f of unknown) {
      const data = await remote(() => client.readBytes(remoteId, `${f.dir}/${f.name}`, IDENTIFY_BYTES));
      hashes.push({ filename: f.name, sha1: createHash("sha1").update(data).digest("hex"), fp: cfFingerprint(data) });
    }
    const mr = await fromSource(() => modrinth.byHashes(hashes.map((h) => h.sha1)));
    const key = await cfKeyOf(teamId);
    const rest = hashes.filter((h) => !mr.has(h.sha1)).map((h) => h.fp);
    const cf = key && rest.length ? await fromSource(() => curseforgeClient(deps.fetch, key).byFingerprints(rest)) : new Map();
    const found: { filename: string; title: string; source: ItemSource; versionNumber: string }[] = [];
    for (const h of hashes) {
      const m = mr.get(h.sha1);
      const c = cf.get(h.fp);
      const hit = m ? { source: "modrinth" as const, ...m } : c ? { source: "curseforge" as const, ...c } : null;
      if (!hit) continue;
      const info = await project(hit.source, hit.projectId, teamId).catch(() => null);
      const title = info?.title || h.filename;
      const values = { serverId: row.id, source: hit.source, projectId: hit.projectId, versionId: hit.versionId, versionNumber: hit.versionNumber, title, filename: h.filename, installedBy: userId, installedAt: new Date() };
      await db.insert(installedMod).values({ id: randomUUID(), ...values }).onConflictDoUpdate({ target: [installedMod.serverId, installedMod.filename], set: values });
      await remember(teamId, userId, hit.source, hit.projectId, { title, slug: info?.slug ?? "", iconUrl: info?.iconUrl ?? "", projectType: fileProfile(p, h.filename).kind ?? PLATFORMS[p.platform].type });
      found.push({ filename: h.filename, title, source: hit.source, versionNumber: hit.versionNumber });
    }
    return { checked: hashes.length, found, missing: hashes.filter((h) => !found.some((f) => f.filename === h.filename)).map((h) => h.filename), curseforge: !!key };
  }

  /**
   * 前提のうち have("配布元:ID")に無いもの。items は p のサーバーに入れる(入っている)もの。
   * 前提は、配布元の必須(Modrinth・CurseForge の、p のサーバーに入るいちばん新しい版のもの)と、ライブラリで手で決めたもの。
   * 配布元につながらなかったものは errors に。cache を渡すと、同じ問い合わせをまとめる(何台も確かめるとき)。
   * installed(サーバーに入っている版)を渡したものは、同じ版なら DEPS_MEMO_MS のあいだ結果を覚えておき、配布元に問い合わせない
   */
  async function missingOf(teamId: string, items: { source: string; projectId: string; title: string; installed?: string }[], p: Profile, have: Set<string>,
    cache = new Map<string, Promise<unknown>>()) {
    const need = new Map<string, { source: ItemSource; projectId: string; by: string[]; byKeys: string[] }>();
    const add = (source: ItemSource, projectId: string, it: { source: string; projectId: string; title: string }) => {
      const k = `${source}:${projectId}`;
      if (have.has(k)) return;
      const e = need.get(k) ?? { source, projectId, by: [], byKeys: [] };
      if (!e.byKeys.includes(`${it.source}:${it.projectId}`)) {
        e.by.push(it.title);
        e.byKeys.push(`${it.source}:${it.projectId}`);
      }
      need.set(k, e);
    };
    const lib = await db.select({ id: libraryItem.id, source: libraryItem.source, projectId: libraryItem.projectId, title: libraryItem.title, iconUrl: libraryItem.iconUrl })
      .from(libraryItem).where(eq(libraryItem.teamId, teamId));
    const byKey = new Map(lib.map((i) => [`${i.source}:${i.projectId}`, i]));
    const byId = new Map(lib.map((i) => [i.id, i]));
    const mine = items.map((it) => byKey.get(`${it.source}:${it.projectId}`)?.id).filter((x): x is string => !!x);
    const links = mine.length ? await db.select().from(libraryDep).where(inArray(libraryDep.itemId, mine)) : [];
    for (const it of items) {
      const me = byKey.get(`${it.source}:${it.projectId}`);
      for (const l of links) {
        const d = l.itemId === me?.id ? byId.get(l.depItemId) : undefined;
        if (d && isItemSource(d.source)) add(d.source, d.projectId, it);
      }
    }
    const errors: string[] = [];
    const todo = items.filter((i) => i.source === "modrinth" || i.source === "curseforge");
    for (let k = 0; k < todo.length; k += 8) { // 配布元に一度に送りすぎない
      await Promise.all(todo.slice(k, k + 8).map(async (it) => {
        const src = it.source as "modrinth" | "curseforge";
        const key = `deps:${src}:${it.projectId}:${p.platform}:${p.mcVersion ?? ""}`;
        const memo = it.installed ? `${teamId}:${key}:${it.installed}` : "";
        const hit = memo ? memoGet(memo) : undefined;
        if (hit) {
          for (const d of hit.value as string[]) add(src, d, it);
          return;
        }
        if (!cache.has(key)) cache.set(key, latestFile(src, it.projectId, p, teamId).then((f) => f?.deps ?? []));
        try {
          const list = (await cache.get(key)) as string[];
          if (memo) memoSet(memo, list);
          for (const d of list) add(src, d, it);
        } catch (e) {
          if (!isHttpError(e)) throw e;
          errors.push(`${it.title}: ${e.message}`);
        }
      }));
    }
    const missing: MissingDep[] = [];
    for (const n of need.values()) {
      const known = byKey.get(`${n.source}:${n.projectId}`);
      const key = `title:${n.source}:${n.projectId}`;
      const memo = memoGet(`${teamId}:${key}`);
      if (!known && !memo && !cache.has(key)) cache.set(key, project(n.source, n.projectId, teamId).catch(() => null));
      const info = known ?? (memo?.value as { title: string; iconUrl: string } | undefined) ?? ((await cache.get(key)) as { title: string; iconUrl: string } | null);
      if (!known && !memo && info) memoSet(`${teamId}:${key}`, { title: info.title, iconUrl: info.iconUrl });
      missing.push({ ...n, itemId: known?.id ?? null, title: info?.title || n.projectId, iconUrl: info?.iconUrl ?? "" });
    }
    return { missing: missing.sort((a, b) => a.title.localeCompare(b.title)), errors: [...new Set(errors)] };
  }

  return { teamPinsOf, files, missingOf, pickOf, modrinth, spiget, curseforge, cfKeyOf, latestFile, fileById, versionsOf, project, profileOf, needProfile, remember, installInto, holdsOf, pinsOf, updatesOf, logChange, removeFrom, restoreConfig, identifyIn, dirOf, addonsIn, packVersions };
}

export function libraryService(deps: Deps) {
  const { db, auth } = deps;
  const { record } = eventService(deps);
  const { teamPinsOf, files, missingOf, modrinth, spiget, curseforge, cfKeyOf, latestFile, fileById, versionsOf, project, profileOf, needProfile, remember, installInto, holdsOf, pinsOf, updatesOf, logChange, removeFrom, restoreConfig, identifyIn, dirOf, addonsIn, packVersions } = modTools(deps);
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

  async function itemOf(teamId: string, itemId: string) {
    const [i] = await db.select().from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
    if (!i) throw new HttpError(404, "見つかりません");
    return i;
  }

  /** 配布元のページの URL → 配布元とプロジェクトの ID(Modrinth・SpigotMC・CurseForge。Hangar はまだ扱えない) */
  async function resolveUrl(teamId: string, url: string) {
    const u = parseSourceUrl(url);
    if (!u) throw new HttpError(400, "Modrinth・SpigotMC・CurseForge のプロジェクトのページの URL を入力してください");
    if (u.source === "hangar") throw new HttpError(400, "Hangar は、まだ配布元として使えません(同じものが Modrinth にあれば、Modrinth のページの URL を入力してください)");
    if (u.source === "spigot") return { source: u.source, projectId: u.ref, type: u.type };
    const id = u.source === "modrinth" ? (await fromSource(() => modrinth.project(u.ref)))?.id
      : await fromSource(async () => (await curseforge(teamId)).bySlug(u.ref, u.type));
    if (!id) throw new HttpError(404, `${SOURCE_LABEL[u.source]} にこのプロジェクトが見つかりません`);
    return { source: u.source, projectId: id, type: u.type };
  }

  /**
   * 使えるサーバーごとの、入っているもの(無効にしたものは除く)の前提のうち、そのサーバーに無いもの。
   * serverId・itemId を渡すと、そのサーバー・そのアイテムの分だけを確かめる
   */
  async function depsReport(who: Awaited<ReturnType<typeof requireTeam>>, only: { serverId?: string; itemId?: string } = {}) {
    const { teamId } = who;
    const scope = await serverScope(deps, who);
    const item = only.itemId ? await itemOf(teamId, only.itemId) : null;
    const rows = (await db.select({ serverId: server.id, name: server.name, source: installedMod.source, projectId: installedMod.projectId, versionId: installedMod.versionId, title: installedMod.title,
      filename: installedMod.filename, platform: serverProfile.platform, mcVersion: serverProfile.mcVersion })
      .from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id)).innerJoin(serverProfile, eq(serverProfile.serverId, server.id))
      .where(and(eq(server.teamId, teamId), ...(only.serverId ? [eq(server.id, only.serverId)] : []))).orderBy(asc(server.name)))
      // データパックの前提は配布元に問い合わせない(サーバーの種類の作りでは探せないため)
      .filter((r) => isPlatform(r.platform) && isItemSource(r.source) && !isDisabled(r.filename) && !isDatapackFile(r.filename) && (!scope || scope.has(r.serverId)));
    const cache = new Map<string, Promise<unknown>>();
    const out: { serverId: string; serverName: string; missing: MissingDep[] }[] = [];
    const errors: string[] = [];
    for (const serverId of [...new Set(rows.map((r) => r.serverId))]) {
      const mine = rows.filter((r) => r.serverId === serverId);
      const check = item ? mine.filter((r) => r.source === item.source && r.projectId === item.projectId) : mine;
      if (!check.length) continue;
      const p = { platform: mine[0].platform as Platform, mcVersion: mine[0].mcVersion };
      const r = await missingOf(teamId, check.map((x) => ({ ...x, installed: x.versionId })), p, new Set(mine.map((x) => `${x.source}:${x.projectId}`)), cache);
      if (r.missing.length) out.push({ serverId, serverName: mine[0].name, missing: r.missing });
      errors.push(...r.errors.map((e) => `${mine[0].name}: ${e}`));
    }
    return { servers: out, errors };
  }

  /**
   * このサーバーにこのものを入れるときの選び方: kind で決める・サーバーに入っているファイルで決める・ライブラリの種類で決める(この順)。
   * サーバーに入れない種類(リソースパック・シェーダー・Modパック)と、ワールドの無いサーバーのデータパックは断る
   */
  async function targetProfile(teamId: string, serverId: string, p: Profile, source: string, projectId: string, kind?: string) {
    let t = kind;
    if (!t) {
      const [rec] = await db.select({ f: installedMod.filename }).from(installedMod)
        .where(and(eq(installedMod.serverId, serverId), eq(installedMod.source, source), eq(installedMod.projectId, projectId)));
      if (rec) return fileProfile(p, rec.f);
      t = (await db.select({ t: libraryItem.projectType }).from(libraryItem)
        .where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, source), eq(libraryItem.projectId, projectId))))[0]?.t;
    }
    if (t === "plugin" || t === "mod" || !isItemType(t)) return p; // 種類の違う Mod・プラグインは、これまでどおり配布元に合う版を探す
    const q = profileFor(p, t);
    if (q) return q;
    throw new HttpError(400, t === "datapack" ? "このサーバーにはワールドが無いので、データパックは入れられません"
      : t === "modpack" ? "Modパックは、ライブラリの「Modパックをサーバーに入れる」から入れてください(中の Mod と設定ファイルを入れます)"
      : `${ITEM_TYPES[t]}はクライアントで使うものなので、サーバーには入れません(ライブラリで持つ・ダウンロードするだけです)`);
  }

  async function addItem(headers: Headers, projectId: string, source = "modrinth", type?: string) {
    const src = searchable(source);
    const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
    const [{ n }] = await db.select({ n: count() }).from(libraryItem).where(eq(libraryItem.teamId, teamId));
    if (n >= LIBRARY_LIMITS.itemsPerTeam) throw new HttpError(400, `ライブラリに登録できるのは ${LIBRARY_LIMITS.itemsPerTeam} 件までです`);
    const p = await project(src, projectId, teamId);
    if (!p) throw new HttpError(404, `${SOURCE_LABEL[src]} にこのプロジェクトが見つかりません`);
    if (!isItemType(p.projectType)) {
      throw new HttpError(400, src === "spigot"
        ? "SpigotMC の外で配っているもの・有料のもの・プラグインではないものは登録できません"
        : src === "curseforge" ? "外部からのダウンロードを許していないもの・ワールドなど扱えない種類のものは登録できません"
        : "ライブラリに登録できるのは、プラグイン・Mod・データパック・リソースパック・シェーダー・Modパックです");
    }
    // 探したときの種類を優先する(Modrinth は、プラグイン・データパックでも "mod" と返す)
    const itemId = await remember(teamId, user.id, src, projectId, { ...p, projectType: isItemType(type) ? type : p.projectType, title: p.title || projectId });
    await record({ teamId, userId: user.id, kind: "admin", action: "ライブラリに足す", target: p.title || projectId, detail: SOURCE_LABEL[src] });
    return { id: itemId, title: p.title || projectId };
  }

  // 古い版が入っているもの(ライブラリの ID と、古い版のサーバー)
  async function outdatedServers(headers: Headers): Promise<{ itemId: string; serverIds: string[] }[]> {
    const who = await requireTeam(auth, headers);
    const { teamId } = who;
    const scope = await serverScope(deps, who);
    const rows = await db.select({ serverId: server.id, source: installedMod.source, projectId: installedMod.projectId, versionId: installedMod.versionId, filename: installedMod.filename, platform: serverProfile.platform, mcVersion: serverProfile.mcVersion })
      .from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id)).innerJoin(serverProfile, eq(serverProfile.serverId, server.id))
      .where(eq(server.teamId, teamId));
    const holds = new Set((await db.select({ serverId: serverHold.serverId, source: serverHold.source, projectId: serverHold.projectId }).from(serverHold)
      .innerJoin(server, eq(serverHold.serverId, server.id)).where(eq(server.teamId, teamId))).map((h) => `${h.serverId}:${h.source}:${h.projectId}`));
    const pins = await teamPinsOf(teamId);
    // 更新を止めているもの・結び付けたセットで版を固定しているもの・無効にしたもの・割り当てられていないサーバーは見ない
    const todo = rows.filter((r) => isItemSource(r.source) && isPlatform(r.platform) && !isDisabled(r.filename) && (!scope || scope.has(r.serverId))
      && !holds.has(`${r.serverId}:${r.source}:${r.projectId}`) && !pins.has(`${r.serverId}:${r.source}:${r.projectId}`));
    // 同じ配布元・種類・バージョンの組は 1 回だけ問い合わせる。問い合わせられなかったものは「更新あり」にしない
    const latest = new Map<string, Promise<string | null>>();
    const latestOf = (r: (typeof todo)[number]) => {
      const p = fileProfile({ platform: r.platform as Platform, mcVersion: r.mcVersion }, r.filename);
      const k = `${r.source}:${r.projectId}:${r.platform}:${r.mcVersion ?? ""}:${p.kind ?? ""}`;
      if (!latest.has(k)) {
        latest.set(k, latestFile(r.source as ItemSource, r.projectId, p, teamId)
          .then((f) => f?.versionId ?? null, () => null));
      }
      return latest.get(k)!;
    };
    const old = new Map<string, Set<string>>(); // 配布元:ID → 古い版のサーバー
    for (let i = 0; i < todo.length; i += 8) { // 配布元に一度に送りすぎない
      await Promise.all(todo.slice(i, i + 8).map(async (r) => {
        const v = await latestOf(r);
        const k = `${r.source}:${r.projectId}`;
        if (v && v !== r.versionId) old.set(k, (old.get(k) ?? new Set<string>()).add(r.serverId));
      }));
    }
    if (!old.size) return [];
    const items = await db.select({ id: libraryItem.id, source: libraryItem.source, projectId: libraryItem.projectId }).from(libraryItem).where(eq(libraryItem.teamId, teamId));
    return items.filter((i) => old.has(`${i.source}:${i.projectId}`)).map((i) => ({ itemId: i.id, serverIds: [...old.get(`${i.source}:${i.projectId}`)!] }));
  }

  return {
    /** チームのライブラリ: 登録したもの・それぞれが入っているサーバーと版・入れられるサーバー */
    async catalog(headers: Headers) {
      const who = await requireTeam(auth, headers);
      const { teamId } = who;
      const scope = await serverScope(deps, who);
      const mine = (id: string) => !scope || scope.has(id);
      const items = await db.select().from(libraryItem).where(eq(libraryItem.teamId, teamId)).orderBy(asc(libraryItem.title));
      const tags = await db.select({ itemId: libraryTag.itemId, tag: libraryTag.tag }).from(libraryTag)
        .innerJoin(libraryItem, eq(libraryTag.itemId, libraryItem.id)).where(eq(libraryItem.teamId, teamId)).orderBy(asc(libraryTag.tag));
      const favs = new Set((await db.select({ itemId: libraryFavorite.itemId }).from(libraryFavorite)
        .innerJoin(libraryItem, eq(libraryFavorite.itemId, libraryItem.id))
        .where(and(eq(libraryItem.teamId, teamId), eq(libraryFavorite.userId, who.user.id)))).map((f) => f.itemId));
      const installs = (await db.select({ serverId: server.id, serverName: server.name, source: installedMod.source, projectId: installedMod.projectId, title: installedMod.title, versionNumber: installedMod.versionNumber, filename: installedMod.filename })
        .from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id))
        .where(eq(server.teamId, teamId)).orderBy(asc(server.name))).filter((r) => mine(r.serverId)).map((r) => ({ ...r, disabled: isDisabled(r.filename) }));
      const pins = await teamPinsOf(teamId); // 結び付けたセットで固定した版(「固定」と出す)
      const servers = await db.select({ id: server.id, name: server.name, platform: serverProfile.platform })
        .from(server).leftJoin(serverProfile, eq(serverProfile.serverId, server.id)).where(eq(server.teamId, teamId)).orderBy(asc(server.name));
      const listed = new Set(items.map((i) => `${i.source}:${i.projectId}`));
      const links = items.length ? await db.select().from(libraryDep).where(inArray(libraryDep.itemId, items.map((i) => i.id))) : [];
      const [opt] = await db.select({ channel: teamOption.channel, keepFiles: teamOption.keepFiles, keepVersions: teamOption.keepVersions }).from(teamOption).where(eq(teamOption.teamId, teamId));
      // 保存先にある版: 数・大きさの合計・いちばん新しく足した版(一覧の「版 · N バージョン · 大きさ」)
      const fileRows = await db.select({ itemId: libraryFile.itemId, size: libraryFile.size, version: libraryFile.version }).from(libraryFile)
        .innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id)).where(eq(libraryItem.teamId, teamId)).orderBy(desc(libraryFile.createdAt));
      const fileSum = new Map<string, { n: number; size: number; version: string }>();
      for (const f of fileRows) {
        const s = fileSum.get(f.itemId) ?? { n: 0, size: 0, version: f.version };
        fileSum.set(f.itemId, { n: s.n + 1, size: s.size + f.size, version: s.version });
      }
      const [store] = deps.local ? await db.select({ name: storageTarget.name, kind: storageTarget.kind }).from(storageTarget)
        .where(and(eq(storageTarget.teamId, teamId), eq(storageTarget.active, true))) : [];
      return {
        channel: (opt?.channel === "all" ? "all" : "release") as Channel, // 受け取る版のチームの既定
        keep: { files: opt?.keepFiles ?? false, versions: opt?.keepVersions ?? 0 }, // 保存の設定のチームの既定(配布元のファイルを保存する・古い版を残す数)
        items: items.map((i) => ({
          id: i.id, source: i.source, projectId: i.projectId, title: i.title, slug: i.slug, projectType: i.projectType, iconUrl: i.iconUrl,
          createdAt: i.createdAt.toISOString(), favorite: favs.has(i.id), tags: tags.filter((t) => t.itemId === i.id).map((t) => t.tag),
          // channel: "" = チームの既定。loaders・mcVersions: 管理者が直したもの(null = 直していない)。mc: 対応 MC(直したもの、無ければ配布元から取ったもの)。deps: 手で決めた前提
          channel: isChannel(i.channel) ? i.channel : ("" as const), loaders: i.loaders ? parseList(i.loaders) : null, mcVersions: i.mcVersions ? parseList(i.mcVersions) : null,
          mc: (i.mcVersions ? parseList(i.mcVersions) : null) ?? mcClean(parseList(i.upstreamMc)), deps: links.filter((l) => l.itemId === i.id).map((l) => l.depItemId),
          installs: installs.filter((r) => r.source === i.source && r.projectId === i.projectId).map(({ serverId, serverName, versionNumber, filename, disabled }) => ({ serverId, serverName, versionNumber, filename, disabled, pinned: pins.get(`${serverId}:${i.source}:${i.projectId}`) ?? null })),
          pack: packOf(i.pack), // Modパック: 使った版と、配布元のいちばん新しい版(使っていなければ null)
          // 保存先にある版の数(アップロード・保存したもの)と、保存の設定("" / null = チームの既定)
          files: fileSum.get(i.id)?.n ?? 0, keepFiles: i.keepFiles, keepVersions: i.keepVersions,
          // 一覧に出す版(保存したいちばん新しい版。無ければ、サーバーに入っている版)と、保存した版の大きさの合計(バイト)
          version: fileSum.get(i.id)?.version || installs.find((r) => r.source === i.source && r.projectId === i.projectId)?.versionNumber || "",
          size: fileSum.get(i.id)?.size ?? 0,
        })),
        // 使っている保存先(自分用の版だけ。name が "" ならパネルの中 = ローカル)
        storage: deps.local ? { name: store?.name ?? "", kind: store?.kind ?? "" } : null,
        // 配布元はわかっているが、ライブラリに無いもの(ライブラリから外したものなど)
        orphans: installs.filter((r) => !listed.has(`${r.source}:${r.projectId}`)).map(({ serverId, source, projectId, title, versionNumber, filename, disabled }) => ({ serverId, source, projectId, title, versionNumber, filename, disabled })),
        // 種類を決めていないサーバーには入れられない(type が null)。kinds は入れられる種類(プラグイン・Mod と、ワールドがあればデータパック)
        servers: servers.filter((x) => mine(x.id)).map((x) => ({ id: x.id, name: x.name, type: isPlatform(x.platform) ? PLATFORMS[x.platform].type : null, kinds: kindsOf(x.platform) })),
        sources: await sourcesOf(teamId),
      };
    },

    /** 配布元で、種類(プラグイン・Mod・データパック・リソースパック・シェーダー・Modパック)だけで探す(ライブラリに足すとき)。SpigotMC はプラグインだけ */
    async searchCatalog(headers: Headers, query: string, type: string, source = "modrinth") {
      const { teamId } = await requireTeam(auth, headers);
      if (!isItemType(type)) throw new HttpError(400, "種類を選んでください");
      const src = searchable(source);
      if (src === "spigot" && type !== "plugin") throw new HttpError(400, "SpigotMC で探せるのはプラグインだけです");
      const cf = src === "curseforge" ? await curseforge(teamId) : null;
      return fromSource(() => (cf ? cf.searchType(query, type) : src === "spigot" ? spiget.searchAll(query) : modrinth.searchType(query, type)));
    },

    /** CurseForge の API キーの設定(自分用の版・管理者以上。キーは最後の 4 文字だけ) */
    async curseforgeKey(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { integrations: ["manage"] });
      if (!deps.local) return { enabled: false, hint: "" };
      const [k] = await db.select({ hint: teamCurseforge.apiKeyHint }).from(teamCurseforge).where(eq(teamCurseforge.teamId, teamId));
      return { enabled: true, hint: k?.hint ?? "" };
    },

    /** CurseForge の API キーを設定する(使えることを確かめてから保存)。null なら消す */
    async setCurseforgeKey(headers: Headers, key: string | null) {
      const { teamId, user } = await requireTeam(auth, headers, { integrations: ["manage"] });
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
    addItem,

    /** 配布元のページの URL から、ライブラリに足す(Modrinth・SpigotMC・CurseForge。編集者以上) */
    async addFromUrl(headers: Headers, url: string) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      const r = await resolveUrl(teamId, url);
      return addItem(headers, r.projectId, r.source, r.type);
    },

    /**
     * アイテムの情報を直す(管理者以上): 種類・動く作り・対応 MC(null = 配布元のとおり)・受け取る版("" = チームの既定)。
     * 動く作り・対応 MC を直すと、入れる版を選ぶときにもそれを使う(対応 MC がサーバーのバージョンを含めば、配布元の対応 MC では絞らない)
     */
    async editItem(headers: Headers, itemId: string, input: { projectType: string; loaders: string[] | null; mcVersions: string[] | null; channel: string }) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      const i = await itemOf(teamId, itemId);
      if (!isItemType(input.projectType)) throw new HttpError(400, "種類を選んでください");
      if (input.channel !== "" && !isChannel(input.channel)) throw new HttpError(400, "受け取る版を選んでください");
      const loaders = input.loaders && [...new Set(input.loaders.map((l) => l.trim().toLowerCase()).filter(Boolean))];
      if (loaders?.some((l) => !LOADERS.includes(l))) throw new HttpError(400, `動く作りは ${LOADERS.join("・")} から選んでください`);
      const mc = input.mcVersions && [...new Set(input.mcVersions.map((v) => v.trim()).filter(Boolean))];
      if (mc?.some((v) => !MC_VERSION.test(v)) || (mc?.length ?? 0) > 50) throw new HttpError(400, "対応 MC は 1.21.1 や 1.20 のように、カンマで区切って入力してください(50 個まで)");
      await db.update(libraryItem).set({ projectType: input.projectType, channel: input.channel,
        loaders: loaders?.length ? JSON.stringify(loaders) : "", mcVersions: mc?.length ? JSON.stringify(mc) : "" }).where(eq(libraryItem.id, i.id));
      await record({ teamId, userId: user.id, kind: "admin", action: "アイテムの情報を直す", target: i.title,
        detail: [ITEM_TYPES[input.projectType], loaders?.length ? `作り ${loaders.join("・")}` : "", mc?.length ? `MC ${mc.join("・")}` : "",
          input.channel === "all" ? "ベータ版も" : input.channel === "release" ? "正式版だけ" : ""].filter(Boolean).join("・") });
    },

    /**
     * 配布元を付け替える(管理者以上): 別のプロジェクト(URL)に結び付け直す。サーバーに入っているものの記録・更新を止めたものも付け替え、
     * 次の更新で新しいプロジェクトの版に入れ替わる。アップロードしたものは付け替えられない
     */
    async relinkItem(headers: Headers, itemId: string, url: string) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      const i = await itemOf(teamId, itemId);
      if (i.source === "upload") throw new HttpError(400, "アップロードしたものは、配布元を付け替えられません");
      const r = await resolveUrl(teamId, url);
      if (r.source === i.source && r.projectId === i.projectId) throw new HttpError(400, "いまと同じプロジェクトです");
      const [dup] = await db.select({ title: libraryItem.title }).from(libraryItem)
        .where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, r.source), eq(libraryItem.projectId, r.projectId)));
      if (dup) throw new HttpError(400, `そのプロジェクトは、もうライブラリにあります(${dup.title})`);
      const p = await project(r.source, r.projectId, teamId);
      if (!p) throw new HttpError(404, `${SOURCE_LABEL[r.source]} にこのプロジェクトが見つかりません`);
      await db.update(libraryItem).set({ source: r.source, projectId: r.projectId, title: p.title || r.projectId, slug: p.slug, iconUrl: p.iconUrl, upstreamMc: "[]", infoAt: null })
        .where(eq(libraryItem.id, i.id));
      const mine = (await db.select({ id: server.id }).from(server).where(eq(server.teamId, teamId))).map((x) => x.id);
      if (mine.length) {
        await db.update(installedMod).set({ source: r.source, projectId: r.projectId })
          .where(and(inArray(installedMod.serverId, mine), eq(installedMod.source, i.source), eq(installedMod.projectId, i.projectId)));
        const holds = await db.delete(serverHold).where(and(inArray(serverHold.serverId, mine), eq(serverHold.source, i.source), eq(serverHold.projectId, i.projectId))).returning();
        if (holds.length) await db.insert(serverHold).values(holds.map((h) => ({ ...h, source: r.source, projectId: r.projectId }))).onConflictDoNothing();
      }
      await record({ teamId, userId: user.id, kind: "admin", action: "配布元を付け替える", target: i.title, detail: `${SOURCE_LABEL[r.source]}: ${p.title || r.projectId}` });
      return { title: p.title || r.projectId };
    },

    /** 前提を手で決める・外す(編集者以上): itemId を入れるサーバーには depItemId も要る */
    async linkDep(headers: Headers, itemId: string, depItemId: string, on: boolean) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const i = await itemOf(teamId, itemId);
      const d = await itemOf(teamId, depItemId);
      if (i.id === d.id) throw new HttpError(400, "自分自身は前提にできません");
      if (on) await db.insert(libraryDep).values({ itemId: i.id, depItemId: d.id }).onConflictDoNothing();
      else await db.delete(libraryDep).where(and(eq(libraryDep.itemId, i.id), eq(libraryDep.depItemId, d.id)));
      await record({ teamId, userId: user.id, kind: "admin", action: on ? "前提を決める" : "前提を外す", target: i.title, detail: d.title });
    },

    /**
     * 必須の前提が入っていないもの(ライブラリのアイテムごと・サーバーごと)。配布元に問い合わせるので、確かめるときだけ呼ぶ。
     * itemId を渡すとそのアイテムの分だけ。見るのはメンバー全員(割り当てられたサーバーだけ)
     */
    async missingDeps(headers: Headers, itemId?: string) {
      const who = await requireTeam(auth, headers);
      const r = await depsReport(who, { itemId });
      const items = await db.select({ id: libraryItem.id, source: libraryItem.source, projectId: libraryItem.projectId }).from(libraryItem).where(eq(libraryItem.teamId, who.teamId));
      const idOf = new Map(items.map((i) => [`${i.source}:${i.projectId}`, i.id]));
      type Row = { serverId: string; serverName: string; deps: { source: ItemSource; projectId: string; title: string; itemId: string | null }[] };
      const out = new Map<string, Row[]>();
      for (const s of r.servers) {
        for (const m of s.missing) {
          for (const k of m.byKeys) {
            const id = idOf.get(k);
            if (!id) continue;
            const list = out.get(id) ?? [];
            let row = list.find((x) => x.serverId === s.serverId);
            if (!row) list.push(row = { serverId: s.serverId, serverName: s.serverName, deps: [] });
            row.deps.push({ source: m.source, projectId: m.projectId, title: m.title, itemId: m.itemId });
            out.set(id, list);
          }
        }
      }
      return { items: [...out].map(([id, servers]) => ({ itemId: id, servers })), errors: r.errors };
    },

    /** このサーバーで、入っているものの必須の前提が無いもの(配布元に問い合わせる) */
    async serverDeps(headers: Headers, serverId: string) {
      const who = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, who, serverId); // ほかのチーム・割り当てられていないサーバーは見せない
      const r = await depsReport(who, { serverId: row.id });
      return { missing: (r.servers[0]?.missing ?? []).map(({ byKeys: _, ...m }) => m), errors: r.errors };
    },

    /** アイテムの版(配布元のもの。新しい順)。SpigotMC は更新のお知らせを版の代わりに出す。アップロードしたものは空(「版を見る」で見る) */
    async itemVersions(headers: Headers, itemId: string) {
      const { teamId } = await requireTeam(auth, headers);
      const i = await itemOf(teamId, itemId);
      if (i.source === "upload") return [];
      if (i.source === "spigot") return fromSource(() => spiget.updates(i.projectId));
      const cf = i.source === "curseforge" ? await curseforge(teamId) : null;
      const list = await fromSource(() => (cf ? cf.allFiles(i.projectId) : modrinth.allVersions(i.projectId)));
      // 同じ版が作りごと(Bukkit・Fabric など)に並ぶので、このアイテムの動く作り(直したもの、無ければ種類の作り)のものだけにする(1 つも無ければすべて)
      const want = (i.loaders && parseList(i.loaders)) || (i.projectType === "datapack" ? ["datapack"]
        : Object.values(PLATFORMS).filter((p) => p.type === i.projectType).flatMap((p) => [...p.loaders]));
      const fit = list.filter((v) => v.loaders.some((l) => want.includes(l)));
      return fit.length ? fit : list;
    },

    /** 版の変更内容(Modrinth は Markdown の文、CurseForge は HTML を文字にしたもの)。SpigotMC は版の一覧に入っている */
    async itemChangelog(headers: Headers, itemId: string, versionId: string) {
      const { teamId } = await requireTeam(auth, headers);
      const i = await itemOf(teamId, itemId);
      if (i.source !== "modrinth" && i.source !== "curseforge") throw new HttpError(400, "この配布元の変更内容は、版の一覧に入っています");
      const cf = i.source === "curseforge" ? await curseforge(teamId) : null;
      const text = await fromSource(() => (cf ? cf.changelog(i.projectId, versionId) : modrinth.changelog(i.projectId, versionId)));
      if (text === null) throw new HttpError(404, "その版は見つかりません");
      return { text };
    },

    /** 受け取る版のチームの既定を決める(管理者以上) */
    async setChannel(headers: Headers, channel: string) {
      const { teamId, user } = await requireTeam(auth, headers, { member: ["update"] });
      if (!isChannel(channel)) throw new HttpError(400, "受け取る版を選んでください");
      await db.insert(teamOption).values({ teamId, channel }).onConflictDoUpdate({ target: teamOption.teamId, set: { channel, updatedAt: new Date() } });
      await record({ teamId, userId: user.id, kind: "admin", action: "受け取る版の既定を変える", detail: channel === "all" ? "ベータ版・アルファ版も" : "正式版だけ" });
    },

    /**
     * 対応 MC を配布元から取り直す(1 分ごとに呼ぶ。画面からは呼ばない): 取ってから 1 日たったもの(まだのものから)を 1 回に INFO_BATCH 件まで。
     * 取れなかったものは前の値のまま、次は 1 日後。アップロードしたものは、jar から読んだ対応 MC を使う。
     * Modパックは、いちばん新しい版も取り直し、使った版より新しい版が出たら一度だけ知らせる(「新しい版」の種類)
     */
    async refreshInfo(now: Date) {
      const rows = await db.select({ id: libraryItem.id, teamId: libraryItem.teamId, source: libraryItem.source, projectId: libraryItem.projectId,
        projectType: libraryItem.projectType, title: libraryItem.title, pack: libraryItem.pack }).from(libraryItem)
        .where(or(isNull(libraryItem.infoAt), lt(libraryItem.infoAt, new Date(now.getTime() - INFO_EVERY))))
        .orderBy(sql`${libraryItem.infoAt} asc nulls first`).limit(INFO_BATCH);
      if (!rows.length) return 0;
      // 先に時刻を書き換え、ほかのプロセスと同じものを取り直さない
      await db.update(libraryItem).set({ infoAt: now }).where(inArray(libraryItem.id, rows.map((r) => r.id)));
      const found = new Map<string, string[]>();
      const quiet = async (fn: () => Promise<void>) => {
        try {
          await fn();
        } catch { /* 配布元につながらなければ、前の値のまま */ }
      };
      const take = (list: typeof rows, m: Map<string, { mcVersions: string[] }>) => { for (const r of list) if (m.has(r.projectId)) found.set(r.id, m.get(r.projectId)!.mcVersions); };
      const mr = rows.filter((r) => r.source === "modrinth");
      if (mr.length) await quiet(async () => take(mr, await modrinth.projects(mr.map((r) => r.projectId))));
      for (const teamId of new Set(rows.filter((r) => r.source === "curseforge").map((r) => r.teamId))) {
        const key = await cfKeyOf(teamId);
        const list = rows.filter((r) => r.source === "curseforge" && r.teamId === teamId);
        if (key) await quiet(async () => take(list, await curseforgeClient(deps.fetch, key).projects(list.map((r) => r.projectId))));
      }
      for (const r of rows.filter((x) => x.source === "spigot")) {
        await quiet(async () => {
          const p = await spiget.project(r.projectId);
          if (p) found.set(r.id, p.mcVersions);
        });
      }
      const up = rows.filter((r) => r.source === "upload");
      if (up.length) {
        for (const f of await db.select({ itemId: libraryFile.itemId, mc: libraryFile.mcVersions }).from(libraryFile).where(inArray(libraryFile.itemId, up.map((r) => r.id)))) {
          found.set(f.itemId, [...(found.get(f.itemId) ?? []), ...(parseList(f.mc) ?? [])]);
        }
      }
      for (const [id, mc] of found) await db.update(libraryItem).set({ upstreamMc: JSON.stringify(mcClean(mc)) }).where(eq(libraryItem.id, id));
      for (const r of rows.filter((x) => x.projectType === "modpack" && (x.source === "modrinth" || x.source === "curseforge"))) {
        await quiet(async () => {
          const { latest } = await packVersions(r.teamId, r.source as "modrinth" | "curseforge", r.projectId);
          const st = packOf(r.pack);
          if (!latest || st?.latest?.id === latest.versionId) return;
          await db.update(libraryItem).set({ pack: JSON.stringify({ used: st?.used ?? null, latest: { id: latest.versionId, number: latest.versionNumber } }) }).where(eq(libraryItem.id, r.id));
          if (st?.used && st.used.id !== latest.versionId) {
            await record({ teamId: r.teamId, userId: null, kind: "updates", action: "Modパックに新しい版があります", target: r.title, detail: `${st.used.number} → ${latest.versionNumber}` });
          }
        });
      }
      return found.size;
    },

    /** ライブラリから外す(サーバーに入っているファイルはそのまま。アップロード・保存した版は保存先からも消す) */
    async removeItem(headers: Headers, itemId: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const own = await db.select({ f: libraryFile }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryFile.itemId, itemId), eq(libraryItem.teamId, teamId)));
      for (const { f } of own) await files.dropFile(teamId, f);
      const gone = await db.delete(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId))).returning({ title: libraryItem.title });
      if (!gone.length) throw new HttpError(404, "見つかりません");
      await record({ teamId, userId: user.id, kind: "admin", action: "ライブラリから外す", target: gone[0].title });
    },

    /** ライブラリのものにタグを付ける・外す(まとめて)。タグはチームの中で共有 */
    async tagItems(headers: Headers, itemIds: string[], tag: string, on: boolean) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const t = tag.trim();
      if (!t || t.length > TAG_MAX) throw new HttpError(400, `タグは 1〜${TAG_MAX} 文字にしてください`);
      const ids = itemIds.length ? (await db.select({ id: libraryItem.id }).from(libraryItem)
        .where(and(eq(libraryItem.teamId, teamId), inArray(libraryItem.id, itemIds)))).map((r) => r.id) : [];
      if (!ids.length) throw new HttpError(404, "見つかりません");
      if (on) {
        const full = await db.select({ itemId: libraryTag.itemId, n: count() }).from(libraryTag).where(inArray(libraryTag.itemId, ids)).groupBy(libraryTag.itemId);
        if (full.some((f) => f.n >= TAGS_PER_ITEM)) throw new HttpError(400, `タグは 1 つにつき ${TAGS_PER_ITEM} 個までです`);
        await db.insert(libraryTag).values(ids.map((itemId) => ({ itemId, tag: t }))).onConflictDoNothing();
      } else {
        await db.delete(libraryTag).where(and(inArray(libraryTag.itemId, ids), eq(libraryTag.tag, t)));
      }
      await record({ teamId, userId: user.id, kind: "admin", action: on ? "タグを付ける" : "タグを外す", target: t, detail: `${ids.length} 件` });
    },

    /** お気に入りにする・やめる(利用者ごと。閲覧者もできる) */
    async favorite(headers: Headers, itemId: string, on: boolean) {
      const { teamId, user } = await requireTeam(auth, headers);
      const [i] = await db.select({ id: libraryItem.id }).from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
      if (!i) throw new HttpError(404, "見つかりません");
      if (on) await db.insert(libraryFavorite).values({ userId: user.id, itemId }).onConflictDoNothing();
      else await db.delete(libraryFavorite).where(and(eq(libraryFavorite.userId, user.id), eq(libraryFavorite.itemId, itemId)));
    },

    /** どこかのサーバーに古い版が入っているもの(ライブラリの ID)。配布元に問い合わせるので、絞り込むときだけ呼ぶ */
    async outdated(headers: Headers) {
      return (await outdatedServers(headers)).map((x) => x.itemId);
    },

    /** 古い版が入っているもの(ライブラリの ID と、古い版のサーバーの ID)。配布元に問い合わせるので、絞り込むときだけ呼ぶ */
    outdatedServers,

    /** サーバーの名前・種類・バージョン */
    async detail(headers: Headers, id: string) {
      const who = await requireTeam(auth, headers);
      const { teamId } = who;
      const { row } = await serverOf(deps, who, id);
      return { id: row.id, name: row.name, kind: row.kind, profile: await profileOf(row.id), sources: await sourcesOf(teamId), autoUpdate: row.autoUpdate };
    },

    /** サーバーの種類(paper・fabric など)とバージョンを決める */
    async setProfile(headers: Headers, id: string, input: { platform: string; mcVersion: string }) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { teamId, user } = who;
      const { row } = await serverOf(deps, who, id);
      if (!isPlatform(input.platform)) throw new HttpError(400, "サーバーの種類を選んでください");
      const mcVersion = input.mcVersion.trim() || null;
      if (mcVersion && !MC_VERSION.test(mcVersion)) throw new HttpError(400, "バージョンは 1.21.1 や 26.3 のように入力してください");
      const values = { serverId: row.id, platform: input.platform, mcVersion, updatedAt: new Date() };
      await db.insert(serverProfile).values(values).onConflictDoUpdate({ target: serverProfile.serverId, set: values });
      await record({ teamId, userId: user.id, kind: "admin", action: "サーバーの種類を設定", target: row.name, detail: `${PLATFORMS[input.platform].label}${mcVersion ? ` ${mcVersion}` : ""}` });
    },

    /**
     * 入っている Mod・プラグイン・データパック(サーバーのフォルダーの中身と、このアプリで入れた記録を合わせる)。
     * dir はサーバーの種類のフォルダ、datapacks はワールドのデータパックのフォルダ(プロキシは null)。datapack はデータパックの行
     */
    async installed(headers: Headers, id: string) {
      const who = await requireTeam(auth, headers);
      const target = await serverOf(deps, who, id);
      const { row } = target;
      const profile = await needProfile(row.id);
      const dir = PLATFORMS[profile.platform].dir;
      const files = await addonsIn(target, profile);
      const datapacks = kindsOf(profile.platform).includes("datapack") ? await dirOf(target, fileProfile(profile, ".zip")) : null;
      const records = new Map((await db.select().from(installedMod).where(eq(installedMod.serverId, row.id))).map((r) => [r.filename, r]));
      const holds = await holdsOf(row.id);
      const pins = await pinsOf(row.id);
      const history = new Set((await db.select({ source: installHistory.source, projectId: installHistory.projectId }).from(installHistory)
        .where(eq(installHistory.serverId, row.id))).filter((h) => h.source !== "spigot").map((h) => `${h.source}:${h.projectId}`));
      return {
        dir, datapacks,
        items: files.map((f) => {
          const r = records.get(f.name);
          return {
            filename: f.name, size: f.size, disabled: isDisabled(f.name), datapack: f.datapack,
            ...(r ? { source: r.source, projectId: r.projectId, versionId: r.versionId, versionNumber: r.versionNumber, title: r.title, held: holds.has(`${r.source}:${r.projectId}`), pinned: pins.get(`${r.source}:${r.projectId}`)?.versionNumber ?? null, canRollback: history.has(`${r.source}:${r.projectId}`) } : {}),
          };
        }).sort((a, b) => (a.title ?? a.filename).localeCompare(b.title ?? b.filename)),
      };
    },

    /**
     * このアプリで入れていない jar の配布元を、中身から探す(Modrinth は SHA-1、CurseForge はフィンガープリント。1 回に ${IDENTIFY_MAX} 個まで)。
     * 見つかったものは、このアプリで入れたものとして記録し、ライブラリにも載せる(編集者以上)
     */
    async identify(headers: Headers, id: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const target = await serverOf(deps, who, id);
      const r = await identifyIn(teamId, user.id, target, await needProfile(target.row.id));
      if (r.found.length) await record({ teamId, userId: user.id, kind: "changes", action: "配布元を見つける", target: target.row.name, detail: r.found.map((f) => `${f.title} ${f.versionNumber}(${SOURCE_LABEL[f.source]})`).join("、") });
      return r;
    },

    /**
     * サーバーにあるものをライブラリに載せる(編集者以上): 配布元がわかっているもの(ライブラリから外したものなど)はそのまま載せ、
     * わからないものは中身から探す。見つからなければ、アップロードしたものとして取り込む(自分用の版だけ)
     */
    async adopt(headers: Headers, id: string, filename: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      if (!ADDON.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
      const target = await serverOf(deps, who, id);
      const p = await needProfile(target.row.id);
      const [rec] = await db.select().from(installedMod).where(and(eq(installedMod.serverId, target.row.id), eq(installedMod.filename, filename)));
      if (rec && isItemSource(rec.source) && rec.source !== "upload") {
        const info = await project(rec.source, rec.projectId, teamId).catch(() => null);
        await remember(teamId, user.id, rec.source, rec.projectId, { title: info?.title || rec.title, slug: info?.slug ?? "", iconUrl: info?.iconUrl ?? "", projectType: fileProfile(p, filename).kind ?? PLATFORMS[p.platform].type });
        await record({ teamId, userId: user.id, kind: "admin", action: "ライブラリに足す", target: rec.title, detail: SOURCE_LABEL[rec.source] });
        return { title: rec.title, how: "source" as const };
      }
      if (!rec) {
        const r = await identifyIn(teamId, user.id, target, p, filename);
        if (r.found.length) {
          await record({ teamId, userId: user.id, kind: "changes", action: "配布元を見つける", target: target.row.name, detail: `${r.found[0].title} ${r.found[0].versionNumber}(${SOURCE_LABEL[r.found[0].source]})` });
          return { title: r.found[0].title, how: "found" as const };
        }
      }
      if (!deps.local) throw new HttpError(404, "配布元が見つかりませんでした(配布元のわからないファイルを取り込めるのは、自分用の版だけです)");
      return { title: (await uploadService(deps).fromServer(headers, id, filename)).title, how: "upload" as const };
    },

    /** 無効にする・有効にする(消さずに、名前の最後に .disabled を付ける・外す。変更の履歴から元に戻せる) */
    async setEnabled(headers: Headers, id: string, filename: string, enable: boolean) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      if (!ADDON.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
      if (isDisabled(filename) !== enable) throw new HttpError(400, enable ? "すでに有効です" : "すでに無効です");
      const target = await serverOf(deps, who, id);
      const { row, client, remoteId } = target;
      const p = await needProfile(row.id);
      const dir = await dirOf(target, fileProfile(p, filename));
      const to = enable ? filename.slice(0, -DISABLED.length) : filename + DISABLED;
      const list = await remote(() => client.listFiles(remoteId, dir));
      if (!list.some((f) => f.isFile && f.name === filename)) throw new HttpError(404, "ファイルが見つかりません");
      if (list.some((f) => f.name === to)) throw new HttpError(400, `${to} がもうあります`);
      await remote(() => client.rename(remoteId, dir, filename, to));
      const [rec] = await db.update(installedMod).set({ filename: to }).where(and(eq(installedMod.serverId, row.id), eq(installedMod.filename, filename))).returning({ title: installedMod.title });
      const action = enable ? "有効にする" : "無効にする";
      await logChange(row.id, user.id, { action, title: rec?.title ?? filename, added: to, removed: { filename } }, target, p);
      await record({ teamId, userId: user.id, kind: "changes", action, target: row.name, detail: rec?.title ?? filename });
      return { filename: to };
    },

    /** 配布元で、このサーバーの種類とバージョンに合うものを探す(kind = "datapack" ならデータパック) */
    async search(headers: Headers, id: string, query: string, source = "modrinth", kind?: string) {
      const who = await requireTeam(auth, headers);
      const { teamId } = who;
      const { row } = await serverOf(deps, who, id);
      const p = await needProfile(row.id);
      const src = searchable(source);
      const dp = kind === "datapack" ? "datapack" as const : undefined;
      if (dp && !profileFor(p, dp)) throw new HttpError(400, "このサーバーにはワールドが無いので、データパックは入れられません");
      if (src === "spigot" && (dp || PLATFORMS[p.platform].type !== "plugin")) throw new HttpError(400, "SpigotMC にあるのはプラグインだけです");
      const cf = src === "curseforge" ? await curseforge(teamId) : null;
      return fromSource(() => (cf ? cf.search(query, p.platform, p.mcVersion, dp) : src === "spigot" ? spiget.search(query, p.platform) : modrinth.search(query, p.platform, p.mcVersion, dp)));
    },

    /** このサーバーに入れられる版(新しい順・30 個まで)。SpigotMC は、いちばん新しい版しか取ってこられないので空 */
    async versions(headers: Headers, id: string, source: string, projectId: string, kind?: string) {
      const who = await requireTeam(auth, headers);
      const { teamId } = who;
      const { row } = await serverOf(deps, who, id);
      const p = await targetProfile(teamId, row.id, await needProfile(row.id), source, projectId, kind);
      return (await versionsOf(sourceOf(source), projectId, p, teamId))
        .map(({ versionId, versionNumber, date, release }) => ({ versionId, versionNumber, date, release }));
    },

    /**
     * 入れる。同じものの古い版が入っていれば、新しい版を入れてから古いファイルを消す(= 更新)。
     * versionId を渡すとその版を入れ、いちばん新しい版でなければ「更新を止める」にする(そろえる・予約で戻されないように)。
     * データパックは、kind = "datapack" か、ライブラリの種類がデータパックのとき(ワールドの datapacks に入れる)
     */
    async install(headers: Headers, id: string, projectId: string, source = "modrinth", versionId?: string, kind?: string) {
      const src = sourceOf(source);
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const { row, client, remoteId } = await serverOf(deps, who, id);
      const p = await targetProfile(teamId, row.id, await needProfile(row.id), src, projectId, kind);
      let file: Awaited<ReturnType<typeof fileById>> = null;
      let hold = false;
      if (versionId) {
        if (src === "spigot") throw new HttpError(400, "SpigotMC のものは版を選べません(いちばん新しい版だけを入れられます)");
        // 一覧に出した版(このサーバーの種類・バージョンに合うもの)だけを受け付ける
        if (!(await versionsOf(src, projectId, p, teamId)).some((v) => v.versionId === versionId)) throw new HttpError(400, "この版は、このサーバーの種類・バージョンに合いません");
        file = await fileById(src, projectId, versionId, teamId);
        if (!file) throw new HttpError(404, "その版は見つかりません");
        hold = (await latestFile(src, projectId, p, teamId))?.versionId !== versionId;
      } else {
        // 結び付けたセットで版を固定しているものは、版を選ばなければ(「更新」を押しても)固定した版を入れる
        const pin = (await pinsOf(row.id)).get(`${src}:${projectId}`);
        if (pin) file = await fileById(src, projectId, pin.versionId, teamId);
      }
      const r = await jobService(deps).track({ teamId, userId: user.id, serverId: row.id, action: "入れる" },
        () => installInto(teamId, user.id, { row, client, remoteId }, p, src, projectId, file ? { file } : {}), (x) => `${x.title} ${x.versionNumber}`);
      if (hold) await db.insert(serverHold).values({ serverId: row.id, source: src, projectId, createdBy: user.id }).onConflictDoNothing();
      await record({ teamId, userId: user.id, kind: "changes", action: r.replaced.length ? "更新" : "入れる", target: row.name,
        detail: `${r.title} ${r.versionNumber}(${SOURCE_LABEL[src]})${hold ? "・版を選んだので更新を止めました" : ""}${r.deps.length ? `\n前提: ${r.deps.map((d) => `${d.title} ${d.ok ? d.detail : `(入れられません: ${d.detail})`}`).join("、")}` : ""}` });
      return { ...r, held: hold };
    },

    /** 前の版に戻す(更新で入れ替えた、いちばん新しい前の版を入れ直す)。戻したものは「更新を止める」にする */
    async rollback(headers: Headers, id: string, source: string, projectId: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const target = await serverOf(deps, who, id);
      const src = sourceOf(source);
      if (src === "spigot") throw new HttpError(400, "SpigotMC のものは、前の版を取ってこられないので戻せません");
      const p = await targetProfile(teamId, target.row.id, await needProfile(target.row.id), src, projectId);
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

    /** アドオンの変更の履歴(新しい順・30 件まで)。元に戻せるものがわかる */
    async changes(headers: Headers, id: string) {
      const who = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, who, id);
      const rows = await db.select({ c: serverChange, by: userTable.name }).from(serverChange).leftJoin(userTable, eq(serverChange.userId, userTable.id))
        .where(eq(serverChange.serverId, row.id)).orderBy(desc(serverChange.at));
      return rows.map(({ c, by }) => {
        const removed = c.removed ? (JSON.parse(c.removed) as Removed) : null;
        return {
          id: c.id, action: c.action, title: c.title, at: c.at.toISOString(), by: by ?? "", added: c.added, removed: removed?.filename ?? "",
          version: removed?.versionNumber ?? "", undone: c.undone, config: !!c.configBackup,
          // 外したもの・新しく入れたもの・無効と有効の切り替えは戻せる。更新は前の版を取ってこられるもの(SpigotMC 以外)だけ
          undoable: !c.undone && (c.action === "外す" || c.action === "無効にする" || c.action === "有効にする" || (c.action === "入れる" && !!c.added)
            || (c.action === "更新" && !!removed?.versionId && removed.source !== "spigot")),
        };
      });
    },

    /**
     * 変更を元に戻す(編集者以上): 外したもの → 名前を戻す / 入れたもの → 外す / 更新 → 前の版を入れ直して「更新を止める」にする /
     * 無効・有効 → 名前を戻す。外す・更新のときに退避したプラグインの設定フォルダも戻す
     */
    async undo(headers: Headers, id: string, changeId: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const target = await serverOf(deps, who, id);
      const { row, client, remoteId } = target;
      const [c] = await db.select().from(serverChange).where(and(eq(serverChange.id, changeId), eq(serverChange.serverId, row.id)));
      if (!c) throw new HttpError(404, "履歴が見つかりません");
      if (c.undone) throw new HttpError(400, "この変更は、もう元に戻しています");
      const p = await needProfile(row.id);
      const removed = c.removed ? (JSON.parse(c.removed) as Removed) : null;
      const q = fileProfile(p, removed?.filename || c.added); // データパックはワールドの datapacks
      const dir = await dirOf(target, q);
      const files = await remote(() => client.listFiles(remoteId, dir));
      if (c.action === "外す" && removed) {
        if (!files.some((f) => f.name === c.backup)) throw new HttpError(404, "残していたファイルが見つかりません");
        if (files.some((f) => f.name === removed.filename)) throw new HttpError(400, `${removed.filename} がもうあります`);
        await remote(() => client.rename(remoteId, dir, c.backup, removed.filename));
        if (removed.source && removed.projectId && removed.versionId) {
          await db.insert(installedMod).values({ id: randomUUID(), serverId: row.id, source: removed.source, projectId: removed.projectId, versionId: removed.versionId,
            versionNumber: removed.versionNumber ?? "", title: removed.title ?? removed.filename, filename: removed.filename, installedBy: user.id }).onConflictDoNothing();
        }
      } else if (c.action === "入れる" && c.added) {
        if (files.some((f) => f.name === c.added)) await remote(() => client.deleteFiles(remoteId, dir, [c.added]));
        await db.delete(installedMod).where(and(eq(installedMod.serverId, row.id), eq(installedMod.filename, c.added)));
      } else if (c.action === "更新" && removed?.versionId && removed.source && removed.projectId && isItemSource(removed.source) && removed.source !== "spigot") {
        const file = await fileById(removed.source, removed.projectId, removed.versionId, teamId);
        if (!file) throw new HttpError(404, "前の版のファイルが、もう取ってこられません");
        await installInto(teamId, user.id, target, q, removed.source, removed.projectId, { file, depth: 0 });
        await db.insert(serverHold).values({ serverId: row.id, source: removed.source, projectId: removed.projectId, createdBy: user.id }).onConflictDoNothing();
      } else if ((c.action === "無効にする" || c.action === "有効にする") && removed && c.added) {
        if (!files.some((f) => f.name === c.added)) throw new HttpError(404, "ファイルが見つかりません");
        if (files.some((f) => f.name === removed.filename)) throw new HttpError(400, `${removed.filename} がもうあります`);
        await remote(() => client.rename(remoteId, dir, c.added, removed.filename));
        await db.update(installedMod).set({ filename: removed.filename }).where(and(eq(installedMod.serverId, row.id), eq(installedMod.filename, c.added)));
      } else {
        throw new HttpError(400, "この変更は元に戻せません");
      }
      if (c.configBackup) await restoreConfig(target, p, c.configBackup);
      await db.update(serverChange).set({ undone: true }).where(eq(serverChange.id, c.id));
      await record({ teamId, userId: user.id, kind: "changes", action: "変更を元に戻す", target: row.name, detail: `${c.action}: ${c.title}` });
    },

    /** 外す(サーバーのフォルダーからファイルを消す) */
    async remove(headers: Headers, id: string, filename: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const target = await serverOf(deps, who, id);
      const { row, client, remoteId } = target;
      // フォルダーをまたぐ名前は受け付けず、いまフォルダーにある .jar(無効にしたものを含む)だけを外す
      if (!ADDON.test(filename)) throw new HttpError(400, "ファイルの名前が正しくありません");
      const p = await needProfile(row.id);
      const dir = await dirOf(target, fileProfile(p, filename));
      const present = (await remote(() => client.listFiles(remoteId, dir))).some((f) => f.isFile && f.name === filename);
      if (!present) throw new HttpError(404, "ファイルが見つかりません");
      await removeFrom(target, p, user.id, filename);
      await record({ teamId, userId: user.id, kind: "changes", action: "外す", target: row.name, detail: filename });
    },

    /** 更新を止める・止めるのをやめる(そろえる・予約・更新の確認で、新しい版にしない) */
    async setHold(headers: Headers, id: string, source: string, projectId: string, hold: boolean) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const { row } = await serverOf(deps, who, id);
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
      const who = await requireTeam(auth, headers);
      const { teamId } = who;
      const { row } = await serverOf(deps, who, id);
      return (await updatesOf(row.id, await needProfile(row.id), teamId)).map(({ title: _, ...u }) => u);
    },
  };
}
