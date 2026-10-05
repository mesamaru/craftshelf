"""Minecraft サーバーとのやり取り(状態の問い合わせ・RCON・Docker の操作・サーバー本体の更新確認)。

どれも外部のライブラリを使わず、標準ライブラリと requests だけで動く。
"""
import http.client
import json
import os
import re
import socket
import struct
import time

import requests

TIMEOUT = 5
UA = "CraftShelf (+https://github.com/mesamaru/craftshelf)"


class NetError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


# --------------------------------------------------------------------------
# アドレス
# --------------------------------------------------------------------------
def parse_address(addr, default_port=25565):
    """"example.com" / "example.com:25566" / "[::1]:25565" → (host, port)。"""
    addr = str(addr or "").strip()
    if not addr:
        raise NetError("サーバーのアドレスが設定されていません")
    m = re.fullmatch(r"\[([^\]]+)\](?::(\d+))?", addr)
    if m:
        return m.group(1), int(m.group(2) or default_port)
    if addr.count(":") == 1:
        host, port = addr.split(":")
        if not port.isdigit():
            raise NetError("ポート番号が正しくありません")
        return host, int(port)
    return addr, default_port


# --------------------------------------------------------------------------
# Server List Ping(サーバー一覧に出る情報: 人数・バージョン・MOTD)
# --------------------------------------------------------------------------
def _varint(n):
    out = b""
    n &= 0xFFFFFFFF
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def _read_varint(sock):
    n = shift = 0
    for _ in range(5):
        b = sock.recv(1)
        if not b:
            raise NetError("サーバーからの応答が途中で切れました")
        n |= (b[0] & 0x7F) << shift
        if not b[0] & 0x80:
            return n
        shift += 7
    raise NetError("サーバーからの応答が正しくありません")


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise NetError("サーバーからの応答が途中で切れました")
        buf += chunk
    return buf


def _motd_text(desc):
    if isinstance(desc, str):
        return re.sub(r"§.", "", desc)
    if isinstance(desc, dict):
        return _motd_text(desc.get("text", "")) + "".join(_motd_text(x) for x in desc.get("extra") or [])
    if isinstance(desc, list):
        return "".join(_motd_text(x) for x in desc)
    return ""


def ping(host, port=25565, timeout=TIMEOUT):
    """Java 版の Server List Ping。オンラインなら人数やバージョンを返す。"""
    t0 = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.settimeout(timeout)
            hb = host.encode("utf-8")
            hs = b"\x00" + _varint(767) + _varint(len(hb)) + hb + struct.pack(">H", port) + _varint(1)
            s.sendall(_varint(len(hs)) + hs + _varint(1) + b"\x00")
            _read_varint(s)  # 全体の長さ
            if _read_varint(s) != 0:
                raise NetError("サーバーからの応答が正しくありません")
            data = _recv_exact(s, _read_varint(s))
            latency = int((time.monotonic() - t0) * 1000)
    except (OSError, socket.timeout) as e:
        raise NetError(f"つながりません({host}:{port})") from e
    try:
        st = json.loads(data.decode("utf-8", "replace"))
    except ValueError as e:
        raise NetError("サーバーからの応答が正しくありません") from e
    players = st.get("players") or {}
    ver = st.get("version") or {}
    return {
        "online": True, "latency": latency,
        "players": int(players.get("online") or 0), "max": int(players.get("max") or 0),
        "sample": [p.get("name") for p in (players.get("sample") or []) if isinstance(p, dict) and p.get("name")][:12],
        "version": str(ver.get("name") or "")[:80], "protocol": ver.get("protocol"),
        "motd": _motd_text(st.get("description"))[:200].strip(),
    }


def mc_from_version_name(name):
    """"Paper 1.21.4" / "Velocity 3.3.0-SNAPSHOT, 1.7.2-1.21.4" などから MC のバージョンを取り出す。"""
    vs = re.findall(r"(?<![\d.])(1\.\d{1,2}(?:\.\d{1,2})?|2\d\.\d{1,2}(?:\.\d{1,2})?)(?![\d.])", str(name or ""))
    return vs[-1] if vs else ""


# --------------------------------------------------------------------------
# RCON(コマンドを送る。保存・停止・プレイヤー一覧など)
# --------------------------------------------------------------------------
class Rcon:
    def __init__(self, host, port, password, timeout=TIMEOUT):
        self.host, self.port, self.password, self.timeout = host, int(port), password, timeout
        self.sock = None

    def __enter__(self):
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
            self.sock.settimeout(self.timeout)
        except OSError as e:
            raise NetError(f"RCON につながりません({self.host}:{self.port})") from e
        if self._send(3, self.password)[0] == -1:
            self.sock.close()
            raise NetError("RCON のパスワードが違います")
        return self

    def __exit__(self, *exc):
        if self.sock:
            self.sock.close()

    def _send(self, kind, body):
        payload = struct.pack("<ii", 7, kind) + body.encode("utf-8") + b"\x00\x00"
        try:
            self.sock.sendall(struct.pack("<i", len(payload)) + payload)
            size = struct.unpack("<i", _recv_exact(self.sock, 4))[0]
            data = _recv_exact(self.sock, size)
        except (OSError, socket.timeout) as e:
            raise NetError("RCON の応答がありません") from e
        rid, _typ = struct.unpack("<ii", data[:8])
        return rid, data[8:-2].decode("utf-8", "replace")

    def command(self, cmd):
        return re.sub(r"§.", "", self._send(2, cmd)[1])


