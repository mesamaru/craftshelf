// 時刻のずれ(03.52.01): データベースの既定の now() で入れた時刻も、アプリが渡した時刻も、UTC で保存して正しく読めること。
// それまでの時間帯で入っていた時刻は、0025_time_utc の移行で UTC に直す(アプリが渡していた時刻は触らない)
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "~/server/db";
import * as schema from "~/server/db/schema";

const near = (d: Date, ms = 60_000) => Math.abs(d.getTime() - Date.now()) < ms;
const addTeam = (pg: { exec: (s: string) => Promise<unknown> }) =>
  pg.exec(`insert into organization (id, name, slug, created_at) values ('t1', 'チーム', 't1', now())`);

describe("時刻", () => {
  it("新しいデータベース: 既定の now() で入れた記録の時刻が、いまの時刻として読める", async () => {
    const db = await createDb("pglite:", "drizzle");
    const pg = (db as unknown as { $client: PGlite }).$client;
    expect((await pg.query<{ TimeZone: string }>("show timezone")).rows[0].TimeZone).toBe("UTC");
    await addTeam(pg);
    await db.insert(schema.auditLog).values({ id: "a1", teamId: "t1", userId: null, kind: "admin", action: "試し" });
    const [r] = await db.select().from(schema.auditLog);
    expect(near(r.at)).toBe(true);
    // アプリが渡した時刻もそのまま
    const at = new Date("2026-01-02T03:04:05.678Z");
    await db.insert(schema.teamSchedule).values({ teamId: "t1", lastRunAt: at });
    expect((await db.select().from(schema.teamSchedule))[0].lastRunAt?.toISOString()).toBe(at.toISOString());
  });

  it("前の版のデータ(日本の時間帯で入った時刻)は、移行で UTC に直す。アプリが渡していた時刻は変えない", async () => {
    // 0025 より前までの移行だけを置いたフォルダ
    const dir = mkdtempSync(join(tmpdir(), "cs-mig-"));
    try {
      cpSync("drizzle", dir, { recursive: true });
      rmSync(join(dir, "0025_time_utc.sql"));
      const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 25);
      writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));

      const pg = new PGlite();
      await pg.exec("SET TIME ZONE 'Asia/Tokyo'"); // 前の版を Docker(TZ=Asia/Tokyo)で動かしていたとき
      const db = drizzle(pg, { schema });
      await migrate(db, { migrationsFolder: dir });
      await addTeam(pg);
      await db.insert(schema.auditLog).values({ id: "a1", teamId: "t1", userId: null, kind: "admin", action: "前の版の記録" });
      const before = (await db.select().from(schema.auditLog))[0].at;
      expect(Math.round((before.getTime() - Date.now()) / 3600_000)).toBe(9); // 前の版では 9 時間先に見えていた
      const at = new Date("2026-01-02T03:04:05.678Z");
      await db.insert(schema.teamSchedule).values({ teamId: "t1", lastRunAt: at });

      // 新しい版で起動したとき(createDb と同じ順: 移行を流してから UTC に)
      await migrate(db, { migrationsFolder: "drizzle" });
      await pg.exec("SET TIME ZONE 'UTC'");
      const [r] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.id, "a1"));
      expect(near(r.at)).toBe(true);
      expect((await db.select().from(schema.teamSchedule))[0].lastRunAt?.toISOString()).toBe(at.toISOString());
      // 移行は 1 度だけ
      await migrate(db, { migrationsFolder: "drizzle" });
      expect((await db.select().from(schema.auditLog))[0].at.getTime()).toBe(r.at.getTime());
      await pg.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
