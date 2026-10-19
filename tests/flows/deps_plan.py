"""サーバーに入れるときの前提: 前提の前提までたどる・サーバーにあるものは除く・足りないものを知らせる・権限。"""
import io, os, sys, tempfile, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-dep-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


def jar(name, ver, depend=()):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        dep = f"depend: [{', '.join(depend)}]\n" if depend else ""
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.{name}\n{dep}"); z.writestr("x/a", name + ver)
    return b.getvalue()


H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)
for n, deps in (("Alpha", ["Beta"]), ("Beta", ["Gamma"]), ("Gamma", []), ("Delta", ["Missing"]), ("Echo", ["Vault"]),
                ("Vault", []), ("Loop1", ["Loop2"]), ("Loop2", ["Loop1"])):
    c.put(f"/api/upload?filename={n}-1.0.jar", data=jar(n, "1.0", deps), headers=H)
lib = {i["name"]: i["id"] for i in c.get("/api/library", headers=H).get_json()["items"]}
check(len(lib) == 8, f"8 items uploaded ({sorted(lib)})")

root = Path(tempfile.mkdtemp(prefix="cs-dep-srv-")) / "srv"
(root / "plugins").mkdir(parents=True)
(root / "plugins" / "Vault-1.7.jar").write_bytes(jar("Vault", "1.7"))
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "name": "Dep", "dirs": {"plugin": "plugins"}}, headers=H)
sid = c.get("/api/servers", headers=H).get_json()["servers"][0]["id"]
with A.app.app_context():  # 最後に確かめたサーバーの中身(Vault がある)
    A.db().execute("INSERT OR REPLACE INTO server_files (server_id, name, plugin_name, version) VALUES (?,?,?,?)", (sid, "plugins/Vault-1.7.jar", "Vault", "1.7"))
    A.db().commit()

plan = lambda ids: c.post(f"/api/servers/{sid}/deps-plan", json={"item_ids": ids}, headers=H).get_json()  # noqa: E731
p = plan([lib["Alpha"]])
check([a["name"] for a in p["add"]] == ["Beta", "Gamma"], f"dependencies of dependencies are followed ({p['add']})")
check(p["add"][1]["for"] == "Beta" and p["missing"] == [], "the reason is shown (Gamma for Beta)")
p = plan([lib["Alpha"], lib["Beta"]])
check([a["name"] for a in p["add"]] == ["Gamma"], "already selected items are not added twice")
p = plan([lib["Delta"]])
check(p["add"] == [] and p["missing"] == [{"name": "Missing", "for": "Delta"}], f"missing dependency reported ({p})")
p = plan([lib["Echo"]])
check(p["add"] == [] and p["present"] == ["Vault"], f"dependency already on the server is skipped ({p})")
p = plan([lib["Loop1"]])
check([a["name"] for a in p["add"]] == ["Loop2"], "circular dependencies do not loop forever")
check(plan([999999]) == {"add": [], "missing": [], "present": []}, "unknown items are ignored")
check(c.post(f"/api/servers/{sid}/deps-plan", json={"item_ids": ["x"]}, headers=H).status_code == 400, "bad ids → 400")

# 前提ごと入れる
ids = [lib["Alpha"]] + [a["id"] for a in plan([lib["Alpha"]])["add"]]
j = c.post(f"/api/servers/{sid}/push", json={"item_ids": ids, "force": True}, headers=H).get_json()
for _ in range(400):
    st = c.get(f"/api/jobs/{j['id']}", headers=H).get_json()
    if st["status"] not in ("running", "queued"):
        break
    time.sleep(0.05)
names = sorted(p.name for p in (root / "plugins").iterdir() if p.suffix == ".jar")
check({"Alpha-1.0.jar", "Beta-1.0.jar", "Gamma-1.0.jar"} <= set(names), f"plugin and its dependencies are on the server ({names})")

# 権限: 共有されていないサーバーの前提は調べられない
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
e = A.app.test_client(); e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(e.post(f"/api/servers/{sid}/deps-plan", json={"item_ids": [lib["Alpha"]]}, headers=H).status_code in (403, 404), "other editor cannot use the plan")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
