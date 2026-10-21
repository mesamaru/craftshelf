"""セット・Pterodactyl(疑似サーバー)・整理・依存・監査・バックアップ・通知設定の通しテスト。"""
import io, json, os, sys, tempfile, threading, time, uuid, zipfile
from pathlib import Path

tmp = tempfile.mkdtemp(prefix="cs-feat-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
from flask import Flask, jsonify, request, send_file  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)

# ---------------- 疑似 Pterodactyl ----------------
SRV_DIR = Path(tmp) / "srv"
(SRV_DIR / "plugins").mkdir(parents=True)
PORT = 18123
mock = Flask("mock")
calls = {"power": []}
def auth_ok():
    return request.headers.get("Authorization") == "Bearer ptlc_test"
@mock.get("/api/client")
def m_list():
    if not auth_ok(): return jsonify(errors=[{"detail": "unauth"}]), 401
    return jsonify(data=[{"attributes": {"identifier": "abc123", "uuid": "u", "name": "Survival", "node": "n1", "description": ""}}],
                   meta={"pagination": {"total_pages": 1}})
@mock.get("/api/client/servers/<i>/files/list")
def m_files(i):
    d = SRV_DIR / request.args["directory"].strip("/")
    return jsonify(data=[{"attributes": {"name": p.name, "size": p.stat().st_size, "is_file": p.is_file(),
                                         "modified_at": str(p.stat().st_mtime_ns)}} for p in d.iterdir()])
@mock.get("/api/client/servers/<i>/files/download")
def m_dl(i):
    return jsonify(attributes={"url": f"http://127.0.0.1:{PORT}/wings/download?f={request.args['file']}"})
@mock.get("/wings/download")
def w_dl():
    assert "Authorization" not in request.headers
    return send_file(SRV_DIR / request.args["f"].strip("/"))
@mock.get("/api/client/servers/<i>/files/upload")
def m_up(i):
    return jsonify(attributes={"url": f"http://127.0.0.1:{PORT}/wings/upload?token=t"})
@mock.post("/wings/upload")
def w_up():
    f = request.files["files"]
    f.save(SRV_DIR / request.args["directory"].strip("/") / f.filename)
    return "", 200
@mock.post("/api/client/servers/<i>/files/delete")
def m_del(i):
    d = request.get_json()
    for n in d["files"]:
        (SRV_DIR / d["root"].strip("/") / n).unlink()
    return "", 204
@mock.post("/api/client/servers/<i>/power")
def m_power(i):
    calls["power"].append(request.get_json()["signal"]); return "", 204
@mock.get("/api/client/servers/<i>/resources")
def m_res(i):
    return jsonify(attributes={"current_state": "running"})
srv = make_server("127.0.0.1", PORT, mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def jar(name, ver, extra=""):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\n{extra}")
    return b.getvalue()

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "admin", "password": "password123"})
def wait(j):
    for _ in range(200):
        j = c.get(f"/api/jobs/{j['id']}").get_json()
        if j["status"] not in ("running", "queued"): return j
        time.sleep(0.1)
    return j

print("== library / deps")
lp1, lp2 = jar("LuckPerms", "5.4.0"), jar("LuckPerms", "5.5.0")
r1 = c.put("/api/upload?filename=LuckPerms-5.4.0.jar", data=lp1).get_json()
c.put("/api/upload?filename=LuckPerms-5.5.0.jar", data=lp2)
ess = c.put("/api/upload?filename=EssentialsX-2.20.1.jar", data=jar("EssentialsX", "2.20.1", "depend: [Vault]\nsoftdepend: [LuckPerms]\n")).get_json()
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(lib["EssentialsX"]["missing_deps"] == ["Vault"] and lib["EssentialsX"]["softdepends"] == ["LuckPerms"], f"missing deps {lib['EssentialsX']['missing_deps']}")
c.put("/api/upload?filename=Vault-1.7.jar", data=jar("Vault", "1.7.3"))
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(lib["EssentialsX"]["missing_deps"] == [], "deps satisfied after adding Vault")

