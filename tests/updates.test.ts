// パネルの自動アップデート・この更新の前に戻す・ログインを戻すコマンド・ランチャー(03.62.00)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, job, member, memberPerm, passkey, session, twoFactor, user } from "~/server/db/schema";
import { eventService } from "~/server/events";
import { HttpError, requireTeam } from "~/server/guard";
import { maybeImportV02SelfUpdate, reportPath } from "~/server/import-v02";
import { RESET_FILE, applyOwnerReset } from "~/server/owner-reset";
import { DATA_FLOOR, pickAuto, readUpdateState, updateService, writeUpdateState } from "~/server/updates";
import type { Release } from "~/server/versions";
import { defaultDataDir, pickApp, startTray } from "../packaging/launcher.mjs";
import { setup } from "./helpers";

vi.setConfig({ testTimeout: 30_000 });
const SECRET = "test-secret-0123456789-0123456789-abcd";
const rel = (version: string, stable: boolean): Release => ({ version, stable, publishedAt: "", notes: "", url: "", sumsUrl: "" });
const code = (p: Promise<unknown>) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : (console.error(e), 500)));

describe("自動で入れる版", () => {
  const list = [rel("04.00.00", true), rel("03.63.00", false), rel("03.62.00", true), rel("03.61.00", true)];
  it("安定版だけ / 開発版も・大きな版上げはしない・いまより新しいものだけ・戻したものは飛ばす", () => {
    expect(pickAuto(list, "03.61.00", "stable", [])?.version).toBe("03.62.00");
    expect(pickAuto(list, "03.61.00", "dev", [])?.version).toBe("03.63.00");
    expect(pickAuto(list, "03.61.00", "dev", ["03.63.00"])?.version).toBe("03.62.00");
    expect(pickAuto(list, "03.62.00", "stable", [])).toBeNull();
    expect(pickAuto(list, "03.63.00", "dev", [])).toBeNull();
  });
});

