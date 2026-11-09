// v02 のデータの取り込み(自分用の版が、v02 と同じ /data で初めて起動したとき)。
// v02 のデータベースは読み取り専用で開き、何も書き込まない(イメージを v02 に戻せば、そのまま v02 で使える)
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { isSoftware } from "~/lib/software";
import { APP_NAME, legacyTotpContext } from "./auth";
import type { Db } from "./db";
import * as schema from "./db/schema";
import { decryptV02Secret } from "./legacy";
import { checkRoot } from "./local";
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

    // v02 で Pterodactyl のサーバーを割り当てていた人(ptero_servers が null でない閲覧者・編集者)
    const serverIds = new Map<string, string>(); // v02 の identifier → v03 のサーバー
    const limits: { userId: string; idents: Set<string> }[] = [];
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
      if (u.ptero_servers != null && role !== "owner" && role !== "admin") {
        let list: unknown = [];
        try {
          list = JSON.parse(str(u.ptero_servers));
        } catch { /* 読めないときは、どれも割り当てない(v02 と同じ) */ }
        limits.push({ userId: id, idents: new Set(Array.isArray(list) ? list.map(String) : []) });
      }
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

    // サーバー: Pterodactyl のもの(フォルダのサーバーは maybeImportV02Library で取り込む)
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
      serverIds.set(str(s.identifier), serverId);
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
    if (folders.length) report.notes.push(`フォルダのサーバー(${folders.length} 台)は、ライブラリと一緒に取り込みます`);
    for (const l of limits) {
      await tx.insert(schema.memberServerLimit).values({ teamId, userId: l.userId });
      const ids = [...l.idents].map((x) => serverIds.get(x)).filter((x): x is string => !!x);
      if (ids.length) await tx.insert(schema.memberServer).values(ids.map((serverId) => ({ teamId, userId: l.userId, serverId })));
    }
  });

  // v03 にまだ無いもの(v02 のデータはそのまま残る)
  const n = (table: string) => (has(v02, table) ? Number(all(v02, `SELECT COUNT(*) AS n FROM ${table}`)[0].n) : 0);
  // ライブラリ・セットは maybeImportV02Library で取り込む(結果は import-v02-library.json)
  if (n("api_tokens")) report.skipped.push({ what: `API トークン(${n("api_tokens")} 件)`, detail: "作り直してください" });
  return report;
}

// ---------------------------------------------------------------------------
// ライブラリ・セット(03.07.00 から)。v02 から取り込んだ自分用の版で一度だけ行う(それより前に取り込んだ人も、次の起動で)。
// 配布元が Modrinth・CurseForge とわかるもの(03.58.00 からはデータパック・リソースパック・シェーダー・Modパックも)と、SpigotMC とわかるプラグインを目録に載せる
export type LibraryImportReport = { at: string; items: number; sets: number; folders?: number; uploads?: number; skipped: { what: string; detail: string }[] };

export const libraryReportPath = (v03Dir: string) => join(v03Dir, "import-v02-library.json");

export function readLibraryReport(v03Dir: string): LibraryImportReport | null {
  try {
    return JSON.parse(readFileSync(libraryReportPath(v03Dir), "utf8"));
  } catch {
    return null;
  }
}

