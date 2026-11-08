// パネルのバックアップと復元(自分用の版・PGlite)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingReimport, applyPendingRestore, backupService } from "~/server/backup";
import { HttpError } from "~/server/guard";
import { localParts } from "~/server/schedule";
import { uploadService } from "~/server/uploads";
import { setup } from "./helpers";

const SECRET = "test-secret-0123456789-0123456789-abcd";
// tar とデータベースの書き出し・読み込みは、ほかのテストと並べて動かすと遅くなるので、長めに待つ
vi.setConfig({ testTimeout: 60_000 });
const dataDir = mkdtempSync(join(tmpdir(), "cs-backup-"));
const v03 = join(dataDir, "v03");
const nas = mkdtempSync(join(tmpdir(), "cs-nas-"));
let t: Awaited<ReturnType<typeof setup>>;
let svc: ReturnType<typeof backupService>;
let owner: Headers;
let viewer: Headers;
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

beforeAll(async () => {
  t = await setup({ mode: "self" });
  svc = backupService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fetch, local: { dataDir } });
  owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
  const inv = await (await t.call("/organization/invite-member", { email: "viewer@example.com", role: "viewer" }, owner.get("cookie")!)).json();
  const cookie = await t.signUp("閲覧者", "viewer@example.com");
  await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
  await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
  viewer = t.headers(cookie);
  mkdirSync(join(v03, "library", "plugin"), { recursive: true });
  writeFileSync(join(v03, "library", "plugin", "a.jar"), "jar");
  writeFileSync(join(v03, "secret"), "old-secret\n");
});

describe("バックアップ", () => {
  it("作る・一覧を見るのは管理者以上。データベース・鍵・パネルの中のアドオンを 1 つにまとめる", async () => {
    expect(await code(svc.create(viewer))).toBe(403);
    const { name } = await svc.create(owner);
    expect(name).toMatch(/^craftshelf-v03-\d{8}-\d{6}\.tar\.gz$/);
    expect((await svc.list(owner)).backups.map((b) => b.name)).toEqual([name]);
    expect(await code(svc.open(owner, "../secret"))).toBe(400);
    expect(await code(svc.open(viewer, name))).toBe(403);
    (await svc.open(owner, name)).destroy();
  });

  it("戻すと、次の起動で入れ替える(今のデータは残す)。バックアップでないファイルは断る", async () => {
    expect(await code(svc.restoreUpload(owner, new TextEncoder().encode("not a backup")))).toBe(400);
    const [b] = (await svc.list(owner)).backups;
    await svc.restore(owner, b.name);
    expect((await svc.list(owner)).pending).toBe(true);
    writeFileSync(join(v03, "secret"), "new-secret\n");
    const pg = join(v03, "pg");
    mkdirSync(pg, { recursive: true });
    writeFileSync(join(pg, "marker"), "今のデータ");
    const aside = await applyPendingRestore(v03, `pglite:${pg}`);
    expect(aside).toBeTruthy();
    expect(readFileSync(join(aside!, "pg", "marker"), "utf8")).toBe("今のデータ");
    expect(readFileSync(join(v03, "secret"), "utf8")).toBe("old-secret\n");
    expect(readFileSync(join(v03, "library", "plugin", "a.jar"), "utf8")).toBe("jar");
    expect(existsSync(join(v03, "restore-pending.tar.gz"))).toBe(false);
    // 戻したデータベースに、バックアップを作ったときの利用者がいる
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(pg);
    const r = await db.query<{ name: string }>(`select name from "user" order by name`);
    expect(r.rows.map((x) => x.name)).toEqual(["オーナー", "閲覧者"]);
    await db.close();
    expect(readdirSync(v03).some((n) => n.startsWith("restore-failed"))).toBe(false);
  });
});

