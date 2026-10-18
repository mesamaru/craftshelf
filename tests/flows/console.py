"""サーバーのコンソール: 最近のログ(末尾・色の印を消す)と、RCON でのコマンド・権限・記録。"""
import os, socket, struct, sys, tempfile, threading
from pathlib import Path
tmp = tempfile.mkdtemp(prefix="cs-con-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


def recv_exact(c, n):
    buf = b""
    while len(buf) < n:
        part = c.recv(n - len(buf))
        if not part:
            raise ConnectionError
        buf += part
    return buf


GOT = []


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
                    GOT.append(body)
                    reply = "§6There are §c2§6 of a max of 20 players online: Alex, Steve" if body == "list" else f"ran {body}"
                    out = struct.pack("<ii", rid, 0) + reply.encode() + b"\x00\x00"
                c.sendall(struct.pack("<i", len(out)) + out)
        except Exception:  # noqa: BLE001
            pass
        finally:
            c.close()

    def run():
        while True:
            c, _ = srv.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
    threading.Thread(target=run, daemon=True).start()
    return srv.getsockname()[1]


RCON = rcon_server("secret")
H = {"X-Requested-With": "mcpl"}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "owner", "password": "password123"}, headers=H)

root = Path(tempfile.mkdtemp(prefix="cs-con-srv-")) / "srv"
(root / "plugins").mkdir(parents=True); (root / "logs").mkdir()
(root / "server.properties").write_text("server-port=25565\n")
c.post("/api/servers", json={"kind": "local", "root_dir": str(root), "software": "paper", "name": "Con", "dirs": {"plugin": "plugins"}}, headers=H)
sid = c.get("/api/servers", headers=H).get_json()["servers"][0]["id"]

# ---- ログ ----
d = c.get(f"/api/servers/{sid}/logs", headers=H).get_json()
check(d["found"] is False and d["lines"] == [], "missing latest.log → found=false")
(root / "logs" / "latest.log").write_text("", encoding="utf-8")
d = c.get(f"/api/servers/{sid}/logs", headers=H).get_json()
check(d["found"] and d["lines"] == [], "empty latest.log → found, no lines")
lines = [f"[12:00:{i % 60:02d}] [Server thread/INFO]: line {i}" for i in range(3000)]
(root / "logs" / "latest.log").write_text("\x1b[0;32m" + "\r\n".join(lines) + "\x1b[m\r\n", encoding="utf-8")
d = c.get(f"/api/servers/{sid}/logs?lines=50", headers=H).get_json()
check(len(d["lines"]) == 50 and d["lines"][-1].endswith("line 2999"), f"last 50 lines ({d['lines'][-1] if d['lines'] else None})")
check(not any("\x1b" in l or "\r" in l for l in d["lines"]), "ANSI colour codes and CR are removed")
big = "x" * 300_000
(root / "logs" / "latest.log").write_text(big + "\nfirst full line\nsecond\n", encoding="utf-8")
d = c.get(f"/api/servers/{sid}/logs", headers=H).get_json()
check(d["lines"] == ["first full line", "second"], f"partial first line is dropped for big files ({d['lines'][:2]})")
check(c.get(f"/api/servers/{sid}/logs?lines=abc", headers=H).status_code == 400, "bad lines value → 400")

# ---- コマンド ----
r = c.post(f"/api/servers/{sid}/console", json={"command": "list"}, headers=H)
check(r.status_code == 400 and "RCON" in r.get_json()["error"], "no RCON configured → helpful error")
c.patch(f"/api/servers/{sid}", json={"address": "127.0.0.1:25565", "rcon_port": RCON, "rcon_password": "secret"}, headers=H)
r = c.post(f"/api/servers/{sid}/console", json={"command": "/list"}, headers=H).get_json()
check(r.get("via") == "rcon" and r["output"] == "There are 2 of a max of 20 players online: Alex, Steve", f"rcon output without § codes ({r})")
check(GOT[-1] == "list", "leading slash is removed")
check(c.post(f"/api/servers/{sid}/console", json={"command": "say a\nop bob"}, headers=H).status_code == 400, "multi-line command refused")
check(c.post(f"/api/servers/{sid}/console", json={"command": "  "}, headers=H).status_code == 400, "empty command refused")
check(c.post(f"/api/servers/{sid}/console", json={"command": "list"}).status_code == 403, "console needs the CSRF header")
with A.app.app_context():
    a = A.db().execute("SELECT detail FROM audit WHERE action='コンソールでコマンドを実行' ORDER BY id DESC").fetchone()
check(a and a[0] == "list", "command is written to the audit log")

# ---- 権限 ----
c.post("/api/users", json={"username": "vw", "password": "password123", "role": "viewer"}, headers=H)
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
v, e = A.app.test_client(), A.app.test_client()
v.post("/api/auth/login", json={"username": "vw", "password": "password123"}, headers=H)
e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(v.post(f"/api/servers/{sid}/console", json={"command": "list"}, headers=H).status_code in (403, 404), "viewer cannot send commands")
check(v.get(f"/api/servers/{sid}/logs", headers=H).status_code in (403, 404), "viewer cannot read logs")
n = len(GOT)
check(e.post(f"/api/servers/{sid}/console", json={"command": "op ed"}, headers=H).status_code in (403, 404) and len(GOT) == n,
      "editor without access to this server cannot send commands")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
