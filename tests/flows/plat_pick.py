"""サーバーのソフトに合わせたバージョン選び: Paper のサーバーには Paper 版・いまと同じ作りを優先・動かないもの(Mod など)は送らない。"""
import io, os, sys, tempfile, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-plat-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


def jar(meta_file, name, ver, extra=""):
    b = io.BytesIO()
    at = lambda n: zipfile.ZipInfo(n, (2024, 1, 1, 0, 0, 0))  # noqa: E731  時刻を固定して、同じ中身なら同じハッシュにする
    with zipfile.ZipFile(b, "w") as z:
        if meta_file == "fabric.mod.json":
            z.writestr(at(meta_file), f'{{"schemaVersion":1,"id":"{name.lower()}","name":"{name}","version":"{ver}"}}')
        else:
            z.writestr(at(meta_file), f"name: {name}\nversion: {ver}\nmain: x.Y\napi-version: 1.20\n{extra}")
        z.writestr(at("x/a"), f"{meta_file}{ver}")  # 版ごとに中身を変えて、ハッシュが違うようにする
    return b.getvalue()


PAPER = lambda v: jar("paper-plugin.yml", "Multi", v)  # noqa: E731  Paper 専用の作り
BUKKIT = lambda v: jar("plugin.yml", "Multi", v)  # noqa: E731  Bukkit / Spigot / Paper で動く作り

H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)
up = lambda fn, data: c.put(f"/api/upload?filename={fn}", data=data, headers=H).get_json()  # noqa: E731
up("Multi-1.0-paper.jar", PAPER("1.0"))
up("Multi-1.0.5-bukkit.jar", BUKKIT("1.0.5"))
up("Multi-1.1-bukkit.jar", BUKKIT("1.1"))
up("ModX-2.0.jar", jar("fabric.mod.json", "ModX", "2.0"))
lib = {(i["name"], i["category"]): i for i in c.get("/api/library", headers=H).get_json()["items"]}
multi, modx = lib[("Multi", "plugin")], lib[("ModX", "mod")]
check(len(multi["versions"]) == 3, "Paper 版と Bukkit 版は同じアイテム(Multi)の版になる")

root = Path(tempfile.mkdtemp(prefix="cs-plat-srv-"))


def server(name, soft, dirs, files=()):
    d = root / name
    for sub in dirs.values():
        (d / sub).mkdir(parents=True, exist_ok=True)
    (d / "server.properties").write_text("motd=x\n")
    for rel, data in files:
        (d / rel).write_bytes(data)
    c.post("/api/servers", json={"kind": "local", "root_dir": str(d), "software": soft, "name": name, "dirs": dirs}, headers=H)
    return next(s["id"] for s in c.get("/api/servers", headers=H).get_json()["servers"] if s["name"] == name), d


def run(url, body):
    j = c.post(url, json=body, headers=H).get_json()
    for _ in range(600):
        st = c.get(f"/api/jobs/{j['id']}", headers=H).get_json()
        if st["status"] not in ("running", "queued"):
            return st
        time.sleep(0.05)
    return st


jars = lambda d, sub: sorted(p.name for p in (d / sub).glob("*.jar")) if (d / sub).exists() else []  # noqa: E731
inv = lambda sid: {f["item_name"]: f for f in c.get(f"/api/servers/{sid}/inventory", headers=H).get_json()["files"] if f["item_name"]}  # noqa: E731

# Paper のサーバー(ライブラリに無い古い Paper 版が入っている): いちばん新しい 1.1(Bukkit 版)ではなく Paper 版の 1.0
p_id, p_dir = server("paper", "paper", {"plugin": "plugins"}, [("plugins/Multi-0.9.jar", PAPER("0.9"))])
e = inv(p_id)["Multi"]
check(e["latest_version"] == "1.0" and e["status"] == "outdated", f"Paper のサーバーにとっての最新は Paper 版の 1.0 ({e['latest_version']}, {e['status']})")
run(f"/api/servers/{p_id}/sync", {})
check(jars(p_dir, "plugins") == ["Multi-1.0-paper.jar"], f"更新で Paper 版が入る(Bukkit 版にならない) ({jars(p_dir, 'plugins')})")

# Paper のサーバーに Bukkit 版が入っている: 同じ作り(Bukkit 版)の新しいもの
b_id, b_dir = server("paper-bukkit", "paper", {"plugin": "plugins"}, [("plugins/Multi-1.0.5-bukkit.jar", BUKKIT("1.0.5"))])
e = inv(b_id)["Multi"]
check(e["latest_version"] == "1.1", f"いま Bukkit 版が入っていれば、Bukkit 版の新しいもの ({e['latest_version']}, {e['status']}, {e.get('version')})")

# Spigot のサーバー: Paper 専用の版は動かないので Bukkit 版
s_id, s_dir = server("spigot", "spigot", {"plugin": "plugins"})
run(f"/api/servers/{s_id}/push", {"item_ids": [multi["id"]]})
check(jars(s_dir, "plugins") == ["Multi-1.1-bukkit.jar"], f"Spigot のサーバーには Bukkit 版 ({jars(s_dir, 'plugins')})")

# Mod は Paper のサーバーには送らない(mods フォルダも作らない)。Fabric のサーバーには送る
j = run(f"/api/servers/{p_id}/push", {"item_ids": [modx["id"]]})
check(not (p_dir / "mods").exists() and any("動かないため" in x for x in j["log"]), f"Paper のサーバーに Mod は送らない ({j['log'][-2:]})")
f_id, f_dir = server("fabric", "fabric", {"mod": "mods"})
run(f"/api/servers/{f_id}/push", {"item_ids": [modx["id"]]})
check(jars(f_dir, "mods") == ["ModX-2.0.jar"], f"Fabric のサーバーには Mod を送る ({jars(f_dir, 'mods')})")
check(c.post(f"/api/servers/{f_id}/push", json={"item_ids": [multi["id"]]}, headers=H).status_code == 200, "送る操作そのものは受け付ける")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
