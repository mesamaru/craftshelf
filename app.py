#!/usr/bin/env python3
"""MC Pack Library

プラグイン / Mod / データパック / リソースパックを、ブラウザへのドラッグ&ドロップで
登録して管理するための小さなWebアプリ。

保存先(ストレージ)はWeb画面から登録・切り替えができる。「ローカル」(このコンテナに
直接バインドマウントされた /data)は常に使え、それに加えて SMB(CIFS) / NFS の接続情報を
登録して、コンテナ側で実際にマウントしてから使うこともできる(Unraid・TrueNASなど)。

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
import shutil
import sqlite3
import subprocess
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_file, send_from_directory

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
# MOUNT_BASE: SMB/NFSで登録した接続を、コンテナ内で実際にマウントする場所。
CONFIG_DIR = Path(os.environ.get(
    "CONFIG_DIR", os.environ.get("DB_DIR", os.environ.get("DATA_DIR", BASE_DIR / "data"))
)).resolve()
LOCAL_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
MOUNT_BASE = Path(os.environ.get("MOUNT_BASE", "/mnt/storage")).resolve()
TMP_DIR = CONFIG_DIR / ".tmp"
DB_PATH = CONFIG_DIR / "index.db"
SECRET_KEY_PATH = CONFIG_DIR / "secret.key"

AUTH_USER = os.environ.get("AUTH_USER", "")
AUTH_PASS = os.environ.get("AUTH_PASS", "")

# key -> (フォルダ名, 表示名)
CATEGORIES = {
    "plugin": ("plugins", "プラグイン"),
    "mod": ("mods", "Mod"),
    "datapack": ("datapacks", "データパック"),
    "resourcepack": ("resourcepacks", "リソースパック"),
    "other": ("other", "その他"),
}
PROTOCOLS = {"local": "ローカル", "cifs": "SMB", "nfs": "NFS"}

LOCK = threading.RLock()
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
"""
# target_id に依存するインデックスは、旧DBのマイグレーション(target_id列の追加)が
# 終わった後にしか作れないので、SCHEMA本体には含めず ensure_indexes() で別途作る。

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
    for d in (CONFIG_DIR, TMP_DIR, LOCAL_DIR, LOCAL_DIR / "library", LOCAL_DIR / "inbox", MOUNT_BASE):
        d.mkdir(parents=True, exist_ok=True)
    for p in TMP_DIR.glob("*"):
        try:
            p.unlink()
        except OSError:
            pass
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    migrate_schema(conn)
    ensure_local_target(conn)
    conn.commit()
    _startup_remount(conn)
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
# ストレージ(保存先)の接続管理: 暗号化・マウント・切り替え
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


def target_mount_point(target_id):
    return MOUNT_BASE / f"t{target_id}"


def _proc_mounts_text():
    try:
        return Path("/proc/mounts").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def is_mounted(path):
    p = str(Path(path).resolve())
    for line in _proc_mounts_text().splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == p:
            return True
    return False


def _mount_cmd(target, mp):
    proto = target["protocol"]
    server = (target["server"] or "").strip()
    share = (target["share"] or "").strip().strip("/")
    extra = (target["mount_opts"] or "").strip()
    if proto == "cifs":
        opts = ["uid=0", "gid=0", "iocharset=utf8", "file_mode=0777", "dir_mode=0777", "vers=3.0"]
        user = (target["username"] or "").strip()
        if user:
            pw = decrypt_secret(target["password_enc"])
            opts += [f"username={user}", f"password={pw}"]
            if (target["domain"] or "").strip():
                opts.append(f"domain={target['domain'].strip()}")
        else:
            opts.append("guest")
        if extra:
            opts.append(extra)
        return ["mount", "-t", "cifs", f"//{server}/{share}", str(mp), "-o", ",".join(opts)]
    if proto == "nfs":
        opts = ["vers=4"]
        if extra:
            opts.append(extra)
        export = share if share.startswith("/") else "/" + share
        return ["mount", "-t", "nfs4", f"{server}:{export}", str(mp), "-o", ",".join(opts)]
    raise ApiError(f"未対応の接続方式です: {proto}")


