// 共有リンク(アップロードした版を、ログインしていない人にも渡す。自分用の版だけ)と、チームの利用状況。
// リンクのトークンはハッシュだけを保存し、期限を過ぎたものは渡さない
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { addonSet, installedMod, libraryFile, libraryItem, member, server, shareLink, storageTarget, user } from "./db/schema";
import { eventService } from "./events";
import { HttpError, allowed, requireTeam } from "./guard";
import type { Deps } from "./servers";
import { fileStore } from "./uploads";
import { makeZip } from "./zip";

export const SHARE_LIMITS = { maxHours: 24 * 30, filesPerLink: 100, linksPerTeam: 200 };
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const safeZipName = (s: string) => (s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 60) || "craftshelf") + ".zip";

export function shareService(deps: Deps) {
  const { db, auth } = deps;
  const { read } = fileStore(deps);
  const { record } = eventService(deps);
  const needLocal = () => {
    if (!deps.local) throw new HttpError(400, "共有リンクは、自分用の版だけで使えます");
  };

  return {
    /** 共有リンクを作る(アップロードしたものの、いちばん新しい版)。URL はこのときだけ返す */
    async create(headers: Headers, input: { itemIds: string[]; hours: number; name: string }, origin: string) {
      const { teamId, user: me } = await requireTeam(auth, headers, { library: ["edit"] });
      needLocal();
      const hours = Math.max(1, Math.min(SHARE_LIMITS.maxHours, Math.floor(Number(input.hours) || 168)));
      const ids = [...new Set(input.itemIds)].slice(0, SHARE_LIMITS.filesPerLink);
      if (!ids.length) throw new HttpError(400, "共有するものを選んでください");
      const items = await db.select().from(libraryItem).where(and(eq(libraryItem.teamId, teamId), eq(libraryItem.source, "upload"), inArray(libraryItem.id, ids)));
      const files: (typeof libraryFile.$inferSelect)[] = [];
      for (const it of items) {
        const [f] = await db.select().from(libraryFile).where(eq(libraryFile.itemId, it.id)).orderBy(desc(libraryFile.createdAt)).limit(1);
        if (f) files.push(f);
      }
      if (!files.length) throw new HttpError(400, "共有できるのは、アップロードしたものだけです");
      const [{ n }] = await db.select({ n: count() }).from(shareLink).where(eq(shareLink.teamId, teamId));
      if (n >= SHARE_LIMITS.linksPerTeam) throw new HttpError(400, `共有リンクは ${SHARE_LIMITS.linksPerTeam} 個までです。古いものを消してください`);
      const name = String(input.name ?? "").trim().slice(0, 80) || (items.length > 1 ? `${items[0].title} ほか ${items.length - 1} 件` : items[0].title);
      // URL の最後をファイル名にしておくと、wget・curl -O でもそのままの名前で保存される
      const filename = files.length === 1 ? files[0].filename : safeZipName(name);
      const token = randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + hours * 3600_000);
      await db.insert(shareLink).values({ id: randomUUID(), teamId, tokenHash: hashOf(token), name, fileIds: JSON.stringify(files.map((f) => f.id)), filename, createdBy: me.id, expiresAt });
      await record({ teamId, userId: me.id, kind: "admin", action: "共有リンクを作る", target: name, detail: `${files.length} 件・${hours} 時間` });
      return { url: `${origin.replace(/\/+$/, "")}/s/${token}/${encodeURIComponent(filename)}`, expiresAt: expiresAt.toISOString(), name };
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
        expiresAt: s.expiresAt.toISOString(), expired: s.expiresAt.getTime() < now, downloads: s.downloads,
      }));
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

    /** リンクからダウンロードする(ログイン不要)。無効・期限切れは null */
    async download(token: string) {
      if (!deps.local || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
      const [s] = await db.select().from(shareLink).where(eq(shareLink.tokenHash, hashOf(token)));
      if (!s || s.expiresAt.getTime() < Date.now()) return null;
      const ids = JSON.parse(s.fileIds) as string[];
      const files = ids.length ? await db.select().from(libraryFile).where(inArray(libraryFile.id, ids)) : [];
      if (!files.length) return null;
      await db.update(shareLink).set({ downloads: sql`${shareLink.downloads} + 1` }).where(eq(shareLink.id, s.id));
      if (files.length === 1) return { filename: files[0].filename, data: await read(s.teamId, files[0]) };
      const parts = [];
      for (const f of files) parts.push({ name: f.filename, data: await read(s.teamId, f) });
      return { filename: s.filename, data: makeZip(parts) };
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
        items: Object.fromEntries(items.map((r) => [r.source, r.n])),
        files: { count: files?.n ?? 0, bytes: Number(files?.bytes ?? 0) },
        storage: perTarget.map((r) => ({ name: r.name ?? "パネルの中(既定)", count: r.n, bytes: Number(r.bytes) })),
        servers: servers.n, installed: installed.n, sets: sets.n, members: members.n, shareLinks: links.n,
      };
    },
  };
}
