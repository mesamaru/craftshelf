"""橋渡し(01.24): 受け取り先・データの保存方法・アップデートの前の状態のテスト。"""
import os, sqlite3, sys, tempfile
tmp = tempfile.mkdtemp(); os.environ["DATA_DIR"] = tmp; os.environ["MCPL_NO_SCHEDULER"] = "1"; os.environ["CRAFTSHELF_TELEMETRY_URL"] = ""
sys.path.insert(0, sys.argv[1]); import app as A, selfupdate as S
fails = []
def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c: fails.append(m)

check(S.parse_data_format("write=1\nread=2\n") == (1, 2), "parse write/read")
check(S.parse_data_format("# comment\nwrite=2") == (2, 2), "read defaults to write")
check(S.parse_data_format("") == (1, 1), "missing file = (1,1)")
check(S.local_data_format() in ((1, 2), (2, 2)), f"this build reads format 2 ({S.local_data_format()})")
W = S.local_data_format()[0]
check(S.DATA_IN_USE == W and (A.CONFIG_DIR / "data-format").read_text().strip() == str(W), f"data format recorded as {W}")

c = A.app.test_client(); c.environ_base["HTTP_X_REQUESTED_WITH"] = "mcpl"
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"})
check(c.patch("/api/settings", json={"update_channel": "preview"}).status_code == 200 and S.CHANNEL == "preview" and S.branch() == "next", "preview channel → branch next")
check((A.CONFIG_DIR / "update-channel").read_text().strip() == "preview", "channel file for Docker")
c.patch("/api/settings", json={"update_channel": "bogus"}); check(S.CHANNEL == "stable", "unknown channel falls back to stable")

# 取得先の版と保存方法(GitHub の代わり)
files = {}
S._github_file = lambda path, ref=None: files[path] if path in files else (_ for _ in ()).throw(S.UpdateError("404"))
files.update({"VERSION": "02.00.00\n", "CHANGELOG.md": "", "DATA_FORMAT": "write=2\nread=2\n"})
_cv0 = S.current_version; S.current_version = lambda: "01.24.00"
S.set_channel("preview"); d = S.check(force=True)
S.current_version = _cv0
check(d["update_available"] and d["major_up"] and not d.get("blocked"), f"1 → 2 allowed ({d.get('blocked')})")
S.DATA_IN_USE = 2  # v2 で使ったあと
_cv = S.current_version; S.current_version = lambda: "02.00.00"
files.update({"VERSION": "01.15.01\n", "DATA_FORMAT": None}); del files["DATA_FORMAT"]
S.set_channel("stable"); d = S.check(force=True)
check(d["downgrade"] and d["major_down"] and d.get("blocked"), "going back to an old v1 that can't read format 2 is blocked")
files.update({"VERSION": "01.24.00\n", "DATA_FORMAT": "write=1\nread=2\n"})
S.set_channel("dev"); d = S.check(force=True)
check(d["downgrade"] and not d.get("blocked"), "going back to the bridge v1dev is allowed")
S.current_version = _cv
r = c.post("/api/system/update")
check(r.status_code in (200, 409), "apply endpoint reachable")
S.DATA_IN_USE = 1

# 保存方法が新しすぎるデータ
with A.app.app_context():
    conn = A.db(); conn.execute("UPDATE settings SET value='3' WHERE key='data_format'"); conn.commit()
    A._note_data_format(conn); conn.commit()
import craftshelf.core as CORE
check(CORE.DATA_TOO_NEW and S.DATA_IN_USE == 3, "data made by a newer format is flagged")
with A.app.app_context():
    conn = A.db(); conn.execute("UPDATE settings SET value='1' WHERE key='data_format'"); conn.commit()
    CORE.DATA_TOO_NEW = False; A._note_data_format(conn); conn.commit()

# アップデートの前の状態 → 戻す
with A.app.app_context():
    name = A.snapshot_data("テスト")
check((A.SNAPSHOT_DIR / name / "index.db").is_file() and (A.SNAPSHOT_DIR / name / "meta.json").is_file(), "snapshot created")
c.post("/api/users", json={"username": "after", "password": "password123", "role": "viewer"})  # 退避のあとに足したもの
snaps = c.get("/api/system/snapshots").get_json()["snapshots"]
check(snaps and snaps[0]["name"] == name and snaps[0]["can_restore"], "snapshot listed")
A.selfupdate.restart = lambda *a, **k: None
check(c.post(f"/api/system/snapshots/{name}/restore").get_json()["ok"], "restore scheduled")
check(c.post("/api/system/snapshots/..%5Cx/restore").status_code in (404, 400), "bad snapshot name rejected")
A._restore_pending_snapshot()  # 次の起動のかわり
users = [r[0] for r in sqlite3.connect(A.DB_PATH).execute("SELECT username FROM users")]
check("after" not in users and "owner" in users, f"database restored to the snapshot ({users})")
check(any(x.name.startswith("before-restore-") for x in A.SNAPSHOT_DIR.iterdir()), "data before restore kept")
check(not A.RESTORE_MARK.exists(), "restore mark cleared")
with A.app.app_context():
    for i in range(7): A.snapshot_data("x")
check(len([x for x in A.SNAPSHOT_DIR.iterdir() if not x.name.startswith("before-restore-")]) == 5, "only 5 snapshots kept")
print("FAILS:", len(fails))

sys.exit(1 if fails else 0)
