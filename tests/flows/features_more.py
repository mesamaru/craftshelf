import base64, hashlib, hmac, io, json, os, struct, sys, tempfile, threading, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-f2-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
from flask import Flask, jsonify, request, send_file  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)

SRV = Path(tmp) / "srv"; (SRV / "plugins").mkdir(parents=True)
PORT = 18131
m = Flask("mock")
@m.get("/api/client")
def l(): return jsonify(data=[{"attributes": {"identifier": "abc123", "name": "Survival", "node": "n"}}], meta={"pagination": {"total_pages": 1}})
@m.get("/api/client/servers/<i>/files/list")
def fl(i):
    d = SRV / request.args["directory"].strip("/")
    return jsonify(data=[{"attributes": {"name": p.name, "size": p.stat().st_size, "is_file": p.is_file(), "modified_at": str(p.stat().st_mtime_ns)}} for p in d.iterdir()])
@m.get("/api/client/servers/<i>/files/download")
def dl(i): return jsonify(attributes={"url": f"http://127.0.0.1:{PORT}/w/dl?f={request.args['file']}"})
@m.get("/w/dl")
def wdl(): return send_file(SRV / request.args["f"].strip("/"))
@m.get("/api/client/servers/<i>/files/upload")
def up(i): return jsonify(attributes={"url": f"http://127.0.0.1:{PORT}/w/up?token=t"})
@m.post("/w/up")
def wup():
    f = request.files["files"]; f.save(SRV / request.args["directory"].strip("/") / f.filename); return ""
@m.post("/api/client/servers/<i>/files/delete")
def de(i):
    d = request.get_json()
    for n in d["files"]:
        (SRV / d["root"].strip("/") / n).unlink(missing_ok=True)
    return "", 204
@m.post("/api/client/servers/<i>/power")
def pw(i): return "", 204
srv = make_server("127.0.0.1", PORT, m); threading.Thread(target=srv.serve_forever, daemon=True).start()

def jar(name, ver, extra=""):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\n{extra}")
    return b.getvalue()
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "admin", "password": "password123"})
def wait(j):
    for _ in range(300):
        j = c.get(f"/api/jobs/{j['id']}").get_json()
        if j["status"] != "running": return j
        time.sleep(0.1)
    return j

print("== tags / dep links")
e = c.put("/api/upload?filename=Ess-2.20.jar", data=jar("EssentialsX", "2.20.1", "depend: [Vault]\n")).get_json()
va = c.put("/api/upload?filename=VaultAPI-1.7.jar", data=jar("VaultAPI", "1.7")).get_json()
c.patch(f"/api/items/{e['item_id']}", json={"name": "EssentialsX", "category": "plugin", "tags": ["必須", " テスト中 ", "必須"]})
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(lib["EssentialsX"]["tags"] == ["必須", "テスト中"], f"tags {lib['EssentialsX']['tags']}")
check(lib["EssentialsX"]["missing_deps"] == ["Vault"], "dep missing before link")
c.post("/api/deps/link", json={"name": "Vault", "item_id": va["item_id"]})
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
st = lib["EssentialsX"]["dep_status"][0]
check(lib["EssentialsX"]["missing_deps"] == [] and st["item_id"] == va["item_id"] and st["manual"], f"dep linked {st}")
c.post("/api/deps/link", json={"name": "Vault", "item_id": None})
check({i["name"]: i for i in c.get("/api/library").get_json()["items"]}["EssentialsX"]["missing_deps"] == ["Vault"], "dep unlink")

