"""認証・保存先の中身確認/移行・配布元連携の通しテスト(実SMB/実Modrinth/実Spigetを使う)。"""
import io, os, sys, tempfile, time, uuid, zipfile

APP_DIR = sys.argv[1]
tmp = tempfile.mkdtemp(prefix="mcpl2-")
os.environ["DATA_DIR"] = os.path.join(tmp, "data")
os.environ["CONFIG_DIR"] = os.path.join(tmp, "config")
os.environ["MCPL_NO_SCHEDULER"] = "1"
sys.path.insert(0, APP_DIR)
import app as A  # noqa: E402
# SMB は、テスト用の共有を環境変数で指定したときだけ使う(無ければ手元の WebDAV へ移す)
SMB_SERVER = os.environ.get("CRAFTSHELF_TEST_SMB_SERVER", "")
SMB_SHARE = os.environ.get("CRAFTSHELF_TEST_SMB_SHARE", "")
SMB_AUTH = {k: v for k, v in (("username", os.environ.get("CRAFTSHELF_TEST_SMB_USER", "")),
                              ("password", os.environ.get("CRAFTSHELF_TEST_SMB_PASSWORD", ""))) if v}

fails = []
H = {"X-Requested-With": "mcpl"}


def check(cond, msg):
    print(("  OK  " if cond else "  NG  ") + msg)
    if not cond:
        fails.append(msg)


def jar(name, ver, extra=""):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\n{extra}")
        z.writestr("x/" + uuid.uuid4().hex, uuid.uuid4().hex)
    return b.getvalue()


def wait_job(c, jid, limit=300):
    t = time.time()
    while time.time() - t < limit:
        j = c.get(f"/api/jobs/{jid}").get_json()
        if j["status"] not in ("running", "queued"):
            return j
        time.sleep(0.5)
    return j


admin = A.app.test_client()
print("== auth")
me = admin.get("/api/auth/me").get_json()
check(me["user"] is None and me["setup_required"], "setup required initially")
check(admin.get("/api/library").status_code == 401, "library requires login")
check(admin.post("/api/auth/setup", json={"username": "maru", "password": "short"}, headers=H).status_code == 400, "short pw rejected")
check(admin.post("/api/auth/setup", json={"username": "maru", "password": "password123"}).status_code == 403, "CSRF header required")
check(admin.post("/api/auth/setup", json={"username": "maru", "password": "password123"}, headers=H).status_code == 200, "setup admin")
check(admin.get("/api/auth/me").get_json()["user"]["role"] == "admin", "logged in as admin")
other = A.app.test_client()
check(other.post("/api/auth/setup", json={"username": "evil", "password": "password123"}, headers=H).status_code == 409, "second setup blocked")
check(admin.post("/api/users", json={"username": "viewer1", "password": "password123", "role": "viewer"}, headers=H).status_code == 200, "create viewer")
check(admin.post("/api/users", json={"username": "ed1", "password": "password123", "role": "editor"}, headers=H).status_code == 200, "create editor")
viewer, editor = A.app.test_client(), A.app.test_client()
check(viewer.post("/api/auth/login", json={"username": "viewer1", "password": "nope"}, headers=H).status_code == 401, "bad login")
check(viewer.post("/api/auth/login", json={"username": "VIEWER1", "password": "password123"}, headers=H).status_code == 200, "viewer login (case-insensitive)")
editor.post("/api/auth/login", json={"username": "ed1", "password": "password123"}, headers=H)
check(viewer.get("/api/library").status_code == 200, "viewer can read")
check(viewer.put("/api/upload?filename=a.jar", data=jar("A", "1"), headers=H).status_code == 403, "viewer cannot upload")
check(editor.get("/api/storage/targets").status_code == 403, "editor cannot see storage settings")
check(editor.put("/api/upload?filename=A-1.0.jar", data=jar("A", "1.0"), headers=H).get_json()["status"] == "added", "editor uploads")
uid = [u for u in admin.get("/api/users").get_json()["users"] if u["username"] == "ed1"][0]["id"]
admin.patch(f"/api/users/{uid}", json={"password": "newpassword1"}, headers=H)
check(editor.get("/api/library").status_code == 401, "password reset logs out other sessions")
me_id = admin.get("/api/auth/me").get_json()["user"]["id"]
check(admin.delete(f"/api/users/{me_id}", headers=H).status_code == 400, "cannot delete self")
check(admin.patch(f"/api/users/{me_id}", json={"role": "editor"}, headers=H).status_code == 400, "cannot demote last admin")

