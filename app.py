#!/usr/bin/env python3
"""CraftShelf(旧 MC Pack Library)

プラグイン / Mod / データパック / リソースパックを、ブラウザへのドラッグ&ドロップで
登録して管理するための小さなWebアプリ。

保存先(ストレージ)はWeb画面から登録・切り替えができる。「ローカル」(このコンテナに
直接バインドマウントされた /data)は常に使え、それに加えて SMB(Windows共有)/ WebDAV
(Nextcloud など)の接続情報を登録して使うこともできる(Unraid・TrueNAS・Nextcloudなど)。
SMB / WebDAV はアプリ自身が直接通信するので、OSの mount や特別な権限は必要ない。

ストレージごとに完全に独立したカタログ(登録済みプラグイン一覧)を持つ。つまり「切り替え」は
保存先を変えると同時に、画面に表示される一覧も切り替わる。Unraidに登録したものは、Unraidに
切り替えている間だけ見える(TrueNASに切り替えている間は見えない。またUnraidに戻せば見える)。

ファイルは 保存先/library/<種類>/<名前>/<元のファイル名> の形で整理して保存し、
名前・バージョンなどの情報は index.db (SQLite、常にローカルの CONFIG_DIR に置く) に記録する。
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import struct
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import quote

import requests
from flask import Flask, Response, g, has_request_context, jsonify, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import mcnet
import notify
import ptero
import selfupdate
import sources as src

from storage import (
    LocalStorage, SmbStorage, StorageError, WebDavStorage, clean_rel, join_rel, parent_rel,
)

try:  # Python 3.11+
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover
    Fernet = None
    InvalidToken = Exception

BASE_DIR = Path(__file__).resolve().parent

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
                     ("stage_targets", "TEXT NOT NULL DEFAULT '[]'"), ("soft_info", "TEXT NOT NULL DEFAULT '{}'")):
        if col not in _table_cols(conn, "servers"):  # 状態・起動停止・自動更新・ワールドのバックアップなど(01.17)
            conn.execute(f"ALTER TABLE servers ADD COLUMN {col} {ddl}")
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


def init_storage():
    for d in (CONFIG_DIR, TMP_DIR, LOCAL_DIR, LOCAL_DIR / "library", LOCAL_DIR / "inbox"):
        d.mkdir(parents=True, exist_ok=True)
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


_EXT_RE = re.compile(r"(\.(jar|zip|rar|7z|mcpack|disabled))+$", re.I)


def parse_filename(filename):
    """ファイル名から (名前, バージョン or None) を推測する。"""
    stem = _EXT_RE.sub("", Path(filename).name)
    stem = re.sub(r"\s*\(\d+\)$", "", stem).strip()  # ブラウザの重複DL "(1)"
    m = re.match(r"^(.+?)[\s._-]+[vV]?(\d+(?:\.\d+)+.*)$", stem) or re.match(
        r"^(.+?)[\s._-]+[vV](\d+.*)$", stem
    )
    if m:
        name, ver = m.group(1), m.group(2)
    else:
        name, ver = stem, None
    name = name.strip(" ._-") or stem or "unnamed"
    return name, clean_version(ver)


_PRE = {
    "dev": 0, "snapshot": 0, "nightly": 0,
    "alpha": 1, "a": 1,
    "beta": 2, "b": 2,
    "pre": 3, "preview": 3,
    "rc": 4, "cr": 4,
}


def version_key(v):
    """バージョン文字列の自然順ソート用キー。1.10 > 1.9、1.0.0 > 1.0.0-beta など。"""
    v = re.sub(r"^[vV](?=\d)", "", (v or "").strip())
    toks = []
    for t in re.findall(r"\d+|[A-Za-z]+", v):
        if t.isdigit():
            toks.append((2, int(t), ""))
        else:
            tl = t.lower()
            toks.append((-1, _PRE[tl], "") if tl in _PRE else (1, 0, tl))
    toks.append((0, 0, ""))  # 終端。これでリリース版がプレリリースより上になる
    return toks


# --------------------------------------------------------------------------
# ファイル解析 (jar / zip の中身から名前・バージョン・種類を読む)
# --------------------------------------------------------------------------
def _read(z, name, limit=2_000_000):
    try:
        with z.open(name) as f:
            return f.read(limit).decode("utf-8-sig", errors="replace")
    except KeyError:
        return None


def _json(z, name):
    text = _read(z, name)
    if text is None:
        return None
    try:
        data = json.loads(text, strict=False)
        return data
    except ValueError:
        return None


def _toml(text):
    if not text or tomllib is None:
        return None
    try:
        return tomllib.loads(text)
    except Exception:
        return None


def _yaml_top(text):
    """plugin.yml のトップレベルから name/version/description/api-version だけ抜く。"""
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"^([A-Za-z_-]+)\s*:\s*(.*?)\s*$", line)
        if not m or m.group(1) not in ("name", "version", "description", "api-version"):
            continue
        key, val = m.group(1), m.group(2)
        if key in out:
            continue
        if val[:1] in ("'", '"'):
            q = val[0]
            end = val.find(q, 1)
            val = val[1:end] if end > 0 else val[1:]
        else:
            val = re.sub(r"\s+#.*$", "", val)
        if val in ("", ">", "|", ">-", "|-"):
            continue
        out[key] = val
    return out


def _flatten_text(d):
    if isinstance(d, str):
        return d
    if isinstance(d, list):
        return "".join(_flatten_text(x) for x in d)
    if isinstance(d, dict):
        s = d.get("text") if isinstance(d.get("text"), str) else ""
        return s + _flatten_text(d.get("extra", []))
    return ""


def _short(s, n=200):
    s = re.sub(r"§.", "", str(s or "")).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:n]


def _manifest_version(z):
    text = _read(z, "META-INF/MANIFEST.MF") or ""
    m = re.search(r"^Implementation-Version:\s*(.+?)\s*$", text, re.M)
    return m.group(1) if m else None


def _analyze_zip(z, info):
    names = z.namelist()
    nameset = set(names)

    # ---- サーバープラグイン ----
    for fname, loader in (
        ("paper-plugin.yml", "Paper"),
        ("plugin.yml", "Bukkit / Spigot / Paper"),
        ("bungee.yml", "BungeeCord"),
    ):
        if fname in nameset:
            y = _yaml_top(_read(z, fname))
            if fname == "plugin.yml" and str(y.get("folia-supported") or "").lower() == "true":
                loader = "Bukkit / Spigot / Paper / Folia"
            info.update(
                category="plugin", loader=loader, name=y.get("name"),
                version=y.get("version"), description=_short(y.get("description")),
            )
            if y.get("api-version"):
                info["mc"] = str(y["api-version"])
            return
    if "velocity-plugin.json" in nameset:
        d = _json(z, "velocity-plugin.json") or {}
        info.update(
            category="plugin", loader="Velocity", name=d.get("name") or d.get("id"),
            version=d.get("version"), description=_short(d.get("description")),
        )
        return

    # ---- Mod ----
    if "fabric.mod.json" in nameset:
        d = _json(z, "fabric.mod.json") or {}
        mc = (d.get("depends") or {}).get("minecraft")
        if isinstance(mc, list):
            mc = ", ".join(str(x) for x in mc)
        info.update(
            category="mod", loader="Fabric", name=d.get("name") or d.get("id"),
            version=d.get("version"), description=_short(d.get("description")),
            mc=str(mc) if mc else None,
        )
        return
    if "quilt.mod.json" in nameset:
        d = _json(z, "quilt.mod.json") or {}
        ql = d.get("quilt_loader") or {}
        mc = None
        for dep in ql.get("depends") or []:
            if isinstance(dep, dict) and dep.get("id") == "minecraft":
                mc = dep.get("versions")
                if isinstance(mc, list):
                    mc = ", ".join(str(x) for x in mc)
        meta = d.get("metadata") or {}
        info.update(
            category="mod", loader="Quilt", name=meta.get("name") or ql.get("id"),
            version=ql.get("version"), description=_short(meta.get("description")),
            mc=str(mc) if mc else None,
        )
        return
    for path, loader in (
        ("META-INF/neoforge.mods.toml", "NeoForge"),
        ("META-INF/mods.toml", "Forge"),
    ):
        if path in nameset:
            text = _read(z, path) or ""
            data = _toml(text)
            name = version = desc = mc = None
            if data:
                mods = data.get("mods") or [{}]
                m0 = mods[0] if isinstance(mods, list) and mods else {}
                name = m0.get("displayName") or m0.get("modId")
                version = m0.get("version")
                desc = m0.get("description")
                for lst in (data.get("dependencies") or {}).values():
                    if isinstance(lst, list):
                        for dep in lst:
                            if isinstance(dep, dict) and dep.get("modId") == "minecraft":
                                mc = dep.get("versionRange")
            else:  # tomllib が無い / 壊れている場合の簡易パース
                m = re.search(r'displayName\s*=\s*"([^"]*)"', text) or re.search(r'modId\s*=\s*"([^"]*)"', text)
                name = m.group(1) if m else None
                m = re.search(r'^\s*version\s*=\s*"([^"]*)"', text, re.M)
                version = m.group(1) if m else None
            if not clean_version(version):  # ${file.jarVersion} など
                version = _manifest_version(z)
            info.update(
                category="mod", loader=loader, name=name, version=version,
                description=_short(desc), mc=str(mc) if mc else None,
            )
            return
    if "mcmod.info" in nameset:
        d = _json(z, "mcmod.info")
        if isinstance(d, dict):
            d = d.get("modList")
        if isinstance(d, list) and d and isinstance(d[0], dict):
            m0 = d[0]
            info.update(
                category="mod", loader="Forge", name=m0.get("name") or m0.get("modid"),
                version=m0.get("version"), description=_short(m0.get("description")),
                mc=m0.get("mcversion") or None,
            )
            return

    # ---- Modパック(Modrinth .mrpack / CurseForge) ----
    if "modrinth.index.json" in nameset:
        d = _json(z, "modrinth.index.json") or {}
        deps = d.get("dependencies") or {}
        loader = next((k.replace("-loader", "").capitalize() for k in deps if k != "minecraft"), None)
        info.update(category="modpack", loader=f"Modrinth / {loader}" if loader else "Modrinth", name=d.get("name"),
                    version=d.get("versionId"), description=_short(d.get("summary")),
                    mc=str(deps["minecraft"]) if deps.get("minecraft") else None)
        return
    if "manifest.json" in nameset and any(n.startswith("overrides/") for n in names):
        d = _json(z, "manifest.json") or {}
        mc = (d.get("minecraft") or {})
        loader = ((mc.get("modLoaders") or [{}])[0].get("id") or "").split("-")[0].capitalize() or None
        info.update(category="modpack", loader=f"CurseForge / {loader}" if loader else "CurseForge", name=d.get("name"),
                    version=d.get("version"), description=_short(d.get("author") and f"by {d['author']}"),
                    mc=str(mc["version"]) if mc.get("version") else None)
        return

    # ---- シェーダー(Iris / OptiFine) ----
    tops = {n.split("/", 1)[0] for n in names}
    if "shaders" in tops or any(n.split("/")[1:2] == ["shaders"] for n in names if n.count("/") >= 2):
        info.update(category="shader", loader="Iris / OptiFine")
        return

    # ---- データパック / リソースパック ----
    mcmeta = None
    if "pack.mcmeta" in nameset:
        mcmeta = "pack.mcmeta"
    else:  # フォルダごとzip化されたもの
        for n in names:
            if n.endswith("/pack.mcmeta") and n.count("/") == 1:
                mcmeta = n
                break
    prefix = mcmeta[: -len("pack.mcmeta")] if mcmeta else ""
    has_data = any(n.startswith(prefix + "data/") for n in names)
    has_assets = any(n.startswith(prefix + "assets/") for n in names)
    if has_data or has_assets:
        pack = ((_json(z, mcmeta) if mcmeta else None) or {}).get("pack") or {}
        info["category"] = "datapack" if has_data else "resourcepack"
        info["description"] = _short(_flatten_text(pack.get("description")))
        fmt = pack.get("pack_format", pack.get("min_format"))
        if fmt is not None:
            info["pack_format"] = str(fmt)


# --------------------------------------------------------------------------
# 前提(依存)プラグイン・Mod の読み取り
# --------------------------------------------------------------------------
# ローダーやゲーム本体など、ライブラリで管理しない依存は無視する
_IGNORE_DEPS = {"minecraft", "java", "fabricloader", "fabricloader", "fabric-loader", "quiltloader", "quilt_loader",
                "forge", "neoforge", "fml", "javafml", "lowcodefml", "quiltbase", "quilted_fabric_api_base"}


def _yaml_list(text, key):
    """plugin.yml の「depend: [A, B]」「depend:\\n  - A」形式の一覧を読む。"""
    lines = (text or "").splitlines()
    for i, line in enumerate(lines):
        m = re.match(rf"^{re.escape(key)}\s*:\s*(.*?)\s*$", line)
        if not m:
            continue
        val = re.sub(r"\s+#.*$", "", m.group(1)).strip()
        if val.startswith("["):
            return [x.strip().strip("'\"") for x in val.strip("[]").split(",") if x.strip().strip("'\"")]
        if val and val not in ("|", ">", "[]"):
            return [val.strip("'\"")]
        out = []
        for nxt in lines[i + 1:]:
            mm = re.match(r"^\s*-\s*(.+?)\s*$", nxt)
            if mm:
                out.append(mm.group(1).strip("'\""))
            elif nxt.strip() and not nxt.lstrip().startswith("#"):
                break
        return out
    return []


def _paper_deps(text):
    """paper-plugin.yml の dependencies: server: 名前: {required: true} を読む。"""
    req, soft = [], []
    lines = (text or "").splitlines()
    in_deps = in_server = False
    cur = None
    name_indent = None
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        s = line.strip()
        if indent == 0:
            in_deps = s.startswith("dependencies:")
            in_server = False
            continue
        if not in_deps:
            continue
        if s.startswith("server:") and (name_indent is None or indent < name_indent):
            in_server, name_indent, cur = True, None, None
            continue
        if not in_server:
            continue
        m = re.match(r"^([^:#]+):\s*$", s)
        if m and (name_indent is None or indent == name_indent):
            name_indent = indent
            cur = m.group(1).strip().strip("'\"")
            soft.append(cur)
            continue
        if cur and re.match(r"^required\s*:\s*true\b", s):
            if cur in soft:
                soft.remove(cur)
            req.append(cur)
    return req, soft


def _analyze_deps(z, info):
    names = set(z.namelist())
    deps, soft, mod_id = [], [], None
    if "paper-plugin.yml" in names:
        deps, soft = _paper_deps(_read(z, "paper-plugin.yml"))
    elif "plugin.yml" in names or "bungee.yml" in names:
        text = _read(z, "plugin.yml" if "plugin.yml" in names else "bungee.yml")
        deps = _yaml_list(text, "depend") + _yaml_list(text, "depends")
        soft = _yaml_list(text, "softdepend") + _yaml_list(text, "softDepends")
    elif "velocity-plugin.json" in names:
        d = _json(z, "velocity-plugin.json") or {}
        mod_id = d.get("id")
        for dep in d.get("dependencies") or []:
            if isinstance(dep, dict) and dep.get("id"):
                (soft if dep.get("optional") else deps).append(dep["id"])
    elif "fabric.mod.json" in names:
        d = _json(z, "fabric.mod.json") or {}
        mod_id = d.get("id")
        deps = [k for k in (d.get("depends") or {}) if isinstance(k, str)]
        soft = [k for k in (d.get("recommends") or {}) if isinstance(k, str)]
    elif "quilt.mod.json" in names:
        ql = (_json(z, "quilt.mod.json") or {}).get("quilt_loader") or {}
        mod_id = ql.get("id")
        for dep in ql.get("depends") or []:
            dep_id = dep.get("id") if isinstance(dep, dict) else dep if isinstance(dep, str) else None
            if dep_id:
                (soft if isinstance(dep, dict) and dep.get("optional") else deps).append(dep_id)
    else:
        for path in ("META-INF/neoforge.mods.toml", "META-INF/mods.toml"):
            if path in names:
                data = _toml(_read(z, path)) or {}
                mods = data.get("mods") or [{}]
                mod_id = (mods[0] if isinstance(mods, list) and mods else {}).get("modId")
                for lst in (data.get("dependencies") or {}).values():
                    for dep in lst if isinstance(lst, list) else []:
                        if not isinstance(dep, dict) or not dep.get("modId"):
                            continue
                        required = dep.get("mandatory") is True or str(dep.get("type", "")).lower() == "required"
                        (deps if required else soft).append(dep["modId"])
                break
    clean = lambda xs: sorted({x.strip() for x in xs if x and x.strip().lower() not in _IGNORE_DEPS})[:50]  # noqa: E731
    info["depends"], info["softdepends"] = clean(deps), clean(soft)
    if mod_id:
        info["mod_id"] = str(mod_id)[:80]


def analyze(path, filename):
    info = dict(category="other", name=None, version=None, loader=None,
                mc=None, description=None, pack_format=None)
    if zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as z:
                _analyze_zip(z, info)
                try:
                    _analyze_deps(z, info)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:
            pass
    fn_name, fn_ver = parse_filename(filename)
    info["name"] = (str(info["name"] or "")).strip() or fn_name
    info["version"] = clean_version(info["version"]) or fn_ver or ""
    return info



# --------------------------------------------------------------------------
# ストレージ(保存先)の接続管理: 暗号化・接続・切り替え
# --------------------------------------------------------------------------
def _fernet():
    if Fernet is None:
        return None
    if not SECRET_KEY_PATH.exists():
        SECRET_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        SECRET_KEY_PATH.write_bytes(Fernet.generate_key())
        try:
            os.chmod(SECRET_KEY_PATH, 0o600)
        except OSError:
            pass
    return Fernet(SECRET_KEY_PATH.read_bytes())


def encrypt_secret(s):
    if not s:
        return ""
    f = _fernet()
    if f is None:  # cryptography が使えない環境向けの最終手段(README参照)
        return "plain:" + base64.urlsafe_b64encode(s.encode()).decode()
    return "enc:" + f.encrypt(s.encode()).decode()


def decrypt_secret(s):
    if not s:
        return ""
    if s.startswith("plain:"):
        try:
            return base64.urlsafe_b64decode(s[len("plain:"):].encode()).decode()
        except Exception:
            return ""
    if s.startswith("enc:"):
        f = _fernet()
        if f is None:
            return ""
        try:
            return f.decrypt(s[len("enc:"):].encode()).decode()
        except InvalidToken:
            return ""
    return ""


def target_options(target):
    try:
        opts = json.loads(target["options"] or "{}")
    except (KeyError, IndexError, TypeError, ValueError):
        opts = {}
    return opts if isinstance(opts, dict) else {}


def make_storage(target, password=None):
    """storage_targets の行(または同じキーを持つ dict)から、ストレージの実体を作る。"""
    proto = target["protocol"]
    if proto == "local":
        return LocalStorage(LOCAL_DIR)
    if password is None:
        password = decrypt_secret(target["password_enc"])
    if proto == "smb":
        return SmbStorage(target["server"], target["share"], target["subpath"],
                          target["username"], password, target["domain"])
    if proto == "webdav":
        return WebDavStorage(target["server"], target["subpath"], target["username"], password,
                             verify_tls=not target_options(target).get("tls_insecure"))
    raise ApiError("この接続方式(NFS)には対応しなくなりました。編集で「SMB」に変更するか、登録し直してください")


# target_id -> (設定の指紋, ストレージ)。設定が変わったら作り直す
_STORES = {}
# target_id -> {"connected": bool, "last_try": 時刻}
_CONN = {}
RETRY_INTERVAL = 30  # 秒。接続できなかったリモートに、自動で再接続を試みる間隔


def _fingerprint(target):
    return tuple(target[k] for k in ("protocol", "server", "share", "subpath", "username",
                                      "domain", "password_enc", "options"))


def store_for(target):
    fp = _fingerprint(target)
    cached = _STORES.get(target["id"])
    if cached and cached[0] == fp:
        return cached[1]
    store = make_storage(target)
    _STORES[target["id"]] = (fp, store)
    _CONN.pop(target["id"], None)
    return store


def forget_store(target_id):
    _STORES.pop(target_id, None)
    _CONN.pop(target_id, None)


def is_connected(target):
    if target["protocol"] == "local":
        return True
    return bool(_CONN.get(target["id"], {}).get("connected"))


def connect_target(target, conn):
    """リモートの保存先に接続し、library / inbox フォルダを用意する。失敗時は ApiError(503)。"""
    try:
        store = store_for(target)
    except StorageError as e:
        raise ApiError(e.message, 503)
    _CONN[target["id"]] = {"connected": False, "last_try": time.monotonic()}
    try:
        store.connect()
        store.ensure_dir("library")
        store.ensure_dir("inbox")
    except StorageError as e:
        conn.execute("UPDATE storage_targets SET last_error=? WHERE id=?", (e.message, target["id"]))
        conn.commit()
        raise ApiError(e.message, 503)
    _CONN[target["id"]]["connected"] = True
    conn.execute("UPDATE storage_targets SET last_error='' WHERE id=?", (target["id"],))
    conn.commit()
    return store


def test_target_params(params):
    """保存前の接続テスト。実際に接続して中身を一覧し、書き込めるかを確かめる。"""
    if params.get("protocol") not in REMOTE_PROTOCOLS:
        raise ApiError("protocol は smb か webdav を指定してください")
    opts = target_options(params) if "options" in params else {}
    if "tls_insecure" in params:
        opts["tls_insecure"] = _truthy(params.get("tls_insecure"))
    fake = {
        "protocol": params["protocol"],
        "server": str(params.get("server", "")).strip(),
        "share": str(params.get("share", "")).strip(),
        "subpath": str(params.get("subpath", "")).strip(),
        "username": str(params.get("username", "")).strip(),
        "domain": str(params.get("domain", "")).strip(),
        "options": json.dumps(opts),
    }
    if not fake["server"]:
        return {"ok": False, "message": "サーバー / URL を入力してください"}
    if fake["protocol"] == "smb" and not fake["share"]:
        return {"ok": False, "message": "共有名を入力してください"}
    try:
        store = make_storage(fake, password=str(params.get("password") or ""))
        store.connect()
        entries, writable = store.probe()
    except StorageError as e:
        return {"ok": False, "message": e.message}
    except ApiError as e:
        return {"ok": False, "message": e.message}
    msg = "接続に成功しました" if writable else "接続に成功しました(書き込みはできないようです)"
    return {"ok": True, "message": msg, "entries": entries, "writable": writable}


def _startup_connect(conn):
    """コンテナ起動時、アクティブなターゲットがリモートなら接続を試みる(失敗しても起動は続ける)。"""
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target or target["protocol"] == "local":
        return
    try:
        connect_target(target, conn)
        print(f"[storage] 「{target['name']}」に接続しました ({store_for(target).describe()})")
    except ApiError as e:
        print(f"[storage] 「{target['name']}」への接続に失敗しました: {e.message}")


def active_store():
    """(store, target_row) を返す。リモートに接続できなければ ApiError(503)。

    NASの再起動などで接続できなかった場合も、RETRY_INTERVAL ごとに自動で繋ぎ直しを試みる。
    """
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target:
        raise ApiError("有効なストレージが設定されていません", 503)
    store = store_for(target)
    if target["protocol"] == "local" or is_connected(target):
        return store, target
    st = _CONN.get(target["id"])
    if st is None or time.monotonic() - st["last_try"] > RETRY_INTERVAL:
        try:
            return connect_target(target, conn), target
        except ApiError as e:
            raise ApiError(f"「{target['name']}」に接続できません: {e.message}", 503)
    reason = target["last_error"] or "接続されていません"
    raise ApiError(f"「{target['name']}」に接続できません: {reason}", 503)


def activate_target(target_id):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    if not target:
        raise ApiError("見つかりません", 404)
    with LOCK:
        if target["protocol"] != "local":
            connect_target(target, conn)  # 失敗時はここで ApiError
        conn.execute("UPDATE storage_targets SET active=0")
        conn.execute("UPDATE storage_targets SET active=1, last_error='', updated_at=? WHERE id=?",
                     (utcnow(), target["id"]))
        conn.commit()
    return active_store()


def require_same_target(row, kind="バージョン"):
    """versions/items の操作対象が、現在アクティブなストレージのものか確認する。"""
    store, target = active_store()
    if row["target_id"] != target["id"]:
        raise ApiError(
            f"この{kind}は現在アクティブなストレージに属していません。"
            "該当のストレージに切り替えてから操作してください。", 409)
    return store, target


# --------------------------------------------------------------------------
# 保存まわり
# --------------------------------------------------------------------------
def lib_rel(relpath):
    """versions.relpath(library からの相対パス)を、保存先ルートからの相対パスにする。"""
    try:
        return join_rel("library", clean_rel(relpath))
    except StorageError:
        raise ApiError("不正なパスです", 400)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def get_or_create_item(conn, target_id, category, name, owner_id):
    key = norm_key(name)
    row = conn.execute(
        "SELECT * FROM items WHERE target_id=? AND owner_id=? AND category=? AND key=?",
        (target_id, owner_id, category, key)).fetchone()
    if row:
        return row, False
    base = safe_name(name)
    taken = {r[0].lower() for r in conn.execute(
        "SELECT folder FROM items WHERE target_id=? AND category=?", (target_id, category))}
    folder, n = base, 2
    while folder.lower() in taken:
        folder = f"{base} ({n})"
        n += 1
    cur = conn.execute(
        "INSERT INTO items (target_id, category, name, key, folder, created_at, owner_id) VALUES (?,?,?,?,?,?,?)",
        (target_id, category, name, key, folder, utcnow(), owner_id),
    )
    row = conn.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,)).fetchone()
    return row, True


def remove_file(store, relpath):
    rel = lib_rel(relpath)
    store.delete(rel)
    store.rmdir_if_empty(parent_rel(rel))  # 空のときだけ消える


META_KEYS = ("loader", "mc", "description", "pack_format", "depends", "softdepends", "mod_id")
DEPS_VERSION = 1  # 依存関係の読み取り方式を変えたら上げる(古いものは読み取り直す)


def meta_from_info(info):
    meta = {k: info[k] for k in META_KEYS if info.get(k)}
    meta["deps_v"] = DEPS_VERSION
    return meta


def _uid_of(username):
    r = db().execute("SELECT id FROM users WHERE username=?", (username or "",)).fetchone()
    return r[0] if r else 0


def _owner_for_request():
    u = current_user() if has_request_context() else None
    return u["id"] if u else 0


def ingest(local, filename, force_cat=None, default_cat=None, src_rel=None, item_id=None,
           store=None, target=None, owner_id=None):
    """ファイルを解析して、保存先の library に登録する。

    local  : 解析に使う手元(コンテナ内)のファイル
    src_rel: 保存先に既にあるファイル(inbox取り込み時)の場所。指定時はアップロードせず
             保存先の中で移動する。未指定なら local を保存先へアップロード(移動)する。
    item_id: 指定すると、解析結果の名前に関係なくそのアイテムの新しいバージョンとして登録する
             (配布サイトから取得した更新ファイルなど)。
    store / target: 省略時は現在アクティブな保存先。
    """
    local = Path(local)
    size = local.stat().st_size
    if size == 0:
        raise ApiError("空のファイルです")
    if store is None:
        store, target = active_store()
    sha = sha256_file(local)
    sha1 = src.sha1_file(local)
    info = analyze(local, filename)
    cat = force_cat or (info["category"] if info["category"] != "other" else (default_cat or "other"))
    meta = meta_from_info(info)

    with LOCK:
        conn = db()
        if item_id:
            owner_row = conn.execute("SELECT owner_id FROM items WHERE id=?", (item_id,)).fetchone()
            owner_id = owner_row[0] if owner_row else owner_id
        if owner_id is None:
            owner_id = _owner_for_request()
        dup = conn.execute(
            "SELECT v.id, v.version, i.id AS item_id, i.name, i.category FROM versions v "
            "JOIN items i ON i.id = v.item_id WHERE v.sha256=? AND v.target_id=? AND i.owner_id=?",
            (sha, target["id"], owner_id)).fetchone()
        if dup:
            return {"status": "duplicate", "filename": filename, "name": dup["name"],
                    "version": dup["version"], "category": dup["category"], "item_id": dup["item_id"]}
        try:
            if item_id:
                item = conn.execute("SELECT * FROM items WHERE id=? AND target_id=?",
                                    (item_id, target["id"])).fetchone()
                if not item:
                    raise ApiError("登録先のアイテムが見つかりません", 404)
                created, cat = False, item["category"]
            else:
                item, created = get_or_create_item(conn, target["id"], cat, info["name"], owner_id)
            dest_dir = join_rel("library", CATEGORIES[cat][0], item["folder"])
            fname = safe_name(Path(filename).name, "file", 200)
            canonical = join_rel(dest_dir, fname)
            if src_rel and clean_rel(src_rel) == canonical:
                dest = canonical  # すでに正しい場所にある(再スキャン時)
            else:
                dest = store.unique_rel(dest_dir, fname)
            conn.execute(
                "INSERT INTO versions (item_id, target_id, version, filename, relpath, size, sha256, sha1, meta, added_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (item["id"], target["id"], info["version"], dest.rsplit("/", 1)[-1],
                 dest[len("library/"):], size, sha, sha1, json.dumps(meta, ensure_ascii=False), utcnow()),
            )
            if src_rel:
                if dest != clean_rel(src_rel):
                    store.move(src_rel, dest)
            else:
                store.put(local, dest)
            conn.commit()
        except StorageError as e:
            conn.rollback()
            raise ApiError(f"保存先への書き込みに失敗しました: {e.message}", 502)
        except Exception:
            conn.rollback()
            raise
    try:
        prune_versions(db(), store, item["id"])
    except Exception:  # noqa: BLE001
        app.logger.exception("prune")
    return {"status": "added", "filename": filename, "name": item["name"],
            "version": info["version"], "category": cat, "item_id": item["id"],
            "new_item": created}


_MC_REL = re.compile(r"^1\.\d+(\.\d+)?$|^\d{2}\.\d+(\.\d+)?$")


def _mc_key(v):
    return tuple(int(x) for x in v.split("."))


def summarize_mc(versions):
    """["1.20.1", "1.20.2", ..., "1.21.4"] → "1.20.1〜1.21.4"(スナップショット等は除く)。"""
    vs = sorted({v for v in versions if isinstance(v, str) and _MC_REL.match(v)}, key=_mc_key)
    if not vs:
        return ""
    return vs[0] if len(vs) == 1 else (", ".join(vs) if len(vs) <= 3 else f"{vs[0]}〜{vs[-1]}")


def mc_max(versions):
    """対応バージョンの一覧から、いちばん新しい正式版(例 "1.21.4")。"""
    vs = [v for v in (versions or []) if isinstance(v, str) and _MC_REL.match(v)]
    return max(vs, key=_mc_key) if vs else ""


PLATFORM_IDS = {"bukkit", "paper", "purpur", "folia", "sponge", "velocity", "bungee", "fabric", "quilt", "forge",
                "neoforge", "shader", "datapack", "resourcepack"}
_PLATFORM_LEGACY = {"Paper": "paper", "Spigot / Paper": "bukkit", "Folia": "folia", "Velocity": "velocity",
                    "BungeeCord": "bungee", "Fabric": "fabric", "Quilt": "quilt", "Forge": "forge", "NeoForge": "neoforge",
                    "Iris / OptiFine": "shader", "Datapack": "datapack", "Minecraft": "resourcepack"}


def auto_mc_versions(meta, category, source):
    """保存しているファイルの中身・配布元の情報から、対応MCバージョンを推定する。"""
    mc = str((meta or {}).get("mc") or "").strip()
    if mc:
        if category == "plugin" and re.match(r"^\d+\.\d+(\.\d+)?$", mc):
            # plugin.yml の api-version は「このバージョン以降」の意味。保存している版が配布元の最新と
            # 同じなら、配布元が示す対応バージョンの上限を付けて「1.13〜1.21.4」のように表示する
            top = mc_max(((source or {}).get("latest") or {}).get("game_versions")) if (source or {}).get("status") == "up_to_date" else ""
            if top and _mc_key(top) > _mc_key(mc):
                return f"{mc}〜{top}"
            return f"{mc} 以降"
        mc = re.sub(r"^>=\s*(\S+)$", r"\1 以降", mc)
        mc = re.sub(r"^\[([^,\]]+),\s*\)$", r"\1 以降", mc)  # Forge の [1.20.1,)
        return mc.lstrip("~^=")[:60]
    if source:
        if source.get("game_versions"):
            return summarize_mc(source["game_versions"])
        if source.get("status") == "up_to_date":
            return summarize_mc((source.get("latest") or {}).get("game_versions") or [])
    return ""


def build_library(conn, store, target, user=None):
    """保存先のアイテム一覧。user を渡すと、その人に見えるもの(自分の + 共有されたもの)だけにする。"""
    tid = target["id"]
    present = store.file_index("library")
    items = {r["id"]: dict(r, versions=[])
             for r in conn.execute("SELECT * FROM items WHERE target_id=?", (tid,))}
    if user is not None:
        vis = visible_item_ids(conn, user)
        items = {k: v for k, v in items.items() if k in vis}
        names = {r[0]: r[1] for r in conn.execute("SELECT id, username FROM users")}
        acl_in = {r[0]: r[1] for r in conn.execute("SELECT item_id, level FROM item_acl WHERE user_id=?", (user["id"],))}
        acl_out = {}
        for r in conn.execute("SELECT a.item_id, a.user_id, a.level FROM item_acl a JOIN items i ON i.id=a.item_id "
                              "WHERE i.owner_id=?", (user["id"],)):
            acl_out.setdefault(r[0], []).append({"user_id": r[1], "username": names.get(r[1], "?"), "level": r[2]})
        favs = {r[0] for r in conn.execute("SELECT item_id FROM favorites WHERE user_id=?", (user["id"],))}
        for it in items.values():
            mine = it["owner_id"] == user["id"]
            it["access"] = "owner" if mine else acl_in.get(it["id"], "view")
            it["owner_name"] = names.get(it["owner_id"], "")
            it["shared_with"] = acl_out.get(it["id"], []) if mine else []
            it["favorite"] = it["id"] in favs
    for r in conn.execute("SELECT * FROM versions WHERE target_id=?", (tid,)):
        if r["item_id"] not in items:
            continue
        d = dict(r)
        try:
            d["meta"] = json.loads(d["meta"] or "{}")
        except ValueError:
            d["meta"] = {}
        d["missing"] = ("library/" + d.pop("relpath")) not in present
        items[d["item_id"]]["versions"].append(d)
    for r in conn.execute("SELECT s.* FROM item_sources s JOIN items i ON i.id=s.item_id WHERE i.target_id=?",
                          (tid,)):
        if r["item_id"] in items:
            items[r["item_id"]]["source"] = source_public(r)
    out = []
    for it in items.values():
        vs = sorted(it["versions"],
                    key=lambda v: (version_key(v["version"]), v["added_at"], v["id"]),
                    reverse=True)
        if not vs:
            continue
        it["versions"] = vs
        it["latest_id"] = vs[0]["id"]
        it["mc_auto"] = auto_mc_versions(vs[0]["meta"], it["category"], it.get("source"))
        # 配布元の最新版がどの MC まで対応しているか(保存している版より新しい場合もある)
        it["mc_latest_max"] = mc_max(((it.get("source") or {}).get("latest") or {}).get("game_versions"))
        it["tags"] = _jl(it.get("tags"), [])
        it["total_size"] = sum(v["size"] for v in vs)
        it["last_added"] = max(v["added_at"] for v in vs)
        it.pop("key", None)
        it.pop("folder", None)
        out.append(it)
    shown = {it["id"] for it in out}
    dependency_report(out, {r["dep_key"]: r["item_id"] for r in conn.execute(
        "SELECT dep_key, item_id FROM dep_links WHERE target_id=?", (tid,)) if r["item_id"] in shown})
    return out


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


def cf_api_key():
    return decrypt_secret(get_setting("cf_api_key"))


# --------------------------------------------------------------------------
# アカウント(ログイン・権限)
# --------------------------------------------------------------------------
def _session_secret():
    if not SESSION_KEY_PATH.exists():
        SESSION_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        SESSION_KEY_PATH.write_bytes(secrets.token_bytes(32))
        try:
            os.chmod(SESSION_KEY_PATH, 0o600)
        except OSError:
            pass
    return SESSION_KEY_PATH.read_bytes()


app.config.update(
    SESSION_COOKIE_NAME="mcpl_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


def ensure_initial_admin(conn):
    """ユーザーが1人もいなければ、環境変数 AUTH_USER / AUTH_PASS から管理者を作る(旧Basic認証からの移行用)。"""
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return
    if AUTH_USER and AUTH_PASS:
        conn.execute("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)",
                     (AUTH_USER, generate_password_hash(AUTH_PASS), "admin", utcnow()))
        print(f"[auth] 環境変数 AUTH_USER から管理者「{AUTH_USER}」を作成しました")


def _pw_stamp(user):
    # パスワードを変えたら、他の端末のログインを無効にするための目印
    return hashlib.sha256(user["password_hash"].encode()).hexdigest()[:16]


def current_user():
    if "user" not in g:
        u = None
        uid = session.get("uid")
        if uid:
            u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if u and session.get("pw") != _pw_stamp(u):
                u = None
        g.user = u
    return g.user


def role_level(user):
    return ROLES.get(user["role"], (0, ""))[0] if user else 0


def user_perms(user):
    if not user:
        return set()
    if user["role"] == "admin":
        return set(PERMS)
    try:
        return {p for p in json.loads(user["perms"] or "[]") if p in PERMS}
    except (ValueError, TypeError, IndexError, KeyError):
        return set()


def has_perm(perm, user=None):
    return perm in user_perms(user or current_user())


def require_perm(perm):
    """管理の操作に必要な権限(管理者、または管理者からその権限をもらったユーザー)。"""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                raise ApiError("ログインしてください", 401)
            if perm not in user_perms(u):
                raise ApiError(f"この操作には「{PERMS[perm].split('(')[0]}」の権限が必要です", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


# --------------------------------------------------------------------------
# 持ち主と共有(アイテム・サーバー)
# --------------------------------------------------------------------------
ACL_LEVELS = {"view": "閲覧・ダウンロード", "edit": "編集もできる"}


def item_access(item, user=None):
    """'owner' / 'edit' / 'view' / None"""
    u = user or current_user()
    if not u or not item:
        return None
    if item["owner_id"] == u["id"]:
        return "owner"
    r = db().execute("SELECT level FROM item_acl WHERE item_id=? AND user_id=?", (item["id"], u["id"])).fetchone()
    return r[0] if r else None


def server_access(srv, user=None):
    u = user or current_user()
    if not u or not srv:
        return None
    if srv["owner_id"] == u["id"]:
        return "owner"
    r = db().execute("SELECT level FROM server_acl WHERE server_id=? AND user_id=?", (srv["id"], u["id"])).fetchone()
    return r[0] if r else None


def visible_item_ids(conn, user=None):
    """このユーザーに見えるアイテム(自分のもの + 共有されたもの)の id の集合。"""
    u = user or current_user()
    if not u:
        return set()
    ids = {r[0] for r in conn.execute("SELECT id FROM items WHERE owner_id=?", (u["id"],))}
    ids |= {r[0] for r in conn.execute("SELECT item_id FROM item_acl WHERE user_id=?", (u["id"],))}
    return ids


def get_item_checked(iid, need="view"):
    """アイテムを取り出し、必要な権限(view / edit / owner)があるか確かめる。無ければ 404(存在も明かさない)。"""
    row = db().execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    acc = item_access(row)
    order = {"view": 1, "edit": 2, "owner": 3}
    if not acc:
        raise ApiError("見つかりません", 404)
    if order[acc] < order[need]:
        raise ApiError("このアイテムを変更する権限がありません(持ち主に「編集もできる」で共有してもらってください)", 403)
    return row


def get_server_checked(sid, need="view"):
    row = db().execute("SELECT * FROM servers WHERE id=?", (sid,)).fetchone()
    acc = server_access(row)
    order = {"view": 1, "edit": 2, "owner": 3}
    if not acc:
        raise ApiError("見つかりません", 404)
    if order[acc] < order[need]:
        raise ApiError("このサーバーを操作する権限がありません(持ち主に「編集もできる」で共有してもらってください)", 403)
    return row


def require(role):
    """ルートに必要な権限を付けるデコレーター。"""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                raise ApiError("ログインしてください", 401)
            if role_level(u) < ROLES[role][0]:
                raise ApiError(f"この操作には「{ROLES[role][1]}」以上の権限が必要です", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


def user_prefs(u):
    try:
        p = json.loads(u["prefs"] or "{}")
    except (KeyError, IndexError, ValueError):
        p = {}
    return p if isinstance(p, dict) else {}


def _clean_widgets(v):
    """ダッシュボードに足したウィジェット(メモ・ToDo・時計・日付)。種類と大きさを確かめて保存する。"""
    out = []
    for w in (v if isinstance(v, list) else [])[:12]:
        if not isinstance(w, dict) or w.get("type") not in ("memo", "todo", "clock", "date"):
            continue
        wid = str(w.get("id") or "")
        if not re.fullmatch(r"x[0-9a-f]{6,12}", wid):
            continue
        c = {"id": wid, "type": w["type"], "title": str(w.get("title") or "")[:40]}
        if w["type"] == "memo":
            c["md"] = bool(w.get("md"))
            c["text"] = str(w.get("text") or "")[:10000]
        elif w["type"] == "todo":
            c["items"] = [{"t": str(x.get("t") or "")[:200], "d": bool(x.get("d"))}
                          for x in (w.get("items") if isinstance(w.get("items"), list) else [])[:100]
                          if isinstance(x, dict) and str(x.get("t") or "").strip()]
        elif w["type"] == "clock":
            c["style"] = "analog" if w.get("style") == "analog" else "digital"
        out.append(c)
    return out


def user_public(u):
    return {"id": u["id"], "username": u["username"], "role": u["role"],
            "role_label": ROLES.get(u["role"], (0, u["role"]))[1], "perms": sorted(user_perms(u)),
            "created_at": u["created_at"], "last_login": u["last_login"], "totp_enabled": bool(u["totp_enabled"])}


def _login(u):
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    session["pw"] = _pw_stamp(u)
    db().execute("UPDATE users SET last_login=? WHERE id=?", (utcnow(), u["id"]))
    db().commit()


_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))
_USERNAME_RE = re.compile(r"^[\w.@-]{1,40}$")


def _check_new_credentials(username, password, need_username=True):
    if need_username and not _USERNAME_RE.match(username or ""):
        raise ApiError("ユーザー名は1〜40文字の英数字・記号(. _ - @)で入力してください")
    if len(password or "") < 8:
        raise ApiError("パスワードは8文字以上にしてください")


# ログイン失敗の回数制限(IPごと、10分で10回まで)
_FAILS = {}
_FAILS_LOCK = threading.Lock()


def _too_many_failures(ip, add=False):
    now = time.monotonic()
    with _FAILS_LOCK:
        if len(_FAILS) > 5000:  # 大量のユーザー名で試されてもメモリを使い切らないように
            for k in [k for k, v in _FAILS.items() if not v or now - v[-1] >= 600]:
                del _FAILS[k]
        lst = [t for t in _FAILS.get(ip, []) if now - t < 600]
        if add:
            lst.append(now)
        _FAILS[ip] = lst
        return len(lst) >= 10


# --------------------------------------------------------------------------
# バックグラウンド処理(移行・更新確認など、時間のかかるもの)
# --------------------------------------------------------------------------
_JOBS = {}
_JOBS_LOCK = threading.Lock()


class Job:
    def __init__(self, kind, title, user):
        self.id = uuid.uuid4().hex[:12]
        self.kind, self.title, self.user = kind, title, user
        self.total = self.done = 0
        self.status = "running"
        self.log = []
        self.result = {}
        self.started = utcnow()
        self.finished = ""

    def note(self, msg):
        self.log.append(msg)
        del self.log[:-200]

    def public(self):
        return {k: getattr(self, k) for k in
                ("id", "kind", "title", "user", "total", "done", "status", "log", "result", "started", "finished")}


def start_job(kind, title, fn, *args, user=""):
    with _JOBS_LOCK:
        if any(j.kind == kind and j.status == "running" for j in _JOBS.values()):
            raise ApiError("同じ種類の処理がすでに実行中です。終わるまでお待ちください", 409)
        job = Job(kind, title, user)
        _JOBS[job.id] = job
        for old in sorted(_JOBS.values(), key=lambda j: j.started)[:-20]:  # 古い記録は捨てる
            if old.status != "running":
                _JOBS.pop(old.id, None)

    def run():
        with app.app_context():
            try:
                fn(job, *args)
                job.status = "done"
            except Exception as e:  # noqa: BLE001
                job.status = "error"
                job.note(f"エラー: {getattr(e, 'message', e)}")
                app.logger.exception("job failed")
                notify_event("errors", f"{job.title} が失敗しました", [str(getattr(e, "message", e))[:500]], "error")
            finally:
                job.finished = utcnow()

    threading.Thread(target=run, daemon=True, name=f"job-{kind}").start()
    return job


def open_store(target):
    """アクティブかどうかに関係なく、その保存先に接続して store を返す。"""
    if target["protocol"] == "local" or is_connected(target):
        return store_for(target)
    return connect_target(target, db())


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
PUBLIC_PATHS = {"/", "/api/auth/me", "/api/auth/login", "/api/auth/setup", "/api/auth/logout", "/api/auth/totp"}


@app.before_request
def check_auth():
    auth = request.headers.get("Authorization", "")
    if request.path.startswith("/api/") and auth.startswith("Bearer cs_"):
        # APIトークン(Cookie を使わないので CSRF の心配はない)
        u = user_from_token(auth[len("Bearer "):].strip())
        if not u:
            raise ApiError("APIトークンが無効です", 401)
        if request.path.startswith(("/api/auth/", "/api/me/totp", "/api/users")):
            raise ApiError("この操作は APIトークンでは行えません", 403)
        g.user, g.via_token = u, True
        return None
    # CSRF対策: 画面(同じオリジンのJavaScript)からしか付けられないヘッダーを、変更系の操作に必須にする
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("X-Requested-With") != "mcpl":
            raise ApiError("不正なリクエストです(画面を再読み込みしてください)", 403)
    if request.path in PUBLIC_PATHS or request.path.startswith(("/static/", "/s/")):
        return None
    if not current_user():
        raise ApiError("ログインしてください", 401)
    return None


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(StorageError)
def handle_storage_error(e):
    return jsonify(error=e.message), 502


@app.errorhandler(Exception)
def handle_error(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify(error=e.description), e.code
    app.logger.exception("unhandled error")
    return jsonify(error="サーバー内部でエラーが発生しました(詳しくはコンテナのログを確認してください)"), 500


@app.get("/")
def index():
    # 更新後に古い画面ファイルがブラウザに残らないよう、読み込むファイルにバージョンを付ける
    html = (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")
    v = quote(running_version() + "-" + str(int((BASE_DIR / "static" / "app.js").stat().st_mtime)))
    html = html.replace('/static/app.css"', f'/static/app.css?v={v}"').replace('/static/app.js"', f'/static/app.js?v={v}"').replace('/static/i18n-en.js"', f'/static/i18n-en.js?v={v}"')
    return Response(html, mimetype="text/html", headers={"Cache-Control": "no-cache"})


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(BASE_DIR / "static", name, max_age=0)


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if request.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


APP_NAME = "CraftShelf"


def running_version():
    return selfupdate.current_version()


def target_public(row, conn=None):
    d = dict(row)
    d.pop("password_enc", None)
    d.pop("mount_opts", None)
    d.pop("options", None)
    d["has_password"] = bool(row["password_enc"])
    d["mounted"] = is_connected(row)
    d["supported"] = row["protocol"] in PROTOCOLS
    d["tls_insecure"] = bool(target_options(row).get("tls_insecure"))
    d["protocol_label"] = PROTOCOLS.get(row["protocol"], f"{row['protocol'].upper()}(非対応)")
    if conn is not None:
        d["item_count"] = conn.execute(
            "SELECT COUNT(*) FROM items WHERE target_id=?", (row["id"],)).fetchone()[0]
    return d


@app.get("/api/library")
def api_library():
    conn = db()
    try:
        store, target = active_store()
        storage_err = None
        items = build_library(conn, store, target, current_user())
        where = store.describe()
    except (ApiError, StorageError) as e:
        target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
        storage_err = e.message
        items = []
        where = None
    return jsonify(
        items=items,
        categories={k: v[1] for k, v in CATEGORIES.items()},
        storage={
            "path": where,
            "target": target_public(target, conn) if target else None,
            "error": storage_err,
        },
        version=running_version(),
        build=selfupdate.build_info(),
        app_name=APP_NAME,
    )


@app.get("/api/storage/status")
def api_storage_status():
    """いま使っている保存先(NAS など)の状況: 接続・応答時間・容量・CraftShelf の使用量・バックアップ。"""
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target:
        raise ApiError("有効なストレージが設定されていません", 404)
    out = {"target": target_public(target, conn), "connected": False, "error": None,
           "latency_ms": None, "capacity": None, "where": None}
    t0 = time.monotonic()
    try:
        store, target = active_store()
        try:
            out["capacity"] = store.capacity()
        except StorageError as e:
            out["capacity_error"] = e.message
        except Exception:  # noqa: BLE001
            out["capacity"] = None
        out["latency_ms"] = round((time.monotonic() - t0) * 1000)
        out["connected"] = True
        if current_user()["role"] == "admin":
            out["where"] = store.describe()
    except (ApiError, StorageError) as e:
        out["error"] = e.message
    r = conn.execute("SELECT COUNT(DISTINCT i.id), COUNT(v.id), COALESCE(SUM(v.size), 0) FROM items i "
                     "LEFT JOIN versions v ON v.item_id=i.id WHERE i.target_id=?", (target["id"],)).fetchone()
    out["usage"] = {"items": r[0], "files": r[1], "bytes": r[2]}
    out["backup"] = {"enabled": bool(int(get_setting("backup_target_id", "0") or 0)),
                     "last": get_setting("last_backup", "")}
    return jsonify(out)


@app.put("/api/upload")
@require("editor")
def api_upload():
    filename = os.path.basename((request.args.get("filename") or "").replace("\\", "/"))
    if not filename:
        raise ApiError("filename が必要です")
    force = request.args.get("category") or None
    if force and force not in CATEGORIES:
        raise ApiError("category が不正です")
    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
    try:
        total = 0
        with open(tmp, "wb") as f:
            while True:
                chunk = request.stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD:
                    raise ApiError(f"ファイルが大きすぎます(上限 {MAX_UPLOAD // 1024 // 1024} MB)", 413)
                f.write(chunk)
        result = ingest(tmp, filename, force)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
    return jsonify(result)


@app.post("/api/scan")
@require("editor")
def api_scan():
    """inbox/ 内のファイルと、DB未登録のlibrary内ファイルを取り込む(アクティブなストレージのみ)。"""
    conn = db()
    store, target = active_store()
    store.ensure_dir("library")
    store.ensure_dir("inbox")
    store.invalidate_index()
    known = {"library/" + r[0] for r in conn.execute(
        "SELECT relpath FROM versions WHERE target_id=?", (target["id"],))}
    inbox_files, inbox_dirs = store.walk("inbox")
    lib_files, lib_dirs = store.walk("library")
    hidden = lambda rel: rel.rsplit("/", 1)[-1].startswith(".")  # noqa: E731
    scan_targets = [(rel, None) for rel in sorted(inbox_files) if not hidden(rel)]  # (rel, default_cat)
    rev = {v[0]: k for k, v in CATEGORIES.items()}
    for rel in sorted(lib_files):
        if hidden(rel) or rel in known:
            continue
        top = rel.split("/")[1] if rel.count("/") >= 2 else ""
        scan_targets.append((rel, rev.get(top)))
    added = dup = 0
    errors = []
    for rel, default_cat in scan_targets:
        name = rel.rsplit("/", 1)[-1]
        try:
            if store.is_local:
                r = ingest(store.local_path(rel), name, default_cat=default_cat, src_rel=rel)
            else:
                tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
                try:
                    store.fetch(rel, tmp)
                    r = ingest(tmp, name, default_cat=default_cat, src_rel=rel)
                finally:
                    try:
                        tmp.unlink()
                    except FileNotFoundError:
                        pass
            if r["status"] == "added":
                added += 1
            else:
                dup += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {getattr(e, 'message', e)}")
    # 取り込みで空になったフォルダを片付ける(inbox本体・カテゴリフォルダは残す)
    keep = {"inbox", "library"} | {"library/" + v[0] for v in CATEGORIES.values()}
    for d in sorted(inbox_dirs + lib_dirs, key=lambda x: x.count("/"), reverse=True):
        if d not in keep:
            store.rmdir_if_empty(d)
    store.invalidate_index()
    present = store.file_index("library")
    missing = sum(1 for r in conn.execute("SELECT relpath FROM versions WHERE target_id=?", (target["id"],))
                  if ("library/" + r[0]) not in present)
    return jsonify(added=added, duplicates=dup, errors=errors, missing=missing,
                   scanned=len(scan_targets))


@app.get("/api/versions/<int:vid>/download")
def api_download(vid):
    row = db().execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    get_item_checked(row["item_id"], "view")
    store, _target = require_same_target(row)
    rel = lib_rel(row["relpath"])
    if store.is_local:
        p = store.local_path(rel)
        if not p.exists():
            raise ApiError("ファイルが保存先に見つかりません", 404)
        return send_file(p, as_attachment=True, download_name=row["filename"])
    if not store.exists(rel):
        raise ApiError("ファイルが保存先に見つかりません", 404)
    f = store.open_read(rel)
    resp = send_file(f, as_attachment=True, download_name=row["filename"],
                     mimetype="application/octet-stream", conditional=False)
    resp.content_length = row["size"]
    return resp


@app.patch("/api/versions/<int:vid>")
@require("editor")
def api_patch_version(vid):
    data = request.get_json(silent=True) or {}
    conn = db()
    row = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    get_item_checked(row["item_id"], "edit")
    version = str(data.get("version", row["version"])).strip()[:64]
    note = str(data.get("note", row["note"])).strip()[:1000]
    meta = _jl(row["meta"], {})
    for key in ("loader", "mc"):
        if key not in data:
            continue
        auto_key = f"auto_{key}"
        if auto_key not in meta:
            meta[auto_key] = meta.get(key, "")
        val = str(data[key] or "").strip()[:60]
        meta[key] = val or meta[auto_key]
        meta[f"user_{key}"] = bool(val)
    with LOCK:
        conn.execute("UPDATE versions SET version=?, note=?, meta=? WHERE id=?",
                     (version, note, json.dumps(meta, ensure_ascii=False), vid))
        conn.commit()
    return jsonify(ok=True)


@app.delete("/api/versions/<int:vid>")
@require("editor")
def api_delete_version(vid):
    conn = db()
    row = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    get_item_checked(row["item_id"], "edit")
    store, _target = require_same_target(row)
    with LOCK:
        conn.execute("DELETE FROM versions WHERE id=?", (vid,))
        left = conn.execute("SELECT COUNT(*) FROM versions WHERE item_id=?", (row["item_id"],)).fetchone()[0]
        if left == 0:
            conn.execute("DELETE FROM items WHERE id=?", (row["item_id"],))
            conn.execute("DELETE FROM item_acl WHERE item_id=?", (row["item_id"],))
            conn.execute("DELETE FROM favorites WHERE item_id=?", (row["item_id"],))
        conn.commit()
        remove_file(store, row["relpath"])
    return jsonify(ok=True)


@app.delete("/api/items/<int:iid>")
@require("editor")
def api_delete_item(iid):
    conn = db()
    item = get_item_checked(iid, "owner")
    store, _target = require_same_target(item, kind="アイテム")
    rows = conn.execute("SELECT relpath FROM versions WHERE item_id=?", (iid,)).fetchall()
    with LOCK:
        conn.execute("DELETE FROM items WHERE id=?", (iid,))
        conn.execute("DELETE FROM item_acl WHERE item_id=?", (iid,))
        conn.execute("DELETE FROM favorites WHERE item_id=?", (iid,))
        conn.commit()
        for r in rows:
            remove_file(store, r["relpath"])
    return jsonify(ok=True)


@app.patch("/api/items/<int:iid>")
@require("editor")
def api_patch_item(iid):
    """名前・種類の変更。同じ名前・種類の項目が既にあれば統合される(同一ストレージ内のみ)。"""
    data = request.get_json(silent=True) or {}
    conn = db()
    item = get_item_checked(iid, "edit")
    store, _target = require_same_target(item, kind="アイテム")
    new_cat = data.get("category", item["category"])
    if new_cat not in CATEGORIES:
        raise ApiError("category が不正です")
    new_name = str(data.get("name", item["name"]) or "").strip()
    if not new_name:
        raise ApiError("名前を入力してください")
    mc_versions = str(data.get("mc_versions", item["mc_versions"]) or "").strip()[:100]
    platform = str(data.get("platform", item["platform"]) or "").strip()[:40]
    if platform and platform not in PLATFORM_IDS:
        raise ApiError("サーバーソフトの指定が不正です")
    if "tags" in data:
        raw = data["tags"] if isinstance(data["tags"], list) else str(data["tags"] or "").split(",")
        tags = list(dict.fromkeys(str(t).strip()[:30] for t in raw if str(t).strip()))[:20]
    else:
        tags = _jl(item["tags"], [])
    try:
        keep_versions = max(0, min(100, int(data.get("keep_versions", item["keep_versions"]) or 0)))
    except (TypeError, ValueError):
        raise ApiError("残すバージョン数は数字で指定してください")

    moved = []  # (dest, src) 失敗時に戻す用
    with LOCK:
        try:
            target, _created = get_or_create_item(conn, item["target_id"], new_cat, new_name, item["owner_id"])
            if target["id"] == item["id"]:
                conn.execute("UPDATE items SET name=? WHERE id=?", (new_name, iid))
            else:
                dest_dir = join_rel("library", CATEGORIES[new_cat][0], target["folder"])
                store.ensure_dir(dest_dir)
                for v in conn.execute("SELECT * FROM versions WHERE item_id=?", (iid,)).fetchall():
                    src = lib_rel(v["relpath"])
                    dest = store.unique_rel(dest_dir, v["filename"])
                    if store.exists(src):
                        store.move(src, dest)
                        moved.append((dest, src))
                    conn.execute(
                        "UPDATE versions SET item_id=?, relpath=?, filename=? WHERE id=?",
                        (target["id"], dest[len("library/"):], dest.rsplit("/", 1)[-1], v["id"]),
                    )
                conn.execute("DELETE FROM items WHERE id=?", (iid,))
            conn.execute("UPDATE items SET mc_versions=?, keep_versions=?, tags=?, platform=? WHERE id=?",
                         (mc_versions, keep_versions, json.dumps(tags, ensure_ascii=False), platform, target["id"]))
            conn.commit()
        except Exception:
            conn.rollback()
            for dest, src in reversed(moved):
                try:
                    store.move(dest, src)
                except (OSError, StorageError):
                    pass
            raise
        # 空になった旧フォルダを片付ける
        store.rmdir_if_empty(join_rel("library", CATEGORIES[item["category"]][0], item["folder"]))
    removed = prune_versions(conn, store, target["id"], user=current_user()["username"]) if keep_versions else []
    return jsonify(ok=True, removed=removed)


# --------------------------------------------------------------------------
# ストレージ接続の登録・切り替え API
# --------------------------------------------------------------------------
@app.get("/api/storage/targets")
@require_perm("storage")
def api_storage_list():
    conn = db()
    rows = conn.execute(
        "SELECT * FROM storage_targets ORDER BY (protocol!='local'), id").fetchall()
    return jsonify(targets=[target_public(r, conn) for r in rows])


def _truthy(v):
    return v is True or str(v).lower() in ("1", "true", "on", "yes")


def _target_payload(data, existing=None):
    def field(key, limit):
        return str(data.get(key, existing[key] if existing else "") or "").strip()[:limit]

    protocol = data.get("protocol", existing["protocol"] if existing else "smb")
    if protocol not in REMOTE_PROTOCOLS:
        raise ApiError("protocol は smb か webdav を指定してください")
    name = field("name", 80)
    if not name:
        raise ApiError("名前を入力してください")
    server = field("server", 500)
    if not server:
        raise ApiError("サーバー(IPアドレス)/ URL を入力してください")
    share = field("share", 255).strip("/\\")
    if protocol == "smb" and not share:
        raise ApiError("共有名を入力してください")
    subpath = field("subpath", 255).strip("/")
    username = field("username", 120)
    domain = field("domain", 120)
    if "password" in data:
        password_enc = encrypt_secret(str(data.get("password") or ""))
    else:
        password_enc = existing["password_enc"] if existing else ""
    opts = target_options(existing) if existing else {}
    if "tls_insecure" in data:
        opts["tls_insecure"] = _truthy(data.get("tls_insecure"))
    return dict(name=name, protocol=protocol, server=server, share=share, subpath=subpath,
                username=username, domain=domain, password_enc=password_enc, options=json.dumps(opts))


@app.post("/api/storage/targets")
@require_perm("storage")
def api_storage_create():
    data = request.get_json(silent=True) or {}
    payload = _target_payload(data)
    conn = db()
    with LOCK:
        cur = conn.execute(
            "INSERT INTO storage_targets "
            "(name,protocol,server,share,subpath,username,domain,password_enc,options,active,created_at,updated_at) "
            "VALUES (:name,:protocol,:server,:share,:subpath,:username,:domain,:password_enc,:options,0,:now,:now)",
            {**payload, "now": utcnow()},
        )
        conn.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.patch("/api/storage/targets/<int:tid>")
@require_perm("storage")
def api_storage_update(tid):
    conn = db()
    row = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    if row["protocol"] == "local":
        raise ApiError("ローカルの設定は変更できません")
    data = request.get_json(silent=True) or {}
    payload = _target_payload(data, existing=row)
    with LOCK:
        conn.execute(
            "UPDATE storage_targets SET name=:name, protocol=:protocol, server=:server, share=:share, "
            "subpath=:subpath, username=:username, domain=:domain, password_enc=:password_enc, "
            "options=:options, last_error='', updated_at=:now WHERE id=:id",
            {**payload, "now": utcnow(), "id": tid},
        )
        conn.commit()
        forget_store(tid)
    return jsonify(ok=True)


@app.delete("/api/storage/targets/<int:tid>")
@require_perm("storage")
def api_storage_delete(tid):
    conn = db()
    row = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    if row["protocol"] == "local":
        raise ApiError("ローカルは削除できません")
    if row["active"]:
        raise ApiError("使用中の接続は削除できません。先に別の接続に切り替えてください")
    has_items = conn.execute("SELECT 1 FROM items WHERE target_id=? LIMIT 1", (tid,)).fetchone()
    if has_items:
        raise ApiError("この接続にはまだ登録されたファイルがあります。削除する前に切り替えて内容を確認してください")
    with LOCK:
        conn.execute("DELETE FROM storage_targets WHERE id=?", (tid,))
        conn.commit()
        forget_store(tid)
    return jsonify(ok=True)


@app.post("/api/storage/targets/test")
@require_perm("storage")
def api_storage_test_new():
    data = request.get_json(silent=True) or {}
    return jsonify(test_target_params(data))


@app.post("/api/storage/targets/<int:tid>/test")
@require_perm("storage")
def api_storage_test_existing(tid):
    conn = db()
    row = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    if row["protocol"] == "local":
        return jsonify(ok=True, message="ローカルは常に利用できます")
    params = dict(row)
    params["password"] = decrypt_secret(row["password_enc"])
    return jsonify(test_target_params(params))


@app.post("/api/storage/targets/<int:tid>/activate")
@require_perm("storage")
def api_storage_activate(tid):
    store, target = activate_target(tid)
    return jsonify(ok=True, target=target_public(target, db()), root=store.describe())


# --------------------------------------------------------------------------
# アカウント API
# --------------------------------------------------------------------------
@app.get("/api/auth/me")
def api_auth_me():
    u = current_user()
    setup = db().execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    return jsonify(user=user_public(u) if u else None, setup_required=setup, prefs=user_prefs(u) if u else None,
                   roles={k: v[1] for k, v in ROLES.items()}, app_name=APP_NAME, version=running_version())


@app.post("/api/auth/setup")
def api_auth_setup():
    """最初の管理者アカウントを作る(ユーザーが1人もいないときだけ使える)。"""
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username", "")).strip(), str(data.get("password", ""))
    _check_new_credentials(username, password)
    conn = db()
    with LOCK:
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            raise ApiError("初期設定はすでに完了しています", 409)
        cur = conn.execute("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)",
                           (username, generate_password_hash(password), "admin", utcnow()))
        for table in ("items", "servers", "sets"):
            conn.execute(f"UPDATE {table} SET owner_id=? WHERE owner_id=0", (cur.lastrowid,))
        conn.commit()
    _login(conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone())
    return jsonify(ok=True)


@app.post("/api/auth/login")
def api_auth_login():
    # X-Forwarded-For は送信側で自由に書き換えられるので使わない(回数制限を回避されるため)
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()[:40]
    keys = ("ip:" + (request.remote_addr or ""), "user:" + username.lower())
    if any(_too_many_failures(k) for k in keys):
        raise ApiError("ログインの失敗が続いたため、しばらく(10分ほど)待ってからお試しください", 429)
    u = db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    # ユーザーが存在しない場合も同じだけ時間をかけ、応答時間からユーザー名を推測されないようにする
    ok = check_password_hash(u["password_hash"] if u else _DUMMY_HASH, str(data.get("password", "")))
    if not u or not ok:
        for k in keys:
            _too_many_failures(k, add=True)
        raise ApiError("ユーザー名かパスワードが違います", 401)
    if u["totp_enabled"]:
        # パスワードは合っている。二段階認証のコードを待つ(5分以内)
        session.clear()
        session["pre_uid"], session["pre_at"] = u["id"], time.time()
        return jsonify(ok=True, need_totp=True)
    _login(u)
    return jsonify(ok=True, user=user_public(u))


@app.post("/api/auth/logout")
def api_auth_logout():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/auth/password")
def api_auth_password():
    data = request.get_json(silent=True) or {}
    u = current_user()
    if not check_password_hash(u["password_hash"], str(data.get("current", ""))):
        raise ApiError("現在のパスワードが違います")
    new = str(data.get("new", ""))
    _check_new_credentials("", new, need_username=False)
    conn = db()
    conn.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(new), u["id"]))
    conn.commit()
    _login(conn.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone())
    return jsonify(ok=True)


@app.get("/api/users")
@require_perm("users")
def api_users():
    rows = db().execute("SELECT * FROM users ORDER BY id").fetchall()
    return jsonify(users=[user_public(r) for r in rows])


@app.post("/api/users")
@require_perm("users")
def api_users_create():
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username", "")).strip(), str(data.get("password", ""))
    role = data.get("role", "editor")
    if role not in ROLES:
        raise ApiError("権限の指定が不正です")
    me = current_user()
    if role == "admin" and me["role"] != "admin":
        raise ApiError("管理者を作れるのは管理者だけです", 403)
    perms = _clean_perms(data.get("perms")) if me["role"] == "admin" else []
    _check_new_credentials(username, password)
    conn = db()
    if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        raise ApiError("そのユーザー名はすでに使われています")
    conn.execute("INSERT INTO users (username, password_hash, role, created_at, perms) VALUES (?,?,?,?,?)",
                 (username, generate_password_hash(password), role, utcnow(), json.dumps(perms)))
    conn.commit()
    return jsonify(ok=True)


def _clean_perms(v):
    return sorted({p for p in (v if isinstance(v, list) else []) if p in PERMS})


def _admin_count(conn):
    return conn.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]


@app.patch("/api/users/<int:uid>")
@require_perm("users")
def api_users_update(uid):
    data = request.get_json(silent=True) or {}
    conn = db()
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise ApiError("見つかりません", 404)
    me = current_user()
    if me["role"] != "admin" and (u["role"] == "admin" or data.get("role") == "admin" or "perms" in data):
        raise ApiError("管理者の変更や、権限の付け外しができるのは管理者だけです", 403)
    if "perms" in data:
        conn.execute("UPDATE users SET perms=? WHERE id=?", (json.dumps(_clean_perms(data["perms"])), uid))
    if "role" in data:
        if data["role"] not in ROLES:
            raise ApiError("権限の指定が不正です")
        if u["role"] == "admin" and data["role"] != "admin" and _admin_count(conn) <= 1:
            raise ApiError("管理者が1人もいなくなるため変更できません")
        conn.execute("UPDATE users SET role=? WHERE id=?", (data["role"], uid))
    if data.get("reset_totp"):
        conn.execute("UPDATE users SET totp_secret='', totp_enabled=0, recovery='[]' WHERE id=?", (uid,))
    if data.get("password"):
        _check_new_credentials("", str(data["password"]), need_username=False)
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (generate_password_hash(str(data["password"])), uid))
    conn.commit()
    return jsonify(ok=True)


@app.delete("/api/users/<int:uid>")
@require_perm("users")
def api_users_delete(uid):
    conn = db()
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise ApiError("見つかりません", 404)
    if uid == current_user()["id"]:
        raise ApiError("自分自身は削除できません")
    if u["role"] == "admin" and _admin_count(conn) <= 1:
        raise ApiError("管理者が1人もいなくなるため削除できません")
    if u["role"] == "admin" and current_user()["role"] != "admin":
        raise ApiError("管理者を削除できるのは管理者だけです", 403)
    _remove_bg_file(user_prefs(u).get("bg_file"))
    moved = _transfer_owner(conn, uid, current_user()["id"])
    conn.execute("DELETE FROM users WHERE id=?", (uid,))
    conn.commit()
    audit("ユーザーを削除", u["username"], f"アイテム {moved['items']} 件・サーバー {moved['servers']} 台を引き継ぎ")
    return jsonify(ok=True, moved=moved)


def _transfer_owner(conn, from_id, to_id):
    """ユーザーを消すとき、その人のアイテム・サーバー・セットを別の人に引き継ぐ。"""
    with LOCK:
        n_items = 0
        for it in conn.execute("SELECT * FROM items WHERE owner_id=?", (from_id,)).fetchall():
            key, name = it["key"], it["name"]
            if conn.execute("SELECT 1 FROM items WHERE target_id=? AND owner_id=? AND category=? AND key=?",
                            (it["target_id"], to_id, it["category"], key)).fetchone():
                old = conn.execute("SELECT username FROM users WHERE id=?", (from_id,)).fetchone()
                name = f"{name} ({old[0] if old else from_id})"  # 同じ名前を持っていたら区別できるように
                key = norm_key(name)
            conn.execute("UPDATE items SET owner_id=?, key=?, name=? WHERE id=?", (to_id, key, name, it["id"]))
            n_items += 1
        n_srv = conn.execute("UPDATE servers SET owner_id=? WHERE owner_id=?", (to_id, from_id)).rowcount
        conn.execute("UPDATE sets SET owner_id=? WHERE owner_id=?", (to_id, from_id))
        conn.execute("UPDATE shares SET owner_id=? WHERE owner_id=?", (to_id, from_id))
        for t in ("item_acl", "server_acl", "favorites"):
            conn.execute(f"DELETE FROM {t} WHERE user_id=?", (from_id,))
        conn.execute("DELETE FROM item_acl WHERE user_id=?", (to_id,))  # 自分のものになったので、共有の記録は不要
        conn.commit()
    return {"items": n_items, "servers": n_srv}


# --------------------------------------------------------------------------
# 共有(アイテム・サーバー)・お気に入り・利用状況
# --------------------------------------------------------------------------
@app.get("/api/users/directory")
@require("viewer")
def api_users_directory():
    """共有する相手を選ぶための一覧(名前だけ)。"""
    me = current_user()
    rows = db().execute("SELECT id, username, role FROM users WHERE id<>? ORDER BY username", (me["id"],)).fetchall()
    return jsonify(users=[{"id": r[0], "username": r[1], "can_edit": r[2] != "viewer"} for r in rows])


def _acl_from(data):
    out = {}
    for x in data.get("shares") or []:
        try:
            uid, lv = int(x.get("user_id")), str(x.get("level") or "view")
        except (TypeError, ValueError, AttributeError):
            raise ApiError("共有の指定が不正です")
        if lv not in ACL_LEVELS:
            raise ApiError("共有の権限が不正です")
        out[uid] = lv
    me = current_user()["id"]
    conn = db()
    valid = {r[0] for r in conn.execute("SELECT id FROM users")}
    return {u: lv for u, lv in out.items() if u in valid and u != me}


@app.put("/api/items/<int:iid>/acl")
@require("editor")
def api_item_acl(iid):
    """アイテムを共有する相手を設定する(持ち主だけ)。shares: [{user_id, level}]"""
    item = get_item_checked(iid, "owner")
    acl = _acl_from(request.get_json(silent=True) or {})
    conn = db()
    with LOCK:
        conn.execute("DELETE FROM item_acl WHERE item_id=?", (iid,))
        for uid, lv in acl.items():
            conn.execute("INSERT INTO item_acl (item_id, user_id, level, created_at) VALUES (?,?,?,?)", (iid, uid, lv, utcnow()))
        conn.commit()
    audit("アイテムの共有を変更", item["name"], f"{len(acl)} 人")
    return jsonify(ok=True)


@app.post("/api/items/acl")
@require("editor")
def api_items_acl_bulk():
    """選んだアイテムをまとめて共有・解除する。{item_ids, user_id, level | remove}"""
    data = request.get_json(silent=True) or {}
    ids = [int(x) for x in data.get("item_ids") or []][:1000]
    try:
        uid = int(data.get("user_id"))
    except (TypeError, ValueError):
        raise ApiError("共有する相手を選んでください")
    if uid == current_user()["id"] or not db().execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        raise ApiError("共有する相手が見つかりません")
    lv = str(data.get("level") or "view")
    if lv not in ACL_LEVELS:
        raise ApiError("共有の権限が不正です")
    conn = db()
    mine = {r[0] for r in conn.execute("SELECT id FROM items WHERE owner_id=?", (current_user()["id"],))}
    done = 0
    with LOCK:
        for iid in ids:
            if iid not in mine:
                continue
            if data.get("remove"):
                conn.execute("DELETE FROM item_acl WHERE item_id=? AND user_id=?", (iid, uid))
            else:
                conn.execute("INSERT OR REPLACE INTO item_acl (item_id, user_id, level, created_at) VALUES (?,?,?,?)",
                             (iid, uid, lv, utcnow()))
            done += 1
        conn.commit()
    return jsonify(ok=True, count=done, skipped=len(ids) - done)


@app.put("/api/servers/<int:srv>/acl")
@require("editor")
def api_server_acl(srv):
    row = get_server_checked(srv, "owner")
    acl = _acl_from(request.get_json(silent=True) or {})
    conn = db()
    with LOCK:
        conn.execute("DELETE FROM server_acl WHERE server_id=?", (srv,))
        for uid, lv in acl.items():
            conn.execute("INSERT INTO server_acl (server_id, user_id, level, created_at) VALUES (?,?,?,?)", (srv, uid, lv, utcnow()))
        conn.commit()
    audit("サーバーの共有を変更", row["name"], f"{len(acl)} 人")
    return jsonify(ok=True)


@app.post("/api/items/<int:iid>/favorite")
@require("viewer")
def api_item_favorite(iid):
    get_item_checked(iid, "view")
    on = _truthy((request.get_json(silent=True) or {}).get("on", True))
    conn = db()
    if on:
        conn.execute("INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?,?,?)",
                     (current_user()["id"], iid, utcnow()))
    else:
        conn.execute("DELETE FROM favorites WHERE user_id=? AND item_id=?", (current_user()["id"], iid))
    conn.commit()
    return jsonify(ok=True, favorite=on)


@app.get("/api/admin/usage")
@require_perm("users")
def api_admin_usage():
    """ユーザーごとの利用状況(何をどれくらい持っているか・共有しているか)。"""
    conn = db()
    out = []
    for u in conn.execute("SELECT * FROM users ORDER BY id").fetchall():
        r = conn.execute("SELECT COUNT(DISTINCT i.id), COUNT(v.id), COALESCE(SUM(v.size), 0) FROM items i "
                         "LEFT JOIN versions v ON v.item_id=i.id WHERE i.owner_id=?", (u["id"],)).fetchone()
        cats = {c: n for c, n in conn.execute("SELECT category, COUNT(*) FROM items WHERE owner_id=? GROUP BY category", (u["id"],))}
        out.append({
            "id": u["id"], "username": u["username"], "role": u["role"], "role_label": ROLES.get(u["role"], (0, u["role"]))[1],
            "perms": sorted(user_perms(u)), "last_login": u["last_login"], "created_at": u["created_at"],
            "items": r[0], "files": r[1], "bytes": r[2], "categories": cats,
            "servers": [x[0] for x in conn.execute("SELECT name FROM servers WHERE owner_id=? ORDER BY name", (u["id"],))],
            "sets": conn.execute("SELECT COUNT(*) FROM sets WHERE owner_id=?", (u["id"],)).fetchone()[0],
            "shared_out": conn.execute("SELECT COUNT(*) FROM item_acl a JOIN items i ON i.id=a.item_id WHERE i.owner_id=?",
                                       (u["id"],)).fetchone()[0],
            "shared_in": conn.execute("SELECT COUNT(*) FROM item_acl WHERE user_id=?", (u["id"],)).fetchone()[0],
            # 共有しているもの(ほかの人に見せているもの)は名前も出す。非公開のものは件数だけ
            "shared_names": [x[0] for x in conn.execute(
                "SELECT DISTINCT i.name FROM items i JOIN item_acl a ON a.item_id=i.id WHERE i.owner_id=? ORDER BY i.name LIMIT 50",
                (u["id"],))],
        })
    return jsonify(users=out, perms=PERMS, total_bytes=sum(x["bytes"] for x in out))


# --------------------------------------------------------------------------
# 個人設定(テーマ・背景画像)
# --------------------------------------------------------------------------
BG_DIR = CONFIG_DIR / "backgrounds"
MAX_BG = 15 * 1024 * 1024
_BG_NAME = re.compile(r"^u\d+-[0-9a-f]{16}\.(png|jpg|webp|gif)$")
_THEME_ID = re.compile(r"^[a-z0-9-]{1,32}$")


def _image_ext(head):
    """中身の先頭バイトで画像の種類を判定する(拡張子やヘッダーは信用しない。SVG は受け付けない)。"""
    if head.startswith(bytes.fromhex("89504e470d0a1a0a")):
        return "png"
    if head.startswith(bytes.fromhex("ffd8ff")):
        return "jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def _save_prefs(uid, prefs):
    conn = db()
    conn.execute("UPDATE users SET prefs=? WHERE id=?", (json.dumps(prefs, ensure_ascii=False), uid))
    conn.commit()


def _remove_bg_file(name):
    if name and _BG_NAME.match(name):
        try:
            (BG_DIR / name).unlink()
        except FileNotFoundError:
            pass


@app.patch("/api/me/prefs")
def api_me_prefs():
    data = request.get_json(silent=True) or {}
    u = current_user()
    prefs = user_prefs(u)
    if "sort" in data:
        if data["sort"] not in ("fav:1", "name:1", "added:-1", "upd:1", "size:-1", "count:-1"):
            raise ApiError("並び順の指定が不正です")
        prefs["sort"] = data["sort"]
    if "dash" in data:
        d = data["dash"] if isinstance(data["dash"], dict) else {}
        clean = lambda xs: [str(x) for x in (xs if isinstance(xs, list) else []) if re.fullmatch(r"[a-z0-9]{1,20}", str(x))][:60]  # noqa: E731
        prefs["dash"] = {"order": clean(d.get("order")), "hidden": clean(d.get("hidden")), "full": clean(d.get("full")),
                         "custom": _clean_widgets(d.get("custom"))}
    if "lang" in data:
        if data["lang"] not in ("ja", "en"):
            raise ApiError("言語の指定が不正です")
        prefs["lang"] = data["lang"]
    if "theme" in data:
        theme = str(data["theme"] or "")
        if not _THEME_ID.match(theme):
            raise ApiError("テーマの指定が不正です")
        if theme == "custom" and not prefs.get("bg_file"):
            raise ApiError("先に背景画像をアップロードしてください")
        prefs["theme"] = theme
    for key, lo, hi in (("bg_dim", 0, 80), ("bg_blur", 0, 40)):
        if key in data:
            try:
                prefs[key] = max(lo, min(hi, int(data[key])))
            except (TypeError, ValueError):
                raise ApiError("数値で指定してください")
    _save_prefs(u["id"], prefs)
    return jsonify(prefs=prefs)


@app.put("/api/me/background")
def api_me_background_upload():
    u = current_user()
    head = request.stream.read(16)
    ext = _image_ext(head)
    if not ext:
        raise ApiError("PNG / JPEG / WebP / GIF の画像を選んでください")
    BG_DIR.mkdir(parents=True, exist_ok=True)
    name = f"u{u['id']}-{secrets.token_hex(8)}.{ext}"
    path = BG_DIR / name
    total = len(head)
    try:
        with open(path, "wb") as f:
            f.write(head)
            while True:
                chunk = request.stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BG:
                    raise ApiError("画像が大きすぎます(15MBまで)", 413)
                f.write(chunk)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    prefs = user_prefs(u)
    _remove_bg_file(prefs.get("bg_file"))
    prefs.update(bg_file=name, theme="custom")
    prefs.setdefault("bg_dim", 20)
    prefs.setdefault("bg_blur", 0)
    _save_prefs(u["id"], prefs)
    return jsonify(prefs=prefs)


@app.delete("/api/me/background")
def api_me_background_delete():
    u = current_user()
    prefs = user_prefs(u)
    _remove_bg_file(prefs.pop("bg_file", None))
    if prefs.get("theme") == "custom":
        prefs["theme"] = "mint"
    _save_prefs(u["id"], prefs)
    return jsonify(prefs=prefs)


@app.get("/api/backgrounds/<name>")
def api_background_file(name):
    if not _BG_NAME.match(name) or not (BG_DIR / name).exists():
        raise ApiError("見つかりません", 404)
    resp = send_from_directory(BG_DIR, name, max_age=86400)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


# --------------------------------------------------------------------------
# 設定 API
# --------------------------------------------------------------------------
def _mask_secret(v):
    """登録済みのキーを、見分けがつく程度に伏せて表示する(例 ptlc_••••a1b2)。"""
    v = v or ""
    if not v:
        return ""
    head = v.split("_", 1)[0] + "_" if "_" in v[:6] else ""
    return f"{head}••••{v[-4:]}" if len(v) > 8 else "••••"


def settings_public():
    # 以前に登録した Webhook は名前を持っていないので、最初の一度だけ取得しておく
    if get_setting("discord_webhook") and not get_setting("discord_info", ""):
        url = decrypt_secret(get_setting("discord_webhook"))
        info = notify.webhook_info(url) if url else {}
        info["id_tail"] = url.rstrip("/").split("/")[-2][-4:] if url.count("/") >= 6 else ""
        set_setting("discord_info", json.dumps(info, ensure_ascii=False))
    return {
        "cf_api_key_set": bool(get_setting("cf_api_key")),
        "check_interval_hours": int(get_setting("check_interval_hours", "0") or 0),
        "auto_download": get_setting("auto_download", "0") == "1",
        "stable_only": get_setting("stable_only", "1") == "1",
        "last_auto_check": get_setting("last_auto_check", ""),
        "self_auto_update": get_setting("self_auto_update", "0") == "1",
        "update_channel": selfupdate.CHANNEL,
        "ptero_url": get_setting("ptero_url", ""),
        "ptero_key_set": bool(get_setting("ptero_key")),
        "ptero_insecure": get_setting("ptero_insecure", "0") == "1",
        "discord_set": bool(get_setting("discord_webhook")),
        "discord_info": _jl(get_setting("discord_info", ""), {}),
        "ptero_key_hint": _mask_secret(decrypt_secret(get_setting("ptero_key"))),
        "discord_events": _jl(get_setting("discord_events", ""), DEFAULT_EVENTS),
        "discord_event_labels": notify.EVENTS,
        "backup_target_id": int(get_setting("backup_target_id", "0") or 0),
        "backup_keep": int(get_setting("backup_keep", "14") or 14),
        "last_backup": get_setting("last_backup", ""),
    }


@app.get("/api/settings")
@require("viewer")
def api_settings():
    return jsonify(settings_public())


_SETTING_PERMS = {
    "system": ("check_interval_hours", "auto_download", "stable_only", "self_auto_update", "update_channel", "telemetry_enabled"),
    "integrations": ("cf_api_key", "ptero_url", "ptero_key", "ptero_insecure", "discord_webhook", "discord_events"),
    "storage": ("backup_target_id", "backup_keep"),
}


@app.patch("/api/settings")
@require("viewer")
def api_settings_update():
    data = request.get_json(silent=True) or {}
    have = user_perms(current_user())
    for perm, keys in _SETTING_PERMS.items():
        if perm not in have and any(k in data for k in keys):
            raise ApiError(f"この設定を変えるには「{PERMS[perm].split('(')[0]}」の権限が必要です", 403)
    if "cf_api_key" in data:
        set_setting("cf_api_key", encrypt_secret(str(data["cf_api_key"] or "").strip()))
    if "check_interval_hours" in data:
        try:
            hours = max(0, min(24 * 7, int(data["check_interval_hours"])))
        except (TypeError, ValueError):
            raise ApiError("確認間隔は数字で指定してください")
        set_setting("check_interval_hours", hours)
    for key in ("auto_download", "stable_only", "self_auto_update", "ptero_insecure"):
        if key in data:
            set_setting(key, "1" if _truthy(data[key]) else "0")
    if "update_channel" in data:
        _set_channel("dev" if data["update_channel"] == "dev" else "stable")
    if "telemetry_enabled" in data:
        on = _truthy(data["telemetry_enabled"])
        set_setting("telemetry_enabled", "1" if on else "0")
        audit("利用状況の送信", "オン" if on else "オフ", "")
        if on:
            threading.Thread(target=_send_telemetry_bg, daemon=True).start()
    if "ptero_url" in data:
        url = str(data["ptero_url"] or "").strip().rstrip("/")
        if url and not re.match(r"^https?://[^\s/]+", url):
            raise ApiError("Pterodactyl の URL は http:// または https:// から入力してください")
        set_setting("ptero_url", url)
    if "ptero_key" in data:
        set_setting("ptero_key", encrypt_secret(str(data["ptero_key"] or "").strip()))
    if "discord_webhook" in data:
        url = str(data["discord_webhook"] or "").strip()
        if url:
            try:
                notify.validate_webhook(url)
            except notify.NotifyError as e:
                raise ApiError(e.message)
        set_setting("discord_webhook", encrypt_secret(url))
        info = notify.webhook_info(url) if url else {}
        if url:
            info["id_tail"] = url.rstrip("/").split("/")[-2][-4:] if url.count("/") >= 6 else ""
        set_setting("discord_info", json.dumps(info, ensure_ascii=False))
    if "discord_events" in data:
        evs = [e for e in (data["discord_events"] or []) if e in notify.EVENTS]
        set_setting("discord_events", json.dumps(evs))
    if "backup_target_id" in data:
        try:
            tid = int(data["backup_target_id"] or 0)
        except (TypeError, ValueError):
            raise ApiError("バックアップ先の指定が不正です")
        if tid and not db().execute("SELECT 1 FROM storage_targets WHERE id=?", (tid,)).fetchone():
            raise ApiError("バックアップ先が見つかりません")
        set_setting("backup_target_id", tid)
    if "backup_keep" in data:
        try:
            set_setting("backup_keep", max(1, min(365, int(data["backup_keep"]))))
        except (TypeError, ValueError):
            raise ApiError("残す数は数字で指定してください")
    return jsonify(settings_public())


# --------------------------------------------------------------------------
# バックグラウンド処理 API
# --------------------------------------------------------------------------
def _job_visible(job):
    """処理の進み具合・記録は、始めた本人と管理者だけが見られる(記録にアドオンの名前などが出るため)。"""
    u = current_user()
    return bool(u) and (u["role"] == "admin" or job.user == u["username"])


@app.get("/api/jobs")
def api_jobs():
    with _JOBS_LOCK:
        jobs = sorted((j for j in _JOBS.values() if _job_visible(j)), key=lambda j: j.started, reverse=True)
    return jsonify(jobs=[j.public() for j in jobs[:10]])


@app.get("/api/jobs/<job_id>")
def api_job(job_id):
    job = _JOBS.get(job_id)
    if not job or not _job_visible(job):
        raise ApiError("見つかりません", 404)
    return jsonify(job.public())


# --------------------------------------------------------------------------
# 保存先の中身の確認・移行
# --------------------------------------------------------------------------
@app.get("/api/storage/targets/<int:tid>/contents")
@require_perm("storage")
def api_storage_contents(tid):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
    if not target:
        raise ApiError("見つかりません", 404)
    store = open_store(target)
    items = build_library(conn, store, target)
    store.invalidate_index()
    lib_files, _ = store.walk("library")
    inbox_files, _ = store.walk("inbox")
    known = {"library/" + r[0] for r in conn.execute("SELECT relpath FROM versions WHERE target_id=?", (tid,))}
    visible = lambda rel: not rel.rsplit("/", 1)[-1].startswith(".")  # noqa: E731
    unregistered = sorted(f for f in lib_files if f not in known and visible(f))
    inbox = sorted(f for f in inbox_files if visible(f))
    compact = [{
        "id": it["id"], "name": it["name"], "category": it["category"],
        "versions": len(it["versions"]), "latest": it["versions"][0]["version"],
        "total_size": it["total_size"], "missing": sum(1 for v in it["versions"] if v["missing"]),
    } for it in sorted(items, key=lambda i: i["name"].lower())]
    return jsonify(
        target=target_public(target, conn), where=store.describe(), items=compact,
        totals={"items": len(items), "files": sum(i["versions"] for i in compact),
                "size": sum(i["total_size"] for i in compact), "missing": sum(i["missing"] for i in compact)},
        unregistered={"count": len(unregistered), "files": unregistered[:200]},
        inbox={"count": len(inbox), "files": inbox[:200]},
    )


def _migrate_job(job, source_id, dest_id, mode, item_ids):
    conn = db()
    s_t = conn.execute("SELECT * FROM storage_targets WHERE id=?", (source_id,)).fetchone()
    d_t = conn.execute("SELECT * FROM storage_targets WHERE id=?", (dest_id,)).fetchone()
    job.note(f"「{s_t['name']}」→「{d_t['name']}」に接続しています…")
    s_store, d_store = open_store(s_t), open_store(d_t)
    q = "SELECT * FROM items WHERE target_id=?"
    args = [source_id]
    if item_ids:
        q += f" AND id IN ({','.join('?' * len(item_ids))})"
        args += list(item_ids)
    items = conn.execute(q, args).fetchall()
    versions = {it["id"]: conn.execute("SELECT * FROM versions WHERE item_id=?", (it["id"],)).fetchall()
                for it in items}
    job.total = sum(len(v) for v in versions.values())
    stats = {"copied": 0, "duplicates": 0, "missing": 0, "errors": 0, "removed": 0}
    for it in items:
        for v in versions[it["id"]]:
            job.done += 1
            label = f"{it['name']} {v['version'] or ''}".strip()
            src_rel = lib_rel(v["relpath"])
            try:
                if not s_store.exists(src_rel):
                    stats["missing"] += 1
                    job.note(f"見つからないためスキップ: {label} ({v['filename']})")
                    continue
                with LOCK:
                    dup = conn.execute("SELECT 1 FROM versions WHERE target_id=? AND sha256=?",
                                       (dest_id, v["sha256"])).fetchone()
                if dup:
                    stats["duplicates"] += 1
                else:
                    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
                    try:
                        s_store.fetch(src_rel, tmp)  # ローカルでもコピーを作る(put は移動するため)
                        with LOCK:
                            d_item, _ = get_or_create_item(conn, dest_id, it["category"], it["name"], it["owner_id"])
                            dest = d_store.unique_rel(
                                join_rel("library", CATEGORIES[it["category"]][0], d_item["folder"]), v["filename"])
                            conn.execute(
                                "INSERT INTO versions (item_id, target_id, version, filename, relpath, size, sha256, "
                                "sha1, meta, note, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (d_item["id"], dest_id, v["version"], dest.rsplit("/", 1)[-1], dest[len("library/"):],
                                 v["size"], v["sha256"], v["sha1"], v["meta"], v["note"], v["added_at"]))
                            try:
                                d_store.put(tmp, dest)
                            except Exception:
                                conn.rollback()
                                raise
                            # 配布元の紐付けも引き継ぐ
                            conn.execute(
                                "INSERT OR IGNORE INTO item_sources (item_id, provider, project_id, title, page_url, "
                                "loaders, game_versions, linked_by) SELECT ?, provider, project_id, title, page_url, "
                                "loaders, game_versions, linked_by FROM item_sources WHERE item_id=?",
                                (d_item["id"], it["id"]))
                            conn.commit()
                    finally:
                        try:
                            tmp.unlink()
                        except FileNotFoundError:
                            pass
                    stats["copied"] += 1
                if mode == "move":
                    with LOCK:
                        conn.execute("DELETE FROM versions WHERE id=?", (v["id"],))
                        if not conn.execute("SELECT 1 FROM versions WHERE item_id=?", (it["id"],)).fetchone():
                            conn.execute("DELETE FROM items WHERE id=?", (it["id"],))
                        conn.commit()
                    remove_file(s_store, v["relpath"])
                    stats["removed"] += 1
            except Exception as e:  # noqa: BLE001
                stats["errors"] += 1
                job.note(f"失敗: {label}: {getattr(e, 'message', e)}")
    job.result = stats
    job.note(f"完了: コピー {stats['copied']} / 移行先に登録済み {stats['duplicates']} / "
              f"見つからない {stats['missing']} / 失敗 {stats['errors']}"
              + (f" / 移行元から削除 {stats['removed']}" if mode == "move" else ""))


@app.post("/api/storage/migrate")
@require_perm("storage")
def api_storage_migrate():
    data = request.get_json(silent=True) or {}
    try:
        source_id, dest_id = int(data.get("source_id")), int(data.get("dest_id"))
    except (TypeError, ValueError):
        raise ApiError("移行元と移行先を指定してください")
    if source_id == dest_id:
        raise ApiError("移行元と移行先が同じです")
    mode = data.get("mode", "copy")
    if mode not in ("copy", "move"):
        raise ApiError("mode は copy か move を指定してください")
    item_ids = [int(x) for x in data.get("item_ids") or []]
    conn = db()
    for tid in (source_id, dest_id):
        t = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
        if not t:
            raise ApiError("保存先が見つかりません", 404)
        open_store(t)  # 接続できるかを先に確認(できなければここでエラー)
    title = "保存先の移行(移動)" if mode == "move" else "保存先の移行(コピー)"
    job = start_job("migrate", title, _migrate_job, source_id, dest_id, mode, item_ids,
                    user=current_user()["username"])
    return jsonify(job.public())


# --------------------------------------------------------------------------
# 配布元(Modrinth / SpigotMC / CurseForge)との連携・更新確認
# --------------------------------------------------------------------------
def _jl(s, default):
    try:
        v = json.loads(s or "")
        return v if isinstance(v, type(default)) else default
    except ValueError:
        return default


def source_public(r):
    return {
        "provider": r["provider"], "provider_label": src.PROVIDERS.get(r["provider"], r["provider"]),
        "project_id": r["project_id"], "title": r["title"], "page_url": r["page_url"],
        "loaders": _jl(r["loaders"], []), "game_versions": _jl(r["game_versions"], []),
        "linked_by": r["linked_by"], "status": r["status"], "message": r["message"],
        "latest": _jl(r["latest"], {}), "checked_at": r["checked_at"],
        "icon_v": _icon_version(r["item_id"]),
    }


def _icon_path(item_id):
    return ICON_DIR / str(int(item_id))


def _icon_version(item_id):
    try:
        return int(_icon_path(item_id).stat().st_mtime)
    except OSError:
        return 0


def fetch_item_icon(item_id, provider, project_id):
    """配布元のアイコンを取得して保存する(取れなくても処理は続ける)。"""
    try:
        b = src.fetch_icon(provider, project_id, api_key=cf_api_key())
    except Exception:  # noqa: BLE001
        return False
    if not b:
        return False
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _icon_path(item_id).with_suffix(".tmp")
    tmp.write_bytes(b)
    os.replace(tmp, _icon_path(item_id))
    return True


@app.get("/api/items/<int:iid>/icon")
def api_item_icon(iid):
    get_item_checked(iid, "view")
    p = _icon_path(iid)
    try:
        b = p.read_bytes()
    except OSError:
        raise ApiError("アイコンがありません", 404)
    mt = src.image_type(b)
    if not mt:
        raise ApiError("アイコンがありません", 404)
    r = Response(b, mimetype=mt)
    r.headers["Cache-Control"] = "private, max-age=86400"
    r.headers["X-Content-Type-Options"] = "nosniff"
    return r


def _item_versions(conn, item_id):
    vs = conn.execute("SELECT * FROM versions WHERE item_id=?", (item_id,)).fetchall()
    return sorted(vs, key=lambda v: (version_key(v["version"]), v["added_at"], v["id"]), reverse=True)


def _default_filters(conn, item, matched=None):
    """紐付け時の絞り込み条件の既定値(loaders / game_versions)。"""
    vs = _item_versions(conn, item["id"])
    loader = _jl(vs[0]["meta"], {}).get("loader") if vs else None
    loaders = src.default_loaders(item["category"], loader)
    if not loaders and matched:
        loaders = matched.get("loaders") or []
    # Mod は MC のバージョンが合わないと動かないので、一致した版の対応バージョンで絞る。
    # プラグインは新しい版が古いMCを切り捨てることが多いので絞らない。
    game_versions = (matched.get("game_versions") or []) if (matched and item["category"] == "mod") else []
    if item["category"] == "mod" and not game_versions and vs:
        # URL や検索で紐付けたときも、ファイルに書かれた MC バージョン(例 1.20.1)で絞る。
        # 絞らないと、別の MC 向けの版(例 26.x 用)が「新しいバージョン」として出てしまう
        mc = str(_jl(vs[0]["meta"], {}).get("mc") or "").strip().lstrip("~^=")
        if _MC_REL.match(mc):
            game_versions = [mc]
    return loaders, game_versions


def link_source(conn, item, info, linked_by, matched=None):
    loaders, game_versions = _default_filters(conn, item, matched)
    with LOCK:
        conn.execute(
            "INSERT INTO item_sources (item_id, provider, project_id, title, page_url, loaders, game_versions, "
            "linked_by, status, message, latest, checked_at) VALUES (?,?,?,?,?,?,?,?, 'unchecked', '', '{}', '') "
            "ON CONFLICT(item_id) DO UPDATE SET provider=excluded.provider, project_id=excluded.project_id, "
            "title=excluded.title, page_url=excluded.page_url, loaders=excluded.loaders, "
            "game_versions=excluded.game_versions, linked_by=excluded.linked_by, status='unchecked', "
            "message='', latest='{}', checked_at=''",
            (item["id"], info["provider"], info["project_id"], info.get("title", ""), info.get("page_url", ""),
             json.dumps(loaders), json.dumps(game_versions), linked_by))
        conn.commit()


def _ensure_hashes(conn, store, versions, want_cf):
    """照合用に sha1(と必要なら CurseForge のフィンガープリント)を用意する。"""
    out = []  # [(version_row, sha1, fingerprint or None)]
    for v in versions:
        sha1, fp = v["sha1"], None
        if not sha1 or want_cf:
            tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
            try:
                store.fetch(lib_rel(v["relpath"]), tmp)
                sha1 = src.sha1_file(tmp)
                fp = src.cf_fingerprint(tmp) if want_cf else None
            except (StorageError, OSError):
                continue
            finally:
                try:
                    tmp.unlink()
                except FileNotFoundError:
                    pass
            if not v["sha1"]:
                with LOCK:
                    conn.execute("UPDATE versions SET sha1=? WHERE id=?", (sha1, v["id"]))
                    conn.commit()
        out.append((v, sha1, fp))
    return out


_PROJECT_TYPES = {"plugin": "plugin", "mod": "mod", "datapack": "datapack", "resourcepack": "resourcepack",
                  "shader": "shader", "modpack": "modpack"}


def detect_source(conn, store, item):
    """保存済みファイルのハッシュや名前から、配布元を探して紐付ける。

    確実なもの(ハッシュ一致、または SpigotMC で名前が完全一致する1件)だけ自動で紐付け、
    それ以外は候補を返す。
    """
    key = cf_api_key()
    hashed = _ensure_hashes(conn, store, _item_versions(conn, item["id"])[:3], want_cf=bool(key))
    sha1s = [h for _v, h, _fp in hashed if h]
    try:
        found = src.modrinth_by_hashes(sha1s)
    except src.SourceError:
        found = {}
    for h in sha1s:
        if h in found:
            ver = found[h]
            info = src.modrinth_project(ver["project_id"])
            link_source(conn, item, info, "hash", matched={"game_versions": ver.get("game_versions") or [],
                                                           "loaders": ver.get("loaders") or []})
            return {"linked": True, "how": "Modrinth でファイルが一致しました", "candidates": []}
    if key:
        fps = [fp for _v, _h, fp in hashed if fp]
        try:
            cf = src.curseforge_by_fingerprints(fps, key)
        except src.SourceError:
            cf = {}
        for fp in fps:
            if fp in cf:
                info = src.curseforge_project(cf[fp]["project_id"], key)
                f = src._cf_file(cf[fp]["file"])
                link_source(conn, item, info, "hash", matched=f)
                return {"linked": True, "how": "CurseForge でファイルが一致しました", "candidates": []}
    candidates = []
    if item["category"] == "plugin":
        # 名前だけで決めると別の同名リソースに紐付くことがあるため、自動では紐付けず候補として出す
        try:
            sp = src.spigot_search(item["name"])
        except src.SourceError:
            sp = []
        for c in sp:
            c["exact"] = norm_key(c["title"]) == norm_key(item["name"])
        sp.sort(key=lambda c: not c["exact"])
        candidates += sp[:5]
    try:
        candidates += src.modrinth_search(item["name"], _PROJECT_TYPES.get(item["category"]))[:5]
    except src.SourceError:
        pass
    return {"linked": False, "how": "", "candidates": candidates}


def _first_nums(v):
    m = re.search(r"\d+(?:\.\d+)*", v or "")
    return tuple(int(x) for x in m.group(0).split(".")) if m else None


def check_item(conn, item):
    """紐付けた配布元の最新版を確認し、保存済みと比べて状態を記録する。"""
    s = conn.execute("SELECT * FROM item_sources WHERE item_id=?", (item["id"],)).fetchone()
    if not s:
        raise ApiError("配布元が紐付けられていません")
    status, message, info = "error", "", {}
    try:
        info = src.latest(s["provider"], s["project_id"], loaders=_jl(s["loaders"], []),
                          game_versions=_jl(s["game_versions"], []),
                          stable_only=get_setting("stable_only", "1") == "1", api_key=cf_api_key())
        if not info:
            message = "条件に合う版が見つかりません(ローダー・MCバージョンの絞り込みを確認してください)"
        else:
            vs = _item_versions(conn, item["id"])
            have = any((info.get("sha1") and v["sha1"] == info["sha1"]) or v["filename"] == info.get("file_name")
                       or src.same_version(v["version"], info.get("version")) for v in vs)
            newest_saved = max((_first_nums(v["version"]) for v in vs if _first_nums(v["version"])), default=None)
            latest_nums = _first_nums(info.get("version"))
            if have:
                status, message = "up_to_date", "最新バージョンを保存しています"
            elif newest_saved and latest_nums and newest_saved > latest_nums:
                status, message = "up_to_date", "保存しているバージョンの方が新しいようです"
            else:
                status = "update"
                message = "新しいバージョンが公開されています" + (f"({info['note']})" if info.get("note") else "")
    except src.SourceError as e:
        message = e.message
    if not _icon_version(item["id"]):
        fetch_item_icon(item["id"], s["provider"], s["project_id"])
    with LOCK:
        conn.execute("UPDATE item_sources SET status=?, message=?, latest=?, checked_at=? WHERE item_id=?",
                     (status, message, json.dumps(info, ensure_ascii=False), utcnow(), item["id"]))
        conn.commit()
    return conn.execute("SELECT * FROM item_sources WHERE item_id=?", (item["id"],)).fetchone()


def download_latest(conn, item, store=None, target=None):
    """配布元の最新版をダウンロードして、そのアイテムの新しいバージョンとして保存する。"""
    s = check_item(conn, item)
    info = _jl(s["latest"], {})
    if s["status"] == "error":
        raise ApiError(s["message"] or "最新版を確認できません")
    if s["status"] == "up_to_date":
        return {"status": "duplicate", "message": s["message"]}
    if not info.get("downloadable") or not info.get("url"):
        raise ApiError(info.get("note") or "この配布元からは自動ダウンロードできません。配布ページから手動で取得してください")
    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
    try:
        try:
            src.download(info["url"], tmp, info.get("sha1") or "")
        except src.SourceError as e:
            raise ApiError(e.message, 502)
        fname = info.get("file_name") or f"{safe_name(item['name'])}-{info.get('version', 'latest')}.jar"
        if store is None:
            store, target = active_store()
        result = ingest(tmp, fname, item_id=item["id"], store=store, target=target)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
    if result.get("status") == "added" and info.get("version"):
        # 配布元の表記(例 5.5.71)の方が分かりやすいことが多いので、読み取れなかった場合は補う
        with LOCK:
            conn.execute("UPDATE versions SET version=? WHERE id=(SELECT MAX(id) FROM versions WHERE item_id=?) "
                         "AND version=''", (info["version"][:64], item["id"]))
            conn.commit()
    check_item(conn, item)
    return result


def _item_for_edit(iid):
    item = get_item_checked(iid, "edit")
    require_same_target(item, kind="アイテム")
    return item


def _source_from_request(data):
    if data.get("url"):
        try:
            provider, pid, hint = src.parse_url(data["url"])
            if provider == "curseforge":
                return src.curseforge_project(pid, cf_api_key(), hint)
            return src.project_info(provider, pid)
        except src.SourceError as e:
            raise ApiError(e.message)
    if data.get("provider") in src.PROVIDERS and data.get("project_id"):
        try:
            return src.project_info(data["provider"], str(data["project_id"]), cf_api_key())
        except src.SourceError as e:
            raise ApiError(e.message)
    raise ApiError("配布ページのURLを入力してください")


@app.post("/api/items/<int:iid>/source")
@require("editor")
def api_source_link(iid):
    item = _item_for_edit(iid)
    info = _source_from_request(request.get_json(silent=True) or {})
    conn = db()
    link_source(conn, item, info, "manual")
    return jsonify(source=source_public(check_item(conn, item)))


@app.patch("/api/items/<int:iid>/source")
@require("editor")
def api_source_update(iid):
    item = _item_for_edit(iid)
    data = request.get_json(silent=True) or {}
    conn = db()
    if not conn.execute("SELECT 1 FROM item_sources WHERE item_id=?", (iid,)).fetchone():
        raise ApiError("配布元が紐付けられていません")

    def split(v):
        return [x.strip() for x in (v if isinstance(v, list) else str(v or "").split(",")) if x.strip()][:30]
    with LOCK:
        if "loaders" in data:
            conn.execute("UPDATE item_sources SET loaders=? WHERE item_id=?",
                         (json.dumps([x.lower() for x in split(data["loaders"])]), iid))
        if "game_versions" in data:
            conn.execute("UPDATE item_sources SET game_versions=? WHERE item_id=?",
                         (json.dumps(split(data["game_versions"])), iid))
        conn.commit()
    return jsonify(source=source_public(check_item(conn, item)))


@app.delete("/api/items/<int:iid>/source")
@require("editor")
def api_source_unlink(iid):
    _item_for_edit(iid)
    conn = db()
    conn.execute("DELETE FROM item_sources WHERE item_id=?", (iid,))
    conn.commit()
    return jsonify(ok=True)


@app.post("/api/items/<int:iid>/source/detect")
@require("editor")
def api_source_detect(iid):
    item = _item_for_edit(iid)
    store, _t = active_store()
    conn = db()
    r = detect_source(conn, store, item)
    s = conn.execute("SELECT * FROM item_sources WHERE item_id=?", (iid,)).fetchone()
    if r["linked"]:
        s = check_item(conn, item)
    return jsonify({**r, "source": source_public(s) if s else None})


@app.post("/api/items/<int:iid>/source/check")
@require("editor")
def api_source_check(iid):
    item = _item_for_edit(iid)
    return jsonify(source=source_public(check_item(db(), item)))


@app.post("/api/items/<int:iid>/source/download")
@require("editor")
def api_source_download(iid):
    item = _item_for_edit(iid)
    return jsonify(download_latest(db(), item))


def _bulk_job(job, target_id, do_detect, do_check, do_download, only_user_id=None):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target) if (do_detect or do_download) else None
    items = conn.execute("SELECT * FROM items WHERE target_id=? ORDER BY name", (target_id,)).fetchall()
    if only_user_id:
        editable = {r[0] for r in conn.execute("SELECT item_id FROM item_acl WHERE user_id=? AND level='edit'", (only_user_id,))}
        items = [it for it in items if it["owner_id"] == only_user_id or it["id"] in editable]
    linked = {r[0] for r in conn.execute("SELECT item_id FROM item_sources")}
    todo = [it for it in items if (it["id"] in linked) or do_detect]
    job.total = len(todo)
    stats = {"linked": 0, "checked": 0, "updates": 0, "downloaded": 0, "errors": 0}
    for it in todo:
        job.done += 1
        try:
            if it["id"] not in linked:
                r = detect_source(conn, store, it)
                if not r["linked"]:
                    continue
                stats["linked"] += 1
                job.note(f"紐付け: {it['name']}({r['how']})")
            if not (do_check or do_download):
                continue
            s = check_item(conn, it)
            stats["checked"] += 1
            if s["status"] == "error":
                stats["errors"] += 1
                job.note(f"確認できません: {it['name']}: {s['message']}")
            elif s["status"] == "update":
                stats["updates"] += 1
                latest = _jl(s["latest"], {})
                job.note(f"更新あり: {it['name']} → {latest.get('version', '?')}")
                if do_download and latest.get("downloadable"):
                    r = download_latest(conn, it, store=store, target=target)
                    if r.get("status") == "added":
                        stats["downloaded"] += 1
                        job.note(f"保存しました: {it['name']} {latest.get('version', '')}")
        except Exception as e:  # noqa: BLE001
            stats["errors"] += 1
            job.note(f"失敗: {it['name']}: {getattr(e, 'message', e)}")
    job.result = stats
    job.note("完了: " + " / ".join(f"{k} {v}" for k, v in {
        "紐付け": stats["linked"], "確認": stats["checked"], "更新あり": stats["updates"],
        "保存": stats["downloaded"], "失敗": stats["errors"]}.items()))
    upd_lines = [x.replace("更新あり: ", "・") for x in job.log if x.startswith("更新あり: ")]
    if upd_lines:
        notify_event("updates", f"新しいバージョンが {len(upd_lines)} 件あります", upd_lines[:30])
    if stats["downloaded"]:
        notify_event("downloaded", f"{stats['downloaded']} 件の新しいバージョンを保存しました",
                     [x.replace("保存しました: ", "・") for x in job.log if x.startswith("保存しました: ")][:30])
    if stats["errors"]:
        notify_event("errors", f"更新の確認で {stats['errors']} 件のエラー",
                     [x for x in job.log if x.startswith(("確認できません", "失敗"))][:20], "warn")


@app.post("/api/updates/run")
@require("editor")
def api_updates_run():
    """detect=未連携のアイテムの配布元を探す / check=最新版を確認 / download=更新を保存。"""
    data = request.get_json(silent=True) or {}
    _store, target = active_store()
    detect, check, dl = _truthy(data.get("detect")), _truthy(data.get("check", True)), _truthy(data.get("download"))
    title = "配布元の自動検出" if detect and not check else ("更新の確認と保存" if dl else "更新の確認")
    job = start_job("updates", title, _bulk_job, target["id"], detect, check, dl, current_user()["id"],
                    user=current_user()["username"])
    return jsonify(job.public())


def _import_version(info, ver, loaders, game_versions, force_cat=None):
    """配布元の特定の版をダウンロードして登録し、配布元も紐付ける。登録結果を返す。"""
    if not ver.get("downloadable") or not ver.get("url"):
        raise ApiError(ver.get("note") or "この配布元からは自動ダウンロードできません")
    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
    try:
        try:
            src.download(ver["url"], tmp, ver.get("sha1") or "")
        except src.SourceError as e:
            raise ApiError(e.message, 502)
        result = ingest(tmp, ver.get("file_name") or f"{safe_name(info['title'])}.jar", force_cat)
    finally:
        tmp.unlink(missing_ok=True)
    conn = db()
    item = conn.execute("SELECT * FROM items WHERE id=?", (result["item_id"],)).fetchone()
    if not conn.execute("SELECT 1 FROM item_sources WHERE item_id=?", (item["id"],)).fetchone():
        link_source(conn, item, info, "import", matched=ver)
        if loaders or game_versions:
            cur = _jl(conn.execute("SELECT loaders FROM item_sources WHERE item_id=?", (item["id"],)).fetchone()[0], [])
            conn.execute("UPDATE item_sources SET loaders=?, game_versions=? WHERE item_id=?",
                         (json.dumps(loaders or cur), json.dumps(game_versions), item["id"]))
            conn.commit()
        check_item(conn, item)
    return result


def _in_library(conn, target_id, provider, project_id, title=""):
    """このユーザーのライブラリ(自分の + 共有されたもの)に、もうあるか。"""
    vis = visible_item_ids(conn)
    for r in conn.execute("SELECT s.item_id FROM item_sources s JOIN items i ON i.id=s.item_id "
                          "WHERE i.target_id=? AND s.provider=? AND s.project_id=?", (target_id, provider, str(project_id))):
        if r[0] in vis:
            return r[0]
    if title:
        key = norm_key(title)
        for row in conn.execute("SELECT id, name FROM items WHERE target_id=?", (target_id,)):
            if row["id"] in vis and norm_key(row["name"]) == key:
                return row["id"]
    return None


@app.post("/api/import")
@require("editor")
def api_import():
    """配布元からダウンロードして登録する。version_id を指定するとその版、無ければ条件に合う最新版。
    with_deps に前提のプロジェクトIDを渡すと、ライブラリに無いものを同じ条件でまとめて登録する。"""
    data = request.get_json(silent=True) or {}
    info = _source_from_request(data)
    loaders = [x.strip().lower() for x in str(data.get("loaders") or "").split(",") if x.strip()]
    game_versions = [x.strip() for x in str(data.get("game_versions") or "").split(",") if x.strip()]
    force = data.get("category") if data.get("category") in CATEGORIES else None
    try:
        if data.get("version_id"):
            ver = src.version_info(info["provider"], info["project_id"], str(data["version_id"]), cf_api_key())
        else:
            ver = src.latest(info["provider"], info["project_id"], loaders=loaders, game_versions=game_versions,
                             stable_only=get_setting("stable_only", "1") == "1", api_key=cf_api_key())
    except src.SourceError as e:
        raise ApiError(e.message, 502)
    if not ver:
        raise ApiError("条件に合うバージョンが見つかりません(サーバーソフト・MCバージョンを確認してください)")
    result = _import_version(info, ver, loaders, game_versions, force)
    deps_out = []
    _store, target = active_store()
    conn = db()
    for pid in [str(x) for x in data.get("with_deps") or []][:30]:
        try:
            dinfo = src.project_info(info["provider"], pid, cf_api_key())
            if _in_library(conn, target["id"], info["provider"], pid, dinfo["title"]):
                deps_out.append({"title": dinfo["title"], "status": "exists"})
                continue
            dver = src.latest(info["provider"], pid, loaders=loaders, game_versions=game_versions,
                              stable_only=get_setting("stable_only", "1") == "1", api_key=cf_api_key())
            if not dver:
                deps_out.append({"title": dinfo["title"], "status": "notfound"})
                continue
            r = _import_version(dinfo, dver, loaders, game_versions)
            deps_out.append({"title": dinfo["title"], "status": r["status"], "version": r.get("version")})
        except (ApiError, src.SourceError) as e:
            deps_out.append({"title": pid, "status": "error", "message": getattr(e, "message", str(e))})
    return jsonify({**result, "source_title": info["title"], "deps": deps_out})


_MC_CACHE = {"at": 0.0, "list": []}


@app.get("/api/mc/versions")
def api_mc_versions():
    # 新しい MC が出たら自動で選択肢に出るよう、Mojang の一覧を 12 時間ごとに取り直す(失敗したら前回の値)
    if time.time() - _MC_CACHE["at"] > 12 * 3600:
        try:
            _MC_CACHE["list"] = src.mc_releases()
            _MC_CACHE["at"] = time.time()
        except Exception:  # noqa: BLE001
            _MC_CACHE["at"] = time.time() - 11 * 3600  # 1 時間後にもう一度試す
    return jsonify(versions=_MC_CACHE["list"])


@app.get("/api/search/versions")
def api_search_versions():
    provider, pid = request.args.get("provider", ""), str(request.args.get("project_id") or "")
    loaders = [x for x in [(request.args.get("loader") or "").strip().lower()] if x]
    mc = [x for x in [(request.args.get("mc") or "").strip()] if x]
    if provider not in src.PROVIDERS or not pid:
        raise ApiError("配布元とプロジェクトを指定してください")
    try:
        vers = src.versions(provider, pid, loaders=loaders, game_versions=mc, api_key=cf_api_key())
        dep_ids = [d["project_id"] for v in vers[:10] for d in v.get("deps") or []]
        titles = src.project_titles(provider, dep_ids, cf_api_key())
    except src.SourceError as e:
        raise ApiError(e.message, 502)
    _store, target = active_store()
    conn = db()
    for v in vers:
        for d in v.get("deps") or []:
            t = titles.get(d["project_id"], {})
            d["title"] = t.get("title") or d["project_id"]
            d["page_url"] = t.get("page_url") or ""
            d["item_id"] = _in_library(conn, target["id"], provider, d["project_id"], d["title"])
    return jsonify(versions=vers)


# --------------------------------------------------------------------------
# CraftShelf 自身の更新(GitHub から)
# --------------------------------------------------------------------------
@app.get("/api/system/info")
def api_system_info():
    return jsonify(name=APP_NAME, version=running_version(), build=selfupdate.build_info(),
                   repo=selfupdate.REPO, branch=selfupdate.branch(), channel=selfupdate.CHANNEL)


@app.get("/api/system/update")
@require_perm("system")
def api_system_update_check():
    return jsonify(selfupdate.check(force=_truthy(request.args.get("force"))))


def _self_update_job(job):
    old, new = selfupdate.apply(note=job.note)
    job.result = {"from": old, "to": new}
    audit("パネルをアップデート", f"{old} → {new}", "", user=job.user)
    notify_event("selfupdate", f"CraftShelf を v{new} にアップデートしました", [f"v{old} → v{new}"])
    job.note(f"{old} → {new} に更新しました。再起動します(数秒で画面が新しいバージョンに切り替わります)")
    selfupdate.restart()


@app.post("/api/system/update")
@require_perm("system")
def api_system_update_apply():
    info = selfupdate.check(force=True)
    if info["error"]:
        raise ApiError(info["error"], 502)
    if not info["update_available"] and not info.get("downgrade"):
        raise ApiError(f"すでに最新です({info['current']})", 409)
    job = start_job("selfupdate", f"{APP_NAME} の更新 ({info['current']} → {info['latest']})",
                    _self_update_job, user=current_user()["username"])
    return jsonify(job.public())


# ==========================================================================
# 操作の記録(監査ログ)
# ==========================================================================
AUDIT_LABELS = {
    "api_upload": "ファイルを登録", "api_scan": "inbox を取り込み", "api_patch_version": "バージョン情報を編集",
    "api_delete_version": "バージョンを削除", "api_delete_item": "アイテムを削除", "api_patch_item": "アイテム情報を編集",
    "api_storage_create": "保存先を追加", "api_storage_update": "保存先を編集", "api_storage_delete": "保存先を削除",
    "api_storage_activate": "保存先を切り替え", "api_storage_migrate": "保存先の移行を開始",
    "api_source_link": "配布元を紐付け", "api_source_update": "配布元の絞り込みを変更", "api_source_unlink": "配布元の紐付けを解除",
    "api_source_download": "最新バージョンを保存", "api_updates_run": "更新の確認を開始", "api_import": "URLから追加",
    "api_auth_setup": "初期設定(管理者を作成)", "api_auth_login": "ログイン", "api_auth_logout": "ログアウト",
    "api_auth_password": "パスワードを変更", "api_users_create": "ユーザーを追加", "api_users_update": "ユーザーを変更",
    "api_users_delete": "ユーザーを削除", "api_settings_update": "設定を変更", "api_system_update_apply": "パネルのアップデートを開始",
    "api_sets_create": "セットを作成", "api_sets_update": "セットを編集", "api_sets_delete": "セットを削除",
    "api_servers_create": "サーバーを連携", "api_servers_update": "サーバー設定を変更", "api_servers_delete": "サーバーの連携を解除",
    "api_servers_sync": "サーバーを同期", "api_servers_push": "サーバーへ転送", "api_servers_import": "サーバーから取り込み",
    "api_servers_power": "サーバーの電源操作", "api_backup_run": "バックアップを開始", "api_deps_rescan": "依存関係の読み取りを開始",
    "api_deps_link": "前提プラグインを紐付け", "api_shares_create": "共有リンクを作成", "api_shares_delete": "共有リンクを削除", "api_modpack": "Modパックの読み込みを開始", "api_server_rollback": "巻き戻しを開始",

}


def audit(action, target="", detail="", user=None):
    try:
        if user is None:
            try:
                u = current_user()
                user = u["username"] if u else "(未ログイン)"
            except RuntimeError:
                user = "(自動)"
        conn = db()
        conn.execute("INSERT INTO audit (at, username, action, target, detail) VALUES (?,?,?,?,?)",
                     (utcnow(), str(user)[:60], action[:100], str(target)[:200], str(detail)[:1000]))
        conn.commit()
    except Exception:  # noqa: BLE001
        app.logger.exception("audit")


@app.before_request
def audit_prepare():
    """削除などで消えてしまう前に、操作対象の名前を控えておく。"""
    ep = request.endpoint or ""
    if request.method in ("GET", "HEAD", "OPTIONS") or ep not in AUDIT_LABELS:
        return None
    va = request.view_args or {}
    target = ""
    try:
        conn = db()
        if "vid" in va:
            r = conn.execute("SELECT i.name, v.version, v.filename FROM versions v JOIN items i ON i.id=v.item_id "
                             "WHERE v.id=?", (va["vid"],)).fetchone()
            target = f"{r['name']} {r['version'] or r['filename']}" if r else ""
        elif "iid" in va:
            r = conn.execute("SELECT name FROM items WHERE id=?", (va["iid"],)).fetchone()
            target = r["name"] if r else ""
        elif "tid" in va:
            r = conn.execute("SELECT name FROM storage_targets WHERE id=?", (va["tid"],)).fetchone()
            target = r["name"] if r else ""
        elif "uid" in va:
            r = conn.execute("SELECT username FROM users WHERE id=?", (va["uid"],)).fetchone()
            target = r["username"] if r else ""
        elif "sid" in va:
            r = conn.execute("SELECT name FROM sets WHERE id=?", (va["sid"],)).fetchone()
            target = r["name"] if r else ""
        elif "srv" in va:
            r = conn.execute("SELECT name FROM servers WHERE id=?", (va["srv"],)).fetchone()
            target = r["name"] if r else ""
    except Exception:  # noqa: BLE001
        pass
    g.audit_target = target
    if ep == "api_auth_logout":  # ログアウト後は誰だったか分からなくなるので先に控える
        u = current_user()
        g.audit_user = u["username"] if u else None
    return None


@app.after_request
def audit_write(resp):
    ep = request.endpoint or ""
    if request.method in ("GET", "HEAD", "OPTIONS") or ep not in AUDIT_LABELS:
        return resp
    data = request.get_json(silent=True) if request.is_json else None
    data = data if isinstance(data, dict) else {}
    ok = resp.status_code < 400
    if not ok and ep != "api_auth_login":
        return resp
    target, detail = getattr(g, "audit_target", ""), ""
    try:
        body = resp.get_json(silent=True) or {}
    except Exception:  # noqa: BLE001
        body = {}
    if ep in ("api_upload", "api_import", "api_source_download") and isinstance(body, dict):
        target = target or f"{body.get('name', '')} {body.get('version', '')}".strip()
        detail = {"added": "追加", "duplicate": "登録済み"}.get(body.get("status"), "")
    elif ep == "api_scan" and isinstance(body, dict):
        detail = f"{body.get('added', 0)} 件追加"
    elif ep in ("api_auth_login", "api_auth_setup"):
        target = str(data.get("username", ""))[:40]
        if ok and isinstance(body, dict) and body.get("need_totp"):
            return resp  # 二段階認証の確認後に記録する
        if not ok:
            audit("ログインに失敗", target, request.remote_addr or "", user="(未ログイン)")
            return resp
    elif ep in ("api_users_create",):
        target = str(data.get("username", ""))[:40]
        detail = str(data.get("role", ""))
    elif ep in ("api_users_update",):
        detail = ", ".join(f"{k}" for k in data if k != "password") + (" / パスワード再設定" if data.get("password") else "")
    elif ep == "api_settings_update":
        detail = ", ".join(sorted(k for k in data))
    elif ep in ("api_patch_item", "api_sets_create", "api_sets_update", "api_storage_create", "api_servers_create"):
        target = target or str(data.get("name", ""))[:80]
        if ep == "api_patch_item":
            detail = ", ".join(f"{k}: {v}" for k, v in data.items() if k in ("name", "category", "mc_versions", "keep_versions"))
    elif ep == "api_servers_power":
        detail = str(data.get("signal", ""))
    user = None
    if ep == "api_auth_logout":
        user = getattr(g, "audit_user", None) or "(未ログイン)"
    elif ep in ("api_auth_login", "api_auth_setup"):
        user = target
    audit(AUDIT_LABELS[ep], target, detail, user=user)
    return resp


@app.get("/api/audit")
@require_perm("audit")
def api_audit():
    try:
        limit = max(1, min(500, int(request.args.get("limit", 100))))
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        raise ApiError("数値で指定してください")
    q = str(request.args.get("q") or "").strip()
    where, args = "", []
    if q:
        where = "WHERE username LIKE ? OR action LIKE ? OR target LIKE ? OR detail LIKE ?"
        args = [f"%{q}%"] * 4
    conn = db()
    rows = conn.execute(f"SELECT * FROM audit {where} ORDER BY id DESC LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM audit {where}", args).fetchone()[0]
    return jsonify(entries=[dict(r) for r in rows], total=total)


def prune_audit(conn):
    conn.execute("DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 20000)")


# ==========================================================================
# Discord 通知
# ==========================================================================
DEFAULT_EVENTS = ["updates", "downloaded", "errors", "servers", "backup", "selfupdate"]


def notify_event(event, title, lines, level="info"):
    try:
        url = decrypt_secret(get_setting("discord_webhook"))
        if not url:
            return
        events = _jl(get_setting("discord_events", ""), DEFAULT_EVENTS) or []
        if event in events:
            notify.send(url, f"CraftShelf: {title}", lines, level)
    except Exception:  # noqa: BLE001
        app.logger.exception("notify")


@app.post("/api/settings/discord/test")
@require_perm("integrations")
def api_discord_test():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip() or decrypt_secret(get_setting("discord_webhook"))
    if not url:
        raise ApiError("Webhook の URL を入力してください")
    try:
        notify.send_now(url, "CraftShelf: テスト通知", ["CraftShelf からのテスト通知です。この通知が見えていれば設定は正しくできています。"])
    except notify.NotifyError as e:
        raise ApiError(e.message, 502)
    return jsonify(ok=True)


# ==========================================================================
# 古いバージョンの自動整理
# ==========================================================================
def pinned_version_ids(conn):
    return {r[0] for r in conn.execute("SELECT version_id FROM set_items WHERE version_id IS NOT NULL")}


def prune_versions(conn, store, item_id, user="(自動)"):
    """アイテムの「残す数」を超えた古いバージョンを削除する(最新・セットで指定中のものは残す)。"""
    item = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    keep = int(item["keep_versions"] or 0) if item else 0
    if keep <= 0:
        return []
    vs = _item_versions(conn, item_id)
    pinned = pinned_version_ids(conn)
    removed = []
    for v in vs[keep:]:
        if v["id"] in pinned:
            continue
        with LOCK:
            conn.execute("DELETE FROM versions WHERE id=?", (v["id"],))
            conn.commit()
        try:
            remove_file(store, v["relpath"])
        except (StorageError, ApiError):
            pass
        removed.append(v["version"] or v["filename"])
    if removed:
        audit("古いバージョンを自動で整理", item["name"], ", ".join(removed), user=user)
    return removed


# ==========================================================================
# 依存関係(前提プラグイン・Mod)
# ==========================================================================
def dependency_report(items, aliases=None):
    """build_library の結果に、前提プラグインの状況(ライブラリにあるか・どれか)を書き足す。"""
    aliases = aliases or {}
    by_key = {}
    ids = {it["id"] for it in items}
    for it in items:
        latest = next((v for v in it["versions"] if v["id"] == it["latest_id"]), it["versions"][0])
        keys = {norm_key(it["name"])}
        if latest["meta"].get("mod_id"):
            keys.add(norm_key(latest["meta"]["mod_id"]))
        it["dep_key"] = sorted(keys)
        for k in keys:
            by_key.setdefault(k, it["id"])
    for k, iid in aliases.items():
        if iid in ids:
            by_key[k] = iid
            next(it for it in items if it["id"] == iid)["dep_key"].append(k)
    for it in items:
        latest = next((v for v in it["versions"] if v["id"] == it["latest_id"]), it["versions"][0])
        it["depends"] = latest["meta"].get("depends") or []
        it["softdepends"] = latest["meta"].get("softdepends") or []
        it["dep_status"] = [{"name": d, "required": req, "item_id": by_key.get(norm_key(d)), "manual": norm_key(d) in aliases}
                            for req, lst in ((True, it["depends"]), (False, it["softdepends"])) for d in lst]
        it["missing_deps"] = [d["name"] for d in it["dep_status"] if d["required"] and not d["item_id"]]
        it["deps_scanned"] = bool(latest["meta"].get("deps_v"))


def _rescan_deps_job(job, target_id, only_ids=None):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    rows = conn.execute("SELECT v.* FROM versions v WHERE v.target_id=?", (target_id,)).fetchall()
    if only_ids is not None:  # 画面から実行したときは、その人に見えるものだけ(記録にほかの人のファイル名を出さない)
        rows = [v for v in rows if v["item_id"] in only_ids]
    todo = [v for v in rows if _jl(v["meta"], {}).get("deps_v") != DEPS_VERSION]
    job.total = len(todo)
    for v in todo:
        job.done += 1
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            store.fetch(lib_rel(v["relpath"]), tmp)
            info = analyze(tmp, v["filename"])
            meta = _jl(v["meta"], {})
            meta.update(meta_from_info(info))
            with LOCK:
                conn.execute("UPDATE versions SET meta=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), v["id"]))
                conn.commit()
        except Exception as e:  # noqa: BLE001
            job.note(f"読み取れません: {v['filename']}: {getattr(e, 'message', e)}")
        finally:
            tmp.unlink(missing_ok=True)
    job.note(f"完了: {len(todo)} 件のファイルから依存関係を読み取りました")


@app.post("/api/deps/rescan")
@require("editor")
def api_deps_rescan():
    _store, target = active_store()
    job = start_job("deps", "依存関係の読み取り", _rescan_deps_job, target["id"], visible_item_ids(db()),
                    user=current_user()["username"])
    return jsonify(job.public())


# ==========================================================================
# サーバー構成セット
# ==========================================================================
def set_public(conn, row):
    items = [dict(r) for r in conn.execute("SELECT item_id, version_id FROM set_items WHERE set_id=?", (row["id"],))]
    return {"id": row["id"], "name": row["name"], "description": row["description"], "items": items,
            "created_at": row["created_at"], "updated_at": row["updated_at"]}


def _set_row(sid):
    _store, target = active_store()
    row = db().execute("SELECT * FROM sets WHERE id=? AND target_id=? AND owner_id=?",
                       (sid, target["id"], current_user()["id"])).fetchone()
    if not row:
        raise ApiError("セットが見つかりません(別の保存先のセットかもしれません)", 404)
    return row


def _set_items_from(conn, target_id, data):
    vis = visible_item_ids(conn)
    out = []
    for x in data.get("items") or []:
        try:
            iid = int(x.get("item_id") if isinstance(x, dict) else x)
            vid = x.get("version_id") if isinstance(x, dict) else None
            vid = int(vid) if vid else None
        except (TypeError, ValueError):
            raise ApiError("items の指定が不正です")
        if iid not in vis or not conn.execute("SELECT 1 FROM items WHERE id=? AND target_id=?", (iid, target_id)).fetchone():
            continue
        if vid and not conn.execute("SELECT 1 FROM versions WHERE id=? AND item_id=?", (vid, iid)).fetchone():
            vid = None
        out.append((iid, vid))
    return out


@app.get("/api/sets")
def api_sets():
    _store, target = active_store()
    conn = db()
    rows = conn.execute("SELECT * FROM sets WHERE target_id=? AND owner_id=? ORDER BY name",
                        (target["id"], current_user()["id"])).fetchall()
    return jsonify(sets=[set_public(conn, r) for r in rows])


@app.post("/api/sets")
@require("editor")
def api_sets_create():
    data = request.get_json(silent=True) or {}
    _store, target = active_store()
    name = str(data.get("name") or "").strip()[:80]
    if not name:
        raise ApiError("セットの名前を入力してください")
    conn = db()
    with LOCK:
        cur = conn.execute("INSERT INTO sets (target_id, name, description, created_at, updated_at, owner_id) VALUES (?,?,?,?,?,?)",
                           (target["id"], name, str(data.get("description") or "")[:500], utcnow(), utcnow(), current_user()["id"]))
        for iid, vid in _set_items_from(conn, target["id"], data):
            conn.execute("INSERT OR REPLACE INTO set_items (set_id, item_id, version_id) VALUES (?,?,?)", (cur.lastrowid, iid, vid))
        conn.commit()
    return jsonify(set=set_public(conn, conn.execute("SELECT * FROM sets WHERE id=?", (cur.lastrowid,)).fetchone()))


@app.patch("/api/sets/<int:sid>")
@require("editor")
def api_sets_update(sid):
    row = _set_row(sid)
    data = request.get_json(silent=True) or {}
    conn = db()
    with LOCK:
        if "name" in data:
            name = str(data["name"] or "").strip()[:80]
            if not name:
                raise ApiError("セットの名前を入力してください")
            conn.execute("UPDATE sets SET name=? WHERE id=?", (name, sid))
        if "description" in data:
            conn.execute("UPDATE sets SET description=? WHERE id=?", (str(data["description"] or "")[:500], sid))
        if "items" in data:
            conn.execute("DELETE FROM set_items WHERE set_id=?", (sid,))
            for iid, vid in _set_items_from(conn, row["target_id"], data):
                conn.execute("INSERT OR REPLACE INTO set_items (set_id, item_id, version_id) VALUES (?,?,?)", (sid, iid, vid))
        conn.execute("UPDATE sets SET updated_at=? WHERE id=?", (utcnow(), sid))
        conn.commit()
    return jsonify(set=set_public(conn, conn.execute("SELECT * FROM sets WHERE id=?", (sid,)).fetchone()))


@app.delete("/api/sets/<int:sid>")
@require("editor")
def api_sets_delete(sid):
    _set_row(sid)
    conn = db()
    with LOCK:
        conn.execute("UPDATE servers SET set_id=NULL WHERE set_id=?", (sid,))
        conn.execute("DELETE FROM sets WHERE id=?", (sid,))
        conn.commit()
    return jsonify(ok=True)


def resolve_set_versions(conn, sid):
    """セットの各アイテムについて、使うバージョン(指定がなければ最新)を返す。[(item_row, version_row)]"""
    out = []
    for r in conn.execute("SELECT * FROM set_items WHERE set_id=?", (sid,)).fetchall():
        item = conn.execute("SELECT * FROM items WHERE id=?", (r["item_id"],)).fetchone()
        if not item:
            continue
        v = conn.execute("SELECT * FROM versions WHERE id=?", (r["version_id"],)).fetchone() if r["version_id"] else None
        if not v:
            vs = _item_versions(conn, item["id"])
            v = vs[0] if vs else None
        if v:
            out.append((item, v))
    return out


@app.get("/api/sets/<int:sid>/download")
def api_sets_download(sid):
    row = _set_row(sid)
    store, _target = active_store()
    conn = db()
    pairs = resolve_set_versions(conn, sid)
    if not pairs:
        raise ApiError("セットが空です")
    audit("セットをダウンロード", row["name"], f"{len(pairs)} ファイル")
    return _send_zip(store, pairs, f"{safe_name(row['name'], 'set')}.zip")


# ==========================================================================
# Pterodactyl 連携
# ==========================================================================
def ptero_client():
    url, key = get_setting("ptero_url"), decrypt_secret(get_setting("ptero_key"))
    try:
        return ptero.Ptero(url, key, verify_tls=get_setting("ptero_insecure", "0") != "1")
    except ptero.PteroError as e:
        raise ApiError(e.message)


def _pcall(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ptero.PteroError as e:
        raise ApiError(e.message, 502)


@app.post("/api/ptero/test")
@require_perm("integrations")
def api_ptero_test():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or get_setting("ptero_url") or "")
    key = str(data.get("key") or "") or decrypt_secret(get_setting("ptero_key"))
    insecure = _truthy(data["insecure"]) if "insecure" in data else get_setting("ptero_insecure", "0") == "1"
    try:
        servers = ptero.Ptero(url, key, verify_tls=not insecure).servers()
    except ptero.PteroError as e:
        return jsonify(ok=False, message=e.message)
    return jsonify(ok=True, message=f"接続できました(操作できるサーバー: {len(servers)} 台)")


@app.get("/api/ptero/servers")
@require("editor")
def api_ptero_servers():
    servers = _pcall(ptero_client().servers)
    names = {r[0]: r[1] for r in db().execute("SELECT id, username FROM users")}
    linked = {r["identifier"]: r for r in db().execute("SELECT id, identifier, owner_id FROM servers")}
    for s in servers:
        r = linked.get(s["identifier"])
        s["linked_id"] = r["id"] if r else None
        s["linked_by"] = names.get(r["owner_id"], "") if r else ""
    return jsonify(servers=servers)


# --------------------------------------------------------------------------
# サーバーのファイル(Pterodactyl / このパネルから見えるフォルダ)
# --------------------------------------------------------------------------
SERVER_CATS = ("plugin", "mod", "datapack")  # サーバーで管理する種類(表示もこの順)
SERVER_SOFTWARE = ("paper", "purpur", "folia", "spigot", "bukkit", "velocity", "bungeecord", "waterfall",
                   "fabric", "quilt", "forge", "neoforge", "sponge")
_SOFT_PROXY = {"velocity", "bungeecord", "waterfall"}
_SOFT_MOD = {"fabric", "quilt", "forge", "neoforge"}


def default_dirs(software, world="world"):
    """サーバーソフトから、種類ごとのフォルダ(サーバーのフォルダからの相対パス)を決める。"""
    world = _clean_rel_dir(world) or "world"
    if software in _SOFT_PROXY:
        return {"plugin": "plugins"}
    if software in _SOFT_MOD:
        return {"mod": "mods", "datapack": f"{world}/datapacks"}
    if software == "sponge":
        return {"plugin": "plugins", "mod": "mods", "datapack": f"{world}/datapacks"}
    return {"plugin": "plugins", "datapack": f"{world}/datapacks"}


def _clean_rel_dir(d):
    parts = [p for p in str(d or "").replace("\\", "/").split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise ApiError("フォルダの指定が不正です")
    return "/".join(parts)


def _clean_dirs(d):
    if not isinstance(d, dict):
        return {}
    out = {}
    for c in SERVER_CATS:
        v = _clean_rel_dir(d.get(c))
        if v:
            out[c] = v
    return out


def server_dirs(row):
    """{種類: フォルダ}。01.16 より前の連携は、プラグインのフォルダ 1 つだけを持つ。"""
    d = _clean_dirs(_jl(row["dirs"], {}))
    if d:
        return d
    pd = _clean_rel_dir(row["plugin_dir"]) or "plugins"
    return {"mod" if pd.rsplit("/", 1)[-1] == "mods" else "plugin": pd}


def _local_root(p):
    """このパネルから見えるサーバーのフォルダ(絶対パス)を確かめる。"""
    p = str(p or "").strip()
    if not p or not Path(p).is_absolute():
        raise ApiError("サーバーのフォルダは、/srv/minecraft や D:\\minecraft のような絶対パスで入力してください")
    path = Path(p).resolve()
    if path == Path(path.anchor):
        raise ApiError("ドライブやディスクの一番上は指定できません")
    if not path.is_dir():
        raise ApiError(f"フォルダが見つかりません: {p}(Docker の場合は、コンテナにフォルダをマウントしてください)")
    return str(path)


class _PteroFiles:
    """Pterodactyl のサーバー(Client API 経由)。"""
    kind = "ptero"

    def __init__(self, ident):
        self.p, self.ident = ptero_client(), ident

    def list(self, rel):
        try:
            return self.p.list_dir(self.ident, "/" + rel)
        except ptero.PteroError:
            return None

    def download(self, rel, dest):
        _pcall(self.p.download, self.ident, "/" + rel, dest)

    def upload(self, rel_dir, src_path, name):
        if self.list(rel_dir) is None:  # データパックのフォルダなどが無ければ作る
            parent, _sep, leaf = rel_dir.rpartition("/")
            self.p.create_folder(self.ident, "/" + parent, leaf)
        _pcall(self.p.upload, self.ident, "/" + rel_dir, src_path, name)

    def delete(self, rel_dir, names):
        _pcall(self.p.delete, self.ident, "/" + rel_dir, list(names))

    def power(self, signal):
        _pcall(self.p.power, self.ident, signal)

    def status(self):
        return self.p.resources(self.ident)

    def rename(self, rel_dir, frm, to):
        _pcall(self.p.rename, self.ident, "/" + rel_dir, frm, to)

    def read_text(self, rel, limit=256 * 1024):
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            _pcall(self.p.download, self.ident, "/" + rel, tmp, limit)
            return tmp.read_text("utf-8", "replace")
        except ApiError:
            return None
        finally:
            tmp.unlink(missing_ok=True)

    def archive(self, rel_dir, names, dest):
        """サーバー上でまとめて圧縮して取り出す。拡張子(.tar.gz など)を返す。"""
        name = _pcall(self.p.compress, self.ident, "/" + rel_dir, names)
        if not name:
            raise ApiError("サーバー上で圧縮できませんでした")
        path = f"{rel_dir}/{name}" if rel_dir else name
        try:
            _pcall(self.p.download, self.ident, "/" + path, dest, 64 * 1024 ** 3)
        finally:
            try:
                _pcall(self.p.delete, self.ident, "/" + rel_dir, [name])
            except ApiError:
                pass
        return ".tar.gz" if name.endswith(".tar.gz") else Path(name).suffix

    def restore_archive(self, rel_dir, src_path, ext):
        name = f".craftshelf-restore-{uuid.uuid4().hex[:8]}{ext}"
        self.upload(rel_dir, src_path, name)
        try:
            _pcall(self.p.decompress, self.ident, "/" + rel_dir, name)
        finally:
            try:
                _pcall(self.p.delete, self.ident, "/" + rel_dir, [name])
            except ApiError:
                pass

    def address(self):
        try:
            return self.p.address(self.ident)
        except ptero.PteroError:
            return ""


class _LocalFiles:
    """このパネルから見えるフォルダにあるサーバー(同じ PC・NAS の共有・Docker でマウントしたフォルダ)。"""
    kind = "local"

    def __init__(self, root):
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise ApiError(f"サーバーのフォルダが見つかりません: {root}")

    def _p(self, rel):
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ApiError("フォルダの指定が不正です")
        return p

    def list(self, rel):
        d = self._p(rel)
        if not d.is_dir():
            return None
        out = []
        for e in d.iterdir():
            try:
                st = e.stat()
            except OSError:
                continue
            out.append({"name": e.name, "size": st.st_size, "is_file": e.is_file(),
                        "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        return out

    def download(self, rel, dest):
        try:
            shutil.copyfile(self._p(rel), dest)
        except OSError as e:
            raise ApiError(f"サーバーのファイルを読めません: {rel}({e.strerror or e})") from e

    def upload(self, rel_dir, src_path, name):
        try:
            d = self._p(rel_dir)
            d.mkdir(parents=True, exist_ok=True)
            dst = self._p(f"{rel_dir}/{name}")
            part = d / f".{name}.craftshelf-part"
            shutil.copyfile(src_path, part)
            os.replace(part, dst)  # 書き終わってから置き換える(途中のファイルをサーバーが読まないように)
        except OSError as e:
            raise ApiError(f"サーバーのフォルダに書き込めません: {rel_dir}({e.strerror or e})") from e

    def delete(self, rel_dir, names):
        for n in names:
            p = self._p(f"{rel_dir}/{n}")
            try:
                if p.is_file():
                    p.unlink()
            except OSError as e:
                raise ApiError(f"サーバーのファイルを削除できません: {n}({e.strerror or e})") from e

    def rename(self, rel_dir, frm, to):
        try:
            os.replace(self._p(f"{rel_dir}/{frm}"), self._p(f"{rel_dir}/{to}"))
        except OSError as e:
            raise ApiError(f"名前を変更できません: {frm}({e.strerror or e})") from e

    def read_text(self, rel, limit=256 * 1024):
        try:
            with open(self._p(rel), "rb") as f:
                return f.read(limit).decode("utf-8", "replace")
        except OSError:
            return None

    def archive(self, rel_dir, names, dest):
        """フォルダをまとめて zip にする(ワールド・プラグインの設定フォルダ)。"""
        base = self._p(rel_dir)
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            for n in names:
                top = self._p(f"{rel_dir}/{n}" if rel_dir else n)
                if top.is_file():
                    z.write(top, n)
                    continue
                for f in sorted(top.rglob("*")):
                    if f.is_file() and f.name != "session.lock":
                        try:
                            z.write(f, f.relative_to(base).as_posix())
                        except OSError:
                            pass  # 書き込み中などで読めないファイルは飛ばす
        return ".zip"

    def restore_archive(self, rel_dir, src_path, ext):
        base = self._p(rel_dir)
        with zipfile.ZipFile(src_path) as z:
            for m in z.infolist():
                dst = (base / m.filename).resolve()
                if base != dst and base not in dst.parents:
                    raise ApiError("退避したファイルの中身が不正です")
                if m.is_dir():
                    dst.mkdir(parents=True, exist_ok=True)
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                with z.open(m) as fi, open(dst, "wb") as fo:
                    shutil.copyfileobj(fi, fo)

    def address(self):
        return ""

    def power(self, signal):
        raise ApiError("このサーバーは、起動・停止の方法が設定されていません(「設定」→「起動・停止」)")

    def status(self):
        return {"state": "local"}


def server_fs(row):
    return _LocalFiles(row["root_dir"]) if row["kind"] == "local" else _PteroFiles(row["identifier"])


# --------------------------------------------------------------------------
# サーバーの状態・起動停止(Pterodactyl / コマンド / Docker)・RCON
# --------------------------------------------------------------------------
def _rcon(row):
    """RCON の設定があれば、接続済みの mcnet.Rcon を返す(with で使う)。"""
    if not row["rcon_port"] or not row["rcon_password"]:
        return None
    host = mcnet.parse_address(_server_address(row) or "127.0.0.1")[0]
    return mcnet.Rcon(host, row["rcon_port"], decrypt_secret(row["rcon_password"]))


def _server_address(row):
    if row["address"]:
        return row["address"]
    if row["kind"] == "ptero":
        info = _jl(row["soft_info"], {})
        if info.get("address"):
            return info["address"]
        addr = server_fs(row).address()
        if addr:
            info["address"] = addr
            with LOCK:
                db().execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(info), row["id"]))
                db().commit()
        return addr
    if row["kind"] == "local":  # 同じ PC なら server.properties のポートで問い合わせる
        props = _server_props(server_fs(row))
        return f"127.0.0.1:{props.get('server-port') or 25565}"
    return ""


def _server_props(fs):
    out = {}
    for line in (fs.read_text("server.properties") or "").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _wait_offline(row, seconds=90):
    """止まるまで待つ(人数の問い合わせに答えなくなるまで)。"""
    try:
        host, port = mcnet.parse_address(_server_address(row))
    except mcnet.NetError:
        time.sleep(5)
        return
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            mcnet.ping(host, port, timeout=2)
        except mcnet.NetError:
            return
        time.sleep(2)


def _run_cmd(row, cmd, wait):
    import subprocess
    kw = {"cwd": row["root_dir"] or None, "shell": True, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
          "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    p = subprocess.Popen(cmd, **kw)  # noqa: S602(管理者が設定したコマンドだけを実行する)
    if wait:
        try:
            p.wait(timeout=180)
        except subprocess.TimeoutExpired:
            pass


def server_power(row, signal):
    """起動・停止・再起動。Pterodactyl / Docker / 設定したコマンド(停止は RCON の stop でも可)。"""
    if signal not in ("start", "stop", "restart", "kill"):
        raise ApiError("不正な操作です")
    if row["kind"] == "ptero":
        return server_fs(row).power(signal)
    try:
        if row["control"] == "docker" and row["container"]:
            return mcnet.docker_power(row["container"], signal)
        if row["control"] == "command":
            def stop():
                rc = _rcon(row)
                if row["stop_cmd"]:
                    _run_cmd(row, row["stop_cmd"], wait=True)
                elif rc:
                    with rc as r:
                        r.command("stop")
                else:
                    raise ApiError("停止のコマンドか RCON を設定してください")
                _wait_offline(row)

            def start():
                if not row["start_cmd"]:
                    raise ApiError("起動のコマンドを設定してください")
                _run_cmd(row, row["start_cmd"], wait=False)
            if signal in ("stop", "kill"):
                return stop()
            if signal == "start":
                return start()
            stop()
            return start()
    except mcnet.NetError as e:
        raise ApiError(e.message) from e
    return server_fs(row).power(signal)


def server_live(row):
    """今の状態: 稼働状況・人数・バージョン・応答速度(Pterodactyl なら CPU・メモリも)。"""
    out = {"state": "unknown", "controls": row["kind"] == "ptero" or (row["control"] in ("command", "docker"))}
    try:
        if row["kind"] == "ptero":
            out.update(server_fs(row).status())
        elif row["control"] == "docker" and row["container"]:
            out["state"] = mcnet.docker_state(row["container"])
    except (ptero.PteroError, ApiError, mcnet.NetError) as e:
        out["error"] = getattr(e, "message", str(e))
    addr = ""
    try:
        addr = _server_address(row)
    except ApiError:
        pass
    out["address"] = addr
    if addr:
        try:
            p = mcnet.ping(*mcnet.parse_address(addr), timeout=3)
            out.update(ping=p)
            if out["state"] in ("unknown", "local"):
                out["state"] = "running"
            mc = mcnet.mc_from_version_name(p.get("version"))
            if mc and not row["mc_version"]:
                out["mc_detected"] = mc
        except mcnet.NetError as e:
            out["ping_error"] = e.message
            if out["state"] in ("unknown", "local") and row["kind"] == "local":
                out["state"] = "offline"
    if out["state"] == "unknown" and row["kind"] == "local" and not addr:
        out["state"] = "local"
    return out


# --------------------------------------------------------------------------
# 対応MCバージョンの照らし合わせ
# --------------------------------------------------------------------------
def _ver_nums(v):
    m = re.search(r"\d+(?:\.\d+)*", str(v or ""))
    return [int(x) for x in m.group(0).split(".")] if m else []


def _cmp_nums(a, b):
    for i in range(max(len(a), len(b))):
        d = (a[i] if i < len(a) else 0) - (b[i] if i < len(b) else 0)
        if d:
            return d
    return 0


def mc_supports(text, line):
    """「1.20 以降」「1.20.1〜1.21.4」「1.20.1, 1.20.2」「[1.20.1,1.21)」などが、系列(例 1.21)で使えるか。不明は None。"""
    if not text or not line:
        return None
    L = _ver_nums(line)[:2]
    if len(L) < 2:
        return None
    lend = [L[0], L[1] + 1]
    t = re.sub(r"\s", "", str(text))
    m = re.fullmatch(r"([\d.]+)以降", t) or re.fullmatch(r">=?([\d.]+)", t) or re.fullmatch(r"\[([\d.]+),\)", t)
    if m:
        return _cmp_nums(_ver_nums(m.group(1)), lend) < 0
    m = re.fullmatch(r"([\d.]+)[〜~\-–]([\d.]+)", t) or re.fullmatch(r"\[([\d.]+),([\d.]+)[)\]]", t)
    if m:
        return _cmp_nums(_ver_nums(m.group(1)), lend) < 0 and _cmp_nums(_ver_nums(m.group(2)), L) >= 0
    parts = [p for p in re.split(r"[,、]", t) if p]
    if parts and all(re.fullmatch(r"[\d.]+", p) for p in parts):
        return any(_ver_nums(p)[:2] == L for p in parts)
    return None


def _version_mc(conn, item, v):
    if item["mc_versions"]:
        return item["mc_versions"]
    src_row = conn.execute("SELECT * FROM item_sources WHERE item_id=?", (item["id"],)).fetchone()
    return auto_mc_versions(_jl(v["meta"], {}), item["category"], source_public(src_row) if src_row else None)


def _compat(conn, row, item, v):
    """このバージョンがサーバーの MC で使えるか(True / False / 不明 None)。プロキシは見ない。"""
    if not row["mc_version"] or row["software"] in _SOFT_PROXY or not v:
        return None
    return mc_supports(_version_mc(conn, item, v), row["mc_version"])


def _holds(conn, srv_id):
    return {r[0] for r in conn.execute("SELECT item_id FROM server_holds WHERE server_id=?", (srv_id,))}


def _detect_build(fs, root_names=None):
    """サーバー本体のバージョンとビルド(Paper 系は version_history.json、それ以外は jar の名前から)。"""
    mc = build = ""
    vh = fs.read_text("version_history.json", 64 * 1024)
    if vh:
        try:
            mc, build = mcnet.parse_build(json.loads(vh).get("currentVersion"))
        except ValueError:
            pass
    if not build:
        for n in sorted(root_names if root_names is not None else [e["name"] for e in (fs.list("") or [])]):
            m = re.match(r"fabric-server-mc\.([\d.]+)-loader\.([\d.]+)", n)
            if m:
                return m.group(1), m.group(2)
            if n.lower().endswith(".jar"):
                m2, b2 = mcnet.parse_build(n)
                if b2:
                    mc, build = mc or m2, b2
                    break
    return mc, build


def detect_server(fs):
    """サーバーのフォルダの中身から、サーバーソフト・ワールドの名前・種類ごとのフォルダを推測する。"""
    root = fs.list("") or []
    names = {e["name"].lower() for e in root}
    jars = " ".join(n for n in names if n.endswith(".jar"))

    def sub(rel):
        return {e["name"].lower() for e in (fs.list(rel) or [])}

    soft = ""
    if "velocity.toml" in names or "velocity" in jars:
        soft = "velocity"
    elif "waterfall.yml" in names or "waterfall" in jars:
        soft = "waterfall"
    elif "bungeecord" in jars or "modules.yml" in names:
        soft = "bungeecord"
    elif "purpur.yml" in names or "purpur" in jars:
        soft = "purpur"
    elif "folia" in jars:
        soft = "folia"
    elif "paper.yml" in names or "paper" in jars or ("config" in names and "paper-global.yml" in sub("config")):
        soft = "paper"
    elif "spigot.yml" in names or "spigot" in jars:
        soft = "spigot"
    elif "bukkit.yml" in names:
        soft = "bukkit"
    elif "quilt-server-launch.jar" in names or ".quilt" in names or "quilt" in jars:
        soft = "quilt"
    elif ".fabric" in names or "fabric" in jars:
        soft = "fabric"
    elif "libraries" in names:
        net = sub("libraries/net")
        soft = "neoforge" if "neoforged" in net else "forge" if "minecraftforge" in net else ""
    world = "world"
    if "server.properties" in names:
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            fs.download("server.properties", tmp)
            for line in tmp.read_text("utf-8", "replace").splitlines():
                if line.strip().startswith("level-name="):
                    world = line.split("=", 1)[1].strip() or "world"
        except (ApiError, OSError):
            pass
        finally:
            tmp.unlink(missing_ok=True)
    try:
        world = _clean_rel_dir(world) or "world"
    except ApiError:
        world = "world"
    if soft:
        dirs = default_dirs(soft, world)
    else:  # 判定できないときは、実際にあるフォルダを使う
        dirs = {c: d for c, d in (("plugin", "plugins"), ("mod", "mods")) if d in names} or {"plugin": "plugins"}
        if world.lower() in names:
            dirs["datapack"] = f"{world}/datapacks"
    mc, build = _detect_build(fs, [e["name"] for e in root])
    if soft in _SOFT_PROXY:
        mc = ""
    return {"software": soft, "world": world, "dirs": dirs, "is_server": bool(soft or "server.properties" in names),
            "mc": mc, "build": build}


def _cached_states(conn, servers):
    """最後に確認したときの中身(キャッシュ)から、サーバーごとに [(ファイル, 種類, アイテムID, 状態)] を作る。"""
    _store, target = active_store()
    by_sha = {v["sha256"]: v for v in conn.execute("SELECT * FROM versions WHERE target_id=?", (target["id"],))}
    vis = visible_item_ids(conn)
    items = {r["id"]: r for r in conn.execute("SELECT * FROM items WHERE target_id=?", (target["id"],)) if r["id"] in vis}
    by_key = {}
    for it in items.values():
        by_key.setdefault((it["category"], norm_key(it["name"])), it["id"])
    latest = {iid: (_item_versions(conn, iid) or [None])[0] for iid in items}
    out = {}
    for srv in servers:
        rev = {d: c for c, d in server_dirs(srv).items()}
        lst = []
        for f in conn.execute("SELECT * FROM server_files WHERE server_id=?", (srv["id"],)):
            cat = rev.get(f["name"].rpartition("/")[0])
            if cat is None:
                continue
            v = by_sha.get(f["sha256"])
            iid = v["item_id"] if v else by_key.get((cat, norm_key(f["plugin_name"])))
            status = None
            if iid in items:
                lv = latest.get(iid)
                same = (v and lv and v["id"] == lv["id"]) or (lv and src.same_version(lv["version"], f["version"]))
                status = "latest" if same else "outdated"
            else:
                iid = None
            lst.append((f, cat, iid, status))
        out[srv["id"]] = lst
    return out, items


def visible_servers(conn, user=None):
    u = user or current_user()
    if not u:
        return []
    shared = {r[0]: r[1] for r in conn.execute("SELECT server_id, level FROM server_acl WHERE user_id=?", (u["id"],))}
    return [r for r in conn.execute("SELECT * FROM servers ORDER BY name").fetchall()
            if r["owner_id"] == u["id"] or r["id"] in shared]


def server_public(conn, r, summary=None):
    d = dict(r)
    d["has_rcon"] = bool(r["rcon_port"] and r["rcon_password"])
    d.pop("rcon_password", None)
    d["stage_targets"] = _jl(r["stage_targets"], [])
    d["soft_info"] = _jl(r["soft_info"], {})
    d["holds"] = len(_holds(conn, r["id"]))
    d["staged_from"] = [x["id"] for x in conn.execute("SELECT id, stage_targets FROM servers")
                        if r["id"] in _jl(x["stage_targets"], [])]
    if r["set_id"]:
        s = conn.execute("SELECT name FROM sets WHERE id=?", (r["set_id"],)).fetchone()
        d["set_name"] = s["name"] if s else ""
    d["dirs"] = server_dirs(r)
    if summary is not None:
        cats = {c: {"files": 0, "outdated": 0} for c in d["dirs"]}
        for _f, cat, _iid, status in summary:
            cats[cat]["files"] += 1
            cats[cat]["outdated"] += status == "outdated"
        d["summary"] = cats
        d["checked"] = bool(summary)
    u = current_user() if has_request_context() else None
    if u:
        names = {x[0]: x[1] for x in conn.execute("SELECT id, username FROM users")}
        mine = r["owner_id"] == u["id"]
        lv = conn.execute("SELECT level FROM server_acl WHERE server_id=? AND user_id=?", (r["id"], u["id"])).fetchone()
        d["access"] = "owner" if mine else (lv[0] if lv else "view")
        d["owner_name"] = names.get(r["owner_id"], "")
        d["shared_with"] = [{"user_id": x[0], "username": names.get(x[0], "?"), "level": x[1]} for x in
                            conn.execute("SELECT user_id, level FROM server_acl WHERE server_id=?", (r["id"],))] if mine else []
    return d


@app.get("/api/servers")
def api_servers():
    conn = db()
    rows = visible_servers(conn)
    try:
        states, _items = _cached_states(conn, rows)
    except ApiError:  # 保存先につながっていないときは件数なし
        states = {}
    return jsonify(servers=[server_public(conn, r, states.get(r["id"], [])) for r in rows],
                   configured=bool(get_setting("ptero_url") and get_setting("ptero_key")),
                   local_ok=has_perm("system"), software=list(SERVER_SOFTWARE), docker=mcnet.docker_available())


def _clean_dir(d):
    d = "/" + str(d or "/plugins").strip().strip("/")
    if ".." in d.split("/"):
        raise ApiError("フォルダの指定が不正です")
    return d


@app.post("/api/servers")
@require("editor")
def api_servers_create():
    data = request.get_json(silent=True) or {}
    conn = db()
    kind = "local" if data.get("kind") == "local" else "ptero"
    if kind == "local":
        if not has_perm("system"):
            raise ApiError("フォルダでつなぐサーバーは、「パネル全体の設定」の権限がある人だけが追加できます", 403)
        root = _local_root(data.get("root_dir"))
        if conn.execute("SELECT 1 FROM servers WHERE kind='local' AND root_dir=?", (root,)).fetchone():
            raise ApiError("このフォルダのサーバーはすでに追加されています")
        ident = "local-" + uuid.uuid4().hex[:16]
    else:
        root = ""
        ident = str(data.get("identifier") or "").strip()
        if not ident:
            raise ApiError("サーバーを選んでください")
        ex = conn.execute("SELECT owner_id FROM servers WHERE identifier=?", (ident,)).fetchone()
        if ex:
            who = conn.execute("SELECT username FROM users WHERE id=?", (ex[0],)).fetchone()
            raise ApiError(f"このサーバーはすでに「{who[0] if who else '?'}」さんが連携しています(使いたい場合は共有してもらってください)")
    software = data.get("software") if data.get("software") in SERVER_SOFTWARE else ""
    dirs = _clean_dirs(data.get("dirs"))
    if not dirs and data.get("plugin_dir"):
        dirs = {"plugin": _clean_rel_dir(data["plugin_dir"])}
    dirs = dirs or default_dirs(software)
    set_id = int(data["set_id"]) if data.get("set_id") else None
    if set_id and not conn.execute("SELECT 1 FROM sets WHERE id=? AND owner_id=?", (set_id, current_user()["id"])).fetchone():
        set_id = None
    name = str(data.get("name") or "").strip()[:80] or (Path(root).name if root else ident)
    mc = str(data.get("mc_version") or "").strip()
    mc = mc if re.fullmatch(r"\d+\.\d+(\.\d+)?", mc) and software not in _SOFT_PROXY else ""
    with LOCK:
        conn.execute("INSERT INTO servers (identifier, name, plugin_dir, set_id, created_at, owner_id, kind, root_dir, software, dirs, mc_version) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (ident, name, "/" + (dirs.get("plugin") or dirs.get("mod") or "plugins"), set_id, utcnow(),
                      current_user()["id"], kind, root, software, json.dumps(dirs), mc))
        conn.commit()
    audit("サーバーを追加", name, "フォルダ" if kind == "local" else "Pterodactyl")
    return jsonify(ok=True)


@app.post("/api/servers/detect")
@require("editor")
def api_servers_detect():
    """サーバーのフォルダを見て、サーバーソフトと種類ごとのフォルダを推測する。"""
    data = request.get_json(silent=True) or {}
    if data.get("server_id"):
        fs = server_fs(_server_row(int(data["server_id"]), "edit"))
    elif data.get("kind") == "local":
        if not has_perm("system"):
            raise ApiError("フォルダでつなぐサーバーは、「パネル全体の設定」の権限がある人だけが扱えます", 403)
        fs = _LocalFiles(_local_root(data.get("root_dir")))
    else:
        fs = _PteroFiles(str(data.get("identifier") or ""))
    return jsonify(detect_server(fs))


def _server_row(srv, need="view"):
    """サーバーを取り出し、この利用者に必要な権限(view / edit / owner)があるか確かめる。"""
    r = db().execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    if not r:
        raise ApiError("サーバーが見つかりません", 404)
    if has_request_context() and current_user():
        return get_server_checked(srv, need)
    return r


@app.patch("/api/servers/<int:srv>")
@require("editor")
def api_servers_update(srv):
    _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    conn = db()
    with LOCK:
        if "name" in data:
            conn.execute("UPDATE servers SET name=? WHERE id=?", (str(data["name"] or "")[:80] or "server", srv))
        if "plugin_dir" in data and "dirs" not in data:
            conn.execute("UPDATE servers SET plugin_dir=?, dirs=? WHERE id=?",
                         (_clean_dir(data["plugin_dir"]), json.dumps({"plugin": _clean_rel_dir(data["plugin_dir"])}), srv))
            conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        if "software" in data:
            conn.execute("UPDATE servers SET software=? WHERE id=?",
                         (data["software"] if data["software"] in SERVER_SOFTWARE else "", srv))
        if "dirs" in data:
            dirs = _clean_dirs(data["dirs"])
            if not dirs:
                raise ApiError("管理するフォルダを 1 つ以上入力してください")
            conn.execute("UPDATE servers SET dirs=?, plugin_dir=? WHERE id=?",
                         (json.dumps(dirs), "/" + (dirs.get("plugin") or dirs.get("mod") or next(iter(dirs.values()))), srv))
            conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        for k, n in (("address", 120), ("mc_version", 20)):
            if k in data:
                v = str(data[k] or "").strip()[:n]
                if k == "address" and v:
                    try:
                        mcnet.parse_address(v)
                    except mcnet.NetError as e:
                        raise ApiError(e.message) from e
                if k == "mc_version" and v and not re.fullmatch(r"\d+\.\d+(\.\d+)?", v):
                    raise ApiError("MC のバージョンは 1.21.4 のように入力してください")
                conn.execute(f"UPDATE servers SET {k}=? WHERE id=?", (v, srv))
        if "rcon_port" in data:
            conn.execute("UPDATE servers SET rcon_port=? WHERE id=?", (max(0, min(65535, int(data["rcon_port"] or 0))), srv))
        if data.get("rcon_password"):
            conn.execute("UPDATE servers SET rcon_password=? WHERE id=?", (encrypt_secret(str(data["rcon_password"])[:200]), srv))
        if data.get("rcon_clear"):
            conn.execute("UPDATE servers SET rcon_password='', rcon_port=0 WHERE id=?", (srv,))
        if "auto_update" in data:
            if data["auto_update"] not in ("off", "auto"):
                raise ApiError("自動更新の指定が不正です")
            conn.execute("UPDATE servers SET auto_update=? WHERE id=?", (data["auto_update"], srv))
        if "backup_config" in data:
            conn.execute("UPDATE servers SET backup_config=? WHERE id=?", (1 if _truthy(data["backup_config"]) else 0, srv))
        if "world_mode" in data:
            if data["world_mode"] not in ("off", "daily", "weekly"):
                raise ApiError("ワールドのバックアップの指定が不正です")
            conn.execute("UPDATE servers SET world_mode=? WHERE id=?", (data["world_mode"], srv))
        if "world_time" in data:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(data["world_time"])):
                raise ApiError("時刻は 05:00 のように入力してください")
            conn.execute("UPDATE servers SET world_time=? WHERE id=?", (data["world_time"], srv))
        if "world_dow" in data:
            conn.execute("UPDATE servers SET world_dow=? WHERE id=?", (max(0, min(6, int(data["world_dow"]))), srv))
        if "world_keep" in data:
            conn.execute("UPDATE servers SET world_keep=? WHERE id=?", (max(1, min(50, int(data["world_keep"] or 5))), srv))
        if "stage_targets" in data:
            ids = []
            for x in data["stage_targets"] or []:
                x = int(x)
                if x != srv:
                    get_server_checked(x, "edit")  # 反映先も操作できるサーバーだけ
                    ids.append(x)
            conn.execute("UPDATE servers SET stage_targets=? WHERE id=?", (json.dumps(sorted(set(ids))), srv))
        if any(k in data for k in ("control", "start_cmd", "stop_cmd", "container")):
            row = conn.execute("SELECT kind FROM servers WHERE id=?", (srv,)).fetchone()
            if row["kind"] != "local":
                raise ApiError("起動・停止の方法は、フォルダのサーバーだけで設定できます")
            if not has_perm("system"):
                raise ApiError("起動・停止の方法は、「パネル全体の設定」の権限がある人だけが設定できます", 403)
            if "control" in data:
                if data["control"] not in ("none", "command", "docker"):
                    raise ApiError("起動・停止の方法の指定が不正です")
                conn.execute("UPDATE servers SET control=? WHERE id=?", (data["control"], srv))
            for k in ("start_cmd", "stop_cmd"):
                if k in data:
                    conn.execute(f"UPDATE servers SET {k}=? WHERE id=?", (str(data[k] or "").strip()[:500], srv))
            if "container" in data:
                c = str(data["container"] or "").strip()
                if c and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", c):
                    raise ApiError("コンテナ名が正しくありません")
                conn.execute("UPDATE servers SET container=? WHERE id=?", (c, srv))
        if "root_dir" in data:
            row = conn.execute("SELECT kind FROM servers WHERE id=?", (srv,)).fetchone()
            if row["kind"] == "local":
                if not has_perm("system"):
                    raise ApiError("サーバーのフォルダは、「パネル全体の設定」の権限がある人だけが変更できます", 403)
                conn.execute("UPDATE servers SET root_dir=? WHERE id=?", (_local_root(data["root_dir"]), srv))
                conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        if "set_id" in data:
            sid = int(data["set_id"]) if data["set_id"] else None
            if sid and not conn.execute("SELECT 1 FROM sets WHERE id=? AND owner_id=?", (sid, current_user()["id"])).fetchone():
                raise ApiError("自分のセットを選んでください")
            conn.execute("UPDATE servers SET set_id=? WHERE id=?", (sid, srv))
        if "sched_mode" in data:
            if data["sched_mode"] not in ("off", "daily", "weekly"):
                raise ApiError("予約の指定が不正です")
            conn.execute("UPDATE servers SET sched_mode=? WHERE id=?", (data["sched_mode"], srv))
        if "sched_time" in data:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(data["sched_time"])):
                raise ApiError("時刻は 04:00 のように入力してください")
            conn.execute("UPDATE servers SET sched_time=? WHERE id=?", (data["sched_time"], srv))
        if "sched_dow" in data:
            conn.execute("UPDATE servers SET sched_dow=? WHERE id=?", (max(0, min(6, int(data["sched_dow"]))), srv))
        if "sched_restart" in data:
            conn.execute("UPDATE servers SET sched_restart=? WHERE id=?", (1 if _truthy(data["sched_restart"]) else 0, srv))
        conn.commit()
    return jsonify(ok=True)


@app.delete("/api/servers/<int:srv>")
@require("editor")
def api_servers_delete(srv):
    _server_row(srv, "owner")
    conn = db()
    with LOCK:
        conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM server_acl WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM server_holds WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM servers WHERE id=?", (srv,))
        conn.commit()
    return jsonify(ok=True)


def server_inventory(conn, srv_row, target, note=lambda m: None, fs=None):
    """サーバーの各フォルダ(プラグイン・Mod・データパック)の中身を、ライブラリと照らし合わせる。

    戻り値は (ファイルの一覧, セットにあってサーバーに無いもの, 見つからなかったフォルダの種類)。
    """
    fs = fs or server_fs(srv_row)
    dirs = server_dirs(srv_row)
    files, absent = [], []
    for cat, d in dirs.items():
        lst = fs.list(d)
        if lst is None:
            absent.append(cat)
            continue
        for f in lst:
            low = f["name"].lower()
            if f["is_file"] and low.endswith((".jar", ".zip", ".jar.disabled", ".zip.disabled")) and not f["name"].startswith("."):
                files.append({**f, "category": cat, "dir": d, "path": f"{d}/{f['name']}", "disabled": low.endswith(".disabled")})
    cache = {r["name"]: r for r in conn.execute("SELECT * FROM server_files WHERE server_id=?", (srv_row["id"],))}
    # 照らし合わせるのは、サーバーの持ち主のライブラリ(自分のもの + 共有されたもの)だけ。
    # ほかの人の非公開のアドオンが、同期でこのサーバーに入ってしまわないように
    vis = visible_item_ids(conn, {"id": srv_row["owner_id"]})
    by_sha = {}
    for v in conn.execute("SELECT * FROM versions WHERE target_id=?", (target["id"],)):
        if v["item_id"] in vis:
            by_sha.setdefault(v["sha256"], v)
    items = {r["id"]: r for r in conn.execute("SELECT * FROM items WHERE target_id=?", (target["id"],)) if r["id"] in vis}
    by_key = {}
    for it in items.values():
        by_key.setdefault((it["category"], norm_key(it["name"])), it)
    holds = _holds(conn, srv_row["id"])
    out = []
    for f in files:
        c = cache.get(f["path"])
        if c and c["size"] == f["size"] and c["modified"] == f["modified"] and c["sha256"]:
            sha, pname, pver = c["sha256"], c["plugin_name"], c["version"]
        else:
            note(f"サーバーのファイルを確認しています: {f['path']}")
            tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
            try:
                fs.download(f["path"], tmp)
                sha = sha256_file(tmp)
                info = analyze(tmp, f["name"][:-9] if f["disabled"] else f["name"])
                pname, pver = info["name"], info["version"]
            finally:
                tmp.unlink(missing_ok=True)
            with LOCK:
                conn.execute("INSERT OR REPLACE INTO server_files (server_id, name, size, modified, sha256, plugin_name, version) "
                             "VALUES (?,?,?,?,?,?,?)", (srv_row["id"], f["path"], f["size"], f["modified"], sha, pname, pver))
                conn.commit()
        entry = {"name": f["name"], "path": f["path"], "dir": f["dir"], "category": f["category"], "size": f["size"],
                 "disabled": f["disabled"], "held": False, "compat": None, "compat_now": None,
                 "modified": f["modified"], "plugin_name": pname, "version": pver, "status": "unregistered",
                 "item_id": None, "item_name": None, "latest_version": None, "latest_version_id": None}
        v = by_sha.get(sha)
        item = items.get(v["item_id"]) if v else by_key.get((f["category"], norm_key(pname)))
        if item:
            vs = _item_versions(conn, item["id"])
            entry.update(item_id=item["id"], item_name=item["name"],
                         latest_version=vs[0]["version"] if vs else None, latest_version_id=vs[0]["id"] if vs else None)
            if v and vs and v["id"] == vs[0]["id"]:
                entry["status"] = "latest"
            elif v:
                entry["status"] = "outdated"
            elif vs and src.same_version(vs[0]["version"], pver):
                entry["status"] = "latest"  # 中身のハッシュは違うが、ライブラリの最新と同じバージョン
            else:
                newer = vs and version_key(vs[0]["version"]) > version_key(pver or "")
                entry["status"] = "outdated" if newer else "different"
            entry["version_id"] = v["id"] if v else None
            entry["held"] = item["id"] in holds
            if vs:
                entry["compat"] = _compat(conn, srv_row, item, vs[0])
                entry["compat_mc"] = _version_mc(conn, item, vs[0])
            if f["disabled"]:
                entry["status"] = "disabled"
        elif f["disabled"]:
            entry["status"] = "disabled"
        out.append(entry)
    with LOCK:
        paths = [f["path"] for f in files]
        conn.execute(f"DELETE FROM server_files WHERE server_id=? AND name NOT IN ({','.join('?' * len(paths)) or 'NULL'})",
                     [srv_row["id"]] + paths)
        conn.commit()
    missing = []
    if srv_row["set_id"]:
        present = {e["item_id"] for e in out if e["item_id"]}
        for item, ver in resolve_set_versions(conn, srv_row["set_id"]):
            if item["id"] not in present:
                missing.append({"item_id": item["id"], "item_name": item["name"], "version": ver["version"],
                                "version_id": ver["id"], "category": item["category"], "no_dir": item["category"] not in dirs,
                                "compat": _compat(conn, srv_row, item, ver), "held": item["id"] in holds})
    return out, missing, absent


@app.get("/api/servers/presence")
def api_servers_presence():
    """各アイテムがどのサーバーに入っているか(最後に確認したときの内容から)。"""
    conn = db()
    servers = visible_servers(conn)
    states, items = _cached_states(conn, servers)
    out, listed = {}, []
    for srv in servers:
        rows = states.get(srv["id"], [])
        listed.append({"id": srv["id"], "name": srv["name"], "checked": bool(rows)})
        present = set()
        for f, _cat, iid, status in rows:
            if not iid:
                continue
            present.add(iid)
            out.setdefault(iid, []).append({"server_id": srv["id"], "server": srv["name"], "status": status, "version": f["version"]})
        if srv["set_id"] and rows:
            for r in conn.execute("SELECT item_id FROM set_items WHERE set_id=?", (srv["set_id"],)):
                if r[0] in items and r[0] not in present:
                    out.setdefault(r[0], []).append({"server_id": srv["id"], "server": srv["name"], "status": "missing", "version": ""})
    return jsonify(items=out, servers=listed)


@app.get("/api/servers/<int:srv>/inventory")
@require("editor")
def api_servers_inventory(srv):
    row = _server_row(srv, "view")
    _store, target = active_store()
    files, missing, absent = server_inventory(db(), row, target)
    return jsonify(files=files, missing=missing, absent=absent, dirs=server_dirs(row), kind=row["kind"],
                   plugin_dir=row["plugin_dir"], mc_version=row["mc_version"])


def _push_versions(job, conn, srv_row, store, pairs, inventory, title="", fs=None, remove=()):
    """(item, version) をサーバーの種類ごとのフォルダへ送り、同じアイテムの別のバージョンがあれば消す。

    置き換え・削除するファイルは先に取り出して退避し、あとで巻き戻せるようにする。
    """
    fs = fs or server_fs(srv_row)
    dirs = server_dirs(srv_row)
    on_server = {e["path"] for e in inventory}
    snap = {"id": None, "removed": [], "added": []}

    def open_snap():
        if snap["id"] is None:
            with LOCK:
                cur = conn.execute("INSERT INTO server_snapshots (server_id, created_at, title) VALUES (?,?,?)",
                                   (srv_row["id"], utcnow(), title))
                conn.commit()
            snap["id"] = cur.lastrowid
            (SNAP_DIR / str(snap["id"])).mkdir(parents=True, exist_ok=True)

    def keep(path):
        open_snap()
        if any(r["name"] == path for r in snap["removed"]):
            return
        stored = f"{len(snap['removed'])}-{safe_name(path.rsplit('/', 1)[-1], 'file', 150)}"
        fs.download(path, SNAP_DIR / str(snap["id"]) / stored)
        snap["removed"].append({"name": path, "stored": stored})

    plugin_dirs = None

    def keep_config(entry):
        """プラグインの設定フォルダ(plugins/<名前>/)も退避しておく。巻き戻しで設定まで戻せるように。"""
        nonlocal plugin_dirs
        if not srv_row["backup_config"] or entry["category"] != "plugin":
            return
        if plugin_dirs is None:
            plugin_dirs = {e["name"].lower(): e["name"] for e in (fs.list(entry["dir"]) or []) if not e["is_file"]}
        folder = plugin_dirs.get(str(entry.get("plugin_name") or "").lower())
        rel = f"{entry['dir']}/{folder}/" if folder else ""
        if not folder or any(r["name"] == rel for r in snap["removed"]):
            return
        open_snap()
        stored = f"{len(snap['removed'])}-cfg-{safe_name(folder, 'config', 120)}"
        try:
            ext = fs.archive(entry["dir"], [folder], SNAP_DIR / str(snap["id"]) / (stored + ".part"))
            os.replace(SNAP_DIR / str(snap["id"]) / (stored + ".part"), SNAP_DIR / str(snap["id"]) / (stored + ext))
            snap["removed"].append({"name": rel, "stored": stored + ext, "dir": True, "ext": ext})
            job.note(f"設定フォルダを退避しました: {rel}")
        except ApiError as e:
            job.note(f"設定フォルダを退避できませんでした({folder}): {e.message}")

    sent = 0
    for item, v in pairs:
        job.done += 1
        d = dirs.get(item["category"])
        if not d:
            job.note(f"送れません({CATEGORIES.get(item['category'], ('', item['category']))[1]}のフォルダが設定されていません): {item['name']}")
            continue
        old = [e for e in inventory if e["item_id"] == item["id"]]
        if any(e.get("version_id") == v["id"] for e in old):
            job.note(f"送信不要(同じファイルがあります): {item['name']} {v['version']}")
            continue
        dest = f"{d}/{v['filename']}"
        for e in old:
            keep(e["path"])
            keep_config(e)
        if dest in on_server:
            keep(dest)  # 同じ名前のファイルを上書きする場合も退避
        open_snap()
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            store.fetch(lib_rel(v["relpath"]), tmp)
            fs.upload(d, tmp, v["filename"])
        finally:
            tmp.unlink(missing_ok=True)
        snap["added"].append(dest)
        stale = [e for e in old if e["path"] != dest]
        for sd in {e["dir"] for e in stale}:
            fs.delete(sd, [e["name"] for e in stale if e["dir"] == sd])
        sent += 1
        job.note(f"送信しました: {item['name']} {v['version']}" + (f"(古いファイルを削除: {', '.join(e['name'] for e in stale)})" if stale else ""))
    for e in remove:  # コピー(そろえる)で、元のサーバーに無いものを取り除く
        keep(e["path"])
        keep_config(e)
        fs.delete(e["dir"], [e["name"]])
        sent += 1
        job.note(f"取り除きました: {e.get('item_name') or e['name']}")
    with LOCK:
        if snap["id"] is not None:
            conn.execute("UPDATE server_snapshots SET removed=?, added=? WHERE id=?",
                         (json.dumps(snap["removed"], ensure_ascii=False), json.dumps(snap["added"], ensure_ascii=False), snap["id"]))
        conn.execute("DELETE FROM server_files WHERE server_id=?", (srv_row["id"],))
        conn.execute("UPDATE servers SET last_sync=? WHERE id=?", (utcnow(), srv_row["id"]))
        conn.commit()
    if snap["id"] is not None:
        prune_snapshots(conn, srv_row["id"])
    return sent


def _server_job(job, srv, target_id, mode, item_ids, version_ids, restart, user, force=False):
    conn = db()
    srv_row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    fs = server_fs(srv_row)
    job.note(f"「{srv_row['name']}」の {', '.join(server_dirs(srv_row).values())} を確認しています…")
    inventory, missing, absent = server_inventory(conn, srv_row, target, note=job.note, fs=fs)
    for cat in absent:
        job.note(f"{CATEGORIES[cat][1]}のフォルダ({server_dirs(srv_row)[cat]})が見つかりません。送るときに作ります")
    holds = _holds(conn, srv)
    pairs = []

    def add(item, v):
        if not force and item["id"] in holds:
            job.note(f"見送り中のため入れません: {item['name']}")
            return
        if not force and _compat(conn, srv_row, item, v) is False:
            job.note(f"MC {srv_row['mc_version']} に対応していないため入れません: {item['name']} {v['version']}"
                     f"(対応: {_version_mc(conn, item, v)})")
            return
        pairs.append((item, v))
    if mode == "sync":
        chosen = {i["id"]: v for i, v in resolve_set_versions(conn, srv_row["set_id"])} if srv_row["set_id"] else {}
        for e in inventory:
            if e["status"] == "outdated" and e["latest_version_id"]:
                item = conn.execute("SELECT * FROM items WHERE id=?", (e["item_id"],)).fetchone()
                v = chosen.get(item["id"]) or conn.execute("SELECT * FROM versions WHERE id=?", (e["latest_version_id"],)).fetchone()
                add(item, v)
        for m in missing:
            if not m["no_dir"]:
                add(conn.execute("SELECT * FROM items WHERE id=?", (m["item_id"],)).fetchone(),
                    conn.execute("SELECT * FROM versions WHERE id=?", (m["version_id"],)).fetchone())
    else:
        vmap = {int(k): int(v) for k, v in (version_ids or {}).items() if v}
        for iid in item_ids:
            item = conn.execute("SELECT * FROM items WHERE id=? AND target_id=?", (iid, target_id)).fetchone()
            if not item:
                continue
            v = conn.execute("SELECT * FROM versions WHERE id=? AND item_id=?", (vmap[iid], iid)).fetchone() if iid in vmap else None
            v = v or (_item_versions(conn, iid) or [None])[0]
            if v:
                add(item, v)
    job.total = len(pairs)
    if not pairs:
        job.note("送信するものはありません(すべて最新です)")
    sent = _push_versions(job, conn, srv_row, store, pairs, inventory, title=job.title, fs=fs)
    if restart and sent and (srv_row["kind"] == "ptero" or srv_row["control"] in ("command", "docker")):
        server_power(srv_row, "restart")
        job.note("サーバーを再起動しました")
    job.result = {"sent": sent}
    label = "同期" if mode == "sync" else "転送"
    job.note(f"完了: {sent} 件を{label}しました")
    audit(f"サーバーへの{label}が完了", srv_row["name"], f"{sent} 件" + ("・再起動" if restart and sent else ""), user=user)
    if sent:
        notify_event("servers", f"{srv_row['name']} に{label}しました",
                     [f"・{i['name']} {v['version']}" for i, v in pairs][:30] + (["サーバーを再起動しました"] if restart else []))


@app.post("/api/servers/<int:srv>/sync")
@require("editor")
def api_servers_sync(srv):
    row = _server_row(srv, "edit")
    _store, target = active_store()
    data = request.get_json(silent=True) or {}
    job = start_job(f"server-{srv}", f"「{row['name']}」を同期", _server_job, srv, target["id"], "sync", [], {},
                    _truthy(data.get("restart")), current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


@app.post("/api/servers/<int:srv>/push")
@require("editor")
def api_servers_push(srv):
    row = _server_row(srv, "edit")
    _store, target = active_store()
    data = request.get_json(silent=True) or {}
    item_ids = [int(x) for x in data.get("item_ids") or []]
    version_ids = {}
    if data.get("set_id"):
        conn = db()
        s = conn.execute("SELECT * FROM sets WHERE id=? AND target_id=? AND owner_id=?",
                         (int(data["set_id"]), target["id"], current_user()["id"])).fetchone()
        if not s:
            raise ApiError("セットが見つかりません", 404)
        for i, v in resolve_set_versions(conn, s["id"]):
            item_ids.append(i["id"])
            version_ids[i["id"]] = v["id"]
    vis = visible_item_ids(db())
    item_ids = [i for i in item_ids if i in vis]
    if not item_ids:
        raise ApiError("送るものを選んでください")
    job = start_job(f"server-{srv}", f"「{row['name']}」へ転送", _server_job, srv, target["id"], "push",
                    item_ids, version_ids, _truthy(data.get("restart")), current_user()["username"], _truthy(data.get("force")),
                    user=current_user()["username"])
    return jsonify(job.public())


def _server_import_job(job, srv, target_id, names, user):
    conn = db()
    srv_row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    fs = server_fs(srv_row)
    dirs = set(server_dirs(srv_row).values())
    job.total = len(names)
    added = 0
    for path in names:
        job.done += 1
        d, _sep, n = path.rpartition("/")
        if d not in dirs or not n or n.startswith("."):  # 01.16 より前の画面はファイル名だけを送る
            if "/" in path or len(dirs) != 1:
                continue
            d, n = next(iter(dirs)), path
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            fs.download(f"{d}/{n}", tmp)
            r = ingest(tmp, n, store=store, target=target, owner_id=_uid_of(user))
            added += r.get("status") == "added"
            job.note(f"{'取り込みました' if r.get('status') == 'added' else '登録済みです'}: {r.get('name')} {r.get('version', '')}")
        except Exception as e:  # noqa: BLE001
            job.note(f"失敗: {n}: {getattr(e, 'message', e)}")
        finally:
            tmp.unlink(missing_ok=True)
    job.result = {"added": added}
    audit("サーバーから取り込みが完了", srv_row["name"], f"{added} 件", user=user)


@app.post("/api/servers/<int:srv>/import")
@require("editor")
def api_servers_import(srv):
    row = _server_row(srv, "edit")
    _store, target = active_store()
    names = [str(x) for x in (request.get_json(silent=True) or {}).get("names") or []][:200]
    if not names:
        raise ApiError("取り込むファイルを選んでください")
    job = start_job(f"server-{srv}", f"「{row['name']}」から取り込み", _server_import_job, srv, target["id"], names,
                    current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


@app.post("/api/servers/<int:srv>/power")
@require("editor")
def api_servers_power(srv):
    row = _server_row(srv, "edit")
    signal = str((request.get_json(silent=True) or {}).get("signal") or "")
    if row["kind"] == "local" and row["control"] == "command":  # 止まるのを待つので、処理として動かす
        job = start_job(f"power-{srv}", f"「{row['name']}」の{ {'start': '起動', 'stop': '停止', 'restart': '再起動'}.get(signal, signal) }",
                        lambda job: server_power(row, signal), user=current_user()["username"])
        audit("サーバーを操作", row["name"], signal)
        return jsonify(ok=True, job=job.public())
    server_power(row, signal)
    audit("サーバーを操作", row["name"], signal)
    return jsonify(ok=True)


@app.get("/api/servers/<int:srv>/status")
def api_servers_status(srv):
    row = _server_row(srv, "view")
    live = server_live(row)
    return jsonify(live)


# --------------------------------------------------------------------------
# 見送り・無効化・コピー(段階的な更新)・サーバー本体の更新・ワールドのバックアップ
# --------------------------------------------------------------------------
@app.post("/api/servers/<int:srv>/hold")
@require("editor")
def api_servers_hold(srv):
    """このアドオンの更新を、このサーバーでは見送る(同期・自動更新で入れ替えない)。"""
    _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    iid = int(data.get("item_id") or 0)
    conn = db()
    with LOCK:
        if _truthy(data.get("hold")):
            conn.execute("INSERT OR IGNORE INTO server_holds (server_id, item_id, created_at) VALUES (?,?,?)", (srv, iid, utcnow()))
        else:
            conn.execute("DELETE FROM server_holds WHERE server_id=? AND item_id=?", (srv, iid))
        conn.commit()
    return jsonify(ok=True)


@app.post("/api/servers/<int:srv>/toggle")
@require("editor")
def api_servers_toggle(srv):
    """ファイルを消さずに外す(名前の最後に .disabled を付ける)・元に戻す。"""
    row = _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    d, _sep, name = str(data.get("path") or "").rpartition("/")
    if d not in server_dirs(row).values() or not name or name.startswith(".") or "/" in name:
        raise ApiError("ファイルの指定が不正です")
    enable = _truthy(data.get("enable"))
    if enable != name.lower().endswith(".disabled"):
        raise ApiError("すでにその状態です")
    to = name[:-9] if enable else name + ".disabled"
    server_fs(row).rename(d, name, to)
    with LOCK:
        db().execute("DELETE FROM server_files WHERE server_id=? AND name IN (?,?)", (srv, f"{d}/{name}", f"{d}/{to}"))
        db().commit()
    audit("サーバーのファイルを" + ("有効化" if enable else "無効化"), row["name"], to)
    return jsonify(ok=True, name=to)


def _copy_job(job, src_id, dst_ids, target_id, mode, user, uid=0):
    """src のサーバーの中身(ライブラリにあるもの)を、dst のサーバーにそろえる。

    mode: update = dst にあるものだけ src のバージョンに / add = src にあるものを入れる /
          mirror = add に加えて、src に無い登録済みのものを dst から取り除く
    """
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    src_row = conn.execute("SELECT * FROM servers WHERE id=?", (src_id,)).fetchone()
    job.note(f"「{src_row['name']}」の中身を確認しています…")
    src_inv, _m, _a = server_inventory(conn, src_row, target, note=job.note)
    want = {}
    vis = visible_item_ids(conn, {"id": uid}) if uid else None  # 操作した人に見えるアドオンだけ
    for e in src_inv:
        if not e["item_id"] or e["status"] == "disabled" or (vis is not None and e["item_id"] not in vis):
            continue
        vid = e.get("version_id")
        if not vid:
            job.note(f"ライブラリに同じファイルが無いため、そろえられません: {e['item_name']}({e['name']})")
            continue
        want[e["item_id"]] = vid
    total = 0
    for dst_id in dst_ids:
        dst = conn.execute("SELECT * FROM servers WHERE id=?", (dst_id,)).fetchone()
        if not dst:
            continue
        fs = server_fs(dst)
        job.note(f"「{dst['name']}」の中身を確認しています…")
        inv, _m, _a = server_inventory(conn, dst, target, note=job.note, fs=fs)
        on_dst = {e["item_id"] for e in inv if e["item_id"]}
        pairs = []
        for iid, vid in want.items():
            if mode == "update" and iid not in on_dst:
                continue
            item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
            v = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
            if item and v:
                pairs.append((item, v))
        remove = [e for e in inv if mode == "mirror" and e["item_id"] and e["item_id"] not in want]
        job.total += len(pairs)
        sent = _push_versions(job, conn, dst, store, pairs, inv, title=job.title, fs=fs, remove=remove)
        total += sent
        job.note(f"「{dst['name']}」: {sent} 件を変更しました")
        if sent:
            notify_event("servers", f"{dst['name']} を {src_row['name']} にそろえました", [f"{sent} 件"])
    job.result = {"sent": total}
    audit("サーバーの中身をそろえた", src_row["name"], f"{len(dst_ids)} 台・{total} 件", user=user)


@app.post("/api/servers/<int:srv>/copy")
@require("editor")
def api_servers_copy(srv):
    """このサーバー(コピー元)の構成を、ほかのサーバーへそろえる(コピー・本番への反映)。"""
    row = _server_row(srv, "view")
    data = request.get_json(silent=True) or {}
    mode = data.get("mode") if data.get("mode") in ("update", "add", "mirror") else "update"
    dst = [int(x) for x in data.get("targets") or [] if int(x) != srv]
    if not dst:
        raise ApiError("そろえる先のサーバーを選んでください")
    for d in dst:
        get_server_checked(d, "edit")
    _store, target = active_store()
    job = start_job(f"copy-{srv}", f"「{row['name']}」の構成をそろえる", _copy_job, srv, dst, target["id"], mode,
                    current_user()["username"], current_user()["id"], user=current_user()["username"])
    return jsonify(job.public())


def server_software_info(row, force=False):
    """サーバー本体の今のビルドと、新しいビルドがあるか。結果は半日ほど覚えておく。"""
    info = _jl(row["soft_info"], {})
    fresh = info.get("checked_at") and not _due_iso(info["checked_at"], 12)
    if fresh and not force:
        return info
    soft = row["software"]
    try:
        fs = server_fs(row)
        mc, build = _detect_build(fs)
    except ApiError as e:
        return {**info, "error": e.message}
    mc = row["mc_version"] or mc
    out = {"address": info.get("address", ""), "software": soft, "mc": mc, "build": build, "checked_at": utcnow(),
           "notified": info.get("notified", "")}
    try:
        if soft and (mc or soft in ("velocity", "waterfall", "fabric")):
            ver = mc
            if soft in ("velocity", "waterfall"):
                ver = mc or ""
            latest = mcnet.latest_build(soft, ver) if ver or soft == "fabric" else None
            if latest:
                out["latest"] = latest
                out["update"] = bool(build and latest["build"] and str(latest["build"]) != str(build)
                                     and (not build.isdigit() or not str(latest["build"]).isdigit() or int(latest["build"]) > int(build)))
            newest = mcnet.newest_mc(soft)
            if newest and mc and _cmp_nums(_ver_nums(newest), _ver_nums(mc)) > 0:
                out["newer_mc"] = newest
    except mcnet.NetError as e:
        out["error"] = e.message
    with LOCK:
        db().execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(out), row["id"]))
        db().commit()
    return out


def _due_iso(iso, hours):
    try:
        t = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return True
    return datetime.now(timezone.utc) - t >= timedelta(hours=hours)


@app.get("/api/servers/<int:srv>/software")
def api_servers_software(srv):
    row = _server_row(srv, "view")
    return jsonify(server_software_info(row, force=_truthy(request.args.get("refresh"))))


WORLD_DIR = "_craftshelf_worlds"


def _world_store():
    """ワールドのバックアップの置き場所(バックアップ先があればそこ、無ければ今の保存先)。"""
    conn = db()
    tid = int(get_setting("backup_target_id", "0") or 0)
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone() if tid else None
    target = target or conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target:
        raise ApiError("保存先がありません")
    return open_store(target), target


def _world_rel(row):
    return f"{WORLD_DIR}/{row['id']}-{safe_name(row['name'], 'server', 60)}"


def _world_backup_job(job, srv, user):
    conn = db()
    row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    fs = server_fs(row)
    store, _target = _world_store()
    world = _server_props(fs).get("level-name") or "world"
    names = {e["name"] for e in (fs.list("") or []) if not e["is_file"]}
    dirs = [d for d in (world, f"{world}_nether", f"{world}_the_end") if d in names]
    if not dirs:
        raise ApiError(f"ワールドのフォルダ({world})が見つかりません")
    rc = None
    try:
        rc = _rcon(row)
        if rc:
            with rc as r:  # 書き込みを止めてから保存する(壊れたバックアップにならないように)
                r.command("save-off")
                r.command("save-all flush")
            job.note("RCON で保存を止め、ワールドを書き出しました")
            time.sleep(3)
    except mcnet.NetError as e:
        job.note(f"RCON につながらないため、そのまま保存します({e.message})")
        rc = None
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    tmp = TMP_DIR / f"world-{uuid.uuid4().hex}.part"
    try:
        job.note(f"{', '.join(dirs)} をまとめています…")
        ext = fs.archive("", dirs, tmp)
    finally:
        if rc:
            try:
                with _rcon(row) as r:
                    r.command("save-on")
            except mcnet.NetError:
                job.note("RCON で保存を再開できませんでした。サーバーで save-on を実行してください")
    size = tmp.stat().st_size
    rel = f"{_world_rel(row)}/{world}-{stamp}{ext}"
    try:
        store.ensure_dir(_world_rel(row))
        store.put(tmp, rel)
    finally:
        tmp.unlink(missing_ok=True)
    job.note(f"保存しました: {rel}({size // 1024 // 1024} MB)")
    olds = sorted(n for n in store.listdir(_world_rel(row)) if not n.startswith("."))
    for n in olds[:-max(1, row["world_keep"])]:
        try:
            store.delete(f"{_world_rel(row)}/{n}")
            job.note(f"古いバックアップを削除しました: {n}")
        except Exception:  # noqa: BLE001
            pass
    with LOCK:
        conn.execute("UPDATE servers SET last_world=? WHERE id=?", (utcnow(), srv))
        conn.commit()
    audit("ワールドをバックアップ", row["name"], rel, user=user)


@app.post("/api/servers/<int:srv>/worlds")
@require("editor")
def api_servers_world_backup(srv):
    row = _server_row(srv, "edit")
    job = start_job(f"world-{srv}", f"「{row['name']}」のワールドをバックアップ", _world_backup_job, srv,
                    current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


@app.get("/api/servers/<int:srv>/worlds")
@require("editor")
def api_servers_worlds(srv):
    row = _server_row(srv, "view")
    store, target = _world_store()
    try:
        names = sorted((n for n in store.listdir(_world_rel(row)) if not n.startswith(".")), reverse=True)
    except Exception:  # noqa: BLE001
        names = []
    return jsonify(backups=[{"name": n} for n in names], storage=target["name"], keep=row["world_keep"])


@app.get("/api/servers/<int:srv>/worlds/<path:name>")
@require("editor")
def api_servers_world_download(srv, name):
    row = _server_row(srv, "view")
    if "/" in name or name.startswith("."):
        raise ApiError("ファイルの指定が不正です")
    store, _t = _world_store()
    return send_file(store.open_read(f"{_world_rel(row)}/{name}"), as_attachment=True, download_name=name)


@app.delete("/api/servers/<int:srv>/worlds/<path:name>")
@require("editor")
def api_servers_world_delete(srv, name):
    row = _server_row(srv, "edit")
    if "/" in name or name.startswith("."):
        raise ApiError("ファイルの指定が不正です")
    store, _t = _world_store()
    store.delete(f"{_world_rel(row)}/{name}")
    audit("ワールドのバックアップを削除", row["name"], name)
    return jsonify(ok=True)


@app.post("/api/servers/<int:srv>/rcon")
@require("editor")
def api_servers_rcon(srv):
    """RCON の接続確認(list を送ってプレイヤーを返す)。"""
    row = _server_row(srv, "edit")
    rc = _rcon(row)
    if not rc:
        raise ApiError("RCON のポートとパスワードを設定してください")
    try:
        with rc as r:
            return jsonify(ok=True, message=r.command("list")[:300])
    except mcnet.NetError as e:
        raise ApiError(e.message) from e



# ==========================================================================
# 自動バックアップ
# ==========================================================================
BACKUP_DIR = "_craftshelf_backup"
_BACKUP_NAME = re.compile(r"^craftshelf-\d{8}-\d{6}\.zip$")


def _backup_job(job, user):
    conn = db()
    tid = int(get_setting("backup_target_id", "0") or 0)
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
    if not target:
        raise ApiError("バックアップ先が設定されていません")
    store = open_store(target)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dbcopy = TMP_DIR / f"backup-{uuid.uuid4().hex}.db"
    zpath = TMP_DIR / f"craftshelf-{stamp}.zip"
    try:
        job.note("登録情報(index.db)を書き出しています…")
        dst = sqlite3.connect(dbcopy)
        conn.backup(dst)
        dst.close()
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(dbcopy, "index.db")
            for f in (SECRET_KEY_PATH,):
                if f.exists():
                    z.write(f, f.name)
            if BG_DIR.exists():
                for f in BG_DIR.iterdir():
                    z.write(f, f"backgrounds/{f.name}")
            z.writestr("README.txt", "CraftShelf のバックアップ\n\nindex.db と secret.key を CONFIG_DIR(既定 /data)に戻すと復元できます。\n"
                                     "secret.key は保存先のパスワードなどの暗号鍵です。取り扱いに注意してください。\n")
        job.note(f"「{target['name']}」に保存しています…")
        store.ensure_dir(BACKUP_DIR)
        store.put(zpath, f"{BACKUP_DIR}/craftshelf-{stamp}.zip")
        keep = max(1, int(get_setting("backup_keep", "14") or 14))
        olds = sorted(n for n in store.listdir(BACKUP_DIR) if _BACKUP_NAME.match(n))
        for n in olds[:-keep]:
            store.delete(f"{BACKUP_DIR}/{n}")
            job.note(f"古いバックアップを削除: {n}")
        set_setting("last_backup", utcnow())
        job.note(f"完了: craftshelf-{stamp}.zip")
        audit("バックアップを作成", target["name"], f"craftshelf-{stamp}.zip", user=user)
        notify_event("backup", "バックアップを作成しました", [f"保存先: {target['name']}", f"ファイル: craftshelf-{stamp}.zip"])
    finally:
        dbcopy.unlink(missing_ok=True)
        zpath.unlink(missing_ok=True)


@app.post("/api/backup/run")
@require_perm("storage")
def api_backup_run():
    job = start_job("backup", "バックアップ", _backup_job, current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


def _backup_store():
    tid = int(get_setting("backup_target_id", "0") or 0)
    target = db().execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone()
    if not target:
        raise ApiError("バックアップ先が設定されていません")
    return open_store(target), target


@app.get("/api/backup/list")
@require_perm("storage")
def api_backup_list():
    store, target = _backup_store()
    try:
        names = sorted((n for n in store.listdir(BACKUP_DIR) if _BACKUP_NAME.match(n)), reverse=True)
    except StorageError:
        names = []
    return jsonify(target=target["name"], files=names)


@app.get("/api/backup/download/<name>")
@require_perm("storage")
def api_backup_download(name):
    if not _BACKUP_NAME.match(name):
        raise ApiError("見つかりません", 404)
    store, _t = _backup_store()
    rel = f"{BACKUP_DIR}/{name}"
    if not store.exists(rel):
        raise ApiError("見つかりません", 404)
    if store.is_local:
        return send_file(store.local_path(rel), as_attachment=True, download_name=name)
    return send_file(store.open_read(rel), as_attachment=True, download_name=name, mimetype="application/zip",
                     conditional=False)


# ==========================================================================
# 変更履歴(配布元のチェンジログ)
# ==========================================================================
@app.get("/api/items/<int:iid>/source/changelog")
def api_source_changelog(iid):
    get_item_checked(iid, "view")
    conn = db()
    s = conn.execute("SELECT * FROM item_sources WHERE item_id=?", (iid,)).fetchone()
    if not s:
        raise ApiError("配布元が紐付けられていません")
    have = [v["version"] for v in conn.execute("SELECT version FROM versions WHERE item_id=?", (iid,)) if v["version"]]
    try:
        entries = src.changelogs(s["provider"], s["project_id"], have_versions=have, loaders=_jl(s["loaders"], []),
                                 game_versions=_jl(s["game_versions"], []),
                                 stable_only=get_setting("stable_only", "1") == "1", api_key=cf_api_key())
    except src.SourceError as e:
        raise ApiError(e.message, 502)
    return jsonify(entries=entries, page_url=s["page_url"])


# ==========================================================================
# 前提プラグインの紐付け(名前が違うときに、ライブラリのアイテムと手動で結び付ける)
# ==========================================================================
@app.post("/api/deps/link")
@require("editor")
def api_deps_link():
    data = request.get_json(silent=True) or {}
    _store, target = active_store()
    key = norm_key(str(data.get("name") or ""))
    if not key:
        raise ApiError("前提プラグインの名前が必要です")
    conn = db()
    with LOCK:
        if data.get("item_id"):
            iid = int(data["item_id"])
            if iid not in visible_item_ids(conn) or not conn.execute("SELECT 1 FROM items WHERE id=? AND target_id=?", (iid, target["id"])).fetchone():
                raise ApiError("アイテムが見つかりません", 404)
            conn.execute("INSERT OR REPLACE INTO dep_links (target_id, dep_key, item_id) VALUES (?,?,?)", (target["id"], key, iid))
        else:
            conn.execute("DELETE FROM dep_links WHERE target_id=? AND dep_key=?", (target["id"], key))
        conn.commit()
    return jsonify(ok=True)


# ==========================================================================
# 配布サイトの検索
# ==========================================================================
@app.get("/api/search")
def api_search():
    provider = request.args.get("provider", "modrinth")
    q = str(request.args.get("q") or "").strip()[:100]
    kind = request.args.get("kind") or None
    if kind and kind not in ("plugin", "mod", "datapack", "resourcepack"):
        kind = None
    loader = (request.args.get("loader") or "").strip().lower()[:20] or None
    mc = (request.args.get("mc") or "").strip()[:20] or None
    try:
        results = src.search(provider, q, kind=kind, loader=loader, mc=mc, api_key=cf_api_key())
    except src.SourceError as e:
        raise ApiError(e.message, 502)
    _store, target = active_store()
    conn = db()
    linked = {(r["provider"], r["project_id"]): r["item_id"] for r in conn.execute(
        "SELECT s.provider, s.project_id, s.item_id FROM item_sources s JOIN items i ON i.id=s.item_id WHERE i.target_id=?",
        (target["id"],))}
    names = {norm_key(r["name"]): r["id"] for r in conn.execute("SELECT id, name FROM items WHERE target_id=?", (target["id"],))}
    for r in results:
        r["item_id"] = linked.get((r["provider"], r["project_id"])) or names.get(norm_key(r["title"]))
    return jsonify(results=results)


# ==========================================================================
# Modパックの読み込み(.mrpack / CurseForge のModパック zip)
# ==========================================================================
_MRPACK_HOSTS = ("github.com", "githubusercontent.com", "gitlab.com")


def _modpack_job(job, path, filename, make_set, include_client, target_id, user):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    added_items, stats = [], {"added": 0, "duplicate": 0, "skipped": 0, "failed": 0}
    pack_name, links = Path(filename).stem, []  # links: (item_id, provider, project_id)

    def take(local, name, force_cat=None):
        try:
            r = ingest(local, name, force_cat, store=store, target=target, owner_id=_uid_of(user))
            stats["added" if r["status"] == "added" else "duplicate"] += 1
            added_items.append(r["item_id"])
            return r
        except Exception as e:  # noqa: BLE001
            stats["failed"] += 1
            job.note(f"登録できません: {name}: {getattr(e, 'message', e)}")
            return None

    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            if "modrinth.index.json" in names:
                idx = json.loads(z.read("modrinth.index.json").decode("utf-8"))
                pack_name = f"{idx.get('name') or pack_name} {idx.get('versionId') or ''}".strip()
                files = idx.get("files") or []
                job.total = len(files)
                job.note(f"Modrinth のModパック「{pack_name}」({len(files)} ファイル)を読み込みます")
                sha_by_item = {}
                for f in files:
                    job.done += 1
                    fpath = str(f.get("path") or "")
                    base = fpath.rsplit("/", 1)[-1]
                    top = fpath.split("/", 1)[0]
                    if top not in ("mods", "resourcepacks", "datapacks") or not base or ".." in fpath:
                        stats["skipped"] += 1
                        continue
                    if not include_client and (f.get("env") or {}).get("server") == "unsupported":
                        stats["skipped"] += 1
                        job.note(f"クライアント専用のため省略: {base}")
                        continue
                    url = next((u for u in f.get("downloads") or []), None)
                    if not url:
                        stats["failed"] += 1
                        continue
                    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
                    try:
                        sha1 = (f.get("hashes") or {}).get("sha1", "")
                        src.download(url, tmp, sha1, extra_hosts=_MRPACK_HOSTS)
                        cat = {"resourcepacks": "resourcepack", "datapacks": "datapack"}.get(top)
                        r = take(tmp, base, cat)
                        if r and sha1:
                            sha_by_item[sha1] = r["item_id"]
                    except src.SourceError as e:
                        stats["failed"] += 1
                        job.note(f"ダウンロードできません: {base}: {e.message}")
                    finally:
                        tmp.unlink(missing_ok=True)
                try:
                    found = src.modrinth_by_hashes(list(sha_by_item))
                    for h, ver in found.items():
                        links.append((sha_by_item[h], "modrinth", ver["project_id"]))
                except src.SourceError:
                    pass
            elif "manifest.json" in names:
                man = json.loads(z.read("manifest.json").decode("utf-8"))
                pack_name = f"{man.get('name') or pack_name} {man.get('version') or ''}".strip()
                files = man.get("files") or []
                job.total = len(files)
                job.note(f"CurseForge のModパック「{pack_name}」({len(files)} ファイル)を読み込みます")
                key = cf_api_key()
                if not key:
                    raise ApiError("CurseForge のModパックを読み込むには、設定で CurseForge の APIキーを登録してください")
                try:
                    infos = src.curseforge_files([int(f["fileID"]) for f in files if f.get("fileID")], key)
                except src.SourceError as e:
                    raise ApiError(e.message, 502)
                for f in files:
                    job.done += 1
                    info = infos.get(int(f.get("fileID") or 0))
                    if not info:
                        stats["failed"] += 1
                        continue
                    if not info.get("url"):
                        stats["failed"] += 1
                        job.note(f"作者が外部からのダウンロードを許可していないため取得できません: {info.get('file_name')}")
                        continue
                    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
                    try:
                        src.download(info["url"], tmp, info.get("sha1") or "")
                        r = take(tmp, info.get("file_name") or f"{f['fileID']}.jar")
                        if r:
                            links.append((r["item_id"], "curseforge", str(f.get("projectID"))))
                    except src.SourceError as e:
                        stats["failed"] += 1
                        job.note(f"ダウンロードできません: {info.get('file_name')}: {e.message}")
                    finally:
                        tmp.unlink(missing_ok=True)
            else:
                raise ApiError("Modパックとして読み込めません(modrinth.index.json / manifest.json がありません)")
            # overrides に同梱されている jar も取り込む
            for n in names:
                parts = n.split("/")
                if len(parts) >= 3 and parts[0] in ("overrides", "server-overrides") and parts[1] == "mods" \
                        and n.lower().endswith(".jar") and ".." not in parts:
                    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
                    try:
                        tmp.write_bytes(z.read(n))
                        take(tmp, parts[-1])
                    finally:
                        tmp.unlink(missing_ok=True)
    finally:
        Path(path).unlink(missing_ok=True)
    for iid, provider, pid in links:
        if conn.execute("SELECT 1 FROM item_sources WHERE item_id=?", (iid,)).fetchone():
            continue
        try:
            item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
            link_source(conn, item, src.project_info(provider, pid, cf_api_key()), "hash")
        except Exception:  # noqa: BLE001
            pass
    uniq = list(dict.fromkeys(added_items))
    if make_set and uniq:
        with LOCK:
            cur = conn.execute("INSERT INTO sets (target_id, name, description, created_at, updated_at, owner_id) VALUES (?,?,?,?,?,?)",
                               (target_id, pack_name[:80], f"Modパック「{filename}」から作成", utcnow(), utcnow(), _uid_of(user)))
            for iid in uniq:
                conn.execute("INSERT OR IGNORE INTO set_items (set_id, item_id) VALUES (?,?)", (cur.lastrowid, iid))
            conn.commit()
        job.note(f"セット「{pack_name}」を作成しました")
    job.result = stats
    job.note(f"完了: 追加 {stats['added']} / 登録済み {stats['duplicate']} / 省略 {stats['skipped']} / 失敗 {stats['failed']}")
    audit("Modパックを読み込み", pack_name, f"追加 {stats['added']} 件", user=user)


@app.put("/api/modpack")
@require("editor")
def api_modpack():
    filename = os.path.basename((request.args.get("filename") or "modpack.zip").replace("\\", "/"))
    _store, target = active_store()
    tmp = TMP_DIR / (uuid.uuid4().hex + ".pack")
    total = 0
    with open(tmp, "wb") as f:
        while True:
            chunk = request.stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD:
                tmp.unlink(missing_ok=True)
                raise ApiError("ファイルが大きすぎます", 413)
            f.write(chunk)
    if not zipfile.is_zipfile(tmp):
        tmp.unlink(missing_ok=True)
        raise ApiError(".mrpack または CurseForge のModパック(zip)を選んでください")
    job = start_job("modpack", f"Modパックの読み込み({filename})", _modpack_job, str(tmp), filename,
                    _truthy(request.args.get("set", "1")), _truthy(request.args.get("client", "0")), target["id"],
                    current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


# ==========================================================================
# サーバーの巻き戻し(同期・転送の前のファイルを保存しておく)
# ==========================================================================
SNAP_DIR = CONFIG_DIR / "snapshots"
SNAP_KEEP = 10


def prune_snapshots(conn, server_id):
    olds = conn.execute("SELECT id FROM server_snapshots WHERE server_id=? ORDER BY id DESC LIMIT -1 OFFSET ?",
                        (server_id, SNAP_KEEP)).fetchall()
    for r in olds:
        shutil.rmtree(SNAP_DIR / str(r["id"]), ignore_errors=True)
        conn.execute("DELETE FROM server_snapshots WHERE id=?", (r["id"],))
    conn.commit()


@app.get("/api/servers/<int:srv>/snapshots")
@require("editor")
def api_server_snapshots(srv):
    _server_row(srv, "view")
    rows = db().execute("SELECT * FROM server_snapshots WHERE server_id=? ORDER BY id DESC", (srv,)).fetchall()
    return jsonify(snapshots=[{**dict(r), "removed": _jl(r["removed"], []), "added": _jl(r["added"], [])} for r in rows])


def _rollback_job(job, srv, snap_id, restart, user):
    conn = db()
    srv_row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    snap = conn.execute("SELECT * FROM server_snapshots WHERE id=? AND server_id=?", (snap_id, srv)).fetchone()
    removed, added = _jl(snap["removed"], []), _jl(snap["added"], [])
    fs = server_fs(srv_row)
    legacy = _clean_rel_dir(srv_row["plugin_dir"]) or "plugins"

    def full(n):  # 01.16 より前の履歴はファイル名だけ(プラグインのフォルダの中)
        return n if "/" in n else f"{legacy}/{n}"

    job.total = len(removed) + 1
    restore = {full(r["name"]) for r in removed if not r.get("dir")}
    to_delete = [full(n) for n in added if full(n) not in restore]
    for d in sorted({p.rpartition("/")[0] for p in to_delete}):
        names = [p.rpartition("/")[2] for p in to_delete if p.rpartition("/")[0] == d]
        try:
            fs.delete(d, names)
            job.note(f"同期で入れたファイルを削除: {', '.join(names)}")
        except ApiError as e:
            job.note(f"削除できないファイルがあります(すでに無いかもしれません): {e.message}")
    job.done += 1
    for r in removed:
        job.done += 1
        f = SNAP_DIR / str(snap_id) / r["stored"]
        if not f.exists():
            job.note(f"保存したファイルが見つかりません: {r['name']}")
            continue
        if r.get("dir"):  # プラグインの設定フォルダ
            parent = r["name"].rstrip("/").rpartition("/")[0]
            try:
                fs.restore_archive(parent, f, r.get("ext") or ".zip")
                job.note(f"設定フォルダを元に戻しました: {r['name']}")
            except ApiError as e:
                job.note(f"設定フォルダを戻せませんでした: {r['name']}: {e.message}")
            continue
        d, _sep, n = full(r["name"]).rpartition("/")
        fs.upload(d, f, n)
        job.note(f"元に戻しました: {n}")
    with LOCK:
        conn.execute("UPDATE server_snapshots SET rolled_back=? WHERE id=?", (utcnow(), snap_id))
        conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        conn.commit()
    if restart and (srv_row["kind"] == "ptero" or srv_row["control"] in ("command", "docker")):
        server_power(srv_row, "restart")
        job.note("サーバーを再起動しました")
    audit("サーバーを巻き戻し", srv_row["name"], snap["title"], user=user)
    notify_event("servers", f"{srv_row['name']} を巻き戻しました", [snap["title"], f"{fmt_local(snap['created_at'])} の状態に戻しました"], "warn")


def fmt_local(iso):
    try:
        return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone().strftime("%Y/%m/%d %H:%M")
    except (ValueError, TypeError):
        return iso


@app.post("/api/servers/<int:srv>/snapshots/<int:snap>/rollback")
@require("editor")
def api_server_rollback(srv, snap):
    row = _server_row(srv, "edit")
    if not db().execute("SELECT 1 FROM server_snapshots WHERE id=? AND server_id=?", (snap, srv)).fetchone():
        raise ApiError("見つかりません", 404)
    data = request.get_json(silent=True) or {}
    job = start_job(f"server-{srv}", f"「{row['name']}」を巻き戻し", _rollback_job, srv, snap, _truthy(data.get("restart")),
                    current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


# ==========================================================================
# 予約同期(サーバーごとに、毎日・毎週の決まった時刻に同期)
# ==========================================================================
def _server_auto_tick(conn, now):
    """自動更新(更新があれば同期)・ワールドの定期バックアップ・サーバー本体の新しいビルドのお知らせ。"""
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    for s in conn.execute("SELECT * FROM servers").fetchall():
        if s["auto_update"] == "auto" and target and _due_iso(s["last_auto"], 6):
            with LOCK:
                conn.execute("UPDATE servers SET last_auto=? WHERE id=?", (utcnow(), s["id"]))
                conn.commit()
            try:
                start_job(f"server-{s['id']}", f"「{s['name']}」の自動更新", _server_job, s["id"], target["id"], "sync",
                          [], {}, bool(s["sched_restart"]), "(自動更新)", user="(自動更新)")
            except ApiError:
                pass
        if s["world_mode"] in ("daily", "weekly"):
            try:
                hh, mm = (int(x) for x in (s["world_time"] or "05:00").split(":"))
            except ValueError:
                hh, mm = 5, 0
            due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            ok_day = s["world_mode"] == "daily" or now.weekday() == int(s["world_dow"] or 0)
            if ok_day and due <= now <= due + timedelta(hours=2) and _due_iso(s["last_world"], 20):
                with LOCK:
                    conn.execute("UPDATE servers SET last_world=? WHERE id=?", (utcnow(), s["id"]))
                    conn.commit()
                try:
                    start_job(f"world-{s['id']}", f"「{s['name']}」のワールドの定期バックアップ", _world_backup_job, s["id"],
                              "(予約)", user="(予約)")
                except ApiError:
                    pass
        if s["software"] and _due_iso(_jl(s["soft_info"], {}).get("checked_at"), 12):
            try:
                info = server_software_info(s, force=True)
            except Exception:  # noqa: BLE001
                continue
            if info.get("update") and info.get("notified") != info["latest"]["build"]:
                notify_event("servers", f"{s['name']}: サーバー本体の新しいビルドがあります",
                             [f"{SERVER_SOFT_LABEL.get(s['software'], s['software'])} {info.get('mc', '')} "
                              f"#{info.get('build')} → #{info['latest']['build']}", info["latest"].get("url", "")])
                info["notified"] = info["latest"]["build"]
                with LOCK:
                    conn.execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(info), s["id"]))
                    conn.commit()


SERVER_SOFT_LABEL = {"paper": "Paper", "purpur": "Purpur", "folia": "Folia", "spigot": "Spigot", "bukkit": "CraftBukkit",
                     "velocity": "Velocity", "bungeecord": "BungeeCord", "waterfall": "Waterfall", "fabric": "Fabric",
                     "quilt": "Quilt", "forge": "Forge", "neoforge": "NeoForge", "sponge": "Sponge"}


def _server_schedule_tick():
    now = datetime.now().astimezone()
    conn = db()
    _server_auto_tick(conn, now)
    for s in conn.execute("SELECT * FROM servers WHERE sched_mode IN ('daily','weekly')").fetchall():
        try:
            hh, mm = (int(x) for x in (s["sched_time"] or "04:00").split(":"))
        except ValueError:
            continue
        due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if s["sched_mode"] == "weekly" and now.weekday() != int(s["sched_dow"] or 0):
            continue
        if now < due or (now - due) > timedelta(hours=2):
            continue
        stamp = due.strftime("%Y-%m-%dT%H:%M")
        if (s["last_sched"] or "") >= stamp:
            continue
        target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
        with LOCK:
            conn.execute("UPDATE servers SET last_sched=? WHERE id=?", (stamp, s["id"]))
            conn.commit()
        try:
            start_job(f"server-{s['id']}", f"「{s['name']}」の予約同期", _server_job, s["id"], target["id"], "sync", [], {},
                      bool(s["sched_restart"]), "(予約)", user="(予約)")
        except ApiError:
            pass


# ==========================================================================
# APIトークン(外部のスクリプトから操作する)
# ==========================================================================
def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def user_from_token(token):
    r = db().execute("SELECT t.id AS tid, t.role AS trole, u.* FROM api_tokens t JOIN users u ON u.id=t.user_id "
                     "WHERE t.token_hash=?", (_token_hash(token),)).fetchone()
    if not r:
        return None
    u = dict(r)
    if ROLES.get(u["trole"], (0,))[0] < ROLES.get(u["role"], (0,))[0]:
        u["role"] = u["trole"]  # トークンの権限は、作ったユーザーの権限以下に制限する
    db().execute("UPDATE api_tokens SET last_used=? WHERE id=?", (utcnow(), u["tid"]))
    db().commit()
    return u


@app.get("/api/me/tokens")
def api_tokens_list():
    rows = db().execute("SELECT id, name, prefix, role, created_at, last_used FROM api_tokens WHERE user_id=? ORDER BY id DESC",
                        (current_user()["id"],)).fetchall()
    return jsonify(tokens=[dict(r) for r in rows])


@app.post("/api/me/tokens")
def api_tokens_create():
    if getattr(g, "via_token", False):
        raise ApiError("APIトークンではトークンを作れません", 403)
    data = request.get_json(silent=True) or {}
    u = current_user()
    name = str(data.get("name") or "").strip()[:60]
    if not name:
        raise ApiError("トークンの名前(用途)を入力してください")
    role = data.get("role") or u["role"]
    if role not in ROLES or ROLES[role][0] > ROLES[u["role"]][0]:
        raise ApiError("自分より強い権限のトークンは作れません")
    token = "cs_" + secrets.token_urlsafe(32)
    conn = db()
    conn.execute("INSERT INTO api_tokens (user_id, name, token_hash, prefix, role, created_at) VALUES (?,?,?,?,?,?)",
                 (u["id"], name, _token_hash(token), token[:10], role, utcnow()))
    conn.commit()
    audit("APIトークンを作成", name, ROLES[role][1])
    return jsonify(token=token)


@app.delete("/api/me/tokens/<int:tid>")
def api_tokens_delete(tid):
    if getattr(g, "via_token", False):
        raise ApiError("APIトークンではトークンを削除できません", 403)
    conn = db()
    r = conn.execute("SELECT name FROM api_tokens WHERE id=? AND user_id=?", (tid, current_user()["id"])).fetchone()
    if not r:
        raise ApiError("見つかりません", 404)
    conn.execute("DELETE FROM api_tokens WHERE id=?", (tid,))
    conn.commit()
    audit("APIトークンを削除", r["name"])
    return jsonify(ok=True)


# ==========================================================================
# 二段階認証(TOTP。Google Authenticator などのアプリで 6 桁のコードを表示)
# ==========================================================================
def totp_code(secret, counter):
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    h = hmac.new(key, struct.pack(">Q", counter), "sha1").digest()
    o = h[-1] & 15
    return f"{(struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def totp_verify(secret, code):
    code = re.sub(r"\s", "", str(code or ""))
    if not secret or not re.fullmatch(r"\d{6}", code):
        return False
    now = int(time.time() // 30)
    return any(hmac.compare_digest(totp_code(secret, now + d), code) for d in (-1, 0, 1))


def _qr_svg(text):
    try:
        import segno
        return segno.make(text, error="m").svg_inline(scale=5, border=2, dark="#000", light="#fff")
    except Exception:  # noqa: BLE001
        return ""


def _use_recovery(u, code):
    code = re.sub(r"[\s-]", "", str(code or "")).lower()
    codes = _jl(u["recovery"], [])
    h = hashlib.sha256(code.encode()).hexdigest()
    if code and h in codes:
        codes.remove(h)
        db().execute("UPDATE users SET recovery=? WHERE id=?", (json.dumps(codes), u["id"]))
        db().commit()
        return True
    return False


@app.post("/api/auth/totp")
def api_auth_totp():
    uid, at = session.get("pre_uid"), session.get("pre_at", 0)
    if not uid or time.time() - at > 300:
        session.clear()
        raise ApiError("時間が経ちすぎました。もう一度ログインしてください", 401)
    if _too_many_failures(f"totp:{uid}"):
        raise ApiError("失敗が続いたため、しばらく待ってからお試しください", 429)
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    code = (request.get_json(silent=True) or {}).get("code")
    if not u or not (totp_verify(u["totp_secret"], code) or _use_recovery(u, code)):
        _too_many_failures(f"totp:{uid}", add=True)
        raise ApiError("確認コードが違います", 401)
    _login(u)
    audit("ログイン(二段階認証)", u["username"], "", user=u["username"])
    return jsonify(ok=True, user=user_public(u))


@app.post("/api/me/totp/setup")
def api_totp_setup():
    u = current_user()
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    session["totp_pending"] = secret
    uri = f"otpauth://totp/CraftShelf:{quote(u['username'])}?secret={secret}&issuer=CraftShelf&digits=6&period=30"
    return jsonify(secret=secret, uri=uri, qr_svg=_qr_svg(uri))


@app.post("/api/me/totp/enable")
def api_totp_enable():
    u = current_user()
    secret = session.get("totp_pending")
    if not secret:
        raise ApiError("もう一度最初からやり直してください")
    if not totp_verify(secret, (request.get_json(silent=True) or {}).get("code")):
        raise ApiError("確認コードが違います。アプリに表示されている 6 桁の数字を入力してください")
    codes = [secrets.token_hex(4) + "-" + secrets.token_hex(4) for _ in range(8)]
    conn = db()
    conn.execute("UPDATE users SET totp_secret=?, totp_enabled=1, recovery=? WHERE id=?",
                 (secret, json.dumps([hashlib.sha256(c.replace("-", "").encode()).hexdigest() for c in codes]), u["id"]))
    conn.commit()
    session.pop("totp_pending", None)
    audit("二段階認証を有効化", u["username"])
    return jsonify(ok=True, recovery_codes=codes)


@app.post("/api/me/totp/disable")
def api_totp_disable():
    u = current_user()
    if not check_password_hash(u["password_hash"], str((request.get_json(silent=True) or {}).get("password", ""))):
        raise ApiError("パスワードが違います")
    db().execute("UPDATE users SET totp_secret='', totp_enabled=0, recovery='[]' WHERE id=?", (u["id"],))
    db().commit()
    audit("二段階認証を無効化", u["username"])
    return jsonify(ok=True)


@app.post("/api/auth/username")
def api_auth_username():
    if getattr(g, "via_token", False):
        raise ApiError("APIトークンでは変更できません", 403)
    data = request.get_json(silent=True) or {}
    u = current_user()
    if not check_password_hash(u["password_hash"], str(data.get("password", ""))):
        raise ApiError("パスワードが違います")
    new = str(data.get("username") or "").strip()
    if not _USERNAME_RE.match(new):
        raise ApiError("ユーザー名は1〜40文字の英数字・記号(. _ - @)で入力してください")
    conn = db()
    if conn.execute("SELECT 1 FROM users WHERE username=? AND id<>?", (new, u["id"])).fetchone():
        raise ApiError("そのユーザー名はすでに使われています")
    conn.execute("UPDATE users SET username=? WHERE id=?", (new, u["id"]))
    conn.commit()
    audit("ユーザー名を変更", f"{u['username']} → {new}", "")
    return jsonify(ok=True)


# ==========================================================================
# まとめてダウンロード・共有リンク
# ==========================================================================
def _zip_versions(store, pairs, zpath):
    """[(item, version)] を種類ごとのフォルダに分けて zip にする。"""
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        used = set()
        for item, v in pairs:
            arc = f"{CATEGORIES[item['category']][0]}/{v['filename']}"
            if arc in used:
                continue
            used.add(arc)
            tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
            try:
                store.fetch(lib_rel(v["relpath"]), tmp)
                z.write(tmp, arc)
            finally:
                tmp.unlink(missing_ok=True)


def _latest_pairs(conn, target_id, item_ids):
    vis = visible_item_ids(conn) if has_request_context() and current_user() else None
    pairs = []
    for iid in item_ids:
        if vis is not None and iid not in vis:
            continue  # 見えないアイテム(他の人の非公開のもの)は含めない
        item = conn.execute("SELECT * FROM items WHERE id=? AND target_id=?", (iid, target_id)).fetchone()
        vs = _item_versions(conn, iid) if item else []
        if item and vs:
            pairs.append((item, vs[0]))
    return pairs


def _send_zip(store, pairs, name):
    zpath = TMP_DIR / (uuid.uuid4().hex + ".zip")
    try:
        _zip_versions(store, pairs, zpath)
    except Exception:
        zpath.unlink(missing_ok=True)
        raise
    resp = send_file(zpath, as_attachment=True, download_name=name)
    resp.call_on_close(lambda: zpath.unlink(missing_ok=True))
    return resp


@app.get("/api/items/zip")
def api_items_zip():
    """選んだアイテムの最新バージョンをまとめて zip でダウンロードする。"""
    try:
        ids = [int(x) for x in str(request.args.get("ids") or "").split(",") if x.strip()][:500]
    except ValueError:
        raise ApiError("ids の指定が不正です")
    store, target = active_store()
    pairs = _latest_pairs(db(), target["id"], ids)
    if not pairs:
        raise ApiError("ダウンロードするものを選んでください")
    audit("まとめてダウンロード", f"{len(pairs)} 件", ", ".join(i["name"] for i, _v in pairs)[:500])
    return _send_zip(store, pairs, f"craftshelf-{datetime.now().strftime('%Y%m%d-%H%M')}.zip")


@app.post("/api/shares")
@require("editor")
def api_shares_create():
    data = request.get_json(silent=True) or {}
    ids = [int(x) for x in data.get("item_ids") or []][:500]
    _store, target = active_store()
    conn = db()
    pairs = _latest_pairs(conn, target["id"], ids)
    if not pairs:
        raise ApiError("共有するものを選んでください")
    try:
        hours = max(1, min(24 * 30, int(data.get("hours") or 168)))
    except (TypeError, ValueError):
        raise ApiError("有効期限は数字で指定してください")
    token = secrets.token_urlsafe(24)
    default_name = f"{pairs[0][0]['name']} ほか {len(pairs) - 1} 件" if len(pairs) > 1 else pairs[0][0]["name"]
    name = str(data.get("name") or "").strip()[:80] or default_name
    expires = (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute("INSERT INTO shares (token_hash, name, target_id, versions, created_by, created_at, expires_at, owner_id) "
                 "VALUES (?,?,?,?,?,?,?,?)",
                 (hashlib.sha256(token.encode()).hexdigest(), name, target["id"], json.dumps([v["id"] for _i, v in pairs]),
                  current_user()["username"], utcnow(), expires, current_user()["id"]))
    conn.commit()
    # URL の最後をファイル名にしておくと、wget / curl -O でもそのままの名前で保存される
    fname = pairs[0][1]["filename"] if len(pairs) == 1 else f"{safe_name(name, 'craftshelf')}.zip"
    url = f"{request.host_url.rstrip('/')}/s/{token}/{quote(fname)}"
    return jsonify(url=url, expires_at=expires, name=name, filename=fname)


@app.get("/api/shares")
@require("editor")
def api_shares_list():
    """自分が作った共有リンク(管理者はすべて)。"""
    u = current_user()
    sql = "SELECT id, name, created_by, created_at, expires_at, downloads, versions FROM shares"
    rows = db().execute(sql + " ORDER BY id DESC").fetchall() if u["role"] == "admin" else         db().execute(sql + " WHERE owner_id=? ORDER BY id DESC", (u["id"],)).fetchall()
    now = utcnow()
    return jsonify(shares=[{**{k: r[k] for k in ("id", "name", "created_by", "created_at", "expires_at", "downloads")},
                            "count": len(_jl(r["versions"], [])), "expired": r["expires_at"] < now} for r in rows])


@app.delete("/api/shares/<int:shid>")
@require("editor")
def api_shares_delete(shid):
    conn = db()
    u = current_user()
    r = conn.execute("SELECT owner_id FROM shares WHERE id=?", (shid,)).fetchone()
    if not r or (r[0] != u["id"] and u["role"] != "admin"):
        raise ApiError("見つかりません", 404)
    conn.execute("DELETE FROM shares WHERE id=?", (shid,))
    conn.commit()
    return jsonify(ok=True)


@app.get("/s/<token>/<path:_fname>")
def share_download_named(token, _fname):
    """/s/<token>/<ファイル名> でも同じものを返す(wget などでファイル名を保つため)。"""
    return share_download(token)


@app.get("/s/<token>")
def share_download(token):
    """共有リンク(ログイン不要)。有効期限内なら、共有されたファイルを zip(1つならそのまま)で返す。"""
    conn = db()
    r = conn.execute("SELECT * FROM shares WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
    if not r or r["expires_at"] < utcnow():
        return Response("このリンクは無効か、有効期限が切れています。\nThis link is invalid or has expired.", 404,
                        mimetype="text/plain; charset=utf-8")
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (r["target_id"],)).fetchone()
    store = open_store(target)
    pairs = []
    for vid in _jl(r["versions"], []):
        v = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
        item = conn.execute("SELECT * FROM items WHERE id=?", (v["item_id"],)).fetchone() if v else None
        if v and item:
            pairs.append((item, v))
    if not pairs:
        return Response("共有されたファイルは削除されています。", 404, mimetype="text/plain; charset=utf-8")
    conn.execute("UPDATE shares SET downloads=downloads+1 WHERE id=?", (r["id"],))
    conn.commit()
    if len(pairs) == 1:
        item, v = pairs[0]
        rel = lib_rel(v["relpath"])
        if store.is_local:
            return send_file(store.local_path(rel), as_attachment=True, download_name=v["filename"])
        return send_file(store.open_read(rel), as_attachment=True, download_name=v["filename"],
                         mimetype="application/octet-stream", conditional=False)
    return _send_zip(store, pairs, f"{safe_name(r['name'], 'craftshelf')}.zip")


# --------------------------------------------------------------------------
# 定期的な更新確認
# --------------------------------------------------------------------------
def _auto_check_job(job, auto_download):
    conn = db()
    targets = conn.execute("SELECT DISTINCT t.* FROM storage_targets t JOIN items i ON i.target_id=t.id "
                           "JOIN item_sources s ON s.item_id=i.id").fetchall()
    for t in targets:
        job.note(f"保存先「{t['name']}」を確認します")
        try:
            _bulk_job(job, t["id"], False, True, auto_download)
        except Exception as e:  # noqa: BLE001
            job.note(f"「{t['name']}」を確認できません: {getattr(e, 'message', e)}")


def _self_update_tick():
    """6時間ごとに GitHub を確認。「自動で適用」が有効なら更新まで行う。"""
    last = getattr(_self_update_tick, "last", 0.0)
    if time.monotonic() - last < 6 * 3600:
        return
    _self_update_tick.last = time.monotonic()
    info = selfupdate.check(force=True)
    if info["update_available"] and info.get("can_apply", True) and get_setting("self_auto_update", "0") == "1":
        start_job("selfupdate", f"{APP_NAME} の自動更新 ({info['current']} → {info['latest']})",
                  _self_update_job, user="(自動)")


def _due(key, hours):
    last = get_setting(key, "")
    if not last:
        return True
    try:
        last_dt = datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - last_dt >= timedelta(hours=hours)


# --------------------------------------------------------------------------
# 匿名の利用状況(同意したときだけ)・お問い合わせ
# --------------------------------------------------------------------------
# 送り先は開発者の Cloudflare Workers(telemetry/ フォルダ)。環境変数で変えられる(空にすると機能ごと無効)
DEFAULT_TELEMETRY_URL = "https://craftshelf-telemetry.mesamaru.workers.dev"
TELEMETRY_URL = os.environ.get("CRAFTSHELF_TELEMETRY_URL", DEFAULT_TELEMETRY_URL).strip().rstrip("/")


def _bucket(n):
    return "0" if n <= 0 else "1-9" if n < 10 else "10-49" if n < 50 else "50-199" if n < 200 else "200+"


def _env_info():
    import platform
    osn = {"Linux": "linux", "Windows": "windows", "Darwin": "macos"}.get(platform.system(), "other")
    if selfupdate.FROZEN:
        mode = "installer"
    elif Path("/.dockerenv").exists():
        mode = "docker"
    elif os.environ.get("CRAFTSHELF_NATIVE") and str(BASE_DIR).startswith("/opt/craftshelf"):
        mode = "script"
    else:
        mode = "source"
    return {"os": osn, "arch": platform.machine().lower()[:16], "mode": mode}


def telemetry_payload(conn):
    """送る内容(これ以外は送らない)。名前・ファイル名・アドレス・IP などは含めない。"""
    count = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    install_id = get_setting("install_id", "")
    if not re.fullmatch(r"[0-9a-f]{32}", install_id):
        install_id = secrets.token_hex(16)
        set_setting("install_id", install_id)
    admin = conn.execute("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
    lang = user_prefs(admin).get("lang", "ja") if admin else "ja"
    features = {
        "ptero": bool(get_setting("ptero_url") and get_setting("ptero_key")),
        "discord": bool(get_setting("discord_webhook")),
        "curseforge": bool(get_setting("cf_api_key")),
        "backup": bool(int(get_setting("backup_target_id", "0") or 0)),
        "auto_update": get_setting("self_auto_update", "0") == "1",
        "share_links": bool(count("SELECT COUNT(*) FROM shares")),
        "sharing": bool(count("SELECT COUNT(*) FROM item_acl") + count("SELECT COUNT(*) FROM server_acl")),
        "totp": bool(count("SELECT COUNT(*) FROM users WHERE totp_enabled=1")),
        "api_tokens": bool(count("SELECT COUNT(*) FROM api_tokens")),
    }
    return {
        "install_id": install_id, "version": running_version(), "channel": selfupdate.CHANNEL,
        **_env_info(), "lang": lang if lang in ("ja", "en") else "ja",
        "items": _bucket(count("SELECT COUNT(*) FROM items")), "users": _bucket(count("SELECT COUNT(*) FROM users")),
        "servers": _bucket(count("SELECT COUNT(*) FROM servers")), "sets": _bucket(count("SELECT COUNT(*) FROM sets")),
        "storage": sorted({r[0] for r in conn.execute("SELECT protocol FROM storage_targets") if r[0] in ("local", "smb", "webdav")}),
        "features": sorted(k for k, on in features.items() if on),
        "categories": sorted({r[0] for r in conn.execute("SELECT DISTINCT category FROM items")}),
    }


def send_telemetry():
    if not TELEMETRY_URL or get_setting("telemetry_enabled") != "1":
        return False
    try:
        r = requests.post(f"{TELEMETRY_URL}/v1/ping", json=telemetry_payload(db()), timeout=15,
                          headers={"User-Agent": f"CraftShelf/{running_version()}"})
        set_setting("telemetry_last", utcnow())
        return r.status_code == 200
    except requests.RequestException:
        return False


def _send_telemetry_bg():
    with app.app_context():
        send_telemetry()


@app.get("/api/telemetry")
@require("viewer")
def api_telemetry():
    """利用状況の送信の設定と、実際に送る内容(管理の権限がある人だけ中身を見られる)。"""
    out = {"available": bool(TELEMETRY_URL), "enabled": get_setting("telemetry_enabled") == "1",
           "asked": get_setting("telemetry_enabled") in ("0", "1"), "last_sent": get_setting("telemetry_last", ""),
           "feedback": bool(TELEMETRY_URL)}
    if has_perm("system"):
        out["preview"] = telemetry_payload(db())
    return jsonify(out)


@app.post("/api/feedback")
@require("viewer")
def api_feedback():
    """お問い合わせ・要望を開発者に送る。"""
    if not TELEMETRY_URL:
        raise ApiError("お問い合わせの送り先が設定されていません(GitHub の Issues からお送りください)", 503)
    data = request.get_json(silent=True) or {}
    kind = data.get("kind") if data.get("kind") in ("request", "bug", "question", "other") else "other"
    message = str(data.get("message") or "").strip()[:4000]
    if len(message) < 2:
        raise ApiError("内容を入力してください")
    body = {"kind": kind, "message": message, "contact": str(data.get("contact") or "").strip()[:200]}
    if _truthy(data.get("include_env", True)):
        e = _env_info()
        body.update(version=running_version(), os=e["os"], mode=e["mode"])
    try:
        r = requests.post(f"{TELEMETRY_URL}/v1/feedback", json=body, timeout=20,
                          headers={"User-Agent": f"CraftShelf/{running_version()}"})
    except requests.RequestException:
        raise ApiError("送信できませんでした(インターネット接続を確認してください)", 502)
    if r.status_code != 200:
        try:
            msg = r.json().get("error") or ""
        except ValueError:
            msg = ""
        raise ApiError(msg or f"送信できませんでした(HTTP {r.status_code})", 502)
    audit("お問い合わせを送信", {"request": "要望", "bug": "不具合", "question": "質問"}.get(kind, "その他"), "")
    return jsonify(ok=True)


def _maintenance_tick():
    """1日1回のバックアップ、依存関係の読み取り(古いデータ向け)、操作記録の整理。"""
    if TELEMETRY_URL and get_setting("telemetry_enabled") == "1" and _due("telemetry_last", 23):
        send_telemetry()
    if int(get_setting("backup_target_id", "0") or 0) and _due("last_backup", 24):
        try:
            set_setting("last_backup_try", utcnow())
            if _due("last_backup_try_gate", 1):
                set_setting("last_backup_try_gate", utcnow())
                start_job("backup", "定期バックアップ", _backup_job, "(自動)", user="(自動)")
        except ApiError:
            pass
    if not getattr(_maintenance_tick, "deps_done", False):
        _maintenance_tick.deps_done = True
        try:
            target = db().execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
            if target and any(_jl(r[0], {}).get("deps_v") != DEPS_VERSION
                              for r in db().execute("SELECT meta FROM versions WHERE target_id=?", (target["id"],))):
                start_job("deps", "依存関係の読み取り", _rescan_deps_job, target["id"], user="(自動)")
        except ApiError:
            pass
    if db().execute("SELECT 1 FROM servers LIMIT 1").fetchone() and _due("last_inventory_refresh", 6):
        set_setting("last_inventory_refresh", utcnow())

        def refresh_all(job):
            conn = db()
            target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
            for srv in conn.execute("SELECT * FROM servers").fetchall():
                try:
                    server_inventory(conn, srv, target)
                except Exception as e:  # noqa: BLE001
                    job.note(f"{srv['name']}: {getattr(e, 'message', e)}")
        try:
            start_job("inventory", "サーバーの中身の確認", refresh_all, user="(自動)")
        except ApiError:
            pass
    if _due("last_audit_prune", 24):
        set_setting("last_audit_prune", utcnow())
        prune_audit(db())
        db().commit()


def _scheduler_loop():
    while True:
        time.sleep(60)
        try:
            with app.app_context():
                try:
                    _self_update_tick()
                except ApiError:
                    pass
                _maintenance_tick()
                _server_schedule_tick()
                hours = int(get_setting("check_interval_hours", "0") or 0)
                if hours <= 0:
                    continue
                last = get_setting("last_auto_check", "")
                if last:
                    last_dt = datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                    if datetime.now(timezone.utc) - last_dt < timedelta(hours=hours):
                        continue
                set_setting("last_auto_check", utcnow())
                start_job("updates", "定期的な更新確認", _auto_check_job,
                          get_setting("auto_download", "0") == "1", user="(自動)")
        except ApiError:
            pass  # 手動の確認が実行中など
        except Exception:  # noqa: BLE001
            app.logger.exception("scheduler")


def start_scheduler():
    if os.environ.get("MCPL_NO_SCHEDULER"):
        return
    threading.Thread(target=_scheduler_loop, daemon=True, name="scheduler").start()


def _set_channel(ch):
    """受け取る版を切り替える。Docker の起動スクリプトも読めるよう、ファイルにも書いておく。"""
    set_setting("update_channel", ch)
    selfupdate.set_channel(ch)
    try:
        (CONFIG_DIR / "update-channel").write_text(ch + "\n", encoding="utf-8")
    except OSError:
        pass


def _migrate_mod_filters():
    """01.12.00: MC バージョンで絞っていない Mod の紐付けに、ファイルの MC バージョンを一度だけ設定する。"""
    if get_setting("mig_mod_mc_filter") == "1":
        return
    conn = db()
    rows = conn.execute("SELECT s.item_id FROM item_sources s JOIN items i ON i.id=s.item_id "
                        "WHERE i.category='mod' AND (s.game_versions='[]' OR s.game_versions='')").fetchall()
    for (iid,) in rows:
        vs = _item_versions(conn, iid)
        mc = str(_jl(vs[0]["meta"], {}).get("mc") or "").strip().lstrip("~^=") if vs else ""
        if _MC_REL.match(mc):
            conn.execute("UPDATE item_sources SET game_versions=?, status='unchecked' WHERE item_id=?", (json.dumps([mc]), iid))
    conn.commit()
    set_setting("mig_mod_mc_filter", "1")


init_storage()
with app.app_context():
    selfupdate.set_channel(get_setting("update_channel", "stable"))
    try:
        _migrate_mod_filters()
    except Exception:  # noqa: BLE001
        app.logger.exception("migrate mod filters")
start_scheduler()

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"{APP_NAME} {running_version()}: http://{host}:{port}  (ローカル保存先: {LOCAL_DIR})")
    app.run(host=host, port=port, threaded=True)
