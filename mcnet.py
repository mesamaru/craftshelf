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
# サーバー本体(サーバーソフト)の新しいビルドと取得
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


# サーバーソフトごとの扱い: auto = jar を取得して入れ替えられる / False = 新しいバージョンの確認だけ(インストーラーが要るもの)
SOFTWARE = {
    "paper": ("Paper", True), "folia": ("Folia", True), "purpur": ("Purpur", True), "leaf": ("Leaf", True),
    "pufferfish": ("Pufferfish", True), "velocity": ("Velocity", True), "waterfall": ("Waterfall", True),
    "bungeecord": ("BungeeCord", True), "fabric": ("Fabric", True), "vanilla": ("Vanilla", True),
    "mohist": ("Mohist", True), "sponge": ("SpongeVanilla", True),
    "quilt": ("Quilt", False), "forge": ("Forge", False), "neoforge": ("NeoForge", False), "arclight": ("Arclight", False),
    "spigot": ("Spigot", False), "bukkit": ("CraftBukkit", False),
}
_JENKINS = {"bungeecord": "https://ci.md-5.net/job/BungeeCord", "pufferfish": "https://ci.pufferfish.host/job/Pufferfish-{major}"}


def _major(mc):
    m = re.match(r"(\d+\.\d+)", mc or "")
    return m.group(1) if m else ""


def _res(build, url="", file="", channel="stable", sha256="", time="", auto=True):
    return {"build": str(build or ""), "channel": channel, "url": url, "file": file, "sha256": sha256, "time": time, "auto": bool(auto and url)}


def latest_build(software, mc):
    """そのサーバーソフト・Minecraft のバージョンの最新のビルドと、取得先(取得できないものは確認だけ)。"""
    try:
        if software in _FILL_PROJECTS:
            d = _get(f"{FILL}/{software}/versions/{mc}/builds/latest")
            if not d:
                return None
            dl = ((d.get("downloads") or {}).get("server:default") or {})
            return _res(d.get("id"), dl.get("url") or "", dl.get("name") or "", str(d.get("channel") or "").lower(),
                        ((dl.get("checksums") or {}).get("sha256") or ""), d.get("time") or "")
        if software == "purpur":
            d = _get(f"https://api.purpurmc.org/v2/purpur/{mc}")
            if not d:
                return None
            b = str((d.get("builds") or {}).get("latest") or "")
            return _res(b, f"https://api.purpurmc.org/v2/purpur/{mc}/{b}/download", f"purpur-{mc}-{b}.jar")
        if software == "leaf":
            d = _get(f"https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds")
            builds = (d or {}).get("builds") or []
            if not builds:
                return None
            b = builds[-1]
            dl = ((b.get("downloads") or {}).get("primary") or {})
            name = dl.get("name") or f"leaf-{mc}-{b.get('build')}.jar"
            return _res(b.get("build"), f"https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds/{b.get('build')}/downloads/{name}",
                        name, str(b.get("channel") or "default"), dl.get("sha256") or "", b.get("time") or "")
        if software in _JENKINS:
            job = _JENKINS[software].format(major=_major(mc))
            d = _get(f"{job}/lastSuccessfulBuild/api/json?tree=number,timestamp,artifacts%5BfileName,relativePath%5D")
            if not d:
                return None
            arts = d.get("artifacts") or []
            art = next((a for a in arts if a.get("fileName") == "BungeeCord.jar"), None) if software == "bungeecord" \
                else next((a for a in arts if a.get("fileName", "").endswith(".jar")), None)
            if not art:
                return _res(d.get("number"))
            return _res(d.get("number"), f"{job}/{d.get('number')}/artifact/{art['relativePath']}", art["fileName"])
        if software == "fabric":
            loaders = _get("https://meta.fabricmc.net/v2/versions/loader?limit=20") or []
            loader = next((x for x in loaders if x.get("stable")), loaders[0] if loaders else None)
            inst = next((x for x in (_get("https://meta.fabricmc.net/v2/versions/installer") or []) if x.get("stable")), None)
            if not loader:
                return None
            lv = loader.get("version", "")
            url = f"https://meta.fabricmc.net/v2/versions/loader/{mc}/{lv}/{inst['version']}/server/jar" if mc and inst else ""
            return _res(lv, url, f"fabric-server-mc.{mc}-loader.{lv}-launcher.{inst['version'] if inst else ''}.jar")
        if software == "quilt":
            d = _get("https://meta.quiltmc.org/v3/versions/loader") or []
            rel = next((x for x in d if "-" not in str(x.get("version", ""))), d[0] if d else None)
            return _res(rel.get("version"), auto=False) if rel else None
        if software == "vanilla":
            man = _get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json") or {}
            v = next((x for x in man.get("versions") or [] if x.get("id") == mc), None)
            if not v:
                return None
            srv = ((_get(v["url"]) or {}).get("downloads") or {}).get("server") or {}
            return _res(mc, srv.get("url") or "", f"minecraft_server.{mc}.jar")
        if software == "mohist":
            d = _get(f"https://api.mohistmc.com/project/mohist/{mc}/builds") or []
            if not d:
                return None
            b = max(d, key=lambda x: int(x.get("id") or 0))
            return _res(b.get("id"), f"https://api.mohistmc.com/project/mohist/{mc}/builds/{b.get('id')}/download",
                        f"mohist-{mc}-{b.get('id')}-server.jar", sha256=b.get("file_sha256") or "", time=b.get("build_date") or "")
        if software == "sponge":
            d = _get(f"https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla/versions?tags=minecraft:{mc}&offset=0&limit=1") or {}
            ver = next(iter((d.get("artifacts") or {}).keys()), "")
            if not ver:
                return None
            info = _get(f"https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla/versions/{ver}") or {}
            a = next((x for x in info.get("assets") or [] if x.get("classifier") == "universal" and x.get("extension") == "jar"), None)
            return _res(ver, (a or {}).get("downloadUrl", ""), f"spongevanilla-{ver}-universal.jar")
        if software == "forge":
            promos = (_get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json") or {}).get("promos") or {}
            v = promos.get(f"{mc}-recommended") or promos.get(f"{mc}-latest")
            return _res(v, auto=False) if v else None
        if software == "neoforge":
            parts = (mc or "").split(".")
            if len(parts) < 2 or parts[0] != "1":
                return None
            flt = f"{parts[1]}.{parts[2] if len(parts) > 2 else 0}"
            d = _get(f"https://maven.neoforged.net/api/maven/latest/version/releases/net/neoforged/neoforge?filter={flt}.") or {}
            return _res(d.get("version"), auto=False) if d.get("version") else None
        if software == "arclight":
            d = _get("https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=1") or []
            return _res(d[0].get("tag_name"), auto=False) if d else None
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        raise NetError(f"更新の確認に失敗しました({e.__class__.__name__})") from e
    return None


# 配布ページ(手で取得するとき・確かめるとき)
PAGES = {
    "paper": "https://papermc.io/downloads/paper", "folia": "https://papermc.io/downloads/folia",
    "velocity": "https://papermc.io/downloads/velocity", "waterfall": "https://papermc.io/downloads/all",
    "purpur": "https://purpurmc.org/downloads", "leaf": "https://www.leafmc.one/download",
    "pufferfish": "https://ci.pufferfish.host/", "bungeecord": "https://ci.md-5.net/job/BungeeCord/",
    "fabric": "https://fabricmc.net/use/server/", "quilt": "https://quiltmc.org/en/install/server/",
    "vanilla": "https://www.minecraft.net/en-us/download/server", "mohist": "https://mohistmc.com/download",
    "sponge": "https://spongepowered.org/downloads/spongevanilla", "forge": "https://files.minecraftforge.net/",
    "neoforge": "https://neoforged.net/", "arclight": "https://github.com/IzzelAliz/Arclight/releases",
    "spigot": "https://www.spigotmc.org/wiki/buildtools/", "bukkit": "https://www.spigotmc.org/wiki/buildtools/",
}


def _vkey(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:4])


