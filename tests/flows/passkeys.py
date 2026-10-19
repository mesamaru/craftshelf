"""パスキー: ソフトウェアの認証器で、登録・ログイン・使い回しの防止・別のサイトからの拒否・権限を確かめる。"""
import base64, hashlib, json, os, sys, tempfile
tmp = tempfile.mkdtemp(prefix="cs-pk-")
os.environ.update(DATA_DIR=tmp + "/data", CONFIG_DIR=tmp + "/config", MCPL_NO_SCHEDULER="1", CRAFTSHELF_TELEMETRY_URL="")
sys.path.insert(0, sys.argv[1])
import app as A  # noqa: E402
import cbor2  # noqa: E402
from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

fails = []


def check(c, m):
    print(("  OK  " if c else "  NG  ") + m)
    if not c:
        fails.append(m)


b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
unb64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))  # noqa: E731
ORIGIN, RP = "http://localhost", "localhost"


class Authenticator:
    """ブラウザと認証器の代わり(ES256・アテステーションなし)。"""
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(16)
        self.count = 0

    def create(self, options, origin=ORIGIN, rp=RP):
        nums = self.key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")})
        auth = hashlib.sha256(rp.encode()).digest() + bytes([0x45]) + self.count.to_bytes(4, "big") + bytes(16) \
            + len(self.cred_id).to_bytes(2, "big") + self.cred_id + cose
        cdj = json.dumps({"type": "webauthn.create", "challenge": options["challenge"], "origin": origin, "crossOrigin": False}).encode()
        att = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth})
        return {"id": b64(self.cred_id), "rawId": b64(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64(cdj), "attestationObject": b64(att), "transports": ["internal"]}}

    def get(self, options, origin=ORIGIN, rp=RP, count=None):
        self.count = self.count + 1 if count is None else count
        auth = hashlib.sha256(rp.encode()).digest() + bytes([0x05]) + self.count.to_bytes(4, "big")
        cdj = json.dumps({"type": "webauthn.get", "challenge": options["challenge"], "origin": origin, "crossOrigin": False}).encode()
        sig = self.key.sign(auth + hashlib.sha256(cdj).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64(self.cred_id), "rawId": b64(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64(cdj), "authenticatorData": b64(auth), "signature": b64(sig), "userHandle": None}}


H = {"X-Requested-With": "mcpl", "Origin": ORIGIN}
c = A.app.test_client()
c.post("/api/auth/setup", json={"username": "admin", "password": "password123"}, headers=H)

# ---- 登録 ----
key = Authenticator()
opt = c.post("/api/me/passkeys/options", headers=H).get_json()
check(opt["rp"]["id"] == RP and opt["authenticatorSelection"]["residentKey"] == "required", "registration options (discoverable, rp id)")
r = c.post("/api/me/passkeys", json={"credential": key.create(opt), "name": "テスト端末"}, headers=H)
check(r.status_code == 200, f"passkey registered ({r.get_json()})")
lst = c.get("/api/me/passkeys", headers=H).get_json()["passkeys"]
check(len(lst) == 1 and lst[0]["name"] == "テスト端末" and "public_key" not in lst[0], "listed without secrets")
r = c.post("/api/me/passkeys", json={"credential": key.create(opt)}, headers=H)
check(r.status_code == 400, "the same registration challenge cannot be used twice")
opt2 = c.post("/api/me/passkeys/options", headers=H).get_json()
check([x["id"] for x in opt2.get("excludeCredentials", [])] == [b64(key.cred_id)], "already registered passkeys are excluded")
check(c.post("/api/me/passkeys", json={"credential": key.create(opt2)}, headers=H).status_code == 409, "same passkey twice → 409")
evil = Authenticator()
opt3 = c.post("/api/me/passkeys/options", headers=H).get_json()
check(c.post("/api/me/passkeys", json={"credential": evil.create(opt3, origin="https://evil.example")}, headers=H).status_code == 400,
      "registration made for another origin is refused")

