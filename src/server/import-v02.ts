// v02 のデータの取り込み(自分用の版が、v02 と同じ /data で初めて起動したとき)。
// v02 のデータベースは読み取り専用で開き、何も書き込まない(イメージを v02 に戻せば、そのまま v02 で使える)
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
import { isSoftware } from "~/lib/software";
import type { Grant } from "~/lib/permissions";
import { APP_NAME, legacyTotpContext } from "./auth";
import type { Db } from "./db";
import * as schema from "./db/schema";
import { decryptV02Secret } from "./legacy";
import { checkRoot } from "./local";
import { type FetchLike, checkPublicUrl } from "./net";
import { hint, open, seal } from "./secrets";
import { modrinthClient } from "./modrinth";
import { curseforgeClient } from "./curseforge";
import { readUpdateState, updateStatePath, writeUpdateState } from "./updates";

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

// v02 のアイテムの配布元(配布元のわからないものは "upload")
const v02Source = (r: Row) => {
  const projectId = str(r.project_id);
  const provider = str(r.provider);
  return provider === "modrinth" && MODRINTH_ID.test(projectId) ? "modrinth"
    : provider === "spigot" && SPIGOT_ID.test(projectId) && str(r.category) === "plugin" ? "spigot"
    : provider === "curseforge" && SPIGOT_ID.test(projectId) ? "curseforge" : "upload";
};

// v02 のアイテム → 取り込んだ v03 のアイテム(配布元のものは配布元と ID。アップロードしたものは取り込んだファイルの SHA-256〔shas を渡したとき〕、無ければ種類と名前で)
async function v03ItemOf(db: Db, teamId: string, r: Row, shas: string[] = []) {
  const source = v02Source(r);
  if (source !== "upload") {
    return (await db.select().from(schema.libraryItem).where(and(eq(schema.libraryItem.teamId, teamId), eq(schema.libraryItem.source, source), eq(schema.libraryItem.projectId, str(r.project_id)))))[0];
  }
  if (shas.length) {
    const [f] = await db.select({ item: schema.libraryItem }).from(schema.libraryFile).innerJoin(schema.libraryItem, eq(schema.libraryFile.itemId, schema.libraryItem.id))
      .where(and(eq(schema.libraryItem.teamId, teamId), eq(schema.libraryItem.source, "upload"), inArray(schema.libraryFile.sha256, shas))).limit(1);
    if (f) return f.item;
  }
  const type = TYPES[str(r.category)];
  return (await db.select().from(schema.libraryItem).where(and(eq(schema.libraryItem.teamId, teamId), eq(schema.libraryItem.source, "upload"), eq(schema.libraryItem.projectType, type ?? ""))))
    .find((x) => x.title.toLowerCase() === str(r.name).toLowerCase());
}

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
        await tx.insert(schema.addonSetItem).values({ setId: id, itemId }).onConflictDoNothing();
      }
      if (missing) report.skipped.push({ what: `セット「${str(set.name)}」の ${missing} 件`, detail: "ライブラリに取り込めなかったものは入れていません" });
    }
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
  const sourced = has(v02, "item_sources");
  const items = all(v02, sourced
    ? "SELECT i.id, i.name, i.category, s.provider, s.project_id FROM items i LEFT JOIN item_sources s ON s.item_id = i.id ORDER BY i.id"
    : "SELECT id, name, category FROM items ORDER BY id")
    .filter((r) => TYPES[str(r.category)] && (!only || only.has(str(r.category))) && !(str(r.provider) === "modrinth" && MODRINTH_ID.test(str(r.project_id)))
      && !(str(r.provider) === "spigot" && SPIGOT_ID.test(str(r.project_id)) && str(r.category) === "plugin")
      && !(str(r.provider) === "curseforge" && SPIGOT_ID.test(str(r.project_id))));
  if (!items.length) return uploaded;
  const targets = await v02TargetMap(db, v02, teamId, opts, report);

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
  return uploaded;
}

