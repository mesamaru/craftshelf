// セット: ライブラリから選んだものの組み合わせ。サーバーにまとめて入れる。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { PLATFORMS } from "~/lib/platforms";
import { addonSet, addonSetItem, installedMod, libraryItem, server, serverHold, serverSet } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { isItemSource } from "~/lib/sources";
import { isDisabled, modTools } from "./library";
import { type EventKind, eventService } from "./events";
import { type Deps, serverOf, needServerAccess, serverScope } from "./servers";

// 無料で使える範囲
export const SET_LIMITS = { setsPerTeam: 50, itemsPerSet: 200 };
// 自動更新を入れたサーバーを確かめる間隔
export const AUTO_UPDATE_EVERY = 6 * 60 * 60_000;
// 新しい版の見回り: 1 台を確かめる間隔と、1 分に確かめる台数(配布元へ問い合わせすぎないように)
export const UPDATE_CHECK_EVERY = 24 * 60 * 60_000;
export const UPDATE_CHECK_BATCH = 2;

// missing・available は「確かめるだけ」のときの、入っていない・新しい版がある
export type ApplyResult = { title: string; status: "installed" | "updated" | "present" | "skipped" | "failed" | "missing" | "available" | "removed"; detail: string };
// add = 足りないものを入れる / sync = それに加えて更新する / check = 確かめるだけ(何も変えない)
export type ApplyMode = "add" | "sync" | "check";
// ほかのサーバーにそろえるときの、そろえ方: update = 入っているものだけ同じ版に / add = 足りないものも入れる / mirror = さらに、そろえる元に無いものを外す
export const COPY_MODES = ["update", "add", "mirror"] as const;
export type CopyMode = (typeof COPY_MODES)[number];
type SetLike = { source: string; projectId: string; title: string; projectType: string };

/** 結果から、記録の種類のほかに知らせる種類: 入れた・更新した・外した → auto、失敗 → errors、新しい版がある → updates */
export function alsoOf(list: ApplyResult[]): EventKind[] {
  const has = (...st: ApplyResult["status"][]) => list.some((x) => st.includes(x.status));
  return [...(has("installed", "updated", "removed") ? ["auto" as const] : []), ...(has("failed") ? ["errors" as const] : []), ...(has("available") ? ["updates" as const] : [])];
}

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 60);
  if (!n) throw new HttpError(400, "セットの名前を入力してください");
  return n;
};

