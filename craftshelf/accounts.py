"""CraftShelf: ユーザー・ログインの API・個人の設定(テーマ・背景)。"""

from urllib.parse import quote
import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
import time

from flask import g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from .core import APP_NAME, ApiError, CONFIG_DIR, LOCK, PERMS, ROLES, _jl, app, db, norm_key, running_version, utcnow
from .auth import _DUMMY_HASH, _USERNAME_RE, _check_new_credentials, _clean_widgets, _login, _token_hash, _too_many_failures, current_user, require, require_perm, user_perms, user_prefs, user_public
from .events import audit


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
    if data.get("reset_passkeys"):  # 端末を紛失した・乗っ取られたとき、そのユーザーのパスキーをすべて無効にする
        n = conn.execute("DELETE FROM passkeys WHERE user_id=?", (uid,)).rowcount
        audit("パスキーをすべて削除", u["username"], f"{n} 件")
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
    conn.execute("DELETE FROM passkeys WHERE user_id=?", (uid,))
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
# パスキー(WebAuthn。指紋・顔・PIN・セキュリティキーでログイン)
# ==========================================================================
# ブラウザの決まりで、HTTPS(か localhost)の名前で開いたときだけ使える(IP アドレスでは使えない)
def _rp():
    """呼び出し元の画面のオリジンと RP ID。Origin の名前が、届いた Host と同じときだけ受け付ける
    (リバースプロキシの後ろでも動くように。署名は RP ID に結び付くので、ほかのサイトからは使えない)。"""
    from urllib.parse import urlsplit
    origin = request.headers.get("Origin", "")
    o = urlsplit(origin)
    host = urlsplit("//" + (request.host or "")).hostname or ""
    if not o.hostname or o.hostname.lower() != host.lower():
        raise ApiError("パスキーを使えない接続です(画面を開き直してください)", 400)
    name = o.hostname.lower()
    if o.scheme != "https" and name != "localhost" and not name.endswith(".localhost"):
        raise ApiError("パスキーは HTTPS で開いたときだけ使えます", 400)
    if re.fullmatch(r"[\d.]+|[0-9a-f:]+", name):
        raise ApiError("パスキーは IP アドレスでは使えません。名前(ドメイン)で開いてください", 400)
    return origin, name


def _b64e(b):
    return base64.urlsafe_b64encode(b).decode()


def _passkey_public(r):
    return {"id": r["id"], "name": r["name"], "created_at": r["created_at"], "last_used": r["last_used"]}


@app.get("/api/me/passkeys")
def api_passkeys_list():
    """自分のパスキーの一覧。"""
    rows = db().execute("SELECT * FROM passkeys WHERE user_id=? ORDER BY id", (current_user()["id"],)).fetchall()
    return jsonify(passkeys=[_passkey_public(r) for r in rows])


@app.post("/api/me/passkeys/options")
def api_passkeys_register_options():
    """パスキーを登録する準備(ブラウザに渡す設定)。"""
    import webauthn
    from webauthn.helpers import base64url_to_bytes
    from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                          ResidentKeyRequirement, UserVerificationRequirement)
    u = current_user()
    _origin, rp_id = _rp()
    have = db().execute("SELECT credential_id FROM passkeys WHERE user_id=?", (u["id"],)).fetchall()
    opts = webauthn.generate_registration_options(
        rp_id=rp_id, rp_name=APP_NAME, user_name=u["username"], user_id=hashlib.sha256(f"{u['id']}:{u['created_at']}".encode()).digest()[:32],
        authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.REQUIRED,
                                                               user_verification=UserVerificationRequirement.REQUIRED),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(r[0])) for r in have])
    session["pk_reg"] = {"challenge": _b64e(opts.challenge), "at": time.time()}
    return app.response_class(webauthn.options_to_json(opts), mimetype="application/json")