print("== sets")
LP, ES, VA = lib["LuckPerms"], lib["EssentialsX"], lib["Vault"]
old_lp_vid = [v for v in LP["versions"] if v["version"] == "5.4.0"][0]["id"]
s = c.post("/api/sets", json={"name": "サバイバル", "items": [{"item_id": LP["id"]}, {"item_id": ES["id"]}, {"item_id": VA["id"], "version_id": None}]}).get_json()["set"]
check(len(s["items"]) == 3, "set created")
r = c.get(f"/api/sets/{s['id']}/download")
names = zipfile.ZipFile(io.BytesIO(r.data)).namelist()
check(r.status_code == 200 and "plugins/LuckPerms-5.5.0.jar" in names and len(names) == 3, f"set zip {names}")
c.patch(f"/api/sets/{s['id']}", json={"items": [{"item_id": LP["id"], "version_id": old_lp_vid}, {"item_id": ES["id"]}]})
names = zipfile.ZipFile(io.BytesIO(c.get(f"/api/sets/{s['id']}/download").data)).namelist()
check("plugins/LuckPerms-5.4.0.jar" in names and len(names) == 2, f"pinned version in zip {names}")

print("== keep_versions")
c.put("/api/upload?filename=LuckPerms-5.6.0.jar", data=jar("LuckPerms", "5.6.0"))
r = c.patch(f"/api/items/{LP['id']}", json={"name": "LuckPerms", "category": "plugin", "keep_versions": 1}).get_json()
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
vers = sorted(v["version"] for v in lib["LuckPerms"]["versions"])
check(vers == ["5.4.0", "5.6.0"], f"pruned to latest + pinned: {vers} removed={r.get('removed')}")
c.put("/api/upload?filename=LuckPerms-5.7.0.jar", data=jar("LuckPerms", "5.7.0"))
vers = sorted(v["version"] for v in {i["name"]: i for i in c.get("/api/library").get_json()["items"]}["LuckPerms"]["versions"])
check(vers == ["5.4.0", "5.7.0"], f"auto prune on add: {vers}")
c.patch(f"/api/sets/{s['id']}", json={"items": [{"item_id": LP["id"]}, {"item_id": ES["id"]}, {"item_id": VA["id"]}]})

print("== pterodactyl")
check(not c.post("/api/ptero/test", json={"url": f"http://127.0.0.1:{PORT}", "key": "bad"}).get_json()["ok"], "bad key rejected")
check(c.post("/api/ptero/test", json={"url": f"http://127.0.0.1:{PORT}", "key": "ptlc_test"}).get_json()["ok"], "test ok")
c.patch("/api/settings", json={"ptero_url": f"http://127.0.0.1:{PORT}", "ptero_key": "ptlc_test"})
ps = c.get("/api/ptero/servers").get_json()["servers"]
check(ps and ps[0]["identifier"] == "abc123", "list panel servers")
check(c.post("/api/servers", json={"identifier": "abc123", "name": "Survival", "plugin_dir": "/plugins"}).status_code == 200, "link server")
sid = c.get("/api/servers").get_json()["servers"][0]["id"]
check(c.post("/api/servers", json={"identifier": "abc123"}).status_code == 400, "no duplicate link")
(SRV_DIR / "plugins" / "LuckPerms-5.4.0.jar").write_bytes(lp1)
(SRV_DIR / "plugins" / "Unknown-1.0.jar").write_bytes(jar("Unknown", "1.0"))
(SRV_DIR / "plugins" / "config.yml").write_text("x")
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
st = {f["name"]: f["status"] for f in inv["files"]}
check(st == {"LuckPerms-5.4.0.jar": "outdated", "Unknown-1.0.jar": "unregistered"}, f"inventory {st}")
j = wait(c.post(f"/api/servers/{sid}/sync", json={"restart": True}).get_json())
files = sorted(p.name for p in (SRV_DIR / "plugins").iterdir())
check(j["status"] == "done" and "LuckPerms-5.7.0.jar" in files and "LuckPerms-5.4.0.jar" not in files, f"sync updated: {files} {j['log'][-2:]}")
check(calls["power"] == ["restart"], f"restart called {calls['power']}")
j = wait(c.post(f"/api/servers/{sid}/push", json={"item_ids": [ES["id"]]}).get_json())
check("EssentialsX-2.20.1.jar" in [p.name for p in (SRV_DIR / "plugins").iterdir()], f"push {j['log'][-1:]}")
j = wait(c.post(f"/api/servers/{sid}/import", json={"names": ["Unknown-1.0.jar"]}).get_json())
check("Unknown" in {i["name"] for i in c.get("/api/library").get_json()["items"]}, f"import from server {j['log']}")
c.patch(f"/api/servers/{sid}", json={"set_id": s["id"]})
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
check([m["item_name"] for m in inv["missing"]] == ["Vault"], f"set missing on server {inv['missing']}")
j = wait(c.post(f"/api/servers/{sid}/sync", json={}).get_json())
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
check(inv["missing"] == [] and all(f["status"] == "latest" for f in inv["files"]), f"sync installs set items {[(f['name'], f['status']) for f in inv['files']]}")
j = wait(c.post(f"/api/servers/{sid}/push", json={"set_id": s["id"]}).get_json())
check("送信不要" in " ".join(j["log"]), "push set skips identical files")

