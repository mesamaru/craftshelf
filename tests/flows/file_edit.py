"""設定ファイルの編集: 一覧・読み書き・場所の不正・書式の確認・同時編集・履歴・権限。"""
import os, sys, tempfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-fe-")
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
base = Path(tempfile.mkdtemp(prefix="cs-fe-srv-"))
root = base / "srv"
(root / "plugins" / "Alpha").mkdir(parents=True)
(root / "server.properties").write_text("motd=Hello\nmax-players=20\n", encoding="utf-8")
(root / "plugins" / "Alpha" / "config.yml").write_text("a:\n  b: 1\n", encoding="utf-8")
(root / "plugins" / "Alpha.jar").write_bytes(b"PK\x03\x04jar")
(root / "big.yml").write_text("x: " + "y" * 600_000, encoding="utf-8")
(root / "bin.json").write_bytes(b"\x00\x01\x02")
(base / "outside.properties").write_text("secret=1\n", encoding="utf-8")
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "name": "FE", "dirs": {"plugin": "plugins"}}, headers=H)
sid = c.get("/api/servers", headers=H).get_json()["servers"][0]["id"]
U = f"/api/servers/{sid}"

# ---- 一覧 ----
d = c.get(f"{U}/files", headers=H).get_json()
names = [e["name"] for e in d["entries"]]
check(names[0] == "plugins" and "server.properties" in names, f"folders first, then files ({names})")
ed = {e["name"]: e["editable"] for e in d["entries"]}
check(ed["server.properties"] and not ed["big.yml"], "big files are not editable")
d = c.get(f"{U}/files?dir=plugins", headers=H).get_json()
check({e["name"]: e["editable"] for e in d["entries"]} == {"Alpha": False, "Alpha.jar": False}, "jar is not editable")
check(c.get(f"{U}/files?dir=../", headers=H).status_code == 400, "listing outside the server folder is refused")
check(c.get(f"{U}/files?dir=nope", headers=H).status_code == 404, "missing folder → 404")

# ---- 読む ----
f = c.get(f"{U}/file?path=server.properties", headers=H).get_json()
check(f["text"].startswith("motd=Hello") and len(f["hash"]) == 64 and f["history"] == 0, "read server.properties")
for bad in ("../outside.properties", "plugins/../../outside.properties", "plugins/Alpha.jar", "big.yml"):
    r = c.get(f"{U}/file?path={bad}", headers=H)
    check(r.status_code == 400, f"refused: {bad} ({r.status_code})")
check(c.get(f"{U}/file?path=/etc/passwd.txt", headers=H).status_code == 404, "absolute path is read inside the server folder only")
check(c.get(f"{U}/file?path=bin.json", headers=H).status_code == 400, "binary content is refused")
check(c.get(f"{U}/file?path=none.yml", headers=H).status_code == 404, "missing file → 404")

# ---- 書く ----
r = c.put(f"{U}/file", json={"path": "server.properties", "text": "motd=Changed\nmax-players=20\n", "hash": f["hash"]}, headers=H).get_json()
check(r["ok"] and r["changed"], "save")
check((root / "server.properties").read_text(encoding="utf-8").startswith("motd=Changed"), "file on disk changed")
check(not any(p.name.endswith(".craftshelf-part") for p in root.iterdir()), "no temporary file left")
r2 = c.put(f"{U}/file", json={"path": "server.properties", "text": "motd=Again\n", "hash": f["hash"]}, headers=H)
check(r2.status_code == 409 and r2.get_json().get("conflict"), "stale hash → 409 conflict (someone else changed it)")
check((root / "server.properties").read_text(encoding="utf-8").startswith("motd=Changed"), "conflict does not overwrite")
r3 = c.put(f"{U}/file", json={"path": "server.properties", "text": "motd=Changed\nmax-players=20\n", "hash": r["hash"]}, headers=H).get_json()
check(r3["changed"] is False, "saving the same content changes nothing")

# ---- 書式 ----
r = c.put(f"{U}/file", json={"path": "plugins/Alpha/config.yml", "text": "a:\n\tb: 2\n"}, headers=H)
check(r.status_code == 422 and "2 行目" in r.get_json()["error"], f"tab indentation in YAML is caught ({r.get_json()})")
r = c.put(f"{U}/file", json={"path": "plugins/Alpha/config.yml", "text": "a:\n\tb: 2\n", "force": True}, headers=H)
check(r.status_code == 200, "force saves anyway")
r = c.put(f"{U}/file", json={"path": "ops.json", "text": "[{\"name\": \"x\",}]"}, headers=H)
check(r.status_code == 422 and "JSON" in r.get_json()["error"], "broken JSON is caught")
check(c.put(f"{U}/file", json={"path": "ops.json", "text": "[]"}, headers=H).status_code == 200 and (root / "ops.json").exists(), "new file can be created")
check(c.put(f"{U}/file", json={"path": "x.yml", "text": "a" * 600_000}, headers=H).status_code == 400, "too big content refused")
check(c.put(f"{U}/file", json={"path": "../outside.properties", "text": "x"}, headers=H).status_code == 400
      and (base / "outside.properties").read_text() == "secret=1\n", "cannot write outside the server folder")
check(c.put(f"{U}/file", json={"path": "server.properties", "text": "x"}).status_code == 403, "save needs the CSRF header")

# ---- 履歴 ----
h = c.get(f"{U}/file/history?path=server.properties", headers=H).get_json()["entries"]
check(len(h) == 1 and h[0]["username"] == "owner", "one history entry for server.properties")
old = c.get(f"{U}/file/history/{h[0]['id']}", headers=H).get_json()
check(old["text"].startswith("motd=Hello"), "history keeps the content before saving")
cur = c.get(f"{U}/file?path=server.properties", headers=H).get_json()
for i in range(25):
    cur = c.put(f"{U}/file", json={"path": "server.properties", "text": f"motd={i}\n", "hash": cur["hash"]}, headers=H).get_json()
h = c.get(f"{U}/file/history?path=server.properties", headers=H).get_json()["entries"]
check(len(h) == A.FILE_HISTORY_KEEP, f"history is limited to {A.FILE_HISTORY_KEEP} ({len(h)})")
with A.app.app_context():
    a = A.db().execute("SELECT target, detail FROM audit WHERE action='設定ファイルを編集' ORDER BY id DESC").fetchone()
check(a and a["detail"] == "server.properties", "edits are written to the audit log")

# ---- 権限 ----
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
e = A.app.test_client(); e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(e.get(f"{U}/file?path=server.properties", headers=H).status_code in (403, 404), "other editor cannot read")
check(e.put(f"{U}/file", json={"path": "server.properties", "text": "hacked"}, headers=H).status_code in (403, 404), "other editor cannot write")
check(e.get(f"{U}/file/history/1", headers=H).status_code in (403, 404), "other editor cannot read history")

# ---- サーバーを外すと履歴も消える ----
c.delete(U, headers=H)
with A.app.app_context():
    n = A.db().execute("SELECT COUNT(*) FROM server_file_history WHERE server_id=?", (sid,)).fetchone()[0]
check(n == 0, "history is removed with the server")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