export async function maybeImportV02Library(db: Db, opts: { v02Dir: string; v03Dir: string; secret?: string; dataDir?: string }): Promise<LibraryImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(reportPath(opts.v03Dir)) || existsSync(libraryReportPath(opts.v03Dir))) return null;
  // 自分用の版のチームは 1 つ(v02 から取り込んだときに作ったもの)
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const o = opts.secret ? { secret: opts.secret, v02Dir: opts.v02Dir, dataDir: opts.dataDir ?? opts.v02Dir } : null;
    const pre: LibraryImportReport = { at: "", items: 0, sets: 0, skipped: [] };
    const uploaded = o ? await importUploads(db, v02, team.id, o, pre) : new Map<number, string>();
    const report = await importLibrary(db, v02, team.id, uploaded);
    report.uploads = pre.uploads;
    report.skipped.push(...pre.skipped);
    if (o) {
      await importFolders(db, v02, team.id, o, report);
      await importCurseforgeKey(db, v02, team.id, o, report);
    }
    writeFileSync(libraryReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    // データパックなども一緒に取り込んだので、あとからの取り込み(maybeImportV02Kinds)はしない
    writeFileSync(kindsReportPath(opts.v03Dir), JSON.stringify({ at: report.at, items: 0, uploads: 0, skipped: [], withLibrary: true }, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// データパック・リソースパック・シェーダー・Modパック(03.58.00 から)。03.57.00 までにライブラリを取り込んだパネルで一度だけ
// (それより後に取り込んだものは、ライブラリと一緒に取り込む)。配布元のわかるものは目録に、わからないものは v02 の保存先のファイルを指す形で載せ、
// 取り込み済みの同じ名前のセットにも足す。v02 の保存先は、前に取り込んだものを使う
export const kindsReportPath = (v03Dir: string) => join(v03Dir, "import-v02-kinds.json");

/** あとから取り込んだデータパックなどの結果(ライブラリと一緒に取り込んだときは null) */
export function readKindsReport(v03Dir: string): LibraryImportReport | null {
  try {
    const r = JSON.parse(readFileSync(kindsReportPath(v03Dir), "utf8"));
    return r.withLibrary ? null : r;
  } catch {
    return null;
  }
}

export async function maybeImportV02Kinds(db: Db, opts: { v02Dir: string; v03Dir: string; secret?: string; dataDir?: string }): Promise<LibraryImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(libraryReportPath(opts.v03Dir)) || existsSync(kindsReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const pre: LibraryImportReport = { at: "", items: 0, sets: 0, skipped: [] };
    const o = opts.secret ? { secret: opts.secret, v02Dir: opts.v02Dir, dataDir: opts.dataDir ?? opts.v02Dir } : null;
    const uploaded = o ? await importUploads(db, v02, team.id, o, pre, LATER_TYPES) : new Map<number, string>();
    const report = await importLibrary(db, v02, team.id, uploaded, LATER_TYPES);
    report.uploads = pre.uploads;
    report.skipped.push(...pre.skipped);
    writeFileSync(kindsReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

const MODRINTH_ID = /^[A-Za-z0-9]{8}$/;
const SPIGOT_ID = /^\d{1,9}$/;
// v02 の種類(03.58.00 から、データパック・リソースパック・シェーダー・Modパックも取り込む)
const TYPES: Record<string, string> = { plugin: "plugin", mod: "mod", datapack: "datapack", resourcepack: "resourcepack", shader: "shader", modpack: "modpack" };
// 03.57.00 までは取り込まなかった種類(前に取り込んだパネルで、あとから一度だけ取り込む)
const LATER_TYPES = new Set(["datapack", "resourcepack", "shader", "modpack"]);
const listOf = (names: string[]) => names.slice(0, 20).join("、") + (names.length > 20 ? ` ほか ${names.length - 20} 件` : "");

// uploaded: アップロードとして取り込んだもの(v02 のアイテムの ID → v03 のライブラリの ID)。セットに入れるのに使う。
// only を渡すと、その種類だけを取り込み、セットは作らずに、取り込み済みの同じ名前のセットに足す(あとから取り込むとき)
export async function importLibrary(db: Db, v02: DatabaseSync, teamId: string, uploaded = new Map<number, string>(), only?: Set<string>): Promise<LibraryImportReport> {
  const report: LibraryImportReport = { at: new Date().toISOString(), items: 0, sets: 0, skipped: [] };
  if (!has(v02, "items")) return report;
  const sourced = has(v02, "item_sources");
  const rows = all(v02, sourced
    ? "SELECT i.id, i.name, i.category, s.provider, s.project_id, s.title, s.page_url FROM items i LEFT JOIN item_sources s ON s.item_id = i.id ORDER BY i.id"
    : "SELECT id, name, category FROM items ORDER BY id");
  const mapped = new Map<number, string>(); // v02 のアイテムの ID → v03 のライブラリの ID
  const unknown: string[] = [];
  const otherKinds: string[] = [];

  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (only && !only.has(str(r.category))) continue;
      const type = TYPES[str(r.category)];
      if (!type) {
        otherKinds.push(str(r.name));
        continue;
      }
      const projectId = str(r.project_id);
      const provider = str(r.provider);
      const source = provider === "modrinth" && MODRINTH_ID.test(projectId) ? "modrinth"
        : provider === "spigot" && SPIGOT_ID.test(projectId) && type === "plugin" ? "spigot"
        : provider === "curseforge" && SPIGOT_ID.test(projectId) ? "curseforge" : null;
      if (!source) {
        if (!uploaded.has(Number(r.id))) unknown.push(str(r.name));
        continue;
      }
      const slug = source === "modrinth" ? str(r.page_url).match(/modrinth\.com\/[a-z]+\/([A-Za-z0-9_.-]+)/)?.[1] ?? ""
        : source === "curseforge" ? str(r.page_url).match(/curseforge\.com\/minecraft\/([a-z-]+\/[A-Za-z0-9_.-]+)/)?.[1] ?? "" : "";
      await tx.insert(schema.libraryItem)
        .values({ id: randomUUID(), teamId, source, projectId, title: str(r.title) || str(r.name), slug, projectType: type })
        .onConflictDoNothing();
      const [row] = await tx.select({ id: schema.libraryItem.id }).from(schema.libraryItem)
        .where(and(eq(schema.libraryItem.teamId, teamId), eq(schema.libraryItem.source, source), eq(schema.libraryItem.projectId, projectId)));
      mapped.set(Number(r.id), row.id);
    }
    report.items = new Set(mapped.values()).size;

    if (!has(v02, "sets") || !has(v02, "set_items")) return;
    let pinned = 0;
    for (const set of all(v02, "SELECT id, name FROM sets ORDER BY id")) {
      const name = (str(set.name) || "セット").slice(0, 60);
      let id: string = randomUUID();
      if (only) {
        const [had] = await tx.select({ id: schema.addonSet.id }).from(schema.addonSet).where(and(eq(schema.addonSet.teamId, teamId), eq(schema.addonSet.name, name))).limit(1);
        if (!had) continue;
        id = had.id;
      } else {
        await tx.insert(schema.addonSet).values({ id, teamId, name });
        report.sets++;
      }
      const members = v02.prepare("SELECT item_id, version_id FROM set_items WHERE set_id=?").all(Number(set.id)) as Row[];
      let missing = 0;
      for (const m of members) {
        const itemId = mapped.get(Number(m.item_id)) ?? uploaded.get(Number(m.item_id));
        if (only && !itemId) continue; // ほかの種類は、前に取り込んだときに入れている
        if (!itemId) {
          missing++;
          continue;
        }
        if (m.version_id != null) pinned++;
        await tx.insert(schema.addonSetItem).values({ setId: id, itemId }).onConflictDoNothing();
      }
      if (missing) report.skipped.push({ what: `セット「${str(set.name)}」の ${missing} 件`, detail: "ライブラリに取り込めなかったものは入れていません" });
    }
    if (pinned) report.skipped.push({ what: `セットの版の固定(${pinned} 件)`, detail: "v03 は固定せず、いつもサーバーに合う新しい版を入れます" });
  });

  if (unknown.length) {
    report.skipped.push({ what: `ライブラリの ${unknown.length} 件`, detail: `配布元が Modrinth・SpigotMC・CurseForge とわからず、ファイルも取り込めなかったもの(保存先の方式が使えない・版が無いなど)です。ファイルは v02 の保存先に残っています: ${listOf(unknown)}` });
  }
  if (otherKinds.length) {
    report.skipped.push({ what: `種類のわからないもの(${otherKinds.length} 件)`, detail: `v03 はプラグイン・Mod・データパック・リソースパック・シェーダー・Modパックを扱います: ${listOf(otherKinds)}` });
  }
  return report;
}

// フォルダのサーバー(03.15.00 から)。このマシンから見えるフォルダのものだけ。起動・停止・RCON の設定も引き継ぐ
export async function importFolders(db: Db, v02: DatabaseSync, teamId: string, opts: { secret: string; v02Dir: string; dataDir: string }, report: LibraryImportReport) {
  report.folders = 0;
  if (!has(v02, "servers", "root_dir")) return;
  const keyFile = join(opts.v02Dir, "secret.key");
  const v02Key = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
  const col = (name: string) => has(v02, "servers", name);
  for (const s of all(v02, "SELECT * FROM servers WHERE kind='local' ORDER BY id")) {
    const name = str(s.name) || "フォルダのサーバー";
    let root: string;
    try {
      root = checkRoot(str(s.root_dir), opts.dataDir);
    } catch (e) {
      report.skipped.push({ what: `フォルダのサーバー「${name}」`, detail: `${str(s.root_dir)}: ${(e as Error).message}` });
      continue;
    }
    const id = randomUUID();
    let rconPasswordSealed = "";
    if (col("rcon_password") && str(s.rcon_password)) {
      try {
        rconPasswordSealed = seal(opts.secret, decryptV02Secret(str(s.rcon_password), v02Key), `rcon:${id}`);
      } catch {
        report.skipped.push({ what: `「${name}」の RCON のパスワード`, detail: "読めませんでした。設定し直してください" });
      }
    }
    const control = col("control") && ["none", "command", "docker"].includes(str(s.control)) ? str(s.control) : "none";
    await db.transaction(async (tx) => {
      await tx.insert(schema.server).values({ id, teamId, kind: "local", name });
      await tx.insert(schema.localServer).values({
        serverId: id, rootDir: root, control,
        startCmd: col("start_cmd") ? str(s.start_cmd).slice(0, 500) : "", stopCmd: col("stop_cmd") ? str(s.stop_cmd).slice(0, 500) : "",
        container: col("container") ? str(s.container).slice(0, 128) : "", rconPort: col("rcon_port") && Number(s.rcon_port) > 0 ? Number(s.rcon_port) : null, rconPasswordSealed,
      });
      const platform = SOFT[str(s.software)];
      if (platform && isPlatform(platform)) {
        const mc = str(s.mc_version);
        await tx.insert(schema.serverProfile).values({ serverId: id, platform, mcVersion: MC_VERSION.test(mc) ? mc : null });
      }
    });
    report.folders++;
  }
}

// アップロードしたアドオン(03.17.00 から)。配布元が Modrinth・SpigotMC とわからないもの(プラグイン・Mod・データパックなど)を、v02 の保存先のファイルを
// そのまま指す形で取り込む(コピーしない)。v02 のパネルの中の保存先(/data/library)・WebDAV を、v03 の保存先として登録する
const LOADERS: [RegExp, string[]][] = [
  [/folia/i, ["folia"]], [/bukkit|spigot/i, ["bukkit", "spigot", "paper", "purpur"]], [/paper/i, ["paper", "purpur"]],
  [/bungee/i, ["bungeecord", "waterfall"]], [/velocity/i, ["velocity"]], [/neoforge/i, ["neoforge"]], [/(^|[^o])forge/i, ["forge"]],
  [/fabric/i, ["fabric", "quilt"]], [/quilt/i, ["quilt"]],
];
const loadersOf = (label: string) => [...new Set(LOADERS.filter(([re]) => re.test(label)).flatMap(([, l]) => l))];

export async function importUploads(db: Db, v02: DatabaseSync, teamId: string, opts: { secret: string; v02Dir: string; dataDir: string }, report: LibraryImportReport, only?: Set<string>) {
  report.uploads = 0;
  const uploaded = new Map<number, string>();
  if (!has(v02, "items") || !has(v02, "versions", "relpath")) return uploaded;
  const keyFile = join(opts.v02Dir, "secret.key");
  const v02Key = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
  const sourced = has(v02, "item_sources");
  const items = all(v02, sourced
    ? "SELECT i.id, i.name, i.category, s.provider, s.project_id FROM items i LEFT JOIN item_sources s ON s.item_id = i.id ORDER BY i.id"
    : "SELECT id, name, category FROM items ORDER BY id")
    .filter((r) => TYPES[str(r.category)] && (!only || only.has(str(r.category))) && !(str(r.provider) === "modrinth" && MODRINTH_ID.test(str(r.project_id)))
      && !(str(r.provider) === "spigot" && SPIGOT_ID.test(str(r.project_id)) && str(r.category) === "plugin")
      && !(str(r.provider) === "curseforge" && SPIGOT_ID.test(str(r.project_id))));
  if (!items.length) return uploaded;

  // v02 の保存先 → v03 の保存先(SMB はまだつなげないので飛ばす)
  const targets = new Map<number, string | null>();
  const smb: string[] = [];
  const v02Targets = has(v02, "storage_targets") ? all(v02, "SELECT * FROM storage_targets ORDER BY id") : [];
  if (!v02Targets.length) v02Targets.push({ id: 1, name: "パネルの中", protocol: "local", active: 1 });
  for (const t of v02Targets) {
    const proto = str(t.protocol);
    let config: Record<string, string> | null = null;
    let summary = "";
    if (proto === "local") {
      config = { kind: "local", path: opts.dataDir };
      summary = `${opts.dataDir}(v02 のパネルの中)`;
    } else if (proto === "webdav") {
      let password = "";
      try {
        password = str(t.password_enc) ? decryptV02Secret(str(t.password_enc), v02Key) : "";
      } catch {
        report.skipped.push({ what: `v02 の保存先「${str(t.name)}」のパスワード`, detail: "読めませんでした。「保存先」で設定し直してください" });
      }
      const url = str(t.server).replace(/\/+$/, "") + (str(t.subpath) ? `/${str(t.subpath).replace(/^\/+/, "")}` : "");
      config = { kind: "webdav", url, user: str(t.username), password };
      summary = `${url}${str(t.username) ? `(${str(t.username)})` : ""}`;
    } else if (proto === "smb") {
      let password = "";
      try {
        password = str(t.password_enc) ? decryptV02Secret(str(t.password_enc), v02Key) : "";
      } catch {
        report.skipped.push({ what: `v02 の保存先「${str(t.name)}」のパスワード`, detail: "読めませんでした。「保存先」で設定し直してください" });
      }
      config = { kind: "smb", host: str(t.server), share: str(t.share), path: str(t.subpath), user: str(t.username), password, domain: has(v02, "storage_targets", "domain") ? str(t.domain) : "" };
      summary = `\\\\${str(t.server)}\\${str(t.share)}${str(t.subpath) ? `\\${str(t.subpath)}` : ""}${str(t.username) ? `(${str(t.username)})` : ""}`;
    } else {
      smb.push(str(t.name) || proto); // NFS など、v03 にない方式
      targets.set(Number(t.id), null);
      continue;
    }
    // 前に取り込んだ保存先があれば、それを使う(あとから取り込むとき)
    const name = `v02: ${str(t.name) || proto}`.slice(0, 60);
    const [had] = await db.select({ id: schema.storageTarget.id }).from(schema.storageTarget)
      .where(and(eq(schema.storageTarget.teamId, teamId), eq(schema.storageTarget.name, name), eq(schema.storageTarget.kind, config.kind))).limit(1);
    if (had) {
      targets.set(Number(t.id), had.id);
      continue;
    }
    const id = randomUUID();
    await db.insert(schema.storageTarget).values({
      id, teamId, name, kind: config.kind, summary,
      configSealed: seal(opts.secret, JSON.stringify(config), `storage:${teamId}:${id}`), active: false,
    });
    targets.set(Number(t.id), id);
  }

  for (const it of items) {
    const versions = all(v02, `SELECT * FROM versions WHERE item_id=${Number(it.id)} ORDER BY id`).filter((v) => targets.get(Number(v.target_id ?? 1)));
    if (!versions.length) continue; // 取り込めなかったものは、importLibrary が知らせる
    const type = TYPES[str(it.category)];
    const existing = await db.select().from(schema.libraryItem)
      .where(and(eq(schema.libraryItem.teamId, teamId), eq(schema.libraryItem.source, "upload"), eq(schema.libraryItem.projectType, type)));
    let item = existing.find((x) => x.title.toLowerCase() === str(it.name).toLowerCase());
    if (!item) {
      [item] = await db.insert(schema.libraryItem).values({ id: randomUUID(), teamId, source: "upload", projectId: randomUUID().replace(/-/g, "").slice(0, 16), title: str(it.name).slice(0, 80), projectType: type }).returning();
    }
    for (const v of versions) {
      const sha = str(v.sha256);
      const dup = await db.select({ id: schema.libraryFile.id }).from(schema.libraryFile).where(eq(schema.libraryFile.sha256, sha)).limit(1);
      if (dup.length) continue;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(str(v.meta) || "{}");
      } catch { /* 読めなければ空 */ }
      await db.insert(schema.libraryFile).values({
        id: randomUUID(), itemId: item.id, targetId: targets.get(Number(v.target_id ?? 1))!, storageKey: `library/${str(v.relpath).replace(/^\/+/, "")}`,
        filename: str(v.filename), size: Number(v.size) || 0, sha256: sha, version: str(v.version), loaders: JSON.stringify(loadersOf(str(meta.loader))), mcVersions: "[]",
        createdAt: new Date(str(v.added_at) || Date.now()),
      });
    }
    uploaded.set(Number(it.id), item.id);
    report.uploads++;
  }
  if (smb.length) report.skipped.push({ what: `v02 の保存先(${smb.length} 個)`, detail: `${smb.join("、")}。v03 で使えない方式(NFS など)なので取り込んでいません(NAS をマウントしてフォルダとして足せます)` });
  return uploaded;
}

// サーバーごとの自動更新(03.49.00 から)。ライブラリ(フォルダのサーバー)を取り込んだあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 で「自動更新」をオンにしていたサーバーを、Pterodactyl は識別子・フォルダのサーバーはフォルダの場所で探してオンにする
export const autoUpdateReportPath = (v03Dir: string) => join(v03Dir, "import-v02-auto-update.json");

export async function maybeImportV02AutoUpdate(db: Db, opts: { v02Dir: string; v03Dir: string; dataDir?: string }): Promise<{ at: string; servers: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(libraryReportPath(opts.v03Dir)) || existsSync(autoUpdateReportPath(opts.v03Dir))) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), servers: [] as string[] };
    for (const s of has(v02, "servers", "auto_update") ? all(v02, "SELECT * FROM servers WHERE auto_update='auto' ORDER BY id") : []) {
      const ids = await v03ServerIds(db, s, opts);
      if (!ids.length) continue;
      await db.update(schema.server).set({ autoUpdate: true }).where(inArray(schema.server.id, ids));
      report.servers.push(str(s.name));
    }
    writeFileSync(autoUpdateReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// v02 のサーバーを、取り込んだ v03 のサーバーから探す(Pterodactyl は識別子、フォルダのサーバーはフォルダの場所。取り込めなかったものは空)
async function v03ServerIds(db: Db, s: Row, opts: { v02Dir: string; dataDir?: string }) {
  if ((str(s.kind) || "ptero") === "ptero") {
    return (await db.select({ id: schema.server.id }).from(schema.server)
      .where(and(eq(schema.server.kind, "ptero"), eq(schema.server.remoteId, str(s.identifier))))).map((x) => x.id);
  }
  let root: string;
  try {
    root = checkRoot(str(s.root_dir), opts.dataDir ?? opts.v02Dir);
  } catch {
    return [];
  }
  return (await db.select({ id: schema.localServer.serverId }).from(schema.localServer).where(eq(schema.localServer.rootDir, root))).map((x) => x.id);
}

// パネルの定期バックアップと、ワールドのバックアップの予約(03.53.00 から)。自動更新の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// 置き場所は、v02 の保存先を取り込んだもの(「v02: 名前」)があればそれ、無ければパネルの中。v02 の曜日は月曜 = 0、v03 は日曜 = 0
export const backupReportPath = (v03Dir: string) => join(v03Dir, "import-v02-backup.json");

export async function maybeImportV02Backups(db: Db, opts: { v02Dir: string; v03Dir: string; dataDir?: string }): Promise<{ at: string; panel: boolean; worlds: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(autoUpdateReportPath(opts.v03Dir)) || existsSync(backupReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), panel: false, worlds: [] as string[] };
    const setting = (key: string) => (has(v02, "settings") ? str((v02.prepare("SELECT value FROM settings WHERE key=?").get(key) as Row | undefined)?.value) : "");
    const targetOf = async (v02Id: number) => {
      const t = v02Id && has(v02, "storage_targets") ? (v02.prepare("SELECT name, protocol FROM storage_targets WHERE id=?").get(v02Id) as Row | undefined) : undefined;
      if (!t) return null;
      const [row] = await db.select({ id: schema.storageTarget.id }).from(schema.storageTarget)
        .where(and(eq(schema.storageTarget.teamId, team.id), eq(schema.storageTarget.name, `v02: ${str(t.name) || str(t.protocol)}`.slice(0, 60))));
      return row?.id ?? null;
    };
    const backupTarget = Number(setting("backup_target_id")) || 0;
    if (backupTarget) {
      const keep = Math.min(60, Math.max(1, Number(setting("backup_keep")) || 14));
      await db.insert(schema.backupSchedule).values({ teamId: team.id, enabled: true, keep, targetId: await targetOf(backupTarget) }).onConflictDoNothing();
      report.panel = true;
    }
    if (has(v02, "servers", "world_mode")) {
      // v02 はワールドを、バックアップ先(無ければ今の保存先)に置いていた
      const active = has(v02, "storage_targets") ? Number((v02.prepare("SELECT id FROM storage_targets WHERE active=1").get() as Row | undefined)?.id ?? 0) : 0;
      const worldTarget = await targetOf(backupTarget || active);
      for (const s of all(v02, "SELECT * FROM servers WHERE world_mode IN ('daily', 'weekly') ORDER BY id")) {
        const ids = await v03ServerIds(db, s, opts);
        if (!ids.length) continue;
        const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(str(s.world_time)) ? str(s.world_time) : "05:00";
        const dow = ((Number(s.world_dow) || 0) + 1) % 7;
        const keep = Math.min(30, Math.max(1, Number(s.world_keep) || 5));
        const ptero = (str(s.kind) || "ptero") === "ptero";
        for (const serverId of ids) {
          await db.insert(schema.worldBackup).values({ serverId, mode: str(s.world_mode), time, dow, keep, targetId: ptero ? null : worldTarget }).onConflictDoNothing();
        }
        report.worlds.push(str(s.name));
      }
    }
    writeFileSync(backupReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// CurseForge の API キー(03.19.00 から)。v02 のパネル全体の設定を、チームのキーにする
export async function importCurseforgeKey(db: Db, v02: DatabaseSync, teamId: string, opts: { secret: string; v02Dir: string }, report: LibraryImportReport) {
  if (!has(v02, "settings")) return;
  const enc = str((v02.prepare("SELECT value FROM settings WHERE key='cf_api_key'").get() as Row | undefined)?.value);
  if (!enc) return;
  const keyFile = join(opts.v02Dir, "secret.key");
  try {
    const key = decryptV02Secret(enc, existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "");
    await db.insert(schema.teamCurseforge).values({ teamId, apiKeySealed: seal(opts.secret, key, `curseforge:${teamId}`), apiKeyHint: hint(key) }).onConflictDoNothing();
  } catch {
    report.skipped.push({ what: "CurseForge の API キー", detail: "読めませんでした。「チーム」で設定し直してください" });
  }
}

// サーバー本体の種類(03.54.00 から)。v03 のサーバーの種類だけでは分からないもの(Leaf・Waterfall・Vanilla・Mohist など)と、
// v02 で決めていたサーバー本体の jar を、ワールドのバックアップの取り込みのあとで一度だけ引き継ぐ。v02 がパネルに退避していた jar は引き継がない
export const softwareReportPath = (v03Dir: string) => join(v03Dir, "import-v02-software.json");
const V02_SOFTWARE: Record<string, string> = { bukkit: "spigot" };

export async function maybeImportV02Software(db: Db, opts: { v02Dir: string; v03Dir: string; dataDir?: string }): Promise<{ at: string; servers: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(backupReportPath(opts.v03Dir)) || existsSync(softwareReportPath(opts.v03Dir))) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), servers: [] as string[] };
    if (has(v02, "servers", "software")) {
      const jarCol = has(v02, "servers", "server_jar");
      for (const s of all(v02, "SELECT * FROM servers ORDER BY id")) {
        const sw = V02_SOFTWARE[str(s.software)] ?? str(s.software);
        const jar = jarCol ? basename(str(s.server_jar)) : "";
        const safeJar = /^[^/\\]{1,120}\.jar$/i.test(jar) ? jar : "";
        if (!isSoftware(sw) || (sw === SOFT[str(s.software)] && !safeJar)) continue; // サーバーの種類と同じで jar も決めていなければ、引き継ぐものが無い
        const ids = await v03ServerIds(db, s, opts);
        for (const serverId of ids) await db.insert(schema.serverSoftware).values({ serverId, jar: safeJar, software: sw }).onConflictDoNothing();
        if (ids.length) report.servers.push(str(s.name));
      }
    }
    writeFileSync(softwareReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// サーバーごとの予約(03.55.00 から。v02 の予約同期)。サーバー本体の種類の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 の予約同期は「入っているものを新しい版にする」なので update にする。v02 の曜日は月曜 = 0、v03 は日曜 = 0
export const scheduleReportPath = (v03Dir: string) => join(v03Dir, "import-v02-schedule.json");
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function maybeImportV02Schedules(db: Db, opts: { v02Dir: string; v03Dir: string; dataDir?: string }): Promise<{ at: string; servers: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(softwareReportPath(opts.v03Dir)) || existsSync(scheduleReportPath(opts.v03Dir))) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), servers: [] as string[] };
    for (const s of has(v02, "servers", "sched_mode") ? all(v02, "SELECT * FROM servers WHERE sched_mode IN ('daily', 'weekly') ORDER BY id") : []) {
      const ids = await v03ServerIds(db, s, opts);
      const time = TIME_RE.test(str(s.sched_time)) ? str(s.sched_time) : "04:00";
      const dow = ((Number(s.sched_dow) || 0) + 1) % 7;
      for (const serverId of ids) {
        await db.insert(schema.serverSchedule).values({ serverId, mode: str(s.sched_mode), action: "update", time, dow, restart: Number(s.sched_restart ?? 1) !== 0 }).onConflictDoNothing();
      }
      if (ids.length) report.servers.push(str(s.name));
    }
    writeFileSync(scheduleReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// 受け取る版(03.56.00 から。v02 01.19 の「正式版だけ / ベータ版も」)。サーバーごとの予約の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 の全体の設定(stable_only)をチームの既定に、アイテムごとの設定(item_sources.channel)を、同じ配布元・プロジェクトのライブラリのものに
export const channelReportPath = (v03Dir: string) => join(v03Dir, "import-v02-channel.json");

export async function maybeImportV02Channels(db: Db, opts: { v02Dir: string; v03Dir: string }): Promise<{ at: string; team: string; items: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(scheduleReportPath(opts.v03Dir)) || existsSync(channelReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), team: "release", items: [] as string[] };
    const stable = has(v02, "settings") ? (v02.prepare("SELECT value FROM settings WHERE key='stable_only'").get() as Row | undefined)?.value : undefined;
    if (stable !== undefined && str(stable) === "0") {
      await db.insert(schema.teamOption).values({ teamId: team.id, channel: "all" }).onConflictDoUpdate({ target: schema.teamOption.teamId, set: { channel: "all" } });
      report.team = "all";
    }
    for (const s of has(v02, "item_sources", "channel") ? all(v02, "SELECT provider, project_id, channel FROM item_sources WHERE channel IN ('release', 'all')") : []) {
      const rows = await db.update(schema.libraryItem).set({ channel: str(s.channel) })
        .where(and(eq(schema.libraryItem.teamId, team.id), eq(schema.libraryItem.source, str(s.provider)), eq(schema.libraryItem.projectId, str(s.project_id))))
        .returning({ title: schema.libraryItem.title });
      report.items.push(...rows.map((r) => r.title));
    }
    writeFileSync(channelReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// 見た目(03.57.00 から。v02 の 02.06 の個人設定のテーマ・背景の暗さとぼかし)。受け取る版の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 の利用者は u<番号>@v02.craftshelf.invalid で取り込んでいるので、その人に保存する。v03 で見た目をもう決めた人は上書きしない。
// v02 の「マイ画像」(背景画像)はサーバーの外のファイルなので取り込まない(v03 では、ブラウザごとに選び直す)
export const prefsReportPath = (v03Dir: string) => join(v03Dir, "import-v02-prefs.json");
const V02_THEMES = new Set(["aurora", "sunset", "ocean", "overworld", "nether", "end", "pastel", "graphite"]);

export async function maybeImportV02Prefs(db: Db, opts: { v02Dir: string; v03Dir: string }): Promise<{ at: string; users: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(channelReportPath(opts.v03Dir)) || existsSync(prefsReportPath(opts.v03Dir))) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), users: [] as string[] };
    for (const u of has(v02, "users", "prefs") ? all(v02, "SELECT id, username, prefs FROM users") : []) {
      let p: Row = {};
      try {
        p = JSON.parse(str(u.prefs) || "{}") as Row;
      } catch { /* 読めない設定は飛ばす */ }
      // v02 の初めのテーマはオーロラ(02 から)。ミントは v03 の標準。マイ画像は暗さ・ぼかしだけを引き継ぐ
      const theme = str(p.theme) || "aurora";
      const preset = V02_THEMES.has(theme) ? theme : "standard";
      const n = (v: unknown, max: number) => (typeof v === "number" ? Math.max(0, Math.min(max, Math.round(v))) : 0);
      const value = { mode: "auto", accent: "auto", preset, dim: n(p.bg_dim ?? (theme === "custom" ? 20 : 0), 80), blur: n(p.bg_blur, 40) };
      const [v03] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, `u${str(u.id)}@v02.craftshelf.invalid`));
      if (!v03) continue;
      const done = await db.insert(schema.userPref).values({ userId: v03.id, theme: JSON.stringify(value) }).onConflictDoNothing().returning({ id: schema.userPref.userId });
      if (done.length) report.users.push(str(u.username));
    }
    writeFileSync(prefsReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}
