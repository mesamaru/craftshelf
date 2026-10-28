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
import v03switch

from . import auth, core
from .core import APP_NAME, ApiError, BASE_DIR, CONFIG_DIR, DATA_READ, DATA_WRITE, PERMS, RESTORE_MARK, ROLES, SECRET_KEY_PATH, SNAPSHOT_DIR, TMP_DIR, _jl, _truthy, app, db, get_setting, running_version, safe_name, set_setting, snapshot_data, utcnow
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
        raise ApiError("このバージョンでは、その退避のデータを読めません")
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



@app.get("/api/system/v03")
@require_perm("system")
def api_system_v03():
    """v03(開発版)に切り替えられるか・GitHub にある v03 の版。"""
    reason = v03switch.unsupported()
    if reason:
        return jsonify(unsupported=reason, releases=[])
    try:
        rels = v03switch.releases()[:5]
    except v03switch.SwitchError as e:
        raise ApiError(e.message, 502)
    return jsonify(unsupported=None, releases=[{k: r[k] for k in ("version", "notes", "published_at")} for r in rels])


def _v03_job(job, version):
    try:
        name = snapshot_data("v03 に切り替える前")
        job.note(f"切り替えの前の状態を退避しました({name})")
    except (OSError, sqlite3.Error) as e:
        raise ApiError(f"切り替えの前の退避に失敗したため中止しました: {e}") from e
    try:
        v03switch.install(version, note=job.note)
    except v03switch.SwitchError as e:
        raise ApiError(e.message, 502) from e
    audit("v03(開発版)に切り替え", f"v{version}", "", user=job.user)
    job.note(f"v{version} に切り替えます。再起動します(数十秒で画面が v03 に切り替わります)")
    threading.Timer(1.5, v03switch.restart).start()


@app.post("/api/system/v03")
@require_perm("system")
def api_system_v03_switch():
    """v03(開発版)の指定した版に切り替える(ダウンロードして確かめ、再起動する)。"""
    version = str((request.get_json(silent=True) or {}).get("version") or "")
    if not re.fullmatch(r"03\.\d{2}\.\d{2}", version):
        raise ApiError("版の形が違います")
    reason = v03switch.unsupported()
    if reason:
        raise ApiError(reason, 409)
    job = start_job("v03", f"v03(開発版)v{version} への切り替え", _v03_job, version, user=current_user()["username"])
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


_BG_NAME = re.compile(r"^backgrounds/[\w\-][\w.\-]{0,119}$")  # 「.」で始まる名前(.. など)は受け付けない


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
            # 中身を確かめる(壊れていないか・このバージョンで読める保存方法か)
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
                raise ApiError(f"このバックアップは新しい保存方法({fmt})で作られているため、このバージョンでは戻せません")
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
    # 自動アップデートでは、メジャーバージョンをまたぐ更新・切り替えられないバージョンには進まない(手動で選んでもらう)
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
    """受け取るバージョンを切り替える。Docker の起動スクリプトも読めるよう、ファイルにも書いておく。"""
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


# ==========================================================================
# API の説明(ルートの一覧から作るので、実際の動きとずれない)
# ==========================================================================
API_GROUPS = {"core": "全体", "auth": "ログイン・共有の配信", "events": "記録・お知らせ", "jobs": "処理(ジョブ)",
              "library": "ライブラリ・保存先・セット・共有", "accounts": "ユーザー・個人設定・トークン", "upstream": "配布元・検索",
              "servers": "サーバー", "system": "パネル全体"}