# ---- ログイン ----
anon = A.app.test_client()
check(anon.get("/api/library", headers=H).status_code == 401, "not logged in yet")
o = anon.post("/api/auth/passkey/options", headers=H).get_json()
check(o["rpId"] == RP and not o.get("allowCredentials"), "login options (no username needed)")
r = anon.post("/api/auth/passkey", json={"credential": key.get(o)}, headers=H)
check(r.status_code == 200 and r.get_json()["user"]["username"] == "admin", f"login with passkey ({r.get_json()})")
check(anon.get("/api/library", headers=H).status_code == 200, "logged in after passkey")
check(anon.post("/api/auth/passkey", json={"credential": key.get(o)}, headers=H).status_code == 401, "login challenge cannot be reused")
b = A.app.test_client()
o = b.post("/api/auth/passkey/options", headers=H).get_json()
check(b.post("/api/auth/passkey", json={"credential": key.get(o, count=1)}, headers=H).status_code == 401, "replayed (old) sign counter is refused")
o = b.post("/api/auth/passkey/options", headers=H).get_json()
check(b.post("/api/auth/passkey", json={"credential": key.get(o, origin="https://evil.example")}, headers=H).status_code == 401, "assertion for another origin is refused")
o = b.post("/api/auth/passkey/options", headers=H).get_json()
check(b.post("/api/auth/passkey", json={"credential": evil.get(o)}, headers=H).status_code == 401, "unknown passkey is refused")
o = b.post("/api/auth/passkey/options", headers=H).get_json()
forged = key.get(o); forged["response"]["signature"] = b64(b"\x30\x06\x02\x01\x01\x02\x01\x01")
check(b.post("/api/auth/passkey", json={"credential": forged}, headers=H).status_code == 401, "bad signature is refused")

# ---- 接続の確認 ----
check(A.app.test_client().post("/api/auth/passkey/options", headers={**H, "Origin": "https://other.example"}).status_code == 400, "Origin must match the host")
ip = A.app.test_client()
check(ip.post("/api/auth/passkey/options", headers={**H, "Origin": "http://127.0.0.1"}, base_url="http://127.0.0.1").status_code == 400, "IP address is refused")
check(A.app.test_client().post("/api/auth/passkey/options", headers={"Origin": ORIGIN}).status_code == 403, "CSRF header required")

# ---- 名前・削除・ユーザーの削除・ID の使い回し ----
pid = lst[0]["id"]
check(c.patch(f"/api/me/passkeys/{pid}", json={"name": "iPhone"}, headers=H).status_code == 200, "rename")
c.post("/api/users", json={"username": "ed", "password": "password123", "role": "editor"}, headers=H)
e = A.app.test_client(); e.post("/api/auth/login", json={"username": "ed", "password": "password123"}, headers=H)
check(e.delete(f"/api/me/passkeys/{pid}", headers=H).status_code == 404, "cannot delete another user's passkey")
ek = Authenticator()
o = e.post("/api/me/passkeys/options", headers=H).get_json()
e.post("/api/me/passkeys", json={"credential": ek.create(o)}, headers=H)
with A.app.app_context():
    ed_id = A.db().execute("SELECT id FROM users WHERE username='ed'").fetchone()[0]
    A.db().execute("UPDATE users SET created_at='2000-01-01T00:00:00Z' WHERE id=?", (ed_id,)); A.db().commit()  # 古い版で消して作り直した、のと同じ状態
x = A.app.test_client()
o = x.post("/api/auth/passkey/options", headers=H).get_json()
check(x.post("/api/auth/passkey", json={"credential": ek.get(o)}, headers=H).status_code == 401, "passkey of a re-created user (same id) is refused")
c.delete(f"/api/users/{ed_id}", headers=H)
with A.app.app_context():
    n = A.db().execute("SELECT COUNT(*) FROM passkeys WHERE user_id=?", (ed_id,)).fetchone()[0]
check(n == 0, "passkeys are removed with the user")
check(c.delete(f"/api/me/passkeys/{pid}", headers=H).status_code == 200 and not c.get("/api/me/passkeys", headers=H).get_json()["passkeys"], "delete")
tok = c.post("/api/me/tokens", json={"name": "t", "role": "viewer"}, headers=H).get_json()
t = A.app.test_client()
check(t.get("/api/me/passkeys", headers={"Authorization": f"Bearer {tok['token']}"}).status_code == 403, "API tokens cannot manage passkeys")

print("FAILS:", len(fails))
sys.exit(1 if fails else 0)
