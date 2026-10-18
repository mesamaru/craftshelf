"""CraftShelf: パネル全体の設定・自分のアップデート・バックアップ・利用状況・予約の処理。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
import uuid
import zipfile

from flask import jsonify, request, send_file
import requests

from storage import StorageError
import notify
import selfupdate

from . import core
from .core import APP_NAME, ApiError, BASE_DIR, CONFIG_DIR, DATA_READ, DATA_WRITE, PERMS, RESTORE_MARK, SECRET_KEY_PATH, SNAPSHOT_DIR, TMP_DIR, _jl, _truthy, app, db, get_setting, running_version, safe_name, set_setting, snapshot_data, utcnow
from .analysis import _MC_REL
from .auth import current_user, decrypt_secret, encrypt_secret, has_perm, require, require_perm, user_perms, user_prefs
from .events import DEFAULT_EVENTS, audit, notify_event, prune_audit
from .jobs import start_job
from .library import DEPS_VERSION, _item_versions, _rescan_deps_job, open_store
from .accounts import BG_DIR
from .upstream import _bulk_job
from .servers import _server_schedule_tick, server_inventory


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
        _set_channel(data["update_channel"] if data["update_channel"] in selfupdate.CHANNELS else "stable")
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
# CraftShelf 自身の更新(GitHub から)
# --------------------------------------------------------------------------
@app.get("/api/system/info")
def api_system_info():
    return jsonify(name=APP_NAME, version=running_version(), build=selfupdate.build_info(),
                   repo=selfupdate.REPO, branch=selfupdate.branch(), channel=selfupdate.CHANNEL)


@app.get("/api/system/update")
@require_perm("system")
def api_system_update_check():
    return jsonify({**selfupdate.check(force=_truthy(request.args.get("force"))),
                    "this_format": {"write": DATA_WRITE, "read": DATA_READ}, "data_too_new": core.DATA_TOO_NEW})


@app.get("/api/system/snapshots")
@require_perm("system")
def api_system_snapshots():
    """アップデートの前の状態の一覧(新しい順)。"""
    out = []
    if SNAPSHOT_DIR.exists():
        for d in sorted((x for x in SNAPSHOT_DIR.iterdir() if x.is_dir() and (x / "index.db").is_file()), reverse=True):
            meta = _jl((d / "meta.json").read_text(encoding="utf-8") if (d / "meta.json").exists() else "", {})
            fmt = int(meta.get("data_format") or 1)
            out.append({"name": d.name, "version": meta.get("version") or "", "created_at": meta.get("created_at") or "",
                        "reason": meta.get("reason") or ("戻す前のデータ" if d.name.startswith("before-restore-") else ""),
                        "data_format": fmt, "size": (d / "index.db").stat().st_size, "can_restore": fmt <= DATA_READ})
    return jsonify(snapshots=out, pending=RESTORE_MARK.read_text(encoding="utf-8").strip() if RESTORE_MARK.exists() else "",
                   frozen=selfupdate.FROZEN)


@app.post("/api/system/snapshots/<name>/restore")
@require_perm("system")
def api_system_snapshot_restore(name):
    """次の起動で、この退避の状態にデータベースを戻す(いまのデータも残しておく)。"""
    d = SNAPSHOT_DIR / name
    if "/" in name or "\\" in name or name.startswith(".") or not (d / "index.db").is_file():
        raise ApiError("退避が見つかりません", 404)
    meta = _jl((d / "meta.json").read_text(encoding="utf-8") if (d / "meta.json").exists() else "", {})
    if int(meta.get("data_format") or 1) > DATA_READ:
        raise ApiError("この版では、その退避のデータを読めません")
    RESTORE_MARK.write_text(name + "\n", encoding="utf-8")
    audit("アップデートの前の状態に戻す", name, "次の起動で戻します")
    if not selfupdate.FROZEN:
        selfupdate.restart()
    return jsonify(ok=True, restart=not selfupdate.FROZEN)


def _self_update_job(job):
    try:
        name = snapshot_data("アップデートの前")
        job.note(f"アップデートの前の状態を退避しました({name})")
    except (OSError, sqlite3.Error) as e:
        raise ApiError(f"アップデートの前の退避に失敗したため中止しました: {e}") from e
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
    if info.get("blocked"):
        raise ApiError(info["blocked"], 409)
    if not info["update_available"] and not info.get("downgrade"):
        raise ApiError(f"すでに最新です({info['current']})", 409)
    job = start_job("selfupdate", f"{APP_NAME} の更新 ({info['current']} → {info['latest']})",
                    _self_update_job, user=current_user()["username"])
    return jsonify(job.public())



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


_BG_NAME = re.compile(r"^backgrounds/[\w.\-]{1,120}$")


def stage_backup_restore(zpath, label):
    """バックアップの zip を確かめて、アップデートの前の状態と同じ置き場所に展開し、次の起動で戻す印を付ける。"""
    try:
        z = zipfile.ZipFile(zpath)
    except (zipfile.BadZipFile, OSError):
        raise ApiError("CraftShelf のバックアップ(zip)ではありません")
    with z:
        names = set(z.namelist())
        if "index.db" not in names:
            raise ApiError("バックアップに登録情報(index.db)が入っていません")
        if sum(i.file_size for i in z.infolist()) > 8 * 1024 ** 3:
            raise ApiError("バックアップが大きすぎます")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        d = SNAPSHOT_DIR / f"{stamp}-backup"
        n = 1
        while d.exists():
            n += 1
            d = SNAPSHOT_DIR / f"{stamp}-backup-{n}"
        d.mkdir(parents=True)
        try:
            with z.open("index.db") as src, open(d / "index.db", "wb") as dst:
                shutil.copyfileobj(src, dst)
            if "secret.key" in names:
                (d / "secret.key").write_bytes(z.read("secret.key"))
            bgs = [x for x in names if _BG_NAME.match(x)]
            if bgs:
                (d / "backgrounds").mkdir()
                for x in bgs:
                    (d / x).write_bytes(z.read(x))
            # 中身を確かめる(壊れていないか・この版で読める保存方法か)
            try:
                c = sqlite3.connect(f"file:{d / 'index.db'}?mode=ro", uri=True)
                try:
                    ok = c.execute("PRAGMA integrity_check").fetchone()[0]
                    users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
                    row = c.execute("SELECT value FROM settings WHERE key='data_format'").fetchone()
                finally:
                    c.close()
            except sqlite3.Error:
                raise ApiError("バックアップの登録情報(index.db)を読めません")
            if ok != "ok":
                raise ApiError("バックアップの登録情報(index.db)が壊れています")
            if not users:
                raise ApiError("バックアップにユーザーが 1 人もいません")
            fmt = int(row[0]) if row and str(row[0]).isdigit() else 1
            if fmt > DATA_READ:
                raise ApiError(f"このバックアップは新しい保存方法({fmt})で作られているため、この版では戻せません")
            (d / "meta.json").write_text(json.dumps({
                "version": "", "created_at": utcnow(), "reason": f"バックアップから戻す({label})",
                "data_format": fmt}, ensure_ascii=False), encoding="utf-8")
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
    RESTORE_MARK.write_text(d.name + "\n", encoding="utf-8")
    return d.name


def _finish_restore(label):
    audit("バックアップから戻す", label, "次の起動で戻します")
    if not selfupdate.FROZEN:
        selfupdate.restart()
    return jsonify(ok=True, restart=not selfupdate.FROZEN)


@app.post("/api/backup/restore/<name>")
@require("admin")
def api_backup_restore(name):
    """保存先にあるバックアップから戻す(次の起動で入れ替える。いまのデータも残す)。"""
    if not _BACKUP_NAME.match(name):
        raise ApiError("見つかりません", 404)
    store, _t = _backup_store()
    rel = f"{BACKUP_DIR}/{name}"
    if not store.exists(rel):
        raise ApiError("見つかりません", 404)
    tmp = TMP_DIR / f"restore-{uuid.uuid4().hex}.zip"
    try:
        store.fetch(rel, tmp)
        stage_backup_restore(tmp, name)
    finally:
        tmp.unlink(missing_ok=True)
    return _finish_restore(name)


@app.post("/api/backup/restore-upload")
@require("admin")
def api_backup_restore_upload():
    """手元のバックアップの zip を送って戻す(入れ直したあとなど、保存先を設定する前でも使える)。"""
    f = request.files.get("file")
    if not f:
        raise ApiError("ファイルを選んでください")
    tmp = TMP_DIR / f"restore-{uuid.uuid4().hex}.zip"
    try:
        f.save(tmp)
        stage_backup_restore(tmp, safe_name(f.filename or "upload.zip")[:80])
    finally:
        tmp.unlink(missing_ok=True)
    return _finish_restore(f.filename or "upload.zip")


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
    # 自動アップデートでは、メジャー版をまたぐ更新・切り替えられない版には進まない(手動で選んでもらう)
    if info["update_available"] and info.get("can_apply", True) and get_setting("self_auto_update", "0") == "1" \
            and not info.get("major_up") and not info.get("blocked"):
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
