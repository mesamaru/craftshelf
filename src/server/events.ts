// 操作の記録と Discord への通知。どの処理も、選んでいるチームの中だけを読み書きする
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, lt, inArray, or, sql } from "drizzle-orm";
import { auditLog, noticeSeen, organization, teamNotify, user, server } from "./db/schema";
import { HttpError, requireTeam, allowed } from "./guard";
import type { Deps } from "./servers";
import { hint, open, seal } from "./secrets";

// 知らせる種類(記録はすべて残す。Discord に送るのは選んだ種類だけ)
export const EVENT_KINDS = {
  changes: "アドオンの変更(入れる・更新・外す)",
  sets: "セットでそろえた結果",
  schedule: "予約の結果",
  power: "起動・停止",
  admin: "登録と設定の変更",
  updates: "新しいバージョンの発見(サーバーに入っているものの更新)",
  auto: "自動で入れた(自動更新・予約でそろえた)",
  errors: "エラー(予約・自動更新・バックアップの失敗)",
  backup: "バックアップ(作った・失敗)",
  panel: "パネルの更新(v03 の新しい版)",
} as const;
export type EventKind = keyof typeof EVENT_KINDS;
const isKind = (v: unknown): v is EventKind => typeof v === "string" && v in EVENT_KINDS;

// also は、記録の種類のほかに当てはまる知らせる種類(自動更新で入れた → auto、失敗 → errors など)。記録は kind で残す
export type EventInput = { teamId: string; userId: string | null; kind: EventKind; also?: EventKind[]; action: string; target?: string; detail?: string };
// 管理者でない人のお知らせに出す種類
const MEMBER_KINDS: EventKind[] = ["changes", "sets", "schedule", "power", "updates"];
// 人でない操作の名前(予約・自動更新は「予約」、見回りなどは「自動」)
export const actorOf = (kind: string) => (kind === "schedule" ? "予約" : "自動");
// LIKE の \ % _ をそのままの文字として探す
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

