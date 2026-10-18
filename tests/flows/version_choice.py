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
        z.writestr("plugin.yml", f"name: {n}\nversion: {v}\nmain: x.Y\n"); z.writestr("x/a", v)
    return b.getvalue()
def wait(c, jid):
    for _ in range(300):
        j = c.get(f"/api/jobs/{jid}").get_json()
        if j["status"] != "running": return j
        time.sleep(0.05)
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
r1 = c.put("/api/upload?filename=Alpha-1.0.jar", data=jar("Alpha", "1.0")).get_json()
r2 = c.put("/api/upload?filename=Alpha-2.0.jar", data=jar("Alpha", "2.0")).get_json()
r3 = c.put("/api/upload?filename=Alpha-1.0-copy.jar", data=jar("Alpha", "1.0")).get_json()
check(r1.get("version_id") and r2.get("version_id") and r1["version_id"] != r2["version_id"], f"upload returns version_id ({r1.get('version_id')}, {r2.get('version_id')})")
check(r3["status"] == "duplicate" and r3.get("version_id") == r1["version_id"], f"duplicate returns existing version_id ({r3.get('version_id')})")
root = Path(tempfile.mkdtemp()) / "s"; (root / "plugins").mkdir(parents=True); (root / "server.properties").write_text("x=1")
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "dirs": {"plugin": "plugins"}})
sid = c.get("/api/servers").get_json()["servers"][0]["id"]
j = c.post(f"/api/servers/{sid}/push", json={"item_ids": [r1["item_id"]], "version_ids": {str(r1["item_id"]): r1["version_id"]}, "force": True}).get_json()
wait(c, j["id"])
check([p.name for p in (root / "plugins").glob("*.jar")] == ["Alpha-1.0.jar"], f"chosen older version pushed ({[p.name for p in (root / 'plugins').glob('*.jar')]})")
j = c.post(f"/api/servers/{sid}/push", json={"item_ids": [r1["item_id"]]}).get_json(); wait(c, j["id"])
check([p.name for p in (root / "plugins").glob("*.jar")] == ["Alpha-2.0.jar"], "without a choice the latest is pushed")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
