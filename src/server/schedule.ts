// 予約: 決めた曜日・時刻に、セットを結び付けたチームのサーバーをそろえる(または確かめるだけ)。
// サーバーごとの予約(03.55.00 から。v02 の予約同期): 毎日・毎週の時刻に、そのサーバーを最新にする・セットでそろえる。変えたら再起動もできる。
// 1 分ごとに tick・serverTick を呼ぶ(src/server/startup.ts)。同じ分に 2 回動かないよう、動かす前に last_run_at を書き換える
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { server, serverSchedule, teamSchedule } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import { type Deps, remote, serverOf } from "./servers";
import { type ApplyResult, alsoOf, type setService } from "./sets";

export const SCHEDULE_MODES = { check: "更新を確かめるだけ", sync: "セットでそろえる" } as const;
type Mode = keyof typeof SCHEDULE_MODES;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT = { enabled: false, mode: "check" as Mode, time: "04:00", days: [0, 1, 2, 3, 4, 5, 6], tz: "Asia/Tokyo" };
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** その時刻の、その場所での曜日と "HH:MM" */
export function localParts(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: WEEKDAY[p.weekday] ?? -1, time: `${p.hour}:${p.minute}` };
}

const daysOf = (s: string) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  } catch {
    return [];
  }
};

export const SERVER_SCHEDULE_ACTIONS = { update: "入っているものを最新にする", sync: "結び付けたセットでそろえる" } as const;
const SERVER_MODES = ["off", "daily", "weekly"] as const;
const SERVER_DEFAULT = { mode: "off", action: "update", time: "04:00", dow: 0, tz: "Asia/Tokyo", restart: false, lastRunAt: null as Date | null };
const DAYS = "日月火水木金土";

