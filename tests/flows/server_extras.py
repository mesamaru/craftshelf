"""サーバー機能の拡張(01.17)のテスト。"""
import io, json, os, socket, struct, sys, tempfile, threading, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(); os.environ["DATA_DIR"] = tmp; os.environ["MCPL_NO_SCHEDULER"] = "1"; os.environ["CRAFTSHELF_TELEMETRY_URL"] = ""
sys.path.insert(0, sys.argv[1]); import app as A
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)
def jar(name, ver, api="1.20"):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("plugin.yml", f"name: {name}\nversion: {ver}\nmain: x.Y\napi-version: {api}\n"); z.writestr("x/a", ver)
    return b.getvalue()
def wait(c):
    js = []
    for _ in range(400):
        js = c.get("/api/jobs").get_json()["jobs"]
        if js and all(j["status"] != "running" for j in js): return js
        time.sleep(0.05)
    return js

def vi(n):
    o = b""
    while True:
        b = n & 0x7F; n >>= 7; o += bytes([b | (0x80 if n else 0)])
        if not n: return o
def recv_exact(c, n):
    buf = b""
    while len(buf) < n:
        x = c.recv(n - len(buf))
        if not x: raise EOFError
        buf += x
    return buf
def slp_server():
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(5)
    def rv(c):
        n = s = 0
        while True:
            b = recv_exact(c, 1)[0]; n |= (b & 0x7F) << s; s += 7
            if not b & 0x80: return n
    def run():
        while True:
            c, _ = srv.accept()
            try:
                c.settimeout(3)
                recv_exact(c, rv(c))          # handshake
                recv_exact(c, rv(c))          # status request
                js = json.dumps({"version": {"name": "Paper 1.20.4", "protocol": 765}, "players": {"online": 3, "max": 20, "sample": [{"name": "Alex", "id": "x"}]}, "description": {"text": "Hello §aWorld"}}).encode()
                body = b"\x00" + vi(len(js)) + js
                c.sendall(vi(len(body)) + body)
            except Exception:
                pass
            finally:
                c.close()
    threading.Thread(target=run, daemon=True).start()
    return srv.getsockname()[1]
RCON_LOG = []
def rcon_server(password):
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(5)
    def handle(c):
        try:
            while True:
                size = struct.unpack("<i", recv_exact(c, 4))[0]; data = recv_exact(c, size)
                rid, typ = struct.unpack("<ii", data[:8]); body = data[8:-2].decode()
                if typ == 3:
                    out = struct.pack("<ii", rid if body == password else -1, 2) + b"\x00\x00"
                else:
                    RCON_LOG.append(body)
                    out = struct.pack("<ii", rid, 0) + ("There are 3 of a max of 20 players online: Alex" if body == "list" else "ok").encode() + b"\x00\x00"
                c.sendall(struct.pack("<i", len(out)) + out)
        except Exception:
            pass
        finally:
            c.close()
    def run():
        while True:
            c, _ = srv.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
    threading.Thread(target=run, daemon=True).start()
    return srv.getsockname()[1]
SLP = slp_server(); RCON = rcon_server("secret")

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
for n, v, api in (("Alpha", "1.0", "1.20"), ("Alpha", "1.1", "1.20"), ("Beta", "1.0", "1.20"), ("Beta", "2.0", "1.21"), ("Gamma", "1.0", "1.20"), ("Gamma", "1.5", "1.20")):
    c.put(f"/api/upload?filename={n}-{v}.jar", data=jar(n, v, api))
lib = {i["name"]: i for i in c.get("/api/library").get_json()["items"]}

