"""CraftShelf: 保存先・ライブラリ(取り込み・一覧・バージョン・セット・共有リンク・アクセス権)。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
import hashlib
import json
import os
import secrets
import time
import uuid
import zipfile

from flask import Response, has_request_context, jsonify, request, send_file

from storage import LocalStorage, SmbStorage, StorageError, WebDavStorage, clean_rel, join_rel, parent_rel
import selfupdate
import sources as src

from .core import APP_NAME, ApiError, CATEGORIES, LOCAL_DIR, LOCK, MAX_UPLOAD, PROTOCOLS, REMOTE_PROTOCOLS, TMP_DIR, _jl, _truthy, app, db, get_setting, norm_key, running_version, safe_name, utcnow
from .analysis import PLATFORM_IDS, analyze, auto_mc_versions, mc_max, version_key
from .auth import ACL_LEVELS, current_user, decrypt_secret, encrypt_secret, get_item_checked, get_server_checked, require, require_perm, visible_item_ids
from .events import audit
from .jobs import start_job


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
                    "version": dup["version"], "category": dup["category"], "item_id": dup["item_id"],
                    "version_id": dup["id"] if "id" in dup.keys() else None}
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
            vcur = conn.execute(
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
            "new_item": created, "version_id": vcur.lastrowid}


def build_library(conn, store, target, user=None):
    """保存先のアイテム一覧。user を渡すと、その人に見えるもの(自分の + 共有されたもの)だけにする。"""
    from .upstream import source_public  # 上の層(循環を避けるため、ここで読み込む)
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
        # 配布元の最新バージョンがどの MC まで対応しているか(保存しているバージョンより新しい場合もある)
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


def open_store(target):
    """アクティブかどうかに関係なく、その保存先に接続して store を返す。"""
    if target["protocol"] == "local" or is_connected(target):
        return store_for(target)
    return connect_target(target, db())


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


def _item_versions(conn, item_id):
    vs = conn.execute("SELECT * FROM versions WHERE item_id=?", (item_id,)).fetchall()
    return sorted(vs, key=lambda v: (version_key(v["version"]), v["added_at"], v["id"]), reverse=True)


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