export function scheduleService(deps: Deps, sets: ReturnType<typeof setService>) {
  const { db, auth } = deps;
  const { record } = eventService(deps);

  async function run(teamId: string, mode: Mode) {
    const { servers, summary } = await sets.runForSchedule(teamId, mode);
    const lines = servers.map((s) => (s.error ? `■ ${s.server}: ${s.error}` : `■ ${s.server}(${s.set}): ${summary(s.results).split("\n")[0]}`));
    const changed = servers.filter((s) => s.error || s.results.some((r) => !["present", "skipped"].includes(r.status)));
    const detail = [lines.join("\n"), ...changed.filter((s) => !s.error).map((s) => `\n${s.server}\n${summary(s.results).split("\n").slice(1).join("\n")}`)].join("\n");
    await record({
      teamId, userId: null, kind: "schedule", also: [...alsoOf(servers.flatMap((s) => s.results)), ...(servers.some((s) => s.error) ? ["errors" as const] : [])], action: mode === "sync" ? "予約でそろえる" : "予約で更新を確かめる",
      target: `${servers.length} 台`, detail: servers.length ? detail : "セットを結び付けたサーバーがありません",
    });
    return servers;
  }

  // サーバーごとの予約を動かす。何か変えて、再起動を選んでいれば再起動する。結果はいつも記録し、Discord には何か変えたとき・失敗したときだけ送る
  async function runServer(teamId: string, serverId: string, name: string, action: string, restart: boolean) {
    const label = action === "sync" ? "予約でそろえる" : "予約で最新にする";
    let r: ApplyResult[];
    try {
      r = action === "sync" ? await sets.syncForSchedule(teamId, serverId) : await sets.updateForSchedule(teamId, serverId);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await record({ teamId, userId: null, kind: "schedule", also: ["errors"], action: label, target: name, detail: `できませんでした: ${e.message}` });
      return;
    }
    const changed = r.some((x) => ["installed", "updated", "removed"].includes(x.status));
    let note = "";
    if (restart && changed) {
      try {
        const { client, remoteId } = await serverOf(deps, teamId, serverId);
        await remote(() => client.power(remoteId, "restart"));
        note = "再起動しました";
      } catch (e) {
        note = `再起動できませんでした: ${e instanceof Error ? e.message : ""}`;
      }
    }
    const failed = r.some((x) => x.status === "failed");
    await record({ teamId, userId: null, kind: "schedule", also: [...alsoOf(r), ...(note.startsWith("再起動できません") ? ["errors" as const] : [])], action: label, target: name,
      detail: [changed || failed ? sets.summary(r) : "変えるものはありませんでした", note].filter(Boolean).join("\n"), quiet: !changed && !failed });
  }

  return {
    /** サーバーごとの予約(見るのはメンバー全員。割り当てられたサーバーだけ) */
    async getServer(headers: Headers, serverId: string) {
      const who = await requireTeam(auth, headers);
      const { row } = await serverOf(deps, who, serverId);
      const [s] = await db.select().from(serverSchedule).where(eq(serverSchedule.serverId, row.id));
      const v = s ?? SERVER_DEFAULT;
      return { actions: SERVER_SCHEDULE_ACTIONS, mode: v.mode, action: v.action, time: v.time, dow: v.dow, tz: v.tz, restart: v.restart, lastRunAt: v.lastRunAt?.toISOString() ?? null };
    },

    /** サーバーごとの予約を決める(管理者以上)。tz は画面の時間帯 */
    async setServer(headers: Headers, serverId: string, input: { mode: string; action: string; time: string; dow: number; restart: boolean; tz: string }) {
      const who = await requireTeam(auth, headers, { server: ["update"] });
      const { row } = await serverOf(deps, who, serverId);
      if (!(SERVER_MODES as readonly string[]).includes(input.mode)) throw new HttpError(400, "予約の種類を選んでください");
      if (!(input.action in SERVER_SCHEDULE_ACTIONS)) throw new HttpError(400, "予約でする内容を選んでください");
      if (!TIME.test(input.time)) throw new HttpError(400, "時刻は 04:00 のように入力してください");
      if (!Number.isInteger(input.dow) || input.dow < 0 || input.dow > 6) throw new HttpError(400, "曜日を選んでください");
      try {
        localParts(new Date(), input.tz);
      } catch {
        throw new HttpError(400, "時間帯が正しくありません");
      }
      const values = { serverId: row.id, mode: input.mode, action: input.action, time: input.time, dow: input.dow, tz: input.tz, restart: input.restart, updatedAt: new Date() };
      await db.insert(serverSchedule).values(values).onConflictDoUpdate({ target: serverSchedule.serverId, set: values });
      await record({ teamId: who.teamId, userId: who.user.id, kind: "admin", action: "サーバーの予約を設定", target: row.name,
        detail: input.mode === "off" ? "予約なし" : `${input.mode === "daily" ? "毎日" : `毎週${DAYS[input.dow]}曜`} ${input.time}・${SERVER_SCHEDULE_ACTIONS[input.action as keyof typeof SERVER_SCHEDULE_ACTIONS]}${input.restart ? "・変えたら再起動" : ""}` });
    },

    /** 1 分ごとに呼ぶ。時刻になったサーバーごとの予約を動かす(動かしたサーバーの ID を返す) */
    async serverTick(now: Date) {
      const ran: string[] = [];
      const rows = await db.select({ s: serverSchedule, teamId: server.teamId, name: server.name }).from(serverSchedule)
        .innerJoin(server, eq(serverSchedule.serverId, server.id)).where(ne(serverSchedule.mode, "off"));
      for (const { s, teamId, name } of rows) {
        let local;
        try {
          local = localParts(now, s.tz);
        } catch {
          continue;
        }
        if (local.time !== s.time || (s.mode === "weekly" && local.day !== s.dow)) continue;
        const claimed = await db.update(serverSchedule).set({ lastRunAt: now })
          .where(and(eq(serverSchedule.serverId, s.serverId), or(isNull(serverSchedule.lastRunAt), lt(serverSchedule.lastRunAt, new Date(now.getTime() - 90_000)))))
          .returning({ id: serverSchedule.serverId });
        if (!claimed.length) continue;
        try {
          await runServer(teamId, s.serverId, name, s.action, s.restart);
          ran.push(s.serverId);
        } catch (e) {
          console.error("[サーバーの予約] 動かせませんでした:", e);
        }
      }
      return ran;
    },

    /** 予約の設定(見るのはメンバー全員) */
    async get(headers: Headers) {
      const { teamId } = await requireTeam(auth, headers);
      const [s] = await db.select().from(teamSchedule).where(eq(teamSchedule.teamId, teamId));
      return { modes: SCHEDULE_MODES, ...(s ? { enabled: s.enabled, mode: s.mode as Mode, time: s.time, days: daysOf(s.days), tz: s.tz, lastRunAt: s.lastRunAt?.toISOString() ?? null } : { ...DEFAULT, lastRunAt: null }) };
    },

    /** 予約を決める(管理者以上) */
    async set(headers: Headers, input: { enabled: boolean; mode: string; time: string; days: number[] }) {
      const { teamId, user } = await requireTeam(auth, headers, { server: ["update"] });
      if (!(input.mode in SCHEDULE_MODES)) throw new HttpError(400, "予約でする内容を選んでください");
      if (!TIME.test(input.time)) throw new HttpError(400, "時刻は 04:00 のように入力してください");
      const days = [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (input.enabled && !days.length) throw new HttpError(400, "曜日を 1 つ以上選んでください");
      const values = { teamId, enabled: input.enabled, mode: input.mode, time: input.time, days: JSON.stringify(days), updatedAt: new Date() };
      await db.insert(teamSchedule).values(values).onConflictDoUpdate({ target: teamSchedule.teamId, set: values });
      const names = "日月火水木金土";
      await record({ teamId, userId: user.id, kind: "admin", action: input.enabled ? "予約を設定" : "予約を止める",
        detail: input.enabled ? `${days.map((d) => names[d]).join("")} ${input.time}・${SCHEDULE_MODES[input.mode as Mode]}` : "" });
    },

    /** 1 分ごとに呼ぶ。時刻になったチームの予約を動かす(動かしたチームの ID を返す) */
    async tick(now: Date) {
      const ran: string[] = [];
      for (const s of await db.select().from(teamSchedule).where(eq(teamSchedule.enabled, true))) {
        let local;
        try {
          local = localParts(now, s.tz);
        } catch {
          continue; // 時間帯の名前が壊れていたら動かさない
        }
        if (local.time !== s.time || !daysOf(s.days).includes(local.day)) continue;
        // 同じ分に 2 回動かさない(ほかのプロセスが先に動かしていたら、書き換えられない)
        const claimed = await db.update(teamSchedule).set({ lastRunAt: now })
          .where(and(eq(teamSchedule.teamId, s.teamId), or(isNull(teamSchedule.lastRunAt), lt(teamSchedule.lastRunAt, new Date(now.getTime() - 90_000)))))
          .returning({ teamId: teamSchedule.teamId });
        if (!claimed.length) continue;
        try {
          await run(s.teamId, s.mode as Mode);
          ran.push(s.teamId);
        } catch (e) {
          console.error("[予約] 動かせませんでした:", e);
        }
      }
      return ran;
    },
  };
}
