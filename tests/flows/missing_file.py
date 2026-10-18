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
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
a = c.put("/api/upload?filename=A-1.0.jar", data=jar("A", "1.0")).get_json()
b = c.put("/api/upload?filename=B-1.0.jar", data=jar("B", "1.0")).get_json()
for p in Path(tmp).rglob("A-1.0.jar"): p.unlink()   # ライブラリのファイルが消えた
root = Path(tempfile.mkdtemp()) / "s"; (root / "plugins").mkdir(parents=True); (root / "server.properties").write_text("x=1")
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "dirs": {"plugin": "plugins"}})
sid = c.get("/api/servers").get_json()["servers"][0]["id"]
j = c.post(f"/api/servers/{sid}/push", json={"item_ids": [a["item_id"], b["item_id"]]}).get_json()
for _ in range(200):
    r = c.get(f"/api/jobs/{j['id']}").get_json()
    if r["status"] not in ("running", "queued"): break
    time.sleep(0.05)
check(r["status"] == "done", f"job finishes even with a missing file ({r['status']})")
check([p.name for p in (root / "plugins").glob("*.jar")] == ["B-1.0.jar"], "the other add-on is still installed")
check(any("見つかりません" in x for x in r["log"]), "clear message for the missing file")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
