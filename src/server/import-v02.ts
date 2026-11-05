// v02 のデータの取り込み(自分用の版が、v02 と同じ /data で初めて起動したとき)。
// v02 のデータベースは読み取り専用で開き、何も書き込まない(イメージを v02 に戻せば、そのまま v02 で使える)
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, asc, count, eq } from "drizzle-orm";
import { MC_VERSION, type Platform, isPlatform } from "~/lib/platforms";
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
// v03 はファイルを持たないので、配布元が Modrinth とわかるプラグイン・Mod と、SpigotMC とわかるプラグインだけを目録に載せる
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
    return report;
  } finally {
    v02.close();
  }
}

const MODRINTH_ID = /^[A-Za-z0-9]{8}$/;
const SPIGOT_ID = /^\d{1,9}$/;
const TYPES: Record<string, string> = { plugin: "plugin", mod: "mod" };
const listOf = (names: string[]) => names.slice(0, 20).join("、") + (names.length > 20 ? ` ほか ${names.length - 20} 件` : "");

// uploaded: アップロードとして取り込んだもの(v02 のアイテムの ID → v03 のライブラリの ID)。セットに入れるのに使う
export async function importLibrary(db: Db, v02: DatabaseSync, teamId: string, uploaded = new Map<number, string>()): Promise<LibraryImportReport> {
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
      const id = randomUUID();
      await tx.insert(schema.addonSet).values({ id, teamId, name: (str(set.name) || "セット").slice(0, 60) });
      report.sets++;
      const members = v02.prepare("SELECT item_id, version_id FROM set_items WHERE set_id=?").all(Number(set.id)) as Row[];
      let missing = 0;
      for (const m of members) {
        const itemId = mapped.get(Number(m.item_id)) ?? uploaded.get(Number(m.item_id));
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
    report.skipped.push({ what: `データパックなど(${otherKinds.length} 件)`, detail: `v03 はプラグインと Mod だけを扱います: ${listOf(otherKinds)}` });
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

// アップロードしたアドオン(03.17.00 から)。配布元が Modrinth・SpigotMC とわからないプラグイン・Mod を、v02 の保存先のファイルを
// そのまま指す形で取り込む(コピーしない)。v02 のパネルの中の保存先(/data/library)・WebDAV を、v03 の保存先として登録する
const LOADERS: [RegExp, string[]][] = [
  [/folia/i, ["folia"]], [/bukkit|spigot/i, ["bukkit", "spigot", "paper", "purpur"]], [/paper/i, ["paper", "purpur"]],
  [/bungee/i, ["bungeecord", "waterfall"]], [/velocity/i, ["velocity"]], [/neoforge/i, ["neoforge"]], [/(^|[^o])forge/i, ["forge"]],
  [/fabric/i, ["fabric", "quilt"]], [/quilt/i, ["quilt"]],
];
const loadersOf = (label: string) => [...new Set(LOADERS.filter(([re]) => re.test(label)).flatMap(([, l]) => l))];

export async function importUploads(db: Db, v02: DatabaseSync, teamId: string, opts: { secret: string; v02Dir: string; dataDir: string }, report: LibraryImportReport) {
  report.uploads = 0;
  const uploaded = new Map<number, string>();
  if (!has(v02, "items") || !has(v02, "versions", "relpath")) return uploaded;
  const keyFile = join(opts.v02Dir, "secret.key");
  const v02Key = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
  const sourced = has(v02, "item_sources");
  const items = all(v02, sourced
    ? "SELECT i.id, i.name, i.category, s.provider, s.project_id FROM items i LEFT JOIN item_sources s ON s.item_id = i.id ORDER BY i.id"
    : "SELECT id, name, category FROM items ORDER BY id")
    .filter((r) => TYPES[str(r.category)] && !(str(r.provider) === "modrinth" && MODRINTH_ID.test(str(r.project_id)))
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
    const id = randomUUID();
    await db.insert(schema.storageTarget).values({
      id, teamId, name: `v02: ${str(t.name) || proto}`.slice(0, 60), kind: config.kind, summary,
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
