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
