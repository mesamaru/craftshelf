"""CraftShelf: 配布元(Modrinth / SpigotMC / CurseForge)との連携・検索・Modパック。"""

from pathlib import Path
import json
import os
import re
import time
import uuid
import zipfile

from flask import Response, jsonify, request

from storage import StorageError
import sources as src

from .core import ApiError, CATEGORIES, ICON_DIR, LOCK, MAX_UPLOAD, TMP_DIR, _jl, _truthy, app, db, get_setting, norm_key, safe_name, utcnow
from .analysis import _MC_REL
from .auth import cf_api_key, current_user, get_item_checked, require, visible_item_ids
from .events import audit, notify_event
from .jobs import start_job
from .library import _item_versions, _uid_of, active_store, ingest, lib_rel, open_store, require_same_target


def source_public(r):
    return {
        "provider": r["provider"], "provider_label": src.PROVIDERS.get(r["provider"], r["provider"]),
        "project_id": r["project_id"], "title": r["title"], "page_url": r["page_url"],
        "loaders": _jl(r["loaders"], []), "game_versions": _jl(r["game_versions"], []),
        "linked_by": r["linked_by"], "status": r["status"], "message": r["message"],
        "latest": _jl(r["latest"], {}), "checked_at": r["checked_at"],
        "icon_v": _icon_version(r["item_id"]), "channel": r["channel"] if "channel" in r.keys() else "",
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


_PRERELEASE = re.compile(r"(snapshot|alpha|beta|\bpre(?=[0-9.\-]|$)|\brc\d*\b|-dev|nightly)", re.I)


def _stable_only(conn, item_id, s=None):
    """正式版だけを探すか。アドオンごとの指定 → 無ければ全体の設定。
    ただし、保存している版やサーバーに入っている版がスナップショット・ベータなら、ベータ版も探す
    (正式版だけを見ると、一つ前の正式版を「最新」と表示してしまうため)。"""
    s = s or conn.execute("SELECT * FROM item_sources WHERE item_id=?", (item_id,)).fetchone()
    ch = (s["channel"] if s is not None and "channel" in s.keys() else "") or ""
    if ch == "all":
        return False
    if ch == "release":
        return True
    if get_setting("stable_only", "1") != "1":
        return False
    vers = [r[0] for r in conn.execute("SELECT version FROM versions WHERE item_id=?", (item_id,))]
    item = conn.execute("SELECT name FROM items WHERE id=?", (item_id,)).fetchone()
    if item:
        key = norm_key(item["name"])
        vers += [r["version"] for r in conn.execute("SELECT plugin_name, version FROM server_files") if norm_key(r["plugin_name"]) == key]
    return not any(_PRERELEASE.search(v or "") for v in vers)


def check_item(conn, item):
    """紐付けた配布元の最新版を確認し、保存済みと比べて状態を記録する。"""
    s = conn.execute("SELECT * FROM item_sources WHERE item_id=?", (item["id"],)).fetchone()
    if not s:
        raise ApiError("配布元が紐付けられていません")
    status, message, info = "error", "", {}
    try:
        info = src.latest(s["provider"], s["project_id"], loaders=_jl(s["loaders"], []),
                          game_versions=_jl(s["game_versions"], []),
                          stable_only=_stable_only(conn, item["id"], s), api_key=cf_api_key())
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
        if "channel" in data:
            if data["channel"] not in ("", "all", "release"):
                raise ApiError("受け取る版の指定が不正です")
            conn.execute("UPDATE item_sources SET channel=? WHERE item_id=?", (data["channel"], iid))
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
                                 stable_only=_stable_only(conn, iid, s), api_key=cf_api_key())
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
