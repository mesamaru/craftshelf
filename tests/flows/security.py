"""安全性: CSRF・ログインの回数制限・セキュリティヘッダー・権限・ファイルの場所の不正・共有リンク・秘密の値。"""
import io, os, sys, tempfile, zipfile
tmp = tempfile.mkdtemp(prefix="cs-sec-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


def jar(n, v):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {n}\nversion: {v}\nmain: x.Y\n"); z.writestr("x/a", v)
    return b.getvalue()


H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
check(c.post("/api/auth/setup", json={"username": "admin", "password": "password123"}, headers=H).status_code == 200, "setup")

# ---- CSRF: 画面からの印が無い書き込みは断る ----
check(c.post("/api/sets", json={"name": "x"}).status_code == 403, "write without X-Requested-With is refused")
check(c.post("/api/sets", json={"name": "x"}, headers={"X-Requested-With": "other"}).status_code == 403, "wrong X-Requested-With is refused")
check(c.post("/api/sets", json={"name": "ok"}, headers=H).status_code == 200, "write with the header works")

# ---- セキュリティヘッダー ----
r = c.get("/", headers=H)
check(r.headers.get("X-Content-Type-Options") == "nosniff" and r.headers.get("X-Frame-Options") == "DENY", "nosniff / frame deny")
csp = r.headers.get("Content-Security-Policy", "")
check("script-src 'self'" in csp and "frame-ancestors 'none'" in csp and "unsafe-eval" not in csp, "CSP blocks inline/eval scripts and framing")
check(c.get("/api/library", headers=H).headers.get("Cache-Control") == "no-store", "API responses are not cached")

# ---- 権限: 閲覧のみは書けない・管理の API は使えない ----
v = A.app.test_client()
c.post("/api/users", json={"username": "viewer2", "password": "password123", "role": "viewer"}, headers=H)
v.post("/api/auth/login", json={"username": "viewer2", "password": "password123"}, headers=H)
check(v.put("/api/upload?filename=A-1.0.jar", data=jar("A", "1.0"), headers=H).status_code == 403, "viewer cannot upload")
check(v.get("/api/users", headers=H).status_code == 403, "viewer cannot list users")
check(v.patch("/api/settings", json={"auto_download": True}, headers=H).status_code == 403, "viewer cannot change settings")
check(v.get("/api/system/snapshots", headers=H).status_code == 403, "viewer cannot see update snapshots")
check(A.app.test_client().get("/api/library", headers=H).status_code == 401, "not logged in → 401")

# ---- ログイン: 回数制限は X-Forwarded-For で逃れられない ----
c.post("/api/users", json={"username": "bob", "password": "password123", "role": "viewer"}, headers=H)
b = A.app.test_client()
codes = [b.post("/api/auth/login", json={"username": "bob", "password": f"wrong{i}"}, headers={**H, "X-Forwarded-For": f"10.9.0.{i}"}).status_code for i in range(12)]
check(429 in codes, f"repeated wrong passwords are rate limited ({codes[-3:]})")
r = b.post("/api/auth/login", json={"username": "bob", "password": "password123"}, headers={**H, "X-Forwarded-For": "10.9.9.9"})
check(r.status_code == 429, "spoofed X-Forwarded-For does not bypass the lockout")
r = A.app.test_client().post("/api/auth/login", json={"username": "nobody", "password": "x"}, headers=H)
check(r.status_code in (401, 429) and "nobody" not in r.get_data(as_text=True), "unknown user gets the same generic answer")

# ---- ファイルの場所の不正 ----
check(c.get("/static/../app.py", headers=H).status_code in (400, 404), "static path traversal blocked")
check(c.get("/static/..%2fapp.py", headers=H).status_code in (400, 404), "encoded static traversal blocked")
check(c.get("/api/backup/download/..%2f..%2findex.db", headers=H).status_code in (400, 404), "backup download traversal blocked")
check(c.post("/api/system/snapshots/..%2f..%2fx/restore", headers=H).status_code in (400, 404), "snapshot restore traversal blocked")
check(c.get("/api/backgrounds/..%2fsecret.key", headers=H).status_code in (400, 404), "background file traversal blocked")

# ---- 共有リンク ----
up = c.put("/api/upload?filename=Vault-1.7.jar", data=jar("Vault", "1.7"), headers=H).get_json()
sh = c.post("/api/shares", json={"item_ids": [up["item_id"]], "hours": 1}, headers=H).get_json()
token = sh["url"].split("/s/")[1].split("/")[0]
check(len(token) >= 24, "share token is long and random")
anon = A.app.test_client()
check(anon.get(f"/s/{token}").status_code == 200, "share link downloads without login")
check(anon.get(f"/s/{token[:-2]}xx").status_code == 404, "wrong token → 404")
with A.app.app_context():
    A.db().execute("UPDATE shares SET expires_at='2000-01-01T00:00:00Z'"); A.db().commit()
check(anon.get(f"/s/{token}").status_code in (404, 410), "expired share link no longer works")

# ---- 秘密の値は返さない ----
c.patch("/api/settings", json={"cf_api_key": "secret-cf-key-123", "discord_webhook": "https://discord.com/api/webhooks/1/secret"}, headers=H)
body = c.get("/api/settings", headers=H).get_data(as_text=True)
check("secret-cf-key-123" not in body and "webhooks/1/secret" not in body, "API keys and webhooks are never returned")
with A.app.app_context():
    raw = A.db().execute("SELECT value FROM settings WHERE key='cf_api_key'").fetchone()
check(raw and "secret-cf-key-123" not in raw[0], "API key is stored encrypted")
users = c.get("/api/users", headers=H).get_data(as_text=True)
check("password" not in users.lower().replace("password_", ""), "user list has no password hashes")

# ---- ホーム画面に追加(PWA) ----
anon = A.app.test_client()
r = anon.get("/manifest.webmanifest")
check(r.status_code == 200 and r.mimetype == "application/manifest+json" and r.get_json()["start_url"] == "/", "manifest is public")
r = anon.get("/sw.js")
check(r.status_code == 200 and "javascript" in r.mimetype and r.headers.get("Cache-Control") == "no-cache", "service worker is public, not cached")
sw = r.get_data(as_text=True)
check('startsWith("/static/")' in sw and "/api/" not in sw.split("const CACHE")[1].split("fetch(req)")[0], "service worker only caches screen files")
check(anon.get("/api/library", headers=H).status_code == 401, "API still needs login")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
