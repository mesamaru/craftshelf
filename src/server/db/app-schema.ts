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
    // 自動更新(03.49.00 から): 入れておくと、6 時間ごとに新しい版があれば入れる。auto_updated_at は最後に確かめた時刻
    autoUpdate: boolean("auto_update").notNull().default(false),
    autoUpdatedAt: timestamp("auto_updated_at"),
    // 新しい版の見回り(03.51.00 から): 最後に確かめた時刻と、そのとき知らせた「新しい版」の行(同じものを 2 度知らせない)
    updateCheckedAt: timestamp("update_checked_at"),
    updateNotice: text("update_notice").notNull().default(""),
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

// ライブラリのタグ(チームの中で共有。チームはアイテムからたどる)
export const libraryTag = pgTable(
  "library_tag",
  {
    itemId: text("item_id").notNull().references(() => libraryItem.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tag] })],
);

// ライブラリのお気に入り(利用者ごと)
export const libraryFavorite = pgTable(
  "library_favorite",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull().references(() => libraryItem.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemId] })],
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

// 操作の記録(だれが・いつ・何をしたか)。user_id が null のものは予約で動いたもの。kind は Discord に知らせる種類
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    detail: text("detail").notNull().default(""),
    at: timestamp("at").defaultNow().notNull(),
  },
  (t) => [index("audit_log_team_at_idx").on(t.teamId, t.at)],
);

