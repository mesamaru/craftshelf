// アプリの表(認証の表は auth-schema.ts)。変更は「足すだけ」
import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

// チームが登録した Pterodactyl パネル(API キーは暗号化して保存)
export const pteroConnection = pgTable(
  "ptero_connection",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    apiKeySealed: text("api_key_sealed").notNull(),
    apiKeyHint: text("api_key_hint").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("ptero_connection_team_idx").on(t.teamId)],
);

// チームが管理するサーバー。kind = "ptero"(Pterodactyl に直接)/ "agent"(エージェント経由、これから)
export const server = pgTable(
  "server",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    pteroConnectionId: text("ptero_connection_id").references(() => pteroConnection.id, { onDelete: "cascade" }),
    remoteId: text("remote_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("server_team_idx").on(t.teamId),
    uniqueIndex("server_ptero_remote_uq").on(t.pteroConnectionId, t.remoteId),
  ],
);

// サーバーの種類(paper・fabric など)と Minecraft のバージョン。Mod・プラグインを探すときの絞り込みに使う
export const serverProfile = pgTable("server_profile", {
  serverId: text("server_id").primaryKey().references(() => server.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  mcVersion: text("mc_version"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// このアプリから入れた Mod・プラグイン(どの配布元のどの版か。更新の確認に使う)
export const installedMod = pgTable(
  "installed_mod",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    projectId: text("project_id").notNull(),
    versionId: text("version_id").notNull(),
    versionNumber: text("version_number").notNull(),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    installedBy: text("installed_by").references(() => user.id, { onDelete: "set null" }),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("installed_mod_server_file_uq").on(t.serverId, t.filename), index("installed_mod_server_idx").on(t.serverId)],
);

// v02 から取り込んだ人の二段階認証(v02 の秘密の値を暗号化して保存)。v03 で二段階認証を設定し直したら消す
export const legacyTotp = pgTable("legacy_totp", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  secretSealed: text("secret_sealed").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// チームのライブラリ(使う Mod・プラグインの目録)。ファイルは持たず、配布元のプロジェクトだけを記録する。
// サーバーに入れたものは自動で載る。project_type = "plugin" / "mod"
export const libraryItem = pgTable(
  "library_item",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull().default(""),
    projectType: text("project_type").notNull(),
    iconUrl: text("icon_url").notNull().default(""),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("library_item_team_project_uq").on(t.teamId, t.source, t.projectId)],
);

// セット: ライブラリから選んだものの組み合わせ。サーバーにまとめて入れる
export const addonSet = pgTable(
  "addon_set",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("addon_set_team_idx").on(t.teamId)],
);

export const addonSetItem = pgTable(
  "addon_set_item",
  {
    setId: text("set_id").notNull().references(() => addonSet.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull().references(() => libraryItem.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.setId, t.itemId] })],
);

// ポート管理: 種類(表の列)。mode = group(開始番号 + グループ番号から size 個)/ fixed(from–to)/ free(自由)。
// file・key は読み書きする設定ファイルと項目(空 = 記録だけ)
export const portKind = pgTable(
  "port_kind",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mode: text("mode").notNull().default("free"),
    start: integer("start"),
    size: integer("size"),
    rangeFrom: integer("range_from"),
    rangeTo: integer("range_to"),
    proto: text("proto").notNull().default("TCP"),
    file: text("file").notNull().default(""),
    key: text("key").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("port_kind_team_idx").on(t.teamId)],
);

// ポート管理: グループ(表の行のまとまり)。number は範囲の計算に使う(例 "90")
export const portGroup = pgTable(
  "port_group",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("port_group_team_idx").on(t.teamId)],
);

// サーバーごとのポート管理の情報(グループ・メモ・どのマシンで動くか = Pterodactyl のノード・最後に読み取った時刻)
export const serverPortInfo = pgTable("server_port_info", {
  serverId: text("server_id").primaryKey().references(() => server.id, { onDelete: "cascade" }),
  groupId: text("group_id").references(() => portGroup.id, { onDelete: "set null" }),
  memo: text("memo").notNull().default(""),
  machine: text("machine").notNull().default(""),
  scannedAt: timestamp("scanned_at"),
});

// サーバーのポート。source = allocation(Pterodactyl の割り当て)/ file(設定ファイルから読んだ)/ manual(手入力)/ found(見つけて、まだ聞いている)/ adopted(見つけて管理することにしたもの)。
// ignored = 「管理から外す」を選んだもの(次の読み取りでも出さない)
export const serverPort = pgTable(
  "server_port",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
    kindId: text("kind_id").references(() => portKind.id, { onDelete: "set null" }),
    port: integer("port").notNull(),
    source: text("source").notNull(),
    file: text("file").notNull().default(""),
    key: text("key").notNull().default(""),
    label: text("label").notNull().default(""),
    memo: text("memo").notNull().default(""),
    ignored: boolean("ignored").notNull().default(false),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("server_port_server_idx").on(t.serverId)],
);

// サーバーに結び付けたセット(1 台に 1 つ)。「セットでそろえる」で、足りないものを入れ、新しい版があれば更新する
export const serverSet = pgTable("server_set", {
  serverId: text("server_id").primaryKey().references(() => server.id, { onDelete: "cascade" }),
  setId: text("set_id").notNull().references(() => addonSet.id, { onDelete: "cascade" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
