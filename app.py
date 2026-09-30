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
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

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
DB_PATH = CONFIG_DIR / "index.db"
SECRET_KEY_PATH = CONFIG_DIR / "secret.key"
SESSION_KEY_PATH = CONFIG_DIR / "session.key"

# 初回起動時の管理者アカウント(ユーザーがまだ1人もいない場合だけ使う。README参照)
AUTH_USER = os.environ.get("AUTH_USER", "")
AUTH_PASS = os.environ.get("AUTH_PASS", "")

# 権限。数字が大きいほど強い
ROLES = {"viewer": (1, "閲覧のみ"), "editor": (2, "編集者"), "admin": (3, "管理者")}

# key -> (フォルダ名, 表示名)
CATEGORIES = {
    "plugin": ("plugins", "プラグイン"),
    "mod": ("mods", "Mod"),
    "datapack": ("datapacks", "データパック"),
    "resourcepack": ("resourcepacks", "リソースパック"),
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
    UNIQUE (target_id, category, key)
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
    # 旧バージョン(OSの mount を使っていた頃)の SMB 登録は、そのまま新しい SMB 方式で使える。
    # NFS はアプリ単体では扱えなくなったため、画面上で「非対応」と表示して再登録を促す。
    conn.execute("UPDATE storage_targets SET protocol='smb' WHERE protocol='cifs'")
    if "sha1" not in _table_cols(conn, "versions"):  # 配布サイトとの照合に使う
        conn.execute("ALTER TABLE versions ADD COLUMN sha1 TEXT NOT NULL DEFAULT ''")
    if "mc_versions" not in _table_cols(conn, "items"):  # 対応MCバージョン(手入力。空なら自動)
        conn.execute("ALTER TABLE items ADD COLUMN mc_versions TEXT NOT NULL DEFAULT ''")
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


def analyze(path, filename):
    info = dict(category="other", name=None, version=None, loader=None,
                mc=None, description=None, pack_format=None)
    if zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as z:
                _analyze_zip(z, info)
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


def get_or_create_item(conn, target_id, category, name):
    key = norm_key(name)
    row = conn.execute(
        "SELECT * FROM items WHERE target_id=? AND category=? AND key=?", (target_id, category, key)
    ).fetchone()
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
        "INSERT INTO items (target_id, category, name, key, folder, created_at) VALUES (?,?,?,?,?,?)",
        (target_id, category, name, key, folder, utcnow()),
    )
    row = conn.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,)).fetchone()
    return row, True


def remove_file(store, relpath):
    rel = lib_rel(relpath)
    store.delete(rel)
    store.rmdir_if_empty(parent_rel(rel))  # 空のときだけ消える


def ingest(local, filename, force_cat=None, default_cat=None, src_rel=None, item_id=None,
           store=None, target=None):
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
    meta = {k: info[k] for k in ("loader", "mc", "description", "pack_format") if info.get(k)}

    with LOCK:
        conn = db()
        dup = conn.execute(
            "SELECT v.id, v.version, i.id AS item_id, i.name, i.category FROM versions v "
            "JOIN items i ON i.id = v.item_id WHERE v.sha256=? AND v.target_id=?",
            (sha, target["id"])).fetchone()
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
                item, created = get_or_create_item(conn, target["id"], cat, info["name"])
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


def auto_mc_versions(meta, category, source):
    """保存しているファイルの中身・配布元の情報から、対応MCバージョンを推定する。"""
    mc = str((meta or {}).get("mc") or "").strip()
    if mc:
        if category == "plugin" and re.match(r"^\d+\.\d+(\.\d+)?$", mc):
            return f"{mc} 以降"  # plugin.yml の api-version は「このバージョン以降」の意味
        mc = re.sub(r"^>=\s*(\S+)$", r"\1 以降", mc)
        mc = re.sub(r"^\[([^,\]]+),\s*\)$", r"\1 以降", mc)  # Forge の [1.20.1,)
        return mc.lstrip("~^=")[:60]
    if source:
        if source.get("game_versions"):
            return summarize_mc(source["game_versions"])
        if source.get("status") == "up_to_date":
            return summarize_mc((source.get("latest") or {}).get("game_versions") or [])
    return ""


