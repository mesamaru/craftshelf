// 配布元のファイルを保存先に持つ(v02 と同じ。自分用の版だけ): 保存の設定・版を保存する・まとめて zip・
// 保存先の状況と中身・保存先の inbox/ からの取り込み・古い版の自動整理・アドオンの整理。
// 版は library_file(アップロードしたものと同じ表。配布元のものは upstream_version_id に配布元の版の ID)
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { PLATFORMS } from "~/lib/platforms";
import { isItemSource } from "~/lib/sources";
import { addonSet, addonSetItem, installedMod, libraryFile, libraryItem, server, storageTarget, teamOption } from "./db/schema";
import { eventService } from "./events";
import { cfFingerprint } from "./fingerprint";
import { HttpError, isHttpError, requireTeam } from "./guard";
import { analyzeJar, analyzePack, fileSource } from "./jar";
import { fromSource, libraryService, modTools } from "./library";
import { curseforgeClient } from "./curseforge";
import { pickVersion } from "./modrinth";
import type { Deps } from "./servers";
import type { Entry, Store } from "./storage";
import { UPDATE_CHECK_BATCH, UPDATE_CHECK_EVERY } from "./sets";
import { fromStorage, uploadService } from "./uploads";
import { ZIP_MAX_BYTES, zipStream } from "./zip";

// 古い版を残す数の上限・まとめて zip にする数・中身の一覧の上限・inbox から 1 回に取り込む数
export const SAVED_LIMITS = { keepVersions: 100, zipItems: 500, listEntries: 2000, listDepth: 6, scanFiles: 200 };
// zip の中のフォルダ(種類ごと。v02 と同じ)
const ZIP_DIR: Record<string, string> = { plugin: "plugins", mod: "mods", datapack: "datapacks", resourcepack: "resourcepacks", shader: "shaderpacks", modpack: "modpacks" };
const INBOX = "inbox";
const ADDON_FILE = /\.(jar|zip|mrpack)$/i;
type FileRow = typeof libraryFile.$inferSelect;
type Item = typeof libraryItem.$inferSelect;
export type CleanupCond = "old" | "dup" | "stale" | "unused";