print("== snapshots / rollback / schedule")
c.patch("/api/settings", json={"ptero_url": f"http://127.0.0.1:{PORT}", "ptero_key": "ptlc_x"})
c.post("/api/servers", json={"identifier": "abc123", "name": "Survival"})
sid = c.get("/api/servers").get_json()["servers"][0]["id"]
old_bytes = jar("EssentialsX", "2.19.0")
(SRV / "plugins" / "EssentialsX-2.19.0.jar").write_bytes(old_bytes)
j = wait(c.post(f"/api/servers/{sid}/sync", json={}).get_json())
files = sorted(p.name for p in (SRV / "plugins").iterdir())
check(files == ["Ess-2.20.jar"], f"synced {files} {j['log'][-1:]}")
snaps = c.get(f"/api/servers/{sid}/snapshots").get_json()["snapshots"]
check(len(snaps) == 1 and snaps[0]["removed"][0]["name"] == "plugins/EssentialsX-2.19.0.jar" and snaps[0]["added"] == ["plugins/Ess-2.20.jar"], f"snapshot {snaps}")
j = wait(c.post(f"/api/servers/{sid}/snapshots/{snaps[0]['id']}/rollback", json={}).get_json())
files = sorted(p.name for p in (SRV / "plugins").iterdir())
check(files == ["EssentialsX-2.19.0.jar"] and (SRV / "plugins" / "EssentialsX-2.19.0.jar").read_bytes() == old_bytes, f"rolled back {files} {j['log']}")
check(c.get(f"/api/servers/{sid}/snapshots").get_json()["snapshots"][0]["rolled_back"], "rollback recorded")
check(c.patch(f"/api/servers/{sid}", json={"sched_time": "25:00"}).status_code == 400, "bad time rejected")
now = time.localtime()
c.patch(f"/api/servers/{sid}", json={"sched_mode": "daily", "sched_time": time.strftime("%H:%M", time.localtime(time.time() - 60)), "sched_restart": False})
with A.app.app_context():
    A._server_schedule_tick()
time.sleep(3)
files = sorted(p.name for p in (SRV / "plugins").iterdir())
check(files == ["Ess-2.20.jar"], f"scheduled sync ran {files}")
with A.app.app_context():
    before = len(A._JOBS); A._server_schedule_tick()
    check(len(A._JOBS) == before, "schedule not repeated")

print("== api tokens")
t = c.post("/api/me/tokens", json={"name": "ci", "role": "viewer"}).get_json()["token"]
api = A.app.test_client()
H = {"Authorization": f"Bearer {t}"}
check(api.get("/api/library", headers=H).status_code == 200, "token read")
check(api.put("/api/upload?filename=x.jar", data=jar("X", "1"), headers=H).status_code == 403, "viewer token cannot upload")
check(api.get("/api/library", headers={"Authorization": "Bearer cs_bad"}).status_code == 401, "bad token")
t2 = c.post("/api/me/tokens", json={"name": "ed", "role": "editor"}).get_json()["token"]
check(api.put("/api/upload?filename=Y-1.jar", data=jar("Y", "1"), headers={"Authorization": f"Bearer {t2}"}).status_code == 200, "editor token upload w/o csrf header")
check(api.post("/api/me/tokens", json={"name": "x"}, headers={"Authorization": f"Bearer {t2}"}).status_code == 403, "token cannot mint tokens")
tid = c.get("/api/me/tokens").get_json()["tokens"][0]["id"]
c.delete(f"/api/me/tokens/{tid}")
check(api.get("/api/library", headers={"Authorization": f"Bearer {t2}"}).status_code == 401, "revoked token")