describe("パネルの更新と、更新の前に戻す", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-upd-"));
  mkdirSync(join(dataDir, "v03"), { recursive: true });
  let t: Awaited<ReturnType<typeof setup>>;
  let owner: Headers, admin: Headers, editor: Headers;
  const calls: string[] = [];
  const state = { current: "03.61.00", image: "03.60.00", selected: null as string | null };
  let releases = [rel("03.62.00", true), rel("03.61.00", true)];
  const versions = {
    state: () => state,
    list: async () => releases,
    use: async (v: string) => { calls.push(`use ${v}`); },
  } as unknown as Parameters<typeof updateService>[1];
  let n = 0;
  const backups = {
    supported: () => true,
    makeFor: async () => { calls.push("backup"); return { name: `craftshelf-v03-20261110-00000${n++}.tar.gz` }; },
    restoreFor: async (_t: string, _u: string | null, name: string) => { calls.push(`restore ${name}`); },
    cancelRestore: () => { calls.push("cancel"); },
  } as unknown as Parameters<typeof updateService>[2];
  let svc: ReturnType<typeof updateService>;

  const join2 = async (email: string, role: string) => {
    const inv = await (await t.call("/organization/invite-member", { email, role }, owner.get("cookie")!)).json();
    const cookie = await t.signUp(email.split("@")[0], email);
    await t.call("/organization/accept-invitation", { invitationId: inv.id }, cookie);
    await t.call("/organization/set-active", { organizationId: inv.organizationId }, cookie);
    return t.headers(cookie);
  };

  beforeAll(async () => {
    t = await setup({ mode: "self" });
    svc = updateService({ db: t.db, auth: t.auth, secret: SECRET, fetch, local: { dataDir } }, versions, backups);
    owner = t.headers(await t.signUp("オーナー", "owner@example.com"));
    admin = await join2("admin@example.com", "admin");
    editor = await join2("editor@example.com", "editor");
  });

  it("設定を見る・変えるのは「パネルの設定」の権限がある人だけ", async () => {
    expect(await code(svc.settings(editor))).toBe(403);
    expect(await code(svc.setAuto(editor, { auto: true, channel: "dev" }))).toBe(403);
    await svc.setAuto(admin, { auto: true, channel: "stable" });
    expect((await svc.settings(owner)).auto).toBe(true);
    expect(readUpdateState(join(dataDir, "v03")).channel).toBe("stable");
  });

  it("手で切り替えると、先にバックアップを作り、前の版と組にして覚える", async () => {
    expect(await code(svc.update(editor, "03.62.00"))).toBe(403);
    calls.length = 0;
    await svc.update(admin, "03.62.00");
    expect(calls).toEqual(["backup", "use 03.62.00"]);
    const [h] = (await svc.settings(owner)).history;
    expect(h).toMatchObject({ from: "03.61.00", to: "03.62.00", auto: false, canRollback: true });
  });

  it("戻すと、そのバックアップを次の起動で戻し、版も前のものにする。戻した版は自動では入れ直さない", async () => {
    const [h] = (await svc.settings(owner)).history;
    // 版の切り替えだけ任された人は、データまでは戻せない
    const [{ id }] = await t.db.select({ id: member.id }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(user.email, "editor@example.com"));
    await t.db.insert(memberPerm).values({ memberId: id, allow: JSON.stringify(["panel:manage"]) });
    expect(await code(svc.settings(editor))).toBe(200);
    expect(await code(svc.rollback(editor, h.at))).toBe(403);
    calls.length = 0;
    await svc.rollback(admin, h.at);
    expect(calls).toEqual([`restore ${h.backup}`, "use 03.61.00"]);
    expect((await svc.settings(owner)).history[0]).toMatchObject({ canRollback: false });
    expect(await code(svc.rollback(admin, h.at))).toBe(400);
    expect(await code(svc.rollback(admin, "nope"))).toBe(404);
    // 03.62.00 は飛ばすので、自動では何もしない
    expect(await svc.check()).toBe(false);
  });

  it("版を戻せなければ、データを戻すのもやめる", async () => {
    await svc.update(admin, "03.62.00");
    const [h] = (await svc.settings(owner)).history;
    const use = versions.use;
    versions.use = async () => { throw new Error("取ってこられません"); };
    calls.length = 0;
    await expect(svc.rollback(admin, h.at)).rejects.toThrow("取ってこられません");
    expect(calls).toEqual([`restore ${h.backup}`, "cancel"]);
    versions.use = use;
  });

  it("データを読めない古い版(下限より古い版)には、切り替えない。下限は下げず、イメージの版にも当てはまる", async () => {
    const before = readUpdateState(join(dataDir, "v03"));
    expect(before.floor).toBe(DATA_FLOOR); // 起動のときに残る
    calls.length = 0;
    const err = await svc.update(admin, "03.59.00").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(calls).toEqual([]); // バックアップも切り替えも始めない
    expect(await code(svc.update(admin, DATA_FLOOR))).toBe(200); // 下限ちょうどは切り替えられる
    // イメージの版(パネルで選んだ版をやめて戻す先)が下限より古いときも同じ
    state.image = "03.50.00";
    expect(await code(svc.update(admin, state.image))).toBe(400);
    state.image = "03.60.00";
    // 前に残した下限が、このコードの下限より新しければ、そちらを守る
    const s = readUpdateState(join(dataDir, "v03"));
    s.floor = "03.65.00";
    writeUpdateState(join(dataDir, "v03"), s);
    expect(await code(svc.update(admin, "03.62.00"))).toBe(400);
    expect((await svc.settings(owner)).floor).toBe("03.65.00");
    s.floor = DATA_FLOOR;
    writeUpdateState(join(dataDir, "v03"), s);
  });

  it("手での切り替え・更新の前に戻すも、動いている処理があれば断る(自動アップデートと同じ)", async () => {
    const [team] = await t.db.select({ id: member.organizationId }).from(member).limit(1);
    const [h] = (await svc.settings(owner)).history;
    await t.db.insert(job).values({ id: "j2", teamId: team.id, userId: null, action: "x", target: "", state: "queued" });
    calls.length = 0;
    expect(await code(svc.update(admin, "03.62.00"))).toBe(409);
    expect(await code(svc.rollback(admin, h.at))).toBe(409);
    expect(calls).toEqual([]); // バックアップも版の切り替えも始めない
    await t.db.delete(job).where(eq(job.id, "j2"));
    expect(await code(svc.update(admin, "03.62.00"))).toBe(200);
  });

  it("6 時間ごとの確認: 自動アップデートを使うなら入れる。処理が動いている間・使わないときは入れない", async () => {
    releases = [rel("03.64.00", false), rel("03.63.00", true), ...releases];
    const [team] = await t.db.select({ id: member.organizationId }).from(member).limit(1);
    await t.db.insert(job).values({ id: "j1", teamId: team.id, userId: null, action: "x", target: "", state: "running" });
    expect(await svc.check()).toBe(false);
    await t.db.delete(job).where(eq(job.id, "j1"));
    calls.length = 0;
    expect(await svc.check()).toBe(true);
    expect(calls).toEqual(["backup", "use 03.63.00"]);
    expect((await svc.settings(owner)).history[0]).toMatchObject({ to: "03.63.00", auto: true });
    const logged = await t.db.select().from(auditLog).where(and(eq(auditLog.teamId, team.id), eq(auditLog.action, "パネルを自動でアップデート")));
    expect(logged.length).toBe(1);
    await svc.setAuto(owner, { auto: false, channel: "dev" });
    calls.length = 0;
    expect(await svc.check()).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("ログインを戻す(サーバーの上のコマンド)", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const v03 = mkdtempSync(join(tmpdir(), "cs-reset-"));
  let ownerId = "";

  beforeAll(async () => {
    t = await setup({ mode: "self" });
    const cookie = await t.signUp("オーナー", "owner@example.com");
    ownerId = (await requireTeam(t.auth, t.headers(cookie))).user.id;
    await t.db.insert(twoFactor).values({ id: "tf1", secret: "s", backupCodes: "c", userId: ownerId });
    await t.db.insert(passkey).values({ id: "pk1", publicKey: "k", userId: ownerId, credentialID: "c", counter: 0, deviceType: "singleDevice", backedUp: false });
    await t.db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, ownerId));
  });

  it("コマンドが頼みごとを置き、パネルが片付けて新しいパスワードを出す。二段階認証・パスキー・ログインは外れ、記録に残る", async () => {
    const launcher = join(process.cwd(), "packaging", "launcher.mjs");
    const dataDir = join(v03, "..", `${v03.split(/[\\/]/).pop()}-data`);
    mkdirSync(join(dataDir, "v03"), { recursive: true });
    const out = new Promise<string>((res, rej) => execFile(process.execPath, [launcher, "reset-owner", "owner@example.com", "--data-dir", dataDir], (e, stdout) => (e ? rej(e) : res(stdout))));
    const file = join(dataDir, "v03", RESET_FILE);
    for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(readFileSync(file, "utf8")).login).toBe("owner@example.com");
    const record = eventService({ db: t.db, auth: t.auth, secret: SECRET, fetch }).record;
    expect(await applyOwnerReset(t.db, join(dataDir, "v03"), record)).toMatchObject({ ok: true, user: "オーナー" });
    expect(existsSync(file)).toBe(false);
    const password = (await out).match(/新しいパスワード: (\S+)/)?.[1];
    expect(password).toBeTruthy();
    expect(await t.db.select().from(twoFactor).where(eq(twoFactor.userId, ownerId))).toEqual([]);
    expect(await t.db.select().from(passkey).where(eq(passkey.userId, ownerId))).toEqual([]);
    expect(await t.db.select().from(session).where(eq(session.userId, ownerId))).toEqual([]);
    expect((await t.call("/sign-in/email", { email: "owner@example.com", password: "correct horse battery" })).status).toBe(401);
    const res = await t.call("/sign-in/email", { email: "owner@example.com", password });
    expect(res.status).toBe(200);
    expect((await res.json()).twoFactorRedirect).toBeFalsy();
    expect((await t.db.select().from(auditLog).where(eq(auditLog.action, "サーバーの上でログインを戻す"))).map((r) => r.target)).toEqual(["オーナー"]);
  });

  it("古い頼みごと・知らない人は断る(結果のファイルに書く)", async () => {
    const record = async () => {};
    writeFileSync(join(v03, RESET_FILE), JSON.stringify({ login: "owner@example.com", password: "x".repeat(16), at: "2020-01-01T00:00:00Z" }));
    expect(await applyOwnerReset(t.db, v03, record)).toMatchObject({ ok: false });
    writeFileSync(join(v03, RESET_FILE), JSON.stringify({ login: "nobody", password: "x".repeat(16), at: new Date().toISOString() }));
    expect((await applyOwnerReset(t.db, v03, record))?.error).toMatch("見つかりません");
    expect(await applyOwnerReset(t.db, v03, record)).toBeNull();
  });
});