print("== contents & migrate local -> smb")
c = admin
c.put("/api/upload?filename=B-2.0.jar", data=jar("B", "2.0"), headers=H)
c.put("/api/upload?filename=B-2.1.jar", data=jar("B", "2.1"), headers=H)
d = c.get("/api/storage/targets/1/contents").get_json()
check(d["totals"]["items"] == 2 and d["totals"]["files"] == 3, f"local contents {d['totals']}")
# stray file in library -> unregistered
with A.app.test_request_context():
    A.store_for(A.db().execute("SELECT * FROM storage_targets WHERE id=1").fetchone()).write_bytes("library/plugins/stray.jar", b"x")
d = c.get("/api/storage/targets/1/contents").get_json()
check(d["unregistered"]["count"] == 1, "unregistered file listed")
SUB = "_mcpl_test_" + uuid.uuid4().hex[:6]
if SMB_SERVER and SMB_SHARE:
    tid = c.post("/api/storage/targets", json={"name": "SMB", "protocol": "smb", "server": SMB_SERVER,
                                              "share": SMB_SHARE, "subpath": SUB, **SMB_AUTH}, headers=H).get_json()["id"]
else:
    import threading as _th  # noqa: E402
    from wsgidav.wsgidav_app import WsgiDAVApp  # noqa: E402
    from cheroot import wsgi as _wsgi  # noqa: E402
    _dav = os.path.join(tempfile.mkdtemp(), "dav"); os.makedirs(_dav)
    _srv = _wsgi.Server(("127.0.0.1", 18098), WsgiDAVApp({
        "provider_mapping": {"/dav": _dav}, "simple_dc": {"user_mapping": {"*": {"u": {"password": "p"}}}},
        "http_authenticator": {"domain_controller": None, "accept_basic": True, "accept_digest": False, "default_to_digest": False},
        "verbose": 1, "logging": {"enable": False}}))
    _th.Thread(target=_srv.start, daemon=True).start(); time.sleep(1.5)
    tid = c.post("/api/storage/targets", json={"name": "DAV", "protocol": "webdav", "server": "http://127.0.0.1:18098/dav",
                                              "subpath": SUB, "username": "u", "password": "p"}, headers=H).get_json()["id"]
j = c.post("/api/storage/migrate", json={"source_id": 1, "dest_id": tid, "mode": "copy"}, headers=H).get_json()
j = wait_job(c, j["id"])
check(j["status"] == "done" and j["result"]["copied"] == 3, f"copy job {j['result']} {j['log'][-2:]}")
j = wait_job(c, c.post("/api/storage/migrate", json={"source_id": 1, "dest_id": tid, "mode": "copy"}, headers=H).get_json()["id"])
check(j["result"]["duplicates"] == 3 and j["result"]["copied"] == 0, "re-copy detects duplicates")
d2 = c.get(f"/api/storage/targets/{tid}/contents").get_json()
check(d2["totals"]["items"] == 2 and d2["totals"]["files"] == 3 and d2["totals"]["missing"] == 0, f"smb contents {d2['totals']}")
# move one item back? move all smb->local should dup & remove from smb
j = wait_job(c, c.post("/api/storage/migrate", json={"source_id": tid, "dest_id": 1, "mode": "move"}, headers=H).get_json()["id"])
check(j["result"]["removed"] == 3, f"move job {j['result']}")
d2 = c.get(f"/api/storage/targets/{tid}/contents").get_json()
check(d2["totals"]["items"] == 0, "source emptied after move")
with A.app.test_request_context():
    st = A.store_for(A.db().execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone())
    check(st.walk("library")[0] == [], "smb library files removed")

print("== sources")
# 古いLuckPermsを装ったファイル → Spigot の名前一致で紐付く
r = c.put("/api/upload?filename=LuckPerms-Bukkit-5.4.0.jar", data=jar("LuckPerms", "5.4.0"), headers=H).get_json()
lp = r["item_id"]
r = c.post(f"/api/items/{lp}/source/detect", headers=H).get_json()
check((not r["linked"]) and r["candidates"] and r["candidates"][0]["exact"], "name match is offered as candidate, not auto-linked")
c0 = r["candidates"][0]
r = c.post(f"/api/items/{lp}/source", json={"provider": c0["provider"], "project_id": c0["project_id"]}, headers=H).get_json()
check(r["source"]["status"] == "update" and r["source"]["message"] == "新しいバージョンが公開されています", f"pick candidate -> spigot says update: {r['source']['message']} {r['source']['latest'].get('version')}")
lib0 = {i["id"]: i for i in c.get("/api/library").get_json()["items"]}
check(lib0[lp]["mc_auto"] == "", f"no mc info for fake jar ({lib0[lp]['mc_auto']!r})")
check(c.patch(f"/api/items/{lp}", json={"name": "LuckPerms", "category": "plugin", "mc_versions": "1.20〜1.21"}, headers=H).status_code == 200
      and {i["id"]: i for i in c.get("/api/library").get_json()["items"]}[lp]["mc_versions"] == "1.20〜1.21", "mc_versions editable")
