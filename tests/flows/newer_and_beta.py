"""サーバーの方が新しい版・ベータ版の受け取り(01.19)のテスト。"""
import io, os, sys, tempfile, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(); os.environ["DATA_DIR"] = tmp; os.environ["MCPL_NO_SCHEDULER"] = "1"; os.environ["CRAFTSHELF_TELEMETRY_URL"] = ""
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)
def jar(n, v):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {n}\nversion: {v}\nmain: x.Y\napi-version: 1.13\n"); z.writestr("x/a", v)
    return b.getvalue()
def wait(c):
    for _ in range(300):
        js = c.get("/api/jobs").get_json()["jobs"]
        if js and all(j["status"] != "running" for j in js): return js
        time.sleep(0.05)
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
c.put("/api/upload?filename=ViaBackwards-5.12.0.jar", data=jar("ViaBackwards", "5.12.0"))
c.put("/api/upload?filename=Other-1.0.jar", data=jar("Other", "1.0"))
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
root = Path(tempfile.mkdtemp()) / "lobby"; (root / "plugins").mkdir(parents=True)
(root / "server.properties").write_text("level-name=world\n")
(root / "plugins" / "ViaBackwards-5.12.1-SNAPSHOT.jar").write_bytes(jar("ViaBackwards", "5.12.1-SNAPSHOT"))
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "dirs": {"plugin": "plugins"}})
sid = c.get("/api/servers").get_json()["servers"][0]["id"]
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
f = inv["files"][0]
check(f["status"] == "newer", f"server newer version is 'newer' ({f['status']})")
pres = c.get("/api/servers/presence").get_json()["items"][str(lib["ViaBackwards"]["id"])][0]
check(pres["status"] == "newer", f"presence shows newer ({pres['status']})")
sv = c.get("/api/servers").get_json()["servers"][0]
check(sv["summary"]["plugin"]["outdated"] == 0, "newer is not counted as an update")
c.post(f"/api/servers/{sid}/sync", json={}); wait(c)
check((root / "plugins" / "ViaBackwards-5.12.1-SNAPSHOT.jar").exists() and not (root / "plugins" / "ViaBackwards-5.12.0.jar").exists(), "sync does not downgrade")
c.post(f"/api/servers/{sid}/import", json={"names": ["plugins/ViaBackwards-5.12.1-SNAPSHOT.jar"]}); wait(c)
vs = [v["version"] for v in [i for i in c.get("/api/library").get_json()["items"] if i["name"] == "ViaBackwards"][0]["versions"]]
check("5.12.1-SNAPSHOT" in vs, f"imported newer version ({vs})")
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
check(inv["files"][0]["status"] == "latest", "after import it is latest")
with A.app.app_context():
    conn = A.db()
    for iid in (lib["ViaBackwards"]["id"], lib["Other"]["id"]):
        conn.execute("INSERT OR REPLACE INTO item_sources (item_id, provider, project_id) VALUES (?, 'modrinth', 'x')", (iid,))
    conn.commit()
    check(A._stable_only(conn, lib["ViaBackwards"]["id"]) is False, "snapshot in use -> include betas automatically")
    check(A._stable_only(conn, lib["Other"]["id"]) is True, "release-only item stays stable")
r = c.patch(f"/api/items/{lib['Other']['id']}/source", json={"channel": "all"})
with A.app.app_context():
    check(A._stable_only(A.db(), lib["Other"]["id"]) is False, f"channel=all includes betas ({r.status_code})")
c.patch(f"/api/items/{lib['ViaBackwards']['id']}/source", json={"channel": "release"})
with A.app.app_context():
    check(A._stable_only(A.db(), lib["ViaBackwards"]["id"]) is True, "channel=release forces stable")
check(c.patch(f"/api/items/{lib['Other']['id']}/source", json={"channel": "weird"}).status_code == 400, "bad channel rejected")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
