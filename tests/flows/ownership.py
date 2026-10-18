"""複数ユーザー(持ち主・共有・権限・お気に入り)のテスト。"""
import io, os, sys, tempfile, uuid, zipfile
tmp = tempfile.mkdtemp(); os.environ["DATA_DIR"] = tmp; os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, sys.argv[1]); import app as A

fails = []
def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond: fails.append(msg)

def client():
    c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"; return c

def jar(name, ver, extra=""):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\n{extra}")
        z.writestr("x/a.txt", "same-content")  # 同じ中身(重複判定のため)
    return b.getvalue()

a = client()
check(a.post("/api/auth/setup", json={"username": "alice", "password": "password123"}).status_code == 200, "setup alice")
X = jar("WorldEdit", "7.3.0")
r = a.put("/api/upload?filename=WorldEdit-7.3.0.jar", data=X).get_json()
check(r["status"] == "added", "alice uploads WorldEdit")
wid = r["item_id"]
for u, role in (("bob", "editor"), ("carol", "viewer")):
    check(a.post("/api/users", json={"username": u, "password": "password123", "role": role}).status_code == 200, f"create {u}")
b, c = client(), client()
b.post("/api/auth/login", json={"username": "bob", "password": "password123"})
c.post("/api/auth/login", json={"username": "carol", "password": "password123"})
ids = {u["username"]: u["id"] for u in a.get("/api/users").get_json()["users"]}

# 非公開
check(b.get("/api/library").get_json()["items"] == [], "bob sees nothing by default")
check(b.get(f"/api/items/{wid}/icon").status_code == 404, "bob cannot reach alice's item (404)")
r = b.put("/api/upload?filename=WorldEdit-7.3.0.jar", data=X).get_json()
check(r["status"] == "added" and r["item_id"] != wid, "bob uploading the same file gets his own item (not 'duplicate')")
bid = r["item_id"]
check(len(a.get("/api/library").get_json()["items"]) == 1, "alice still sees only her item")

# 共有(閲覧)
check(a.put(f"/api/items/{wid}/acl", json={"shares": [{"user_id": ids["bob"], "level": "view"}]}).status_code == 200, "alice shares view with bob")
lib = {i["id"]: i for i in b.get("/api/library").get_json()["items"]}
check(wid in lib and lib[wid]["access"] == "view" and lib[wid]["owner_name"] == "alice", "bob sees shared item with access=view, owner=alice")
vid = lib[wid]["versions"][0]["id"]
check(b.get(f"/api/versions/{vid}/download").status_code == 200, "bob can download shared item")
check(b.patch(f"/api/items/{wid}", json={"name": "Hacked"}).status_code == 403, "bob cannot edit view-only item")
check(b.put(f"/api/items/{wid}/acl", json={"shares": []}).status_code in (403, 404), "bob cannot change sharing of alice's item")
own = {i["id"]: i for i in a.get("/api/library").get_json()["items"]}
check(own[wid]["shared_with"] and own[wid]["shared_with"][0]["username"] == "bob", "alice sees whom she shared with")

# 共有(編集)
a.put(f"/api/items/{wid}/acl", json={"shares": [{"user_id": ids["bob"], "level": "edit"}]})
check(b.patch(f"/api/items/{wid}", json={"tags": ["shared"]}).status_code == 200, "bob can edit with edit share")
check(b.delete(f"/api/items/{wid}").status_code == 403, "bob cannot delete alice's item (owner only)")
check(c.get("/api/library").get_json()["items"] == [], "carol sees nothing")

# 一括共有
r = a.post("/api/items/acl", json={"item_ids": [wid, bid], "user_id": ids["carol"], "level": "view"}).get_json()
check(r["count"] == 1 and r["skipped"] == 1, "bulk share only applies to own items")
check(len(c.get("/api/library").get_json()["items"]) == 1, "carol now sees 1 shared item")

# お気に入り
check(b.post(f"/api/items/{bid}/favorite", json={"on": True}).get_json()["favorite"] is True, "bob favorites his item")
fav = {i["id"]: i["favorite"] for i in b.get("/api/library").get_json()["items"]}
check(fav.get(bid) is True and fav.get(wid) is False, "favorite flag is per user")

# サーバー
db = A.sqlite3.connect(A.DB_PATH)
db.execute("INSERT INTO servers (identifier, name, plugin_dir, created_at, owner_id) VALUES ('abc','Survival','/plugins','',?)", (ids["alice"],))
db.commit(); sid = db.execute("SELECT id FROM servers WHERE identifier='abc'").fetchone()[0]
check(b.get("/api/servers").get_json()["servers"] == [], "bob cannot see alice's server")
check(b.patch(f"/api/servers/{sid}", json={"name": "x"}).status_code == 404, "bob cannot edit alice's server")
a.put(f"/api/servers/{sid}/acl", json={"shares": [{"user_id": ids["bob"], "level": "view"}]})
srv = b.get("/api/servers").get_json()["servers"]
check(len(srv) == 1 and srv[0]["access"] == "view", "bob sees shared server (view)")
check(b.patch(f"/api/servers/{sid}", json={"name": "x"}).status_code == 403, "bob cannot edit view-shared server")
check(b.delete(f"/api/servers/{sid}").status_code == 403, "bob cannot delete shared server")

# 権限
check(b.get("/api/storage/targets").status_code == 403, "bob lacks storage permission")
check(b.patch("/api/settings", json={"check_interval_hours": 6}).status_code == 403, "bob cannot change system settings")
check(a.patch(f"/api/users/{ids['bob']}", json={"perms": ["storage", "users"]}).status_code == 200, "alice grants bob storage+users")
check(b.get("/api/storage/targets").status_code == 200, "bob can now open storage settings")
check(b.patch(f"/api/users/{ids['bob']}", json={"role": "admin"}).status_code == 403, "bob cannot promote himself to admin")
check(b.patch(f"/api/users/{ids['carol']}", json={"perms": ["system"]}).status_code == 403, "bob cannot grant permissions")
check(b.patch(f"/api/users/{ids['alice']}", json={"password": "newpassword1"}).status_code == 403, "bob cannot change an admin")
me = b.get("/api/auth/me").get_json()["user"]
check(sorted(me["perms"]) == ["storage", "users"], "me.perms reflects granted permissions")

# 利用状況
u = {x["username"]: x for x in a.get("/api/admin/usage").get_json()["users"]}
check(u["alice"]["items"] == 1 and u["bob"]["items"] == 1 and u["alice"]["servers"] == ["Survival"], "usage counts per user")
check(u["alice"]["shared_names"] == ["WorldEdit"] and u["bob"]["shared_names"] == [], "usage shows names only of shared items")
check(c.get("/api/admin/usage").status_code == 403, "carol cannot see usage")

# ユーザー削除 → 引き継ぎ(同じ名前は区別)
r = a.delete(f"/api/users/{ids['bob']}").get_json()
check(r.get("moved", {}).get("items") == 1, "deleting bob transfers his item to alice")
names = sorted(i["name"] for i in a.get("/api/library").get_json()["items"])
check(names == ["WorldEdit", "WorldEdit (bob)"], f"transferred duplicate is renamed: {names}")

print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