export function setService(deps: Deps) {
  const { db, auth } = deps;
  const { latestFile, fileById, versionsOf, needProfile, installInto, holdsOf, updatesOf, removeFrom } = modTools(deps);
  const { record } = eventService(deps);
  // 結果のまとめ(通知・記録に使う)。変わったもの・失敗したものだけを並べる
  const summary = (list: ApplyResult[]) => {
    const n = (s: ApplyResult["status"]) => list.filter((x) => x.status === s).length;
    const head = n("missing") + n("available")
      ? [`入っていない ${n("missing")}`, `新しい版 ${n("available")}`, `失敗 ${n("failed")}`].join(" / ")
      : [`入れた ${n("installed")}`, `更新 ${n("updated")}`, `失敗 ${n("failed")}`].join(" / ");
    const lines = list.filter((x) => ["installed", "updated", "failed", "missing", "available", "removed"].includes(x.status)).map((x) => `・${x.title}: ${x.detail}`);
    return [head, ...lines].join("\n");
  };

  async function setOf(teamId: string, id: string) {
    const [s] = await db.select().from(addonSet).where(and(eq(addonSet.id, id), eq(addonSet.teamId, teamId)));
    if (!s) throw new HttpError(404, "セットが見つかりません");
    return s;
  }
  // セットの中身(items)をサーバーに入れる(mode は ApplyMode)
  async function applyTo(teamId: string, userId: string | null, items: SetLike[], serverId: string, mode: ApplyMode, removeExtra = false): Promise<ApplyResult[]> {
    const target = await serverOf(deps, teamId, serverId);
    const p = await needProfile(target.row.id);
    const type = PLATFORMS[p.platform].type;
    const records = await db.select().from(installedMod).where(eq(installedMod.serverId, target.row.id));
    const present = new Map(records.map((r) => [`${r.source}:${r.projectId}`, r]));
    const holds = await holdsOf(target.row.id);
    const out: ApplyResult[] = [];
    for (const it of items) {
      const now = present.get(`${it.source}:${it.projectId}`);
      if (!isItemSource(it.source)) continue;
      if (it.projectType !== type) {
        out.push({ title: it.title, status: "skipped", detail: `${it.projectType === "mod" ? "Mod " : "プラグイン"}なので、${PLATFORMS[p.platform].label} のサーバーには入れません` });
        continue;
      }
      try {
        if (!now && mode === "check") {
          out.push({ title: it.title, status: "missing", detail: "入っていません" });
        } else if (!now) {
          const r = await installInto(teamId, userId, target, p, it.source, it.projectId);
          out.push({ title: it.title, status: "installed", detail: r.versionNumber });
          for (const d of r.deps) out.push({ title: d.title, status: d.ok ? "installed" : "failed", detail: d.ok ? `${d.detail}(${it.title} の前提)` : d.detail });
        } else if (mode === "add") {
          out.push({ title: it.title, status: "present", detail: "入っています" });
        } else if (isDisabled(now.filename)) {
          out.push({ title: it.title, status: "present", detail: `無効にしています(${now.versionNumber})` });
        } else if (holds.has(`${it.source}:${it.projectId}`)) {
          out.push({ title: it.title, status: "present", detail: `更新を止めています(${now.versionNumber})` });
        } else {
          const latest = await latestFile(it.source, it.projectId, p, teamId);
          if (!latest || latest.versionId === now.versionId) {
            out.push({ title: it.title, status: "present", detail: `最新です(${now.versionNumber})` });
          } else if (mode === "check") {
            out.push({ title: it.title, status: "available", detail: `${now.versionNumber} → ${latest.versionNumber}` });
          } else {
            const r = await installInto(teamId, userId, target, p, it.source, it.projectId);
            out.push({ title: it.title, status: "updated", detail: `${now.versionNumber} → ${r.versionNumber}` });
          }
        }
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        out.push({ title: it.title, status: "failed", detail: e.message });
      }
    }
    // セットに無いもの(このアプリで入れたものだけ。手で置いたファイルは触らない)を外す
    if (removeExtra && mode === "sync") await removeExtras(target, p, userId, records, new Set(items.map((it) => `${it.source}:${it.projectId}`)), out);
    return out;
  }

  // keep に無いもの(このアプリで入れたもの)を、1 つずつ外す(消さずに名前を変えて残し、変更の履歴から元に戻せる)
  async function removeExtras(target: Awaited<ReturnType<typeof serverOf>>, p: Awaited<ReturnType<typeof needProfile>>, userId: string | null,
    records: (typeof installedMod.$inferSelect)[], keep: Set<string>, out: ApplyResult[]) {
    for (const r of records.filter((x) => !keep.has(`${x.source}:${x.projectId}`))) {
      try {
        await removeFrom(target, p, userId, r.filename);
        out.push({ title: r.title, status: "removed", detail: r.filename });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        out.push({ title: r.title, status: "failed", detail: `外せませんでした(${e.message})` });
      }
    }
  }

  /**
   * from のサーバーの構成(このアプリで入れたもの。無効にしたものは除く)を、serverId のサーバーに同じ版でそろえる。
   * 版を変えたもの・入れたものだけを結果に載せる。止めているもの・無効にしたものは変えない
   */
  async function copyInto(teamId: string, userId: string | null, from: { type: string; rows: (typeof installedMod.$inferSelect)[]; holds: Set<string> }, serverId: string, mode: CopyMode) {
    const target = await serverOf(deps, teamId, serverId);
    const p = await needProfile(target.row.id);
    if (PLATFORMS[p.platform].type !== from.type) throw new HttpError(400, "プラグインのサーバーと Mod のサーバーはそろえられません");
    const records = await db.select().from(installedMod).where(eq(installedMod.serverId, target.row.id));
    const present = new Map(records.map((r) => [`${r.source}:${r.projectId}`, r]));
    const holds = await holdsOf(target.row.id);
    const out: ApplyResult[] = [];
    for (const s of from.rows) {
      const key = `${s.source}:${s.projectId}`;
      const now = present.get(key);
      if (!isItemSource(s.source) || (!now && mode === "update") || now?.versionId === s.versionId) continue;
      if (now && isDisabled(now.filename)) {
        out.push({ title: s.title, status: "present", detail: `無効にしています(${now.versionNumber})` });
        continue;
      }
      if (now && holds.has(key)) {
        out.push({ title: s.title, status: "present", detail: `更新を止めています(${now.versionNumber})` });
        continue;
      }
      try {
        // そろえる元と同じ版を、このサーバーの種類・バージョンに合うときだけ入れる。SpigotMC はいちばん新しい版だけ
        const file = s.source === "spigot" ? await latestFile(s.source, s.projectId, p, teamId)
          : (await versionsOf(s.source, s.projectId, p, teamId)).some((v) => v.versionId === s.versionId) ? await fileById(s.source, s.projectId, s.versionId, teamId) : null;
        if (!file || file.versionId !== s.versionId) {
          out.push({ title: s.title, status: "failed", detail: s.source === "spigot" ? `SpigotMC のものは、いちばん新しい版しか入れられません(${s.versionNumber})` : `${s.versionNumber} は、このサーバーの種類・バージョンに合いません` });
          continue;
        }
        const r = await installInto(teamId, userId, target, p, s.source, s.projectId, { file, depth: 0 });
        // そろえる元で更新を止めているもの(古い版にしたもの)は、こちらでも止める(自動更新・予約で戻されないように)
        if (from.holds.has(key)) await db.insert(serverHold).values({ serverId: target.row.id, source: s.source, projectId: s.projectId, createdBy: userId }).onConflictDoNothing();
        out.push({ title: s.title, status: now ? "updated" : "installed", detail: now ? `${now.versionNumber} → ${r.versionNumber}` : r.versionNumber });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        out.push({ title: s.title, status: "failed", detail: e.message });
      }
    }
    if (mode === "mirror") await removeExtras(target, p, userId, records, new Set(from.rows.map((r) => `${r.source}:${r.projectId}`)), out);
    return out;
  }

  const serverName = async (serverId: string) => (await db.select({ name: server.name }).from(server).where(eq(server.id, serverId)))[0]?.name ?? "";
  async function serverInTeam(teamId: string, serverId: string) {
    const [srv] = await db.select({ id: server.id }).from(server).where(and(eq(server.id, serverId), eq(server.teamId, teamId)));
    if (!srv) throw new HttpError(404, "サーバーが見つかりません");
  }
  const itemsOf = (setId: string) => db.select({ id: libraryItem.id, source: libraryItem.source, projectId: libraryItem.projectId, title: libraryItem.title, projectType: libraryItem.projectType, iconUrl: libraryItem.iconUrl })
    .from(addonSetItem).innerJoin(libraryItem, eq(addonSetItem.itemId, libraryItem.id))
    .where(eq(addonSetItem.setId, setId)).orderBy(asc(libraryItem.title));

  return {
    /** チームのセットと、それぞれに入っているもの */
    async list(headers: Headers) {
      const who = await requireTeam(auth, headers);
      const { teamId } = who;
      const scope = await serverScope(deps, who);
      const sets = await db.select().from(addonSet).where(eq(addonSet.teamId, teamId)).orderBy(asc(addonSet.name));
      const bound = await db.select({ setId: serverSet.setId, id: server.id, name: server.name }).from(serverSet)
        .innerJoin(server, eq(serverSet.serverId, server.id)).where(eq(server.teamId, teamId)).orderBy(asc(server.name));
      return Promise.all(sets.map(async (s) => ({
        id: s.id, name: s.name, items: await itemsOf(s.id),
        servers: bound.filter((b) => b.setId === s.id && (!scope || scope.has(b.id))).map(({ id, name }) => ({ id, name })),
      })));
    },

    /** セットを作る */
    async create(headers: Headers, name: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const n = cleanName(name);
      const [{ c }] = await db.select({ c: count() }).from(addonSet).where(eq(addonSet.teamId, teamId));
      if (c >= SET_LIMITS.setsPerTeam) throw new HttpError(400, `セットは ${SET_LIMITS.setsPerTeam} 個まで作れます`);
      const id = randomUUID();
      await db.insert(addonSet).values({ id, teamId, name: n, createdBy: user.id });
      await record({ teamId, userId: user.id, kind: "admin", action: "セットを作る", target: n });
      return { id };
    },

    /** 名前を変える */
    async rename(headers: Headers, id: string, name: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const before = await setOf(teamId, id);
      const n = cleanName(name);
      await db.update(addonSet).set({ name: n }).where(eq(addonSet.id, id));
      await record({ teamId, userId: user.id, kind: "admin", action: "セットの名前を変える", target: `${before.name} → ${n}` });
    },

    /** セットを消す(ライブラリとサーバーはそのまま) */
    async remove(headers: Headers, id: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const set = await setOf(teamId, id);
      await db.delete(addonSet).where(eq(addonSet.id, id));
      await record({ teamId, userId: user.id, kind: "admin", action: "セットを消す", target: set.name });
    },

    /** ライブラリのものをセットに入れる・外す */
    async toggleItem(headers: Headers, id: string, itemId: string, add: boolean) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      await setOf(teamId, id);
      if (!add) {
        await db.delete(addonSetItem).where(and(eq(addonSetItem.setId, id), eq(addonSetItem.itemId, itemId)));
        return;
      }
      const [item] = await db.select({ id: libraryItem.id }).from(libraryItem).where(and(eq(libraryItem.id, itemId), eq(libraryItem.teamId, teamId)));
      if (!item) throw new HttpError(404, "ライブラリに見つかりません");
      const [{ c }] = await db.select({ c: count() }).from(addonSetItem).where(eq(addonSetItem.setId, id));
      if (c >= SET_LIMITS.itemsPerSet) throw new HttpError(400, `1 つのセットに入れられるのは ${SET_LIMITS.itemsPerSet} 件までです`);
      await db.insert(addonSetItem).values({ setId: id, itemId }).onConflictDoNothing();
    },

    /**
     * セットの中身をサーバーに入れる。サーバーの種類に合うもので、まだ入っていないものだけを入れる
     * (Paper のサーバーに Mod は入れない)。1 件ずつ結果を返し、失敗しても残りは続ける
     */
    async apply(headers: Headers, id: string, serverId: string): Promise<ApplyResult[]> {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      const set = await setOf(teamId, id);
      await serverInTeam(teamId, serverId);
      await needServerAccess(deps, who, serverId);
      const r = await applyTo(teamId, user.id, await itemsOf(set.id), serverId, "add");
      await record({ teamId, userId: user.id, kind: "sets", action: "セットを入れる", target: `${set.name} → ${await serverName(serverId)}`, detail: summary(r) });
      return r;
    },

    /** サーバーにセットを結び付ける(setId が null なら外す)。結び付けるのは 1 台に 1 つ */
    async bind(headers: Headers, serverId: string, setId: string | null) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      await serverInTeam(teamId, serverId);
      await needServerAccess(deps, who, serverId);
      if (!setId) {
        await db.delete(serverSet).where(eq(serverSet.serverId, serverId));
        await record({ teamId, userId: user.id, kind: "admin", action: "セットの結び付けを外す", target: await serverName(serverId) });
        return;
      }
      const set = await setOf(teamId, setId);
      const values = { serverId, setId, updatedAt: new Date() };
      await db.insert(serverSet).values(values).onConflictDoUpdate({ target: serverSet.serverId, set: values });
      await record({ teamId, userId: user.id, kind: "admin", action: "セットを結び付ける", target: `${await serverName(serverId)} ← ${set.name}` });
    },

    /** 結び付けたセットでそろえる: 足りないものを入れ、入っているものに新しい版があれば更新する */
    async sync(headers: Headers, serverId: string, removeExtra = false): Promise<ApplyResult[]> {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      await serverInTeam(teamId, serverId); // ほかのチームのサーバーは「見つからない」
      await needServerAccess(deps, who, serverId);
      const [b] = await db.select({ setId: serverSet.setId }).from(serverSet).where(eq(serverSet.serverId, serverId));
      if (!b) throw new HttpError(400, "このサーバーにはセットを結び付けていません");
      const set = await setOf(teamId, b.setId);
      const r = await applyTo(teamId, user.id, await itemsOf(set.id), serverId, "sync", removeExtra);
      await record({ teamId, userId: user.id, kind: "sets", action: "セットでそろえる", target: `${await serverName(serverId)}(${set.name})`, detail: summary(r) });
      return r;
    },

    /**
     * 予約で動かす(画面からは呼ばない。権限の確認は予約を決めたときに済ませている)。
     * セットを結び付けたチームのサーバーを 1 台ずつそろえる・確かめる。1 台が失敗しても残りは続ける
     */
    async runForSchedule(teamId: string, mode: "sync" | "check") {
      const bound = await db.select({ serverId: serverSet.serverId, setId: serverSet.setId, name: server.name, setName: addonSet.name })
        .from(serverSet).innerJoin(server, eq(serverSet.serverId, server.id)).innerJoin(addonSet, eq(serverSet.setId, addonSet.id))
        .where(eq(server.teamId, teamId)).orderBy(asc(server.name));
      const out: { server: string; set: string; results: ApplyResult[]; error: string }[] = [];
      for (const b of bound) {
        try {
          out.push({ server: b.name, set: b.setName, results: await applyTo(teamId, null, await itemsOf(b.setId), b.serverId, mode), error: "" });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          out.push({ server: b.name, set: b.setName, results: [], error: e.message });
        }
      }
      return { servers: out, summary };
    },

    /**
     * from のサーバーの構成(このアプリで入れたもの)を、ほかのサーバー(to)にそろえる(編集者以上)。
     * 検証用のサーバーで試した構成を、本番のサーバーへ反映するのにも使う。1 台が失敗しても残りは続ける
     */
    async copy(headers: Headers, fromId: string, toIds: string[], mode: string) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { teamId, user } = who;
      if (!(COPY_MODES as readonly string[]).includes(mode)) throw new HttpError(400, "そろえ方を選んでください");
      const ids = [...new Set(toIds)].filter((x) => x !== fromId);
      if (!ids.length) throw new HttpError(400, "そろえる先のサーバーを選んでください");
      const src = await serverOf(deps, who, fromId);
      const targets = [];
      for (const id of ids) targets.push((await serverOf(deps, who, id)).row); // 変える前に、どれも使えるサーバーか確かめる
      const sp = await needProfile(src.row.id);
      const from = {
        type: PLATFORMS[sp.platform].type,
        rows: (await db.select().from(installedMod).where(eq(installedMod.serverId, src.row.id)).orderBy(asc(installedMod.title))).filter((r) => !isDisabled(r.filename)),
        holds: await holdsOf(src.row.id),
      };
      const out: { serverId: string; server: string; results: ApplyResult[]; error: string }[] = [];
      for (const t of targets) {
        let results: ApplyResult[] = [];
        let error = "";
        try {
          results = await copyInto(teamId, user.id, from, t.id, mode as CopyMode);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          error = e.message;
        }
        out.push({ serverId: t.id, server: t.name, results, error });
        await record({ teamId, userId: user.id, kind: "sets", action: "ほかのサーバーにそろえる", target: `${src.row.name} → ${t.name}`, detail: error || summary(results) });
      }
      return out;
    },

    /** 自動更新を入れる・やめる(編集者以上): 入れたサーバーは 6 時間ごとに、新しい版があれば入れる */
    async setAutoUpdate(headers: Headers, serverId: string, on: boolean) {
      const who = await requireTeam(auth, headers, { library: ["edit"] });
      const { row } = await serverOf(deps, who, serverId);
      await db.update(server).set({ autoUpdate: on }).where(eq(server.id, row.id));
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: on ? "自動更新を入れる" : "自動更新をやめる", target: row.name });
    },

    /**
     * 自動更新(1 分ごとに呼ぶ。画面からは呼ばない): 自動更新を入れたサーバーのうち、前に確かめてから 6 時間たったものを、
     * 入っているものに新しい版があれば更新する(止めたもの・無効にしたものは除く)。何か変えたとき・失敗したときだけ記録する
     */
    async runAutoUpdates(now: Date) {
      // 動かす前に時刻を書き換え、ほかのプロセスと同じサーバーを 2 回動かさない
      const due = await db.update(server).set({ autoUpdatedAt: now })
        .where(and(eq(server.autoUpdate, true), or(isNull(server.autoUpdatedAt), lt(server.autoUpdatedAt, new Date(now.getTime() - AUTO_UPDATE_EVERY)))))
        .returning({ id: server.id, teamId: server.teamId, name: server.name });
      for (const s of due) {
        try {
          const records = await db.select().from(installedMod).where(eq(installedMod.serverId, s.id));
          const type = PLATFORMS[(await needProfile(s.id)).platform].type;
          const r = await applyTo(s.teamId, null, records.map((x) => ({ source: x.source, projectId: x.projectId, title: x.title, projectType: type })), s.id, "sync");
          if (r.some((x) => x.status !== "present")) await record({ teamId: s.teamId, userId: null, kind: "schedule", also: alsoOf(r), action: "自動更新", target: s.name, detail: summary(r) });
        } catch (e) {
          if (!(e instanceof HttpError)) console.error("[自動更新] 動かせませんでした:", e);
          else await record({ teamId: s.teamId, userId: null, kind: "schedule", also: ["errors"], action: "自動更新", target: s.name, detail: `できませんでした: ${e.message}` });
        }
      }
      return due.map((s) => s.id);
    },

    /**
     * 新しい版の見回り(1 分ごとに呼ぶ。画面からは呼ばない): 前に確かめてから 1 日たったサーバーを、1 回に UPDATE_CHECK_BATCH 台まで確かめ、
     * 前に知らせていない新しい版があれば記録する(知らせる種類 updates)。自動更新を入れたサーバーは、そちらで入るので見ない
     */
    async runUpdateChecks(now: Date) {
      const stale = or(isNull(server.updateCheckedAt), lt(server.updateCheckedAt, new Date(now.getTime() - UPDATE_CHECK_EVERY)));
      const due = await db.select({ id: server.id }).from(server).where(and(eq(server.autoUpdate, false), stale)).limit(UPDATE_CHECK_BATCH);
      const found: string[] = [];
      for (const { id } of due) {
        // 動かす前に時刻を書き換え、ほかのプロセスと同じサーバーを 2 回確かめない
        const [s] = await db.update(server).set({ updateCheckedAt: now }).where(and(eq(server.id, id), stale))
          .returning({ id: server.id, teamId: server.teamId, name: server.name, notice: server.updateNotice });
        if (!s) continue;
        try {
          const lines = (await updatesOf(s.id, await needProfile(s.id), s.teamId, true)).map((u) => `・${u.title}: ${u.current} → ${u.latest}`);
          const before = new Set(s.notice.split("\n"));
          const fresh = lines.filter((l) => !before.has(l));
          await db.update(server).set({ updateNotice: lines.join("\n") }).where(eq(server.id, s.id));
          if (fresh.length) {
            await record({ teamId: s.teamId, userId: null, kind: "updates", action: "新しいバージョンがあります", target: s.name, detail: fresh.join("\n") });
            found.push(s.id);
          }
        } catch (e) {
          if (!(e instanceof HttpError)) console.error("[新しい版の見回り] 確かめられませんでした:", e); // 種類を決めていないサーバーなどは飛ばす
        }
      }
      return found;
    },
  };
}
