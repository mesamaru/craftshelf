"""CraftShelf: サーバー(Pterodactyl / フォルダ)の管理・同期・比較・巻き戻し・ワールドのバックアップ。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import os
import re
import shutil
import time
import uuid
import zipfile

from flask import has_request_context, jsonify, request, send_file

from storage import StorageError
import mcnet
import ptero
import sources as src

from .core import ApiError, CATEGORIES, CONFIG_DIR, LOCK, TMP_DIR, _jl, _truthy, app, db, get_setting, norm_key, safe_name, utcnow
from .analysis import analyze, auto_mc_versions, version_key
from .auth import current_user, decrypt_secret, encrypt_secret, get_server_checked, has_perm, require, require_perm, visible_item_ids
from .events import audit, notify_event
from .jobs import start_job
from .library import _item_versions, _uid_of, active_store, build_library, ingest, lib_rel, open_store, resolve_set_versions, sha256_file
from .upstream import source_public


# ==========================================================================
# Pterodactyl 連携
# ==========================================================================
def ptero_client():
    url, key = get_setting("ptero_url"), decrypt_secret(get_setting("ptero_key"))
    try:
        return ptero.Ptero(url, key, verify_tls=get_setting("ptero_insecure", "0") != "1")
    except ptero.PteroError as e:
        raise ApiError(e.message)


def _pcall(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ptero.PteroError as e:
        raise ApiError(e.message, 502)


@app.post("/api/ptero/test")
@require_perm("integrations")
def api_ptero_test():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or get_setting("ptero_url") or "")
    key = str(data.get("key") or "") or decrypt_secret(get_setting("ptero_key"))
    insecure = _truthy(data["insecure"]) if "insecure" in data else get_setting("ptero_insecure", "0") == "1"
    try:
        servers = ptero.Ptero(url, key, verify_tls=not insecure).servers()
    except ptero.PteroError as e:
        return jsonify(ok=False, message=e.message)
    return jsonify(ok=True, message=f"接続できました(操作できるサーバー: {len(servers)} 台)")


@app.get("/api/ptero/servers")
@require("editor")
def api_ptero_servers():
    servers = _pcall(ptero_client().servers)
    names = {r[0]: r[1] for r in db().execute("SELECT id, username FROM users")}
    linked = {r["identifier"]: r for r in db().execute("SELECT id, identifier, owner_id FROM servers")}
    for s in servers:
        r = linked.get(s["identifier"])
        s["linked_id"] = r["id"] if r else None
        s["linked_by"] = names.get(r["owner_id"], "") if r else ""
    return jsonify(servers=servers)


# --------------------------------------------------------------------------
# サーバーのファイル(Pterodactyl / このパネルから見えるフォルダ)
# --------------------------------------------------------------------------
SERVER_CATS = ("plugin", "mod", "datapack")  # サーバーで管理する種類(表示もこの順)
SERVER_SOFTWARE = ("paper", "purpur", "folia", "spigot", "bukkit", "velocity", "bungeecord", "waterfall",
                   "fabric", "quilt", "forge", "neoforge", "sponge")
_SOFT_PROXY = {"velocity", "bungeecord", "waterfall"}
_SOFT_MOD = {"fabric", "quilt", "forge", "neoforge"}


def default_dirs(software, world="world"):
    """サーバーソフトから、種類ごとのフォルダ(サーバーのフォルダからの相対パス)を決める。"""
    world = _clean_rel_dir(world) or "world"
    if software in _SOFT_PROXY:
        return {"plugin": "plugins"}
    if software in _SOFT_MOD:
        return {"mod": "mods", "datapack": f"{world}/datapacks"}
    if software == "sponge":
        return {"plugin": "plugins", "mod": "mods", "datapack": f"{world}/datapacks"}
    return {"plugin": "plugins", "datapack": f"{world}/datapacks"}


def _clean_rel_dir(d):
    parts = [p for p in str(d or "").replace("\\", "/").split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise ApiError("フォルダの指定が不正です")
    return "/".join(parts)


def _clean_dirs(d):
    if not isinstance(d, dict):
        return {}
    out = {}
    for c in SERVER_CATS:
        v = _clean_rel_dir(d.get(c))
        if v:
            out[c] = v
    return out


def server_dirs(row):
    """{種類: フォルダ}。01.16 より前の連携は、プラグインのフォルダ 1 つだけを持つ。"""
    d = _clean_dirs(_jl(row["dirs"], {}))
    if d:
        return d
    pd = _clean_rel_dir(row["plugin_dir"]) or "plugins"
    return {"mod" if pd.rsplit("/", 1)[-1] == "mods" else "plugin": pd}


def _local_root(p):
    """このパネルから見えるサーバーのフォルダ(絶対パス)を確かめる。"""
    p = str(p or "").strip()
    if not p or not Path(p).is_absolute():
        raise ApiError("サーバーのフォルダは、/srv/minecraft や D:\\minecraft のような絶対パスで入力してください")
    path = Path(p).resolve()
    if path == Path(path.anchor):
        raise ApiError("ドライブやディスクの一番上は指定できません")
    if not path.is_dir():
        raise ApiError(f"フォルダが見つかりません: {p}(Docker の場合は、コンテナにフォルダをマウントしてください)")
    return str(path)


class _PteroFiles:
    """Pterodactyl のサーバー(Client API 経由)。"""
    kind = "ptero"

    def __init__(self, ident):
        self.p, self.ident = ptero_client(), ident

    def list(self, rel):
        try:
            return self.p.list_dir(self.ident, "/" + rel)
        except ptero.PteroError:
            return None

    def download(self, rel, dest):
        _pcall(self.p.download, self.ident, "/" + rel, dest)

    def upload(self, rel_dir, src_path, name):
        if self.list(rel_dir) is None:  # データパックのフォルダなどが無ければ作る
            parent, _sep, leaf = rel_dir.rpartition("/")
            self.p.create_folder(self.ident, "/" + parent, leaf)
        _pcall(self.p.upload, self.ident, "/" + rel_dir, src_path, name)

    def delete(self, rel_dir, names):
        _pcall(self.p.delete, self.ident, "/" + rel_dir, list(names))

    def power(self, signal):
        _pcall(self.p.power, self.ident, signal)

    def status(self):
        return self.p.resources(self.ident)

    def rename(self, rel_dir, frm, to):
        _pcall(self.p.rename, self.ident, "/" + rel_dir, frm, to)

    def tail(self, rel, nbytes=256 * 1024):
        try:
            return self.p.tail(self.ident, "/" + rel, nbytes)
        except ptero.PteroError:
            return None

    def read_bytes(self, rel, limit):
        parent, _sep, name = rel.rpartition("/")
        entry = next((e for e in (self.list(parent) or []) if e["name"] == name and e["is_file"]), None)
        if entry is None:
            return None
        if entry["size"] > limit:
            raise ApiError("ファイルが大きすぎるため、ここでは編集できません")
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            _pcall(self.p.download, self.ident, "/" + rel, tmp, limit)
            return tmp.read_bytes()
        finally:
            tmp.unlink(missing_ok=True)

    def write_bytes(self, rel, data):
        _pcall(self.p.write_file, self.ident, "/" + rel, data)

    def read_text(self, rel, limit=256 * 1024):
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            _pcall(self.p.download, self.ident, "/" + rel, tmp, limit)
            return tmp.read_text("utf-8", "replace")
        except ApiError:
            return None
        finally:
            tmp.unlink(missing_ok=True)

    def archive(self, rel_dir, names, dest):
        """サーバー上でまとめて圧縮して取り出す。拡張子(.tar.gz など)を返す。"""
        name = _pcall(self.p.compress, self.ident, "/" + rel_dir, names)
        if not name:
            raise ApiError("サーバー上で圧縮できませんでした")
        path = f"{rel_dir}/{name}" if rel_dir else name
        try:
            _pcall(self.p.download, self.ident, "/" + path, dest, 64 * 1024 ** 3)
        finally:
            try:
                _pcall(self.p.delete, self.ident, "/" + rel_dir, [name])
            except ApiError:
                pass
        return ".tar.gz" if name.endswith(".tar.gz") else Path(name).suffix

    def restore_archive(self, rel_dir, src_path, ext):
        name = f".craftshelf-restore-{uuid.uuid4().hex[:8]}{ext}"
        self.upload(rel_dir, src_path, name)
        try:
            _pcall(self.p.decompress, self.ident, "/" + rel_dir, name)
        finally:
            try:
                _pcall(self.p.delete, self.ident, "/" + rel_dir, [name])
            except ApiError:
                pass

    def address(self):
        try:
            return self.p.address(self.ident)
        except ptero.PteroError:
            return ""


class _LocalFiles:
    """このパネルから見えるフォルダにあるサーバー(同じ PC・NAS の共有・Docker でマウントしたフォルダ)。"""
    kind = "local"

    def __init__(self, root):
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise ApiError(f"サーバーのフォルダが見つかりません: {root}")

    def _p(self, rel):
        p = (self.root / rel).resolve()
        if p != self.root and self.root not in p.parents:
            raise ApiError("フォルダの指定が不正です")
        return p

    def list(self, rel):
        d = self._p(rel)
        if not d.is_dir():
            return None
        out = []
        for e in d.iterdir():
            try:
                st = e.stat()
            except OSError:
                continue
            out.append({"name": e.name, "size": st.st_size, "is_file": e.is_file(),
                        "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        return out

    def download(self, rel, dest):
        try:
            shutil.copyfile(self._p(rel), dest)
        except OSError as e:
            raise ApiError(f"サーバーのファイルを読めません: {rel}({e.strerror or e})") from e

    def upload(self, rel_dir, src_path, name):
        try:
            d = self._p(rel_dir)
            d.mkdir(parents=True, exist_ok=True)
            dst = self._p(f"{rel_dir}/{name}" if rel_dir else name)  # rel_dir="" はサーバーのフォルダのいちばん上
            part = d / f".{name}.craftshelf-part"
            shutil.copyfile(src_path, part)
            os.replace(part, dst)  # 書き終わってから置き換える(途中のファイルをサーバーが読まないように)
        except OSError as e:
            raise ApiError(f"サーバーのフォルダに書き込めません: {rel_dir}({e.strerror or e})") from e

    def delete(self, rel_dir, names):
        for n in names:
            p = self._p(f"{rel_dir}/{n}")
            try:
                if p.is_file():
                    p.unlink()
            except OSError as e:
                raise ApiError(f"サーバーのファイルを削除できません: {n}({e.strerror or e})") from e

    def rename(self, rel_dir, frm, to):
        try:
            os.replace(self._p(f"{rel_dir}/{frm}"), self._p(f"{rel_dir}/{to}"))
        except OSError as e:
            raise ApiError(f"名前を変更できません: {frm}({e.strerror or e})") from e

    def read_text(self, rel, limit=256 * 1024):
        try:
            with open(self._p(rel), "rb") as f:
                return f.read(limit).decode("utf-8", "replace")
        except OSError:
            return None

    def read_bytes(self, rel, limit):
        """ファイルの中身(無ければ None。limit より大きければ ApiError)。"""
        p = self._p(rel)
        try:
            if p.stat().st_size > limit:
                raise ApiError("ファイルが大きすぎるため、ここでは編集できません")
            return p.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as e:
            raise ApiError(f"ファイルを読めません: {rel}({e.strerror or e})") from e

    def write_bytes(self, rel, data):
        p = self._p(rel)
        part = p.with_name(f".{p.name}.craftshelf-part")
        try:
            part.write_bytes(data)
            os.replace(part, p)  # 書き終わってから置き換える
        except OSError as e:
            part.unlink(missing_ok=True)
            raise ApiError(f"ファイルに書き込めません: {rel}({e.strerror or e})") from e

    def tail(self, rel, nbytes=256 * 1024):
        try:
            with open(self._p(rel), "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - nbytes))
                return f.read(nbytes)
        except OSError:
            return None

    def archive(self, rel_dir, names, dest):
        """フォルダをまとめて zip にする(ワールド・プラグインの設定フォルダ)。"""
        base = self._p(rel_dir)
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            for n in names:
                top = self._p(f"{rel_dir}/{n}" if rel_dir else n)
                if top.is_file():
                    z.write(top, n)
                    continue
                for f in sorted(top.rglob("*")):
                    if f.is_file() and f.name != "session.lock":
                        try:
                            z.write(f, f.relative_to(base).as_posix())
                        except OSError:
                            pass  # 書き込み中などで読めないファイルは飛ばす
        return ".zip"

    def restore_archive(self, rel_dir, src_path, ext):
        base = self._p(rel_dir)
        with zipfile.ZipFile(src_path) as z:
            for m in z.infolist():
                dst = (base / m.filename).resolve()
                if base != dst and base not in dst.parents:
                    raise ApiError("退避したファイルの中身が不正です")
                if m.is_dir():
                    dst.mkdir(parents=True, exist_ok=True)
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                with z.open(m) as fi, open(dst, "wb") as fo:
                    shutil.copyfileobj(fi, fo)

    def address(self):
        return ""

    def power(self, signal):
        raise ApiError("このサーバーは、起動・停止の方法が設定されていません(「設定」→「起動・停止」)")

    def status(self):
        return {"state": "local"}


def server_fs(row):
    return _LocalFiles(row["root_dir"]) if row["kind"] == "local" else _PteroFiles(row["identifier"])


# --------------------------------------------------------------------------
# サーバーの状態・起動停止(Pterodactyl / コマンド / Docker)・RCON
# --------------------------------------------------------------------------
def _rcon(row):
    """RCON の設定があれば、接続済みの mcnet.Rcon を返す(with で使う)。"""
    if not row["rcon_port"] or not row["rcon_password"]:
        return None
    host = mcnet.parse_address(_server_address(row) or "127.0.0.1")[0]
    return mcnet.Rcon(host, row["rcon_port"], decrypt_secret(row["rcon_password"]))


def _server_address(row):
    if row["address"]:
        return row["address"]
    if row["kind"] == "ptero":
        info = _jl(row["soft_info"], {})
        if info.get("address"):
            return info["address"]
        addr = server_fs(row).address()
        if addr:
            info["address"] = addr
            with LOCK:
                db().execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(info), row["id"]))
                db().commit()
        return addr
    if row["kind"] == "local":  # 同じ PC なら server.properties のポートで問い合わせる
        props = _server_props(server_fs(row))
        return f"127.0.0.1:{props.get('server-port') or 25565}"
    return ""


def _server_props(fs):
    out = {}
    for line in (fs.read_text("server.properties") or "").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _wait_offline(row, seconds=90):
    """止まるまで待つ(人数の問い合わせに答えなくなるまで)。"""
    try:
        host, port = mcnet.parse_address(_server_address(row))
    except mcnet.NetError:
        time.sleep(5)
        return
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            mcnet.ping(host, port, timeout=2)
        except mcnet.NetError:
            return
        time.sleep(2)


def _run_cmd(row, cmd, wait):
    import subprocess
    kw = {"cwd": row["root_dir"] or None, "shell": True, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
          "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    p = subprocess.Popen(cmd, **kw)  # noqa: S602(管理者が設定したコマンドだけを実行する)
    if wait:
        try:
            p.wait(timeout=180)
        except subprocess.TimeoutExpired:
            pass


def server_power(row, signal):
    """起動・停止・再起動。Pterodactyl / Docker / 設定したコマンド(停止は RCON の stop でも可)。"""
    if signal not in ("start", "stop", "restart", "kill"):
        raise ApiError("不正な操作です")
    if row["kind"] == "ptero":
        return server_fs(row).power(signal)
    try:
        if row["control"] == "docker" and row["container"]:
            return mcnet.docker_power(row["container"], signal)
        if row["control"] == "command":
            def stop():
                rc = _rcon(row)
                if row["stop_cmd"]:
                    _run_cmd(row, row["stop_cmd"], wait=True)
                elif rc:
                    with rc as r:
                        r.command("stop")
                else:
                    raise ApiError("停止のコマンドか RCON を設定してください")
                _wait_offline(row)

            def start():
                if not row["start_cmd"]:
                    raise ApiError("起動のコマンドを設定してください")
                _run_cmd(row, row["start_cmd"], wait=False)
            if signal in ("stop", "kill"):
                return stop()
            if signal == "start":
                return start()
            stop()
            return start()
    except mcnet.NetError as e:
        raise ApiError(e.message) from e
    return server_fs(row).power(signal)


def server_live(row):
    """今の状態: 稼働状況・人数・バージョン・応答速度(Pterodactyl なら CPU・メモリも)。"""
    out = {"state": "unknown", "controls": row["kind"] == "ptero" or (row["control"] in ("command", "docker"))}
    try:
        if row["kind"] == "ptero":
            out.update(server_fs(row).status())
        elif row["control"] == "docker" and row["container"]:
            out["state"] = mcnet.docker_state(row["container"])
    except (ptero.PteroError, ApiError, mcnet.NetError) as e:
        out["error"] = getattr(e, "message", str(e))
    addr = ""
    try:
        addr = _server_address(row)
    except ApiError:
        pass
    out["address"] = addr
    if addr:
        try:
            p = mcnet.ping(*mcnet.parse_address(addr), timeout=3)
            out.update(ping=p)
            if out["state"] in ("unknown", "local"):
                out["state"] = "running"
            mc = mcnet.mc_from_version_name(p.get("version"))
            if mc and not row["mc_version"]:
                out["mc_detected"] = mc
        except mcnet.NetError as e:
            out["ping_error"] = e.message
            if out["state"] in ("unknown", "local") and row["kind"] == "local":
                out["state"] = "offline"
    if out["state"] == "unknown" and row["kind"] == "local" and not addr:
        out["state"] = "local"
    return out


# --------------------------------------------------------------------------
# 対応MCバージョンの照らし合わせ
# --------------------------------------------------------------------------
def _ver_nums(v):
    m = re.search(r"\d+(?:\.\d+)*", str(v or ""))
    return [int(x) for x in m.group(0).split(".")] if m else []


def _cmp_nums(a, b):
    for i in range(max(len(a), len(b))):
        d = (a[i] if i < len(a) else 0) - (b[i] if i < len(b) else 0)
        if d:
            return d
    return 0


def mc_supports(text, line):
    """「1.20 以降」「1.20.1〜1.21.4」「1.20.1, 1.20.2」「[1.20.1,1.21)」などが、系列(例 1.21)で使えるか。不明は None。"""
    if not text or not line:
        return None
    L = _ver_nums(line)[:2]
    if len(L) < 2:
        return None
    lend = [L[0], L[1] + 1]
    t = re.sub(r"\s", "", str(text))
    m = re.fullmatch(r"([\d.]+)以降", t) or re.fullmatch(r">=?([\d.]+)", t) or re.fullmatch(r"\[([\d.]+),\)", t)
    if m:
        return _cmp_nums(_ver_nums(m.group(1)), lend) < 0
    m = re.fullmatch(r"([\d.]+)[〜~\-–]([\d.]+)", t) or re.fullmatch(r"\[([\d.]+),([\d.]+)[)\]]", t)
    if m:
        return _cmp_nums(_ver_nums(m.group(1)), lend) < 0 and _cmp_nums(_ver_nums(m.group(2)), L) >= 0
    parts = [p for p in re.split(r"[,、]", t) if p]
    if parts and all(re.fullmatch(r"[\d.]+", p) for p in parts):
        return any(_ver_nums(p)[:2] == L for p in parts)
    return None


def _version_mc(conn, item, v):
    if item["mc_versions"]:
        return item["mc_versions"]
    src_row = conn.execute("SELECT * FROM item_sources WHERE item_id=?", (item["id"],)).fetchone()
    return auto_mc_versions(_jl(v["meta"], {}), item["category"], source_public(src_row) if src_row else None)


def _compat(conn, row, item, v):
    """このバージョンがサーバーの MC で使えるか(True / False / 不明 None)。プロキシは見ない。"""
    if not row["mc_version"] or row["software"] in _SOFT_PROXY or not v:
        return None
    return mc_supports(_version_mc(conn, item, v), row["mc_version"])


def _holds(conn, srv_id):
    return {r[0] for r in conn.execute("SELECT item_id FROM server_holds WHERE server_id=?", (srv_id,))}


def _detect_build(fs, root_names=None):
    """サーバー本体のバージョンとビルド(Paper 系は version_history.json、それ以外は jar の名前から)。"""
    mc = build = ""
    vh = fs.read_text("version_history.json", 64 * 1024)
    if vh:
        try:
            mc, build = mcnet.parse_build(json.loads(vh).get("currentVersion"))
        except ValueError:
            pass
    if not build:
        for n in sorted(root_names if root_names is not None else [e["name"] for e in (fs.list("") or [])]):
            m = re.match(r"fabric-server-mc\.([\d.]+)-loader\.([\d.]+)", n)
            if m:
                return m.group(1), m.group(2)
            if n.lower().endswith(".jar"):
                m2, b2 = mcnet.parse_build(n)
                if b2:
                    mc, build = mc or m2, b2
                    break
    return mc, build


def _soft_from_jar(name):
    """サーバーの jar の名前から、サーバーソフトを決める(例: paper-1.21.4-232.jar → paper)。"""
    n = str(name or "").lower()
    for key, soft in (("velocity", "velocity"), ("waterfall", "waterfall"), ("bungeecord", "bungeecord"), ("purpur", "purpur"),
                      ("folia", "folia"), ("leaf", "leaf"), ("pufferfish", "pufferfish"), ("mohist", "mohist"), ("arclight", "arclight"),
                      ("paper", "paper"), ("spigot", "spigot"), ("craftbukkit", "bukkit"), ("bukkit", "bukkit"),
                      ("quilt", "quilt"), ("fabric", "fabric"), ("neoforge", "neoforge"), ("forge", "forge"), ("sponge", "sponge"),
                      ("minecraft_server", "vanilla")):
        if key in n:
            return soft
    return ""


def detect_server(fs, jar=None):
    """サーバーのフォルダの中身から、サーバーソフト・ワールドの名前・種類ごとのフォルダを推測する。

    jar(サーバーソフトの jar の名前)を渡すと、その名前を優先してサーバーソフトとバージョンを決める。"""
    root = fs.list("") or []
    names = {e["name"].lower() for e in root}
    jars = " ".join(n for n in names if n.endswith(".jar"))

    def sub(rel):
        return {e["name"].lower() for e in (fs.list(rel) or [])}

    soft = ""
    if "velocity.toml" in names or "velocity" in jars:
        soft = "velocity"
    elif "waterfall.yml" in names or "waterfall" in jars:
        soft = "waterfall"
    elif "bungeecord" in jars or "modules.yml" in names:
        soft = "bungeecord"
    elif "purpur.yml" in names or "purpur" in jars:
        soft = "purpur"
    elif "folia" in jars:
        soft = "folia"
    elif "paper.yml" in names or "paper" in jars or ("config" in names and "paper-global.yml" in sub("config")):
        soft = "paper"
    elif "spigot.yml" in names or "spigot" in jars:
        soft = "spigot"
    elif "bukkit.yml" in names:
        soft = "bukkit"
    elif "quilt-server-launch.jar" in names or ".quilt" in names or "quilt" in jars:
        soft = "quilt"
    elif ".fabric" in names or "fabric" in jars:
        soft = "fabric"
    elif "libraries" in names:
        net = sub("libraries/net")
        soft = "neoforge" if "neoforged" in net else "forge" if "minecraftforge" in net else ""
    jar_soft = _soft_from_jar(jar) if jar else ""
    soft = jar_soft or soft
    world = "world"
    if "server.properties" in names:
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            fs.download("server.properties", tmp)
            for line in tmp.read_text("utf-8", "replace").splitlines():
                if line.strip().startswith("level-name="):
                    world = line.split("=", 1)[1].strip() or "world"
        except (ApiError, OSError):
            pass
        finally:
            tmp.unlink(missing_ok=True)
    try:
        world = _clean_rel_dir(world) or "world"
    except ApiError:
        world = "world"
    if soft:
        dirs = default_dirs(soft, world)
    else:  # 判定できないときは、実際にあるフォルダを使う
        dirs = {c: d for c, d in (("plugin", "plugins"), ("mod", "mods")) if d in names} or {"plugin": "plugins"}
        if world.lower() in names:
            dirs["datapack"] = f"{world}/datapacks"
    mc, build = _detect_build(fs, [e["name"] for e in root])
    if jar:
        m = re.match(r"fabric-server-mc\.([\d.]+)-loader\.([\d.]+)", jar)
        jm, jb = (m.group(1), m.group(2)) if m else mcnet.parse_build(jar)
        if soft not in _SOFT_PROXY:
            mc = mc or jm
        build = build or jb
    if soft in _SOFT_PROXY:
        mc = ""
    return {"software": soft, "world": world, "dirs": dirs, "is_server": bool(soft or "server.properties" in names),
            "mc": mc, "build": build, "jar": jar or "", "jar_matched": bool(jar_soft)}


def _cached_states(conn, servers):
    """最後に確認したときの中身(キャッシュ)から、サーバーごとに [(ファイル, 種類, アイテムID, 状態)] を作る。"""
    _store, target = active_store()
    by_sha = {v["sha256"]: v for v in conn.execute("SELECT * FROM versions WHERE target_id=?", (target["id"],))}
    vis = visible_item_ids(conn)
    items = {r["id"]: r for r in conn.execute("SELECT * FROM items WHERE target_id=?", (target["id"],)) if r["id"] in vis}
    by_key = {}
    for it in items.values():
        by_key.setdefault((it["category"], norm_key(it["name"])), it["id"])
    latest = {iid: (_item_versions(conn, iid) or [None])[0] for iid in items}
    out = {}
    for srv in servers:
        rev = {d: c for c, d in server_dirs(srv).items()}
        lst = []
        for f in conn.execute("SELECT * FROM server_files WHERE server_id=?", (srv["id"],)):
            cat = rev.get(f["name"].rpartition("/")[0])
            if cat is None:
                continue
            v = by_sha.get(f["sha256"])
            iid = v["item_id"] if v else by_key.get((cat, norm_key(f["plugin_name"])))
            status = None
            if iid in items:
                lv = latest.get(iid)
                same = (v and lv and v["id"] == lv["id"]) or (lv and src.same_version(lv["version"], f["version"]))
                ahead = not same and lv and f["version"] and version_key(f["version"]) > version_key(lv["version"])
                status = "latest" if same else "newer" if ahead else "outdated"
            else:
                iid = None
            lst.append((f, cat, iid, status))
        out[srv["id"]] = lst
    return out, items


def visible_servers(conn, user=None):
    u = user or current_user()
    if not u:
        return []
    shared = {r[0]: r[1] for r in conn.execute("SELECT server_id, level FROM server_acl WHERE user_id=?", (u["id"],))}
    return [r for r in conn.execute("SELECT * FROM servers ORDER BY name").fetchall()
            if r["owner_id"] == u["id"] or r["id"] in shared]


def server_public(conn, r, summary=None):
    d = dict(r)
    d["has_rcon"] = bool(r["rcon_port"] and r["rcon_password"])
    d.pop("rcon_password", None)
    d["stage_targets"] = _jl(r["stage_targets"], [])
    d["soft_info"] = _jl(r["soft_info"], {})
    d["holds"] = len(_holds(conn, r["id"]))
    d["staged_from"] = [x["id"] for x in conn.execute("SELECT id, stage_targets FROM servers")
                        if r["id"] in _jl(x["stage_targets"], [])]
    if r["set_id"]:
        s = conn.execute("SELECT name FROM sets WHERE id=?", (r["set_id"],)).fetchone()
        d["set_name"] = s["name"] if s else ""
    d["dirs"] = server_dirs(r)
    if summary is not None:
        cats = {c: {"files": 0, "outdated": 0} for c in d["dirs"]}
        for _f, cat, _iid, status in summary:
            cats[cat]["files"] += 1
            cats[cat]["outdated"] += status == "outdated"
        d["summary"] = cats
        d["checked"] = bool(summary)
    u = current_user() if has_request_context() else None
    if u:
        names = {x[0]: x[1] for x in conn.execute("SELECT id, username FROM users")}
        mine = r["owner_id"] == u["id"]
        lv = conn.execute("SELECT level FROM server_acl WHERE server_id=? AND user_id=?", (r["id"], u["id"])).fetchone()
        d["access"] = "owner" if mine else (lv[0] if lv else "view")
        d["owner_name"] = names.get(r["owner_id"], "")
        d["shared_with"] = [{"user_id": x[0], "username": names.get(x[0], "?"), "level": x[1]} for x in
                            conn.execute("SELECT user_id, level FROM server_acl WHERE server_id=?", (r["id"],))] if mine else []
    return d


@app.get("/api/servers")
def api_servers():
    conn = db()
    rows = visible_servers(conn)
    try:
        states, _items = _cached_states(conn, rows)
    except ApiError:  # 保存先につながっていないときは件数なし
        states = {}
    return jsonify(servers=[server_public(conn, r, states.get(r["id"], [])) for r in rows],
                   configured=bool(get_setting("ptero_url") and get_setting("ptero_key")),
                   local_ok=has_perm("system"), software=list(SERVER_SOFTWARE), docker=mcnet.docker_available())


def _clean_dir(d):
    d = "/" + str(d or "/plugins").strip().strip("/")
    if ".." in d.split("/"):
        raise ApiError("フォルダの指定が不正です")
    return d


@app.post("/api/servers")
@require("editor")
def api_servers_create():
    data = request.get_json(silent=True) or {}
    conn = db()
    kind = "local" if data.get("kind") == "local" else "ptero"
    if kind == "local":
        if not has_perm("system"):
            raise ApiError("フォルダでつなぐサーバーは、「パネル全体の設定」の権限がある人だけが追加できます", 403)
        root = _local_root(data.get("root_dir"))
        if conn.execute("SELECT 1 FROM servers WHERE kind='local' AND root_dir=?", (root,)).fetchone():
            raise ApiError("このフォルダのサーバーはすでに追加されています")
        ident = "local-" + uuid.uuid4().hex[:16]
    else:
        root = ""
        ident = str(data.get("identifier") or "").strip()
        if not ident:
            raise ApiError("サーバーを選んでください")
        ex = conn.execute("SELECT owner_id FROM servers WHERE identifier=?", (ident,)).fetchone()
        if ex:
            who = conn.execute("SELECT username FROM users WHERE id=?", (ex[0],)).fetchone()
            raise ApiError(f"このサーバーはすでに「{who[0] if who else '?'}」さんが連携しています(使いたい場合は共有してもらってください)")
    software = data.get("software") if data.get("software") in SERVER_SOFTWARE else ""
    dirs = _clean_dirs(data.get("dirs"))
    if not dirs and data.get("plugin_dir"):
        dirs = {"plugin": _clean_rel_dir(data["plugin_dir"])}
    dirs = dirs or default_dirs(software)
    set_id = int(data["set_id"]) if data.get("set_id") else None
    if set_id and not conn.execute("SELECT 1 FROM sets WHERE id=? AND owner_id=?", (set_id, current_user()["id"])).fetchone():
        set_id = None
    name = str(data.get("name") or "").strip()[:80] or (Path(root).name if root else ident)
    jar = Path(str(data.get("jar") or "")).name if kind == "local" else ""
    if jar and not (Path(root) / jar).is_file():
        jar = ""
    mc = str(data.get("mc_version") or "").strip()
    mc = mc if re.fullmatch(r"\d+\.\d+(\.\d+)?", mc) and software not in _SOFT_PROXY else ""
    with LOCK:
        conn.execute("INSERT INTO servers (identifier, name, plugin_dir, set_id, created_at, owner_id, kind, root_dir, software, dirs, mc_version, server_jar) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (ident, name, "/" + (dirs.get("plugin") or dirs.get("mod") or "plugins"), set_id, utcnow(),
                      current_user()["id"], kind, root, software, json.dumps(dirs), mc, jar))
        conn.commit()
    audit("サーバーを追加", name, "フォルダ" if kind == "local" else "Pterodactyl")
    return jsonify(ok=True)


@app.post("/api/servers/detect")
@require("editor")
def api_servers_detect():
    """サーバーのフォルダを見て、サーバーソフトと種類ごとのフォルダを推測する。"""
    data = request.get_json(silent=True) or {}
    if data.get("server_id"):
        fs = server_fs(_server_row(int(data["server_id"]), "edit"))
    elif data.get("kind") == "local":
        if not has_perm("system"):
            raise ApiError("フォルダでつなぐサーバーは、「パネル全体の設定」の権限がある人だけが扱えます", 403)
        fs = _LocalFiles(_local_root(data.get("root_dir")))
    else:
        fs = _PteroFiles(str(data.get("identifier") or ""))
    jar = Path(str(data.get("jar") or "")).name or None
    return jsonify(detect_server(fs, jar))


@app.get("/api/fs/browse")
@require("editor")
def api_fs_browse():
    """このパネルから見えるフォルダをたどる(フォルダのサーバーを選ぶため。名前だけを返し、中身は読まない)。"""
    if not has_perm("system"):
        raise ApiError("フォルダの一覧は、「パネル全体の設定」の権限がある人だけが見られます", 403)
    p = str(request.args.get("path") or "").strip()
    if not p:  # はじめの場所: ドライブ・ホーム・よく使う場所・登録済みのサーバー
        starts = []
        if os.name == "nt":
            starts += [f"{c}:\\" for c in "CDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.isdir(f"{c}:\\")]
        else:
            starts.append("/")
        for d in (str(Path.home()), "/servers", "/srv", "/mnt", "/opt", "/home", "/data", "/minecraft"):
            if os.path.isdir(d) and d not in starts:
                starts.append(d)
        for r in db().execute("SELECT DISTINCT root_dir FROM servers WHERE kind='local' AND root_dir<>''"):
            parent = str(Path(r[0]).parent)
            if os.path.isdir(parent) and parent not in starts:
                starts.append(parent)
        return jsonify(path="", parent="", starts=starts, dirs=[], jars=[], is_server=False)
    try:
        path = Path(p).resolve()
        if not path.is_dir():
            raise ApiError("フォルダが見つかりません")
        dirs, jars = [], []
        for e in sorted(path.iterdir(), key=lambda x: x.name.lower()):
            if len(dirs) + len(jars) >= 800:
                break
            try:
                if e.is_dir():
                    dirs.append({"name": e.name, "server": (e / "server.properties").is_file()})
                elif e.is_file() and e.name.lower().endswith(".jar"):
                    jars.append({"name": e.name, "size": e.stat().st_size, "soft": _soft_from_jar(e.name)})
            except OSError:
                continue
    except PermissionError:
        raise ApiError("このフォルダは開けません(アクセス権がありません)")
    except OSError as e:
        raise ApiError(f"フォルダを開けません({e.strerror or e})")
    parent = str(path.parent) if path.parent != path else ""
    return jsonify(path=str(path), parent=parent, dirs=dirs, jars=jars, is_server=(path / "server.properties").is_file(),
                   starts=[])


def _server_row(srv, need="view"):
    """サーバーを取り出し、この利用者に必要な権限(view / edit / owner)があるか確かめる。"""
    r = db().execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    if not r:
        raise ApiError("サーバーが見つかりません", 404)
    if has_request_context() and current_user():
        return get_server_checked(srv, need)
    return r


@app.patch("/api/servers/<int:srv>")
@require("editor")
def api_servers_update(srv):
    _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    conn = db()
    with LOCK:
        if "name" in data:
            conn.execute("UPDATE servers SET name=? WHERE id=?", (str(data["name"] or "")[:80] or "server", srv))
        if "plugin_dir" in data and "dirs" not in data:
            conn.execute("UPDATE servers SET plugin_dir=?, dirs=? WHERE id=?",
                         (_clean_dir(data["plugin_dir"]), json.dumps({"plugin": _clean_rel_dir(data["plugin_dir"])}), srv))
            conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        if "software" in data:
            conn.execute("UPDATE servers SET software=? WHERE id=?",
                         (data["software"] if data["software"] in SERVER_SOFTWARE else "", srv))
        if "dirs" in data:
            dirs = _clean_dirs(data["dirs"])
            if not dirs:
                raise ApiError("管理するフォルダを 1 つ以上入力してください")
            conn.execute("UPDATE servers SET dirs=?, plugin_dir=? WHERE id=?",
                         (json.dumps(dirs), "/" + (dirs.get("plugin") or dirs.get("mod") or next(iter(dirs.values()))), srv))
            conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        for k, n in (("address", 120), ("mc_version", 20)):
            if k in data:
                v = str(data[k] or "").strip()[:n]
                if k == "address" and v:
                    try:
                        mcnet.parse_address(v)
                    except mcnet.NetError as e:
                        raise ApiError(e.message) from e
                if k == "mc_version" and v and not re.fullmatch(r"\d+\.\d+(\.\d+)?", v):
                    raise ApiError("MC のバージョンは 1.21.4 のように入力してください")
                conn.execute(f"UPDATE servers SET {k}=? WHERE id=?", (v, srv))
        if "server_jar" in data:
            conn.execute("UPDATE servers SET server_jar=? WHERE id=?", (Path(str(data["server_jar"] or "")).name[:200], srv))
        if "rcon_port" in data:
            conn.execute("UPDATE servers SET rcon_port=? WHERE id=?", (max(0, min(65535, int(data["rcon_port"] or 0))), srv))
        if data.get("rcon_password"):
            conn.execute("UPDATE servers SET rcon_password=? WHERE id=?", (encrypt_secret(str(data["rcon_password"])[:200]), srv))
        if data.get("rcon_clear"):
            conn.execute("UPDATE servers SET rcon_password='', rcon_port=0 WHERE id=?", (srv,))
        if "auto_update" in data:
            if data["auto_update"] not in ("off", "auto"):
                raise ApiError("自動更新の指定が不正です")
            conn.execute("UPDATE servers SET auto_update=? WHERE id=?", (data["auto_update"], srv))
        if "backup_config" in data:
            conn.execute("UPDATE servers SET backup_config=? WHERE id=?", (1 if _truthy(data["backup_config"]) else 0, srv))
        if "world_mode" in data:
            if data["world_mode"] not in ("off", "daily", "weekly"):
                raise ApiError("ワールドのバックアップの指定が不正です")
            conn.execute("UPDATE servers SET world_mode=? WHERE id=?", (data["world_mode"], srv))
        if "world_time" in data:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(data["world_time"])):
                raise ApiError("時刻は 05:00 のように入力してください")
            conn.execute("UPDATE servers SET world_time=? WHERE id=?", (data["world_time"], srv))
        if "world_dow" in data:
            conn.execute("UPDATE servers SET world_dow=? WHERE id=?", (max(0, min(6, int(data["world_dow"]))), srv))
        if "world_keep" in data:
            conn.execute("UPDATE servers SET world_keep=? WHERE id=?", (max(1, min(50, int(data["world_keep"] or 5))), srv))
        if "stage_targets" in data:
            ids = []
            for x in data["stage_targets"] or []:
                x = int(x)
                if x != srv:
                    get_server_checked(x, "edit")  # 反映先も操作できるサーバーだけ
                    ids.append(x)
            conn.execute("UPDATE servers SET stage_targets=? WHERE id=?", (json.dumps(sorted(set(ids))), srv))
        if any(k in data for k in ("control", "start_cmd", "stop_cmd", "container")):
            row = conn.execute("SELECT kind FROM servers WHERE id=?", (srv,)).fetchone()
            if row["kind"] != "local":
                raise ApiError("起動・停止の方法は、フォルダのサーバーだけで設定できます")
            if not has_perm("system"):
                raise ApiError("起動・停止の方法は、「パネル全体の設定」の権限がある人だけが設定できます", 403)
            if "control" in data:
                if data["control"] not in ("none", "command", "docker"):
                    raise ApiError("起動・停止の方法の指定が不正です")
                conn.execute("UPDATE servers SET control=? WHERE id=?", (data["control"], srv))
            for k in ("start_cmd", "stop_cmd"):
                if k in data:
                    conn.execute(f"UPDATE servers SET {k}=? WHERE id=?", (str(data[k] or "").strip()[:500], srv))
            if "container" in data:
                c = str(data["container"] or "").strip()
                if c and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", c):
                    raise ApiError("コンテナ名が正しくありません")
                conn.execute("UPDATE servers SET container=? WHERE id=?", (c, srv))
        if "root_dir" in data:
            row = conn.execute("SELECT kind FROM servers WHERE id=?", (srv,)).fetchone()
            if row["kind"] == "local":
                if not has_perm("system"):
                    raise ApiError("サーバーのフォルダは、「パネル全体の設定」の権限がある人だけが変更できます", 403)
                conn.execute("UPDATE servers SET root_dir=? WHERE id=?", (_local_root(data["root_dir"]), srv))
                conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        if "set_id" in data:
            sid = int(data["set_id"]) if data["set_id"] else None
            if sid and not conn.execute("SELECT 1 FROM sets WHERE id=? AND owner_id=?", (sid, current_user()["id"])).fetchone():
                raise ApiError("自分のセットを選んでください")
            conn.execute("UPDATE servers SET set_id=? WHERE id=?", (sid, srv))
        if "sched_mode" in data:
            if data["sched_mode"] not in ("off", "daily", "weekly"):
                raise ApiError("予約の指定が不正です")
            conn.execute("UPDATE servers SET sched_mode=? WHERE id=?", (data["sched_mode"], srv))
        if "sched_time" in data:
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(data["sched_time"])):
                raise ApiError("時刻は 04:00 のように入力してください")
            conn.execute("UPDATE servers SET sched_time=? WHERE id=?", (data["sched_time"], srv))
        if "sched_dow" in data:
            conn.execute("UPDATE servers SET sched_dow=? WHERE id=?", (max(0, min(6, int(data["sched_dow"]))), srv))
        if "sched_restart" in data:
            conn.execute("UPDATE servers SET sched_restart=? WHERE id=?", (1 if _truthy(data["sched_restart"]) else 0, srv))
        conn.commit()
    return jsonify(ok=True)


@app.delete("/api/servers/<int:srv>")
@require("editor")
def api_servers_delete(srv):
    _server_row(srv, "owner")
    conn = db()
    with LOCK:
        conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM server_acl WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM server_holds WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM server_file_history WHERE server_id=?", (srv,))
        conn.execute("DELETE FROM servers WHERE id=?", (srv,))
        conn.commit()
    return jsonify(ok=True)


def server_inventory(conn, srv_row, target, note=lambda m: None, fs=None):
    """サーバーの各フォルダ(プラグイン・Mod・データパック)の中身を、ライブラリと照らし合わせる。

    戻り値は (ファイルの一覧, セットにあってサーバーに無いもの, 見つからなかったフォルダの種類)。
    """
    fs = fs or server_fs(srv_row)
    dirs = server_dirs(srv_row)
    files, absent = [], []
    for cat, d in dirs.items():
        lst = fs.list(d)
        if lst is None:
            absent.append(cat)
            continue
        for f in lst:
            low = f["name"].lower()
            if f["is_file"] and low.endswith((".jar", ".zip", ".jar.disabled", ".zip.disabled")) and not f["name"].startswith("."):
                files.append({**f, "category": cat, "dir": d, "path": f"{d}/{f['name']}", "disabled": low.endswith(".disabled")})
    cache = {r["name"]: r for r in conn.execute("SELECT * FROM server_files WHERE server_id=?", (srv_row["id"],))}
    # 照らし合わせるのは、サーバーの持ち主のライブラリ(自分のもの + 共有されたもの)だけ。
    # ほかの人の非公開のアドオンが、同期でこのサーバーに入ってしまわないように
    vis = visible_item_ids(conn, {"id": srv_row["owner_id"]})
    by_sha = {}
    for v in conn.execute("SELECT * FROM versions WHERE target_id=?", (target["id"],)):
        if v["item_id"] in vis:
            by_sha.setdefault(v["sha256"], v)
    items = {r["id"]: r for r in conn.execute("SELECT * FROM items WHERE target_id=?", (target["id"],)) if r["id"] in vis}
    by_key = {}
    for it in items.values():
        by_key.setdefault((it["category"], norm_key(it["name"])), it)
    holds = _holds(conn, srv_row["id"])
    out = []
    for f in files:
        c = cache.get(f["path"])
        if c and c["size"] == f["size"] and c["modified"] == f["modified"] and c["sha256"]:
            sha, pname, pver = c["sha256"], c["plugin_name"], c["version"]
        else:
            note(f"サーバーのファイルを確認しています: {f['path']}")
            tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
            try:
                fs.download(f["path"], tmp)
                sha = sha256_file(tmp)
                info = analyze(tmp, f["name"][:-9] if f["disabled"] else f["name"])
                pname, pver = info["name"], info["version"]
            finally:
                tmp.unlink(missing_ok=True)
            with LOCK:
                conn.execute("INSERT OR REPLACE INTO server_files (server_id, name, size, modified, sha256, plugin_name, version) "
                             "VALUES (?,?,?,?,?,?,?)", (srv_row["id"], f["path"], f["size"], f["modified"], sha, pname, pver))
                conn.commit()
        entry = {"name": f["name"], "path": f["path"], "dir": f["dir"], "category": f["category"], "size": f["size"],
                 "disabled": f["disabled"], "held": False, "compat": None, "compat_now": None,
                 "modified": f["modified"], "plugin_name": pname, "version": pver, "status": "unregistered",
                 "item_id": None, "item_name": None, "latest_version": None, "latest_version_id": None}
        v = by_sha.get(sha)
        item = items.get(v["item_id"]) if v else by_key.get((f["category"], norm_key(pname)))
        if item:
            vs = _item_versions(conn, item["id"])
            entry.update(item_id=item["id"], item_name=item["name"],
                         latest_version=vs[0]["version"] if vs else None, latest_version_id=vs[0]["id"] if vs else None)
            if v and vs and v["id"] == vs[0]["id"]:
                entry["status"] = "latest"
            elif v:
                entry["status"] = "outdated"
            elif vs and src.same_version(vs[0]["version"], pver):
                entry["status"] = "latest"  # 中身のハッシュは違うが、ライブラリの最新と同じバージョン
            else:
                newer = vs and version_key(vs[0]["version"]) > version_key(pver or "")
                older = vs and pver and version_key(pver) > version_key(vs[0]["version"])
                entry["status"] = "outdated" if newer else "newer" if older else "different"
            entry["version_id"] = v["id"] if v else None
            entry["held"] = item["id"] in holds
            if vs:
                entry["compat"] = _compat(conn, srv_row, item, vs[0])
                entry["compat_mc"] = _version_mc(conn, item, vs[0])
            if f["disabled"]:
                entry["status"] = "disabled"
        elif f["disabled"]:
            entry["status"] = "disabled"
        out.append(entry)
    with LOCK:
        paths = [f["path"] for f in files]
        conn.execute(f"DELETE FROM server_files WHERE server_id=? AND name NOT IN ({','.join('?' * len(paths)) or 'NULL'})",
                     [srv_row["id"]] + paths)
        conn.commit()
    missing = []
    if srv_row["set_id"]:
        present = {e["item_id"] for e in out if e["item_id"]}
        for item, ver in resolve_set_versions(conn, srv_row["set_id"]):
            if item["id"] not in present:
                missing.append({"item_id": item["id"], "item_name": item["name"], "version": ver["version"],
                                "version_id": ver["id"], "category": item["category"], "no_dir": item["category"] not in dirs,
                                "compat": _compat(conn, srv_row, item, ver), "held": item["id"] in holds})
    return out, missing, absent


@app.get("/api/servers/presence")
def api_servers_presence():
    """各アイテムがどのサーバーに入っているか(最後に確認したときの内容から)。"""
    conn = db()
    servers = visible_servers(conn)
    states, items = _cached_states(conn, servers)
    out, listed = {}, []
    for srv in servers:
        rows = states.get(srv["id"], [])
        listed.append({"id": srv["id"], "name": srv["name"], "checked": bool(rows)})
        present = set()
        for f, _cat, iid, status in rows:
            if not iid:
                continue
            present.add(iid)
            out.setdefault(iid, []).append({"server_id": srv["id"], "server": srv["name"], "status": status, "version": f["version"]})
        if srv["set_id"] and rows:
            for r in conn.execute("SELECT item_id FROM set_items WHERE set_id=?", (srv["set_id"],)):
                if r[0] in items and r[0] not in present:
                    out.setdefault(r[0], []).append({"server_id": srv["id"], "server": srv["name"], "status": "missing", "version": ""})
    return jsonify(items=out, servers=listed)


@app.get("/api/servers/<int:srv>/inventory")
@require("editor")
def api_servers_inventory(srv):
    row = _server_row(srv, "view")
    _store, target = active_store()
    files, missing, absent = server_inventory(db(), row, target)
    return jsonify(files=files, missing=missing, absent=absent, dirs=server_dirs(row), kind=row["kind"],
                   plugin_dir=row["plugin_dir"], mc_version=row["mc_version"])


def _push_versions(job, conn, srv_row, store, pairs, inventory, title="", fs=None, remove=()):
    """(item, version) をサーバーの種類ごとのフォルダへ送り、同じアイテムの別のバージョンがあれば消す。

    置き換え・削除するファイルは先に取り出して退避し、あとで巻き戻せるようにする。
    """
    fs = fs or server_fs(srv_row)
    dirs = server_dirs(srv_row)
    on_server = {e["path"] for e in inventory}
    snap = {"id": None, "removed": [], "added": []}

    def open_snap():
        if snap["id"] is None:
            with LOCK:
                cur = conn.execute("INSERT INTO server_snapshots (server_id, created_at, title) VALUES (?,?,?)",
                                   (srv_row["id"], utcnow(), title))
                conn.commit()
            snap["id"] = cur.lastrowid
            (SNAP_DIR / str(snap["id"])).mkdir(parents=True, exist_ok=True)

    def keep(path):
        open_snap()
        if any(r["name"] == path for r in snap["removed"]):
            return
        stored = f"{len(snap['removed'])}-{safe_name(path.rsplit('/', 1)[-1], 'file', 150)}"
        fs.download(path, SNAP_DIR / str(snap["id"]) / stored)
        snap["removed"].append({"name": path, "stored": stored})

    plugin_dirs = None

    def keep_config(entry):
        """プラグインの設定フォルダ(plugins/<名前>/)も退避しておく。巻き戻しで設定まで戻せるように。"""
        nonlocal plugin_dirs
        if not srv_row["backup_config"] or entry["category"] != "plugin":
            return
        if plugin_dirs is None:
            plugin_dirs = {e["name"].lower(): e["name"] for e in (fs.list(entry["dir"]) or []) if not e["is_file"]}
        folder = plugin_dirs.get(str(entry.get("plugin_name") or "").lower())
        rel = f"{entry['dir']}/{folder}/" if folder else ""
        if not folder or any(r["name"] == rel for r in snap["removed"]):
            return
        open_snap()
        stored = f"{len(snap['removed'])}-cfg-{safe_name(folder, 'config', 120)}"
        try:
            ext = fs.archive(entry["dir"], [folder], SNAP_DIR / str(snap["id"]) / (stored + ".part"))
            os.replace(SNAP_DIR / str(snap["id"]) / (stored + ".part"), SNAP_DIR / str(snap["id"]) / (stored + ext))
            snap["removed"].append({"name": rel, "stored": stored + ext, "dir": True, "ext": ext})
            job.note(f"設定フォルダを退避しました: {rel}")
        except ApiError as e:
            job.note(f"設定フォルダを退避できませんでした({folder}): {e.message}")

    sent = 0
    for item, v in pairs:
        job.done += 1
        d = dirs.get(item["category"])
        if not d:
            job.note(f"送れません({CATEGORIES.get(item['category'], ('', item['category']))[1]}のフォルダが設定されていません): {item['name']}")
            continue
        old = [e for e in inventory if e["item_id"] == item["id"]]
        if any(e.get("version_id") == v["id"] for e in old):
            job.note(f"送信不要(同じファイルがあります): {item['name']} {v['version']}")
            continue
        dest = f"{d}/{v['filename']}"
        # 先にライブラリから取り出す。無ければこのアドオンだけ飛ばし、サーバーには手を付けない
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            store.fetch(lib_rel(v["relpath"]), tmp)
        except (StorageError, OSError):
            tmp.unlink(missing_ok=True)
            job.note(f"送れません(ライブラリにファイルが見つかりません): {item['name']} {v['version']}。保存先を確認してください")
            continue
        try:
            for e in old:
                keep(e["path"])
                keep_config(e)
            if dest in on_server:
                keep(dest)  # 同じ名前のファイルを上書きする場合も退避
            open_snap()
            fs.upload(d, tmp, v["filename"])
        finally:
            tmp.unlink(missing_ok=True)
        snap["added"].append(dest)
        stale = [e for e in old if e["path"] != dest]
        for sd in {e["dir"] for e in stale}:
            fs.delete(sd, [e["name"] for e in stale if e["dir"] == sd])
        sent += 1
        job.note(f"送信しました: {item['name']} {v['version']}" + (f"(古いファイルを削除: {', '.join(e['name'] for e in stale)})" if stale else ""))
    for e in remove:  # コピー(そろえる)で、元のサーバーに無いものを取り除く
        keep(e["path"])
        keep_config(e)
        fs.delete(e["dir"], [e["name"]])
        sent += 1
        job.note(f"取り除きました: {e.get('item_name') or e['name']}")
    with LOCK:
        if snap["id"] is not None:
            conn.execute("UPDATE server_snapshots SET removed=?, added=? WHERE id=?",
                         (json.dumps(snap["removed"], ensure_ascii=False), json.dumps(snap["added"], ensure_ascii=False), snap["id"]))
        conn.execute("DELETE FROM server_files WHERE server_id=?", (srv_row["id"],))
        conn.execute("UPDATE servers SET last_sync=? WHERE id=?", (utcnow(), srv_row["id"]))
        conn.commit()
    if snap["id"] is not None:
        prune_snapshots(conn, srv_row["id"])
    return sent


def _server_job(job, srv, target_id, mode, item_ids, version_ids, restart, user, force=False):
    conn = db()
    srv_row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    fs = server_fs(srv_row)
    job.note(f"「{srv_row['name']}」の {', '.join(server_dirs(srv_row).values())} を確認しています…")
    inventory, missing, absent = server_inventory(conn, srv_row, target, note=job.note, fs=fs)
    for cat in absent:
        job.note(f"{CATEGORIES[cat][1]}のフォルダ({server_dirs(srv_row)[cat]})が見つかりません。送るときに作ります")
    holds = _holds(conn, srv)
    pairs = []

    def add(item, v):
        if not force and item["id"] in holds:
            job.note(f"見送り中のため入れません: {item['name']}")
            return
        if not force and _compat(conn, srv_row, item, v) is False:
            job.note(f"MC {srv_row['mc_version']} に対応していないため入れません: {item['name']} {v['version']}"
                     f"(対応: {_version_mc(conn, item, v)})")
            return
        pairs.append((item, v))
    if mode == "sync":
        chosen = {i["id"]: v for i, v in resolve_set_versions(conn, srv_row["set_id"])} if srv_row["set_id"] else {}
        for e in inventory:
            if e["status"] == "outdated" and e["latest_version_id"]:
                item = conn.execute("SELECT * FROM items WHERE id=?", (e["item_id"],)).fetchone()
                v = chosen.get(item["id"]) or conn.execute("SELECT * FROM versions WHERE id=?", (e["latest_version_id"],)).fetchone()
                add(item, v)
        for m in missing:
            if not m["no_dir"]:
                add(conn.execute("SELECT * FROM items WHERE id=?", (m["item_id"],)).fetchone(),
                    conn.execute("SELECT * FROM versions WHERE id=?", (m["version_id"],)).fetchone())
    else:
        vmap = {int(k): int(v) for k, v in (version_ids or {}).items() if v}
        for iid in item_ids:
            item = conn.execute("SELECT * FROM items WHERE id=? AND target_id=?", (iid, target_id)).fetchone()
            if not item:
                continue
            v = conn.execute("SELECT * FROM versions WHERE id=? AND item_id=?", (vmap[iid], iid)).fetchone() if iid in vmap else None
            v = v or (_item_versions(conn, iid) or [None])[0]
            if v:
                add(item, v)
    job.total = len(pairs)
    if not pairs:
        job.note("送信するものはありません(すべて最新です)")
    sent = _push_versions(job, conn, srv_row, store, pairs, inventory, title=job.title, fs=fs)
    if restart and sent and (srv_row["kind"] == "ptero" or srv_row["control"] in ("command", "docker")):
        server_power(srv_row, "restart")
        job.note("サーバーを再起動しました")
    job.result = {"sent": sent}
    label = "同期" if mode == "sync" else "転送"
    job.note(f"完了: {sent} 件を{label}しました")
    audit(f"サーバーへの{label}が完了", srv_row["name"], f"{sent} 件" + ("・再起動" if restart and sent else ""), user=user)
    if sent:
        notify_event("servers", f"{srv_row['name']} に{label}しました",
                     [f"・{i['name']} {v['version']}" for i, v in pairs][:30] + (["サーバーを再起動しました"] if restart else []))


@app.post("/api/servers/<int:srv>/sync")
@require("editor")
def api_servers_sync(srv):
    row = _server_row(srv, "edit")
    _store, target = active_store()
    data = request.get_json(silent=True) or {}
    job = start_job(f"server-{srv}", f"「{row['name']}」を同期", _server_job, srv, target["id"], "sync", [], {},
                    _truthy(data.get("restart")), current_user()["username"], user=current_user()["username"], queue=True)
    return jsonify(job.public())


@app.post("/api/servers/<int:srv>/push")
@require("editor")
def api_servers_push(srv):
    row = _server_row(srv, "edit")
    _store, target = active_store()
    data = request.get_json(silent=True) or {}
    item_ids = [int(x) for x in data.get("item_ids") or []]
    version_ids = {int(k): int(v) for k, v in (data.get("version_ids") or {}).items() if v}
    if data.get("set_id"):
        conn = db()
        s = conn.execute("SELECT * FROM sets WHERE id=? AND target_id=? AND owner_id=?",
                         (int(data["set_id"]), target["id"], current_user()["id"])).fetchone()
        if not s:
            raise ApiError("セットが見つかりません", 404)
        for i, v in resolve_set_versions(conn, s["id"]):
            item_ids.append(i["id"])
            version_ids[i["id"]] = v["id"]
    vis = visible_item_ids(db())
    item_ids = [i for i in item_ids if i in vis]
    if not item_ids:
        raise ApiError("送るものを選んでください")
    job = start_job(f"server-{srv}", f"「{row['name']}」へ転送", _server_job, srv, target["id"], "push",
                    item_ids, version_ids, _truthy(data.get("restart")), current_user()["username"], _truthy(data.get("force")),
                    user=current_user()["username"], queue=True)
    return jsonify(job.public())


def deps_plan(conn, srv_row, item_ids, user):
    """選んだアドオンを入れるのに要る前提(前提の前提も)を調べる。
    サーバーにすでにあるものは除き、ライブラリにあるものは一緒に入れる候補に、無いものは「足りない」にする。"""
    store, target = active_store()
    items = {it["id"]: it for it in build_library(conn, store, target, user)}
    on_server = set()
    for r in conn.execute("SELECT name, plugin_name FROM server_files WHERE server_id=?", (srv_row["id"],)):
        if r["plugin_name"]:
            on_server.add(norm_key(r["plugin_name"]))
        on_server.add(norm_key(re.split(r"[-_ ]\d", Path(r["name"]).stem)[0]))
    picked = [i for i in item_ids if i in items]
    seen, add, missing, present = set(picked), [], {}, set()
    queue = list(picked)
    while queue:
        it = items[queue.pop(0)]
        for d in it.get("dep_status") or []:
            if not d["required"]:
                continue
            dep = items.get(d["item_id"]) if d["item_id"] else None
            keys = {norm_key(d["name"])} | set((dep or {}).get("dep_key") or [])
            if keys & on_server:
                present.add(d["name"])
            elif dep:
                if dep["id"] not in seen:
                    seen.add(dep["id"])
                    add.append({"id": dep["id"], "name": dep["name"], "for": it["name"]})
                    queue.append(dep["id"])
            else:
                missing.setdefault(d["name"], it["name"])
    return {"add": add, "missing": [{"name": k, "for": v} for k, v in missing.items()], "present": sorted(present)}


@app.post("/api/servers/<int:srv>/deps-plan")
@require("editor")
def api_servers_deps_plan(srv):
    row = _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    try:
        ids = [int(x) for x in data.get("item_ids") or []]
    except (TypeError, ValueError):
        raise ApiError("数値で指定してください")
    return jsonify(deps_plan(db(), row, ids, current_user()))


def _server_import_job(job, srv, target_id, names, user):
    conn = db()
    srv_row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    fs = server_fs(srv_row)
    dirs = set(server_dirs(srv_row).values())
    job.total = len(names)
    added = 0
    for path in names:
        job.done += 1
        d, _sep, n = path.rpartition("/")
        if d not in dirs or not n or n.startswith("."):  # 01.16 より前の画面はファイル名だけを送る
            if "/" in path or len(dirs) != 1:
                continue
            d, n = next(iter(dirs)), path
        tmp = TMP_DIR / (uuid.uuid4().hex + ".part")
        try:
            fs.download(f"{d}/{n}", tmp)
            r = ingest(tmp, n, store=store, target=target, owner_id=_uid_of(user))
            added += r.get("status") == "added"
            job.note(f"{'取り込みました' if r.get('status') == 'added' else '登録済みです'}: {r.get('name')} {r.get('version', '')}")
        except Exception as e:  # noqa: BLE001
            job.note(f"失敗: {n}: {getattr(e, 'message', e)}")
        finally:
            tmp.unlink(missing_ok=True)
    job.result = {"added": added}
    audit("サーバーから取り込みが完了", srv_row["name"], f"{added} 件", user=user)


@app.post("/api/servers/<int:srv>/import")
@require("editor")
def api_servers_import(srv):
    row = _server_row(srv, "edit")
    _store, target = active_store()
    names = [str(x) for x in (request.get_json(silent=True) or {}).get("names") or []][:200]
    if not names:
        raise ApiError("取り込むファイルを選んでください")
    job = start_job(f"server-{srv}", f"「{row['name']}」から取り込み", _server_import_job, srv, target["id"], names,
                    current_user()["username"], user=current_user()["username"], queue=True)
    return jsonify(job.public())


def _server_remove_job(job, srv, target_id, paths, user):
    """サーバーからファイルを取り除く(先に退避するので「履歴」から戻せる)。"""
    conn = db()
    row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    fs = server_fs(row)
    inv, _m, _a = server_inventory(conn, row, target, note=job.note, fs=fs)
    entries = [e for e in inv if e["path"] in paths]
    job.total = len(entries)
    if not entries:
        job.note("取り除くファイルが見つかりません(すでに無いかもしれません)")
    n = _push_versions(job, conn, row, open_store(target), [], inv, title=job.title, fs=fs, remove=entries)
    job.result = {"removed": n}
    audit("サーバーからアドオンを削除", row["name"], ", ".join(e["name"] for e in entries)[:300], user=user)


@app.post("/api/servers/<int:srv>/remove")
@require("editor")
def api_servers_remove(srv):
    row = _server_row(srv, "edit")
    paths = [str(x) for x in (request.get_json(silent=True) or {}).get("paths") or []][:100]
    dirs = set(server_dirs(row).values())
    paths = [p for p in paths if p.rpartition("/")[0] in dirs and p.rpartition("/")[2] and not p.rpartition("/")[2].startswith(".")]
    if not paths:
        raise ApiError("削除するファイルを選んでください")
    _store, target = active_store()
    job = start_job(f"server-{srv}", f"「{row['name']}」から削除", _server_remove_job, srv, target["id"], paths,
                    current_user()["username"], user=current_user()["username"], queue=True)
    return jsonify(job.public())


@app.post("/api/servers/<int:srv>/power")
@require("editor")
def api_servers_power(srv):
    row = _server_row(srv, "edit")
    signal = str((request.get_json(silent=True) or {}).get("signal") or "")
    if row["kind"] == "local" and row["control"] == "command":  # 止まるのを待つので、処理として動かす
        job = start_job(f"power-{srv}", f"「{row['name']}」の{ {'start': '起動', 'stop': '停止', 'restart': '再起動'}.get(signal, signal) }",
                        lambda job: server_power(row, signal), user=current_user()["username"])
        audit("サーバーを操作", row["name"], signal)
        return jsonify(ok=True, job=job.public())
    server_power(row, signal)
    audit("サーバーを操作", row["name"], signal)
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# コンソール(RCON・Pterodactyl でコマンドを送る)と、最近のログ
# --------------------------------------------------------------------------
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b-\x1f\x7f]")
LOG_FILE = "logs/latest.log"


def server_log_tail(row, lines=200):
    raw = server_fs(row).tail(LOG_FILE, 256 * 1024)
    if raw is None:
        return None
    text = _ANSI.sub("", raw.decode("utf-8", "replace").replace("\r\n", "\n"))
    out = text.split("\n")
    if len(raw) >= 256 * 1024:  # 途中から読んだので、最初の欠けた行は捨てる
        out = out[1:]
    while out and not out[-1].strip():
        out.pop()
    return out[-lines:]


@app.get("/api/servers/<int:srv>/logs")
@require("editor")
def api_servers_logs(srv):
    row = _server_row(srv, "edit")
    try:
        n = max(20, min(1000, int(request.args.get("lines", 200))))
    except ValueError:
        raise ApiError("数値で指定してください")
    lines = server_log_tail(row, n)
    if lines is None:
        return jsonify(lines=[], found=False, file=LOG_FILE)
    return jsonify(lines=lines, found=True, file=LOG_FILE)


@app.post("/api/servers/<int:srv>/console")
@require("editor")
def api_servers_console(srv):
    row = _server_row(srv, "edit")
    cmd = str((request.get_json(silent=True) or {}).get("command") or "").strip()
    if cmd.startswith("/"):
        cmd = cmd[1:].strip()
    if not cmd:
        raise ApiError("コマンドを入力してください")
    if len(cmd) > 1000 or "\n" in cmd or "\r" in cmd:
        raise ApiError("コマンドは 1 行・1000 文字までです")
    rc = _rcon(row)
    if rc:
        try:
            with rc as r:
                output = _ANSI.sub("", re.sub(r"§.", "", r.command(cmd) or ""))
        except mcnet.NetError as e:
            raise ApiError(f"RCON: {e.message}") from e
        audit("コンソールでコマンドを実行", row["name"], cmd[:300])
        return jsonify(ok=True, via="rcon", output=output)
    if row["kind"] == "ptero":
        _pcall(server_fs(row).p.command, row["identifier"], cmd)
        audit("コンソールでコマンドを実行", row["name"], cmd[:300])
        return jsonify(ok=True, via="ptero", output=None)
    raise ApiError("コマンドを送るには、サーバーの設定で RCON(ポートとパスワード)を設定してください")


# --------------------------------------------------------------------------
# 設定ファイルの編集(server.properties・プラグインの config.yml など。保存の前の内容を残す)
# --------------------------------------------------------------------------
EDIT_EXTS = {".properties", ".yml", ".yaml", ".json", ".json5", ".toml", ".txt", ".conf", ".cfg", ".ini", ".mcmeta", ".lang", ".sk"}
EDIT_LIMIT = 512 * 1024
FILE_HISTORY_KEEP = 20


def _edit_path(raw, allow_dir=False):
    """利用者が指定した場所を、サーバーのフォルダの中の相対パスにそろえる(外へ出る指定は断る)。"""
    import posixpath
    p = str(raw or "").replace("\\", "/").strip().strip("/")
    if "\x00" in p or any(part in ("..", ".") for part in p.split("/") if part):
        raise ApiError("場所の指定が不正です")
    p = posixpath.normpath(p) if p else ""
    if p == ".":
        p = ""
    if not allow_dir:
        if not p or Path(p).suffix.lower() not in EDIT_EXTS:
            raise ApiError("この種類のファイルはここでは編集できません")
    return p


def _hash(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


def check_syntax(path, text):
    """書式の誤りを探す。見つかれば「何行目: 内容」を返す(YAML はよくある誤り=字下げのタブだけを調べる)。"""
    ext = Path(path).suffix.lower()
    if ext == ".json":
        try:
            json.loads(text)
        except json.JSONDecodeError as e:
            return f"{e.lineno} 行目: JSON の書き方が正しくありません({e.msg})"
    elif ext == ".toml":
        try:
            import tomllib
            tomllib.loads(text)
        except ModuleNotFoundError:
            return None
        except Exception as e:  # noqa: BLE001
            return f"TOML の書き方が正しくありません({e})"
    elif ext in (".yml", ".yaml"):
        for i, line in enumerate(text.split("\n"), 1):
            lead = line[:len(line) - len(line.lstrip(" \t"))]
            if "\t" in lead:
                return f"{i} 行目: YAML の字下げにタブが使われています(スペースにしてください)"
    return None


@app.get("/api/servers/<int:srv>/files")
@require("editor")
def api_servers_files(srv):
    row = _server_row(srv, "edit")
    rel = _edit_path(request.args.get("dir"), allow_dir=True)
    entries = server_fs(row).list(rel)
    if entries is None:
        raise ApiError("フォルダが見つかりません", 404)
    out = []
    for e in entries:
        if e["name"].endswith(".craftshelf-part"):
            continue
        editable = e["is_file"] and Path(e["name"]).suffix.lower() in EDIT_EXTS and (e["size"] or 0) <= EDIT_LIMIT
        out.append({**e, "editable": editable})
    out.sort(key=lambda e: (e["is_file"], e["name"].lower()))
    return jsonify(dir=rel, entries=out)


@app.get("/api/servers/<int:srv>/file")
@require("editor")
def api_servers_file_get(srv):
    row = _server_row(srv, "edit")
    rel = _edit_path(request.args.get("path"))
    data = server_fs(row).read_bytes(rel, EDIT_LIMIT)
    if data is None:
        raise ApiError("ファイルが見つかりません", 404)
    if b"\x00" in data[:8192]:
        raise ApiError("文字のファイルではないため、ここでは編集できません")
    n = db().execute("SELECT COUNT(*) FROM server_file_history WHERE server_id=? AND path=?", (srv, rel)).fetchone()[0]
    return jsonify(path=rel, text=data.decode("utf-8", "replace"), hash=_hash(data), history=n)


@app.put("/api/servers/<int:srv>/file")
@require("editor")
def api_servers_file_put(srv):
    row = _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    rel = _edit_path(data.get("path"))
    text = data.get("text")
    if not isinstance(text, str):
        raise ApiError("内容がありません")
    new = text.encode("utf-8")
    if len(new) > EDIT_LIMIT:
        raise ApiError("内容が大きすぎます(512 KB まで)")
    if not data.get("force"):
        err = check_syntax(rel, text)
        if err:
            return jsonify(error=err, syntax=True), 422
    fs = server_fs(row)
    old = fs.read_bytes(rel, EDIT_LIMIT)
    if old is not None and data.get("hash") and _hash(old) != data["hash"]:
        return jsonify(error="開いたあとに、サーバー側でこのファイルが変わりました。読み込み直してから編集してください", conflict=True), 409
    user = current_user()["username"]
    conn = db()
    if old is not None and old != new:
        conn.execute("INSERT INTO server_file_history (server_id, path, saved_at, username, size, content) VALUES (?,?,?,?,?,?)",
                     (srv, rel, utcnow(), user, len(old), old))
        conn.execute("DELETE FROM server_file_history WHERE server_id=? AND path=? AND id NOT IN "
                     "(SELECT id FROM server_file_history WHERE server_id=? AND path=? ORDER BY id DESC LIMIT ?)",
                     (srv, rel, srv, rel, FILE_HISTORY_KEEP))
        conn.commit()
    if old != new:
        fs.write_bytes(rel, new)
        audit("設定ファイルを編集", row["name"], rel)
    return jsonify(ok=True, hash=_hash(new), changed=old != new)


@app.get("/api/servers/<int:srv>/file/history")
@require("editor")
def api_servers_file_history(srv):
    _server_row(srv, "edit")
    rel = _edit_path(request.args.get("path"))
    rows = db().execute("SELECT id, saved_at, username, size FROM server_file_history WHERE server_id=? AND path=? ORDER BY id DESC",
                        (srv, rel)).fetchall()
    return jsonify(entries=[dict(r) for r in rows])


@app.get("/api/servers/<int:srv>/file/history/<int:hid>")
@require("editor")
def api_servers_file_history_get(srv, hid):
    _server_row(srv, "edit")
    r = db().execute("SELECT path, saved_at, content FROM server_file_history WHERE id=? AND server_id=?", (hid, srv)).fetchone()
    if not r:
        raise ApiError("見つかりません", 404)
    return jsonify(path=r["path"], saved_at=r["saved_at"], text=bytes(r["content"]).decode("utf-8", "replace"))


@app.get("/api/servers/<int:srv>/status")
def api_servers_status(srv):
    row = _server_row(srv, "view")
    live = server_live(row)
    return jsonify(live)


# --------------------------------------------------------------------------
# 見送り・無効化・コピー(段階的な更新)・サーバー本体の更新・ワールドのバックアップ
# --------------------------------------------------------------------------
@app.post("/api/servers/<int:srv>/hold")
@require("editor")
def api_servers_hold(srv):
    """このアドオンの更新を、このサーバーでは見送る(同期・自動更新で入れ替えない)。"""
    _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    iid = int(data.get("item_id") or 0)
    conn = db()
    with LOCK:
        if _truthy(data.get("hold")):
            conn.execute("INSERT OR IGNORE INTO server_holds (server_id, item_id, created_at) VALUES (?,?,?)", (srv, iid, utcnow()))
        else:
            conn.execute("DELETE FROM server_holds WHERE server_id=? AND item_id=?", (srv, iid))
        conn.commit()
    return jsonify(ok=True)


@app.post("/api/servers/<int:srv>/toggle")
@require("editor")
def api_servers_toggle(srv):
    """ファイルを消さずに外す(名前の最後に .disabled を付ける)・元に戻す。"""
    row = _server_row(srv, "edit")
    data = request.get_json(silent=True) or {}
    d, _sep, name = str(data.get("path") or "").rpartition("/")
    if d not in server_dirs(row).values() or not name or name.startswith(".") or "/" in name:
        raise ApiError("ファイルの指定が不正です")
    enable = _truthy(data.get("enable"))
    if enable != name.lower().endswith(".disabled"):
        raise ApiError("すでにその状態です")
    to = name[:-9] if enable else name + ".disabled"
    server_fs(row).rename(d, name, to)
    with LOCK:
        db().execute("DELETE FROM server_files WHERE server_id=? AND name IN (?,?)", (srv, f"{d}/{name}", f"{d}/{to}"))
        db().commit()
    audit("サーバーのファイルを" + ("有効化" if enable else "無効化"), row["name"], to)
    return jsonify(ok=True, name=to)


def _copy_job(job, src_id, dst_ids, target_id, mode, user, uid=0):
    """src のサーバーの中身(ライブラリにあるもの)を、dst のサーバーにそろえる。

    mode: update = dst にあるものだけ src のバージョンに / add = src にあるものを入れる /
          mirror = add に加えて、src に無い登録済みのものを dst から取り除く
    """
    conn = db()
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (target_id,)).fetchone()
    store = open_store(target)
    src_row = conn.execute("SELECT * FROM servers WHERE id=?", (src_id,)).fetchone()
    job.note(f"「{src_row['name']}」の中身を確認しています…")
    src_inv, _m, _a = server_inventory(conn, src_row, target, note=job.note)
    want = {}
    vis = visible_item_ids(conn, {"id": uid}) if uid else None  # 操作した人に見えるアドオンだけ
    for e in src_inv:
        if not e["item_id"] or e["status"] == "disabled" or (vis is not None and e["item_id"] not in vis):
            continue
        vid = e.get("version_id")
        if not vid:
            job.note(f"ライブラリに同じファイルが無いため、そろえられません: {e['item_name']}({e['name']})")
            continue
        want[e["item_id"]] = vid
    total = 0
    for dst_id in dst_ids:
        dst = conn.execute("SELECT * FROM servers WHERE id=?", (dst_id,)).fetchone()
        if not dst:
            continue
        fs = server_fs(dst)
        job.note(f"「{dst['name']}」の中身を確認しています…")
        inv, _m, _a = server_inventory(conn, dst, target, note=job.note, fs=fs)
        on_dst = {e["item_id"] for e in inv if e["item_id"]}
        pairs = []
        for iid, vid in want.items():
            if mode == "update" and iid not in on_dst:
                continue
            item = conn.execute("SELECT * FROM items WHERE id=?", (iid,)).fetchone()
            v = conn.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
            if item and v:
                pairs.append((item, v))
        remove = [e for e in inv if mode == "mirror" and e["item_id"] and e["item_id"] not in want]
        job.total += len(pairs)
        sent = _push_versions(job, conn, dst, store, pairs, inv, title=job.title, fs=fs, remove=remove)
        total += sent
        job.note(f"「{dst['name']}」: {sent} 件を変更しました")
        if sent:
            notify_event("servers", f"{dst['name']} を {src_row['name']} にそろえました", [f"{sent} 件"])
    job.result = {"sent": total}
    audit("サーバーの中身をそろえた", src_row["name"], f"{len(dst_ids)} 台・{total} 件", user=user)


@app.post("/api/servers/<int:srv>/copy")
@require("editor")
def api_servers_copy(srv):
    """このサーバー(コピー元)の構成を、ほかのサーバーへそろえる(コピー・本番への反映)。"""
    row = _server_row(srv, "view")
    data = request.get_json(silent=True) or {}
    mode = data.get("mode") if data.get("mode") in ("update", "add", "mirror") else "update"
    dst = [int(x) for x in data.get("targets") or [] if int(x) != srv]
    if not dst:
        raise ApiError("そろえる先のサーバーを選んでください")
    for d in dst:
        get_server_checked(d, "edit")
    _store, target = active_store()
    job = start_job(f"copy-{srv}", f"「{row['name']}」の構成をそろえる", _copy_job, srv, dst, target["id"], mode,
                    current_user()["username"], current_user()["id"], user=current_user()["username"])
    return jsonify(job.public())


def server_software_info(row, force=False):
    """サーバー本体の今のビルドと、新しいビルドがあるか。結果は半日ほど覚えておく。"""
    info = _jl(row["soft_info"], {})
    fresh = info.get("checked_at") and not _due_iso(info["checked_at"], 12)
    if fresh and not force:
        return info
    soft = row["software"]
    try:
        fs = server_fs(row)
        mc, build = _detect_build(fs)
    except ApiError as e:
        return {**info, "error": e.message}
    mc = row["mc_version"] or mc
    inst = info.get("installed") or {}
    if inst.get("jar"):
        try:
            cur = next((e for e in (fs.list("") or []) if e["name"] == inst["jar"]), None)
        except ApiError:
            cur = None
        if cur and cur.get("size") == inst.get("size"):
            build = inst.get("build") or build
        else:
            inst = {}
    if soft == "vanilla":
        build = build or mc
    out = {"address": info.get("address", ""), "software": soft, "mc": mc, "build": build, "checked_at": utcnow(),
           "notified": info.get("notified", ""), "installed": inst, "jar": _server_jar(row, fs)}
    try:
        if soft and (mc or soft in NO_MC_SOFT):
            latest = mcnet.latest_build(soft, mc)
            if latest:
                out["latest"] = latest
                out["update"] = bool(build and latest["build"] and str(latest["build"]) != str(build)
                                     and (not build.isdigit() or not str(latest["build"]).isdigit() or int(latest["build"]) > int(build)))
                if soft == "vanilla":
                    out["update"] = False  # バニラはビルドが無い(MC のバージョンそのもの)
            newest = mcnet.newest_mc(soft)
            if newest and mc and _cmp_nums(_ver_nums(newest), _ver_nums(mc)) > 0:
                out["newer_mc"] = newest
    except mcnet.NetError as e:
        out["error"] = e.message
    with LOCK:
        db().execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(out), row["id"]))
        db().commit()
    return out


def _due_iso(iso, hours):
    try:
        t = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return True
    return datetime.now(timezone.utc) - t >= timedelta(hours=hours)


NO_MC_SOFT = ("velocity", "waterfall", "bungeecord", "fabric", "quilt", "arclight")
JAR_BACKUP_DIR = CONFIG_DIR / "server-jars"  # 入れ替える前の jar(サーバーごとに直近 3 つ)


def _server_jar(row, fs):
    """サーバー本体の jar の名前(設定で決めたもの → ソフトの名前が付いたもの → server.jar → 1 つだけの jar)。"""
    if row["server_jar"]:
        return row["server_jar"]
    try:
        jars = [e["name"] for e in (fs.list("") or []) if e["is_file"] and e["name"].lower().endswith(".jar")]
    except ApiError:
        return ""
    soft = row["software"] or ""
    hit = [n for n in jars if soft and _soft_from_jar(n) == soft]
    if len(hit) == 1:
        return hit[0]
    for n in ("server.jar", "paper.jar", "purpur.jar", "velocity.jar", "fabric-server-launch.jar"):
        if n in jars:
            return n
    return jars[0] if len(jars) == 1 else ""


def _software_job(job, srv, restart, user):
    conn = db()
    row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    fs = server_fs(row)
    info = server_software_info(row, force=True)
    latest = info.get("latest") or {}
    if not latest.get("auto") or not latest.get("url"):
        raise ApiError(f"{mcnet.SOFTWARE.get(row['software'], (row['software'] or '?',))[0]} は自動で入れ替えられません(配布元で確認してください)")
    jar = info.get("jar") or _server_jar(row, fs)
    if not jar:
        raise ApiError("サーバー本体の jar が分かりません(サーバーの「設定」で jar を指定してください)")
    tmp = TMP_DIR / f"server-{uuid.uuid4().hex}.jar"
    stopped = False
    try:
        job.note(f"{latest.get('file') or jar} を取得しています…")
        size = mcnet.download(latest["url"], tmp, latest.get("sha256") or "")
        backup_dir = JAR_BACKUP_DIR / str(srv)
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        try:
            fs.download(jar, backup_dir / f"{stamp}__{info.get('build') or 'old'}__{jar}")
            for old in sorted(backup_dir.iterdir())[:-3]:
                old.unlink(missing_ok=True)
            job.note(f"今の {jar} を退避しました")
        except ApiError:
            job.note(f"今の {jar} が見つからないため、退避せずに置きます")
        live = server_live(row) if restart else {}
        if restart and live.get("state") == "running" and live.get("controls"):
            job.note("サーバーを止めています…")
            server_power(row, "stop")
            if row["kind"] == "ptero" or row["control"] == "docker":  # コマンドで止める場合は server_power の中で待つ
                _wait_offline(row)
            stopped = True
        fs.upload("", tmp, jar)
        job.note(f"{jar} を {latest.get('build')} に入れ替えました")
        new = {**info, "installed": {"build": latest.get("build"), "jar": jar, "size": size, "at": utcnow()}, "build": latest.get("build"), "update": False}
        with LOCK:
            conn.execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(new), srv))
            conn.commit()
        audit("サーバー本体を更新", row["name"], f"{info.get('build') or '?'} → {latest.get('build')}", user=user)
        notify_event("servers", f"{row['name']} のサーバー本体を更新しました", [f"{info.get('build') or '?'} → {latest.get('build')}"])
    finally:
        tmp.unlink(missing_ok=True)
        if stopped:
            job.note("サーバーを起動しています…")
            try:
                server_power(row, "start")
            except ApiError as e:
                job.note(f"起動できませんでした: {e.message}")
    job.result = {"build": latest.get("build")}


@app.get("/api/servers/software")
def api_servers_software_all():
    """見られるサーバーすべての、サーバー本体の今のビルドと最新(refresh=1 で確かめ直す)。"""
    conn = db()
    force = _truthy(request.args.get("refresh"))
    out = []
    for row in visible_servers(conn):
        info = server_software_info(row, force=force)
        soft = row["software"] or ""
        out.append({"id": row["id"], "name": row["name"], "kind": row["kind"], "software": soft,
                    "software_name": mcnet.SOFTWARE.get(soft, (soft,))[0] if soft else "", "info": info,
                    "auto": bool((info.get("latest") or {}).get("auto")),
                    "backups": len(list((JAR_BACKUP_DIR / str(row["id"])).glob("*"))) if (JAR_BACKUP_DIR / str(row["id"])).exists() else 0})
    return jsonify(servers=out, supported={k: {"name": v[0], "auto": v[1]} for k, v in mcnet.SOFTWARE.items()})


@app.post("/api/servers/software/update")
@require("editor")
def api_servers_software_update():
    """選んだサーバーの本体を最新のビルドに入れ替える(サーバーごとの順番待ちの処理。restart で止めて入れ替えて起動)。"""
    data = request.get_json(silent=True) or {}
    try:
        ids = [int(x) for x in data.get("server_ids") or []]
    except (TypeError, ValueError):
        raise ApiError("数値で指定してください")
    if not ids:
        raise ApiError("サーバーを選んでください")
    jobs = []
    for srv in ids:
        row = _server_row(srv, "edit")
        j = start_job(f"server-{srv}", f"「{row['name']}」のサーバー本体を更新", _software_job, srv, _truthy(data.get("restart")),
                      current_user()["username"], user=current_user()["username"], queue=True)
        jobs.append(j.public())
    return jsonify(jobs=jobs)


@app.post("/api/servers/<int:srv>/software/restore")
@require("editor")
def api_servers_software_restore(srv):
    """サーバー本体を、入れ替える前の jar に戻す(いちばん新しい退避)。"""
    row = _server_row(srv, "edit")
    d = JAR_BACKUP_DIR / str(srv)
    olds = sorted(d.glob("*")) if d.exists() else []
    if not olds:
        raise ApiError("戻せる jar がありません", 404)
    last = olds[-1]
    _stamp, build, jar = (last.name.split("__", 2) + ["", ""])[:3]
    fs = server_fs(row)
    fs.upload("", last, jar)
    info = _jl(row["soft_info"], {})
    info["installed"] = {"build": build if build != "old" else "", "jar": jar, "size": last.stat().st_size, "at": utcnow()}
    with LOCK:
        db().execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(info), srv))
        db().commit()
    last.unlink(missing_ok=True)
    audit("サーバー本体を前の jar に戻す", row["name"], f"{jar}({build})")
    return jsonify(ok=True, jar=jar, build=build)


@app.get("/api/servers/<int:srv>/software")
def api_servers_software(srv):
    row = _server_row(srv, "view")
    return jsonify(server_software_info(row, force=_truthy(request.args.get("refresh"))))


WORLD_DIR = "_craftshelf_worlds"


def _world_store():
    """ワールドのバックアップの置き場所(バックアップ先があればそこ、無ければ今の保存先)。"""
    conn = db()
    tid = int(get_setting("backup_target_id", "0") or 0)
    target = conn.execute("SELECT * FROM storage_targets WHERE id=?", (tid,)).fetchone() if tid else None
    target = target or conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    if not target:
        raise ApiError("保存先がありません")
    return open_store(target), target


def _world_rel(row):
    return f"{WORLD_DIR}/{row['id']}-{safe_name(row['name'], 'server', 60)}"


def _world_backup_job(job, srv, user):
    conn = db()
    row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    fs = server_fs(row)
    store, _target = _world_store()
    world = _server_props(fs).get("level-name") or "world"
    names = {e["name"] for e in (fs.list("") or []) if not e["is_file"]}
    dirs = [d for d in (world, f"{world}_nether", f"{world}_the_end") if d in names]
    if not dirs:
        raise ApiError(f"ワールドのフォルダ({world})が見つかりません")
    rc = None
    try:
        rc = _rcon(row)
        if rc:
            with rc as r:  # 書き込みを止めてから保存する(壊れたバックアップにならないように)
                r.command("save-off")
                r.command("save-all flush")
            job.note("RCON で保存を止め、ワールドを書き出しました")
            time.sleep(3)
    except mcnet.NetError as e:
        job.note(f"RCON につながらないため、そのまま保存します({e.message})")
        rc = None
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    tmp = TMP_DIR / f"world-{uuid.uuid4().hex}.part"
    try:
        job.note(f"{', '.join(dirs)} をまとめています…")
        ext = fs.archive("", dirs, tmp)
    finally:
        if rc:
            try:
                with _rcon(row) as r:
                    r.command("save-on")
            except mcnet.NetError:
                job.note("RCON で保存を再開できませんでした。サーバーで save-on を実行してください")
    size = tmp.stat().st_size
    rel = f"{_world_rel(row)}/{world}-{stamp}{ext}"
    try:
        store.ensure_dir(_world_rel(row))
        store.put(tmp, rel)
    finally:
        tmp.unlink(missing_ok=True)
    job.note(f"保存しました: {rel}({size // 1024 // 1024} MB)")
    olds = sorted(n for n in store.listdir(_world_rel(row)) if not n.startswith("."))
    for n in olds[:-max(1, row["world_keep"])]:
        try:
            store.delete(f"{_world_rel(row)}/{n}")
            job.note(f"古いバックアップを削除しました: {n}")
        except Exception:  # noqa: BLE001
            pass
    with LOCK:
        conn.execute("UPDATE servers SET last_world=? WHERE id=?", (utcnow(), srv))
        conn.commit()
    audit("ワールドをバックアップ", row["name"], rel, user=user)


@app.post("/api/servers/<int:srv>/worlds")
@require("editor")
def api_servers_world_backup(srv):
    row = _server_row(srv, "edit")
    job = start_job(f"world-{srv}", f"「{row['name']}」のワールドをバックアップ", _world_backup_job, srv,
                    current_user()["username"], user=current_user()["username"])
    return jsonify(job.public())


@app.get("/api/servers/<int:srv>/worlds")
@require("editor")
def api_servers_worlds(srv):
    row = _server_row(srv, "view")
    store, target = _world_store()
    try:
        names = sorted((n for n in store.listdir(_world_rel(row)) if not n.startswith(".")), reverse=True)
    except Exception:  # noqa: BLE001
        names = []
    return jsonify(backups=[{"name": n} for n in names], storage=target["name"], keep=row["world_keep"])


@app.get("/api/servers/<int:srv>/worlds/<path:name>")
@require("editor")
def api_servers_world_download(srv, name):
    row = _server_row(srv, "view")
    if "/" in name or name.startswith("."):
        raise ApiError("ファイルの指定が不正です")
    store, _t = _world_store()
    return send_file(store.open_read(f"{_world_rel(row)}/{name}"), as_attachment=True, download_name=name)


@app.delete("/api/servers/<int:srv>/worlds/<path:name>")
@require("editor")
def api_servers_world_delete(srv, name):
    row = _server_row(srv, "edit")
    if "/" in name or name.startswith("."):
        raise ApiError("ファイルの指定が不正です")
    store, _t = _world_store()
    store.delete(f"{_world_rel(row)}/{name}")
    audit("ワールドのバックアップを削除", row["name"], name)
    return jsonify(ok=True)


@app.post("/api/servers/<int:srv>/rcon")
@require("editor")
def api_servers_rcon(srv):
    """RCON の接続確認(list を送ってプレイヤーを返す)。"""
    row = _server_row(srv, "edit")
    rc = _rcon(row)
    if not rc:
        raise ApiError("RCON のポートとパスワードを設定してください")
    try:
        with rc as r:
            return jsonify(ok=True, message=r.command("list")[:300])
    except mcnet.NetError as e:
        raise ApiError(e.message) from e


# ==========================================================================
# サーバーの巻き戻し(同期・転送の前のファイルを保存しておく)
# ==========================================================================
SNAP_DIR = CONFIG_DIR / "snapshots"
SNAP_KEEP = 10


def prune_snapshots(conn, server_id):
    olds = conn.execute("SELECT id FROM server_snapshots WHERE server_id=? ORDER BY id DESC LIMIT -1 OFFSET ?",
                        (server_id, SNAP_KEEP)).fetchall()
    for r in olds:
        shutil.rmtree(SNAP_DIR / str(r["id"]), ignore_errors=True)
        conn.execute("DELETE FROM server_snapshots WHERE id=?", (r["id"],))
    conn.commit()


@app.get("/api/servers/<int:srv>/snapshots")
@require("editor")
def api_server_snapshots(srv):
    _server_row(srv, "view")
    rows = db().execute("SELECT * FROM server_snapshots WHERE server_id=? ORDER BY id DESC", (srv,)).fetchall()
    return jsonify(snapshots=[{**dict(r), "removed": _jl(r["removed"], []), "added": _jl(r["added"], [])} for r in rows])


def _rollback_job(job, srv, snap_id, restart, user):
    conn = db()
    srv_row = conn.execute("SELECT * FROM servers WHERE id=?", (srv,)).fetchone()
    snap = conn.execute("SELECT * FROM server_snapshots WHERE id=? AND server_id=?", (snap_id, srv)).fetchone()
    removed, added = _jl(snap["removed"], []), _jl(snap["added"], [])
    fs = server_fs(srv_row)
    legacy = _clean_rel_dir(srv_row["plugin_dir"]) or "plugins"

    def full(n):  # 01.16 より前の履歴はファイル名だけ(プラグインのフォルダの中)
        return n if "/" in n else f"{legacy}/{n}"

    job.total = len(removed) + 1
    restore = {full(r["name"]) for r in removed if not r.get("dir")}
    to_delete = [full(n) for n in added if full(n) not in restore]
    for d in sorted({p.rpartition("/")[0] for p in to_delete}):
        names = [p.rpartition("/")[2] for p in to_delete if p.rpartition("/")[0] == d]
        try:
            fs.delete(d, names)
            job.note(f"同期で入れたファイルを削除: {', '.join(names)}")
        except ApiError as e:
            job.note(f"削除できないファイルがあります(すでに無いかもしれません): {e.message}")
    job.done += 1
    for r in removed:
        job.done += 1
        f = SNAP_DIR / str(snap_id) / r["stored"]
        if not f.exists():
            job.note(f"保存したファイルが見つかりません: {r['name']}")
            continue
        if r.get("dir"):  # プラグインの設定フォルダ
            parent = r["name"].rstrip("/").rpartition("/")[0]
            try:
                fs.restore_archive(parent, f, r.get("ext") or ".zip")
                job.note(f"設定フォルダを元に戻しました: {r['name']}")
            except ApiError as e:
                job.note(f"設定フォルダを戻せませんでした: {r['name']}: {e.message}")
            continue
        d, _sep, n = full(r["name"]).rpartition("/")
        fs.upload(d, f, n)
        job.note(f"元に戻しました: {n}")
    with LOCK:
        conn.execute("UPDATE server_snapshots SET rolled_back=? WHERE id=?", (utcnow(), snap_id))
        conn.execute("DELETE FROM server_files WHERE server_id=?", (srv,))
        conn.commit()
    if restart and (srv_row["kind"] == "ptero" or srv_row["control"] in ("command", "docker")):
        server_power(srv_row, "restart")
        job.note("サーバーを再起動しました")
    audit("サーバーを巻き戻し", srv_row["name"], snap["title"], user=user)
    notify_event("servers", f"{srv_row['name']} を巻き戻しました", [snap["title"], f"{fmt_local(snap['created_at'])} の状態に戻しました"], "warn")


def fmt_local(iso):
    try:
        return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone().strftime("%Y/%m/%d %H:%M")
    except (ValueError, TypeError):
        return iso


@app.post("/api/servers/<int:srv>/snapshots/<int:snap>/rollback")
@require("editor")
def api_server_rollback(srv, snap):
    row = _server_row(srv, "edit")
    if not db().execute("SELECT 1 FROM server_snapshots WHERE id=? AND server_id=?", (snap, srv)).fetchone():
        raise ApiError("見つかりません", 404)
    data = request.get_json(silent=True) or {}
    job = start_job(f"server-{srv}", f"「{row['name']}」を巻き戻し", _rollback_job, srv, snap, _truthy(data.get("restart")),
                    current_user()["username"], user=current_user()["username"], queue=True)
    return jsonify(job.public())


# ==========================================================================
# 予約同期(サーバーごとに、毎日・毎週の決まった時刻に同期)
# ==========================================================================
def _server_auto_tick(conn, now):
    """自動更新(更新があれば同期)・ワールドの定期バックアップ・サーバー本体の新しいビルドのお知らせ。"""
    target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
    for s in conn.execute("SELECT * FROM servers").fetchall():
        if s["auto_update"] == "auto" and target and _due_iso(s["last_auto"], 6):
            with LOCK:
                conn.execute("UPDATE servers SET last_auto=? WHERE id=?", (utcnow(), s["id"]))
                conn.commit()
            try:
                start_job(f"server-{s['id']}", f"「{s['name']}」の自動更新", _server_job, s["id"], target["id"], "sync",
                          [], {}, bool(s["sched_restart"]), "(自動更新)", user="(自動更新)")
            except ApiError:
                pass
        if s["world_mode"] in ("daily", "weekly"):
            try:
                hh, mm = (int(x) for x in (s["world_time"] or "05:00").split(":"))
            except ValueError:
                hh, mm = 5, 0
            due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            ok_day = s["world_mode"] == "daily" or now.weekday() == int(s["world_dow"] or 0)
            if ok_day and due <= now <= due + timedelta(hours=2) and _due_iso(s["last_world"], 20):
                with LOCK:
                    conn.execute("UPDATE servers SET last_world=? WHERE id=?", (utcnow(), s["id"]))
                    conn.commit()
                try:
                    start_job(f"world-{s['id']}", f"「{s['name']}」のワールドの定期バックアップ", _world_backup_job, s["id"],
                              "(予約)", user="(予約)")
                except ApiError:
                    pass
        if s["software"] and _due_iso(_jl(s["soft_info"], {}).get("checked_at"), 12):
            try:
                info = server_software_info(s, force=True)
            except Exception:  # noqa: BLE001
                continue
            if info.get("update") and info.get("notified") != info["latest"]["build"]:
                notify_event("servers", f"{s['name']}: サーバー本体の新しいビルドがあります",
                             [f"{SERVER_SOFT_LABEL.get(s['software'], s['software'])} {info.get('mc', '')} "
                              f"#{info.get('build')} → #{info['latest']['build']}", info["latest"].get("url", "")])
                info["notified"] = info["latest"]["build"]
                with LOCK:
                    conn.execute("UPDATE servers SET soft_info=? WHERE id=?", (json.dumps(info), s["id"]))
                    conn.commit()


SERVER_SOFT_LABEL = {"paper": "Paper", "purpur": "Purpur", "folia": "Folia", "spigot": "Spigot", "bukkit": "CraftBukkit",
                     "velocity": "Velocity", "bungeecord": "BungeeCord", "waterfall": "Waterfall", "fabric": "Fabric",
                     "quilt": "Quilt", "forge": "Forge", "neoforge": "NeoForge", "sponge": "Sponge"}


def _server_schedule_tick():
    now = datetime.now().astimezone()
    conn = db()
    _server_auto_tick(conn, now)
    for s in conn.execute("SELECT * FROM servers WHERE sched_mode IN ('daily','weekly')").fetchall():
        try:
            hh, mm = (int(x) for x in (s["sched_time"] or "04:00").split(":"))
        except ValueError:
            continue
        due = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if s["sched_mode"] == "weekly" and now.weekday() != int(s["sched_dow"] or 0):
            continue
        if now < due or (now - due) > timedelta(hours=2):
            continue
        stamp = due.strftime("%Y-%m-%dT%H:%M")
        if (s["last_sched"] or "") >= stamp:
            continue
        target = conn.execute("SELECT * FROM storage_targets WHERE active=1").fetchone()
        with LOCK:
            conn.execute("UPDATE servers SET last_sched=? WHERE id=?", (stamp, s["id"]))
            conn.commit()
        try:
            start_job(f"server-{s['id']}", f"「{s['name']}」の予約同期", _server_job, s["id"], target["id"], "sync", [], {},
                      bool(s["sched_restart"]), "(予約)", user="(予約)")
        except ApiError:
            pass