describe("ランチャー", () => {
  it("データの場所は v02 のインストーラー版と同じ", () => {
    expect(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a")).toBe(join("C:\\Users\\a\\AppData\\Local", "CraftShelf"));
    expect(defaultDataDir("linux", {}, "/home/a")).toBe(join("/home/a", ".local", "share", "craftshelf"));
  });

  it("選んだ版を起動し、前回うまく起動しなかったら入っている版に戻す(docker/start.sh と同じ)", () => {
    const data = mkdtempSync(join(tmpdir(), "cs-launch-"));
    const app = join(data, "app");
    const ver = join(data, "v03", "versions", "03.62.00");
    mkdirSync(join(ver, ".output", "server"), { recursive: true });
    writeFileSync(join(ver, ".output", "server", "index.mjs"), "");
    expect(pickApp(data, app, () => {})).toBe(app);
    writeFileSync(join(data, "v03", "versions", "current"), "03.62.00\n");
    expect(pickApp(data, app, () => {})).toBe(ver);
    expect(existsSync(join(ver, ".starting"))).toBe(true);
    expect(pickApp(data, app, () => {})).toBe(app);
    expect(existsSync(join(data, "v03", "versions", "current"))).toBe(false);
  });

  it("タスクトレイは Windows・macOS だけで、助けのファイルが無ければ出さない。Windows のスクリプトは PowerShell 5.1 が日本語を読める BOM 付き", () => {
    const opts = { url: "http://127.0.0.1:8765/", dataDir: tmpdir(), icon: "", onQuit: () => {}, log: () => {} };
    expect(startTray({ ...opts, platform: "linux" })).toBeNull();
    expect(startTray({ ...opts, platform: "darwin", here: tmpdir() })).toBeNull();
    expect(startTray({ ...opts, platform: "win32", here: tmpdir() })).toBeNull();
    expect([...readFileSync(join(process.cwd(), "packaging", "tray.ps1")).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("v02 からの取り込み", () => {
  it("v02 で自動アップデートを使っていたら、安定版だけで引き継ぐ(一度だけ)", () => {
    const v02Dir = mkdtempSync(join(tmpdir(), "cs-v02su-"));
    const v03Dir = mkdtempSync(join(tmpdir(), "cs-v03su-"));
    const d = new DatabaseSync(join(v02Dir, "index.db"));
    d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('self_auto_update', '1')");
    d.close();
    expect(maybeImportV02SelfUpdate({ v02Dir, v03Dir })).toBeNull(); // まだ v02 から取り込んでいない
    writeFileSync(reportPath(v03Dir), "{}");
    expect(maybeImportV02SelfUpdate({ v02Dir, v03Dir })).toMatchObject({ auto: true });
    expect(readUpdateState(v03Dir)).toMatchObject({ auto: true, channel: "stable" });
    expect(maybeImportV02SelfUpdate({ v02Dir, v03Dir })).toBeNull();
  });
});