export function savedService(deps: Deps) {
  const { db, auth } = deps;
  const tools = modTools(deps);
  const files = tools.files;
  const uploads = uploadService(deps);
  const library = libraryService(deps);
  const { record } = eventService(deps);
  const needLocal = () => {
    if (!deps.local) throw new HttpError(400, "配布元のファイルの保存は、自分用の版だけで使えます");
  };
  const itemOf = async (teamId: string, itemId: string) => {
    const [i] = await db.select().from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
    if (!i) throw new HttpError(404, "見つかりません");
    return i;
  };
  const cleanKeep = (n: unknown) => {
    const v = Math.floor(Number(n));
    if (!(v >= 0 && v <= SAVED_LIMITS.keepVersions)) throw new HttpError(400, `残す数は 0〜${SAVED_LIMITS.keepVersions} にしてください(0 は整理しない)`);
    return v;
  };
  // 保存先(null はパネルの中)を開く。ほかのチームのものは開けない
  async function targetOf(teamId: string, targetId: string | null) {
    const [t] = targetId ? await db.select().from(storageTarget).where(and(eq(storageTarget.id, targetId), eq(storageTarget.teamId, teamId))) : [null];
    if (targetId && !t) throw new HttpError(404, "保存先が見つかりません");
    return { name: t?.name ?? "パネルの中(既定)", store: await files.storeOf(teamId, targetId) };
  }
  // フォルダの中を下へたどる(深さ・数に上限。隠しファイルは除く)
  async function walk(store: Store, dir: string) {
    const out: (Entry & { path: string })[] = [];
    let truncated = false;
    const visit = async (d: string, depth: number) => {
      for (const e of (await store.ls(d)).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".")) continue;
        if (out.length >= SAVED_LIMITS.listEntries) { truncated = true; return; }
        const path = d ? `${d}/${e.name}` : e.name;
        out.push({ ...e, path });
        if (e.dir && depth < SAVED_LIMITS.listDepth) await visit(path, depth + 1);
      }
    };
    await visit(dir, 0);
    return { entries: out, truncated };
  }

  // 版の一覧から、ファイルを取ってこられるもの(受け取る版・アイテムの動く作りのとおり)。versionId を渡すとその版
  async function upstreamFile(teamId: string, i: Item, versionId?: string) {
    if (!isItemSource(i.source) || i.source === "upload") throw new HttpError(400, "アップロードしたものは、もう保存先にあります");
    if (i.source === "spigot") {
      if (versionId) throw new HttpError(400, "SpigotMC は、いちばん新しい版だけ保存できます");
      const f = await fromSource(() => tools.spiget.latestFile(i.projectId, "paper"));
      if (!f) throw new HttpError(404, "SpigotMC から取ってこられる版がありません(SpigotMC の外で配っているもの・有料のものは保存できません)");
      return f;
    }
    const cf = i.source === "curseforge" ? await tools.curseforge(teamId) : null;
    const list = (await fromSource(() => (cf ? cf.allFiles(i.projectId) : tools.modrinth.allVersions(i.projectId)))).filter((v) => v.url && v.filename);
    let v = versionId ? list.find((x) => x.versionId === versionId) : undefined;
    if (!versionId) {
      const loaders = (() => { try { return i.loaders ? (JSON.parse(i.loaders) as string[]) : null; } catch { return null; } })();
      const want = loaders?.length ? loaders : i.projectType === "datapack" ? ["datapack"]
        : Object.values(PLATFORMS).filter((p) => p.type === i.projectType).flatMap((p) => [...p.loaders]);
      const fit = list.filter((x) => !want.length || x.loaders.some((l) => want.includes(l)));
      const { channel } = await tools.pickOf(teamId, i.source, i.projectId, { platform: "paper", mcVersion: null });
      const all = fit.length ? fit : list;
      const rel = all.filter((x) => x.type === "release");
      const pool = channel === "all" || !rel.length ? all : rel;
      // 同じ時期の版が作りごとに並ぶので、サーバーの作り(Paper など)を、プロキシ(Velocity など)より先に選ぶ
      v = pickVersion(pool.map((x) => ({ ...x, date_published: x.date })), want);
    }
    if (!v) throw new HttpError(404, versionId ? "その版は見つかりません" : "ファイルを取ってこられる版がありません");
    return { versionId: v.versionId, versionNumber: v.versionNumber, filename: v.filename!, url: v.url! };
  }

  // zip に入れる版(アイテムごと: 決めた版、無ければいちばん新しい版)。保存した版の無いものは missing
  async function zipFiles(teamId: string, input: { itemIds?: string[]; setId?: string }) {
    let pairs: { item: Item; pin: string | null }[];
    let name = `craftshelf-${new Date().toISOString().slice(0, 10)}`;
    if (input.setId) {
      const [s] = await db.select().from(addonSet).where(and(eq(addonSet.id, input.setId), eq(addonSet.teamId, teamId)));
      if (!s) throw new HttpError(404, "セットが見つかりません");
      name = s.name;
      pairs = (await db.select({ item: libraryItem, pin: addonSetItem.versionId }).from(addonSetItem).innerJoin(libraryItem, eq(addonSetItem.itemId, libraryItem.id))
        .where(and(eq(addonSetItem.setId, s.id), eq(libraryItem.teamId, teamId))).orderBy(asc(libraryItem.title)));
    } else {
      const ids = [...new Set(input.itemIds ?? [])].slice(0, SAVED_LIMITS.zipItems);
      pairs = ids.length ? (await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), inArray(libraryItem.id, ids))).orderBy(asc(libraryItem.title))).map((item) => ({ item, pin: null })) : [];
    }
    if (!pairs.length) throw new HttpError(400, input.setId ? "セットが空です" : "ダウンロードするものを選んでください");
    const all = await db.select().from(libraryFile).where(inArray(libraryFile.itemId, pairs.map((p) => p.item.id))).orderBy(desc(libraryFile.createdAt));
    const found: { item: Item; file: FileRow }[] = [];
    const missing: string[] = [];
    for (const { item, pin } of pairs) {
      const mine = all.filter((f) => f.itemId === item.id);
      const f = pin ? mine.find((x) => (x.upstreamVersionId || x.id) === pin) : mine[0];
      if (f) found.push({ item, file: f });
      else missing.push(pin ? `${item.title}(固定した版が保存されていません)` : item.title);
    }
    return { name, found, missing };
  }

  return {
    /** 保存の設定(チームの既定)。local = 使えるか(自分用の版だけ) */
    async options(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      return { local: !!deps.local, ...(await files.optionOf(teamId)) };
    },

    /** 保存の設定のチームの既定を決める(保存先を扱える人)。残す数を減らしたら、既定のままのアイテムを整理する */
    async setOptions(headers: Headers, input: { keepFiles: boolean; keepVersions: number }) {
      const { teamId, user } = await requireTeam(auth, headers, { storage: ["manage"] });
      needLocal();
      const keepVersions = cleanKeep(input.keepVersions);
      const set = { keepFiles: !!input.keepFiles, keepVersions, updatedAt: new Date() };
      await db.insert(teamOption).values({ teamId, ...set }).onConflictDoUpdate({ target: teamOption.teamId, set });
      await record({ teamId, userId: user.id, kind: "admin", action: "保存の設定を変える",
        detail: `${set.keepFiles ? "配布元のファイルを保存する" : "配布元のファイルは保存しない"}・${keepVersions ? `新しい方から ${keepVersions} 個残す` : "古い版は整理しない"}` });
      let removed = 0;
      if (keepVersions) {
        for (const i of await db.select({ id: libraryItem.id, keep: libraryItem.keepVersions }).from(libraryItem).where(eq(libraryItem.teamId, teamId))) {
          if (i.keep === null) removed += (await files.prune(teamId, i.id, user.id)).length;
        }
      }
      return { removed };
    },

    /** アイテムごとの保存の設定(編集者以上): keepFiles = "" はチームの既定・on・off。keepVersions = null はチームの既定 */
    async setItem(headers: Headers, itemId: string, input: { keepFiles: string; keepVersions: number | null }) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      const i = await itemOf(teamId, itemId);
      if (!["", "on", "off"].includes(input.keepFiles)) throw new HttpError(400, "保存するかを選んでください");
      const keepVersions = input.keepVersions === null ? null : cleanKeep(input.keepVersions);
      await db.update(libraryItem).set({ keepFiles: input.keepFiles, keepVersions }).where(eq(libraryItem.id, i.id));
      await record({ teamId, userId: user.id, kind: "admin", action: "アイテムの保存の設定を変える", target: i.title,
        detail: `${{ "": "チームの既定", on: "保存する", off: "保存しない" }[input.keepFiles]}・${keepVersions === null ? "残す数はチームの既定" : keepVersions ? `${keepVersions} 個残す` : "整理しない"}` });
      return { removed: await files.prune(teamId, i.id, user.id) };
    },

    /**
     * 1 分ごとに呼ぶ(自分用の版だけ。画面からは呼ばない。v02 の「自動で保存」): 保存を有効にしたアイテム(アイテムの「保存する」か、
     * チームの既定が「保存する」で既定のままのもの)のうち、前に確かめてから 1 日たったものを、新しい版の見回りと同じく 1 回に
     * UPDATE_CHECK_BATCH 件まで、受け取る版のとおりのいちばん新しい版を保存先に取ってくる(保存してあれば何もしない)。取ってきたアイテムの ID を返す
     */
    async tick(now: Date) {
      if (!deps.local) return [];
      const stale = or(isNull(libraryItem.savedCheckedAt), lt(libraryItem.savedCheckedAt, new Date(now.getTime() - UPDATE_CHECK_EVERY)));
      const on = or(eq(libraryItem.keepFiles, "on"), and(eq(libraryItem.keepFiles, ""), eq(teamOption.keepFiles, true)));
      const due = await db.select({ id: libraryItem.id }).from(libraryItem).leftJoin(teamOption, eq(teamOption.teamId, libraryItem.teamId))
        .where(and(ne(libraryItem.source, "upload"), on, stale)).orderBy(sql`${libraryItem.savedCheckedAt} asc nulls first`).limit(UPDATE_CHECK_BATCH);
      const got: string[] = [];
      for (const { id } of due) {
        // 動かす前に時刻を書き換え、ほかのプロセスと同じものを 2 回取ってこない
        const [i] = await db.update(libraryItem).set({ savedCheckedAt: now }).where(and(eq(libraryItem.id, id), stale)).returning();
        if (!i) continue;
        try {
          const f = await upstreamFile(i.teamId, i);
          if (await files.savedOf(i.teamId, i.source, i.projectId, f.versionId)) continue;
          await files.saveUpstream(i.teamId, null, i, f);
          got.push(i.id);
        } catch (e) {
          // 配布元につながらない・取ってこられる版が無いものは、次の日にまた確かめる
          if (!isHttpError(e)) console.error("[保存した版の見回り] 取ってこられませんでした:", e);
        }
      }
      return got;
    },

    /** 配布元の版を保存先に保存する(編集者以上)。versionId を省くと、受け取る版のとおりのいちばん新しい版 */
    async save(headers: Headers, itemId: string, versionId?: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      const i = await itemOf(teamId, itemId);
      const f = await upstreamFile(teamId, i, versionId);
      const row = await files.saveUpstream(teamId, user.id, i, f);
      return { fileId: row.id, filename: row.filename, version: row.version };
    },

    /** まとめてダウンロードする前に: zip に入るもの(保存した版のあるもの)と、入らないもの(保存していないもの) */
    async zipPlan(headers: Headers, input: { itemIds?: string[]; setId?: string }) {
      const { teamId } = await requireTeam(auth, headers);
      needLocal();
      const r = await zipFiles(teamId, input);
      const bytes = r.found.reduce((n, x) => n + x.file.size, 0);
      return { name: r.name, count: r.found.length, bytes, tooBig: bytes > ZIP_MAX_BYTES, missing: r.missing };
    },

    /** 選んだもの・セットの中身を、保存した版から zip にする(少しずつ書く。保存していないものは入れない。チームのメンバー) */
    async zip(headers: Headers, input: { itemIds?: string[]; setId?: string }) {
      const { teamId, user } = await requireTeam(auth, headers);
      needLocal();
      const r = await zipFiles(teamId, input);
      if (!r.found.length) throw new HttpError(400, "保存した版のあるものがありません(「保存する」にするか、版の一覧から保存してください)");
      if (r.found.reduce((n, x) => n + x.file.size, 0) > ZIP_MAX_BYTES) throw new HttpError(400, "まとめると大きすぎます(3.5 GB まで)。分けてダウンロードしてください");
      await record({ teamId, userId: user.id, kind: "admin", action: input.setId ? "セットをダウンロード" : "まとめてダウンロード", target: input.setId ? r.name : `${r.found.length} 件`,
        detail: r.missing.length ? `保存していないもの ${r.missing.length} 件は入れませんでした` : "" });
      const filename = (r.name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "craftshelf") + ".zip";
      return {
        filename, missing: r.missing,
        stream: zipStream(r.found.map(({ item, file }) => ({ name: `${ZIP_DIR[item.projectType] ?? "other"}/${file.filename}`, open: () => files.stream(teamId, file) }))),
      };
    },

    /** 保存先の状況(保存先を扱える人): つながるか・応答の時間・容量と空き(取れるものだけ)・このアプリの使っている数と大きさ */
    async status(headers: Headers, targetId: string | null) {
      const { teamId } = await requireTeam(auth, headers, { storage: ["manage"] });
      needLocal();
      const { name, store } = await targetOf(teamId, targetId);
      const t0 = performance.now();
      let error = "";
      let space = null;
      try {
        await store.ls("");
        space = await store.space().catch(() => null);
      } catch (e) {
        error = e instanceof Error ? e.message : "つながりませんでした";
      }
      const latencyMs = Math.round(performance.now() - t0);
      const rows = await db.select({ size: libraryFile.size, saved: libraryFile.upstreamVersionId }).from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryItem.teamId, teamId), targetId ? eq(libraryFile.targetId, targetId) : isNull(libraryFile.targetId)));
      return {
        name, connected: !error, error, latencyMs: error ? null : latencyMs, space,
        files: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0), saved: rows.filter((r) => r.saved).length,
      };
    },

    /** 保存先の中身(保存先を扱える人): フォルダとファイル(6 段・2000 個まで)。登録しているファイルにはアイテムの名前を付ける */
    async contents(headers: Headers, targetId: string | null) {
      const { teamId } = await requireTeam(auth, headers, { storage: ["manage"] });
      needLocal();
      const { name, store } = await targetOf(teamId, targetId);
      const { entries, truncated } = await fromStorage(() => walk(store, ""));
      const known = new Map((await db.select({ key: libraryFile.storageKey, title: libraryItem.title, saved: libraryFile.upstreamVersionId }).from(libraryFile)
        .innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id))
        .where(and(eq(libraryItem.teamId, teamId), targetId ? eq(libraryFile.targetId, targetId) : isNull(libraryFile.targetId)))).map((r) => [r.key, r]));
      return {
        name, truncated,
        entries: entries.map((e) => ({ path: e.path, dir: e.dir, size: e.size, item: known.get(e.path)?.title ?? null, saved: !!known.get(e.path)?.saved, inbox: e.path.startsWith(`${INBOX}/`) })),
      };
    },

    /**
     * 保存先の inbox/ に置いた .jar・.zip・.mrpack を、ライブラリに取り込む(保存先を扱える人・編集者以上)。
     * 中身から配布元を探し(Modrinth は SHA-1、CurseForge はフィンガープリント)、見つかったものはその配布元の保存した版に、
     * 見つからないものはアップロードしたものにする。取り込んだものは inbox/ から消す(取り込めなかったものは残す)
     */
    async scan(headers: Headers, targetId: string | null) {
      const { teamId, user } = await requireTeam(auth, headers, { storage: ["manage"] });
      await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      const { name, store } = await targetOf(teamId, targetId);
      await fromStorage(async () => { await store.ls(INBOX).then((l) => (l.length ? null : store.put(`${INBOX}/.keep`, new Uint8Array()))); });
      const list = (await fromStorage(() => walk(store, INBOX))).entries.filter((e) => !e.dir && ADDON_FILE.test(e.name)).slice(0, SAVED_LIMITS.scanFiles);
      const dir = join(deps.local!.dataDir, "v03", "tmp");
      mkdirSync(dir, { recursive: true });
      const cfKey = await tools.cfKeyOf(teamId);
      const added: { name: string; title: string; source: string }[] = [];
      const failed: { name: string; message: string }[] = [];
      for (const e of list) {
        const tmp = join(dir, `scan-${randomUUID()}.part`);
        try {
          await fromStorage(async () => pipeline(await store.read(e.path), createWriteStream(tmp)));
          const data = await readFile(tmp);
          const sha1 = createHash("sha1").update(data).digest("hex");
          // 配布元につながらないときは、アップロードしたものとして取り込む
          const mr = (await tools.modrinth.byHashes([sha1]).catch(() => null))?.get(sha1);
          const fp = cfFingerprint(data);
          const cf = !mr && cfKey ? (await curseforgeClient(deps.fetch, cfKey).byFingerprints([fp]).catch(() => null))?.get(fp) : undefined;
          const hit = mr ? { source: "modrinth" as const, ...mr } : cf ? { source: "curseforge" as const, ...cf } : null;
          if (hit) {
            const { source } = hit;
            const info = await tools.project(source, hit.projectId, teamId).catch(() => null);
            const jar = /\.jar$/i.test(e.name);
            const src = fileSource(tmp);
            let local;
            try {
              local = jar ? analyzeJar(src, e.name) : analyzePack(src, e.name);
            } finally {
              src.close();
            }
            const projectType = (local.projectType ?? info?.projectType ?? (jar ? "mod" : "datapack")) as "plugin" | "mod";
            const itemId = await tools.remember(teamId, user.id, source, hit.projectId, { title: info?.title || local.name || e.name, slug: info?.slug ?? "", iconUrl: info?.iconUrl ?? "", projectType });
            const item = (await db.select().from(libraryItem).where(eq(libraryItem.id, itemId)))[0];
            await files.keepSaved(teamId, user.id, item, tmp, { versionId: hit.versionId, versionNumber: hit.versionNumber, filename: e.name }, targetId);
            added.push({ name: e.name, title: item.title, source });
          } else {
            const r = await uploads.ingest(headers, e.name, tmp, { targetId });
            added.push({ name: e.name, title: r.title, source: "upload" });
          }
          await store.remove(e.path).catch(() => {}); // 消せなくても、取り込んだものは使える(次は同じ中身として断る)
        } catch (err) {
          failed.push({ name: e.path, message: err instanceof Error ? err.message : "取り込めませんでした" });
        } finally {
          rmSync(tmp, { force: true });
        }
      }
      await record({ teamId, userId: user.id, kind: "changes", action: "保存先から取り込む", target: name,
        detail: `${added.length} 個を取り込みました${failed.length ? `・${failed.length} 個は取り込めませんでした` : ""}` });
      return { checked: list.length, added, failed };
    },

    /**
     * アドオンの整理(v02 の「アドオンの整理」。編集者以上): 条件に当てはまるものを抜き出す(消すのは cleanupRemove)。
     * old = 新しい方から n 個より古い版・dup = 同じ版の重複・stale = n か月以上更新の無いもの・unused = どのサーバーにも入っていないもの。
     * サーバーに入っている版・セットで固定した版は、版としては出さない
     */
    async cleanup(headers: Headers, cond: CleanupCond, n: number) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      const items = await db.select().from(libraryItem).where(eq(libraryItem.teamId, teamId)).orderBy(asc(libraryItem.title));
      const all = items.length ? await db.select().from(libraryFile).where(inArray(libraryFile.itemId, items.map((i) => i.id))).orderBy(desc(libraryFile.createdAt)) : [];
      type Row = { kind: "version" | "item"; itemId: string; title: string; projectType: string; fileId: string | null; version: string; reason: string; size: number; checked: boolean };
      const out: Row[] = [];
      const sizeOf = (id: string) => all.filter((f) => f.itemId === id).reduce((s, f) => s + f.size, 0);
      const ver = (i: Item, f: FileRow, reason: string): Row => ({ kind: "version", itemId: i.id, title: i.title, projectType: i.projectType, fileId: f.id, version: f.version || f.filename, reason, size: f.size, checked: true });
      const whole = (i: Item, reason: string, checked = true): Row => ({ kind: "item", itemId: i.id, title: i.title, projectType: i.projectType, fileId: null, version: "", reason, size: sizeOf(i.id), checked });
      const keep = Math.max(1, Math.floor(Number(n) || 1));
      if (cond === "old" || cond === "dup") {
        for (const i of items) {
          const mine = all.filter((f) => f.itemId === i.id);
          if (mine.length < 2) continue;
          const kept = await files.keptVersions(teamId, i);
          const free = (f: FileRow) => !kept.has(f.upstreamVersionId || f.id);
          if (cond === "old") {
            for (const f of mine.slice(keep).filter(free)) out.push(ver(i, f, `${f.createdAt.toISOString().slice(0, 10)} に追加`));
          } else {
            const groups = new Map<string, FileRow[]>();
            for (const f of mine) groups.set((f.version || f.filename).trim().toLowerCase(), [...(groups.get((f.version || f.filename).trim().toLowerCase()) ?? []), f]);
            for (const g of groups.values()) for (const f of g.slice(1).filter(free)) out.push(ver(i, f, `${`同じ版が ${g.length} 個`}(いちばん新しく足したものを残します)`));
          }
        }
      } else if (cond === "stale") {
        const months = Math.max(1, Math.floor(Number(n) || 12));
        const since = Date.now() - months * 30.4 * 86_400_000;
        const dates = new Map<string, string>();
        const quiet = async (fn: () => Promise<void>) => { try { await fn(); } catch { /* 配布元につながらなければ、日付なし */ } };
        const mr = items.filter((i) => i.source === "modrinth");
        if (mr.length) await quiet(async () => { for (const [id, p] of await tools.modrinth.projects(mr.map((i) => i.projectId))) dates.set(`modrinth:${id}`, p.updated); });
        const cf = items.filter((i) => i.source === "curseforge");
        const key = cf.length ? await tools.cfKeyOf(teamId) : null;
        if (key) await quiet(async () => { for (const [id, p] of await curseforgeClient(deps.fetch, key).projects(cf.map((i) => i.projectId))) dates.set(`curseforge:${id}`, p.updated); });
        for (const i of items.filter((x) => x.source === "spigot")) await quiet(async () => { const p = await tools.spiget.project(i.projectId); if (p?.updated) dates.set(`spigot:${i.projectId}`, p.updated); });
        for (const i of items) {
          const up = i.source === "upload";
          const d = up ? all.find((f) => f.itemId === i.id)?.createdAt.toISOString() : dates.get(`${i.source}:${i.projectId}`);
          if (d && Date.parse(d) < since) out.push(whole(i, up ? `最後に版を足したのは ${d.slice(0, 10)}` : `配布元の最後の更新は ${d.slice(0, 10)}`));
        }
      } else if (cond === "unused") {
        const used = new Set((await db.select({ source: installedMod.source, projectId: installedMod.projectId }).from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id))
          .where(eq(server.teamId, teamId))).map((r) => `${r.source}:${r.projectId}`));
        const inSets = await db.select({ itemId: addonSetItem.itemId, name: addonSet.name }).from(addonSetItem).innerJoin(addonSet, eq(addonSetItem.setId, addonSet.id)).where(eq(addonSet.teamId, teamId));
        // リソースパック・シェーダー・Modパックはサーバーに入れないので出さない
        for (const i of items.filter((x) => ["plugin", "mod", "datapack"].includes(x.projectType) && !used.has(`${x.source}:${x.projectId}`))) {
          const sets = inSets.filter((s) => s.itemId === i.id).map((s) => s.name);
          out.push(whole(i, sets.length ? `どのサーバーにも入っていません(セット「${sets.join("」「")}」に入っています)` : "どのサーバーにも入っていません", !sets.length));
        }
      } else throw new HttpError(400, "条件を選んでください");
      return out;
    },

    /** アドオンの整理で選んだものを消す(版は保存先からも。アイテムはライブラリから外し、その版も消す。サーバーのファイルはそのまま) */
    async cleanupRemove(headers: Headers, input: { fileIds: string[]; itemIds: string[] }) {
      await requireTeam(auth, headers, { library: ["edit"] });
      let files = 0;
      let items = 0;
      const failed: string[] = [];
      for (const id of [...new Set(input.fileIds)].slice(0, 1000)) {
        try {
          await uploads.removeFile(headers, id);
          files++;
        } catch (e) {
          failed.push(e instanceof Error ? e.message : id);
        }
      }
      for (const id of [...new Set(input.itemIds)].slice(0, 1000)) {
        try {
          await library.removeItem(headers, id);
          items++;
        } catch (e) {
          failed.push(e instanceof Error ? e.message : id);
        }
      }
      return { files, items, failed };
    },
  };
}