def mkserver(name, plugins):
    root = Path(tempfile.mkdtemp()) / name; (root / "plugins").mkdir(parents=True); (root / "world" / "region").mkdir(parents=True)
    (root / "server.properties").write_text("level-name=world\nserver-port=25565\n")
    (root / "version_history.json").write_text(json.dumps({"currentVersion": "git-Paper-100 (MC: 1.20.4)"}))
    (root / "world" / "level.dat").write_bytes(b"x" * 100); (root / "world" / "region" / "r.0.0.mca").write_bytes(b"y" * 200)
    for n, v in plugins:
        (root / "plugins" / f"{n}-{v}.jar").write_bytes(jar(n, v))
    (root / "plugins" / "Alpha").mkdir(); (root / "plugins" / "Alpha" / "config.yml").write_text("setting: original\n")
    return root
r1 = mkserver("stage", [("Alpha", "1.0"), ("Beta", "1.0"), ("Gamma", "1.0")])
r2 = mkserver("prod", [("Alpha", "1.0"), ("Beta", "1.0")])
d = c.post("/api/servers/detect", json={"kind": "local", "root_dir": str(r1)}).get_json()
check(d["mc"] == "1.20.4" and d["build"] == "100", f"detect mc/build {d.get('mc')} {d.get('build')}")
for root, nm in ((r1, "Stage"), (r2, "Prod")):
    c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "name": nm, "dirs": {"plugin": "plugins"}})
sv = {s["name"]: s for s in c.get("/api/servers").get_json()["servers"]}
s1, s2 = sv["Stage"]["id"], sv["Prod"]["id"]

# 状態・人数・RCON
r = c.patch(f"/api/servers/{s1}", json={"address": f"127.0.0.1:{SLP}", "mc_version": "1.20.4", "rcon_port": RCON, "rcon_password": "secret"})
check(r.status_code == 200, f"address / mc / rcon saved {r.get_data(as_text=True)[:100]}")
st = c.get(f"/api/servers/{s1}/status").get_json()
check(st["state"] == "running" and (st.get("ping") or {}).get("players") == 3 and st["ping"]["max"] == 20 and st["ping"]["motd"] == "Hello World", f"live status {st}")
srv_pub = [s for s in c.get("/api/servers").get_json()["servers"] if s["id"] == s1][0]
check("rcon_password" not in srv_pub and srv_pub["has_rcon"], "rcon password never returned")
r = c.post(f"/api/servers/{s1}/rcon").get_json()
check(r.get("ok") and "3 of a max" in r["message"], f"rcon test {r}")
check(c.patch(f"/api/servers/{s1}", json={"mc_version": "abc"}).status_code == 400, "bad mc version rejected")

# 互換: Beta 2.0 は api-version 1.21 → MC 1.20.4 には入れない
inv = c.get(f"/api/servers/{s1}/inventory").get_json()
beta = [f for f in inv["files"] if f["item_name"] == "Beta"][0]
check(beta["status"] == "outdated" and beta["compat"] is False, f"Beta latest incompatible ({beta['compat']}, {beta.get('compat_mc')})")
alpha = [f for f in inv["files"] if f["item_name"] == "Alpha"][0]
check(alpha["compat"] is True, "Alpha compatible")

# 見送り
c.post(f"/api/servers/{s1}/hold", json={"item_id": lib["Gamma"]["id"], "hold": True})
inv = c.get(f"/api/servers/{s1}/inventory").get_json()
check([f for f in inv["files"] if f["item_name"] == "Gamma"][0]["held"], "Gamma held")
c.post(f"/api/servers/{s1}/sync", json={}); js = wait(c)
log = " ".join(js[0]["log"])
check((r1 / "plugins" / "Alpha-1.1.jar").exists(), "sync updated Alpha")
check((r1 / "plugins" / "Beta-1.0.jar").exists() and "対応していない" in log, "sync skipped incompatible Beta")
check((r1 / "plugins" / "Gamma-1.0.jar").exists() and "見送り中" in log, "sync skipped held Gamma")
check("設定フォルダを退避" in log, f"plugin config folder backed up")
c.post(f"/api/servers/{s1}/push", json={"item_ids": [lib["Beta"]["id"]], "force": True}); wait(c)
check((r1 / "plugins" / "Beta-2.0.jar").exists(), "force push installs incompatible version")
c.post(f"/api/servers/{s1}/hold", json={"item_id": lib["Gamma"]["id"], "hold": False})

