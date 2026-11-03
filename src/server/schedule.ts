// 予約: 決めた曜日・時刻に、セットを結び付けたチームのサーバーをそろえる(または確かめるだけ)。
// 1 分ごとに tick を呼ぶ(src/server/startup.ts)。同じ分に 2 回動かないよう、動かす前に last_run_at を書き換える
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { teamSchedule } from "./db/schema";
import { eventService } from "./events";
import { HttpError, requireTeam } from "./guard";
import type { Deps } from "./servers";
import type { setService } from "./sets";

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

export function scheduleService(deps: Deps, sets: ReturnType<typeof setService>) {
  const { db, auth } = deps;
  const { record } = eventService(deps);

  async function run(teamId: string, mode: Mode) {
    const { servers, summary } = await sets.runForSchedule(teamId, mode);
    const lines = servers.map((s) => (s.error ? `■ ${s.server}: ${s.error}` : `■ ${s.server}(${s.set}): ${summary(s.results).split("\n")[0]}`));
    const changed = servers.filter((s) => s.error || s.results.some((r) => !["present", "skipped"].includes(r.status)));
    const detail = [lines.join("\n"), ...changed.filter((s) => !s.error).map((s) => `\n${s.server}\n${summary(s.results).split("\n").slice(1).join("\n")}`)].join("\n");
    await record({
      teamId, userId: null, kind: "schedule", action: mode === "sync" ? "予約でそろえる" : "予約で更新を確かめる",
      target: `${servers.length} 台`, detail: servers.length ? detail : "セットを結び付けたサーバーがありません",
    });
    return servers;
  }

  return {
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
