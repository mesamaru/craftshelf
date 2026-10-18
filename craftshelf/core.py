"""CraftShelf: 設定・定数・データベース(スキーマと移行)・設定値・アップデートの前の状態。"""

from datetime import datetime, timezone
from pathlib import Path
import json
import os
import re
import shutil
import sqlite3
import threading
import time

from flask import Flask, g

import selfupdate


BASE_DIR = Path(__file__).resolve().parent.parent  # リポジトリの直下(static/・VERSION がある場所)

# CONFIG_DIR: index.db・暗号鍵など「常にローカル」に置く小さなデータ置き場。
# LOCAL_DIR : 「ローカル」ストレージ(= 今までどおり docker-compose の volumes で
#             直接バインドマウントした /data)の実体。
CONFIG_DIR = Path(os.environ.get(
    "CONFIG_DIR", os.environ.get("DB_DIR", os.environ.get("DATA_DIR", BASE_DIR / "data"))
)).resolve()
LOCAL_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
TMP_DIR = CONFIG_DIR / ".tmp"
ICON_DIR = CONFIG_DIR / "icons"  # 配布元から取得したアイコン(アイテムID ごと)
DB_PATH = CONFIG_DIR / "index.db"
SECRET_KEY_PATH = CONFIG_DIR / "secret.key"
SESSION_KEY_PATH = CONFIG_DIR / "session.key"

# 初回起動時の管理者アカウント(ユーザーがまだ1人もいない場合だけ使う。README参照)
AUTH_USER = os.environ.get("AUTH_USER", "")
AUTH_PASS = os.environ.get("AUTH_PASS", "")

# 権限。数字が大きいほど強い
ROLES = {"viewer": (1, "閲覧のみ"), "editor": (2, "編集者"), "admin": (3, "管理者")}
# 管理者がユーザーごとに付けられる権限(管理者はすべて持つ)
PERMS = {
    "storage": "保存先の管理(保存先の追加・切り替え・移行・バックアップ)",
    "users": "ユーザーの管理(追加・権限の変更・削除・利用状況)",
    "integrations": "連携の設定(Pterodactyl・Discord・CurseForge)",
    "system": "パネル全体の設定(アップデート・更新確認の間隔など)",
    "audit": "操作の記録を見る",
}

# key -> (フォルダ名, 表示名)
CATEGORIES = {
    "plugin": ("plugins", "プラグイン"),
    "mod": ("mods", "Mod"),
    "datapack": ("datapacks", "データパック"),
    "resourcepack": ("resourcepacks", "リソースパック"),
    "shader": ("shaderpacks", "シェーダー"),
    "modpack": ("modpacks", "Modパック"),
    "other": ("other", "その他"),
}
PROTOCOLS = {"local": "ローカル", "smb": "SMB", "webdav": "WebDAV"}
REMOTE_PROTOCOLS = ("smb", "webdav")

