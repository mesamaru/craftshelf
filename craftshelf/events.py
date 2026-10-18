"""CraftShelf: 操作の記録(監査ログ)と Discord への通知。"""

from flask import g, jsonify, request

import notify

from .core import ApiError, _jl, app, db, get_setting, utcnow
from .auth import current_user, decrypt_secret, require_perm, role_level, user_perms


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
    _remember(event, title, lines, level)
    try:
        url = decrypt_secret(get_setting("discord_webhook"))
        if not url:
            return
        events = _jl(get_setting("discord_events", ""), DEFAULT_EVENTS) or []
        if event in events:
            notify.send(url, f"CraftShelf: {title}", lines, level)
    except Exception:  # noqa: BLE001
        app.logger.exception("notify")


# ==========================================================================
# お知らせセンター(パネルの中で、Discord と同じ出来事を見られる)
# ==========================================================================
# 出来事ごとに、誰に見せるか: all = 全員 / editor = 編集者以上 / admin = 管理者 / perm:xxx = その権限を持つ人
AUDIENCE = {"updates": "all", "downloaded": "all", "servers": "editor", "errors": "admin",
            "backup": "perm:storage", "selfupdate": "perm:system"}
NOTIFY_KEEP = 500


def _remember(event, title, lines, level):
    try:
        conn = db()
        conn.execute("INSERT INTO notifications (at, event, level, title, body, audience) VALUES (?,?,?,?,?,?)",
                     (utcnow(), event, level, str(title)[:300], "\n".join(str(x) for x in (lines or []))[:4000],
                      AUDIENCE.get(event, "admin")))
        conn.execute("DELETE FROM notifications WHERE id <= (SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ?)",
                     (NOTIFY_KEEP,))
        conn.commit()
    except Exception:  # noqa: BLE001
        app.logger.exception("remember notification")


def _audience_sql(u):
    """そのユーザーが見られるお知らせの条件(SQL の WHERE と値)。"""
    allowed = ["all"]
    if role_level(u) >= 2:
        allowed.append("editor")
    if u["role"] == "admin":
        allowed.append("admin")
    allowed += [f"perm:{p}" for p in user_perms(u)]
    return f"audience IN ({','.join('?' * len(allowed))})", allowed


@app.get("/api/notifications")
def api_notifications():
    u = current_user()
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
    except ValueError:
        raise ApiError("数値で指定してください")
    where, args = _audience_sql(u)
    conn = db()
    rows = conn.execute(f"SELECT id, at, event, level, title, body FROM notifications WHERE {where} ORDER BY id DESC LIMIT ?",
                        args + [limit]).fetchall()
    r = conn.execute("SELECT last_id FROM notification_reads WHERE user_id=?", (u["id"],)).fetchone()
    last = r[0] if r else 0
    unread = conn.execute(f"SELECT COUNT(*) FROM notifications WHERE {where} AND id > ?", args + [last]).fetchone()[0]
    return jsonify(entries=[dict(x) for x in rows], unread=unread, last_read=last)


@app.post("/api/notifications/read")
def api_notifications_read():
    """ここまで読んだ、を記録する(upto を省くと、いまある分すべて)。"""
    u = current_user()
    data = request.get_json(silent=True) or {}
    conn = db()
    try:
        upto = int(data.get("upto") or conn.execute("SELECT COALESCE(MAX(id), 0) FROM notifications").fetchone()[0])
    except (TypeError, ValueError):
        raise ApiError("数値で指定してください")
    conn.execute("INSERT INTO notification_reads (user_id, last_id) VALUES (?, ?) "
                 "ON CONFLICT(user_id) DO UPDATE SET last_id=MAX(last_id, excluded.last_id)", (u["id"], upto))
    conn.commit()
    return jsonify(ok=True)


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