// Discord の Webhook の URL だけを受け付ける(ほかのサイトへは送らない)
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;
const sealContext = (teamId: string) => `discord:${teamId}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function eventService(deps: Deps) {
  const { db, auth, secret, fetch } = deps;

  async function send(url: string, content: string) {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
      // メンションはさせない(名前に @everyone などが入っていても知らせない)
      body: JSON.stringify({ username: "CraftShelf", content: clip(content, 1900), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new HttpError(502, `Discord に送れませんでした(HTTP ${res.status})`);
  }

  async function notifyOf(teamId: string) {
    const [n] = await db.select().from(teamNotify).where(eq(teamNotify.teamId, teamId));
    if (!n) return null;
    let kinds: EventKind[] = [];
    try {
      kinds = (JSON.parse(n.kinds) as unknown[]).filter(isKind);
    } catch { /* 壊れていたら送らない */ }
    return { url: open(secret, n.webhookSealed, sealContext(teamId)), hint: n.webhookHint, kinds };
  }

  /** 記録する(選んだ種類なら Discord にも送る)。送れなくても、もとの操作は失敗させない */
  async function record(e: EventInput) {
    await db.insert(auditLog).values({ id: randomUUID(), teamId: e.teamId, userId: e.userId, kind: e.kind, action: e.action, target: clip(e.target ?? "", 200), detail: clip(e.detail ?? "", 2000) });
    try {
      const n = await notifyOf(e.teamId);
      if (!n || ![e.kind, ...(e.also ?? [])].some((k) => n.kinds.includes(k))) return;
      const [u] = e.userId ? await db.select({ name: user.name }).from(user).where(eq(user.id, e.userId)) : [];
      await send(n.url, `**${e.action}**${e.target ? ` ${e.target}` : ""}(${u?.name ?? actorOf(e.kind)})${e.detail ? `\n${e.detail}` : ""}`);
    } catch (err) {
      console.error("[通知] Discord に送れませんでした:", err instanceof Error ? err.message : err);
    }
  }

  return {
    record,

    /** 操作の記録(新しい順。before より前のもの。q で操作・対象・詳しく・人の名前を探す)。見るのは管理者以上 */
    async list(headers: Headers, before?: string, q?: string) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      const at = before ? new Date(before) : null;
      const like = q?.trim() ? likeOf(q.trim().slice(0, 100)) : null;
      const rows = await db.select({ id: auditLog.id, kind: auditLog.kind, action: auditLog.action, target: auditLog.target, detail: auditLog.detail, at: auditLog.at, userName: user.name })
        .from(auditLog).leftJoin(user, eq(auditLog.userId, user.id))
        .where(and(eq(auditLog.teamId, teamId), ...(at && !Number.isNaN(at.getTime()) ? [lt(auditLog.at, at)] : []),
          ...(like ? [or(ilike(auditLog.action, like), ilike(auditLog.target, like), ilike(auditLog.detail, like), ilike(user.name, like))] : [])))
        .orderBy(desc(auditLog.at)).limit(100);
      return rows.map((r) => ({ ...r, at: r.at.toISOString(), userName: r.userName ?? "" }));
    },

    /**
     * お知らせ: 最近の出来事(新しい順 30 件)。管理者以上はすべて、ほかの人はアドオン・セット・予約・起動と停止・新しい版だけ。
     * サーバーを割り当てられている人には、割り当てられたサーバーの名前が入ったもの(と自分の操作)だけを出す
     */
    async recent(headers: Headers) {
      const who = await requireTeam(auth, headers);
      const admin = await allowed(auth, headers, { member: ["update"] });
      const rows = await db.select({ id: auditLog.id, kind: auditLog.kind, action: auditLog.action, target: auditLog.target, detail: auditLog.detail, at: auditLog.at, userId: auditLog.userId, userName: user.name })
        .from(auditLog).leftJoin(user, eq(auditLog.userId, user.id))
        .where(and(eq(auditLog.teamId, who.teamId), ...(admin ? [] : [inArray(auditLog.kind, MEMBER_KINDS)])))
        .orderBy(desc(auditLog.at)).limit(admin ? 30 : 100);
      const { serverScope } = await import("./servers");
      const scope = admin ? null : await serverScope(deps as never, who);
      let names: string[] = [];
      if (scope) names = (await db.select({ id: server.id, name: server.name }).from(server).where(eq(server.teamId, who.teamId))).filter((s) => scope.has(s.id)).map((s) => s.name);
      return rows
        .filter((r) => !scope || r.userId === who.user.id || names.some((n) => r.target.includes(n)))
        .slice(0, 30)
        .map(({ userId: _, ...r }) => ({ ...r, at: r.at.toISOString(), userName: r.userName ?? "" }));
    },

    /** お知らせをどこまで読んだか(利用者ごと。まだなら null) */
    async seen(headers: Headers) {
      const { teamId, user: me } = await requireTeam(auth, headers);
      const [r] = await db.select({ at: noticeSeen.seenAt }).from(noticeSeen).where(and(eq(noticeSeen.userId, me.id), eq(noticeSeen.teamId, teamId)));
      return r?.at.toISOString() ?? null;
    },

    /** ここまで読んだ(先へ進めるだけ。記録の時刻をそのまま受け取る: データベースによっては記録の時刻がずれて見えるので、いまの時刻とは比べない) */
    async markSeen(headers: Headers, at: string) {
      const { teamId, user: me } = await requireTeam(auth, headers);
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, "日時が正しくありません");
      await db.insert(noticeSeen).values({ userId: me.id, teamId, seenAt: d })
        .onConflictDoUpdate({ target: [noticeSeen.userId, noticeSeen.teamId], set: { seenAt: sql`greatest(${noticeSeen.seenAt}, excluded.seen_at)` } });
    },

    /** パネルの新しい版を、すべてのチームに知らせる(自分用の版の見回りで呼ぶ。同じ版は 1 度だけ) */
    async announcePanel(version: string) {
      const target = `v${version}`;
      for (const { id } of await db.select({ id: organization.id }).from(organization)) {
        const [done] = await db.select({ id: auditLog.id }).from(auditLog)
          .where(and(eq(auditLog.teamId, id), eq(auditLog.kind, "panel"), eq(auditLog.target, target))).limit(1);
        if (!done) await record({ teamId: id, userId: null, kind: "panel", action: "パネルの新しい版があります", target, detail: "「アカウント」の「パネルのバージョン」から入れ替えられます" });
      }
    },

    /** Discord への通知の設定(URL は最後の 4 文字だけ)。パネルの更新は自分用の版だけ */
    async notifySettings(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      const n = await notifyOf(teamId).catch(() => null);
      const kinds: Partial<Record<EventKind, string>> = { ...EVENT_KINDS };
      if (!deps.local) delete kinds.panel;
      return { kinds, configured: !!n, hint: n?.hint ?? "", selected: n?.kinds ?? [] };
    },

    /** 設定する(url を空にすると、いまの URL のまま種類だけ変える)。url が null なら通知をやめる */
    async setNotify(headers: Headers, input: { url: string | null; kinds: string[] }) {
      const { teamId, user: me } = await requireTeam(auth, headers, { member: ["update"] });
      if (input.url === null) {
        await db.delete(teamNotify).where(eq(teamNotify.teamId, teamId));
        await record({ teamId, userId: me.id, kind: "admin", action: "Discord への通知をやめる" });
        return;
      }
      const kinds = [...new Set(input.kinds.filter(isKind))];
      const url = input.url.trim();
      const now = await notifyOf(teamId).catch(() => null);
      if (!url && !now) throw new HttpError(400, "Discord の Webhook の URL を入力してください");
      if (url && !WEBHOOK.test(url)) throw new HttpError(400, "Discord の Webhook の URL(https://discord.com/api/webhooks/…)を入力してください");
      const webhook = url || now!.url;
      const values = { teamId, webhookSealed: seal(secret, webhook, sealContext(teamId)), webhookHint: hint(webhook), kinds: JSON.stringify(kinds), updatedAt: new Date() };
      await db.insert(teamNotify).values(values).onConflictDoUpdate({ target: teamNotify.teamId, set: values });
      await record({ teamId, userId: me.id, kind: "admin", action: "Discord への通知を設定", detail: kinds.map((k) => EVENT_KINDS[k]).join("・") || "知らせる種類なし" });
    },

    /** 試しに送る */
    async testNotify(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers, { member: ["update"] });
      const n = await notifyOf(teamId);
      if (!n) throw new HttpError(400, "先に Discord の Webhook の URL を設定してください");
      await send(n.url, "CraftShelf からの試しの通知です");
    },
  };
}

export type Events = ReturnType<typeof eventService>;
