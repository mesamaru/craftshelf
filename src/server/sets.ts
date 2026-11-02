// セット: ライブラリから選んだものの組み合わせ。サーバーにまとめて入れる。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { PLATFORMS } from "~/lib/platforms";
import { addonSet, addonSetItem, installedMod, libraryItem } from "./db/schema";
import { HttpError, requireTeam } from "./guard";
import { modTools } from "./library";
import { type Deps, serverOf } from "./servers";

// 無料で使える範囲
export const SET_LIMITS = { setsPerTeam: 50, itemsPerSet: 200 };

export type ApplyResult = { title: string; status: "installed" | "present" | "skipped" | "failed"; detail: string };

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 60);
  if (!n) throw new HttpError(400, "セットの名前を入力してください");
  return n;
};

export function setService(deps: Deps) {
  const { db, auth } = deps;
  const { needProfile, installInto } = modTools(deps);

  async function setOf(teamId: string, id: string) {
    const [s] = await db.select().from(addonSet).where(and(eq(addonSet.id, id), eq(addonSet.teamId, teamId)));
    if (!s) throw new HttpError(404, "セットが見つかりません");
    return s;
  }
  const itemsOf = (setId: string) => db.select({ id: libraryItem.id, projectId: libraryItem.projectId, title: libraryItem.title, projectType: libraryItem.projectType, iconUrl: libraryItem.iconUrl })
    .from(addonSetItem).innerJoin(libraryItem, eq(addonSetItem.itemId, libraryItem.id))
    .where(eq(addonSetItem.setId, setId)).orderBy(asc(libraryItem.title));

  return {
    /** チームのセットと、それぞれに入っているもの */
    async list(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      const sets = await db.select().from(addonSet).where(eq(addonSet.teamId, teamId)).orderBy(asc(addonSet.name));
      return Promise.all(sets.map(async (s) => ({ id: s.id, name: s.name, items: await itemsOf(s.id) })));
    },

    /** セットを作る */
    async create(headers: Headers, name: string) {
      const { teamId, user } = await requireTeam(auth, headers, { library: ["edit"] });
      const n = cleanName(name);
      const [{ c }] = await db.select({ c: count() }).from(addonSet).where(eq(addonSet.teamId, teamId));
      if (c >= SET_LIMITS.setsPerTeam) throw new HttpError(400, `セットは ${SET_LIMITS.setsPerTeam} 個まで作れます`);
      const id = randomUUID();
      await db.insert(addonSet).values({ id, teamId, name: n, createdBy: user.id });
      return { id };
    },

    /** 名前を変える */
    async rename(headers: Headers, id: string, name: string) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      await setOf(teamId, id);
      await db.update(addonSet).set({ name: cleanName(name) }).where(eq(addonSet.id, id));
    },

    /** セットを消す(ライブラリとサーバーはそのまま) */
    async remove(headers: Headers, id: string) {
      const { teamId } = await requireTeam(auth, headers, { library: ["edit"] });
      await setOf(teamId, id);
      await db.delete(addonSet).where(eq(addonSet.id, id));
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
      const target = await serverOf(deps, teamId, serverId);
      const p = await needProfile(target.row.id);
      const type = PLATFORMS[p.platform].type;
      const present = new Set((await db.select({ projectId: installedMod.projectId }).from(installedMod)
        .where(and(eq(installedMod.serverId, target.row.id), eq(installedMod.source, "modrinth")))).map((r) => r.projectId));
      const out: ApplyResult[] = [];
      for (const it of await itemsOf(set.id)) {
        if (it.projectType !== type) {
          out.push({ title: it.title, status: "skipped", detail: `${it.projectType === "mod" ? "Mod" : "プラグイン"}なので、${PLATFORMS[p.platform].label} のサーバーには入れません` });
        } else if (present.has(it.projectId)) {
          out.push({ title: it.title, status: "present", detail: "入っています" });
        } else {
          try {
            const r = await installInto(teamId, user.id, target, p, it.projectId);
            out.push({ title: it.title, status: "installed", detail: r.versionNumber });
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            out.push({ title: it.title, status: "failed", detail: e.message });
          }
        }
      }
      return out;
    },
  };
}
