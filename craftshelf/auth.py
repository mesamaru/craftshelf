"""CraftShelf: 暗号化・ログイン・権限・アクセス権・API トークン・二段階認証・画面の配信。"""

from datetime import timedelta
from functools import wraps
from urllib.parse import quote
import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time

from flask import Response, g, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash

from storage import StorageError

from .core import AUTH_PASS, AUTH_USER, ApiError, BASE_DIR, PERMS, ROLES, SECRET_KEY_PATH, SESSION_KEY_PATH, app, db, get_setting, running_version, utcnow

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover
    Fernet = None
    InvalidToken = Exception


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
# HTTP
# --------------------------------------------------------------------------
PUBLIC_PATHS = {"/", "/sw.js", "/manifest.webmanifest", "/api/auth/me", "/api/auth/login", "/api/auth/setup", "/api/auth/logout", "/api/auth/totp"}


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
    st = BASE_DIR / "static"
    newest = max(p.stat().st_mtime for p in [*st.glob("*.js"), *st.glob("*.css"), *(st / "js").glob("*.js")])
    v = quote(running_version() + "-" + str(int(newest)))
    html = re.sub(r'(/static/[\w/.-]+\.(?:js|css))"', rf'\1?v={v}"', html)
    return Response(html, mimetype="text/html", headers={"Cache-Control": "no-cache"})


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(BASE_DIR / "static", name, max_age=0)


# ホーム画面に追加(PWA)。サービスワーカーは画面全体を受け持てるよう、いちばん上の場所から配る
@app.get("/sw.js")
def service_worker():
    resp = send_from_directory(BASE_DIR / "static", "sw.js", max_age=0, mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/manifest.webmanifest")
def web_manifest():
    return Response(json.dumps({
        "name": "CraftShelf", "short_name": "CraftShelf", "id": "/", "start_url": "/", "scope": "/",
        "display": "standalone", "background_color": "#000000", "theme_color": "#000000", "lang": "ja",
        "description": "Minecraft のアドオン(プラグイン・Mod・データパック)とサーバーをまとめて管理するパネル",
        "icons": [{"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/static/icon.svg", "sizes": "any", "type": "image/svg+xml"}],
    }, ensure_ascii=False), mimetype="application/manifest+json", headers={"Cache-Control": "no-cache"})


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
