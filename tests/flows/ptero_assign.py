"""Pterodactyl のサーバーの割り当て: 管理者が決めたサーバーだけを一覧・連携でき、ほかの人が連携していても操作できる。"""
import os, sys, tempfile
tmp = tempfile.mkdtemp(prefix="cs-passign-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
import ptero  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


# Pterodactyl の代わり: パネルから見えるサーバーは 2 台
ptero.Ptero.servers = lambda self: [{"identifier": i, "name": n, "node": "n1", "uuid": i, "description": ""}
                                    for i, n in (("aaaa1111", "サバイバル"), ("bbbb2222", "ロビー"))]

H = {"X-Requested-With": "mcpl"}
admin = A.app.test_client()
admin.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)
admin.patch("/api/settings", json={"ptero_url": "https://panel.example.test", "ptero_key": "ptlc_test"}, headers=H)
admin.post("/api/users", json={"username": "alice", "password": "password123", "role": "editor"}, headers=H)
admin.post("/api/users", json={"username": "bob", "password": "password123", "role": "editor", "perms": ["users"]}, headers=H)
uid = {u["username"]: u["id"] for u in admin.get("/api/users", headers=H).get_json()["users"]}


def login(name):
    c = A.app.test_client()
    c.post("/api/auth/login", json={"username": name, "password": "password123"}, headers=H)
    return c


alice, bob = login("alice"), login("bob")
idents = lambda c: [s["identifier"] for s in c.get("/api/ptero/servers", headers=H).get_json()["servers"]]  # noqa: E731
mine = lambda c: {s["name"]: s for s in c.get("/api/servers", headers=H).get_json()["servers"]}  # noqa: E731

check(idents(alice) == ["aaaa1111", "bbbb2222"], "決めていなければ、これまでどおりすべてのサーバーが見える")
check(admin.get("/api/users", headers=H).get_json()["users"][1]["ptero_servers"] is None, "ユーザーの一覧: 決めていなければ null")

# 管理者だけが決められる(ユーザー管理の権限をもらった人でも不可)
r = bob.patch(f"/api/users/{uid['alice']}", json={"ptero_servers": ["aaaa1111"]}, headers=H)
check(r.status_code == 403, f"ユーザー管理の権限だけでは割り当てを変えられない ({r.status_code})")
check(admin.patch(f"/api/users/{uid['alice']}", json={"ptero_servers": "aaaa1111"}, headers=H).status_code == 400, "おかしな値は断る")
check(admin.patch(f"/api/users/{uid['alice']}", json={"ptero_servers": ["bbbb2222"]}, headers=H).status_code == 200, "管理者は割り当てを決められる")

j = alice.get("/api/ptero/servers", headers=H).get_json()
check([s["identifier"] for s in j["servers"]] == ["bbbb2222"] and j["assigned"], "割り当てられたサーバーだけが見える")
r = alice.post("/api/servers", json={"identifier": "aaaa1111", "name": "サバイバル"}, headers=H)
check(r.status_code == 403, f"割り当てられていないサーバーは連携できない ({r.status_code})")
check(idents(admin) == ["aaaa1111", "bbbb2222"], "管理者はいつでもすべて見える")

# 管理者が連携したサーバーでも、割り当てられた人は操作できる
admin.post("/api/servers", json={"identifier": "bbbb2222", "name": "ロビー"}, headers=H)
lobby = mine(alice).get("ロビー")
check(lobby is not None and lobby["access"] == "edit", f"割り当てられたサーバーは、ほかの人が連携していても一覧に出て操作できる ({lobby and lobby['access']})")
check(alice.patch(f"/api/servers/{lobby['id']}", json={"name": "ロビー2"}, headers=H).status_code == 200, "設定を変えられる")
check("ロビー2" not in mine(bob), "割り当てられていない人には見えない")

# 割り当てをやめると、連携は管理者のまま・アリスからは見えなくなる
admin.patch(f"/api/users/{uid['alice']}", json={"ptero_servers": None}, headers=H)
check(idents(alice) == ["aaaa1111", "bbbb2222"] and "ロビー2" not in mine(alice), "「すべて」に戻すと一覧は全部、ほかの人のサーバーは見えない")
check(alice.patch(f"/api/servers/{lobby['id']}", json={"name": "x"}, headers=H).status_code in (403, 404), "操作もできなくなる")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