// v02 の保存先 → v03 の保存先(前に取り込んだものはそれを使う。NFS など v03 に無い方式は null にして知らせる)
async function v02TargetMap(db: Db, v02: DatabaseSync, teamId: string, opts: { secret: string; v02Dir: string; dataDir: string }, report: { skipped: { what: string; detail: string }[] }) {
  const targets = new Map<number, string | null>();
  const keyFile = join(opts.v02Dir, "secret.key");
  const v02Key = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
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
      configSealed: seal(opts.secret, JSON.stringify(config), `storage:${teamId}:${id}`), active: false, v02: true,
    });
    targets.set(Number(t.id), id);
  }

  if (smb.length) report.skipped.push({ what: `v02 の保存先(${smb.length} 個)`, detail: `${smb.join("、")}。v03 で使えない方式(NFS など)なので取り込んでいません(NAS をマウントしてフォルダとして足せます)` });
  return targets;
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

// セットの版の固定(03.59.00 から。v02 の set_items.version_id)。見た目の設定の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 の版はファイル(versions)なので、v03 の配布元の版に対応を取る: Modrinth はファイルの SHA-1、CurseForge はファイルの名前(新しい 30 件の中)、
// アップロードしたものは SHA-256 で取り込んだファイル。SpigotMC は v03 では固定できない。対応が取れないものは「固定を引き継げなかったもの」に出す。
// v03 ですでに固定を決め直したものは上書きしない
export type PinsImportReport = { at: string; pinned: string[]; skipped: { what: string; detail: string }[] };
export const pinsReportPath = (v03Dir: string) => join(v03Dir, "import-v02-pins.json");

export function readPinsReport(v03Dir: string): PinsImportReport | null {
  try {
    return JSON.parse(readFileSync(pinsReportPath(v03Dir), "utf8"));
  } catch {
    return null;
  }
}

