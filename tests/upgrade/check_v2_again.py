"""橋渡しの版(01.24)で使ったあと、また今の版(02)で開いて、02 のデータが残っているかを確かめる。"""
import os, sys, sqlite3
os.environ["DATA_DIR"] = sys.argv[2]; os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
check(c.post("/api/auth/login", json={"username": "boss", "password": "password123"}).status_code == 200, "admin logs in on 02 again")
n = c.get("/api/notifications").get_json()
check(any(e["title"] == "v2-notice" for e in n["entries"]) and n["unread"] == 0, "notification and read state kept")
g = c.get("/api/setup/guide").get_json()
check(any(s["id"] == "notify" and s["done"] for s in g["steps"]), "setup guide state kept")
db = sqlite3.connect(A.DB_PATH)
check(db.execute("SELECT name, sign_count FROM passkeys WHERE credential_id='v2-credential'").fetchone() == ("v2-key", 3), "passkey kept")
check(db.execute("SELECT COUNT(*) FROM server_file_history").fetchone()[0] == 1, "file history kept")
check(len(c.get("/api/library").get_json()["items"]) == 3, "library intact")
check(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "database integrity ok")
print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