describe("v02 から取り込み直す", () => {
  it("v02 のデータが無ければ断る。あれば次の起動の前に、v03 のデータ・取り込みの結果・アドオンを移して、取り込み直せるようにする", async () => {
    expect((await svc.list(owner)).v02).toBe(false);
    expect(await code(svc.reimport(owner))).toBe(404);
    writeFileSync(join(dataDir, "index.db"), "");
    expect(await code(svc.reimport(viewer))).toBe(403);
    await svc.reimport(owner);
    expect((await svc.list(owner))).toMatchObject({ v02: true, reimport: true });
    writeFileSync(join(v03, "import-v02.json"), "{}");
    const pg = join(v03, "pg");
    const aside = applyPendingReimport(v03, `pglite:${pg}`)!;
    expect(existsSync(join(aside, "pg"))).toBe(true);
    expect(existsSync(join(aside, "import-v02.json"))).toBe(true);
    expect(existsSync(join(aside, "library", "plugin", "a.jar"))).toBe(true);
    expect(existsSync(pg) || existsSync(join(v03, "import-v02.json"))).toBe(false);
    expect(applyPendingReimport(v03, `pglite:${pg}`)).toBeNull(); // 一度だけ
  });
});

describe("定期バックアップ", () => {
  it("設定は管理者以上。残す数・置き場所(保存先)を選べ、保存先に置いたものから戻せる", async () => {
    const tz = "Asia/Tokyo";
    expect(await code(svc.setSchedule(viewer, { enabled: true, time: "04:00", keep: 2, targetId: null, tz }))).toBe(403);
    expect(await code(svc.setSchedule(owner, { enabled: true, time: "4:00", keep: 2, targetId: null, tz }))).toBe(400);
    expect(await code(svc.setSchedule(owner, { enabled: true, time: "04:00", keep: 0, targetId: null, tz }))).toBe(400);
    expect(await code(svc.setSchedule(owner, { enabled: true, time: "04:00", keep: 2, targetId: "nope", tz }))).toBe(404);
    const up = uploadService({ db: t.db, auth: t.auth, secret: SECRET, fetch: fetch, local: { dataDir } });
    await up.addTarget(owner, { name: "NAS", kind: "local", path: nas });
    const target = (await up.targets(owner)).targets[0];
    await svc.setSchedule(owner, { enabled: true, time: "04:00", keep: 2, targetId: target.id, tz });
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      names.push((await svc.create(owner)).name);
      await new Promise((r) => setTimeout(r, 1100)); // 名前は秒まで
    }
    const l = await svc.list(owner);
    expect(l.stored.map((b) => b.name)).toEqual([names[2], names[1]]);
    expect(readdirSync(join(nas, "_craftshelf_backup")).sort()).toEqual([names[1], names[2]]);
    expect(l.backups.map((b) => b.name)).not.toContain(names[2]); // パネルの中には残さない
    expect(l.schedule).toMatchObject({ enabled: true, time: "04:00", keep: 2, targetId: target.id });
    await svc.restore(owner, names[2]);
    expect(readFileSync(join(v03, "restore-pending.tar.gz")).length).toBe(statSync(join(nas, "_craftshelf_backup", names[2])).size);
    await svc.cancel(owner);
  });

  it("時刻になったら作る(同じ分に 2 回は作らない)", async () => {
    const now = new Date();
    const tz = "Asia/Tokyo";
    const { time } = localParts(now, tz);
    const l = await svc.list(owner);
    await svc.setSchedule(owner, { enabled: true, time, keep: 5, targetId: null, tz });
    const before = l.backups.length;
    expect(await svc.tick(new Date(now.getTime() + 60_000 * 60))).toBe(0); // 時刻が違う
    expect(await svc.tick(now)).toBe(1);
    expect(await svc.tick(now)).toBe(0);
    expect((await svc.list(owner)).backups.length).toBe(before + 1);
    expect((await svc.list(owner)).schedule.lastRunAt).toBe(now.toISOString());
  });
});
