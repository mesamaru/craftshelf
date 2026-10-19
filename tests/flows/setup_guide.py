"""はじめの設定ガイド: 実際の状態で済みになる・不要にする/戻す・隠す/出す・管理者だけ。"""
import io, os, sys, tempfile, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-sg-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "admin", "password": "password123"}, headers=H)
done = lambda g: {s["id"] for s in g["steps"] if s["done"]}  # noqa: E731
g = c.get("/api/setup/guide", headers=H).get_json()
check([s["id"] for s in g["steps"]] == ["storage", "addons", "server", "backup", "notify"] and not done(g) and not g["hidden"], "fresh panel: nothing done")

b = io.BytesIO()
with zipfile.ZipFile(b, "w") as z:
    z.writestr("plugin.yml", "name: A\nversion: 1\nmain: x.A\n")
c.put("/api/upload?filename=A-1.jar", data=b.getvalue(), headers=H)
c.patch("/api/settings", json={"backup_target_id": 1}, headers=H)
root = Path(tempfile.mkdtemp(prefix="cs-sg-srv-")) / "s"; (root / "plugins").mkdir(parents=True)
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "name": "S", "dirs": {"plugin": "plugins"}}, headers=H)
g = c.get("/api/setup/guide", headers=H).get_json()
check(done(g) == {"addons", "backup", "server"}, f"steps are done from the real state ({sorted(done(g))})")

g = c.post("/api/setup/guide", json={"mark": "storage"}, headers=H).get_json()
st = next(s for s in g["steps"] if s["id"] == "storage")
check(st["done"] and st["skipped"], "storage marked as not needed")
g = c.post("/api/setup/guide", json={"mark": "notify"}, headers=H).get_json()
check(g["all_done"], "all done after skipping notify")
g = c.post("/api/setup/guide", json={"unmark": "notify"}, headers=H).get_json()
check(not g["all_done"] and "notify" not in done(g), "unmark brings the step back")
check(c.post("/api/setup/guide", json={"mark": "nope"}, headers=H).status_code == 400, "unknown step refused")
g = c.post("/api/setup/guide", json={"hide": True}, headers=H).get_json()
check(g["hidden"], "guide can be hidden")
check(c.get("/api/setup/guide", headers=H).get_json()["hidden"], "hidden is remembered")
check(not c.post("/api/setup/guide", json={"hide": False}, headers=H).get_json()["hidden"], "guide can be shown again")

c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
e = A.app.test_client(); e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(e.get("/api/setup/guide", headers=H).status_code == 403, "editor cannot see the guide")
check(e.post("/api/setup/guide", json={"hide": True}, headers=H).status_code == 403, "editor cannot change the guide")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
