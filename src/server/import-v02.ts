// v02 のデータの取り込み(自分用の版が、v02 と同じ /data で初めて起動したとき)。
// v02 のデータベースは読み取り専用で開き、何も書き込まない(イメージを v02 に戻せば、そのまま v02 で使える)
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { count } from "drizzle-orm";
import { MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { APP_NAME, legacyTotpContext } from "./auth";
import type { Db } from "./db";
import * as schema from "./db/schema";
import { decryptV02Secret } from "./legacy";
import { checkPublicUrl } from "./net";
import { hint, seal } from "./secrets";

export type ImportReport = {
  at: string;
  source: string;
  users: { name: string; role: string; twoFactor: boolean }[];
  ptero: { url: string; servers: number } | null;
  skipped: { what: string; detail: string }[];
  notes: string[];
};

// v02 のサーバーソフト → v03 の種類(v03 に無いものは null)
const SOFT: Record<string, Platform | null> = {
  paper: "paper", purpur: "purpur", folia: "folia", leaf: "paper", pufferfish: "paper", spigot: "spigot", bukkit: "spigot",
  velocity: "velocity", bungeecord: "bungeecord", waterfall: "bungeecord", fabric: "fabric", quilt: "quilt", forge: "forge",
  neoforge: "neoforge", sponge: null, vanilla: null, mohist: null, arclight: null,
};
const ROLE: Record<string, string> = { admin: "admin", editor: "editor", viewer: "viewer" };

export const reportPath = (v03Dir: string) => join(v03Dir, "import-v02.json");

export function readReport(v03Dir: string): ImportReport | null {
  try {
    return JSON.parse(readFileSync(reportPath(v03Dir), "utf8"));
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;

/** v02 のデータがあり、v03 にまだだれもいなければ取り込む。取り込んだら結果を返す(取り込まなかったら null) */
export async function maybeImportV02(db: Db, opts: { secret: string; v02Dir: string; v03Dir: string }): Promise<ImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || existsSync(reportPath(opts.v03Dir))) return null;
  if ((await db.select({ n: count() }).from(schema.user))[0].n > 0) return null;

  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = await importFrom(db, v02, opts);
    writeFileSync(reportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

const has = (v02: DatabaseSync, table: string, col?: string) => {
  const cols = v02.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return col ? cols.some((c) => c.name === col) : cols.length > 0;
};
const all = (v02: DatabaseSync, sql: string) => v02.prepare(sql).all() as Row[];
const str = (v: unknown) => (v == null ? "" : String(v));

export async function importFrom(db: Db, v02: DatabaseSync, opts: { secret: string; v02Dir: string }): Promise<ImportReport> {
  const report: ImportReport = { at: new Date().toISOString(), source: opts.v02Dir, users: [], ptero: null, skipped: [], notes: [] };
  const setting = (key: string) => str((v02.prepare("SELECT value FROM settings WHERE key=?").get(key) as Row | undefined)?.value);
  const keyFile = join(opts.v02Dir, "secret.key");
  const v02Key = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";

  const users = all(v02, `SELECT * FROM users ORDER BY id`);
  if (users.length === 0) {
    report.notes.push("v02 に利用者がいなかったので、最初の管理者を新しく作ってください");
    return report;
  }
  // オーナーは、いちばん最初の管理者(いなければ、いちばん最初の人)
  const ownerRow = users.find((u) => u.role === "admin") ?? users[0];

  await db.transaction(async (tx) => {
    const now = new Date();
    const teamId = randomUUID();
    await tx.insert(schema.organization).values({ id: teamId, name: APP_NAME, slug: `t-${randomBytes(6).toString("hex")}`, createdAt: now });

    for (const u of users) {
      const id = randomUUID();
      const name = str(u.username);
      const created = new Date(str(u.created_at) || now.toISOString());
      const when = Number.isNaN(created.getTime()) ? now : created;
      await tx.insert(schema.user).values({
        id, name, email: `u${u.id}@v02.craftshelf.invalid`, emailVerified: false, username: name.toLowerCase(), displayUsername: name,
        createdAt: when, updatedAt: now,
      });
      await tx.insert(schema.account).values({
        id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: str(u.password_hash), createdAt: when, updatedAt: now,
      });
      const role = u === ownerRow ? "owner" : ROLE[str(u.role)] ?? "viewer";
      await tx.insert(schema.member).values({ id: randomUUID(), organizationId: teamId, userId: id, role, createdAt: when });
      const twoFactor = Number(u.totp_enabled) === 1 && !!str(u.totp_secret);
      if (twoFactor) {
        await tx.insert(schema.legacyTotp).values({ userId: id, secretSealed: seal(opts.secret, str(u.totp_secret), legacyTotpContext(id)) });
      }
      report.users.push({ name, role, twoFactor });
      if (str(u.perms) && str(u.perms) !== "[]") report.notes.push(`${name} さんに個別に付けていた権限は、v03 の役割(${role})に置き換わりました`);
    }
    if (users.some((u) => Number(u.totp_enabled) === 1)) {
      report.notes.push("二段階認証を使っていた人は、v02 と同じ認証アプリのコードでログインできます。予備のコードは引き継げないので、ログインしたら v03 で設定し直してください");
    }
    if (has(v02, "passkeys") && all(v02, "SELECT COUNT(*) AS n FROM passkeys")[0].n) {
      report.skipped.push({ what: "パスキー", detail: "引き継げません。ログインしたあとで登録し直してください" });
    }

    // Pterodactyl(v02 はパネル全体で 1 つ)
    const pteroUrl = setting("ptero_url");
    const pteroKey = setting("ptero_key");
    let connectionId: string | null = null;
    if (pteroUrl && pteroKey) {
      try {
        const apiKey = decryptV02Secret(pteroKey, v02Key);
        const url = checkPublicUrl(pteroUrl, true);
        connectionId = randomUUID();
        await tx.insert(schema.pteroConnection).values({
          id: connectionId, teamId, name: "Pterodactyl", url, apiKeySealed: seal(opts.secret, apiKey, `ptero:${teamId}:${connectionId}`),
          apiKeyHint: hint(apiKey), createdBy: null,
        });
        report.ptero = { url, servers: 0 };
        if (setting("ptero_insecure") === "1") report.notes.push("v02 では Pterodactyl の証明書を確かめない設定でした。v03 は確かめるので、自己署名の証明書だとつながりません");
      } catch (e) {
        report.skipped.push({ what: "Pterodactyl の設定", detail: `読めませんでした(${(e as Error).message})` });
      }
    }

    // サーバー: Pterodactyl のものだけ(フォルダのサーバーは v03 にまだ無いので、まとめて知らせる)
    const folders: string[] = [];
    for (const s of has(v02, "servers") ? all(v02, "SELECT * FROM servers ORDER BY id") : []) {
      const kind = str(s.kind) || "ptero";
      if (kind !== "ptero") {
        folders.push(str(s.name));
        continue;
      }
      if (!connectionId) {
        report.skipped.push({ what: `サーバー「${str(s.name)}」`, detail: "Pterodactyl の設定を取り込めなかったため" });
        continue;
      }
      const serverId = randomUUID();
      await tx.insert(schema.server).values({
        id: serverId, teamId, kind: "ptero", name: str(s.name) || str(s.identifier), pteroConnectionId: connectionId, remoteId: str(s.identifier),
      });
      report.ptero!.servers++;
      const platform = SOFT[str(s.software)];
      if (platform && isPlatform(platform)) {
        const mc = str(s.mc_version);
        await tx.insert(schema.serverProfile).values({ serverId, platform, mcVersion: MC_VERSION.test(mc) ? mc : null });
      } else if (str(s.software)) {
        report.notes.push(`サーバー「${str(s.name)}」のサーバーソフト(${str(s.software)})は v03 にまだ無いので、種類を選び直してください`);
      }
    }
    if (folders.length) {
      report.skipped.push({ what: `フォルダのサーバー(${folders.length} 台)`, detail: `v03 ではまだ使えません: ${folders.join("、")}` });
    }
  });

  // v03 にまだ無いもの(v02 のデータはそのまま残る)
  const n = (table: string) => (has(v02, table) ? Number(all(v02, `SELECT COUNT(*) AS n FROM ${table}`)[0].n) : 0);
  if (n("items")) report.skipped.push({ what: `ライブラリ(${n("items")} 件・${n("versions")} バージョン)`, detail: "v03 にライブラリはまだありません。ファイルは /data に残っています" });
  if (n("sets")) report.skipped.push({ what: `セット(${n("sets")} 件)`, detail: "v03 にセットはまだありません" });
  if (n("api_tokens")) report.skipped.push({ what: `API トークン(${n("api_tokens")} 件)`, detail: "作り直してください" });
  return report;
}