def build_library(conn, store, target):
    tid = target["id"]
    present = store.file_index("library")
    items = {r["id"]: dict(r, versions=[])
             for r in conn.execute("SELECT * FROM items WHERE target_id=?", (tid,))}
    for r in conn.execute("SELECT * FROM versions WHERE target_id=?", (tid,)):
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
        it["total_size"] = sum(v["size"] for v in vs)
        it["last_added"] = max(v["added_at"] for v in vs)
        it.pop("key", None)
        it.pop("folder", None)
        out.append(it)
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


def user_public(u):
    return {"id": u["id"], "username": u["username"], "role": u["role"],
            "role_label": ROLES.get(u["role"], (0, u["role"]))[1],
            "created_at": u["created_at"], "last_login": u["last_login"]}


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
PUBLIC_PATHS = {"/", "/api/auth/me", "/api/auth/login", "/api/auth/setup", "/api/auth/logout"}


@app.before_request
def check_auth():
    # CSRF対策: 画面(同じオリジンのJavaScript)からしか付けられないヘッダーを、変更系の操作に必須にする
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("X-Requested-With") != "mcpl":
            raise ApiError("不正なリクエストです(画面を再読み込みしてください)", 403)
    if request.path in PUBLIC_PATHS or request.path.startswith("/static/"):
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
    return send_from_directory(BASE_DIR / "static", "index.html", max_age=0)


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
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
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
        items = build_library(conn, store, target)
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
    version = str(data.get("version", row["version"])).strip()[:64]
    note = str(data.get("note", row["note"])).strip()[:1000]
    with LOCK:
        conn.execute("UPDATE versions SET version=?, note=? WHERE id=?", (version, note, vid))
        conn.commit()
    return jsonify(ok=True)


@app.delete("/api/versions/<int:vid>")
@require("editor")
def api_delete_version(vid):
    conn = db()
    row = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    store, _target = require_same_target(row)
    with LOCK:
        conn.execute("DELETE FROM versions WHERE id=?", (vid,))
        left = conn.execute("SELECT COUNT(*) FROM versions WHERE item_id=?", (row["item_id"],)).fetchone()[0]
        if left == 0:
            conn.execute("DELETE FROM items WHERE id=?", (row["item_id"],))
        conn.commit()
        remove_file(store, row["relpath"])
    return jsonify(ok=True)


@app.delete("/api/items/<int:iid>")
@require("editor")
def api_delete_item(iid):
    conn = db()
    item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        raise ApiError("見つかりません", 404)
    store, _target = require_same_target(item, kind="アイテム")
    rows = conn.execute("SELECT relpath FROM versions WHERE item_id=?", (iid,)).fetchall()
    with LOCK:
        conn.execute("DELETE FROM items WHERE id=?", (iid,))
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
    item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        raise ApiError("見つかりません", 404)
    store, _target = require_same_target(item, kind="アイテム")
    new_cat = data.get("category", item["category"])
    if new_cat not in CATEGORIES:
        raise ApiError("category が不正です")
    new_name = str(data.get("name", item["name"]) or "").strip()
    if not new_name:
        raise ApiError("名前を入力してください")
    mc_versions = str(data.get("mc_versions", item["mc_versions"]) or "").strip()[:100]

    moved = []  # (dest, src) 失敗時に戻す用
    with LOCK:
        try:
            target, _created = get_or_create_item(conn, item["target_id"], new_cat, new_name)
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
            conn.execute("UPDATE items SET mc_versions=? WHERE id=?", (mc_versions, target["id"]))
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
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# ストレージ接続の登録・切り替え API
# --------------------------------------------------------------------------
@app.get("/api/storage/targets")
@require("admin")
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
@require("admin")
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
@require("admin")
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
@require("admin")
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
@require("admin")
def api_storage_test_new():
    data = request.get_json(silent=True) or {}
    return jsonify(test_target_params(data))


@app.post("/api/storage/targets/<int:tid>/test")
@require("admin")
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
@require("admin")
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
@require("admin")
def api_users():
    rows = db().execute("SELECT * FROM users ORDER BY id").fetchall()
    return jsonify(users=[user_public(r) for r in rows])


@app.post("/api/users")
@require("admin")
def api_users_create():
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username", "")).strip(), str(data.get("password", ""))
    role = data.get("role", "editor")
    if role not in ROLES:
        raise ApiError("権限の指定が不正です")
    _check_new_credentials(username, password)
    conn = db()
    if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        raise ApiError("そのユーザー名はすでに使われています")
    conn.execute("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)",
                 (username, generate_password_hash(password), role, utcnow()))
    conn.commit()
    return jsonify(ok=True)


