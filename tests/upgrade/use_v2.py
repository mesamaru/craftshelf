"""今の版(02)の機能を使って、02 で足した表にデータを入れる(このあと橋渡しの版で開けるか・また 02 で開けるかを試す)。"""
import os, sys, sqlite3
os.environ["DATA_DIR"] = sys.argv[2]; os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
check(c.post("/api/auth/login", json={"username": "boss", "password": "password123"}).status_code == 200, "admin logs in on 02")
with A.app.app_context():
    A.notify_event("updates", "v2-notice", ["from 02"])
    conn = A.db()
    srv = conn.execute("SELECT id FROM servers").fetchone()[0]
    uid, created = conn.execute("SELECT id, created_at FROM users WHERE username='boss'").fetchone()
    conn.execute("INSERT INTO server_file_history (server_id, path, saved_at, username, size, content) VALUES (?,?,?,?,?,?)",
                 (srv, "server.properties", "2026-10-19T00:00:00Z", "boss", 5, b"motd="))
    conn.execute("INSERT INTO passkeys (user_id, user_created, credential_id, public_key, sign_count, name, created_at) VALUES (?,?,?,?,?,?,?)",
                 (uid, created, "v2-credential", b"pk", 3, "v2-key", "2026-10-19T00:00:00Z"))
    conn.commit()
c.post("/api/notifications/read", json={})
c.post("/api/setup/guide", json={"mark": "notify"})
g = c.get("/api/setup/guide").get_json()
check(any(s["id"] == "notify" and s["done"] for s in g["steps"]), "setup guide state saved")
db = sqlite3.connect(A.DB_PATH)
done = {r[0] for r in db.execute("SELECT id FROM schema_migrations")}
check({m[0] for m in A.MIGRATIONS} <= done, f"all migrations recorded ({len(done)})")
check(db.execute("SELECT value FROM settings WHERE key='data_format'").fetchone()[0] == "2", "data format is 2")
print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
