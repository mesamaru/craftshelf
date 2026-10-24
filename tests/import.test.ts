// v02 のデータの取り込み: v02 と同じ形のデータベースを作り、取り込んで、v02 の人がそのままログインできるか
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signupOpen } from "~/server/auth";
import { pteroConnection, server, serverProfile } from "~/server/db/schema";
import { maybeImportV02, type ImportReport } from "~/server/import-v02";
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
      software TEXT NOT NULL DEFAULT '', mc_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE passkeys (id INTEGER PRIMARY KEY, user_id INTEGER, credential_id TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE versions (id INTEGER PRIMARY KEY); CREATE TABLE sets (id INTEGER PRIMARY KEY);
  `);
  const user = d.prepare("INSERT INTO users (username, password_hash, role, created_at, perms, totp_secret, totp_enabled) VALUES (?,?,?,?,?,?,?)");
  user.run("Owner", V02.scrypt, "admin", "2025-01-02T03:04:05Z", "[]", "", 0);
  user.run("編集者", V02.pbkdf2, "editor", "2025-02-01T00:00:00Z", "[\"storage\"]", TOTP, 1);
  user.run("viewer", V02.scrypt, "viewer", "2025-03-01T00:00:00Z", "[]", "", 0);
  const set = d.prepare("INSERT INTO settings (key, value) VALUES (?,?)");
  set.run("ptero_url", "http://192.168.1.20");
  set.run("ptero_key", V02.fernetToken);
  const srv = d.prepare("INSERT INTO servers (identifier, name, kind, software, mc_version) VALUES (?,?,?,?,?)");
  srv.run("abcd1234", "サバイバル", "ptero", "paper", "26.3");
  srv.run("efgh5678", "プロキシ", "ptero", "waterfall", "");
  srv.run("local-1", "家のサーバー", "local", "fabric", "1.21.1");
  d.exec("INSERT INTO passkeys VALUES (1, 1, 'x'); INSERT INTO items VALUES (1),(2); INSERT INTO versions VALUES (1),(2),(3); INSERT INTO sets VALUES (1);");
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

  it("Pterodactyl の設定(家の中のアドレスも)とサーバーを取り込む。フォルダのサーバーは飛ばして知らせる", async () => {
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
    expect(skipped).toContain("フォルダのサーバー(1 台)");
    expect(report!.skipped.find((s) => s.what.startsWith("フォルダ"))!.detail).toContain("家のサーバー");
    expect(skipped).toContain("ライブラリ(2 件・3 バージョン)");
    expect(skipped).toContain("パスキー");
  });

  it("v02 のデータには書き込まない。二度目は取り込まない。そのあとの登録は招待された人だけ", async () => {
    expect(fileHash(join(v02Dir, "index.db"))).toBe(v02Hash);
    expect(await maybeImportV02(t.db, { secret: TEST_SECRET, v02Dir, v03Dir })).toBeNull();
    expect(await signupOpen(t.db, "self")).toBe(false);
  });
});