def _admin_count(conn):
    return conn.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]


@app.patch("/api/users/<int:uid>")
@require("admin")
def api_users_update(uid):
    data = request.get_json(silent=True) or {}
    conn = db()
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise ApiError("見つかりません", 404)
    if "role" in data:
        if data["role"] not in ROLES:
            raise ApiError("権限の指定が不正です")
        if u["role"] == "admin" and data["role"] != "admin" and _admin_count(conn) <= 1:
            raise ApiError("管理者が1人もいなくなるため変更できません")
        conn.execute("UPDATE users SET role=? WHERE id=?", (data["role"], uid))
    if data.get("password"):
        _check_new_credentials("", str(data["password"]), need_username=False)
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (generate_password_hash(str(data["password"])), uid))
    conn.commit()
    return jsonify(ok=True)


@app.delete("/api/users/<int:uid>")
@require("admin")
def api_users_delete(uid):
    conn = db()
    u = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise ApiError("見つかりません", 404)
    if uid == current_user()["id"]:
        raise ApiError("自分自身は削除できません")
    if u["role"] == "admin" and _admin_count(conn) <= 1:
        raise ApiError("管理者が1人もいなくなるため削除できません")
    _remove_bg_file(user_prefs(u).get("bg_file"))
    conn.execute("DELETE FROM users WHERE id=?", (uid,))
    conn.commit()
    return jsonify(ok=True)


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
def settings_public():
    return {
        "cf_api_key_set": bool(get_setting("cf_api_key")),
        "check_interval_hours": int(get_setting("check_interval_hours", "0") or 0),
        "auto_download": get_setting("auto_download", "0") == "1",
        "stable_only": get_setting("stable_only", "1") == "1",
        "last_auto_check": get_setting("last_auto_check", ""),
        "self_auto_update": get_setting("self_auto_update", "0") == "1",
    }


@app.get("/api/settings")
@require("viewer")
def api_settings():
    return jsonify(settings_public())


@app.patch("/api/settings")
@require("admin")
def api_settings_update():
    data = request.get_json(silent=True) or {}
    if "cf_api_key" in data:
        set_setting("cf_api_key", encrypt_secret(str(data["cf_api_key"] or "").strip()))
    if "check_interval_hours" in data:
        try:
            hours = max(0, min(24 * 7, int(data["check_interval_hours"])))
        except (TypeError, ValueError):
            raise ApiError("確認間隔は数字で指定してください")
        set_setting("check_interval_hours", hours)
    for key in ("auto_download", "stable_only", "self_auto_update"):
        if key in data:
            set_setting(key, "1" if _truthy(data[key]) else "0")
    return jsonify(settings_public())


# --------------------------------------------------------------------------
# バックグラウンド処理 API
# --------------------------------------------------------------------------
@app.get("/api/jobs")
def api_jobs():
    with _JOBS_LOCK:
        jobs = sorted(_JOBS.values(), key=lambda j: j.started, reverse=True)
    return jsonify(jobs=[j.public() for j in jobs[:10]])


@app.get("/api/jobs/<job_id>")
def api_job(job_id):
    job = _JOBS.get(job_id)
    if not job:
        raise ApiError("見つかりません", 404)
    return jsonify(job.public())


# --------------------------------------------------------------------------
# 保存先の中身の確認・移行
# --------------------------------------------------------------------------
@app.get("/api/storage/targets/<int:tid>/contents")
@require("admin")
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
                            d_item, _ = get_or_create_item(conn, dest_id, it["category"], it["name"])
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
@require("admin")
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
    }


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


_PROJECT_TYPES = {"plugin": "plugin", "mod": "mod", "datapack": "datapack", "resourcepack": "resourcepack"}


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
    item = db().execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        raise ApiError("見つかりません", 404)
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


def _bulk_job(job, target_id, do_detect, do_check, do_download):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target) if (do_detect or do_download) else None
    items = conn.execute("SELECT * FROM items WHERE target_id=? ORDER BY name", (target_id,)).fetchall()
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


