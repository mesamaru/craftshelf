"""フォルダでつないだサーバー(01.16)のテスト。"""
import io, json, os, sys, tempfile, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(); os.environ["DATA_DIR"] = tmp; os.environ["MCPL_NO_SCHEDULER"] = "1"; os.environ["CRAFTSHELF_TELEMETRY_URL"] = ""
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)
def jar(name, ver):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\napi-version: 1.20\n"); z.writestr("x/a", ver)
    return b.getvalue()
def dp(name):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("pack.mcmeta", json.dumps({"pack": {"pack_format": 48, "description": name}})); z.writestr("data/x/a.json", "{}")
    return b.getvalue()
def wait(c):
    for _ in range(200):
        js = c.get("/api/jobs").get_json()["jobs"]
        if js and all(j["status"] != "running" for j in js): return js
        time.sleep(0.05)
    return js

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
c.put("/api/upload?filename=Alpha-1.0.jar", data=jar("Alpha", "1.0"))
c.put("/api/upload?filename=Alpha-1.1.jar", data=jar("Alpha", "1.1"))
c.put("/api/upload?filename=Beta-2.0.jar", data=jar("Beta", "2.0"))
c.put("/api/upload?filename=CoolPack.zip", data=dp("CoolPack"))
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(lib.get("CoolPack", {}).get("category") == "datapack", f"datapack recognised ({lib.get('CoolPack', {}).get('category')})")

srv = Path(tempfile.mkdtemp()) / "mysrv"; (srv / "plugins").mkdir(parents=True); (srv / "survival" / "datapacks").mkdir(parents=True)
(srv / "server.properties").write_text("motd=x\nlevel-name=survival\n"); (srv / "purpur.yml").write_text("x: 1\n")
(srv / "plugins" / "Alpha-1.0.jar").write_bytes(jar("Alpha", "1.0"))
(srv / "plugins" / "Gamma-3.0.jar").write_bytes(jar("Gamma", "3.0"))
(srv / "survival" / "datapacks" / "CoolPack.zip").write_bytes(dp("CoolPack"))

r = c.post("/api/servers/detect", json={"kind": "local", "root_dir": str(srv)}).get_json()
check(r["software"] == "purpur" and r["world"] == "survival", f"detect purpur/world: {r['software']} {r['world']}")
check(r["dirs"] == {"plugin": "plugins", "datapack": "survival/datapacks"}, f"detected dirs {r['dirs']}")
check(c.post("/api/servers/detect", json={"kind": "local", "root_dir": "relative/path"}).status_code == 400, "relative path rejected")
r = c.post("/api/servers", json={"kind": "local", "root_dir": str(srv), "software": "purpur", "dirs": r["dirs"], "name": "My Server"})
check(r.status_code == 200, f"local server created {r.status_code} {r.get_data(as_text=True)[:120]}")
check(c.post("/api/servers", json={"kind": "local", "root_dir": str(srv)}).status_code == 400, "same folder cannot be added twice")
s = c.get("/api/servers").get_json()
sv = s["servers"][0]; sid = sv["id"]
check(sv["kind"] == "local" and sv["software"] == "purpur" and s["local_ok"], "server listed as local")
check(c.get(f"/api/servers/{sid}/status").get_json()["state"] in ("local", "offline"), "status for stopped folder server")
check(c.post(f"/api/servers/{sid}/power", json={"signal": "restart"}).status_code == 400, "power refused for local server")

inv = c.get(f"/api/servers/{sid}/inventory").get_json()
by = {f["name"]: f for f in inv["files"]}
check(by["Alpha-1.0.jar"]["status"] == "outdated" and by["Alpha-1.0.jar"]["category"] == "plugin", "Alpha outdated (plugin)")
check(by["Gamma-3.0.jar"]["status"] == "unregistered", "Gamma unregistered")
check(by["CoolPack.zip"]["category"] == "datapack" and by["CoolPack.zip"]["status"] == "latest", f"datapack matched ({by['CoolPack.zip']['status']})")
check(by["Alpha-1.0.jar"]["path"] == "plugins/Alpha-1.0.jar", "path relative to server folder")
sv = c.get("/api/servers").get_json()["servers"][0]
check(sv["summary"]["plugin"] == {"files": 2, "outdated": 1} and sv["summary"]["datapack"]["files"] == 1, f"summary {sv['summary']}")
pres = c.get("/api/servers/presence").get_json()["items"]
check(pres[str(lib["Alpha"]["id"])][0]["status"] == "outdated", "presence shows outdated")