# 巻き戻しで設定フォルダも戻る
(r1 / "plugins" / "Alpha" / "config.yml").write_text("setting: changed\n")
snaps = c.get(f"/api/servers/{s1}/snapshots").get_json()["snapshots"]
sync_snap = [x for x in snaps if any(r.get("dir") for r in x["removed"])][0]
c.post(f"/api/servers/{s1}/snapshots/{sync_snap['id']}/rollback", json={}); wait(c)
check((r1 / "plugins" / "Alpha" / "config.yml").read_text() == "setting: original\n", "rollback restored plugin config")
check((r1 / "plugins" / "Alpha-1.0.jar").exists(), "rollback restored Alpha 1.0")

# 無効化・有効化
c.post(f"/api/servers/{s1}/toggle", json={"path": "plugins/Gamma-1.0.jar", "enable": False})
check((r1 / "plugins" / "Gamma-1.0.jar.disabled").exists(), "disable renames file")
inv = c.get(f"/api/servers/{s1}/inventory").get_json()
g = [f for f in inv["files"] if f["name"] == "Gamma-1.0.jar.disabled"][0]
check(g["status"] == "disabled" and g["item_name"] == "Gamma", "disabled file still recognised")
c.post(f"/api/servers/{s1}/sync", json={}); wait(c)
check((r1 / "plugins" / "Gamma-1.0.jar.disabled").exists() and not (r1 / "plugins" / "Gamma-1.5.jar").exists(), "sync leaves disabled files alone")
check(c.post(f"/api/servers/{s1}/toggle", json={"path": "../x/Gamma.jar.disabled", "enable": True}).status_code == 400, "toggle outside folders rejected")
c.post(f"/api/servers/{s1}/toggle", json={"path": "plugins/Gamma-1.0.jar.disabled", "enable": True})
check((r1 / "plugins" / "Gamma-1.0.jar").exists(), "enable renames back")

# コピー(update → add → mirror)
c.post(f"/api/servers/{s1}/copy", json={"targets": [s2], "mode": "update"}); wait(c)
names2 = sorted(p.name for p in (r2 / "plugins").glob("*.jar"))
check("Gamma-1.0.jar" not in names2 and "Alpha-1.1.jar" in names2, f"update mode only updates existing ({names2})")
c.post(f"/api/servers/{s1}/copy", json={"targets": [s2], "mode": "add"}); wait(c)
names2 = sorted(p.name for p in (r2 / "plugins").glob("*.jar"))
check("Gamma-1.0.jar" in names2, f"add mode adds missing ({names2})")
(r1 / "plugins" / "Beta-2.0.jar").unlink()
c.post(f"/api/servers/{s1}/copy", json={"targets": [s2], "mode": "mirror"}); wait(c)
names2 = sorted(p.name for p in (r2 / "plugins").glob("*.jar"))
check(not any(n.startswith("Beta") for n in names2), f"mirror removes extras ({names2})")
# 設定の「同期」: このサーバーを、ほかのサーバー・セットにそろえる
st = c.post("/api/sets", json={"name": "BetaOnly", "items": [{"item_id": lib["Beta"]["id"]}]}).get_json()
set_id = st.get("id") or (st.get("set") or {}).get("id")
c.post(f"/api/servers/{s2}/sync-from", json={"set_id": set_id, "mode": "add"}); wait(c)
names2 = sorted(p.name for p in (r2 / "plugins").glob("*.jar"))
check(any(n.startswith("Beta") for n in names2) and "Alpha-1.1.jar" in names2, f"sync-from set (add) adds Beta and keeps others ({names2})")
c.post(f"/api/servers/{s2}/sync-from", json={"set_id": set_id, "mode": "mirror"}); wait(c)
names2 = sorted(p.name for p in (r2 / "plugins").glob("*.jar"))
check(any(n.startswith("Beta") for n in names2) and not any(n.startswith(("Alpha", "Gamma")) for n in names2), f"sync-from set (mirror) leaves only the set ({names2})")
c.post(f"/api/servers/{s2}/sync-from", json={"server_id": s1, "mode": "mirror"}); wait(c)
names1 = sorted(p.name for p in (r1 / "plugins").glob("*.jar")); names2 = sorted(p.name for p in (r2 / "plugins").glob("*.jar"))
check(names2 == names1, f"sync-from server (mirror) matches the other server ({names1} / {names2})")
check(c.post(f"/api/servers/{s2}/sync-from", json={"server_id": s2}).status_code == 400, "cannot sync from itself")
check(c.post(f"/api/servers/{s2}/sync-from", json={}).status_code == 400, "source required")
r = c.patch(f"/api/servers/{s1}", json={"stage_targets": [s2]})
check(r.status_code == 200 and [s for s in c.get("/api/servers").get_json()["servers"] if s["id"] == s2][0]["staged_from"] == [s1], "staging relation saved")

