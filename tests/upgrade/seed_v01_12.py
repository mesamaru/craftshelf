"""v01.12.00 のコードで、移行テスト(upgtest.py)用のデータを作る。

使い方: python seed112.py <v01.12.00 のコードの場所> <データの置き場所>
"""
import io, os, sqlite3, sys, zipfile
code, data = sys.argv[1], sys.argv[2]
os.makedirs(data, exist_ok=True)
os.environ["DATA_DIR"] = data; os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, code); import app as A


def jar(n, v):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {n}\nversion: {v}\nmain: x.Y\napi-version: 1.20\n"); z.writestr("x/a", v)
    return b.getvalue()


c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
assert c.post("/api/auth/setup", json={"username": "boss", "password": "password123"}).status_code == 200
c.patch("/api/me/prefs", json={"theme": "aurora"})
ids = {}
for n, v in (("LuckPerms", "5.4.100"), ("LuckPerms", "5.4.120"), ("Vault", "1.7.3"), ("EssentialsX", "2.20.1")):
    r = c.put(f"/api/upload?filename={n}-{v}.jar", data=jar(n, v)).get_json()
    ids[n] = r["item_id"]
c.post(f"/api/items/{ids['LuckPerms']}/source", json={"provider": "modrinth", "project_id": "luckperms"})
c.post("/api/users", json={"username": "helper", "password": "password123", "role": "editor"})
c.post("/api/sets", json={"name": "Basic", "items": [ids["LuckPerms"], ids["Vault"]]})
url = c.post("/api/shares", json={"item_ids": [ids["Vault"]], "hours": 720}).get_json()["url"]
open(os.path.join(data, "share_url.txt"), "w").write(url)
db = sqlite3.connect(A.DB_PATH)
db.execute("INSERT INTO servers (identifier, name, plugin_dir, created_at) VALUES ('abc12345', 'Survival', '/plugins', '2026-10-01T00:00:00Z')")
db.commit()
print("seeded v" + A.running_version(), data)