def mc_versions(software):
    """そのサーバーソフトで選べる Minecraft(プロキシは本体)のバージョン。新しい順。"""
    try:
        if software in _FILL_PROJECTS:
            d = _get(f"{FILL}/{software}") or {}
            vs = [v for group in (d.get("versions") or {}).values() for v in group]
        elif software == "purpur":
            vs = (_get("https://api.purpurmc.org/v2/purpur") or {}).get("versions") or []
        elif software == "leaf":
            vs = (_get("https://api.leafmc.one/v2/projects/leaf") or {}).get("versions") or []
        elif software in ("vanilla", "fabric"):
            man = _get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json") or {}
            vs = [x["id"] for x in man.get("versions") or [] if x.get("type") == "release"]
        elif software == "mohist":
            vs = [x.get("name") or x.get("version") or "" for x in (_get("https://api.mohistmc.com/project/mohist/versions") or [])]
        else:
            return []
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return []
    vs = [v for v in vs if v and re.fullmatch(r"[\d.]+(-SNAPSHOT)?", v)]
    return sorted(set(vs), key=_vkey, reverse=True)[:60]


def list_builds(software, mc, limit=25):
    """そのサーバーソフト・バージョンのビルドの一覧(新しい順)。取得先が分からないものは url が空。"""
    out = []
    try:
        if software in _FILL_PROJECTS:
            d = _get(f"{FILL}/{software}/versions/{mc}/builds") or []
            for b in sorted(d, key=lambda x: int(x.get("id") or 0), reverse=True)[:limit]:
                dl = ((b.get("downloads") or {}).get("server:default") or {})
                out.append(_res(b.get("id"), dl.get("url") or "", dl.get("name") or "", str(b.get("channel") or "").lower(),
                                ((dl.get("checksums") or {}).get("sha256") or ""), b.get("time") or ""))
        elif software == "purpur":
            d = _get(f"https://api.purpurmc.org/v2/purpur/{mc}") or {}
            for b in sorted((d.get("builds") or {}).get("all") or [], key=lambda x: int(x) if str(x).isdigit() else 0, reverse=True)[:limit]:
                out.append(_res(b, f"https://api.purpurmc.org/v2/purpur/{mc}/{b}/download", f"purpur-{mc}-{b}.jar"))
        elif software == "leaf":
            d = _get(f"https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds") or {}
            for b in list(reversed(d.get("builds") or []))[:limit]:
                dl = ((b.get("downloads") or {}).get("primary") or {})
                name = dl.get("name") or f"leaf-{mc}-{b.get('build')}.jar"
                out.append(_res(b.get("build"), f"https://api.leafmc.one/v2/projects/leaf/versions/{mc}/builds/{b.get('build')}/downloads/{name}",
                                name, str(b.get("channel") or "default"), dl.get("sha256") or "", b.get("time") or ""))
        elif software == "mohist":
            d = _get(f"https://api.mohistmc.com/project/mohist/{mc}/builds") or []
            for b in sorted(d, key=lambda x: int(x.get("id") or 0), reverse=True)[:limit]:
                out.append(_res(b.get("id"), f"https://api.mohistmc.com/project/mohist/{mc}/builds/{b.get('id')}/download",
                                f"mohist-{mc}-{b.get('id')}-server.jar", sha256=b.get("file_sha256") or "", time=b.get("build_date") or ""))
        elif software == "fabric":
            loaders = _get("https://meta.fabricmc.net/v2/versions/loader?limit=40") or []
            inst = next((x for x in (_get("https://meta.fabricmc.net/v2/versions/installer") or []) if x.get("stable")), None)
            for x in loaders[:limit]:
                lv = x.get("version", "")
                url = f"https://meta.fabricmc.net/v2/versions/loader/{mc}/{lv}/{inst['version']}/server/jar" if mc and inst else ""
                out.append(_res(lv, url, f"fabric-server-mc.{mc}-loader.{lv}-launcher.{inst['version'] if inst else ''}.jar"))
        elif software == "sponge":
            d = _get(f"https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla/versions?tags=minecraft:{mc}&offset=0&limit={min(limit, 10)}") or {}
            for ver in (d.get("artifacts") or {}).keys():
                out.append(_res(ver, f"sponge:{ver}", f"spongevanilla-{ver}-universal.jar"))  # 取得先は入れる時に確かめる
        elif software in _JENKINS:
            job = _JENKINS[software].format(major=_major(mc))
            d = _get(f"{job}/api/json?tree=builds%5Bnumber,result,artifacts%5BfileName,relativePath%5D%5D%7B0,{limit}%7D") or {}
            for b in d.get("builds") or []:
                if b.get("result") not in (None, "SUCCESS"):
                    continue
                arts = b.get("artifacts") or []
                art = next((a for a in arts if a.get("fileName") == "BungeeCord.jar"), None) if software == "bungeecord" \
                    else next((a for a in arts if a.get("fileName", "").endswith(".jar")), None)
                out.append(_res(b.get("number"), f"{job}/{b.get('number')}/artifact/{art['relativePath']}" if art else "", art["fileName"] if art else ""))
        else:
            one = latest_build(software, mc)
            out = [one] if one else []
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        raise NetError(f"ビルドの一覧を取得できませんでした({e.__class__.__name__})") from e
    return out


