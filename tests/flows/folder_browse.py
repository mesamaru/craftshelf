"""フォルダをたどる・jar からの判定(01.21)のテスト。"""
import os, sys, tempfile
from pathlib import Path
tmp = tempfile.mkdtemp(); os.environ["DATA_DIR"] = tmp; os.environ["MCPL_NO_SCHEDULER"] = "1"; os.environ["CRAFTSHELF_TELEMETRY_URL"] = ""
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
base = Path(tempfile.mkdtemp())
srv = base / "mc" / "survival"; srv.mkdir(parents=True); (srv / "server.properties").write_text("level-name=myworld\n")
(srv / "paper-1.21.4-232.jar").write_bytes(b"x" * 10); (srv / "plugins").mkdir(); (srv / "myworld").mkdir()
fab = base / "mc" / "modded"; fab.mkdir(parents=True)
(fab / "fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar").write_bytes(b"y")
(base / "mc" / "notes.txt").write_text("x")

st = c.get("/api/fs/browse").get_json()
check(st["path"] == "" and len(st["starts"]) >= 1, f"starts listed ({st['starts'][:3]})")
d = c.get(f"/api/fs/browse?path={base / 'mc'}").get_json()
check([x["name"] for x in d["dirs"]] == ["modded", "survival"] and d["jars"] == [], f"dirs listed, txt hidden ({d['dirs']})")
check([x for x in d["dirs"] if x["name"] == "survival"][0]["server"] is True, "server folder marked")
check(d["parent"] == str(base.resolve()), "parent path")
d = c.get(f"/api/fs/browse?path={srv}").get_json()
check(d["is_server"] and d["jars"][0]["soft"] == "paper", f"jar listed with software ({d['jars']})")
check(c.get(f"/api/fs/browse?path={base / 'nope'}").status_code == 400, "missing folder rejected")

r = c.post("/api/servers/detect", json={"kind": "local", "root_dir": str(srv), "jar": "paper-1.21.4-232.jar"}).get_json()
check(r["software"] == "paper" and r["mc"] == "1.21.4" and r["build"] == "232" and r["jar_matched"], f"detect from jar {r}")
check(r["dirs"] == {"plugin": "plugins", "datapack": "myworld/datapacks"}, f"dirs from jar + world ({r['dirs']})")
r = c.post("/api/servers/detect", json={"kind": "local", "root_dir": str(fab), "jar": "fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar"}).get_json()
check(r["software"] == "fabric" and r["mc"] == "1.21.1" and r["dirs"].get("mod") == "mods", f"fabric jar detection {r}")
r = c.post("/api/servers/detect", json={"kind": "local", "root_dir": str(srv), "jar": "../../etc/passwd"}).get_json()
check(r["jar"] == "passwd", "jar name is reduced to a file name")

r = c.post("/api/servers", json={"kind": "local", "root_dir": str(srv), "jar": "paper-1.21.4-232.jar", "software": "paper", "mc_version": "1.21.4"})
check(r.status_code == 200, "created with jar")
s = c.get("/api/servers").get_json()["servers"][0]
check(s["server_jar"] == "paper-1.21.4-232.jar" and s["mc_version"] == "1.21.4", f"jar remembered ({s['server_jar']})")
r = c.post("/api/servers", json={"kind": "local", "root_dir": str(fab), "jar": "missing.jar"})
check(r.status_code == 200 and [x for x in c.get("/api/servers").get_json()["servers"] if x["root_dir"] == str(fab.resolve())][0]["server_jar"] == "", "missing jar not stored")

c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"})
e = A.app.test_client(); e.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
e.post("/api/auth/login", json={"username": "ed", "password": "password123"})
check(e.get(f"/api/fs/browse?path={base}").status_code == 403, "editor cannot browse folders")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