print("== totp / username")
s = c.post("/api/me/totp/setup").get_json()
check(s["secret"] and s["uri"].startswith("otpauth://") and "<svg" in s["qr_svg"], "totp setup with QR")
def code(secret, off=0):
    key = base64.b32decode(secret + "=" * (-len(secret) % 8)); ctr = int(time.time() // 30) + off
    h = hmac.new(key, struct.pack(">Q", ctr), "sha1").digest(); o = h[-1] & 15
    return f"{(struct.unpack('>I', h[o:o+4])[0] & 0x7fffffff) % 1000000:06d}"
check(c.post("/api/me/totp/enable", json={"code": "000000"}).status_code == 400, "wrong code rejected")
rc = c.post("/api/me/totp/enable", json={"code": code(s["secret"])}).get_json()["recovery_codes"]
check(len(rc) == 8, "recovery codes")
x = A.app.test_client(); x.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
r = x.post("/api/auth/login", json={"username": "admin", "password": "password123"}).get_json()
check(r.get("need_totp") and x.get("/api/library").status_code == 401, "password alone not enough")
check(x.post("/api/auth/totp", json={"code": "123456"}).status_code == 401, "bad totp")
check(x.post("/api/auth/totp", json={"code": code(s["secret"])}).status_code == 200 and x.get("/api/library").status_code == 200, "totp login")
y = A.app.test_client(); y.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
y.post("/api/auth/login", json={"username": "admin", "password": "password123"})
check(y.post("/api/auth/totp", json={"code": rc[0]}).status_code == 200, "recovery code login")
y2 = A.app.test_client(); y2.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
y2.post("/api/auth/login", json={"username": "admin", "password": "password123"})
check(y2.post("/api/auth/totp", json={"code": rc[0]}).status_code == 401, "recovery code single use")
check(c.post("/api/auth/username", json={"username": "maru", "password": "bad"}).status_code == 400, "username needs password")
check(c.post("/api/auth/username", json={"username": "maru", "password": "password123"}).status_code == 200
      and c.get("/api/auth/me").get_json()["user"]["username"] == "maru", "username changed")
check(c.post("/api/me/totp/disable", json={"password": "password123"}).status_code == 200, "totp disabled")

print("== search / modpack")
r = c.get("/api/search?provider=modrinth&q=sodium&kind=mod&loader=fabric&mc=1.20.1").get_json()
check(r["results"] and r["results"][0]["title"] == "Sodium", "search modrinth")
b = io.BytesIO()
with zipfile.ZipFile(b, "w") as z:
    z.writestr("modrinth.index.json", json.dumps({"formatVersion": 1, "game": "minecraft", "versionId": "1.0", "name": "TestPack",
        "dependencies": {"minecraft": "1.20.1", "fabric-loader": "0.15.0"},
        "files": []}))
    z.writestr("overrides/mods/Local-1.0.jar", jar("LocalMod", "1.0"))
    z.writestr("overrides/config/x.txt", "x")
# 実際の Modrinth の Mod を1つ入れる(ハッシュで紐付けまで確認)
import requests
v = requests.get("https://api.modrinth.com/v2/project/lithium/version", params={"loaders": '["fabric"]', "game_versions": '["1.20.1"]'},
                 headers={"User-Agent": "craftshelf-test"}, timeout=20).json()[0]
f0 = next(f for f in v["files"] if f["primary"])
idx = json.loads(zipfile.ZipFile(io.BytesIO(b.getvalue())).read("modrinth.index.json"))
idx["files"] = [{"path": f"mods/{f0['filename']}", "hashes": f0["hashes"], "downloads": [f0["url"]], "env": {"client": "required", "server": "required"}, "fileSize": f0["size"]},
                {"path": "mods/clientonly.jar", "hashes": {"sha1": "0"}, "downloads": ["https://cdn.modrinth.com/x"], "env": {"server": "unsupported"}}]
b2 = io.BytesIO()
with zipfile.ZipFile(b2, "w") as z:
    z.writestr("modrinth.index.json", json.dumps(idx))
    z.writestr("overrides/mods/Local-1.0.jar", jar("LocalMod", "1.0"))
j = wait(c.put("/api/modpack?filename=TestPack.mrpack&set=1", data=b2.getvalue()).get_json())
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(j["status"] == "done" and j["result"]["added"] == 2 and j["result"]["skipped"] == 1, f"modpack {j['result']} {j['log'][-3:]}")
lith = [i for i in lib.values() if i.get("source") and i["source"]["provider"] == "modrinth"]
check(len(lith) == 1, f"modpack mod linked by hash {[i['name'] for i in lith]}")
sets = c.get("/api/sets").get_json()["sets"]
check(any(s_["name"].startswith("TestPack") and len(s_["items"]) == 2 for s_ in sets), f"set from modpack {[(s_['name'], len(s_['items'])) for s_ in sets]}")
check(c.put("/api/modpack?filename=x.zip", data=b"notzip").status_code == 400, "non-zip rejected")
srv.shutdown()
print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")

sys.exit(1 if fails else 0)
