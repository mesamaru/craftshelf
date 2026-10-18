"""お知らせセンター: 記録・見られる人の範囲・未読の数・既読。"""
import os, sys, tempfile
tmp = tempfile.mkdtemp(prefix="cs-ntc-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


H = {"X-Requested-With": "mcpl"}
admin = A.app.test_client()
admin.post("/api/auth/setup", json={"username": "admin", "password": "password123"}, headers=H)
admin.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
admin.post("/api/users", json={"username": "vw", "password": "password123", "role": "viewer"}, headers=H)
ed, vw = A.app.test_client(), A.app.test_client()
ed.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
vw.post("/api/auth/login", json={"username": "vw", "password": "password123"}, headers=H)

with A.app.app_context():
    A.notify_event("updates", "新しいバージョンが 1 件あります", ["A 1.0 → 1.1"])
    A.notify_event("servers", "survival にプラグインを送りました", ["3 件"])
    A.notify_event("errors", "更新の確認で 1 件のエラー", ["接続できません"], "error")
    A.notify_event("backup", "バックアップを作成しました", [])

titles = lambda c: [e["title"] for e in c.get("/api/notifications", headers=H).get_json()["entries"]]  # noqa: E731
check(len(titles(admin)) == 4, "admin sees every notification")
check(sorted(titles(ed)) == sorted(["新しいバージョンが 1 件あります", "survival にプラグインを送りました"]), f"editor sees updates + servers ({titles(ed)})")
check(titles(vw) == ["新しいバージョンが 1 件あります"], f"viewer sees only updates ({titles(vw)})")

d = vw.get("/api/notifications", headers=H).get_json()
check(d["unread"] == 1 and d["entries"][0]["body"] == "A 1.0 → 1.1", "unread count and body")
check(vw.post("/api/notifications/read", json={}, headers=H).status_code == 200, "mark all as read")
check(vw.get("/api/notifications", headers=H).get_json()["unread"] == 0, "nothing unread after reading")
check(admin.get("/api/notifications", headers=H).get_json()["unread"] == 4, "reading is per user")
check(vw.post("/api/notifications/read", json={"upto": "x"}, headers=H).status_code == 400, "bad upto is refused")
check(vw.post("/api/notifications/read", json={}).status_code == 403, "read needs the CSRF header")
check(A.app.test_client().get("/api/notifications", headers=H).status_code == 401, "not logged in → 401")

with A.app.app_context():
    for i in range(A.NOTIFY_KEEP + 20):
        A.notify_event("updates", f"n{i}", [])
    n = A.db().execute("SELECT COUNT(*) FROM notifications").fetchone()[0]
check(n == A.NOTIFY_KEEP, f"old notifications are pruned ({n})")

with A.app.app_context():
    done = [r[0] for r in A.db().execute("SELECT id FROM schema_migrations")]
check("02.01.00-notifications" in done, "migration is recorded")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