export async function maybeImportV02Pins(db: Db, opts: { v02Dir: string; v03Dir: string; secret?: string; fetch?: FetchLike }): Promise<PinsImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(prefsReportPath(opts.v03Dir)) || existsSync(pinsReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report: PinsImportReport = { at: new Date().toISOString(), pinned: [], skipped: [] };
    const rows = has(v02, "set_items", "version_id") && has(v02, "versions") ? all(v02, `SELECT s.name AS set_name, i.name AS item_name, i.category, v.version, v.filename, v.sha256,
        ${has(v02, "versions", "sha1") ? "v.sha1" : "''"} AS sha1, ${has(v02, "item_sources") ? "src.provider, src.project_id" : "'' AS provider, '' AS project_id"}
      FROM set_items si JOIN sets s ON s.id = si.set_id JOIN items i ON i.id = si.item_id LEFT JOIN versions v ON v.id = si.version_id
      ${has(v02, "item_sources") ? "LEFT JOIN item_sources src ON src.item_id = i.id" : ""} WHERE si.version_id IS NOT NULL ORDER BY s.id, i.name`) : [];
    if (!rows.length) {
      writeFileSync(pinsReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      return report;
    }
    const skip = (r: Row, detail: string) => report.skipped.push({ what: `固定を引き継げなかったもの: ${str(r.set_name)} / ${str(r.item_name)} ${str(r.version)}`.trim(), detail });
    // Modrinth はまとめて 1 回で問い合わせる
    const sha1s = [...new Set(rows.filter((r) => v02Source(r) === "modrinth" && /^[0-9a-f]{40}$/i.test(str(r.sha1))).map((r) => str(r.sha1).toLowerCase()))];
    let byHash = new Map<string, { projectId: string; versionId: string; versionNumber: string }>();
    let mrError = "";
    if (sha1s.length && opts.fetch) byHash = await modrinthClient(opts.fetch).byHashes(sha1s).catch((e) => { mrError = (e as Error).message; return byHash; });
    let cf: ReturnType<typeof curseforgeClient> | null = null;
    if (opts.fetch && opts.secret && rows.some((r) => v02Source(r) === "curseforge")) {
      const [k] = await db.select().from(schema.teamCurseforge).where(eq(schema.teamCurseforge.teamId, team.id));
      if (k) cf = curseforgeClient(opts.fetch, open(opts.secret, k.apiKeySealed, `curseforge:${team.id}`));
    }
    for (const r of rows) {
      if (!str(r.filename)) { skip(r, "固定していた版が v02 に残っていません"); continue; }
      const [set] = await db.select({ id: schema.addonSet.id }).from(schema.addonSet)
        .where(and(eq(schema.addonSet.teamId, team.id), eq(schema.addonSet.name, (str(r.set_name) || "セット").slice(0, 60)))).limit(1);
      if (!set) { skip(r, "セットを取り込んでいません"); continue; }
      const source = v02Source(r);
      let itemId: string | null = null;
      let version: { id: string; label: string } | null = null;
      if (source === "spigot") { skip(r, "SpigotMC のものは、v03 では版を固定できません(いちばん新しい版を入れます)"); continue; }
      if (source === "upload") {
        const [f] = await db.select({ id: schema.libraryFile.id, itemId: schema.libraryFile.itemId, version: schema.libraryFile.version, filename: schema.libraryFile.filename })
          .from(schema.libraryFile).innerJoin(schema.libraryItem, eq(schema.libraryFile.itemId, schema.libraryItem.id))
          .where(and(eq(schema.libraryItem.teamId, team.id), eq(schema.libraryFile.sha256, str(r.sha256)))).limit(1);
        if (f) { itemId = f.itemId; version = { id: f.id, label: f.version || f.filename }; }
        else { skip(r, "その版のファイルを取り込んでいません"); continue; }
      } else {
        const [it] = await db.select({ id: schema.libraryItem.id }).from(schema.libraryItem)
          .where(and(eq(schema.libraryItem.teamId, team.id), eq(schema.libraryItem.source, source), eq(schema.libraryItem.projectId, str(r.project_id))));
        if (!it) { skip(r, "ライブラリに取り込んでいません"); continue; }
        itemId = it.id;
        if (!opts.fetch) { skip(r, "配布元に問い合わせられませんでした"); continue; }
        if (source === "modrinth") {
          const hit = byHash.get(str(r.sha1).toLowerCase());
          if (hit && hit.projectId === str(r.project_id)) version = { id: hit.versionId, label: hit.versionNumber };
          else { skip(r, mrError ? `Modrinth につながりませんでした(${mrError})` : "Modrinth に同じファイルの版が見つかりません"); continue; }
        } else {
          if (!cf) { skip(r, "CurseForge の API キーが無いので、版を探せませんでした"); continue; }
          try {
            const hit = (await cf.allFiles(str(r.project_id))).find((v) => v.filename === str(r.filename));
            if (hit) version = { id: hit.versionId, label: hit.versionNumber };
            else { skip(r, "CurseForge の新しい 30 件の中に、同じファイルの版が見つかりません"); continue; }
          } catch (e) {
            skip(r, `CurseForge につながりませんでした(${(e as Error).message})`);
            continue;
          }
        }
      }
      const done = await db.update(schema.addonSetItem).set({ versionId: version.id, versionNumber: version.label })
        .where(and(eq(schema.addonSetItem.setId, set.id), eq(schema.addonSetItem.itemId, itemId), isNull(schema.addonSetItem.versionId)))
        .returning({ id: schema.addonSetItem.itemId });
      if (done.length) report.pinned.push(`${str(r.set_name)} / ${str(r.item_name)} ${version.label}`);
      else {
        const [inSet] = await db.select({ id: schema.addonSetItem.itemId }).from(schema.addonSetItem).where(and(eq(schema.addonSetItem.setId, set.id), eq(schema.addonSetItem.itemId, itemId)));
        if (!inSet) skip(r, "セットに入っていません");
        // 入っていれば、v03 で固定を決め直している(上書きしない)
      }
    }
    writeFileSync(pinsReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// ユーザーごとの権限(03.60.00 から。v02 の users.perms)。セットの版の固定の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 の権限を、下の表で v03 のメンバーごとの権限(member_perm の allow)に置き換える。v02 の管理者・オーナーにしたい人は、もともとすべて持つので飛ばす。
// v03 ですでにメンバーごとの権限を決めた人は上書きしない
export const V02_PERMS: Record<string, { grants: Grant[]; note?: string }> = {
  storage: { grants: ["storage:manage"], note: "パネルのバックアップは、v03 では管理者以上だけです" },
  audit: { grants: ["audit:read"] },
  integrations: { grants: ["integrations:manage"], note: "Pterodactyl のパネルを登録するのは、v03 では「サーバーを追加する」の権限です(要るなら「チーム」で足してください)" },
  system: { grants: ["panel:manage"] },
  users: { grants: [], note: "v03 では、メンバーの招待・役割の変更は管理者以上だけです(要るなら役割を管理者にしてください)" },
};
export type PermsImportReport = { at: string; users: { name: string; grants: string[] }[]; skipped: { what: string; detail: string }[] };
export const permsReportPath = (v03Dir: string) => join(v03Dir, "import-v02-perms.json");

export function readPermsReport(v03Dir: string): PermsImportReport | null {
  try {
    return JSON.parse(readFileSync(permsReportPath(v03Dir), "utf8"));
  } catch {
    return null;
  }
}

export async function maybeImportV02Perms(db: Db, opts: { v02Dir: string; v03Dir: string }): Promise<PermsImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(pinsReportPath(opts.v03Dir)) || existsSync(permsReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report: PermsImportReport = { at: new Date().toISOString(), users: [], skipped: [] };
    for (const u of has(v02, "users", "perms") ? all(v02, "SELECT id, username, perms FROM users ORDER BY id") : []) {
      let list: unknown = [];
      try {
        list = JSON.parse(str(u.perms) || "[]");
      } catch { /* 読めない権限は無いものとする(v02 と同じ) */ }
      const perms = Array.isArray(list) ? [...new Set(list.map(String))] : [];
      if (!perms.length) continue;
      const [m] = await db.select({ id: schema.member.id, role: schema.member.role }).from(schema.member)
        .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
        .where(and(eq(schema.member.organizationId, team.id), eq(schema.user.email, `u${str(u.id)}@v02.craftshelf.invalid`)));
      const name = str(u.username);
      if (!m) { report.skipped.push({ what: `${name} さんの権限`, detail: "v03 のチームにいません" }); continue; }
      if (m.role.split(",").some((r) => r === "owner" || r === "admin")) continue; // もともとすべて持つ
      const grants = [...new Set(perms.flatMap((p) => V02_PERMS[p]?.grants ?? []))];
      for (const p of perms) {
        const note = V02_PERMS[p] ? V02_PERMS[p].note : "v03 に同じ権限がありません";
        if (note) report.skipped.push({ what: `${name} さんの権限「${p}」`, detail: note });
      }
      if (!grants.length) continue;
      const done = await db.insert(schema.memberPerm).values({ memberId: m.id, allow: JSON.stringify(grants) }).onConflictDoNothing().returning({ id: schema.memberPerm.memberId });
      if (done.length) report.users.push({ name, grants });
    }
    writeFileSync(permsReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// 配布元のファイルの保存(03.61.00 から。v02 はどのアイテムもファイルを持っていた)。ユーザーごとの権限の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// ・v02 の「新しいバージョンを自動でダウンロード」(auto_download)→ チームの「配布元のファイルを保存する」
// ・v02 のアイテムの「残す数」(items.keep_versions)→ アイテムの古い版を残す数(v03 で決めたものは上書きしない)
// ・配布元のわかるアイテムの v02 のファイル → 保存した版(v02 の保存先のファイルをそのまま指す。コピーしない)。配布元の版は、
//   Modrinth はファイルの SHA-1 で探し(まとめて 1 回)、わからないものは "v02:<v02 の版の番号>" にする(配布元につながらないときの代わりに使える)
export type SavedImportReport = { at: string; keepFiles: boolean; keepVersions: string[]; files: number; skipped: { what: string; detail: string }[] };
export const savedReportPath = (v03Dir: string) => join(v03Dir, "import-v02-saved.json");

export async function maybeImportV02Saved(db: Db, opts: { v02Dir: string; v03Dir: string; secret?: string; dataDir?: string; fetch?: FetchLike }): Promise<SavedImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(permsReportPath(opts.v03Dir)) || existsSync(savedReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report: SavedImportReport = { at: new Date().toISOString(), keepFiles: false, keepVersions: [], files: 0, skipped: [] };
    const auto = has(v02, "settings") ? (v02.prepare("SELECT value FROM settings WHERE key='auto_download'").get() as Row | undefined)?.value : undefined;
    if (str(auto) === "1") {
      await db.insert(schema.teamOption).values({ teamId: team.id, keepFiles: true }).onConflictDoUpdate({ target: schema.teamOption.teamId, set: { keepFiles: true } });
      report.keepFiles = true;
    }
    const sourced = has(v02, "item_sources");
    const items = has(v02, "items") ? all(v02, sourced
      ? `SELECT i.id, i.name, i.category, ${has(v02, "items", "keep_versions") ? "i.keep_versions" : "0 AS keep_versions"}, s.provider, s.project_id FROM items i LEFT JOIN item_sources s ON s.item_id = i.id ORDER BY i.id`
      : `SELECT id, name, category, ${has(v02, "items", "keep_versions") ? "keep_versions" : "0 AS keep_versions"} FROM items ORDER BY id`) : [];
    for (const r of items.filter((x) => Number(x.keep_versions) > 0)) {
      const it = await v03ItemOf(db, team.id, r);
      if (!it || it.keepVersions !== null) continue;
      await db.update(schema.libraryItem).set({ keepVersions: Math.min(100, Number(r.keep_versions)) }).where(eq(schema.libraryItem.id, it.id));
      report.keepVersions.push(`${it.title}(${Math.min(100, Number(r.keep_versions))} 個)`);
    }
    const up = items.filter((r) => v02Source(r) !== "upload");
    if (up.length && opts.secret && has(v02, "versions", "relpath")) {
      const targets = await v02TargetMap(db, v02, team.id, { secret: opts.secret, v02Dir: opts.v02Dir, dataDir: opts.dataDir ?? opts.v02Dir }, report);
      const sha1Col = has(v02, "versions", "sha1");
      const versions = all(v02, `SELECT * FROM versions WHERE item_id IN (${up.map((r) => Number(r.id)).join(",")}) ORDER BY id`).filter((v) => targets.get(Number(v.target_id ?? 1)));
      const sha1s = sha1Col ? [...new Set(versions.map((v) => str(v.sha1).toLowerCase()).filter((h) => /^[0-9a-f]{40}$/.test(h)))] : [];
      const byHash = sha1s.length && opts.fetch ? await modrinthClient(opts.fetch).byHashes(sha1s).catch(() => new Map<string, { projectId: string; versionId: string; versionNumber: string }>()) : new Map();
      for (const r of up) {
        const mine = versions.filter((v) => Number(v.item_id) === Number(r.id));
        if (!mine.length) continue;
        const it = await v03ItemOf(db, team.id, r);
        if (!it) { report.skipped.push({ what: `${str(r.name)} のファイル`, detail: "ライブラリに取り込んでいません" }); continue; }
        for (const v of mine) {
          const sha = str(v.sha256);
          if (sha && (await db.select({ id: schema.libraryFile.id }).from(schema.libraryFile).where(and(eq(schema.libraryFile.itemId, it.id), eq(schema.libraryFile.sha256, sha))).limit(1)).length) continue;
          let meta: Record<string, unknown> = {};
          try {
            meta = JSON.parse(str(v.meta) || "{}");
          } catch { /* 読めなければ空 */ }
          const hit = byHash.get(str(v.sha1).toLowerCase());
          await db.insert(schema.libraryFile).values({
            id: randomUUID(), itemId: it.id, targetId: targets.get(Number(v.target_id ?? 1))!, storageKey: `library/${str(v.relpath).replace(/^\/+/, "")}`,
            filename: str(v.filename), size: Number(v.size) || 0, sha256: sha, version: str(v.version), loaders: JSON.stringify(loadersOf(str(meta.loader))), mcVersions: "[]",
            createdAt: new Date(str(v.added_at) || Date.now()), upstreamVersionId: hit && hit.projectId === str(r.project_id) ? hit.versionId : `v02:${str(v.id)}`,
          });
          report.files++;
        }
      }
    }
    writeFileSync(savedReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// パネルの自動アップデート(03.62.00 から。v02 の self_auto_update)。v02 から取り込んだパネルで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 のパネルが受け取るのは安定版だけ(02.21.01 から)なので、v03 でも安定版だけにする。v03 ですでに決めていれば上書きしない
export const selfUpdateReportPath = (v03Dir: string) => join(v03Dir, "import-v02-selfupdate.json");

export function maybeImportV02SelfUpdate(opts: { v02Dir: string; v03Dir: string }): { at: string; auto: boolean } | null {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(reportPath(opts.v03Dir)) || existsSync(selfUpdateReportPath(opts.v03Dir))) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const on = has(v02, "settings") && str((v02.prepare("SELECT value FROM settings WHERE key='self_auto_update'").get() as Row | undefined)?.value) === "1";
    const report = { at: new Date().toISOString(), auto: false };
    if (on && !existsSync(updateStatePath(opts.v03Dir))) {
      writeUpdateState(opts.v03Dir, { ...readUpdateState(opts.v03Dir), auto: true, channel: "stable" });
      report.auto = true;
    }
    writeFileSync(selfUpdateReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// 背景画像(03.63.00 から。v02 の「マイ画像」= テーマ custom の users.prefs.bg_file、CONFIG_DIR/backgrounds/ のファイル)。
// 見た目の設定の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。v03 で背景画像を一度でも決めた人は上書きしない。
// v03 では縮めずに置ける大きさ(PREF_LIMITS.backgroundBytes)までなので、大きいものは引き継がず理由を残す(画面で選び直すと縮めて保存する)
export const backgroundReportPath = (v03Dir: string) => join(v03Dir, "import-v02-background.json");
const V02_BG = /^u\d+-[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

export async function maybeImportV02Backgrounds(db: Db, opts: { v02Dir: string; v03Dir: string }): Promise<{ at: string; users: string[]; skipped: { what: string; detail: string }[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(prefsReportPath(opts.v03Dir)) || existsSync(backgroundReportPath(opts.v03Dir))) return null;
  const { backgroundOf } = await import("./prefs");
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), users: [] as string[], skipped: [] as { what: string; detail: string }[] };
    for (const u of has(v02, "users", "prefs") ? all(v02, "SELECT id, username, prefs FROM users") : []) {
      let p: Row = {};
      try {
        p = JSON.parse(str(u.prefs) || "{}") as Row;
      } catch { /* 読めない設定は飛ばす */ }
      const name = str(p.bg_file);
      if (str(p.theme) !== "custom" || !V02_BG.test(name)) continue;
      const [v03] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, `u${str(u.id)}@v02.craftshelf.invalid`));
      if (!v03) continue;
      const file = join(opts.v02Dir, "backgrounds", name);
      let background: string;
      try {
        background = backgroundOf(readFileSync(file));
      } catch (e) {
        report.skipped.push({ what: `背景画像: ${str(u.username)}`, detail: existsSync(file) ? (e instanceof Error ? e.message : String(e)) : "v02 の背景画像のファイルが見つかりません" });
        continue;
      }
      const now = new Date();
      const added = await db.insert(schema.userPref).values({ userId: v03.id, background, backgroundAt: now }).onConflictDoNothing().returning({ id: schema.userPref.userId });
      const done = added.length ? added : await db.update(schema.userPref).set({ background, backgroundAt: now })
        .where(and(eq(schema.userPref.userId, v03.id), isNull(schema.userPref.backgroundAt))).returning({ id: schema.userPref.userId });
      if (done.length) report.users.push(str(u.username));
    }
    writeFileSync(backgroundReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// ホームのウィジェットの並び(03.69.00 から。v02 の users.prefs.dash = order・hidden・full・custom のメモ / ToDo / 時計 / 今日の日付)。
// 背景画像の取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。v03 でもう並びを決めた人は上書きしない。v02 のウィジェットの名前は v03 と同じ
export const dashReportPath = (v03Dir: string) => join(v03Dir, "import-v02-dash.json");

export async function maybeImportV02Dash(db: Db, opts: { v02Dir: string; v03Dir: string }): Promise<{ at: string; users: string[] } | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(backgroundReportPath(opts.v03Dir)) || existsSync(dashReportPath(opts.v03Dir))) return null;
  const { cleanDash } = await import("~/lib/dash");
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report = { at: new Date().toISOString(), users: [] as string[] };
    for (const u of has(v02, "users", "prefs") ? all(v02, "SELECT id, username, prefs FROM users") : []) {
      let p: Row = {};
      try {
        p = JSON.parse(str(u.prefs) || "{}") as Row;
      } catch { /* 読めない設定は飛ばす */ }
      if (!p.dash || typeof p.dash !== "object") continue;
      const [v03] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, `u${str(u.id)}@v02.craftshelf.invalid`));
      if (!v03) continue;
      const dash = JSON.stringify(cleanDash(p.dash));
      const added = await db.insert(schema.userPref).values({ userId: v03.id, dash }).onConflictDoNothing().returning({ id: schema.userPref.userId });
      const done = added.length ? added : await db.update(schema.userPref).set({ dash }).where(and(eq(schema.userPref.userId, v03.id), isNull(schema.userPref.dash))).returning({ id: schema.userPref.userId });
      if (done.length) report.users.push(str(u.username));
    }
    writeFileSync(dashReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// 結果のファイルを読む(無い・読めないときは null)
export function readReportFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// v02 の前提の名前の比べ方(core.norm_key・analysis.canonical_dep と同じ): 大文字小文字・記号・空白を無視し、Fabric API の部品は Fabric API にまとめる
export const v02NormKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") || name.toLowerCase();
const v02CanonicalDep = (name: string) => {
  const n = name.trim();
  return n.toLowerCase() === "fabric" || /^fabric(-api-base|-[a-z0-9]+(-[a-z0-9]+)*-v\d+)$/.test(n.toLowerCase()) ? "fabric-api" : n;
};

// 前提の手での紐付け(03.64.00 から。v02 の dep_links = 保存先 × 前提の名前 → アイテム)。配布元のファイルの取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 の各アイテムのいちばん新しい版の depends に紐付けた名前があれば、v03 では「そのアイテムの前提は紐付け先のアイテム」(library_dep)にする。
// v03 で手で決める前提は必須の前提だけなので、softdepends の紐付けは理由を残して引き継がない
export type DepsImportReport = { at: string; linked: string[]; skipped: { what: string; detail: string }[] };
export const depsReportPath = (v03Dir: string) => join(v03Dir, "import-v02-deps.json");

export async function maybeImportV02Deps(db: Db, opts: { v02Dir: string; v03Dir: string }): Promise<DepsImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(savedReportPath(opts.v03Dir)) || existsSync(depsReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report: DepsImportReport = { at: new Date().toISOString(), linked: [], skipped: [] };
    const sourced = has(v02, "item_sources");
    const cols = `i.id, i.name, i.category, ${sourced ? "s.provider, s.project_id" : "'' AS provider, '' AS project_id"}`;
    const joinSrc = sourced ? "LEFT JOIN item_sources s ON s.item_id = i.id" : "";
    const links = has(v02, "dep_links") && has(v02, "items") && has(v02, "versions")
      ? all(v02, `SELECT d.target_id, d.dep_key, d.item_id, ${cols} FROM dep_links d JOIN items i ON i.id = d.item_id ${joinSrc}`) : [];
    if (links.length) {
      const byKey = new Map(links.map((l) => [`${Number(l.target_id)}:${str(l.dep_key)}`, l]));
      const items = all(v02, `SELECT ${cols} FROM items i ${joinSrc} ORDER BY i.id`);
      // shortcut: いちばん新しい版は追加した順で選ぶ(v02 は版の番号の順)。古い版をあとから足したアイテムだけずれる。問題になったら v02 の version_key を移す
      const versions = all(v02, "SELECT item_id, target_id, sha256, meta FROM versions ORDER BY added_at DESC, id DESC");
      const shasOf = (id: unknown) => versions.filter((v) => Number(v.item_id) === Number(id)).map((v) => str(v.sha256)).filter(Boolean);
      const seen = new Set<string>();
      for (const it of items) {
        const v = versions.find((x) => Number(x.item_id) === Number(it.id));
        if (!v) continue;
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(str(v.meta) || "{}");
        } catch { /* 読めなければ前提なし */ }
        for (const [required, list] of [[true, meta.depends], [false, meta.softdepends]] as const) {
          for (const raw of Array.isArray(list) ? list.map(String) : []) {
            const l = byKey.get(`${Number(v.target_id)}:${v02NormKey(raw)}`) ?? byKey.get(`${Number(v.target_id)}:${v02NormKey(v02CanonicalDep(raw))}`);
            if (!l || Number(l.item_id) === Number(it.id) || seen.has(`${it.id}:${l.item_id}`)) continue;
            seen.add(`${it.id}:${l.item_id}`);
            const what = `前提の紐付け: ${str(it.name)} → ${str(l.name)}(${raw})`;
            if (!required) {
              report.skipped.push({ what, detail: "v02 では任意の前提(softdepend)でした。v03 で手で決める前提は必須の前提だけなので、引き継いでいません" });
              continue;
            }
            const from = await v03ItemOf(db, team.id, it, shasOf(it.id));
            const to = await v03ItemOf(db, team.id, l, shasOf(l.item_id));
            if (!from || !to) {
              report.skipped.push({ what, detail: `「${str(from ? l.name : it.name)}」をライブラリに取り込んでいません` });
              continue;
            }
            if (from.id === to.id) continue;
            const done = await db.insert(schema.libraryDep).values({ itemId: from.id, depItemId: to.id }).onConflictDoNothing().returning({ id: schema.libraryDep.itemId });
            if (done.length) report.linked.push(`${from.title} → ${to.title}`);
          }
        }
      }
    }
    writeFileSync(depsReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}

// 共有リンク(03.64.00 から。v02 の shares)。配布元のファイルの取り込みのあとで一度だけ(前に取り込んだパネルも、次の起動で)。
// v02 と v03 は、トークンのハッシュの作り方(SHA-256 の 16 進)も URL の形(/s/<トークン>/<ファイル名>)も同じなので、ハッシュをそのまま引き継げば配った URL がそのまま開ける。
// 中身は v02 の版の SHA-256 で取り込んだファイルを探す。見つからない版は外し、1 つも残らないもの・期限切れのものは引き継がない。期限・ダウンロードの回数は v02 のまま(回数の上限は無し)
export type SharesImportReport = { at: string; links: string[]; skipped: { what: string; detail: string }[] };
export const sharesReportPath = (v03Dir: string) => join(v03Dir, "import-v02-shares.json");

export async function maybeImportV02Shares(db: Db, opts: { v02Dir: string; v03Dir: string }, now = new Date()): Promise<SharesImportReport | null> {
  const dbFile = join(opts.v02Dir, "index.db");
  if (!existsSync(dbFile) || !existsSync(savedReportPath(opts.v03Dir)) || existsSync(sharesReportPath(opts.v03Dir))) return null;
  const [team] = await db.select({ id: schema.organization.id }).from(schema.organization).orderBy(asc(schema.organization.createdAt)).limit(1);
  if (!team) return null;
  const { safeZipName } = await import("./shares");
  const v02 = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const report: SharesImportReport = { at: now.toISOString(), links: [], skipped: [] };
    const owned = has(v02, "shares", "owner_id");
    for (const s of has(v02, "shares") && has(v02, "versions") ? all(v02, "SELECT * FROM shares ORDER BY id") : []) {
      const name = (str(s.name) || "共有リンク").slice(0, 80);
      const what = `共有リンク「${name}」`;
      const hash = str(s.token_hash);
      const expiresAt = new Date(str(s.expires_at));
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        report.skipped.push({ what, detail: "v02 のデータが読めません" });
        continue;
      }
      if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
        report.skipped.push({ what, detail: "期限が切れています" });
        continue;
      }
      if ((await db.select({ id: schema.shareLink.id }).from(schema.shareLink).where(eq(schema.shareLink.tokenHash, hash))).length) continue;
      let ids: unknown = [];
      try {
        ids = JSON.parse(str(s.versions) || "[]");
      } catch { /* 読めなければ空 */ }
      const vids = (Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isInteger(x));
      const shas = vids.length ? all(v02, `SELECT id, sha256 FROM versions WHERE id IN (${vids.join(",")})`) : [];
      const files: { id: string; filename: string }[] = [];
      for (const id of vids) {
        const sha = str(shas.find((v) => Number(v.id) === id)?.sha256);
        const [f] = sha ? await db.select({ id: schema.libraryFile.id, filename: schema.libraryFile.filename }).from(schema.libraryFile)
          .innerJoin(schema.libraryItem, eq(schema.libraryFile.itemId, schema.libraryItem.id))
          .where(and(eq(schema.libraryItem.teamId, team.id), eq(schema.libraryFile.sha256, sha))).limit(1) : [];
        if (f && !files.some((x) => x.id === f.id)) files.push(f);
      }
      if (!files.length) {
        report.skipped.push({ what, detail: "共有していた版を v03 に取り込んでいません" });
        continue;
      }
      if (files.length < vids.length) report.skipped.push({ what: `${what}の ${vids.length - files.length} 件`, detail: "v03 に取り込んでいない版は外しました(ほかは同じ URL で渡せます)" });
      const [by] = owned ? await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, `u${str(s.owner_id)}@v02.craftshelf.invalid`)) : [];
      const created = new Date(str(s.created_at));
      await db.insert(schema.shareLink).values({
        id: randomUUID(), teamId: team.id, tokenHash: hash, name, fileIds: JSON.stringify(files.map((f) => f.id)),
        filename: files.length === 1 ? files[0].filename : safeZipName(name), createdBy: by?.id ?? null,
        createdAt: Number.isNaN(created.getTime()) ? now : created, expiresAt, downloads: Number(s.downloads) || 0, maxDownloads: null,
      });
      report.links.push(name);
    }
    writeFileSync(sharesReportPath(opts.v03Dir), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    v02.close();
  }
}
