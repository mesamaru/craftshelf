"""v01.12.00 で作ったデータを、新しいコードで開いて確かめる。"""
import os, sys, sqlite3
os.environ["DATA_DIR"] = sys.argv[2]; os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
check(c.post("/api/auth/login", json={"username": "boss", "password": "password123"}).status_code == 200, "existing admin can log in")
me = c.get("/api/auth/me").get_json()
check(me["user"]["role"] == "admin" and me["prefs"].get("theme") == "aurora", "admin role and personal prefs kept")
lib = c.get("/api/library").get_json()
items = lib["items"]
check(len(items) == 3 and sum(len(i["versions"]) for i in items) == 4, f"all items/versions visible to admin ({len(items)} items)")
check(all(i["access"] == "owner" for i in items), "admin owns all migrated items")
check(not any(v["missing"] for i in items for v in i["versions"]), "no file reported missing")
lp = [i for i in items if i["name"] == "LuckPerms"][0]
check(lp.get("source") and lp["source"]["page_url"].startswith("https://modrinth.com"), "source link kept")
vid = items[0]["versions"][0]["id"]
r = c.get(f"/api/versions/{vid}/download")
check(r.status_code == 200 and len(r.data) > 0, "download still works")
sets = c.get("/api/sets").get_json()["sets"]
check(len(sets) == 1 and len(sets[0]["items"]) == 2, "set kept with its items")
srv = c.get("/api/servers").get_json()["servers"]
check(len(srv) == 1 and srv[0]["access"] == "owner", "server kept and owned by admin")
shares = c.get("/api/shares").get_json()["shares"]
check(len(shares) == 1, "old share link visible to admin")
url = open(os.path.join(sys.argv[2], "share_url.txt")).read()
token = url.split("/s/")[1].split("/")[0]
check(c.get(f"/s/{token}").status_code == 200, "old share link still downloads")

h = A.app.test_client(); h.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
check(h.post("/api/auth/login", json={"username": "helper", "password": "password123"}).status_code == 200, "existing editor can log in")
check(h.get("/api/library").get_json()["items"] == [], "editor now sees only own items (expected change in 01.13)")
check(h.get("/api/shares").get_json()["shares"] == [], "editor does not see admin's old share link")
check(h.get("/api/jobs").get_json()["jobs"] == [], "editor sees no jobs of others")

db = sqlite3.connect(A.DB_PATH)
check(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "database integrity ok")
check(db.execute("PRAGMA foreign_key_check").fetchall() == [], "no broken foreign keys")
check(db.execute("SELECT COUNT(*) FROM items WHERE owner_id=0").fetchone()[0] == 0, "no item left without an owner")
print("version now", A.running_version())
print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
