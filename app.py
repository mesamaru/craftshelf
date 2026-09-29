#!/usr/bin/env python3
"""MC Pack Library

プラグイン / Mod / データパック / リソースパックを、ブラウザへのドラッグ&ドロップで
登録して管理するための小さなWebアプリ。ファイルは DATA_DIR 配下(NASなど)に

    library/<種類>/<名前>/<元のファイル名>

の形で整理して保存し、名前・バージョンなどの情報は index.db (SQLite) に記録します。
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
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

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
DB_DIR = Path(os.environ.get("DB_DIR", DATA_DIR)).resolve()
LIB_DIR = DATA_DIR / "library"
INBOX_DIR = DATA_DIR / "inbox"
TMP_DIR = DATA_DIR / ".tmp"
DB_PATH = DB_DIR / "index.db"

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
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    name        TEXT NOT NULL,
    key         TEXT NOT NULL,
    folder      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (category, key)
);
CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    version     TEXT NOT NULL DEFAULT '',
    filename    TEXT NOT NULL,
    relpath     TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL UNIQUE,
    meta        TEXT NOT NULL DEFAULT '{}',
    note        TEXT NOT NULL DEFAULT '',
    added_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_item ON versions(item_id);
"""


def init_storage():
    for d in (LIB_DIR, INBOX_DIR, TMP_DIR, DB_DIR):
        d.mkdir(parents=True, exist_ok=True)
    for p in TMP_DIR.glob("*"):
        try:
            p.unlink()
        except OSError:
            pass
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.executescript(SCHEMA)
    conn.commit()
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
# 保存まわり
# --------------------------------------------------------------------------
def abs_path(relpath):
    p = (LIB_DIR / relpath).resolve()
    if LIB_DIR not in p.parents:
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


def get_or_create_item(conn, category, name):
    key = norm_key(name)
    row = conn.execute(
        "SELECT * FROM items WHERE category=? AND key=?", (category, key)
    ).fetchone()
    if row:
        return row, False
    base = safe_name(name)
    taken = {r[0].lower() for r in conn.execute(
        "SELECT folder FROM items WHERE category=?", (category,))}
    folder, n = base, 2
    while folder.lower() in taken:
        folder = f"{base} ({n})"
        n += 1
    cur = conn.execute(
        "INSERT INTO items (category, name, key, folder, created_at) VALUES (?,?,?,?,?)",
        (category, name, key, folder, utcnow()),
    )
    row = conn.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,)).fetchone()
    return row, True


def remove_file(relpath):
    p = abs_path(relpath)
    try:
        p.unlink()
    except FileNotFoundError:
        pass
    try:
        p.parent.rmdir()  # 空のときだけ消える
    except OSError:
        pass


