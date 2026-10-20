"""設定を比べる: サーバーごとの設定ファイルの一覧・同じ/差分あり/一部のサーバーだけ・権限・保存。"""
import os, sys, tempfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-cc-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)
base = Path(tempfile.mkdtemp(prefix="cs-cc-srv-"))
for name, props, extra in (("a", "max-players=50\n", True), ("b", "max-players=100\n", False)):
    r = base / name
    (r / "plugins" / "Ess").mkdir(parents=True)
    (r / "server.properties").write_bytes(props.encode())
    (r / "plugins" / "Ess" / "config.yml").write_text("x: 1\n")
    (r / "plugins" / "Ess.jar").write_bytes(b"PK")
    (r / "logs").mkdir(); (r / "logs" / "latest.log").write_text("log")
    if extra:
        (r / "bukkit.yml").write_bytes(b"a: 1\n")
    c.post("/api/servers", json={"kind": "local", "root_dir": str(r), "software": "paper", "name": name.upper(), "dirs": {"plugin": "plugins"}}, headers=H)
sv = {s["name"]: s["id"] for s in c.get("/api/servers", headers=H).get_json()["servers"]}

d = c.get(f"/api/servers/configs?ids={sv['A']},{sv['B']}", headers=H).get_json()
st = {f["path"]: f["status"] for f in d["files"]}
check(st.get("server.properties") == "diff", f"server.properties differs ({st})")
check(st.get("plugins/Ess/config.yml") == "same", "plugin config is the same")
check(st.get("bukkit.yml") == "partial" and next(f for f in d["files"] if f["path"] == "bukkit.yml")["on"] == [sv["A"]], "file only on one server")
check(next(f for f in d["files"] if f["path"] == "bukkit.yml")["differ"] is False and next(f for f in d["files"] if f["path"] == "server.properties")["differ"] is True, "differ flag among servers that have the file")
check(next(f for f in d["files"] if f["path"] == "server.properties").get("changes") == 1, "number of differing places")
check("plugins/Ess.jar" not in st and "logs/latest.log" not in st, "jars and logs are not listed")
check([s["name"] for s in d["servers"]] == ["A", "B"] and all(s["count"] >= 2 for s in d["servers"]), "servers returned in order with counts")
check(c.get(f"/api/servers/configs?ids={sv['A']}", headers=H).status_code == 400, "one server is not enough")
check(c.get("/api/servers/configs?ids=x,y", headers=H).status_code == 400, "bad ids → 400")

# 片方を書き換えると同じになる
f = c.get(f"/api/servers/{sv['B']}/file?path=server.properties", headers=H).get_json()
c.put(f"/api/servers/{sv['B']}/file", json={"path": "server.properties", "text": "max-players=50\n", "hash": f["hash"]}, headers=H)
d = c.get(f"/api/servers/configs?ids={sv['A']},{sv['B']}", headers=H).get_json()
check({f["path"]: f["status"] for f in d["files"]}["server.properties"] == "same", "after saving, the file is the same")
# 片方にだけあるファイルを作る(比べる画面の「基準からコピーして作る」)
c.put(f"/api/servers/{sv['B']}/file", json={"path": "bukkit.yml", "text": "a: 1\n", "hash": ""}, headers=H)
d = c.get(f"/api/servers/configs?ids={sv['A']},{sv['B']}", headers=H).get_json()
check({f["path"]: f["status"] for f in d["files"]}["bukkit.yml"] == "same", "missing file can be created from the base")

c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
e = A.app.test_client(); e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(e.get(f"/api/servers/configs?ids={sv['A']},{sv['B']}", headers=H).status_code in (403, 404), "other editor cannot compare")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