# 説明(docstring)の無い API の、ひとことの説明
API_SUMMARY = {
    "api_audit": "操作の記録(q で絞り込み・limit / offset)", "api_notifications": "お知らせの一覧と未読の数",
    "api_discord_test": "Discord にテストの通知を送る", "api_jobs": "最近の処理(ジョブ)の一覧", "api_job": "処理(ジョブ)の進み具合と記録",
    "api_library": "ライブラリのアイテムとバージョンの一覧", "api_download": "バージョンのファイルをダウンロード",
    "api_storage_list": "保存先の一覧", "api_storage_test_new": "保存先の接続を試す(登録の前)", "api_storage_test_existing": "登録済みの保存先の接続を試す",
    "api_server_acl": "サーバーを共有する相手を設定", "api_item_favorite": "お気に入りの切り替え",
    "api_storage_contents": "保存先の中身(移行の確認用)", "api_sets": "セットの一覧", "api_sets_download": "セットを zip でダウンロード",
    "api_auth_me": "ログイン中のユーザー(ログインしていなければ null)", "api_users": "ユーザーの一覧",
    "api_me_prefs": "自分の表示の設定(テーマなど)を変更", "api_me_background_upload": "背景の画像を送る",
    "api_me_background_delete": "背景の画像を消す", "api_background_file": "背景の画像",
    "api_tokens_list": "自分の APIトークンの一覧", "api_tokens_create": "APIトークンを作る(値はこのときだけ返る)",
    "api_tokens_delete": "APIトークンを無効にする", "api_auth_totp": "二段階認証のコードでログインを終える",
    "api_totp_setup": "二段階認証の準備(QR コード)", "api_totp_enable": "二段階認証をオンにする", "api_totp_disable": "二段階認証をオフにする",
    "api_auth_username": "自分のユーザー名を変更", "api_item_icon": "アイテムのアイコン",
    "api_source_detect": "配布元を自動で探す", "api_source_check": "配布元の新しいバージョンを確認",
    "api_mc_versions": "Minecraft のバージョンの一覧", "api_search_versions": "配布サイトのプロジェクトのバージョン一覧",
    "api_source_changelog": "配布元の更新内容", "api_search": "配布サイト(Modrinth・SpigotMC・CurseForge)を検索",
    "api_ptero_test": "Pterodactyl の接続を試す", "api_ptero_servers": "Pterodactyl のサーバーの一覧",
    "api_servers": "サーバーの一覧", "api_servers_inventory": "サーバーの中身(アドオンと、ライブラリとの比較)",
    "api_servers_deps_plan": "入れるアドオンの前提を調べる(一緒に入れるもの・足りないもの)",
    "api_servers_remove": "サーバーからアドオンを外す(退避して巻き戻せる)", "api_servers_logs": "最近のログ(logs/latest.log の末尾)",
    "api_servers_console": "コマンドを送る(RCON なら結果も返る)", "api_servers_files": "サーバーのフォルダの中身",
    "api_servers_file_get": "設定ファイルを読む", "api_servers_file_put": "設定ファイルを保存(前の内容は履歴に残る)",
    "api_servers_file_history": "設定ファイルの編集履歴", "api_servers_file_history_get": "履歴の時点の内容",
    "api_servers_status": "稼働状況・人数・応答の速さ", "api_servers_software": "サーバー本体のビルドと最新のビルド",
    "api_servers_world_backup": "ワールドのバックアップを始める", "api_servers_worlds": "ワールドのバックアップの一覧",
    "api_servers_world_download": "ワールドのバックアップをダウンロード", "api_servers_world_delete": "ワールドのバックアップを消す",
    "api_server_snapshots": "サーバーの変更の履歴(巻き戻し用)", "api_settings": "パネル全体の設定",
    "api_system_info": "パネルの情報(バージョン・動作環境)", "api_system_update_check": "パネルのアップデートの確認",
    "api_backup_list": "パネルのバックアップの一覧", "api_backup_download": "パネルのバックアップをダウンロード",
}


