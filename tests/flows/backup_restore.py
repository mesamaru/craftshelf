"""パネルのバックアップから戻す: 保存先から・zip を送って・中身の確認・権限・次の起動での入れ替え。"""
import io, os, sqlite3, sys, tempfile, time, zipfile
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-bkr-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
import selfupdate  # noqa: E402
from craftshelf import core  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


RESTARTS = []
selfupdate.restart = lambda: RESTARTS.append(1)
selfupdate.FROZEN = False
H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "admin", "password": "password123"}, headers=H)
c.post("/api/users", json={"username": "keeper", "password": "password123", "role": "editor"}, headers=H)
c.patch("/api/settings", json={"backup_target_id": 1, "cf_api_key": "test-key-for-backup"}, headers=H)


def wait_jobs():
    for _ in range(400):
        js = c.get("/api/jobs", headers=H).get_json()["jobs"]
        if js and all(j["status"] not in ("running", "queued") for j in js):
            return js
        time.sleep(0.05)
    return js


c.post("/api/backup/run", headers=H)
js = wait_jobs()
check(js[0]["status"] == "done", f"backup job done ({js[0]['status']})")
files = c.get("/api/backup/list", headers=H).get_json()["files"]
check(len(files) == 1, f"one backup listed ({files})")

# バックアップのあとに変える(戻すと消えるはず)
c.post("/api/users", json={"username": "later", "password": "password123", "role": "viewer"}, headers=H)
c.post("/api/sets", json={"name": "after-backup"}, headers=H)

# ---- 権限 ----
c.post("/api/users", json={"username": "st", "password": "password123", "role": "editor"}, headers=H)
with A.app.app_context():
    A.db().execute("UPDATE users SET perms='[\"storage\"]' WHERE username='st'"); A.db().commit()
st = A.app.test_client(); st.post("/api/auth/login", json={"username": "st", "password": "password123"}, headers=H)
check(st.get("/api/backup/list", headers=H).status_code == 200, "storage permission can list backups")
check(st.post(f"/api/backup/restore/{files[0]}", headers=H).status_code == 403, "storage permission alone cannot restore (admin only)")
check(st.post("/api/backup/restore-upload", data={"file": (io.BytesIO(b"x"), "a.zip")}, headers=H).status_code == 403, "upload restore is admin only")
check(c.post(f"/api/backup/restore/{files[0]}").status_code == 403, "restore needs the CSRF header")
check(c.post("/api/backup/restore/..%2Findex.db", headers=H).status_code == 404, "bad backup name → 404")

# ---- 送られた zip の確認 ----
def up(data, name="b.zip"):
    return c.post("/api/backup/restore-upload", data={"file": (io.BytesIO(data), name)}, headers=H)


def zbytes(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


check(up(b"not a zip").status_code == 400, "non-zip refused")
check(up(zbytes({"README.txt": "x"})).status_code == 400, "zip without index.db refused")
check(up(zbytes({"index.db": b"garbage" * 100})).status_code == 400, "broken index.db refused")
newer = Path(tmp) / "newer.db"
with sqlite3.connect(newer) as n:
    n.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)"); n.execute("INSERT INTO users VALUES (1)")
    n.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)"); n.execute("INSERT INTO settings VALUES ('data_format', '99')")
r = up(zbytes({"index.db": newer.read_bytes()}))
check(r.status_code == 400 and "99" in r.get_json()["error"], f"backup from a newer data format refused ({r.get_json()})")
check(not core.RESTORE_MARK.exists() and not RESTARTS, "refused uploads change nothing")
check(not any(d.name.endswith("-backup") for d in core.SNAPSHOT_DIR.glob("*")) if core.SNAPSHOT_DIR.exists() else True,
      "refused uploads leave no staged folder")

# ---- 保存先のバックアップから戻す ----
(core.CONFIG_DIR / "backgrounds").mkdir(exist_ok=True)
(core.CONFIG_DIR / "backgrounds" / "now.png").write_bytes(b"now")
r = c.post(f"/api/backup/restore/{files[0]}", headers=H).get_json()
check(r.get("ok") and r.get("restart") and RESTARTS == [1], f"restore staged and restart requested ({r})")
mark = core.RESTORE_MARK.read_text(encoding="utf-8").strip()
check(mark.endswith("-backup") and (core.SNAPSHOT_DIR / mark / "index.db").is_file(), f"staged into the snapshot folder ({mark})")
snaps = c.get("/api/system/snapshots", headers=H).get_json()
check(snaps["pending"] == mark and any(s["name"] == mark and "バックアップから" in s["reason"] for s in snaps["snapshots"]),
      "staged backup shows in the update snapshots list")

# 次の起動で入れ替わる
key_before = core.SECRET_KEY_PATH.read_bytes()
check((core.SNAPSHOT_DIR / mark / "secret.key").read_bytes() == key_before, "backup carries the secret key")
core.SECRET_KEY_PATH.write_bytes(b"changed-key")
core._restore_pending_snapshot()
with sqlite3.connect(core.DB_PATH) as d:
    users = {r[0] for r in d.execute("SELECT username FROM users")}
    sets = {r[0] for r in d.execute("SELECT name FROM sets")}
check({"admin", "keeper"} <= users and "later" not in users and "st" not in users, f"users are back to the backup ({sorted(users)})")
check("after-backup" not in sets, "data added after the backup is gone")
check(core.SECRET_KEY_PATH.read_bytes() == key_before, "secret key restored (same key as when backed up)")
check(not core.RESTORE_MARK.exists(), "restore mark removed")
keep = sorted(core.SNAPSHOT_DIR.glob("before-restore-*"))
check(keep and (keep[-1] / "index.db").is_file() and (keep[-1] / "secret.key").read_bytes() == b"changed-key",
      "the data before restoring is kept (database and key)")
check((core.CONFIG_DIR / "backgrounds" / "now.png").is_file(), "backgrounds stay when the backup has none")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