# 1 件だけ更新
r = c.post(f"/api/servers/{sid}/push", json={"item_ids": [lib["Alpha"]["id"]]})
check(r.status_code == 200, "push single item started"); wait(c)
check((srv / "plugins" / "Alpha-1.1.jar").exists() and not (srv / "plugins" / "Alpha-1.0.jar").exists(), "Alpha replaced by 1.1 on disk")
check(not list((srv / "plugins").glob(".*part")), "no partial files left")
# Beta を送るとプラグインのフォルダへ
c.post(f"/api/servers/{sid}/push", json={"item_ids": [lib["Beta"]["id"]]}); wait(c)
check((srv / "plugins" / "Beta-2.0.jar").exists(), "Beta pushed into plugins/")
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
check(all(f["status"] in ("latest", "unregistered") for f in inv["files"]), "everything latest after push")

# 巻き戻し(最初の更新の前へ)
snaps = c.get(f"/api/servers/{sid}/snapshots").get_json()["snapshots"]
first = snaps[-1]
check(first["removed"][0]["name"] == "plugins/Alpha-1.0.jar" and first["added"] == ["plugins/Alpha-1.1.jar"], f"snapshot paths {first['removed']} {first['added']}")
c.post(f"/api/servers/{sid}/snapshots/{first['id']}/rollback", json={"restart": True}); js = wait(c)
check((srv / "plugins" / "Alpha-1.0.jar").exists() and not (srv / "plugins" / "Alpha-1.1.jar").exists(), "rollback restored Alpha 1.0")
check(js[0]["status"] == "done", f"rollback job done ({js[0]['status']})")

# 同期(更新あり + 予約なし)
r = c.post(f"/api/servers/{sid}/sync", json={"restart": True}); js = wait(c)
check((srv / "plugins" / "Alpha-1.1.jar").exists() and js[0]["status"] == "done", "sync updates Alpha and skips restart for local")

# 取り込み
c.post(f"/api/servers/{sid}/import", json={"names": ["plugins/Gamma-3.0.jar", "../etc/passwd", "plugins/../server.properties"]}); wait(c)
names = [i["name"] for i in c.get("/api/library").get_json()["items"]]
check("Gamma" in names, "import Gamma from server")

# 設定の変更・権限
r = c.patch(f"/api/servers/{sid}", json={"dirs": {"plugin": "plugins", "mod": "mods", "datapack": "../x"}})
check(r.status_code == 400, "dir with .. rejected")
r = c.patch(f"/api/servers/{sid}", json={"dirs": {"plugin": "plugins", "mod": "mods"}, "software": "paper"})
check(r.status_code == 200 and c.get("/api/servers").get_json()["servers"][0]["dirs"] == {"plugin": "plugins", "mod": "mods"}, "dirs updated")
inv = c.get(f"/api/servers/{sid}/inventory").get_json()
check(inv["absent"] == ["mod"], f"missing mods folder reported ({inv['absent']})")

# 編集者はフォルダのサーバーを追加できない
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"})
e = A.app.test_client(); e.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
e.post("/api/auth/login", json={"username": "ed", "password": "password123"})
check(e.post("/api/servers", json={"kind": "local", "root_dir": str(srv.parent)}).status_code == 403, "editor cannot add folder server")
check(e.post("/api/servers/detect", json={"kind": "local", "root_dir": "C:\\Windows" if os.name == "nt" else "/etc"}).status_code == 403, "editor cannot probe host folders")
check(e.get(f"/api/servers/{sid}/inventory").status_code in (403, 404), "editor cannot see owner's server")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