def _friendly_mount_error(msg):
    low = msg.lower()
    if "permission denied" in low and "mount" not in low:
        return "認証に失敗しました(ユーザー名・パスワードを確認してください)"
    if "no route to host" in low or "network is unreachable" in low:
        return "サーバーに到達できません(IPアドレス・ネットワークを確認してください)"
    if "no such file or directory" in low or "no such device" in low or "mount error(2)" in low:
        return "共有名・エクスポートパスが見つかりません"
    if "mount error(112)" in low or "host is down" in low:
        return "サーバーが応答しません"
    if "mount error(13)" in low:
        return "認証に失敗しました(ユーザー名・パスワードを確認してください)"
    if "operation not permitted" in low or ("permission denied" in low and "mount" in low):
        return "コンテナにマウントの権限がありません(docker-compose.yml の cap_add / security_opt を確認してください)"
    return msg[:300] or "接続に失敗しました"


def do_unmount(mp):
    mp = Path(mp)
    if not is_mounted(mp):
        return
    r = subprocess.run(["umount", str(mp)], capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        subprocess.run(["umount", "-l", str(mp)], capture_output=True, text=True, timeout=15)


def do_mount(target, mp):
    mp = Path(mp)
    mp.mkdir(parents=True, exist_ok=True)
    if is_mounted(mp):
        do_unmount(mp)
    cmd = _mount_cmd(target, mp)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except FileNotFoundError:
        raise ApiError("mount コマンドが見つかりません(イメージに cifs-utils / nfs-common が必要です)")
    except subprocess.TimeoutExpired:
        raise ApiError("接続がタイムアウトしました(サーバーに到達できないか、応答がありません)")
    if r.returncode != 0:
        raise ApiError(_friendly_mount_error((r.stderr or r.stdout or "").strip()))
    root = mount_root(target, mp)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass  # 読み取り専用共有など。実際の利用時のエラーに任せる


def mount_root(target, mp):
    subpath = (target["subpath"] or "").strip().strip("/")
    return (mp / subpath) if subpath else mp


def test_target_params(params):
    """保存前の接続テスト。実際に一時マウントポイントへマウント→一覧→アンマウントする。"""
    if params.get("protocol") not in ("cifs", "nfs"):
        raise ApiError("protocol は cifs か nfs を指定してください")
    fake = {
        "protocol": params["protocol"],
        "server": params.get("server", ""),
        "share": params.get("share", ""),
        "subpath": params.get("subpath", ""),
        "username": params.get("username", ""),
        "domain": params.get("domain", ""),
        "password_enc": encrypt_secret(params.get("password", "")),
        "mount_opts": params.get("mount_opts", ""),
    }
    tmp_mp = MOUNT_BASE / f"test-{uuid.uuid4().hex[:8]}"
    try:
        do_mount(fake, tmp_mp)
        root = mount_root(fake, tmp_mp)
        if not root.exists():
            return {"ok": False, "message": "接続はできましたが、指定したサブフォルダが見つかりません"}
        entries = sorted(p.name for p in root.iterdir())[:20]
        writable = True
        probe = root / ".mc-pack-library-test"
        try:
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
        except OSError:
            writable = False
        msg = "接続に成功しました" if writable else "接続に成功しました(書き込みはできないようです)"
        return {"ok": True, "message": msg, "entries": entries, "writable": writable}
    except ApiError as e:
        return {"ok": False, "message": e.message}
    finally:
        do_unmount(tmp_mp)
        try:
            tmp_mp.rmdir()
        except OSError:
            pass


def _startup_remount(conn):
    """コンテナ起動時、アクティブなターゲットがネットワーク接続なら自動で再マウントする。"""
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target or target["protocol"] == "local":
        return
    mp = target_mount_point(target["id"])
    try:
        do_mount(target, mp)
        conn.execute("UPDATE storage_targets SET last_error='' WHERE id=?", (target["id"],))
        print(f"[storage] 「{target['name']}」に接続しました ({mp})")
    except ApiError as e:
        conn.execute("UPDATE storage_targets SET last_error=? WHERE id=?", (e.message, target["id"]))
        print(f"[storage] 「{target['name']}」への接続に失敗しました: {e.message}")
    conn.commit()


def active_root():
    """(root_path, target_row) を返す。ネットワーク接続でマウントされていなければ ApiError(503)。"""
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target:
        raise ApiError("有効なストレージが設定されていません", 503)
    if target["protocol"] == "local":
        return LOCAL_DIR, target
    mp = target_mount_point(target["id"])
    if not is_mounted(mp):
        raise ApiError(f"「{target['name']}」に接続されていません。設定画面から再接続してください。", 503)
    return mount_root(target, mp), target


def activate_target(target_id):
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    if not target:
        raise ApiError("見つかりません", 404)
    with LOCK:
        current = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
        if target["protocol"] != "local":
            do_mount(target, target_mount_point(target["id"]))  # 失敗時はここで ApiError
        if current and current["id"] != target["id"] and current["protocol"] != "local":
            do_unmount(target_mount_point(current["id"]))
        conn.execute("UPDATE storage_targets SET active=0")
        conn.execute("UPDATE storage_targets SET active=1, last_error='', updated_at=? WHERE id=?",
                      (utcnow(), target["id"]))
        conn.commit()
    return active_root()


def require_same_target(row, kind="バージョン"):
    """versions/items の操作対象が、現在アクティブなストレージのものか確認する。"""
    root, target = active_root()
    if row["target_id"] != target["id"]:
        raise ApiError(
            f"この{kind}は現在アクティブなストレージに属していません。"
            "該当のストレージに切り替えてから操作してください。", 409)
    return root, target


# --------------------------------------------------------------------------
# 保存まわり
# --------------------------------------------------------------------------
def abs_path(relpath, lib_root):
    p = (lib_root / relpath).resolve()
    if lib_root not in p.parents and p != lib_root:
        raise ApiError("不正なパスです", 400)
    return p


def unique_path(directory, fname):
    p = directory / fname
    if not p.exists():
        return p
    stem, suf = os.path.splitext(fname)
    i = 1
    while (directory / f"{stem}-{i}{suf}").exists():
        i += 1
    return directory / f"{stem}-{i}{suf}"


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


def remove_file(relpath, lib_root):
    p = abs_path(relpath, lib_root)
    try:
        p.unlink()
    except FileNotFoundError:
        pass
    try:
        p.parent.rmdir()  # 空のときだけ消える
    except OSError:
        pass


def ingest(src, filename, force_cat=None, default_cat=None):
    """src のファイルを解析して、現在アクティブなストレージの library に登録(移動)する。"""
    src = Path(src)
    if src.stat().st_size == 0:
        raise ApiError("空のファイルです")
    root, target = active_root()
    lib_root = root / "library"
    sha = sha256_file(src)
    info = analyze(src, filename)
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
            item, created = get_or_create_item(conn, target["id"], cat, info["name"])
            dest_dir = lib_root / CATEGORIES[cat][0] / item["folder"]
            dest_dir.mkdir(parents=True, exist_ok=True)
            fname = safe_name(Path(filename).name, "file", 200)
            canonical = dest_dir / fname
            if canonical.exists() and src.resolve() == canonical.resolve():
                dest = canonical  # すでに正しい場所にある(再スキャン時)
            else:
                dest = unique_path(dest_dir, fname)
            relpath = dest.relative_to(lib_root).as_posix()
            conn.execute(
                "INSERT INTO versions (item_id, target_id, version, filename, relpath, size, sha256, meta, added_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (item["id"], target["id"], info["version"], dest.name, relpath, src.stat().st_size, sha,
                 json.dumps(meta, ensure_ascii=False), utcnow()),
            )
            if dest != src:
                shutil.move(str(src), str(dest))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {"status": "added", "filename": filename, "name": item["name"],
            "version": info["version"], "category": cat, "item_id": item["id"],
            "new_item": created}


