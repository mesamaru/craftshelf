import io, json, os, sys, tempfile, zipfile
tmp = tempfile.mkdtemp(prefix="cs-f3-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)
def z(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as zz:
        for k, v in files.items(): zz.writestr(k, v)
    return b.getvalue()
c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "admin", "password": "password123"})
r = c.put("/api/upload?filename=Complementary_r5.2.zip", data=z({"shaders/composite.fsh": "x", "shaders/lang/en_us.lang": "x"})).get_json()
check(r["category"] == "shader", f"shader detect {r['category']}")
r = c.put("/api/upload?filename=BSL_v8.2.zip", data=z({"BSL_v8.2/shaders/final.fsh": "x"})).get_json()
check(r["category"] == "shader", f"shader in folder {r['category']}")
r = c.put("/api/upload?filename=MyPack-1.0.mrpack", data=z({"modrinth.index.json": json.dumps({"name": "MyPack", "versionId": "1.0", "dependencies": {"minecraft": "1.20.1", "fabric-loader": "0.15"}, "files": []})})).get_json()
check(r["category"] == "modpack" and r["name"] == "MyPack" and r["version"] == "1.0", f"modpack detect {r}")
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(lib["MyPack"]["mc_auto"] == "1.20.1", f"modpack mc {lib['MyPack']['mc_auto']}")
check(c.patch("/api/me/prefs", json={"lang": "en"}).get_json()["prefs"]["lang"] == "en", "lang pref saved")
check(c.patch("/api/me/prefs", json={"lang": "fr"}).status_code == 400, "bad lang rejected")
v = c.get("/api/search/versions?provider=modrinth&project_id=AANobbMI&loader=fabric&mc=1.21.1").get_json()["versions"]
check(v and all("1.21.1" in x["game_versions"] for x in v), f"versions filtered {len(v)}")
# lithium は前提なし。fabric-api に依存する mod(例: modmenu)で前提をまとめて入れる
mv = c.get("/api/search/versions?provider=modrinth&project_id=sodium-extra&loader=fabric&mc=1.20.1").get_json()["versions"]
deps = [d for d in mv[0]["deps"] if d["required"]]
check(deps and deps[0]["title"], f"deps titles {[d['title'] for d in deps]}")
r = c.post("/api/import", json={"provider": "modrinth", "project_id": "sodium-extra", "version_id": mv[0]["version_id"],
                                "loaders": "fabric", "game_versions": "1.20.1", "with_deps": [d["project_id"] for d in deps]}).get_json()
check(r.get("status") == "added" and r["deps"] and r["deps"][0]["status"] in ("added", "exists"), f"import with deps {r.get('deps')}")
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}
check(any(n == "Sodium" for n in lib), f"dep added {list(lib)}")
check(c.get("/api/servers/presence").get_json() == {"items": {}, "servers": []}, "presence empty")
print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")

sys.exit(1 if fails else 0)
