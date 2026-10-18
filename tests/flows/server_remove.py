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
        if j["status"] not in ("running", "queued"): return j
        time.sleep(0.05)
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
c.put("/api/upload?filename=A-1.0.jar", data=jar("A", "1.0"))
root = Path(tempfile.mkdtemp()) / "s"; (root / "plugins").mkdir(parents=True); (root / "server.properties").write_text("x=1")
(root / "plugins" / "A-1.0.jar").write_bytes(jar("A", "1.0")); (root / "plugins" / "B-1.0.jar").write_bytes(jar("B", "1.0"))
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "dirs": {"plugin": "plugins"}})
sid = c.get("/api/servers").get_json()["servers"][0]["id"]
j = c.post(f"/api/servers/{sid}/remove", json={"paths": ["plugins/A-1.0.jar", "plugins/B-1.0.jar", "../x.jar"]}).get_json()
r = wait(c, j["id"])
check(r["status"] == "done" and r["result"]["removed"] == 2, f"two files removed ({r['result']})")
check(not list((root / "plugins").glob("*.jar")), "files gone from server")
sn = c.get(f"/api/servers/{sid}/snapshots").get_json()["snapshots"][0]
check(sorted(x["name"] for x in sn["removed"]) == ["plugins/A-1.0.jar", "plugins/B-1.0.jar"], "removed files backed up")
j = c.post(f"/api/servers/{sid}/snapshots/{sn['id']}/rollback", json={}).get_json(); wait(c, j["id"])
check(sorted(p.name for p in (root / "plugins").glob("*.jar")) == ["A-1.0.jar", "B-1.0.jar"], "rollback restores removed files")
check(c.post(f"/api/servers/{sid}/remove", json={"paths": ["../../etc/passwd"]}).status_code == 400, "paths outside managed folders rejected")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
