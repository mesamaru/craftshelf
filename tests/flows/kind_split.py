"""同じ名前の Mod とプラグイン: 検索から入れても混ざらない・混ざったものを分けられる・前提の判定(同梱の部品・Fabric API)。"""
import io, json, os, sys, tempfile, zipfile
tmp = tempfile.mkdtemp(prefix="cs-kind-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
from craftshelf import upstream as U  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


def zipped(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for n, data in files.items():
            z.writestr(n, data)
    return b.getvalue()


def plugin(name, ver):
    return zipped({"plugin.yml": f"name: {name}\nversion: {ver}\nmain: x.{name}\n"})


def fabric(mod_id, name, ver, depends=(), nested=(), provides=()):
    meta = {"schemaVersion": 1, "id": mod_id, "name": name, "version": ver, "depends": {d: "*" for d in ("minecraft", *depends)},
            "jars": [{"file": f"META-INF/jars/{n}.jar"} for n in nested], "provides": list(provides)}
    files = {"fabric.mod.json": json.dumps(meta)}
    for n in nested:  # 同梱する部品(jar-in-jar)
        files[f"META-INF/jars/{n}.jar"] = zipped({"fabric.mod.json": json.dumps({"schemaVersion": 1, "id": n, "version": "1.0"})})
    return zipped(files)


H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)
up = lambda fn, data, q="": c.put(f"/api/upload?filename={fn}{q}", data=data, headers=H).get_json()  # noqa: E731
lib = lambda: c.get("/api/library", headers=H).get_json()["items"]  # noqa: E731
find = lambda name, cat: next((i for i in lib() if i["name"] == name and i["category"] == cat), None)  # noqa: E731

# ---- 検索から入れる: プラグインのタブ(category=plugin)から Fabric 版を選んでも、Mod として登録される ----
up("WorldEdit-7.3.jar", plugin("WorldEdit", "7.3.0"))
WE_MOD = fabric("worldedit", "WorldEdit", "7.4.6+7648")
U.src.project_info = lambda provider, pid, key=None: {"provider": "modrinth", "project_id": "1u6JkXh5", "title": "WorldEdit",
                                                     "page_url": "https://modrinth.com/plugin/worldedit"}
U.src.version_info = lambda provider, pid, vid, key=None: {"version": "7.4.6+7648", "downloadable": True, "url": "https://cdn.modrinth.com/x.jar",
                                                          "file_name": "worldedit-mod-7.4.6.jar", "loaders": ["fabric"], "game_versions": ["1.21.1"]}
U.src.latest = lambda *a, **k: None
U.src.download = lambda url, dest, sha1="": open(dest, "wb").write(WE_MOD)
r = c.post("/api/import", json={"provider": "modrinth", "project_id": "1u6JkXh5", "version_id": "v1", "loaders": "fabric",
                                "game_versions": "1.21.1", "category": "plugin"}, headers=H)
check(r.status_code == 200 and r.get_json()["category"] == "mod", f"imported Fabric file goes to Mod, not the plugin tab's type ({r.get_json()})")
pl, mod = find("WorldEdit", "plugin"), find("WorldEdit", "mod")
check(pl and len(pl["versions"]) == 1 and mod and len(mod["versions"]) == 1, "plugin and mod WorldEdit are separate items")

# ---- 混ざってしまったものを分ける ----
up("WorldEdit-7.4.5.jar", fabric("worldedit", "WorldEdit", "7.4.5"), "&category=plugin")  # 古い版で混ざった状態を作る
pl = find("WorldEdit", "plugin")
stray = [v for v in pl["versions"] if v["meta"].get("loader") == "Fabric"]
check(len(pl["versions"]) == 2 and len(stray) == 1, "a Fabric file mixed into the plugin item (reproduced)")
r = c.post(f"/api/versions/{stray[0]['id']}/move", json={"category": "mod"}, headers=H)
check(r.status_code == 200 and not r.get_json()["removed_item"], f"split the Fabric file into the Mod item ({r.get_json()})")
pl, mod = find("WorldEdit", "plugin"), find("WorldEdit", "mod")
check(len(pl["versions"]) == 1 and len(mod["versions"]) == 2, "plugin keeps 1 version, mod now has 2")
dl = c.get(f"/api/versions/{stray[0]['id']}/download", headers=H)
check(dl.status_code == 200 and dl.data[:2] == b"PK", "the moved file can still be downloaded")
check(c.post(f"/api/versions/{stray[0]['id']}/move", json={"category": "mod"}, headers=H).status_code == 400, "moving to the same type → 400")
check(c.post(f"/api/versions/{stray[0]['id']}/move", json={"category": "nope"}, headers=H).status_code == 400, "bad type → 400")
check(c.post("/api/versions/999999/move", json={"category": "mod"}, headers=H).status_code == 404, "unknown version → 404")

# ---- 前提: Fabric API の部品は Fabric API、同梱しているものは数えない、同じ名前なら同じ種類のものを選ぶ ----
up("fabric-api-0.100.jar", fabric("fabric-api", "Fabric API", "0.100.0", nested=("fabric-api-base", "fabric-networking-api-v1")))
up("Proxy-1.0.jar", fabric("proxy", "Proxy", "1.0", depends=("fabric-api-base", "fabric-networking-api-v1", "fabric-command-api-v2", "worldedit")))
up("Bundler-1.0.jar", fabric("bundler", "Bundler", "1.0", depends=("apollib",), nested=("apollib",)))
up("Needy-1.0.jar", fabric("needy", "Needy", "1.0", depends=("fabric-api-base", "nothere")))
fapi, proxy, bundler, needy = find("Fabric API", "mod"), find("Proxy", "mod"), find("Bundler", "mod"), find("Needy", "mod")
check("fabricnetworkingapiv1" in fapi["dep_key"] and "fabricapibase" in fapi["dep_key"], f"Fabric API provides its parts ({fapi['dep_key']})")
names = [d["name"] for d in proxy["dep_status"]]
check(names == ["fabric-api", "worldedit"], f"Fabric API parts are collapsed into one 'fabric-api' ({names})")
st = {d["name"]: d["item_id"] for d in proxy["dep_status"]}
check(st["fabric-api"] == fapi["id"], "fabric-api is found in the library")
check(st["worldedit"] == find("WorldEdit", "mod")["id"], "a Mod's 'worldedit' dependency points to the Mod, not the plugin")
check(proxy["missing_deps"] == [], f"nothing missing for Proxy ({proxy['missing_deps']})")
check(bundler["depends"] == [] and bundler["missing_deps"] == [], f"a bundled dependency is not counted ({bundler['depends']})")
check(needy["missing_deps"] == ["nothere"], f"a really missing dependency is still reported ({needy['missing_deps']})")

# ---- 権限: 閲覧者は分けられない ----
c.post("/api/users", json={"username": "viewer", "password": "password123", "role": "viewer"}, headers=H)
v = A.app.test_client(); v.post("/api/auth/login", json={"username": "viewer", "password": "password123"}, headers=H)
check(v.post(f"/api/versions/{stray[0]['id']}/move", json={"category": "plugin"}, headers=H).status_code in (403, 404), "viewer cannot split versions")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
