// アプリの表(認証の表は auth-schema.ts)。変更は「足すだけ」
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