// チームの Discord への通知(Webhook の URL は暗号化して保存)。kinds は知らせる種類の JSON の配列
export const teamNotify = pgTable("team_notify", {
  teamId: text("team_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  webhookSealed: text("webhook_sealed").notNull(),
  webhookHint: text("webhook_hint").notNull(),
  kinds: text("kinds").notNull().default("[]"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// チームの決めごと(03.52.00 から)。editor_files = 編集者にも設定ファイルを見る・直すのを許す(既定は管理者以上だけ)
export const teamOption = pgTable("team_option", {
  teamId: text("team_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  editorFiles: boolean("editor_files").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// お知らせ(ベル)をどこまで読んだか(利用者 × チーム。どの端末でも同じにする)
export const noticeSeen = pgTable(
  "notice_seen",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.teamId] })],
);

// チームの予約: 決めた曜日・時刻に、セットを結び付けたサーバーをそろえる(mode = sync)か、確かめるだけ(check)。
// days は曜日(0 = 日曜)の JSON の配列、time は "HH:MM"(tz の時刻)
export const teamSchedule = pgTable("team_schedule", {
  teamId: text("team_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  mode: text("mode").notNull().default("check"),
  time: text("time").notNull().default("04:00"),
  days: text("days").notNull().default("[0,1,2,3,4,5,6]"),
  tz: text("tz").notNull().default("Asia/Tokyo"),
  lastRunAt: timestamp("last_run_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// サーバーの設定ファイルの編集の履歴(保存する前の中身。そこから戻せる)
export const serverFileHistory = pgTable(
  "server_file_history",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    savedBy: text("saved_by").references(() => user.id, { onDelete: "set null" }),
    savedAt: timestamp("saved_at").defaultNow().notNull(),
  },
  (t) => [index("server_file_history_idx").on(t.serverId, t.path, t.savedAt)],
);

// サーバーごとの「更新を止める」(そろえる・予約・更新の確認で、新しい版にしない)
export const serverHold = pgTable(
  "server_hold",
  {
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    projectId: text("project_id").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.source, t.projectId] })],
);

// フォルダでつなぐサーバー(自分用の版だけ)。root_dir はパネルから見えるサーバーのフォルダ。
// 起動・停止は control = none / command(パネルの PC でコマンドを実行)/ docker(コンテナを操作)。RCON のパスワードは暗号化して保存
export const localServer = pgTable("local_server", {
  serverId: text("server_id").primaryKey().references(() => server.id, { onDelete: "cascade" }),
  rootDir: text("root_dir").notNull(),
  control: text("control").notNull().default("none"),
  startCmd: text("start_cmd").notNull().default(""),
  stopCmd: text("stop_cmd").notNull().default(""),
  container: text("container").notNull().default(""),
  rconPort: integer("rcon_port"),
  rconPasswordSealed: text("rcon_password_sealed").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// アップロードしたアドオンの保存先(自分用の版だけ)。kind = local(フォルダ。NAS をマウントしたものでもよい)/ webdav / smb。
// config は種類ごとの設定の JSON を暗号化したもの(パスワードを含むため)。active が今の保存先(チームに 1 つ)
export const storageTarget = pgTable(
  "storage_target",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    configSealed: text("config_sealed").notNull(),
    summary: text("summary").notNull().default(""),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("storage_target_team_idx").on(t.teamId)],
);

// アップロードしたアドオンの版(ファイル)。storage_key は保存先の中の場所。loaders は動くサーバーの種類の JSON の配列
export const libraryFile = pgTable(
  "library_file",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => libraryItem.id, { onDelete: "cascade" }),
    targetId: text("target_id").references(() => storageTarget.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    version: text("version").notNull().default(""),
    loaders: text("loaders").notNull().default("[]"),
    mcVersions: text("mc_versions").notNull().default("[]"),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("library_file_item_idx").on(t.itemId), index("library_file_sha_idx").on(t.sha256)],
);

// チームの CurseForge の API キー(自分用の版だけ。利用者が console.curseforge.com で作ったもの。暗号化して保存)
export const teamCurseforge = pgTable("team_curseforge", {
  teamId: text("team_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  apiKeySealed: text("api_key_sealed").notNull(),
  apiKeyHint: text("api_key_hint").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// 更新で入れ替えた前の版(前の版に戻すのに使う。サーバー × 配布元 × ID の、新しい順)
export const installHistory = pgTable(
  "install_history",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    projectId: text("project_id").notNull(),
    versionId: text("version_id").notNull(),
    versionNumber: text("version_number").notNull(),
    filename: text("filename").notNull(),
    replacedAt: timestamp("replaced_at").defaultNow().notNull(),
  },
  (t) => [index("install_history_idx").on(t.serverId, t.source, t.projectId, t.replacedAt)],
);

// 共有リンク(アップロードした版を、ログインしていない人に渡す)。トークンはハッシュだけを保存する。file_ids は版の ID の JSON の配列
export const shareLink = pgTable(
  "share_link",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    fileIds: text("file_ids").notNull(),
    filename: text("filename").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    downloads: integer("downloads").notNull().default(0),
  },
  (t) => [uniqueIndex("share_link_token_uq").on(t.tokenHash), index("share_link_team_idx").on(t.teamId)],
);

// ユーザーごとのサーバーの割り当て(v02 の 02.23)。member_server_limit に行がある人(閲覧者・編集者)は、
// member_server で割り当てられたサーバーだけを見る・使える。管理者・オーナーはいつでもすべて
export const memberServerLimit = pgTable(
  "member_server_limit",
  {
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const memberServer = pgTable(
  "member_server",
  {
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId, t.serverId] })],
);

// サーバー本体(jar)を入れ替えた記録。入れ替える前の jar は backup_jar の名前で 1 つだけ残し、そこへ戻せる。
// size は入れ替えたときの jar の大きさ(同じなら、入れ替えたビルドのまま。サーバーを再起動するまで version_history.json は古いため)
export const serverSoftware = pgTable("server_software", {
  serverId: text("server_id").primaryKey().references(() => server.id, { onDelete: "cascade" }),
  jar: text("jar").notNull(),
  build: text("build").notNull().default(""),
  mc: text("mc").notNull().default(""),
  size: integer("size").notNull().default(0),
  backupJar: text("backup_jar").notNull().default(""),
  backupBuild: text("backup_build").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// サーバーのアドオンの変更の履歴(v02 の「履歴と巻き戻し」)。removed は外した・入れ替えたファイルの記録(JSON)、
// backup は外したファイルを名前を変えて残したもの(元に戻すときに名前を戻す)
export const serverChange = pgTable(
  "server_change",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull().references(() => server.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    title: text("title").notNull(),
    added: text("added").notNull().default(""),
    removed: text("removed").notNull().default(""),
    backup: text("backup").notNull().default(""),
    undone: boolean("undone").notNull().default(false),
    // 退避したプラグインの設定フォルダ(<dir>/.craftshelf-config/ の下の "<key>/<フォルダ名>"。03.49.00 から)
    configBackup: text("config_backup").notNull().default(""),
    at: timestamp("at").defaultNow().notNull(),
  },
  (t) => [index("server_change_server_idx").on(t.serverId, t.at)],
);

// エージェント(家の中のサーバー機で動かし、外向きにつないでくる小さなプログラム)。トークンはハッシュだけを残す。
// servers はエージェントが知らせてきた、扱えるサーバー(JSON: [{ key, name, platform, mcVersion }])
export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenHint: text("token_hint").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    version: text("version").notNull().default(""),
    servers: text("servers").notNull().default("[]"),
  },
  (t) => [uniqueIndex("agent_token_uq").on(t.tokenHash), index("agent_team_idx").on(t.teamId)],
);

// エージェントのサーバー(server.kind = "agent")。key はエージェントの設定ファイルに書いたサーバーの名前
export const agentServer = pgTable("agent_server", {
  serverId: text("server_id").primaryKey().references(() => server.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agent.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
});