# ワールドのバックアップ
RCON_LOG.clear()
c.post(f"/api/servers/{s1}/worlds"); js = wait(c)
check(js[0]["status"] == "done", f"world backup job done {js[0]['log'][-2:]}")
check(RCON_LOG[:2] == ["save-off", "save-all flush"] and "save-on" in RCON_LOG, f"rcon save-off/on ({RCON_LOG})")
bk = c.get(f"/api/servers/{s1}/worlds").get_json()["backups"]
check(len(bk) == 1 and bk[0]["name"].endswith(".zip"), f"world backup listed {bk}")
r = c.get(f"/api/servers/{s1}/worlds/{bk[0]['name']}")
z = zipfile.ZipFile(io.BytesIO(r.data)); check("world/region/r.0.0.mca" in z.namelist(), f"world zip contains region files {z.namelist()[:4]}")
r.close()
c.patch(f"/api/servers/{s1}", json={"world_keep": 1}); time.sleep(1.1)
c.post(f"/api/servers/{s1}/worlds"); wait(c)
check(len(c.get(f"/api/servers/{s1}/worlds").get_json()["backups"]) == 1, "old world backups pruned")

# 起動・停止(コマンド)
r = c.patch(f"/api/servers/{s2}", json={"control": "command", "start_cmd": "echo started> started.txt", "stop_cmd": "echo stopped> stopped.txt"})
check(r.status_code == 200, "control commands saved by admin")
c.post(f"/api/servers/{s2}/power", json={"signal": "restart"}); wait(c); time.sleep(2)
check((r2 / "stopped.txt").exists() and (r2 / "started.txt").exists(), "restart ran stop then start commands")
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"})
c.put(f"/api/servers/{s2}/acl", json={"shares": [{"username": "ed", "level": "edit"}]})
e = A.app.test_client(); e.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
e.post("/api/auth/login", json={"username": "ed", "password": "password123"})
r = e.patch(f"/api/servers/{s2}", json={"start_cmd": "rm -rf /"})
check(r.status_code in (403, 404), f"editor cannot set commands ({r.status_code})")

# サーバー本体の更新確認(実際の Paper の API)
info = c.get(f"/api/servers/{s1}/software?refresh=1").get_json()
check(info.get("build") == "100" and (info.get("latest") or {}).get("build") and info.get("update") is True, f"paper build update {info}")
check(info.get("newer_mc"), f"newer MC suggested ({info.get('newer_mc')})")

for t, l, exp in (("1.20 以降", "1.21", True), ("1.21 以降", "1.20", False), ("1.20.1〜1.20.6", "1.21", False),
                  ("1.20.1, 1.21.4", "1.21", True), ("[1.20.1,1.21)", "1.20", True), ("", "1.20", None)):
    check(A.mc_supports(t, l) is exp, f"mc_supports({t!r}, {l}) == {exp}")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