@app.post("/api/me/passkeys")
def api_passkeys_register():
    """パスキーを登録する(ブラウザが作った公開鍵を確かめて保存)。"""
    import webauthn
    from webauthn.helpers import bytes_to_base64url
    from webauthn.helpers.exceptions import InvalidRegistrationResponse
    u = current_user()
    origin, rp_id = _rp()
    pend = session.pop("pk_reg", None)
    if not pend or time.time() - pend["at"] > 300:
        raise ApiError("時間が経ちすぎました。もう一度お試しください")
    data = request.get_json(silent=True) or {}
    cred = data.get("credential") or {}
    try:
        v = webauthn.verify_registration_response(credential=cred, expected_challenge=base64.urlsafe_b64decode(pend["challenge"]),
                                                  expected_rp_id=rp_id, expected_origin=origin, require_user_verification=True)
    except (InvalidRegistrationResponse, ValueError, KeyError, TypeError) as e:
        raise ApiError(f"パスキーを確かめられませんでした({e})")
    name = str(data.get("name") or "").strip()[:60] or "パスキー"
    transports = ",".join(str(t) for t in ((cred.get("response") or {}).get("transports") or []))[:200]
    conn = db()
    cid = bytes_to_base64url(v.credential_id)
    if conn.execute("SELECT 1 FROM passkeys WHERE credential_id=?", (cid,)).fetchone():
        raise ApiError("このパスキーはすでに登録されています", 409)
    conn.execute("INSERT INTO passkeys (user_id, user_created, credential_id, public_key, sign_count, name, transports, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?)", (u["id"], u["created_at"], cid, v.credential_public_key, v.sign_count, name, transports, utcnow()))
    conn.commit()
    audit("パスキーを登録", u["username"], name)
    return jsonify(ok=True)


@app.patch("/api/me/passkeys/<int:pid>")
def api_passkeys_rename(pid):
    """パスキーの名前を変える。"""
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()[:60]
    if not name:
        raise ApiError("名前を入力してください")
    conn = db()
    if not conn.execute("UPDATE passkeys SET name=? WHERE id=? AND user_id=?", (name, pid, current_user()["id"])).rowcount:
        raise ApiError("見つかりません", 404)
    conn.commit()
    return jsonify(ok=True)


@app.delete("/api/me/passkeys/<int:pid>")
def api_passkeys_delete(pid):
    """パスキーを削除する。"""
    conn = db()
    r = conn.execute("SELECT name FROM passkeys WHERE id=? AND user_id=?", (pid, current_user()["id"])).fetchone()
    if not r:
        raise ApiError("見つかりません", 404)
    conn.execute("DELETE FROM passkeys WHERE id=?", (pid,))
    conn.commit()
    audit("パスキーを削除", current_user()["username"], r["name"])
    return jsonify(ok=True)


@app.post("/api/auth/passkey/options")
def api_auth_passkey_options():
    """パスキーでログインする準備(ユーザー名の入力は要らない)。"""
    import webauthn
    from webauthn.helpers.structs import UserVerificationRequirement
    _origin, rp_id = _rp()
    opts = webauthn.generate_authentication_options(rp_id=rp_id, user_verification=UserVerificationRequirement.REQUIRED)
    session["pk_auth"] = {"challenge": _b64e(opts.challenge), "at": time.time()}
    return app.response_class(webauthn.options_to_json(opts), mimetype="application/json")


@app.post("/api/auth/passkey")
def api_auth_passkey():
    """パスキーでログインする(指紋・顔・PIN の確認つきなので、二段階認証のコードは求めない)。"""
    import webauthn
    from webauthn.helpers.exceptions import InvalidAuthenticationResponse
    origin, rp_id = _rp()
    key = "ip:" + (request.remote_addr or "")
    if _too_many_failures(key):
        raise ApiError("ログインの失敗が続いたため、しばらく(10分ほど)待ってからお試しください", 429)
    pend = session.pop("pk_auth", None)
    if not pend or time.time() - pend["at"] > 300:
        raise ApiError("時間が経ちすぎました。もう一度お試しください", 401)
    cred = (request.get_json(silent=True) or {}).get("credential") or {}
    conn = db()
    r = conn.execute("SELECT * FROM passkeys WHERE credential_id=?", (str(cred.get("id") or "")[:500],)).fetchone()
    u = conn.execute("SELECT * FROM users WHERE id=?", (r["user_id"],)).fetchone() if r else None
    if not r or not u or (r["user_created"] and r["user_created"] != u["created_at"]):
        _too_many_failures(key, add=True)
        raise ApiError("このパスキーは登録されていません", 401)
    try:
        v = webauthn.verify_authentication_response(credential=cred, expected_challenge=base64.urlsafe_b64decode(pend["challenge"]),
                                                    expected_rp_id=rp_id, expected_origin=origin, credential_public_key=bytes(r["public_key"]),
                                                    credential_current_sign_count=r["sign_count"], require_user_verification=True)
    except (InvalidAuthenticationResponse, ValueError, KeyError, TypeError):
        _too_many_failures(key, add=True)
        raise ApiError("パスキーを確かめられませんでした", 401)
    conn.execute("UPDATE passkeys SET sign_count=?, last_used=? WHERE id=?", (v.new_sign_count, utcnow(), r["id"]))
    conn.commit()
    _login(u)
    audit("ログイン(パスキー)", u["username"], r["name"], user=u["username"])
    return jsonify(ok=True, user=user_public(u))
