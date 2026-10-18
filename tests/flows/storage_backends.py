"""MC Pack Library のストレージ3方式(local / smb / webdav)を Flask test_client で通しテストする。"""
import io, os, sys, tempfile, threading, time, uuid, zipfile, json

APP_DIR = sys.argv[1]
tmp = tempfile.mkdtemp(prefix="mcpl-")
os.environ["DATA_DIR"] = os.path.join(tmp, "data")
os.environ["CONFIG_DIR"] = os.path.join(tmp, "config")
os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, APP_DIR)
import app as A  # noqa: E402
# SMB は、テスト用の共有を環境変数で指定したときだけ試す(指定が無ければ飛ばす)
SMB_SERVER = os.environ.get("CRAFTSHELF_TEST_SMB_SERVER", "")
SMB_SHARE = os.environ.get("CRAFTSHELF_TEST_SMB_SHARE", "")
SMB_AUTH = {k: v for k, v in (("username", os.environ.get("CRAFTSHELF_TEST_SMB_USER", "")),
                              ("password", os.environ.get("CRAFTSHELF_TEST_SMB_PASSWORD", ""))) if v}

c = A.app.test_client()
c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
assert c.post("/api/auth/setup", json={"username": "t", "password": "password123"}).status_code == 200
fails = []


def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        fails.append(msg)


def jar(name, ver):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\n")
        z.writestr("x/" + uuid.uuid4().hex, uuid.uuid4().hex)
    return b.getvalue()


def lib():
    r = c.get("/api/library")
    return r.get_json()


def flow(label):
    print(f"== {label}")
    d = lib()
    check(d["storage"]["error"] is None, f"storage OK ({d['storage']['path']})")
    a1, a2 = jar("TestPlug", "1.0.0"), jar("TestPlug", "1.2.0")
    r = c.put("/api/upload?filename=TestPlug-1.0.0.jar", data=a1).get_json()
    check(r.get("status") == "added", f"upload1 {r}")
    r = c.put("/api/upload?filename=TestPlug-1.2.0.jar", data=a2).get_json()
    check(r.get("status") == "added", "upload2")
    r = c.put("/api/upload?filename=dup.jar", data=a2).get_json()
    check(r.get("status") == "duplicate", "duplicate detected")
    r = c.put("/api/upload?filename=Other-2.0.jar", data=jar("Other", "2.0")).get_json()
    d = lib()
    items = {i["name"]: i for i in d["items"]}
    check(set(items) == {"TestPlug", "Other"}, f"items {list(items)}")
    tp = items["TestPlug"]
    check(len(tp["versions"]) == 2 and tp["versions"][0]["version"] == "1.2.0", "versions sorted")
    check(not any(v["missing"] for i in d["items"] for v in i["versions"]), "no missing")
    vid = tp["versions"][0]["id"]
    r = c.get(f"/api/versions/{vid}/download")
    check(r.status_code == 200 and r.data == a2, f"download bytes match ({r.status_code}, {len(r.data)})")
    # rename Other -> merge into TestPlug
    r = c.patch(f"/api/items/{items['Other']['id']}", json={"name": "TestPlug", "category": "plugin"})
    check(r.status_code == 200, f"merge {r.get_json()}")
    d = lib()
    check(len(d["items"]) == 1 and len(d["items"][0]["versions"]) == 3, "merged into one item")
    check(not any(v["missing"] for v in d["items"][0]["versions"]), "no missing after merge")
    # rename category
    iid = d["items"][0]["id"]
    r = c.patch(f"/api/items/{iid}", json={"name": "TestPlug", "category": "mod"})
    d = lib()
    check(d["items"][0]["category"] == "mod" and not any(v["missing"] for v in d["items"][0]["versions"]),
          "category move keeps files")
    # delete one version
    v0 = d["items"][0]["versions"][-1]["id"]
    check(c.delete(f"/api/versions/{v0}").status_code == 200, "delete version")
    # inbox scan: put a file directly into inbox via storage
    store, _t = None, None
    with A.app.test_request_context():
        store, _t = A.active_store()
        store.write_bytes("inbox/sub/Inboxed-3.1.jar", jar("Inboxed", "3.1"))
    r = c.post("/api/scan").get_json()
    check(r["added"] == 1 and not r["errors"] and r["missing"] == 0, f"scan {r}")
    with A.app.test_request_context():
        check(not store.exists("inbox/sub"), "inbox subfolder cleaned")
    d = lib()
    check({i["name"] for i in d["items"]} == {"TestPlug", "Inboxed"}, "scan registered")
    # cleanup all items
    for it in d["items"]:
        check(c.delete(f"/api/items/{it['id']}").status_code == 200, f"delete item {it['name']}")
    with A.app.test_request_context():
        files, _dirs = store.walk("library")
    check(files == [], f"library empty after delete ({files})")