LOCK = threading.RLock()
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_MB", "1024")) * 1024 * 1024
app = Flask(__name__, static_folder=None)


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------
# DB
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS storage_targets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    protocol      TEXT NOT NULL,
    server        TEXT NOT NULL DEFAULT '',
    share         TEXT NOT NULL DEFAULT '',
    subpath       TEXT NOT NULL DEFAULT '',
    username      TEXT NOT NULL DEFAULT '',
    domain        TEXT NOT NULL DEFAULT '',
    password_enc  TEXT NOT NULL DEFAULT '',
    mount_opts    TEXT NOT NULL DEFAULT '',
    options       TEXT NOT NULL DEFAULT '{}',
    active        INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   INTEGER NOT NULL DEFAULT 1 REFERENCES storage_targets(id),
    category    TEXT NOT NULL,
    name        TEXT NOT NULL,
    key         TEXT NOT NULL,
    folder      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    owner_id    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (target_id, owner_id, category, key)
);
-- アイテム・サーバーの共有先(level: view = 閲覧・ダウンロード / edit = 編集も可)
CREATE TABLE IF NOT EXISTS item_acl (
    item_id     INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    level       TEXT NOT NULL DEFAULT 'view',
    created_at  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (item_id, user_id)
);
CREATE TABLE IF NOT EXISTS server_acl (
    server_id   INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    level       TEXT NOT NULL DEFAULT 'view',
    created_at  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS favorites (
    user_id     INTEGER NOT NULL,
    item_id     INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL DEFAULT 1 REFERENCES storage_targets(id),
    version     TEXT NOT NULL DEFAULT '',
    filename    TEXT NOT NULL,
    relpath     TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    meta        TEXT NOT NULL DEFAULT '{}',
    note        TEXT NOT NULL DEFAULT '',
    added_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_item ON versions(item_id);
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'editor',
    created_at    TEXT NOT NULL,
    last_login    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
-- サーバー構成セット(同じ保存先のアイテムの組み合わせ。version_id が NULL なら常に最新)
CREATE TABLE IF NOT EXISTS sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS set_items (
    set_id      INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    version_id  INTEGER REFERENCES versions(id) ON DELETE SET NULL,
    PRIMARY KEY (set_id, item_id)
);
-- Pterodactyl のサーバーとの連携
CREATE TABLE IF NOT EXISTS servers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    plugin_dir  TEXT NOT NULL DEFAULT '/plugins',
    set_id      INTEGER,
    last_sync   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
-- サーバー上のファイルのハッシュ(毎回ダウンロードしないためのキャッシュ)
CREATE TABLE IF NOT EXISTS server_files (
    server_id   INTEGER NOT NULL,
    name        TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    modified    TEXT NOT NULL DEFAULT '',
    sha256      TEXT NOT NULL DEFAULT '',
    plugin_name TEXT NOT NULL DEFAULT '',
    version     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (server_id, name)
);
-- 前提プラグインの手動の紐付け(名前が違う場合)
CREATE TABLE IF NOT EXISTS dep_links (
    target_id   INTEGER NOT NULL,
    dep_key     TEXT NOT NULL,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (target_id, dep_key)
);
-- 同期・転送の前にサーバーから退避したファイル(巻き戻し用)
CREATE TABLE IF NOT EXISTS server_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    removed     TEXT NOT NULL DEFAULT '[]',
    added       TEXT NOT NULL DEFAULT '[]',
    rolled_back TEXT NOT NULL DEFAULT ''
);
-- 外部から操作するための APIトークン
CREATE TABLE IF NOT EXISTS api_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    prefix      TEXT NOT NULL,
    role        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_used   TEXT NOT NULL DEFAULT ''
);
-- 共有リンク(ログイン不要でダウンロードできる、期限付きのリンク)
CREATE TABLE IF NOT EXISTS shares (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    versions    TEXT NOT NULL DEFAULT '[]',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    downloads   INTEGER NOT NULL DEFAULT 0
);
-- 操作の記録
CREATE TABLE IF NOT EXISTS audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    username  TEXT NOT NULL DEFAULT '',
    action    TEXT NOT NULL,
    target    TEXT NOT NULL DEFAULT '',
    detail    TEXT NOT NULL DEFAULT ''
);
-- アイテムと配布元(Modrinth / SpigotMC / CurseForge)の紐付け、および最新版の確認結果
CREATE TABLE IF NOT EXISTS item_sources (
    item_id        INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    page_url       TEXT NOT NULL DEFAULT '',
    loaders        TEXT NOT NULL DEFAULT '[]',
    game_versions  TEXT NOT NULL DEFAULT '[]',
    linked_by      TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'unchecked',
    message        TEXT NOT NULL DEFAULT '',
    latest         TEXT NOT NULL DEFAULT '{}',
    checked_at     TEXT NOT NULL DEFAULT ''
);
"""
# target_id に依存するインデックスは、旧DBのマイグレーション(target_id列の追加)が
# 終わった後にしか作れないので、SCHEMA本体には含めず migrate_schema() で別途作る。

LOCAL_TARGET_ID = 1


def _table_cols(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def _items_add_owner(conn):
    """items に owner_id を足し、同じ名前を持ち主ごとに持てるよう UNIQUE を作り直す(01.13.00)。

    この接続は外部キーを有効にしていないので、表を作り直しても versions は消えない。
    """
    cols = conn.execute("PRAGMA table_info(items)").fetchall()
    defs, names = [], []
    for c in cols:
        name, typ, notnull, dflt, pk = c[1], c[2] or "TEXT", c[3], c[4], c[5]
        names.append(name)
        if pk:
            defs.append(f"{name} INTEGER PRIMARY KEY AUTOINCREMENT")
        else:
            defs.append(f"{name} {typ}" + (" NOT NULL" if notnull else "") + (f" DEFAULT {dflt}" if dflt is not None else ""))
    defs.append("owner_id INTEGER NOT NULL DEFAULT 0")
    conn.execute(f"CREATE TABLE items_new ({', '.join(defs)}, UNIQUE (target_id, owner_id, category, key))")
    cl = ", ".join(names)
    conn.execute(f"INSERT INTO items_new ({cl}, owner_id) SELECT {cl}, 0 FROM items")
    conn.execute("DROP TABLE items")
    conn.execute("ALTER TABLE items_new RENAME TO items")


def migrate_schema(conn):
    """target_id が無い旧DB(このストレージ機能を入れる前)を新しい形に作り直す。"""
    from .analysis import _PLATFORM_LEGACY  # 上の層(循環を避けるため、ここで読み込む)
    if "target_id" not in _table_cols(conn, "items"):
        conn.execute("ALTER TABLE items ADD COLUMN target_id INTEGER NOT NULL DEFAULT 1")
        conn.execute("ALTER TABLE items RENAME TO items_old")
        conn.execute("""
            CREATE TABLE items (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                target_id   INTEGER NOT NULL DEFAULT 1 REFERENCES storage_targets(id),
                category    TEXT NOT NULL,
                name        TEXT NOT NULL,
                key         TEXT NOT NULL,
                folder      TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                UNIQUE (target_id, category, key)
            )
        """)
        conn.execute(
            "INSERT INTO items (id, target_id, category, name, key, folder, created_at) "
            "SELECT id, target_id, category, name, key, folder, created_at FROM items_old")
        conn.execute("DROP TABLE items_old")
    if "target_id" not in _table_cols(conn, "versions"):
        conn.execute("ALTER TABLE versions ADD COLUMN target_id INTEGER NOT NULL DEFAULT 1")
        conn.execute("ALTER TABLE versions RENAME TO versions_old")
        conn.execute("""
            CREATE TABLE versions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                target_id   INTEGER NOT NULL DEFAULT 1 REFERENCES storage_targets(id),
                version     TEXT NOT NULL DEFAULT '',
                filename    TEXT NOT NULL,
                relpath     TEXT NOT NULL,
                size        INTEGER NOT NULL,
                sha256      TEXT NOT NULL,
                meta        TEXT NOT NULL DEFAULT '{}',
                note        TEXT NOT NULL DEFAULT '',
                added_at    TEXT NOT NULL
            )
        """)
        conn.execute(
            "INSERT INTO versions (id, item_id, target_id, version, filename, relpath, size, sha256, meta, note, added_at) "
            "SELECT id, item_id, target_id, version, filename, relpath, size, sha256, meta, note, added_at FROM versions_old")
        conn.execute("DROP TABLE versions_old")
    if "options" not in _table_cols(conn, "storage_targets"):
        conn.execute("ALTER TABLE storage_targets ADD COLUMN options TEXT NOT NULL DEFAULT '{}'")
    if "owner_id" not in _table_cols(conn, "items"):
        _items_add_owner(conn)
    for table in ("servers", "sets"):
        if "owner_id" not in _table_cols(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0")
    if "owner_id" not in _table_cols(conn, "shares"):  # 共有リンクを作った人(01.15.00 から。以前のものは管理者だけに見える)
        conn.execute("ALTER TABLE shares ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0")
    if "perms" not in _table_cols(conn, "users"):  # 管理者が個別に付ける権限
        conn.execute("ALTER TABLE users ADD COLUMN perms TEXT NOT NULL DEFAULT '[]'")
    # 持ち主がまだ決まっていないもの(この機能より前のデータ)は、最初の管理者のものにする
    first = conn.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
    if first:
        for table in ("items", "servers", "sets"):
            conn.execute(f"UPDATE {table} SET owner_id=? WHERE owner_id=0", (first[0],))
    # 旧バージョン(OSの mount を使っていた頃)の SMB 登録は、そのまま新しい SMB 方式で使える。
    # NFS はアプリ単体では扱えなくなったため、画面上で「非対応」と表示して再登録を促す。
    conn.execute("UPDATE storage_targets SET protocol='smb' WHERE protocol='cifs'")
    if "sha1" not in _table_cols(conn, "versions"):  # 配布サイトとの照合に使う
        conn.execute("ALTER TABLE versions ADD COLUMN sha1 TEXT NOT NULL DEFAULT ''")
    if "tags" not in _table_cols(conn, "items"):  # 自由に付けられるタグ
        conn.execute("ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    for col, ddl in (("sched_mode", "TEXT NOT NULL DEFAULT 'off'"), ("sched_time", "TEXT NOT NULL DEFAULT '04:00'"),
                     ("sched_dow", "INTEGER NOT NULL DEFAULT 0"), ("sched_restart", "INTEGER NOT NULL DEFAULT 1"),
                     ("last_sched", "TEXT NOT NULL DEFAULT ''")):
        if col not in _table_cols(conn, "servers"):  # 予約同期
            conn.execute(f"ALTER TABLE servers ADD COLUMN {col} {ddl}")
    for col, ddl in (("kind", "TEXT NOT NULL DEFAULT 'ptero'"), ("root_dir", "TEXT NOT NULL DEFAULT ''"),
                     ("software", "TEXT NOT NULL DEFAULT ''"), ("dirs", "TEXT NOT NULL DEFAULT ''")):
        if col not in _table_cols(conn, "servers"):  # ローカルのサーバー・種類ごとのフォルダ(01.16)
            conn.execute(f"ALTER TABLE servers ADD COLUMN {col} {ddl}")
    for col, ddl in (("mc_version", "TEXT NOT NULL DEFAULT ''"), ("address", "TEXT NOT NULL DEFAULT ''"),
                     ("rcon_port", "INTEGER NOT NULL DEFAULT 0"), ("rcon_password", "TEXT NOT NULL DEFAULT ''"),
                     ("control", "TEXT NOT NULL DEFAULT 'none'"), ("start_cmd", "TEXT NOT NULL DEFAULT ''"),
                     ("stop_cmd", "TEXT NOT NULL DEFAULT ''"), ("container", "TEXT NOT NULL DEFAULT ''"),
                     ("auto_update", "TEXT NOT NULL DEFAULT 'off'"), ("last_auto", "TEXT NOT NULL DEFAULT ''"),
                     ("backup_config", "INTEGER NOT NULL DEFAULT 1"), ("world_mode", "TEXT NOT NULL DEFAULT 'off'"),
                     ("world_time", "TEXT NOT NULL DEFAULT '05:00'"), ("world_dow", "INTEGER NOT NULL DEFAULT 0"),
                     ("world_keep", "INTEGER NOT NULL DEFAULT 5"), ("last_world", "TEXT NOT NULL DEFAULT ''"),
                     ("stage_targets", "TEXT NOT NULL DEFAULT '[]'"), ("soft_info", "TEXT NOT NULL DEFAULT '{}'"),
                     ("server_jar", "TEXT NOT NULL DEFAULT ''")):
        if col not in _table_cols(conn, "servers"):  # 状態・起動停止・自動更新・ワールドのバックアップなど(01.17)
            conn.execute(f"ALTER TABLE servers ADD COLUMN {col} {ddl}")
    if "channel" not in _table_cols(conn, "item_sources"):  # 受け取る版: '' = 自動 / all = ベータも / release = 正式版だけ
        conn.execute("ALTER TABLE item_sources ADD COLUMN channel TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE TABLE IF NOT EXISTS server_holds (server_id INTEGER NOT NULL, item_id INTEGER NOT NULL, "
                 "created_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (server_id, item_id))")
    # 01.16 より前のキャッシュはファイル名だけなので、プラグインのフォルダを前に付ける
    conn.execute("UPDATE server_files SET name = (SELECT trim(plugin_dir, '/') FROM servers s WHERE s.id = server_files.server_id)"
                 " || '/' || name WHERE instr(name, '/') = 0 AND EXISTS (SELECT 1 FROM servers s WHERE s.id = server_files.server_id"
                 " AND trim(plugin_dir, '/') <> '')")
    for col, ddl in (("totp_secret", "TEXT NOT NULL DEFAULT ''"), ("totp_enabled", "INTEGER NOT NULL DEFAULT 0"),
                     ("recovery", "TEXT NOT NULL DEFAULT '[]'")):
        if col not in _table_cols(conn, "users"):  # 二段階認証
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")
    if "keep_versions" not in _table_cols(conn, "items"):  # 古いバージョンの自動整理(残す数。0 = しない)
        conn.execute("ALTER TABLE items ADD COLUMN keep_versions INTEGER NOT NULL DEFAULT 0")
    if "mc_versions" not in _table_cols(conn, "items"):  # 対応MCバージョン(手入力。空なら自動)
        conn.execute("ALTER TABLE items ADD COLUMN mc_versions TEXT NOT NULL DEFAULT ''")
    if "platform" not in _table_cols(conn, "items"):  # サーバーソフト(手で選んだもの。空なら自動)
        conn.execute("ALTER TABLE items ADD COLUMN platform TEXT NOT NULL DEFAULT ''")
    for old, new in _PLATFORM_LEGACY.items():  # 01.09.00 は表示名で保存していた
        conn.execute("UPDATE items SET platform=? WHERE platform=?", (new, old))
    if "prefs" not in _table_cols(conn, "users"):  # テーマ・背景などの個人設定
        conn.execute("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_versions_item ON versions(item_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_versions_target_sha ON versions(target_id, sha256)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_items_target ON items(target_id)")


# --------------------------------------------------------------------------
# 02 からのデータベースの変更(版ごとの移行)
# --------------------------------------------------------------------------
# 決まり: 表や項目を「足す」だけにする(消す・名前や意味を変えることはしない)。
#   古い版(01.24 以降)は知らない表・項目を無視して動けるので、02 から安全に戻せる。
#   どうしても互換のない変更が要るときは、DATA_FORMAT の write を上げ、その番号を読める 01 の版を先に出す。
# 各ステップは一度だけ実行し、schema_migrations に記録する。id は変えない。
def _m_notifications(conn):
    # パネルの中のお知らせ(Discord に送る出来事と同じもの)と、ユーザーごとの「どこまで読んだか」
    conn.execute("CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, "
                 "event TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', "
                 "audience TEXT NOT NULL DEFAULT 'all')")
    conn.execute("CREATE TABLE IF NOT EXISTS notification_reads (user_id INTEGER PRIMARY KEY, last_id INTEGER NOT NULL DEFAULT 0)")


MIGRATIONS = [
    ("02.00.00-migration-log", "版ごとの移行の記録を始める", lambda conn: None),
    ("02.01.00-notifications", "お知らせセンター", _m_notifications),
]


def run_migrations(conn):
    """まだ行っていない移行を順に行う。"""
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', "
                 "applied_at TEXT NOT NULL, version TEXT NOT NULL DEFAULT '')")
    done = {r[0] for r in conn.execute("SELECT id FROM schema_migrations")}
    for mid, title, fn in MIGRATIONS:
        if mid in done:
            continue
        fn(conn)
        conn.execute("INSERT INTO schema_migrations (id, title, applied_at, version) VALUES (?,?,?,?)",
                     (mid, title, utcnow(), running_version()))


def ensure_local_target(conn):
    row = conn.execute("SELECT id FROM storage_targets WHERE id=?", (LOCAL_TARGET_ID,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO storage_targets (id, name, protocol, active, created_at, updated_at) "
            "VALUES (?, 'ローカル', 'local', 1, ?, ?)",
            (LOCAL_TARGET_ID, utcnow(), utcnow()),
        )
    n_active = conn.execute("SELECT COUNT(*) FROM storage_targets WHERE active=1").fetchone()[0]
    if n_active == 0:
        conn.execute("UPDATE storage_targets SET active=1 WHERE id=?", (LOCAL_TARGET_ID,))
    elif n_active > 1:  # 念のため(通常は起こらない)
        conn.execute("UPDATE storage_targets SET active=0")
        conn.execute("UPDATE storage_targets SET active=1 WHERE id=?", (LOCAL_TARGET_ID,))


SNAPSHOT_DIR = CONFIG_DIR / "pre-update"   # アップデートの前の状態(データベースと鍵)
RESTORE_MARK = CONFIG_DIR / "restore-on-start"
DATA_WRITE, DATA_READ = selfupdate.local_data_format()
DATA_TOO_NEW = False  # このデータは、この版より新しい保存方法で作られている


def _restore_pending_snapshot():
    """「アップデートの前の状態に戻す」を選んだあとの起動で、退避したデータベースを元に戻す。"""
    if not RESTORE_MARK.exists():
        return
    name = RESTORE_MARK.read_text(encoding="utf-8").strip()
    RESTORE_MARK.unlink(missing_ok=True)
    src = SNAPSHOT_DIR / name / "index.db"
    if not name or "/" in name or "\\" in name or not src.is_file():
        print(f"[restore] 退避が見つからないため戻しませんでした: {name}")
        return
    keep = SNAPSHOT_DIR / f"before-restore-{time.strftime('%Y%m%d-%H%M%S')}"
    keep.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):  # いまのデータも念のため残す
        cur = Path(str(DB_PATH) + suffix)
        if cur.exists():
            shutil.move(str(cur), str(keep / ("index.db" + suffix)))
    shutil.copyfile(src, DB_PATH)
    if (SNAPSHOT_DIR / name / "secret.key").is_file():
        shutil.copyfile(SNAPSHOT_DIR / name / "secret.key", SECRET_KEY_PATH)
    print(f"[restore] {name} の状態に戻しました(戻す前のデータは {keep.name} に残しています)")


def _note_data_format(conn):
    """データの保存方法の番号を記録する(上げるだけで下げない)。読めない番号なら警告を出す。"""
    global DATA_TOO_NEW
    row = conn.execute("SELECT value FROM settings WHERE key='data_format'").fetchone()
    stored = int(row[0]) if row and str(row[0]).isdigit() else 1
    if stored > DATA_READ:
        DATA_TOO_NEW = True
        print(f"[warn] このデータは保存方法 {stored} で作られていますが、この版は {DATA_READ} までしか読めません")
    use = max(stored, DATA_WRITE)
    conn.execute("INSERT INTO settings (key, value) VALUES ('data_format', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (str(use),))
    selfupdate.DATA_IN_USE = use
    try:  # Docker の起動スクリプトも読めるように
        (CONFIG_DIR / "data-format").write_text(f"{use}\n", encoding="utf-8")
    except OSError:
        pass


def snapshot_data(reason, keep=5):
    """データベースと鍵を退避する(アップデートの前など)。戻すときは次の起動で入れ替える。"""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    base = f"{time.strftime('%Y%m%d-%H%M%S')}-v{running_version()}"
    name, n = base, 1
    while (SNAPSHOT_DIR / name).exists():  # 同じ秒に作ったときは番号を付ける
        n += 1
        name = f"{base}-{n}"
    d = SNAPSHOT_DIR / name
    d.mkdir(parents=True)
    src = sqlite3.connect(DB_PATH, timeout=30)
    dst = sqlite3.connect(d / "index.db")
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    if SECRET_KEY_PATH.exists():
        shutil.copyfile(SECRET_KEY_PATH, d / "secret.key")
    (d / "meta.json").write_text(json.dumps({"version": running_version(), "data_format": selfupdate.DATA_IN_USE,
                                             "created_at": utcnow(), "reason": reason}, ensure_ascii=False), encoding="utf-8")
    olds = sorted(x for x in SNAPSHOT_DIR.iterdir() if x.is_dir() and not x.name.startswith("before-restore-"))
    for x in olds[:-keep]:
        shutil.rmtree(x, ignore_errors=True)
    return name


def init_storage():
    from .auth import _session_secret, ensure_initial_admin  # 上の層(循環を避けるため、ここで読み込む)
    from .library import _startup_connect  # 上の層(循環を避けるため、ここで読み込む)
    for d in (CONFIG_DIR, TMP_DIR, LOCAL_DIR, LOCAL_DIR / "library", LOCAL_DIR / "inbox"):
        d.mkdir(parents=True, exist_ok=True)
    _restore_pending_snapshot()
    for p in TMP_DIR.glob("*"):
        try:
            p.unlink()
        except OSError:
            pass
    app.secret_key = _session_secret()
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    migrate_schema(conn)
    run_migrations(conn)
    _note_data_format(conn)
    ensure_local_target(conn)
    ensure_initial_admin(conn)
    conn.commit()
    _startup_connect(conn)
    conn.close()


def db():
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# 名前・バージョンまわりのユーティリティ
# --------------------------------------------------------------------------
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_name(s, fallback="unnamed", limit=120):
    s = _UNSAFE.sub("_", s or "").strip(" .")
    return s[:limit].rstrip(" .") or fallback


def norm_key(name):
    """大文字小文字・記号・空白の違いを無視して同じ名前とみなすためのキー。"""
    k = re.sub(r"[\W_]+", "", (name or "").lower())
    return k or (name or "").lower()


_BAD_VERSION = re.compile(r"\$\{|^unspecified$|^undefined$|^null$|^none$", re.I)


def clean_version(v):
    if v is None:
        return None
    v = str(v).strip().strip("'\"").strip()
    if not v or _BAD_VERSION.search(v):
        return None
    return v[:64]


# --------------------------------------------------------------------------
# 設定値(settings テーブル)
# --------------------------------------------------------------------------
def get_setting(key, default=""):
    row = db().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    conn = db()
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
    conn.commit()


APP_NAME = "CraftShelf"


def running_version():
    return selfupdate.current_version()


def _truthy(v):
    return v is True or str(v).lower() in ("1", "true", "on", "yes")


# --------------------------------------------------------------------------
# 配布元(Modrinth / SpigotMC / CurseForge)との連携・更新確認
# --------------------------------------------------------------------------
def _jl(s, default):
    try:
        v = json.loads(s or "")
        return v if isinstance(v, type(default)) else default
    except ValueError:
        return default
