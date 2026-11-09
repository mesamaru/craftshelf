// v02 のデータの取り込み: v02 と同じ形のデータベースを作り、取り込んで、v02 の人がそのままログインできるか
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signupOpen } from "~/server/auth";
import { addonSet, addonSetItem, libraryFile, libraryItem, localServer, pteroConnection, server, serverProfile, storageTarget } from "~/server/db/schema";
import * as schema from "~/server/db/schema";
import { maybeImportV02, maybeImportV02AutoUpdate, maybeImportV02Backups, maybeImportV02Channels, maybeImportV02Library, maybeImportV02Prefs, maybeImportV02Schedules, maybeImportV02Software, type ImportReport } from "~/server/import-v02";
import { totpCode } from "~/server/legacy";
import { open } from "~/server/secrets";
import { TEST_SECRET, setup } from "./helpers";
import { V02 } from "./legacy.test";

const TOTP = "JBSWY3DPEHPK3PXP";

// v02(02.21)と同じ形の index.db・secret.key
function makeV02(dir: string) {
  const d = new DatabaseSync(join(dir, "index.db"));
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor', created_at TEXT NOT NULL, last_login TEXT NOT NULL DEFAULT '', perms TEXT NOT NULL DEFAULT '[]',
      totp_secret TEXT NOT NULL DEFAULT '', totp_enabled INTEGER NOT NULL DEFAULT 0, recovery TEXT NOT NULL DEFAULT '[]', prefs TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, identifier TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'ptero',
      software TEXT NOT NULL DEFAULT '', mc_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', root_dir TEXT NOT NULL DEFAULT '',
      control TEXT NOT NULL DEFAULT 'none', start_cmd TEXT NOT NULL DEFAULT '', stop_cmd TEXT NOT NULL DEFAULT '', container TEXT NOT NULL DEFAULT '',
      rcon_port INTEGER NOT NULL DEFAULT 0, rcon_password TEXT NOT NULL DEFAULT '');
    CREATE TABLE passkeys (id INTEGER PRIMARY KEY, user_id INTEGER, credential_id TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, name TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL DEFAULT 0, target_id INTEGER NOT NULL DEFAULT 1, version TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '', relpath TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', added_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE storage_targets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, protocol TEXT NOT NULL, server TEXT NOT NULL DEFAULT '', share TEXT NOT NULL DEFAULT '',
      subpath TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', password_enc TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE item_sources (item_id INTEGER PRIMARY KEY, provider TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', page_url TEXT NOT NULL DEFAULT '');
    CREATE TABLE sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE set_items (set_id INTEGER NOT NULL, item_id INTEGER NOT NULL, version_id INTEGER, PRIMARY KEY (set_id, item_id));
  `);
  const user = d.prepare("INSERT INTO users (username, password_hash, role, created_at, perms, totp_secret, totp_enabled) VALUES (?,?,?,?,?,?,?)");
  user.run("Owner", V02.scrypt, "admin", "2025-01-02T03:04:05Z", "[]", "", 0);
  user.run("編集者", V02.pbkdf2, "editor", "2025-02-01T00:00:00Z", "[\"storage\"]", TOTP, 1);
  user.run("viewer", V02.scrypt, "viewer", "2025-03-01T00:00:00Z", "[]", "", 0);
  d.prepare("UPDATE users SET prefs=? WHERE username='Owner'").run(JSON.stringify({ theme: "nether", bg_dim: 30, bg_blur: 8, skin: "glass" }));
  d.prepare("UPDATE users SET prefs=? WHERE username='viewer'").run(JSON.stringify({ theme: "mint" }));
  d.exec("ALTER TABLE users ADD COLUMN ptero_servers TEXT");
  d.prepare("UPDATE users SET ptero_servers=? WHERE username='viewer'").run(JSON.stringify(["abcd1234"])); // v02.23 の割り当て
  const set = d.prepare("INSERT INTO settings (key, value) VALUES (?,?)");
  set.run("ptero_url", "http://192.168.1.20");
  set.run("ptero_key", V02.fernetToken);
  const srv = d.prepare("INSERT INTO servers (identifier, name, kind, software, mc_version) VALUES (?,?,?,?,?)");
  srv.run("abcd1234", "サバイバル", "ptero", "paper", "26.3");
  srv.run("efgh5678", "プロキシ", "ptero", "waterfall", "");
  srv.run("local-1", "家のサーバー", "local", "fabric", "1.21.1");
  srv.run("local-2", "消えたサーバー", "local", "paper", "");
  // 家のサーバーはこのマシンにあるフォルダ・コマンドで起動。消えたサーバーのフォルダはもう無い
  d.prepare("UPDATE servers SET root_dir=?, control='command', start_cmd='./start.sh', rcon_port=25575 WHERE identifier='local-1'").run(mkdtempSync(join(tmpdir(), "cs-v02srv-")));
  d.prepare("UPDATE servers SET root_dir=? WHERE identifier='local-2'").run(join(tmpdir(), "cs-no-such-folder-x"));
  d.exec("INSERT INTO passkeys VALUES (1, 1, 'x'); ");
  d.exec("ALTER TABLE servers ADD COLUMN auto_update TEXT NOT NULL DEFAULT 'off'"); // 01.17 の自動更新
  d.exec("UPDATE servers SET auto_update='auto' WHERE identifier IN ('abcd1234', 'local-1', 'local-2')");
  // 01.17 のワールドのバックアップ(曜日は月曜 = 0)と、パネルの定期バックアップ(置き場所 = 保存先 1)
  for (const col of ["world_mode TEXT NOT NULL DEFAULT 'off'", "world_time TEXT NOT NULL DEFAULT '05:00'", "world_dow INTEGER NOT NULL DEFAULT 0", "world_keep INTEGER NOT NULL DEFAULT 5"]) d.exec(`ALTER TABLE servers ADD COLUMN ${col}`);
  d.exec("UPDATE servers SET world_mode='weekly', world_time='03:30', world_dow=0, world_keep=3 WHERE identifier='local-1'");
  d.exec("UPDATE servers SET world_mode='daily' WHERE identifier='abcd1234'");
  // 予約同期(曜日は月曜 = 0。再起動は既定でする)
  for (const col of ["sched_mode TEXT NOT NULL DEFAULT 'off'", "sched_time TEXT NOT NULL DEFAULT '04:00'", "sched_dow INTEGER NOT NULL DEFAULT 0", "sched_restart INTEGER NOT NULL DEFAULT 1"]) d.exec(`ALTER TABLE servers ADD COLUMN ${col}`);
  d.exec("UPDATE servers SET sched_mode='weekly', sched_time='02:15', sched_dow=6, sched_restart=0 WHERE identifier='local-1'");
  d.exec("UPDATE servers SET sched_mode='daily' WHERE identifier='abcd1234'");
  set.run("backup_target_id", "1");
  set.run("backup_keep", "7");
  // 保存先: 1 = パネルの中 / 2 = SMB(v03 はまだつなげない)。自作は 1 に、NASだけ は 2 にだけ版がある
  d.exec(`
    INSERT INTO storage_targets (name, protocol, server, share, active) VALUES ('パネルの中', 'local', '', '', 1), ('家の NAS', 'smb', 'nas.example.test', 'share', 0);
    INSERT INTO versions (item_id, target_id, version, filename, relpath, size, sha256, meta, added_at) VALUES
      (1, 1, '5.4', 'LuckPerms-5.4.jar', 'plugin/LuckPerms/LuckPerms-5.4.jar', 10, 'aaa', '{}', '2025-01-01'),
      (4, 1, '1.0', 'Jisaku-1.0.jar', 'plugin/自作/Jisaku-1.0.jar', 20, 'bbb', '{"loader":"Bukkit / Spigot / Paper"}', '2025-02-01'),
      (7, 2, '2.0', 'NasOnly.jar', 'plugin/NasOnly/NasOnly.jar', 30, 'ccc', '{}', '2025-03-01');
  `);
  // 1 = Modrinth のプラグイン / 2 = 別の人が持つ同じプラグイン / 3 = Modrinth の Mod / 4 = アップロードしただけ / 5 = SpigotMC / 6 = データパック
  d.exec(`
    INSERT INTO items (category, name, owner_id) VALUES ('plugin','LuckPerms',1),('plugin','LuckPerms',2),('mod','Lithium',1),('plugin','自作',1),('plugin','EssentialsX',1),('datapack','村人',1),('plugin','NASだけ',1);
    INSERT INTO item_sources VALUES (1,'modrinth','Vebnzrzj','LuckPerms','https://modrinth.com/plugin/luckperms'),(2,'modrinth','Vebnzrzj','LuckPerms',''),
      (3,'modrinth','gvQqBUqZ','Lithium','https://modrinth.com/mod/lithium'),(5,'spigot','9089','EssentialsX','');
    INSERT INTO sets (name, owner_id) VALUES ('ロビー', 1);
    INSERT INTO set_items VALUES (1,1,2),(1,3,NULL),(1,4,NULL);
    ALTER TABLE item_sources ADD COLUMN channel TEXT NOT NULL DEFAULT '';
    UPDATE item_sources SET channel='release' WHERE item_id=3;
    INSERT INTO settings (key, value) VALUES ('stable_only', '0');
  `);
  d.close();
  writeFileSync(join(dir, "secret.key"), V02.fernetKey);
}

let t: Awaited<ReturnType<typeof setup>>;
let report: ImportReport | null;
let v02Dir: string;
let v03Dir: string;
let v02Hash: string;
const fileHash = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

beforeAll(async () => {
  t = await setup({ mode: "self" });
  v02Dir = mkdtempSync(join(tmpdir(), "cs-v02-"));
  v03Dir = mkdtempSync(join(tmpdir(), "cs-v03-"));
  makeV02(v02Dir);
  v02Hash = fileHash(join(v02Dir, "index.db"));
  report = await maybeImportV02(t.db, { secret: TEST_SECRET, v02Dir, v03Dir });
});

let ip = 0; // 回数制限にかからないよう、ログインごとに別のアドレスから来たことにする
const signIn = (username: string, password: string, code?: string) => {
  const h = t.headers("", `10.7.0.${++ip}`);
  h.set("content-type", "application/json");
  if (code) h.set("x-v02-totp", code);
  return t.auth.handler(new Request("http://localhost:3000/api/auth/sign-in/username", { method: "POST", headers: h, body: JSON.stringify({ username, password }) }));
};

describe("v02 のデータの取り込み", () => {
  it("利用者・役割・二段階認証の有無を取り込む(最初の管理者がオーナー)", () => {
    expect(report?.users).toEqual([
      { name: "Owner", role: "owner", twoFactor: false },
      { name: "編集者", role: "editor", twoFactor: true },
      { name: "viewer", role: "viewer", twoFactor: false },
    ]);
  });

  it("v02 のユーザー名とパスワードでログインでき、チームのオーナーになっている", async () => {
    const r = await signIn("owner", "password123"); // ユーザー名の大文字・小文字は問わない(v02 と同じ)
    expect(r.status).toBe(200);
    const team = await (await t.get("/organization/get-full-organization", t.cookieOf(r))).json();
    expect(team.name).toBe("CraftShelf");
    expect(team.members.find((m: { user: { name: string } }) => m.user.name === "Owner").role).toBe("owner");
    expect((await signIn("Owner", "wrong-password")).status).toBe(401);
  });

  it("二段階認証を使っていた人は、パスワードが合っていれば v02 の認証アプリのコードを求められる", async () => {
    const wrongPw = await signIn("編集者", "wrong-password");
    expect(wrongPw.status).toBe(401);
    expect((await wrongPw.json()).code).not.toBe("V02_TOTP_REQUIRED"); // パスワードが違うときは、二段階認証の有無を見せない
    const noCode = await signIn("編集者", "password123");
    expect(noCode.status).toBe(401);
    expect((await noCode.json()).code).toBe("V02_TOTP_REQUIRED");
    expect((await signIn("編集者", "password123", "000000")).status).toBe(401);
    const ok = await signIn("編集者", "password123", totpCode(TOTP, Math.floor(Date.now() / 30000)));
    expect(ok.status).toBe(200);
  });

  it("Pterodactyl の設定(家の中のアドレスも)とサーバーを取り込む。フォルダのサーバーは、あとの取り込みに回す", async () => {
    const [c] = await t.db.select().from(pteroConnection);
    expect(c.url).toBe("http://192.168.1.20");
    expect(open(TEST_SECRET, c.apiKeySealed, `ptero:${c.teamId}:${c.id}`)).toBe("ptlc_abcdefghij0123456789");
    const rows = await t.db.select({ name: server.name, remote: server.remoteId, platform: serverProfile.platform, mc: serverProfile.mcVersion })
      .from(server).leftJoin(serverProfile, eq(serverProfile.serverId, server.id));
    expect(rows.sort((a, b) => a.remote!.localeCompare(b.remote!))).toEqual([
      { name: "サバイバル", remote: "abcd1234", platform: "paper", mc: "26.3" },
      { name: "プロキシ", remote: "efgh5678", platform: "bungeecord", mc: null },
    ]);
    expect(report?.ptero).toEqual({ url: "http://192.168.1.20", servers: 2 });
    const skipped = report!.skipped.map((s) => s.what);
    expect(report!.notes).toContain("フォルダのサーバー(2 台)は、ライブラリと一緒に取り込みます");
    expect(skipped).toContain("パスキー");
  });

  it("v02 で割り当てていたサーバーを、v03 の割り当てにする(割り当てていない人は、すべて使える)", async () => {
    const limited = await t.db.select({ name: schema.user.name }).from(schema.memberServerLimit).innerJoin(schema.user, eq(schema.memberServerLimit.userId, schema.user.id));
    expect(limited.map((x) => x.name)).toEqual(["viewer"]);
    const given = await t.db.select({ name: server.name }).from(schema.memberServer).innerJoin(server, eq(schema.memberServer.serverId, server.id));
    expect(given.map((x) => x.name)).toEqual(["サバイバル"]);
  });

  it("v02 のデータには書き込まない。二度目は取り込まない。そのあとの登録は招待された人だけ", async () => {
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
    expect(await maybeImportV02(t.db, { secret: TEST_SECRET, v02Dir, v03Dir })).toBeNull();
    expect(await signupOpen(t.db, "self")).toBe(false);
  });
});

describe("v02 のライブラリ・セットの取り込み", () => {
  it("配布元が Modrinth・SpigotMC とわかるプラグイン・Mod を載せ、セットも作る。取り込めないものは理由を残す", async () => {
    const r = (await maybeImportV02Library(t.db, { v02Dir, v03Dir, secret: TEST_SECRET, dataDir: v03Dir }))!;
    const items = await t.db.select({ title: libraryItem.title, type: libraryItem.projectType, source: libraryItem.source, slug: libraryItem.slug }).from(libraryItem);
    expect(items.sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { title: "EssentialsX", type: "plugin", source: "spigot", slug: "" },
      { title: "Lithium", type: "mod", source: "modrinth", slug: "lithium" },
      { title: "LuckPerms", type: "plugin", source: "modrinth", slug: "luckperms" }, // 2 人が持っていても 1 件
      { title: "自作", type: "plugin", source: "upload", slug: "" }, // アップロードしたもの(v02 の保存先のファイルを指す)
      { title: "NASだけ", type: "plugin", source: "upload", slug: "" }, // SMB の保存先のもの
    ].sort((a, b) => a.title.localeCompare(b.title)));
    const sets = await t.db.select({ name: addonSet.name, item: libraryItem.title }).from(addonSet)
      .innerJoin(addonSetItem, eq(addonSetItem.setId, addonSet.id)).innerJoin(libraryItem, eq(libraryItem.id, addonSetItem.itemId));
    expect(sets.map((x) => `${x.name}:${x.item}`).sort()).toEqual(["ロビー:Lithium", "ロビー:LuckPerms", "ロビー:自作"]);
    expect([r.items, r.sets, r.uploads]).toEqual([3, 1, 2]);
    const skipped = Object.fromEntries(r.skipped.map((x) => [x.what, x.detail]));
    expect(skipped["ライブラリの 1 件"]).toBeUndefined();
    const files = await t.db.select({ key: libraryFile.storageKey, loaders: libraryFile.loaders, kind: storageTarget.kind, target: storageTarget.summary })
      .from(libraryFile).innerJoin(storageTarget, eq(libraryFile.targetId, storageTarget.id));
    expect(files.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "library/plugin/NasOnly/NasOnly.jar", loaders: "[]", kind: "smb", target: "\\\\nas.example.test\\share" },
      { key: "library/plugin/自作/Jisaku-1.0.jar", loaders: JSON.stringify(["bukkit", "spigot", "paper", "purpur"]), kind: "local", target: `${v03Dir}(v02 のパネルの中)` },
    ]);
    expect(skipped["データパックなど(1 件)"]).toContain("村人");
    expect(skipped["セットの版の固定(1 件)"]).toBeTruthy();
  });

  it("v02 のデータには書き込まない。二度目は取り込まない", async () => {
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
    expect(await maybeImportV02Library(t.db, { v02Dir, v03Dir })).toBeNull();
  });
});

describe("v02 のフォルダのサーバーの取り込み", () => {
  it("このマシンにあるフォルダのものを、起動の設定・種類と一緒に取り込む。無いフォルダは理由を残す", async () => {
    const r = JSON.parse(readFileSync(join(v03Dir, "import-v02-library.json"), "utf8"));
    expect(r.folders).toBe(1);
    expect(r.skipped.find((x: { what: string }) => x.what === "フォルダのサーバー「消えたサーバー」")).toBeTruthy();
    const [row] = await t.db.select({ name: server.name, control: localServer.control, start: localServer.startCmd, rcon: localServer.rconPort, platform: serverProfile.platform })
      .from(localServer).innerJoin(server, eq(localServer.serverId, server.id)).leftJoin(serverProfile, eq(serverProfile.serverId, server.id));
    expect(row).toEqual({ name: "家のサーバー", control: "command", start: "./start.sh", rcon: 25575, platform: "fabric" });
  });
});

describe("v02 の自動更新の取り込み", () => {
  it("自動更新をオンにしていたサーバーを、Pterodactyl は識別子・フォルダはフォルダの場所で探してオンにする。一度だけ", async () => {
    const r = (await maybeImportV02AutoUpdate(t.db, { v02Dir, v03Dir, dataDir: v03Dir }))!;
    expect(r.servers).toEqual(["サバイバル", "家のサーバー"]); // 消えたサーバーは取り込んでいない
    const on = await t.db.select({ name: server.name }).from(server).where(eq(server.autoUpdate, true));
    expect(on.map((x) => x.name).sort()).toEqual(["サバイバル", "家のサーバー"].sort());
    expect(await maybeImportV02AutoUpdate(t.db, { v02Dir, v03Dir, dataDir: v03Dir })).toBeNull();
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
  });
});

describe("v02 のバックアップの設定の取り込み", () => {
  it("パネルの定期バックアップと、ワールドのバックアップの予約を引き継ぐ(置き場所は取り込んだ保存先。曜日を v03 の数え方に)。一度だけ", async () => {
    const r = (await maybeImportV02Backups(t.db, { v02Dir, v03Dir, dataDir: v03Dir }))!;
    expect(r).toMatchObject({ panel: true, worlds: ["サバイバル", "家のサーバー"] });
    const [target] = await t.db.select().from(storageTarget).where(eq(storageTarget.name, "v02: パネルの中"));
    const [panel] = await t.db.select().from(schema.backupSchedule);
    expect(panel).toMatchObject({ enabled: true, keep: 7, time: "04:00", targetId: target.id });
    const rows = await t.db.select({ name: server.name, w: schema.worldBackup }).from(schema.worldBackup).innerJoin(server, eq(schema.worldBackup.serverId, server.id));
    expect(rows.find((x) => x.name === "家のサーバー")?.w).toMatchObject({ mode: "weekly", time: "03:30", dow: 1, keep: 3, targetId: target.id });
    expect(rows.find((x) => x.name === "サバイバル")?.w).toMatchObject({ mode: "daily", time: "05:00", targetId: null });
    expect(await maybeImportV02Backups(t.db, { v02Dir, v03Dir, dataDir: v03Dir })).toBeNull();
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
  });
});

describe("v02 のサーバー本体の種類の取り込み", () => {
  it("v03 のサーバーの種類だけでは分からない種類(Waterfall など)を引き継ぐ。一度だけ", async () => {
    const r = (await maybeImportV02Software(t.db, { v02Dir, v03Dir, dataDir: v03Dir }))!;
    expect(r.servers).toEqual(["プロキシ"]);
    const rows = await t.db.select({ name: server.name, sw: schema.serverSoftware.software }).from(schema.serverSoftware).innerJoin(server, eq(schema.serverSoftware.serverId, server.id));
    expect(rows).toEqual([{ name: "プロキシ", sw: "waterfall" }]);
    expect(await maybeImportV02Software(t.db, { v02Dir, v03Dir, dataDir: v03Dir })).toBeNull();
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
  });
});

describe("v02 のサーバーごとの予約の取り込み", () => {
  it("予約同期を、入っているものを最新にする予約として引き継ぐ(曜日を v03 の数え方に・再起動するか)。一度だけ", async () => {
    const r = (await maybeImportV02Schedules(t.db, { v02Dir, v03Dir, dataDir: v03Dir }))!;
    expect(r.servers).toEqual(["サバイバル", "家のサーバー"]);
    const rows = await t.db.select({ name: server.name, s: schema.serverSchedule }).from(schema.serverSchedule).innerJoin(server, eq(schema.serverSchedule.serverId, server.id));
    expect(rows.find((x) => x.name === "家のサーバー")?.s).toMatchObject({ mode: "weekly", action: "update", time: "02:15", dow: 0, restart: false });
    expect(rows.find((x) => x.name === "サバイバル")?.s).toMatchObject({ mode: "daily", action: "update", time: "04:00", restart: true });
    expect(await maybeImportV02Schedules(t.db, { v02Dir, v03Dir, dataDir: v03Dir })).toBeNull();
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
  });
});

describe("v02 の受け取る版の取り込み", () => {
  it("全体の「ベータ版も」をチームの既定に、アイテムごとの設定をライブラリのものに引き継ぐ。一度だけ", async () => {
    const r = (await maybeImportV02Channels(t.db, { v02Dir, v03Dir }))!;
    expect(r).toMatchObject({ team: "all", items: ["Lithium"] });
    const [opt] = await t.db.select().from(schema.teamOption);
    expect(opt.channel).toBe("all");
    const items = await t.db.select({ title: libraryItem.title, channel: libraryItem.channel }).from(libraryItem);
    expect(items.find((i) => i.title === "Lithium")?.channel).toBe("release");
    expect(items.find((i) => i.title === "LuckPerms")?.channel).toBe("");
    expect(await maybeImportV02Channels(t.db, { v02Dir, v03Dir })).toBeNull();
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
  });
});

describe("v02 の見た目の取り込み", () => {
  it("テーマ・背景の暗さとぼかしを、その人のアカウントに引き継ぐ(何も選んでいない人は v02 の初めのオーロラ)。一度だけ", async () => {
    const r = (await maybeImportV02Prefs(t.db, { v02Dir, v03Dir }))!;
    expect(r.users.sort()).toEqual(["Owner", "viewer", "編集者"].sort());
    const rows = await t.db.select({ name: schema.user.name, theme: schema.userPref.theme }).from(schema.userPref).innerJoin(schema.user, eq(schema.userPref.userId, schema.user.id));
    const of = (n: string) => JSON.parse(rows.find((x) => x.name === n)!.theme!);
    expect(of("Owner")).toEqual({ mode: "auto", accent: "auto", preset: "nether", dim: 30, blur: 8 });
    expect(of("編集者")).toMatchObject({ preset: "aurora", dim: 0, blur: 0 });
    expect(of("viewer")).toMatchObject({ preset: "standard" });
    expect(await maybeImportV02Prefs(t.db, { v02Dir, v03Dir })).toBeNull();
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
  });
});