flow("local")

# ---- SMB(指定したときだけ) ----
tid = None
if SMB_SERVER and SMB_SHARE:
    SMB_SUB = "_mcpl_test_" + uuid.uuid4().hex[:6]
    r = c.post("/api/storage/targets/test", json={"protocol": "smb", "server": SMB_SERVER,
                                                   "share": SMB_SHARE, "subpath": SMB_SUB, **SMB_AUTH}).get_json()
    check(r["ok"], f"smb test {r}")
    r = c.post("/api/storage/targets/test", json={"protocol": "smb", "server": SMB_SERVER,
                                                   "share": "NoSuchShare", **SMB_AUTH}).get_json()
    check(not r["ok"] and "共有名" in r["message"], f"smb bad share msg: {r['message']}")
    r = c.post("/api/storage/targets/test", json={"protocol": "smb", "server": "192.0.2.1",
                                                   "share": "x"}).get_json()
    check(not r["ok"], f"smb unreachable msg: {r['message']}")
    tid = c.post("/api/storage/targets", json={"name": "SMB", "protocol": "smb", "server": SMB_SERVER,
                                                "share": SMB_SHARE, "subpath": SMB_SUB, **SMB_AUTH}).get_json()["id"]
    r = c.post(f"/api/storage/targets/{tid}/activate")
    check(r.status_code == 200, f"smb activate {r.get_json()}")
    flow("smb")

else:
    print("  SKIP smb(CRAFTSHELF_TEST_SMB_SERVER / CRAFTSHELF_TEST_SMB_SHARE が未設定)")

# ---- WebDAV (local wsgidav) ----
from wsgidav.wsgidav_app import WsgiDAVApp  # noqa: E402
from cheroot import wsgi  # noqa: E402
davroot = os.path.join(tmp, "dav"); os.makedirs(davroot)
dav = WsgiDAVApp({"provider_mapping": {"/remote.php/dav/files/alice": davroot},
                  "simple_dc": {"user_mapping": {"*": {"alice": {"password": "pw"}}}},
                  "http_authenticator": {"domain_controller": None, "accept_basic": True,
                                         "accept_digest": False, "default_to_digest": False},
                  "verbose": 1, "logging": {"enable": False}})
srv = wsgi.Server(("127.0.0.1", 18099), dav)
threading.Thread(target=srv.start, daemon=True).start()
time.sleep(1.5)
r = c.post("/api/storage/targets/test", json={"protocol": "webdav", "server": "http://127.0.0.1:18099",
                                               "username": "alice", "password": "bad"}).get_json()
check(not r["ok"] and "認証" in r["message"], f"dav bad pw: {r['message']}")
did = c.post("/api/storage/targets", json={"name": "NC", "protocol": "webdav", "server": "http://127.0.0.1:18099",
                                            "subpath": "mc lib/テスト", "username": "alice", "password": "pw"}).get_json()["id"]
check(c.post(f"/api/storage/targets/{did}/test").get_json()["ok"], "dav test existing")
r = c.post(f"/api/storage/targets/{did}/activate")
check(r.status_code == 200, f"dav activate {r.get_json()}")
flow("webdav")
check(os.path.isdir(os.path.join(davroot, "mc lib", "テスト", "library")), "dav subpath created on server")

# switch back and list targets
c.post("/api/storage/targets/1/activate")
ts = c.get("/api/storage/targets").get_json()["targets"]
check(len(ts) == (3 if tid else 2) and all("password_enc" not in t for t in ts), "targets listed w/o secrets")
if tid:
    check(c.delete(f"/api/storage/targets/{tid}").status_code == 200, "delete smb target")
srv.stop()

# remove SMB test folder
if tid:
    import smbclient  # noqa: E402
    if SMB_AUTH:
        smbclient.register_session(SMB_SERVER, username=SMB_AUTH.get("username"), password=SMB_AUTH.get("password"))
    SHARE = "\\\\" + SMB_SERVER + "\\" + SMB_SHARE
    for name in smbclient.listdir(SHARE):  # this run + any left by aborted runs
        if not name.startswith("_mcpl_test_"):
            continue
        base = SHARE + "\\" + name
        for root, dirs, files in list(smbclient.walk(base, topdown=False)):
            for f in files: smbclient.remove(root + "\\" + f)
            for d_ in dirs: smbclient.rmdir(root + "\\" + d_)
        smbclient.rmdir(base)
    print("SMB test folders removed")

print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