# Modrinth URL で紐付け直し
r = c.post(f"/api/items/{lp}/source", json={"url": "https://modrinth.com/plugin/luckperms"}, headers=H).get_json()
s = r["source"]
check(s["provider"] == "modrinth" and s["status"] == "update" and s["latest"].get("downloadable"), f"modrinth link: {s['status']} {s['latest'].get('version')} loaders={s['loaders']}")
r = c.post(f"/api/items/{lp}/source/download", headers=H).get_json()
check(r.get("status") == "added", f"download latest: {r}")
lib = {i["id"]: i for i in c.get("/api/library").get_json()["items"]}
check(len(lib[lp]["versions"]) == 2 and lib[lp]["source"]["status"] == "up_to_date", f"now up to date: {lib[lp]['source']['message']} versions={[v['version'] for v in lib[lp]['versions']]}")
dl_sha1 = [v for v in lib[lp]["versions"] if v["version"] != "5.4.0"][0]["sha1"]
# ハッシュ検出: 新しいアイテムとしてダウンロード済みファイルを別名で登録 → Modrinth hash で検出
r = c.post(f"/api/items/{lp}/source/check", headers=H).get_json()
check(r["source"]["status"] == "up_to_date", "check again up to date")
# import from URL (Modrinth, fabric mod)
r = c.post("/api/import", json={"url": "https://modrinth.com/mod/fabric-api", "loaders": "fabric", "game_versions": "1.20.1"}, headers=H)
rj = r.get_json()
check(r.status_code == 200 and rj.get("status") == "added" and rj["category"] == "mod", f"import fabric-api: {rj}")
fid = rj.get("item_id")
lib = {i["id"]: i for i in c.get("/api/library").get_json()["items"]}
if fid in lib:
    s = lib[fid]["source"]
    check(s["game_versions"] == ["1.20.1"] and s["loaders"] == ["fabric"] and s["status"] == "up_to_date", f"import linked: {s['status']} {s['message']} {s['loaders']} {s['game_versions']}")
# detect via modrinth hash: remove source, detect again
c.delete(f"/api/items/{fid}/source", headers=H)
r = c.post(f"/api/items/{fid}/source/detect", headers=H).get_json()
check(r["linked"] and "Modrinth" in r["how"], f"hash detect: {r['how']}")
# CurseForge without key
r = c.post(f"/api/items/{fid}/source", json={"url": "https://www.curseforge.com/minecraft/mc-mods/jei"}, headers=H)
check(r.status_code == 400 and "APIキー" in r.get_json()["error"], f"curseforge needs key: {r.get_json()}")
# bulk
j = wait_job(c, c.post("/api/updates/run", json={"detect": True, "check": True}, headers=H).get_json()["id"])
check(j["status"] == "done", f"bulk job {j['result']} {j['log'][-3:]}")
# viewer cannot run updates
viewer.post("/api/auth/login", json={"username": "viewer1", "password": "password123"}, headers=H)
check(viewer.post("/api/updates/run", json={}, headers=H).status_code == 403, "viewer cannot run updates")
check(viewer.get("/api/settings").status_code == 200 and viewer.patch("/api/settings", json={"auto_download": True}, headers=H).status_code == 403, "settings perms")
check(c.patch("/api/settings", json={"check_interval_hours": 12, "cf_api_key": "abc"}, headers=H).get_json()["cf_api_key_set"], "settings saved")

# cleanup smb
if SMB_SERVER and SMB_SHARE:
    import smbclient  # noqa: E402
    if SMB_AUTH:
        smbclient.register_session(SMB_SERVER, username=SMB_AUTH.get("username"), password=SMB_AUTH.get("password"))
    SHARE = "\\\\" + SMB_SERVER + "\\" + SMB_SHARE
    for name in smbclient.listdir(SHARE):
        if name.startswith("_mcpl_test_"):
            base = SHARE + "\\" + name
            for root, dirs, files in list(smbclient.walk(base, topdown=False)):
                for f in files: smbclient.remove(root + "\\" + f)
                for d_ in dirs: smbclient.rmdir(root + "\\" + d_)
            smbclient.rmdir(base)
print("\nRESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL: {fails}")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