def resolve_build(software, mc, build):
    """選ばれたビルドの取得先(一覧から探し直す。ブラウザから来た URL は使わない)。"""
    hit = next((b for b in list_builds(software, mc, 60) if str(b["build"]) == str(build)), None)
    if hit and hit["url"].startswith("sponge:"):
        info = _get(f"https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla/versions/{hit['build']}") or {}
        a = next((x for x in info.get("assets") or [] if x.get("classifier") == "universal" and x.get("extension") == "jar"), None)
        hit = {**hit, "url": (a or {}).get("downloadUrl", ""), "auto": bool(a)}
    return hit


def download(url, dest, sha256="", max_bytes=600 * 1024 * 1024):
    """サーバー本体の jar を取得する(sha256 があれば中身を確かめる)。"""
    import hashlib
    h = hashlib.sha256()
    total = 0
    try:
        with requests.get(url, stream=True, timeout=(15, 300), headers={"User-Agent": UA}) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1024 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise NetError("ファイルが大きすぎます")
                    h.update(chunk)
                    f.write(chunk)
    except requests.RequestException as e:
        raise NetError(f"取得に失敗しました({e.__class__.__name__})") from e
    if total < 1024:
        raise NetError("取得したファイルが小さすぎます(jar ではないようです)")
    if sha256 and h.hexdigest().lower() != sha256.lower():
        raise NetError("取得したファイルの中身が配布元の記録と一致しません")
    with open(dest, "rb") as f:
        if f.read(2) != b"PK":
            raise NetError("取得したファイルが jar ではありません")
    return total


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