print("== backup / discord / audit")
check(c.patch("/api/settings", json={"discord_webhook": "https://evil.example.com/x"}).status_code == 400, "discord url validated")
check(c.patch("/api/settings", json={"discord_webhook": "https://discord.com/api/webhooks/1/abc", "discord_events": ["updates", "bogus"]}).get_json()["discord_events"] == ["updates"], "discord events saved")
c.patch("/api/settings", json={"backup_target_id": 1, "backup_keep": 2})
for _ in range(3):
    j = wait(c.post("/api/backup/run").get_json()); time.sleep(1.1)
bl = c.get("/api/backup/list").get_json()["files"]
check(j["status"] == "done" and len(bl) == 2, f"backup + retention {bl} {j['log'][-1:]}")
z = zipfile.ZipFile(io.BytesIO(c.get(f"/api/backup/download/{bl[0]}").data))
check({"index.db", "secret.key", "README.txt"} <= set(z.namelist()), f"backup contents {z.namelist()}")
aud = c.get("/api/audit?limit=200").get_json()
acts = [e["action"] for e in aud["entries"]]
check("ファイルを登録" in acts and "サーバーへの同期が完了" in acts and "古いバージョンを自動で整理" in acts and "バックアップを作成" in acts, f"audit actions {sorted(set(acts))[:30]}")
check(any(e["action"] == "初期設定(管理者を作成)" and e["username"] == "admin" for e in aud["entries"]), "audit setup user")
v = A.app.test_client(); v.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/users", json={"username": "viewer", "password": "password123", "role": "viewer"})
v.post("/api/auth/login", json={"username": "viewer", "password": "password123"})
check(v.get("/api/audit").status_code == 403 and v.post(f"/api/servers/{sid}/sync", json={}).status_code == 403, "viewer restricted")
check(v.get("/api/sets").status_code == 200, "viewer can see sets")
v.post("/api/auth/login", json={"username": "viewer", "password": "wrong"})
aud = c.get("/api/audit?q=失敗").get_json()
check(aud["total"] >= 1, "failed login logged")

print("== changelog (network)")
c.post(f"/api/items/{LP['id']}/source", json={"url": "https://modrinth.com/plugin/luckperms"})
cl = c.get(f"/api/items/{LP['id']}/source/changelog").get_json()
check(len(cl.get("entries", [])) >= 1, f"changelog entries {len(cl.get('entries', []))}")
r = c.get("/")
check("/static/js/base.js?v=" in r.get_data(as_text=True), "cache-busting query on assets")
srv.shutdown()
print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")

sys.exit(1 if fails else 0)