def build_library(conn, root, target):
    lib_root = root / "library"
    tid = target["id"]
    items = {r["id"]: dict(r, versions=[])
             for r in conn.execute("SELECT * FROM items WHERE target_id=?", (tid,))}
    for r in conn.execute("SELECT * FROM versions WHERE target_id=?", (tid,)):
        d = dict(r)
        try:
            d["meta"] = json.loads(d["meta"] or "{}")
        except ValueError:
            d["meta"] = {}
        d["missing"] = not (lib_root / d.pop("relpath")).exists()
        items[d["item_id"]]["versions"].append(d)
    out = []
    for it in items.values():
        vs = sorted(it["versions"],
                    key=lambda v: (version_key(v["version"]), v["added_at"], v["id"]),
                    reverse=True)
        if not vs:
            continue
        it["versions"] = vs
        it["latest_id"] = vs[0]["id"]
        it["total_size"] = sum(v["size"] for v in vs)
        it["last_added"] = max(v["added_at"] for v in vs)
        it.pop("key", None)
        it.pop("folder", None)
        out.append(it)
    return out


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
@app.before_request
def check_auth():
    if not (AUTH_USER and AUTH_PASS):
        return None
    a = request.authorization
    if a and secrets.compare_digest(a.username or "", AUTH_USER) and \
            secrets.compare_digest(a.password or "", AUTH_PASS):
        return None
    return Response("認証が必要です", 401, {"WWW-Authenticate": 'Basic realm="MC Pack Library"'})


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(Exception)
def handle_error(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify(error=e.description), e.code
    app.logger.exception("unhandled error")
    return jsonify(error=f"サーバーエラー: {e}"), 500


@app.get("/")
def index():
    return send_from_directory(BASE_DIR / "static", "index.html", max_age=0)


def running_version():
    try:
        return (BASE_DIR / ".version").read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def target_public(row, conn=None):
    d = dict(row)
    d.pop("password_enc", None)
    d["has_password"] = bool(row["password_enc"])
    if row["protocol"] == "local":
        d["mounted"] = True
    else:
        d["mounted"] = is_mounted(target_mount_point(row["id"]))
    d["protocol_label"] = PROTOCOLS.get(row["protocol"], row["protocol"])
    if conn is not None:
        d["item_count"] = conn.execute(
            "SELECT COUNT(*) FROM items WHERE target_id=?", (row["id"],)).fetchone()[0]
    return d


@app.get("/api/library")
def api_library():
    conn = db()
    try:
        root, target = active_root()
        storage_err = None
        items = build_library(conn, root, target)
    except ApiError as e:
        target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
        storage_err = e.message
        items = []
        root = None
    return jsonify(
        items=items,
        categories={k: v[1] for k, v in CATEGORIES.items()},
        storage={
            "path": str(root / "library") if root else None,
            "inbox": str(root / "inbox") if root else None,
            "target": target_public(target, conn) if target else None,
            "error": storage_err,
        },
        version=running_version(),
    )


@app.put("/api/upload")
def api_upload():
    filename = os.path.basename((request.args.get("filename") or "").replace("\\", "/"))
    if not filename:
        raise ApiError("filename が必要です")
    force = request.args.get("category") or None
    if force and force not in CATEGORIES:
        raise ApiError("category が不正です")
    tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
    try:
        with open(tmp, "wb") as f:
            while True:
                chunk = request.stream.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        result = ingest(tmp, filename, force)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
    return jsonify(result)


@app.post("/api/scan")
def api_scan():
    """inbox/ 内のファイルと、DB未登録のlibrary内ファイルを取り込む(アクティブなストレージのみ)。"""
    conn = db()
    root, target = active_root()
    lib_root, inbox_root = root / "library", root / "inbox"
    lib_root.mkdir(parents=True, exist_ok=True)
    inbox_root.mkdir(parents=True, exist_ok=True)
    known = {r[0] for r in conn.execute(
        "SELECT relpath FROM versions WHERE target_id=?", (target["id"],))}
    scan_targets = []  # (path, default_cat)
    for p in sorted(inbox_root.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            scan_targets.append((p, None))
    rev = {v[0]: k for k, v in CATEGORIES.items()}
    for p in sorted(lib_root.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        rel = p.relative_to(lib_root).as_posix()
        if rel not in known:
            top = rel.split("/", 1)[0]
            scan_targets.append((p, rev.get(top)))
    added = dup = 0
    errors = []
    for p, default_cat in scan_targets:
        try:
            r = ingest(p, p.name, default_cat=default_cat)
            if r["status"] == "added":
                added += 1
            else:
                dup += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"{p.name}: {getattr(e, 'message', e)}")
    # 取り込みで空になったフォルダを片付ける(inbox本体・カテゴリフォルダは残す)
    keep = {inbox_root} | {lib_root / v[0] for v in CATEGORIES.values()}
    for r_ in (inbox_root, lib_root):
        for d in sorted((x for x in r_.rglob("*") if x.is_dir()), key=lambda x: len(x.parts), reverse=True):
            if d not in keep:
                try:
                    d.rmdir()
                except OSError:
                    pass
    missing = sum(1 for r in conn.execute("SELECT relpath FROM versions WHERE target_id=?", (target["id"],))
                  if not (lib_root / r[0]).exists())
    return jsonify(added=added, duplicates=dup, errors=errors, missing=missing,
                   scanned=len(scan_targets))


@app.get("/api/versions/<int:vid>/download")
def api_download(vid):
    row = db().execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    root, _target = require_same_target(row)
    p = abs_path(row["relpath"], root / "library")
    if not p.exists():
        raise ApiError("ファイルが保存先に見つかりません", 404)
    return send_file(p, as_attachment=True, download_name=row["filename"])


@app.patch("/api/versions/<int:vid>")
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
def api_delete_version(vid):
    conn = db()
    row = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    root, _target = require_same_target(row)
    with LOCK:
        conn.execute("DELETE FROM versions WHERE id=?", (vid,))
        left = conn.execute("SELECT COUNT(*) FROM versions WHERE item_id=?", (row["item_id"],)).fetchone()[0]
        if left == 0:
            conn.execute("DELETE FROM items WHERE id=?", (row["item_id"],))
        conn.commit()
        remove_file(row["relpath"], root / "library")
    return jsonify(ok=True)


@app.delete("/api/items/<int:iid>")
def api_delete_item(iid):
    conn = db()
    item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        raise ApiError("見つかりません", 404)
    root, _target = require_same_target(item, kind="アイテム")
    rows = conn.execute("SELECT relpath FROM versions WHERE item_id=?", (iid,)).fetchall()
    with LOCK:
        conn.execute("DELETE FROM items WHERE id=?", (iid,))
        conn.commit()
        for r in rows:
            remove_file(r["relpath"], root / "library")
    return jsonify(ok=True)


@app.patch("/api/items/<int:iid>")
def api_patch_item(iid):
    """名前・種類の変更。同じ名前・種類の項目が既にあれば統合される(同一ストレージ内のみ)。"""
    data = request.get_json(silent=True) or {}
    conn = db()
    item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        raise ApiError("見つかりません", 404)
    root, _target = require_same_target(item, kind="アイテム")
    lib_root = root / "library"
    new_cat = data.get("category", item["category"])
    if new_cat not in CATEGORIES:
        raise ApiError("category が不正です")
    new_name = str(data.get("name", item["name"]) or "").strip()
    if not new_name:
        raise ApiError("名前を入力してください")

    moved = []  # (dest, src) 失敗時に戻す用
    with LOCK:
        try:
            target, _created = get_or_create_item(conn, item["target_id"], new_cat, new_name)
            if target["id"] == item["id"]:
                conn.execute("UPDATE items SET name=? WHERE id=?", (new_name, iid))
            else:
                dest_dir = lib_root / CATEGORIES[new_cat][0] / target["folder"]
                dest_dir.mkdir(parents=True, exist_ok=True)
                for v in conn.execute("SELECT * FROM versions WHERE item_id=?", (iid,)).fetchall():
                    src = lib_root / v["relpath"]
                    dest = unique_path(dest_dir, v["filename"])
                    if src.exists():
                        shutil.move(str(src), str(dest))
                        moved.append((dest, src))
                    conn.execute(
                        "UPDATE versions SET item_id=?, relpath=?, filename=? WHERE id=?",
                        (target["id"], dest.relative_to(lib_root).as_posix(), dest.name, v["id"]),
                    )
                conn.execute("DELETE FROM items WHERE id=?", (iid,))
            conn.commit()
        except Exception:
            conn.rollback()
            for dest, src in reversed(moved):
                try:
                    shutil.move(str(dest), str(src))
                except OSError:
                    pass
            raise
        # 空になった旧フォルダを片付ける
        old_dir = lib_root / CATEGORIES[item["category"]][0] / item["folder"]
        try:
            old_dir.rmdir()
        except OSError:
            pass
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# ストレージ接続の登録・切り替え API
# --------------------------------------------------------------------------
@app.get("/api/storage/targets")
def api_storage_list():
    conn = db()
    rows = conn.execute(
        "SELECT * FROM storage_targets ORDER BY (protocol!='local'), id").fetchall()
    return jsonify(targets=[target_public(r, conn) for r in rows])


def _target_payload(data, existing=None):
    protocol = data.get("protocol", existing["protocol"] if existing else "cifs")
    if protocol not in ("cifs", "nfs"):
        raise ApiError("protocol は cifs か nfs を指定してください")
    name = str(data.get("name", existing["name"] if existing else "")).strip()[:80]
    if not name:
        raise ApiError("名前を入力してください")
    server = str(data.get("server", existing["server"] if existing else "")).strip()[:255]
    if not server:
        raise ApiError("サーバー(IPアドレス・ホスト名)を入力してください")
    share = str(data.get("share", existing["share"] if existing else "")).strip()[:255]
    if not share:
        raise ApiError("共有名 / エクスポートパスを入力してください")
    subpath = str(data.get("subpath", existing["subpath"] if existing else "")).strip().strip("/")[:255]
    username = str(data.get("username", existing["username"] if existing else "")).strip()[:120]
    domain = str(data.get("domain", existing["domain"] if existing else "")).strip()[:120]
    mount_opts = str(data.get("mount_opts", existing["mount_opts"] if existing else "")).strip()[:500]
    if "password" in data:
        password_enc = encrypt_secret(str(data.get("password") or ""))
    else:
        password_enc = existing["password_enc"] if existing else ""
    return dict(name=name, protocol=protocol, server=server, share=share, subpath=subpath,
                username=username, domain=domain, password_enc=password_enc, mount_opts=mount_opts)


@app.post("/api/storage/targets")
def api_storage_create():
    data = request.get_json(silent=True) or {}
    payload = _target_payload(data)
    conn = db()
    with LOCK:
        cur = conn.execute(
            "INSERT INTO storage_targets "
            "(name,protocol,server,share,subpath,username,domain,password_enc,mount_opts,active,created_at,updated_at) "
            "VALUES (:name,:protocol,:server,:share,:subpath,:username,:domain,:password_enc,:mount_opts,0,:now,:now)",
            {**payload, "now": utcnow()},
        )
        conn.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.patch("/api/storage/targets/<int:tid>")
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
            "mount_opts=:mount_opts, updated_at=:now WHERE id=:id",
            {**payload, "now": utcnow(), "id": tid},
        )
        conn.commit()
    return jsonify(ok=True)


@app.delete("/api/storage/targets/<int:tid>")
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
        if row["protocol"] != "local":
            do_unmount(target_mount_point(tid))
        conn.execute("DELETE FROM storage_targets WHERE id=?", (tid,))
        conn.commit()
    return jsonify(ok=True)


@app.post("/api/storage/targets/test")
def api_storage_test_new():
    data = request.get_json(silent=True) or {}
    return jsonify(test_target_params(data))


@app.post("/api/storage/targets/<int:tid>/test")
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
def api_storage_activate(tid):
    root, target = activate_target(tid)
    return jsonify(ok=True, target=target_public(target, db()), root=str(root))


init_storage()

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"MC Pack Library: http://{host}:{port}  (ローカル保存先: {LOCAL_DIR})")
    app.run(host=host, port=port, threaded=True)