# --------------------------------------------------------------------------
# Docker(コンテナの起動・停止。/var/run/docker.sock をマウントしたときだけ)
# --------------------------------------------------------------------------
DOCKER_SOCK = os.environ.get("CRAFTSHELF_DOCKER_SOCK", "/var/run/docker.sock")


class _UnixConn(http.client.HTTPConnection):
    def __init__(self, path, timeout=60):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        if not hasattr(socket, "AF_UNIX"):
            raise NetError("この環境では Docker を操作できません")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def docker_available():
    return hasattr(socket, "AF_UNIX") and os.path.exists(DOCKER_SOCK)


def _docker(method, path, timeout=60):
    if not docker_available():
        raise NetError("Docker を操作できません(パネルのコンテナに /var/run/docker.sock をマウントしてください)")
    if not re.fullmatch(r"/containers/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/(json|start|stop|restart)(\?t=\d+)?", path):
        raise NetError("コンテナ名が正しくありません")
    c = _UnixConn(DOCKER_SOCK, timeout=timeout)
    try:
        c.request(method, "/v1.41" + path)
        r = c.getresponse()
        body = r.read()
    except OSError as e:
        raise NetError(f"Docker に接続できません({e})") from e
    finally:
        c.close()
    if r.status == 404:
        raise NetError("コンテナが見つかりません")
    if r.status >= 400 and r.status != 304:
        raise NetError(f"Docker の操作に失敗しました(HTTP {r.status})")
    return json.loads(body) if body else {}


def docker_state(name):
    st = (_docker("GET", f"/containers/{name}/json").get("State") or {})
    if st.get("Restarting"):
        return "starting"
    return "running" if st.get("Running") else "offline"


def docker_power(name, signal):
    act = {"start": "start", "stop": "stop", "restart": "restart", "kill": "stop"}.get(signal)
    if not act:
        raise NetError("不正な操作です")
    _docker("POST", f"/containers/{name}/{act}" + ("?t=60" if act != "start" else ""), timeout=120)


# --------------------------------------------------------------------------
# サーバー本体(Paper / Purpur / Folia / Velocity / Fabric)の新しいビルド
# --------------------------------------------------------------------------
FILL = "https://fill.papermc.io/v3/projects"
_FILL_PROJECTS = {"paper", "folia", "velocity", "waterfall"}


def _get(url):
    r = requests.get(url, timeout=15, headers={"User-Agent": UA})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def parse_build(text):
    """"git-Paper-232 (MC: 1.21.4)" / "1.21.4-232-abcdef (MC: 1.21.4)" / "paper-1.21.4-232.jar" → (mc, build)。"""
    t = str(text or "")
    mc = ""
    m = re.search(r"\(MC: ([\d.]+)\)", t)
    if m:
        mc = m.group(1)
    m = re.search(r"git-[A-Za-z]+-(\d+)", t) or re.search(r"^([\d.]+)-(\d+)(?:-|\s|$)", t) \
        or re.search(r"^[a-z]+-([\d.]+(?:-SNAPSHOT)?)-(\d+)\.jar$", t, re.I)
    build = ""
    if m:
        if m.re.pattern.startswith("git"):
            build = m.group(1)
        else:
            mc = mc or m.group(1)
            build = m.group(2)
    return mc, build


def latest_build(software, mc):
    """そのサーバーソフト・バージョンの最新ビルドと、ダウンロード先。"""
    try:
        if software in _FILL_PROJECTS:
            d = _get(f"{FILL}/{software}/versions/{mc}/builds/latest")
            if not d:
                return None
            dl = ((d.get("downloads") or {}).get("server:default") or {})
            return {"build": str(d.get("id") or ""), "channel": str(d.get("channel") or "").lower(),
                    "url": dl.get("url") or "", "file": dl.get("name") or "", "time": d.get("time") or ""}
        if software == "purpur":
            d = _get(f"https://api.purpurmc.org/v2/purpur/{mc}")
            if not d:
                return None
            b = str((d.get("builds") or {}).get("latest") or "")
            return {"build": b, "channel": "stable", "url": f"https://api.purpurmc.org/v2/purpur/{mc}/{b}/download",
                    "file": f"purpur-{mc}-{b}.jar", "time": ""}
        if software in ("fabric", "quilt"):
            if software == "fabric":
                d = _get("https://meta.fabricmc.net/v2/versions/loader?limit=10") or []
                stable = next((x for x in d if x.get("stable")), d[0] if d else None)
                if not stable:
                    return None
                return {"build": stable.get("version", ""), "channel": "stable",
                        "url": "https://fabricmc.net/use/server/", "file": "", "time": ""}
            return None
    except (requests.RequestException, ValueError) as e:
        raise NetError(f"更新の確認に失敗しました({e.__class__.__name__})") from e
    return None


def newest_mc(software):
    """そのサーバーソフトが対応している、いちばん新しい正式版の MC(Paper 系のみ)。"""
    if software not in _FILL_PROJECTS - {"velocity", "waterfall"} and software != "purpur":
        return ""
    try:
        if software == "purpur":
            d = _get("https://api.purpurmc.org/v2/purpur") or {}
            vs = [v for v in d.get("versions") or [] if re.fullmatch(r"[\d.]+", v)]
        else:
            d = _get(f"{FILL}/{software}") or {}
            vs = [v for group in (d.get("versions") or {}).values() for v in group if re.fullmatch(r"[\d.]+", v)]
    except (requests.RequestException, ValueError):
        return ""
    return max(vs, key=lambda v: tuple(int(x) for x in v.split(".")), default="")
