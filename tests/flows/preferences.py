import os, sys, tempfile
tmp = tempfile.mkdtemp(); os.environ.update(DATA_DIR=tmp + "/d", CONFIG_DIR=tmp + "/c", MCPL_NO_SCHEDULER="1")
sys.path.insert(0, sys.argv[1])
import app as A
fails = []


def ok(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


H = {"X-Requested-With": "mcpl"}
a = A.app.test_client()
a.post("/api/auth/setup", json={"username": "admin", "password": "password123"}, headers=H)
ok(a.get("/api/auth/me").get_json()["prefs"] == {}, "empty prefs initially")
ok(a.patch("/api/me/prefs", json={"theme": "aurora", "bg_dim": 999}, headers=H).get_json()["prefs"] == {"theme": "aurora", "bg_dim": 80}, "theme saved, dim clamped")
ok(a.patch("/api/me/prefs", json={"theme": "../x"}, headers=H).status_code == 400, "bad theme id rejected")
ok(a.patch("/api/me/prefs", json={"theme": "custom"}, headers=H).status_code == 400, "custom without image rejected")
png = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 100
r = a.put("/api/me/background", data=png, headers=H).get_json()
f = r["prefs"]["bg_file"]
ok(r["prefs"]["theme"] == "custom" and f.startswith("u1-") and f.endswith(".png"), f"upload png -> {f}")
ok(a.get(f"/api/backgrounds/{f}").status_code == 200, "background served to logged-in user")
ok(A.app.test_client().get(f"/api/backgrounds/{f}").status_code == 401, "background needs login")
ok(a.get("/api/backgrounds/..%2Fsecret.key").status_code == 404, "bg name traversal blocked")
ok(a.put("/api/me/background", data=b"<svg></svg>", headers=H).status_code == 400, "svg rejected")
ok(a.put("/api/me/background", data=png, headers={}).status_code == 403, "csrf header required")
r2 = a.put("/api/me/background", data=bytes.fromhex("ffd8ffe0") + b"\x00" * 50, headers=H).get_json()
ok(not (A.BG_DIR / f).exists() and r2["prefs"]["bg_file"].endswith(".jpg"), "old image removed on replace")
a.post("/api/users", json={"username": "bob", "password": "password123", "role": "viewer"}, headers=H)
b = A.app.test_client(); b.post("/api/auth/login", json={"username": "bob", "password": "password123"}, headers=H)
bf = b.put("/api/me/background", data=png, headers=H).get_json()["prefs"]["bg_file"]
ok(b.get("/api/auth/me").get_json()["prefs"]["theme"] == "custom" and a.get("/api/auth/me").get_json()["prefs"]["bg_file"] != bf, "prefs are per user")
uid = [u for u in a.get("/api/users").get_json()["users"] if u["username"] == "bob"][0]["id"]
a.delete(f"/api/users/{uid}", headers=H)
ok(not (A.BG_DIR / bf).exists(), "user deletion removes their image")
r = a.delete("/api/me/background", headers=H).get_json()
ok(r["prefs"]["theme"] == "aurora" and "bg_file" not in r["prefs"] and not any(A.BG_DIR.iterdir()), "delete image resets theme")
# 見た目の種類(スキン)
ok(a.patch("/api/me/prefs", json={"skin": "win95"}, headers=H).get_json()["prefs"]["skin"] == "win95", "skin saved")
ok(a.patch("/api/me/prefs", json={"skin": "nope"}, headers=H).status_code == 400, "unknown skin rejected")
ok(a.get("/api/auth/me").get_json()["prefs"]["skin"] == "win95", "skin is remembered")
print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
