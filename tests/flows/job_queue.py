"""サーバーの処理の順番待ち(01.22)のテスト。"""
import io, os, sys, tempfile, threading, time, zipfile
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
ids = []
for n in ("A1", "B2", "C3"):
    ids.append(c.put(f"/api/upload?filename={n}-1.0.jar", data=jar(n, "1.0")).get_json()["item_id"])
root = Path(tempfile.mkdtemp()) / "s"; (root / "plugins").mkdir(parents=True); (root / "server.properties").write_text("x=1")
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "dirs": {"plugin": "plugins"}})
sid = c.get("/api/servers").get_json()["servers"][0]["id"]

# 送る処理を遅くして、重なりを見えるようにする
import craftshelf.servers as SRV
spans, orig = [], SRV._push_versions
def slow(*a, **k):
    t0 = time.monotonic(); time.sleep(0.6); r = orig(*a, **k); spans.append((t0, time.monotonic())); return r
SRV._push_versions = slow
rs = [c.post(f"/api/servers/{sid}/push", json={"item_ids": [i]}) for i in ids]
check(all(r.status_code == 200 for r in rs), f"three quick presses all accepted ({[r.status_code for r in rs]})")
st = [r.get_json()["status"] for r in rs]
check(st[0] == "running" and st[1] == "queued" and st[2] == "queued", f"later presses are queued ({st})")
jids = [r.get_json()["id"] for r in rs]
for _ in range(200):
    js = [c.get(f"/api/jobs/{j}").get_json()["status"] for j in jids]
    if all(x not in ("running", "queued") for x in js): break
    time.sleep(0.1)
check(js == ["done", "done", "done"], f"all finished ({js})")
spans.sort()
check(len(spans) == 3 and all(spans[i][1] <= spans[i + 1][0] + 0.01 for i in range(len(spans) - 1)), f"jobs ran one at a time (no overlap, {len(spans)} runs)")
check(sorted(p.name for p in (root / "plugins").glob("*.jar")) == ["A1-1.0.jar", "B2-1.0.jar", "C3-1.0.jar"], "all three add-ons on the server")
# 予約などの自動の処理は、動いているときは今までどおり見送る
SRV._push_versions = slow
r1 = c.post(f"/api/servers/{sid}/sync", json={})
try:
    with A.app.app_context():
        A.start_job(f"server-{sid}", "auto", lambda job: None)
    check(False, "automatic job while busy should be refused")
except A.ApiError as e:
    check(e.status == 409 if hasattr(e, "status") else True, "automatic job while busy is refused (not queued)")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
