"""サーバー本体のまとめて管理: 一覧・jar の入れ替え(退避つき)・入れ替えたビルドの表示・前の jar に戻す・確認だけのソフト・権限。
配布元の代わりに、手元で作った jar を返すようにして試す(外部のサービスは使わない)。"""
import io, json, os, sys, tempfile, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-sw-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
import mcnet  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


def jar_bytes(tag):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("version.txt", tag); z.writestr("pad", os.urandom(2048))
    return b.getvalue()


NEW = jar_bytes("paper-232")
LATEST = {"paper": {"build": "232", "url": "https://example.invalid/paper-232.jar", "file": "paper-1.21.4-232.jar", "sha256": "", "auto": True,
                    "channel": "stable", "time": ""},
          "neoforge": {"build": "21.1.264", "url": "", "file": "", "sha256": "", "auto": False, "channel": "stable", "time": ""}}
mcnet.latest_build = lambda soft, mc: LATEST.get(soft)
mcnet.newest_mc = lambda soft: ""
DL = []


def fake_download(url, dest, sha256="", max_bytes=0):
    DL.append(url); Path(dest).write_bytes(NEW); return len(NEW)


mcnet.download = fake_download

H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)
base = Path(tempfile.mkdtemp(prefix="cs-sw-srv-"))
r1 = base / "paper"; (r1 / "plugins").mkdir(parents=True)
OLD = jar_bytes("paper-212")
(r1 / "paper-1.21.4-212.jar").write_bytes(OLD)
(r1 / "version_history.json").write_text(json.dumps({"currentVersion": "git-Paper-212 (MC: 1.21.4)"}))
r2 = base / "neo"; (r2 / "mods").mkdir(parents=True)
(r2 / "server.jar").write_bytes(jar_bytes("neo"))
c.post("/api/servers", json={"kind": "local", "root_dir": str(r1), "software": "paper", "name": "PaperSrv", "dirs": {"plugin": "plugins"}}, headers=H)
c.post("/api/servers", json={"kind": "local", "root_dir": str(r2), "software": "neoforge", "name": "NeoSrv", "dirs": {"mod": "mods"}, "mc_version": "1.21.1"}, headers=H)
sv = {s["name"]: s["id"] for s in c.get("/api/servers", headers=H).get_json()["servers"]}

# ---- 一覧 ----
d = c.get("/api/servers/software?refresh=1", headers=H).get_json()
by = {s["name"]: s for s in d["servers"]}
p = by["PaperSrv"]
check(p["software_name"] == "Paper" and p["info"]["build"] == "212" and p["info"]["latest"]["build"] == "232" and p["info"]["update"], f"paper: 212 → 232 available ({p['info'].get('build')})")
check(p["auto"] and p["info"]["jar"] == "paper-1.21.4-212.jar", f"paper jar detected and can be swapped ({p['info'].get('jar')})")
n = by["NeoSrv"]
check(n["software_name"] == "NeoForge" and not n["auto"] and n["info"]["latest"]["build"] == "21.1.264", "neoforge: check only")
check(d["supported"]["leaf"]["auto"] and not d["supported"]["forge"]["auto"], "supported software list returned")

# ---- 入れ替え ----
def wait_jobs(ids):
    for _ in range(400):
        js = [c.get(f"/api/jobs/{i}", headers=H).get_json() for i in ids]
        if all(j["status"] not in ("running", "queued") for j in js):
            return js
        time.sleep(0.05)
    return js


r = c.post("/api/servers/software/update", json={"server_ids": [sv["PaperSrv"], sv["NeoSrv"]]}, headers=H).get_json()
js = wait_jobs([j["id"] for j in r["jobs"]])
check(js[0]["status"] == "done", f"paper updated ({js[0]['status']} {js[0].get('log', [])[-1:]})")
check(js[1]["status"] == "error" and "自動で入れ替えられません" in " ".join(js[1]["log"]), "neoforge is refused (check only)")
check((r1 / "paper-1.21.4-212.jar").read_bytes() == NEW, "jar replaced under the same file name (start command keeps working)")
bk = list((A.JAR_BACKUP_DIR / str(sv["PaperSrv"])).glob("*"))
check(len(bk) == 1 and bk[0].read_bytes() == OLD and "__212__" in bk[0].name, f"old jar backed up ({[b.name for b in bk]})")
info = c.get(f"/api/servers/{sv['PaperSrv']}/software?refresh=1", headers=H).get_json()
check(info["build"] == "232" and not info.get("update"), f"installed build is shown before restart ({info.get('build')})")
with A.app.app_context():
    a = A.db().execute("SELECT detail FROM audit WHERE action='サーバー本体を更新'").fetchone()
check(a and a[0] == "212 → 232", "update is in the audit log")

# ---- 前の jar に戻す ----
r = c.post(f"/api/servers/{sv['PaperSrv']}/software/restore", headers=H)
check(r.status_code == 200 and (r1 / "paper-1.21.4-212.jar").read_bytes() == OLD, "previous jar restored")
info = c.get(f"/api/servers/{sv['PaperSrv']}/software?refresh=1", headers=H).get_json()
check(info["build"] == "212", f"build back to 212 ({info.get('build')})")
check(c.post(f"/api/servers/{sv['PaperSrv']}/software/restore", headers=H).status_code == 404, "nothing left to restore → 404")

# ---- 権限 ----
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
e = A.app.test_client(); e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(e.post("/api/servers/software/update", json={"server_ids": [sv["PaperSrv"]]}, headers=H).status_code in (403, 404), "other editor cannot update")
check(e.get("/api/servers/software", headers=H).get_json()["servers"] == [], "other editor sees no servers")
check(c.post("/api/servers/software/update", json={"server_ids": []}, headers=H).status_code == 400, "empty selection refused")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