@app.post("/api/updates/run")
@require("editor")
def api_updates_run():
    """detect=未連携のアイテムの配布元を探す / check=最新版を確認 / download=更新を保存。"""
    data = request.get_json(silent=True) or {}
    _store, target = active_store()
    detect, check, dl = _truthy(data.get("detect")), _truthy(data.get("check", True)), _truthy(data.get("download"))
    title = "配布元の自動検出" if detect and not check else ("更新の確認と保存" if dl else "更新の確認")
    job = start_job("updates", title, _bulk_job, target["id"], detect, check, dl,
                    user=current_user()["username"])
    return jsonify(job.public())


@app.post("/api/import")
@require("editor")
def api_import():
    """配布ページのURLから最新版をダウンロードして登録し、配布元も紐付ける。"""
    data = request.get_json(silent=True) or {}
    info = _source_from_request(data)
    loaders = [x.strip().lower() for x in str(data.get("loaders") or "").split(",") if x.strip()]
    game_versions = [x.strip() for x in str(data.get("game_versions") or "").split(",") if x.strip()]
    try:
        latest = src.latest(info["provider"], info["project_id"], loaders=loaders, game_versions=game_versions,
                            stable_only=get_setting("stable_only", "1") == "1", api_key=cf_api_key())
    except src.SourceError as e:
        raise ApiError(e.message, 502)
    if not latest:
        raise ApiError("条件に合う版が見つかりません(ローダー・MCバージョンを確認してください)")
    if not latest.get("downloadable"):
        raise ApiError(latest.get("note") or "この配布元からは自動ダウンロードできません")
    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
    try:
        try:
            src.download(latest["url"], tmp, latest.get("sha1") or "")
        except src.SourceError as e:
            raise ApiError(e.message, 502)
        force = data.get("category") if data.get("category") in CATEGORIES else None
        result = ingest(tmp, latest.get("file_name") or f"{safe_name(info['title'])}.jar", force)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
    conn = db()
    item = conn.execute("SELECT * FROM items WHERE id=?", (result["item_id"],)).fetchone()
    if not conn.execute("SELECT 1 FROM item_sources WHERE item_id=?", (item["id"],)).fetchone():
        link_source(conn, item, info, "import", matched=latest)
        if loaders or game_versions:
            conn.execute("UPDATE item_sources SET loaders=?, game_versions=? WHERE item_id=?",
                         (json.dumps(loaders or _jl(conn.execute("SELECT loaders FROM item_sources WHERE item_id=?",
                                                                   (item["id"],)).fetchone()[0], [])),
                          json.dumps(game_versions), item["id"]))
            conn.commit()
        check_item(conn, item)
    return jsonify({**result, "source_title": info["title"]})


# --------------------------------------------------------------------------
# CraftShelf 自身の更新(GitHub から)
# --------------------------------------------------------------------------
@app.get("/api/system/info")
def api_system_info():
    return jsonify(name=APP_NAME, version=running_version(), build=selfupdate.build_info(),
                   repo=selfupdate.REPO, branch=selfupdate.BRANCH)


@app.get("/api/system/update")
@require("admin")
def api_system_update_check():
    return jsonify(selfupdate.check(force=_truthy(request.args.get("force"))))


def _self_update_job(job):
    old, new = selfupdate.apply(note=job.note)
    job.result = {"from": old, "to": new}
    job.note(f"{old} → {new} に更新しました。再起動します(数秒で画面が新しい版に切り替わります)")
    selfupdate.restart()


@app.post("/api/system/update")
@require("admin")
def api_system_update_apply():
    info = selfupdate.check(force=True)
    if info["error"]:
        raise ApiError(info["error"], 502)
    if not info["update_available"]:
        raise ApiError(f"すでに最新です({info['current']})", 409)
    job = start_job("selfupdate", f"{APP_NAME} の更新 ({info['current']} → {info['latest']})",
                    _self_update_job, user=current_user()["username"])
    return jsonify(job.public())


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
    if info["update_available"] and get_setting("self_auto_update", "0") == "1":
        start_job("selfupdate", f"{APP_NAME} の自動更新 ({info['current']} → {info['latest']})",
                  _self_update_job, user="(自動)")


def _scheduler_loop():
    while True:
        time.sleep(60)
        try:
            with app.app_context():
                try:
                    _self_update_tick()
                except ApiError:
                    pass
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


init_storage()
start_scheduler()

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"{APP_NAME} {running_version()}: http://{host}:{port}  (ローカル保存先: {LOCAL_DIR})")
    app.run(host=host, port=port, threaded=True)