def api_reference():
    import inspect
    from .events import AUDIT_LABELS
    out = []
    for rule in app.url_map.iter_rules():
        path = str(rule.rule)
        if not path.startswith("/api/"):
            continue
        view = app.view_functions[rule.endpoint]
        need = getattr(view, "cs_need", None)
        doc = inspect.getdoc(inspect.unwrap(view)) or ""
        summary = doc.split("\n\n")[0].replace("\n", "") or API_SUMMARY.get(rule.endpoint) or AUDIT_LABELS.get(rule.endpoint, "")
        methods = sorted(m for m in rule.methods if m not in ("HEAD", "OPTIONS"))
        if need and need[0] == "role":
            need_label = f"{ROLES[need[1]][1]}以上"
        elif need:
            need_label = f"権限: {PERMS[need[1]].split('(')[0]}"
        else:
            need_label = "ログイン不要" if path in auth.PUBLIC_PATHS else "ログイン"
        out.append({"path": re.sub(r"<(?:\w+:)?(\w+)>", r"{\1}", path), "methods": methods,
                    "group": API_GROUPS.get(view.__module__.rsplit(".", 1)[-1], "その他"), "summary": summary, "need": need_label,
                    "token": not path.startswith(auth.TOKEN_BLOCKED)})
    out.sort(key=lambda e: (list(API_GROUPS.values()).index(e["group"]) if e["group"] in API_GROUPS.values() else 99, e["path"], e["methods"]))
    return out


@app.get("/api/docs")
def api_docs():
    """この API の一覧(パス・メソッド・必要な権限・説明)。"""
    return jsonify(endpoints=api_reference(), version=running_version(),
                   notes=["APIトークンは「Authorization: Bearer cs_…」で送ります(⚙ 設定 → アカウント → APIトークン)",
                          "トークンは、作るときに選んだ権限(作った人の権限まで)で動きます。ログイン・二段階認証・ユーザーの管理には使えません",
                          "画面からの書き込みには X-Requested-With: mcpl が要りますが、トークンを使うときは不要です",
                          "答えは JSON です。失敗したときは {\"error\": \"…\"} と HTTP の状態番号を返します"])


# ==========================================================================
# はじめの設定ガイド(管理者向け。実際の状態から、済んだ手順に印を付ける)
# ==========================================================================
SETUP_STEPS = ["storage", "addons", "server", "backup", "notify"]


def setup_guide(conn):
    marked = set(_jl(get_setting("setup_marked", ""), []) or [])
    n_targets = conn.execute("SELECT COUNT(*) FROM storage_targets").fetchone()[0]
    n_items = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    n_servers = conn.execute("SELECT COUNT(*) FROM servers").fetchone()[0]
    real = {"storage": n_targets > 1, "addons": n_items > 0, "server": n_servers > 0,
            "backup": bool(int(get_setting("backup_target_id", "0") or 0)), "notify": bool(get_setting("discord_webhook"))}
    steps = [{"id": s, "done": real[s] or s in marked, "skipped": s in marked and not real[s]} for s in SETUP_STEPS]
    return {"steps": steps, "hidden": get_setting("setup_hidden", "") == "1", "all_done": all(s["done"] for s in steps)}


@app.get("/api/setup/guide")
@require("admin")
def api_setup_guide():
    """はじめの設定ガイドの手順と、済んだかどうか。"""
    return jsonify(setup_guide(db()))


@app.post("/api/setup/guide")
@require("admin")
def api_setup_guide_update():
    """手順を「済み(いまは不要)」にする(mark)・戻す(unmark)、ガイドを隠す(hide)・また出す(show)。"""
    data = request.get_json(silent=True) or {}
    marked = set(_jl(get_setting("setup_marked", ""), []) or [])
    for key, add in (("mark", True), ("unmark", False)):
        step = data.get(key)
        if step is not None:
            if step not in SETUP_STEPS:
                raise ApiError("手順の指定が不正です")
            (marked.add if add else marked.discard)(step)
    set_setting("setup_marked", json.dumps(sorted(marked)))
    if "hide" in data:
        set_setting("setup_hidden", "1" if _truthy(data["hide"]) else "")
    return jsonify(setup_guide(db()))
