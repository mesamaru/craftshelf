// 共有リンク(アップロードした版・保存した配布元の版を、ログインしていない人にも渡す。自分用の版だけ)と、チームの利用状況。
// リンクのトークンはハッシュだけを保存し、期限を過ぎたものは渡さない
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import { addonSet, auditLog, installedMod, libraryFile, libraryItem, member, server, shareLink, storageTarget, user } from "./db/schema";
import { eventService } from "./events";
import { HttpError, allowed, requireTeam } from "./guard";
import type { Deps } from "./servers";
import { fileStore } from "./uploads";
import { zipStream } from "./zip";

// 期限は 1 時間〜30 日か、無期限(hours = 0。共有リンクは自分用の版だけなので、無期限も自分用の版だけ)。回数の上限は 1〜1000 回か、なし
export const SHARE_LIMITS = { maxHours: 24 * 30, filesPerLink: 100, linksPerTeam: 200, maxDownloads: 1000 };
const FOREVER = new Date("9999-12-31T00:00:00Z"); // 無期限(前の版でも「期限内」として読めるよう、空にはしない)
const isForever = (d: Date) => d.getUTCFullYear() >= 9999;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const safeZipName = (s: string) => (s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "craftshelf") + ".zip";

export function shareService(deps: Deps) {
  const { db, auth } = deps;
  const { stream } = fileStore(deps);
  const { record } = eventService(deps);
  const needLocal = () => {
    if (!deps.local) throw new HttpError(400, "共有リンクは、自分用の版だけで使えます");
  };

  return {
    /** 共有リンクを作る(アップロードしたもの・保存した配布元の版の、いちばん新しい版)。URL はこのときだけ返す */
    async create(headers: Headers, input: { itemIds: string[]; hours: number; name: string; maxDownloads?: number | null }, origin: string) {
      const { teamId, user: me } = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      const forever = input.hours === 0;
      const hours = Math.max(1, Math.min(SHARE_LIMITS.maxHours, Math.floor(Number(input.hours) || 168)));
      const max = input.maxDownloads == null ? null : Math.floor(Number(input.maxDownloads));
      if (max !== null && !(max >= 1 && max <= SHARE_LIMITS.maxDownloads)) throw new HttpError(400, `回数の上限は 1〜${SHARE_LIMITS.maxDownloads} 回にしてください`);
      const ids = [...new Set(input.itemIds)].slice(0, SHARE_LIMITS.filesPerLink);
      if (!ids.length) throw new HttpError(400, "共有するものを選んでください");
      const items = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), inArray(libraryItem.id, ids)));
      const files: (typeof libraryFile.$inferSelect)[] = [];
      for (const it of items) {
        const [f] = await db.select().from(libraryFile).where(eq(libraryFile.itemId, it.id)).orderBy(desc(libraryFile.createdAt)).limit(1);
        if (f) files.push(f);
      }
      if (!files.length) throw new HttpError(400, "共有できるのは、アップロードしたもの・保存した版があるものだけです");
      const [{ n }] = await db.select({ n: count() }).from(shareLink).where(eq(shareLink.teamId, teamId));
      if (n >= SHARE_LIMITS.linksPerTeam) throw new HttpError(400, `共有リンクは ${SHARE_LIMITS.linksPerTeam} 個までです。古いものを消してください`);
      const named = items.filter((i) => files.some((f) => f.itemId === i.id));
      const name = String(input.name ?? "").trim().slice(0, 80) || (named.length > 1 ? `${named[0].title} ほか ${named.length - 1} 件` : named[0].title);
      // URL の最後をファイル名にしておくと、wget・curl -O でもそのままの名前で保存される
      const filename = files.length === 1 ? files[0].filename : safeZipName(name);
      const token = randomBytes(24).toString("base64url");
      const expiresAt = forever ? FOREVER : new Date(Date.now() + hours * 3600_000);
      await db.insert(shareLink).values({ id: randomUUID(), teamId, tokenHash: hashOf(token), name, fileIds: JSON.stringify(files.map((f) => f.id)), filename, createdBy: me.id, expiresAt, maxDownloads: max });
      await record({ teamId, userId: me.id, kind: "admin", action: "共有リンクを作る", target: name,
        detail: `${files.length} 件・${forever ? "無期限" : `${hours} 時間`}${max ? `・${max} 回まで` : ""}` });
      return { url: `${origin.replace(/\/+$/, "")}/s/${token}/${encodeURIComponent(filename)}`, expiresAt: forever ? null : expiresAt.toISOString(), name, filename };
    },

    /** 共有リンクの一覧(自分が作ったもの。管理者はチームのすべて) */
    async list(headers: Headers) {
      const { teamId, user: me } = await requireTeam(auth, headers);
      const admin = await allowed(auth, headers, { member: ["update"] });
      const rows = await db.select({ s: shareLink, by: user.name }).from(shareLink).leftJoin(user, eq(shareLink.createdBy, user.id))
        .where(and(eq(shareLink.teamId, teamId), ...(admin ? [] : [eq(shareLink.createdBy, me.id)]))).orderBy(desc(shareLink.createdAt));
      const now = Date.now();
      return rows.map(({ s, by }) => ({
        id: s.id, name: s.name, count: (JSON.parse(s.fileIds) as string[]).length, createdBy: by ?? "", createdAt: s.createdAt.toISOString(),
        expiresAt: isForever(s.expiresAt) ? null : s.expiresAt.toISOString(), expired: s.expiresAt.getTime() < now, downloads: s.downloads,
        maxDownloads: s.maxDownloads, used: s.maxDownloads !== null && s.downloads >= s.maxDownloads,
      }));
    },

    /** 共有リンクを止める(作った人か、管理者)。期限を今にして、記録(ダウンロードの回数)は一覧に残す */
    async stop(headers: Headers, id: string) {
      const { teamId, user: me } = await requireTeam(auth, headers);
      const [s] = await db.select().from(shareLink).where(and(eq(shareLink.id, id), eq(shareLink.teamId, teamId)));
      const admin = await allowed(auth, headers, { member: ["update"] });
      if (!s || (s.createdBy !== me.id && !admin)) throw new HttpError(404, "見つかりません");
      await db.update(shareLink).set({ expiresAt: new Date() }).where(eq(shareLink.id, id));
      await record({ teamId, userId: me.id, kind: "admin", action: "共有リンクを止める", target: s.name });
    },

    /** 共有リンクを消す(作った人か、管理者) */
    async remove(headers: Headers, id: string) {
      const { teamId, user: me } = await requireTeam(auth, headers);
      const [s] = await db.select().from(shareLink).where(and(eq(shareLink.id, id), eq(shareLink.teamId, teamId)));
      const admin = await allowed(auth, headers, { member: ["update"] });
      if (!s || (s.createdBy !== me.id && !admin)) throw new HttpError(404, "見つかりません");
      await db.delete(shareLink).where(eq(shareLink.id, id));
      await record({ teamId, userId: me.id, kind: "admin", action: "共有リンクを消す", target: s.name });
    },

    /** リンクからダウンロードする(ログイン不要)。無効・期限切れ・回数を使い切ったものは null。保存先から少しずつ読む(いくつかなら zip を少しずつ作る) */
    async download(token: string) {
      if (!deps.local || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
      const [s] = await db.select().from(shareLink).where(eq(shareLink.tokenHash, hashOf(token)));
      if (!s || s.expiresAt.getTime() < Date.now()) return null;
      const ids = JSON.parse(s.fileIds) as string[];
      const files = ids.length ? await db.select().from(libraryFile).where(inArray(libraryFile.id, ids)) : [];
      if (!files.length) return null;
      // 数えるのと回数の上限の確かめを 1 つの書き込みにする(同時に開かれても、上限を超えて渡さない)
      const counted = await db.update(shareLink).set({ downloads: sql`${shareLink.downloads} + 1` })
        .where(and(eq(shareLink.id, s.id), or(isNull(shareLink.maxDownloads), lt(shareLink.downloads, shareLink.maxDownloads)))).returning({ id: shareLink.id });
      if (!counted.length) return null;
      if (files.length === 1) return { filename: files[0].filename, size: files[0].size, stream: await stream(s.teamId, files[0]) };
      return { filename: s.filename, size: null, stream: zipStream(files.map((f) => ({ name: f.filename, open: () => stream(s.teamId, f) }))) };
    },

    /** チームの利用状況(管理者以上) */
    async usage(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      const items = await db.select({ source: libraryItem.source, n: count() }).from(libraryItem).where(eq(libraryItem.teamId, teamId)).groupBy(libraryItem.source);
      const [files] = await db.select({ n: count(), bytes: sql<number>`coalesce(sum(${libraryFile.size}), 0)` }).from(libraryFile)
        .innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id)).where(eq(libraryItem.teamId, teamId));
      const perTarget = await db.select({ name: storageTarget.name, n: count(), bytes: sql<number>`coalesce(sum(${libraryFile.size}), 0)` })
        .from(libraryFile).innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id)).leftJoin(storageTarget, eq(libraryFile.targetId, storageTarget.id))
        .where(eq(libraryItem.teamId, teamId)).groupBy(storageTarget.name);
      const [servers] = await db.select({ n: count() }).from(server).where(eq(server.teamId, teamId));
      const [installed] = await db.select({ n: count() }).from(installedMod).innerJoin(server, eq(installedMod.serverId, server.id)).where(eq(server.teamId, teamId));
      const [sets] = await db.select({ n: count() }).from(addonSet).where(eq(addonSet.teamId, teamId));
      const [members] = await db.select({ n: count() }).from(member).where(eq(member.organizationId, teamId));
      const [links] = await db.select({ n: count() }).from(shareLink).where(eq(shareLink.teamId, teamId));
      return {
        users: await this.perUser(teamId),
        items: Object.fromEntries(items.map((r) => [r.source, r.n])),
        files: { count: files?.n ?? 0, bytes: Number(files?.bytes ?? 0) },
        storage: perTarget.map((r) => ({ name: r.name ?? "パネルの中(既定)", count: r.n, bytes: Number(r.bytes) })),
        servers: servers.n, installed: installed.n, sets: sets.n, members: members.n, shareLinks: links.n,
      };
    },

    /**
     * ユーザーごとの利用状況(v02 の「ユーザーごとの利用状況」。usage から呼ぶ。チームの中のものだけを数える):
     * 登録したもの(種類ごと)・アップロードした版と容量・作ったセット・共有リンク・操作の数(すべて・30 日)・最後の操作
     */
    async perUser(teamId: string, now = new Date()) {
      const people = await db.select({ id: user.id, name: user.name, email: user.email, role: member.role }).from(member)
        .innerJoin(user, eq(member.userId, user.id)).where(eq(member.organizationId, teamId)).orderBy(asc(member.createdAt));
      const items = await db.select({ by: libraryItem.addedBy, type: libraryItem.projectType, n: count() }).from(libraryItem)
        .where(eq(libraryItem.teamId, teamId)).groupBy(libraryItem.addedBy, libraryItem.projectType);
      const files = await db.select({ by: libraryFile.uploadedBy, n: count(), bytes: sql<number>`coalesce(sum(${libraryFile.size}), 0)` }).from(libraryFile)
        .innerJoin(libraryItem, eq(libraryFile.itemId, libraryItem.id)).where(eq(libraryItem.teamId, teamId)).groupBy(libraryFile.uploadedBy);
      const sets = await db.select({ by: addonSet.createdBy, n: count() }).from(addonSet).where(eq(addonSet.teamId, teamId)).groupBy(addonSet.createdBy);
      const links = await db.select({ by: shareLink.createdBy, n: count() }).from(shareLink).where(eq(shareLink.teamId, teamId)).groupBy(shareLink.createdBy);
      const since = new Date(now.getTime() - 30 * 24 * 3600_000);
      const acts = await db.select({ by: auditLog.userId, n: count(), recent: sql<number>`count(*) filter (where ${gt(auditLog.at, since)})`, last: max(auditLog.at) })
        .from(auditLog).where(eq(auditLog.teamId, teamId)).groupBy(auditLog.userId);
      return people.map((u) => {
        const f = files.find((x) => x.by === u.id);
        const a = acts.find((x) => x.by === u.id);
        const mine = items.filter((x) => x.by === u.id);
        return {
          id: u.id, name: u.name, email: u.email, role: u.role,
          items: mine.reduce((n, x) => n + x.n, 0), types: Object.fromEntries(mine.map((x) => [x.type, x.n])),
          files: f?.n ?? 0, bytes: Number(f?.bytes ?? 0), sets: sets.find((x) => x.by === u.id)?.n ?? 0, shareLinks: links.find((x) => x.by === u.id)?.n ?? 0,
          actions: a?.n ?? 0, recentActions: Number(a?.recent ?? 0), lastActionAt: a?.last ? new Date(a.last).toISOString() : null,
        };
      });
    },
  };
}