def ingest(src, filename, force_cat=None, default_cat=None):
    """src のファイルを解析して library に登録(移動)する。"""
    src = Path(src)
    if src.stat().st_size == 0:
        raise ApiError("空のファイルです")
    sha = sha256_file(src)
    info = analyze(src, filename)
    cat = force_cat or (info["category"] if info["category"] != "other" else (default_cat or "other"))
    meta = {k: info[k] for k in ("loader", "mc", "description", "pack_format") if info.get(k)}

    with LOCK:
        conn = db()
        dup = conn.execute(
            "SELECT v.id, v.version, i.id AS item_id, i.name, i.category FROM versions v "
            "JOIN items i ON i.id = v.item_id WHERE v.sha256=?", (sha,)).fetchone()
        if dup:
            return {"status": "duplicate", "filename": filename, "name": dup["name"],
                    "version": dup["version"], "category": dup["category"], "item_id": dup["item_id"]}
        try:
            item, created = get_or_create_item(conn, cat, info["name"])
            dest_dir = LIB_DIR / CATEGORIES[cat][0] / item["folder"]
            dest_dir.mkdir(parents=True, exist_ok=True)
            fname = safe_name(Path(filename).name, "file", 200)
            canonical = dest_dir / fname
            if canonical.exists() and src.resolve() == canonical.resolve():
                dest = canonical  # すでに正しい場所にある(再スキャン時)
            else:
                dest = unique_path(dest_dir, fname)
            relpath = dest.relative_to(LIB_DIR).as_posix()
            conn.execute(
                "INSERT INTO versions (item_id, version, filename, relpath, size, sha256, meta, added_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (item["id"], info["version"], dest.name, relpath, src.stat().st_size, sha,
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


def build_library(conn):
    items = {r["id"]: dict(r, versions=[]) for r in conn.execute("SELECT * FROM items")}
    for r in conn.execute("SELECT * FROM versions"):
        d = dict(r)
        try:
            d["meta"] = json.loads(d["meta"] or "{}")
        except ValueError:
            d["meta"] = {}
        d["missing"] = not (LIB_DIR / d.pop("relpath")).exists()
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


@app.get("/api/library")
def api_library():
    conn = db()
    items = build_library(conn)
    return jsonify(
        items=items,
        categories={k: v[1] for k, v in CATEGORIES.items()},
        storage={"path": str(DATA_DIR), "inbox": str(INBOX_DIR)},
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
    """inbox/ 内のファイルと、DB未登録のlibrary内ファイルを取り込む。"""
    conn = db()
    known = {r[0] for r in conn.execute("SELECT relpath FROM versions")}
    targets = []  # (path, default_cat)
    for p in sorted(INBOX_DIR.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            targets.append((p, None))
    rev = {v[0]: k for k, v in CATEGORIES.items()}
    for p in sorted(LIB_DIR.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        rel = p.relative_to(LIB_DIR).as_posix()
        if rel not in known:
            top = rel.split("/", 1)[0]
            targets.append((p, rev.get(top)))
    added = dup = 0
    errors = []
    for p, default_cat in targets:
        try:
            r = ingest(p, p.name, default_cat=default_cat)
            if r["status"] == "added":
                added += 1
            else:
                dup += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"{p.name}: {getattr(e, 'message', e)}")
    # 取り込みで空になったフォルダを片付ける(inbox本体・カテゴリフォルダは残す)
    keep = {INBOX_DIR} | {LIB_DIR / v[0] for v in CATEGORIES.values()}
    for root in (INBOX_DIR, LIB_DIR):
        for d in sorted((x for x in root.rglob("*") if x.is_dir()), key=lambda x: len(x.parts), reverse=True):
            if d not in keep:
                try:
                    d.rmdir()
                except OSError:
                    pass
    missing = sum(1 for r in conn.execute("SELECT relpath FROM versions")
                  if not (LIB_DIR / r[0]).exists())
    return jsonify(added=added, duplicates=dup, errors=errors, missing=missing,
                   scanned=len(targets))


@app.get("/api/versions/<int:vid>/download")
def api_download(vid):
    row = db().execute("SELECT relpath, filename FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        raise ApiError("見つかりません", 404)
    p = abs_path(row["relpath"])
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
    with LOCK:
        conn.execute("DELETE FROM versions WHERE id=?", (vid,))
        left = conn.execute("SELECT COUNT(*) FROM versions WHERE item_id=?", (row["item_id"],)).fetchone()[0]
        if left == 0:
            conn.execute("DELETE FROM items WHERE id=?", (row["item_id"],))
        conn.commit()
        remove_file(row["relpath"])
    return jsonify(ok=True)


@app.delete("/api/items/<int:iid>")
def api_delete_item(iid):
    conn = db()
    rows = conn.execute("SELECT relpath FROM versions WHERE item_id=?", (iid,)).fetchall()
    if not conn.execute("SELECT 1 FROM items WHERE id=?", (iid,)).fetchone():
        raise ApiError("見つかりません", 404)
    with LOCK:
        conn.execute("DELETE FROM items WHERE id=?", (iid,))
        conn.commit()
        for r in rows:
            remove_file(r["relpath"])
    return jsonify(ok=True)


@app.patch("/api/items/<int:iid>")
def api_patch_item(iid):
    """名前・種類の変更。同じ名前・種類の項目が既にあれば統合される。"""
    data = request.get_json(silent=True) or {}
    conn = db()
    item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
    if not item:
        raise ApiError("見つかりません", 404)
    new_cat = data.get("category", item["category"])
    if new_cat not in CATEGORIES:
        raise ApiError("category が不正です")
    new_name = str(data.get("name", item["name"]) or "").strip()
    if not new_name:
        raise ApiError("名前を入力してください")

    moved = []  # (dest, src) 失敗時に戻す用
    with LOCK:
        try:
            target, _created = get_or_create_item(conn, new_cat, new_name)
            if target["id"] == item["id"]:
                conn.execute("UPDATE items SET name=? WHERE id=?", (new_name, iid))
            else:
                dest_dir = LIB_DIR / CATEGORIES[new_cat][0] / target["folder"]
                dest_dir.mkdir(parents=True, exist_ok=True)
                old_rel = []
                for v in conn.execute("SELECT * FROM versions WHERE item_id=?", (iid,)).fetchall():
                    src = LIB_DIR / v["relpath"]
                    dest = unique_path(dest_dir, v["filename"])
                    if src.exists():
                        shutil.move(str(src), str(dest))
                        moved.append((dest, src))
                    old_rel.append(v["relpath"])
                    conn.execute(
                        "UPDATE versions SET item_id=?, relpath=?, filename=? WHERE id=?",
                        (target["id"], dest.relative_to(LIB_DIR).as_posix(), dest.name, v["id"]),
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
        old_dir = LIB_DIR / CATEGORIES[item["category"]][0] / item["folder"]
        try:
            old_dir.rmdir()
        except OSError:
            pass
    return jsonify(ok=True)


init_storage()

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"MC Pack Library: http://{host}:{port}  (保存先: {DATA_DIR})")
    app.run(host=host, port=port, threaded=True)
