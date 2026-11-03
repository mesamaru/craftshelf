// セット: ライブラリから選んだものの組み合わせ。サーバーにまとめて入れる。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { PLATFORMS } from "~/lib/platforms";
import { addonSet, addonSetItem, installedMod, libraryItem, server, serverSet } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { isSource } from "~/lib/sources";
import { modTools } from "./library";
import { eventService } from "./events";
import { type Deps, remote, serverOf } from "./servers";

// 無料で使える範囲
export const SET_LIMITS = { setsPerTeam: 50, itemsPerSet: 200 };

// missing・available は「確かめるだけ」のときの、入っていない・新しい版がある
export type ApplyResult = { title: string; status: "installed" | "updated" | "present" | "skipped" | "failed" | "missing" | "available" | "removed"; detail: string };
// add = 足りないものを入れる / sync = それに加えて更新する / check = 確かめるだけ(何も変えない)
export type ApplyMode = "add" | "sync" | "check";

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 60);
  if (!n) throw new HttpError(400, "セットの名前を入力してください");
  return n;
};

export function setService(deps: Deps) {
  const { db, auth } = deps;
  const { latestFile, needProfile, installInto, holdsOf } = modTools(deps);
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
  // セットの中身をサーバーに入れる(mode は ApplyMode)
  async function applyTo(teamId: string, userId: string | null, set: { id: string }, serverId: string, mode: ApplyMode, removeExtra = false): Promise<ApplyResult[]> {
    const target = await serverOf(deps, teamId, serverId);
    const p = await needProfile(target.row.id);
    const type = PLATFORMS[p.platform].type;
    const records = await db.select().from(installedMod).where(eq(installedMod.serverId, target.row.id));
    const present = new Map(records.map((r) => [`${r.source}:${r.projectId}`, r]));
    const holds = await holdsOf(target.row.id);
    const items = await itemsOf(set.id);
    const out: ApplyResult[] = [];
    for (const it of items) {
      const now = present.get(`${it.source}:${it.projectId}`);
      if (!isSource(it.source)) continue;
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
        } else if (mode === "add") {
          out.push({ title: it.title, status: "present", detail: "入っています" });
        } else if (holds.has(`${it.source}:${it.projectId}`)) {
          out.push({ title: it.title, status: "present", detail: `更新を止めています(${now.versionNumber})` });
        } else {
          const latest = await latestFile(it.source, it.projectId, p);
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
    if (removeExtra && mode === "sync") {
      const keep = new Set(items.map((it) => `${it.source}:${it.projectId}`));
      const extra = records.filter((r) => !keep.has(`${r.source}:${r.projectId}`));
      if (extra.length) {
        try {
          await remote(() => target.client.deleteFiles(target.remoteId, PLATFORMS[p.platform].dir, extra.map((r) => r.filename)));
          await db.delete(installedMod).where(inArray(installedMod.id, extra.map((r) => r.id)));
          for (const r of extra) out.push({ title: r.title, status: "removed", detail: r.filename });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          for (const r of extra) out.push({ title: r.title, status: "failed", detail: `外せませんでした(${e.message})` });
        }
      }
    }
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
      const { teamId } = await requireTeam(auth, headers);
      const sets = await db.select().from(addonSet).where(eq(addonSet.teamId, teamId)).orderBy(asc(addonSet.name));
      const bound = await db.select({ setId: serverSet.setId, id: server.id, name: server.name }).from(serverSet)
        .innerJoin(server, eq(serverSet.serverId, server.id)).where(eq(server.teamId, teamId)).orderBy(asc(server.name));
      return Promise.all(sets.map(async (s) => ({
        id: s.id, name: s.name, items: await itemsOf(s.id),
        servers: bound.filter((b) => b.setId === s.id).map(({ id, name }) => ({ id, name })),
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
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const set = await setOf(teamId, id);
      const r = await applyTo(teamId, user.id, set, serverId, "add");
      await record({ teamId, userId: user.id, kind: "sets", action: "セットを入れる", target: `${set.name} → ${await serverName(serverId)}`, detail: summary(r) });
      return r;
    },

    /** サーバーにセットを結び付ける(setId が null なら外す)。結び付けるのは 1 台に 1 つ */
    async bind(headers: Headers, serverId: string, setId: string | null) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      await serverInTeam(teamId, serverId);
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
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      await serverInTeam(teamId, serverId); // ほかのチームのサーバーは「見つからない」
      const [b] = await db.select({ setId: serverSet.setId }).from(serverSet).where(eq(serverSet.serverId, serverId));
      if (!b) throw new HttpError(400, "このサーバーにはセットを結び付けていません");
      const set = await setOf(teamId, b.setId);
      const r = await applyTo(teamId, user.id, set, serverId, "sync", removeExtra);
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
          out.push({ server: b.name, set: b.setName, results: await applyTo(teamId, null, { id: b.setId }, b.serverId, mode), error: "" });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          out.push({ server: b.name, set: b.setName, results: [], error: e.message });
        }
      }
      return { servers: out, summary };
    },
  };
}
