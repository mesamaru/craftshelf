"""保存先(ストレージ)へのファイル操作を、方式ごとの違いを隠して同じ形で扱うためのモジュール。

- LocalStorage : コンテナ内のフォルダ(docker-compose の volumes でつないだ /data)
- SmbStorage   : SMB(Windows共有)。smbprotocol を使い、アプリ自身が直接通信する
- WebDavStorage: WebDAV(Nextcloud など)。HTTP で直接通信する

SMB / WebDAV は OS の mount を使わないので、特別な権限(cap_add / privileged)は不要で、
Proxmox の非特権LXC の中の Docker でもそのまま動く。

パスはすべて「保存先のルートからの相対パス」を / 区切りの文字列で扱う(例: library/plugins/X/a.jar)。
"""
import os
import shutil
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


class StorageError(Exception):
    """利用者に見せる日本語メッセージ付きのエラー。"""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def clean_rel(rel):
    rel = (rel or "").replace("\\", "/").strip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise StorageError("不正なパスです")
    return "/".join(parts)


def parent_rel(rel):
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def join_rel(*parts):
    return clean_rel("/".join(p for p in parts if p))


class BaseStorage:
    is_local = False
    INDEX_TTL = 60  # 秒。リモートのファイル一覧はこの間キャッシュする

    def __init__(self):
        self._index = None
        self._index_at = 0.0
        self._index_lock = threading.Lock()

    # ---- ファイル一覧のキャッシュ(build_library の「ファイルが見つかりません」判定用) ----
    def file_index(self, rel="library"):
        """rel 以下の全ファイルの相対パス集合。リモートは一定時間キャッシュする。"""
        if self.is_local:
            return set(self.walk(rel)[0])
        with self._index_lock:
            if self._index is None or time.monotonic() - self._index_at > self.INDEX_TTL:
                self._index = set(self.walk(rel)[0])
                self._index_at = time.monotonic()
            return set(self._index)

    def _index_add(self, rel):
        with self._index_lock:
            if self._index is not None:
                self._index.add(rel)

    def _index_remove(self, rel):
        with self._index_lock:
            if self._index is not None:
                self._index.discard(rel)

    def invalidate_index(self):
        with self._index_lock:
            self._index = None

    # ---- 共通の組み合わせ操作 ----
    def unique_rel(self, dir_rel, fname):
        rel = join_rel(dir_rel, fname)
        if not self.exists(rel):
            return rel
        stem, suf = os.path.splitext(fname)
        i = 1
        while self.exists(join_rel(dir_rel, f"{stem}-{i}{suf}")):
            i += 1
        return join_rel(dir_rel, f"{stem}-{i}{suf}")

    def probe(self):
        """接続テスト。(先頭20件の中身, 書き込めるか) を返す。"""
        self.ensure_dir("")
        entries = sorted(self.listdir(""))[:20]
        name = f".craftshelf-test-{uuid.uuid4().hex[:6]}"
        try:
            self.write_bytes(name, b"ok")
            self.delete(name)
            writable = True
        except StorageError:
            writable = False
        return entries, writable

    def describe(self):
        raise NotImplementedError

    def capacity(self):
        """保存先の容量 {"total": バイト, "free": バイト}。分からなければ None。"""
        return None


# --------------------------------------------------------------------------
# ローカル
# --------------------------------------------------------------------------
class LocalStorage(BaseStorage):
    is_local = True

    def __init__(self, root):
        super().__init__()
        self.root = Path(root).resolve()

    def describe(self):
        return str(self.root)

    def capacity(self):
        du = shutil.disk_usage(self.root)
        return {"total": du.total, "free": du.free}

    def local_path(self, rel):
        p = (self.root / clean_rel(rel)).resolve()
        if p != self.root and self.root not in p.parents:
            raise StorageError("不正なパスです")
        return p

    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True)

    def exists(self, rel):
        return self.local_path(rel).exists()

    def ensure_dir(self, rel):
        self.local_path(rel).mkdir(parents=True, exist_ok=True)

    def listdir(self, rel):
        return [p.name for p in self.local_path(rel).iterdir()]

    def walk(self, rel):
        base = self.local_path(rel)
        files, dirs = [], []
        if not base.exists():
            return files, dirs
        for p in base.rglob("*"):
            r = p.relative_to(self.root).as_posix()
            (dirs if p.is_dir() else files).append(r)
        return files, dirs

    def put(self, local_src, rel):
        dest = self.local_path(rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(local_src), str(dest))

    def write_bytes(self, rel, data):
        try:
            p = self.local_path(rel)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        except OSError as e:
            raise StorageError(f"書き込めません: {e}")

    def fetch(self, rel, local_dst):
        shutil.copyfile(self.local_path(rel), local_dst)

    def open_read(self, rel):
        return open(self.local_path(rel), "rb")

    def delete(self, rel):
        try:
            self.local_path(rel).unlink()
        except FileNotFoundError:
            pass

    def rmdir_if_empty(self, rel):
        try:
            self.local_path(rel).rmdir()
        except OSError:
            pass

    def move(self, src_rel, dst_rel):
        dst = self.local_path(dst_rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(self.local_path(src_rel)), str(dst))


# --------------------------------------------------------------------------
# SMB (smbprotocol)
# --------------------------------------------------------------------------
_SMB_LOCK = threading.Lock()
# 接続キャッシュを捨てるたびに増やす。各 SmbStorage はこれを見て、必要なら繋ぎ直す
_SMB_GEN = [0]


def _smb_reset():
    _smb().reset_connection_cache()
    _SMB_GEN[0] += 1


def _smb():
    try:
        import smbclient
        from smbclient import ClientConfig
    except ImportError:
        raise StorageError("SMB用のライブラリ(smbprotocol)がインストールされていません")
    # ゲスト接続(Unraidの「パブリック」共有など)は署名鍵を持たないため、SMB3の
    # ネゴシエーション検証を行うと接続できない。家庭内LAN向けの道具なので無効にしておく。
    ClientConfig(require_secure_negotiate=False)
    return smbclient


def _smb_not_found(e):
    """ファイル・フォルダが無いことを示すSMBのエラーか(例外クラスが状況で変わるので errno でも見る)。"""
    import errno
    from smbprotocol import exceptions as x
    return (isinstance(e, (x.ObjectNameNotFound, x.ObjectPathNotFound, x.NotFound))
            or getattr(e, "errno", None) == errno.ENOENT)


def _smb_error(e):
    from smbprotocol import exceptions as x
    if isinstance(e, StorageError):
        return e
    if isinstance(e, (x.LogonFailure, x.SMBAuthenticationError)):
        return StorageError("認証に失敗しました(ユーザー名・パスワードを確認してください)")
    if isinstance(e, x.BadNetworkName):
        return StorageError("共有名が見つかりません(共有名の綴りを確認してください)")
    if isinstance(e, x.AccessDenied):
        return StorageError("アクセスが拒否されました(共有のアクセス権・書き込み権限を確認してください)")
    if _smb_not_found(e):
        return StorageError("指定したファイル・フォルダが見つかりません")
    if isinstance(e, (TimeoutError, ConnectionRefusedError)) or "timed out" in str(e).lower():
        return StorageError("サーバーに接続できません(IPアドレス・電源・ネットワークを確認してください)")
    if isinstance(e, (OSError, ValueError)) and ("connect" in str(e).lower() or "refused" in str(e).lower()):
        return StorageError("サーバーに接続できません(IPアドレス・電源・ネットワークを確認してください)")
    return StorageError(f"SMBエラー: {str(e)[:300]}")


class SmbStorage(BaseStorage):
    def __init__(self, server, share, subpath="", username="", password="", domain="", port=445):
        super().__init__()
        self.server = server.strip()
        self.share = share.strip().strip("/\\")
        self.subpath = clean_rel(subpath)
        self.guest = not username.strip()
        user = username.strip() or "guest"
        if domain.strip() and "\\" not in user and "@" not in user:
            user = f"{domain.strip()}\\{user}"
        self.username = user
        self.password = "" if self.guest else password
        self.port = int(port or 445)
        self._registered = False
        self._gen = -1

    def describe(self):
        tail = f"/{self.subpath}" if self.subpath else ""
        return f"smb://{self.server}/{self.share}{tail}"

    def _unc(self, rel=""):
        parts = [p for p in (self.subpath, clean_rel(rel)) if p]
        tail = "\\".join(parts).replace("/", "\\")
        return f"\\\\{self.server}\\{self.share}" + (f"\\{tail}" if tail else "")

    def _kw(self):
        return dict(username=self.username, password=self.password, port=self.port)

    def capacity(self):
        v = self._call(lambda c: c.stat_volume(self._unc(""), **self._kw()))
        return {"total": int(v.total_size), "free": int(v.caller_available_size)}

    CONNECT_TIMEOUT = 15  # 秒

    def connect(self):
        smbclient = _smb()
        with _SMB_LOCK:
            try:
                smbclient.register_session(
                    self.server, username=self.username, password=self.password, port=self.port,
                    auth_protocol="ntlm", require_signing=not self.guest, connection_timeout=10)
            except Exception as e:  # noqa: BLE001
                raise _smb_error(e)
            # 共有への接続(tree connect)を確認する。存在しない共有名をゲストで開こうとすると
            # smbprotocol が応答を待ち続けて止まることがあるため、別スレッドで時間制限を付ける。
            result = {}

            def probe_share():
                try:
                    smbclient.stat(f"\\\\{self.server}\\{self.share}", **self._kw())
                    result["ok"] = True
                except Exception as e:  # noqa: BLE001
                    result["err"] = e

            th = threading.Thread(target=probe_share, daemon=True)
            th.start()
            th.join(self.CONNECT_TIMEOUT)
            if th.is_alive():
                _smb_reset()  # 止まった接続を捨てる(待っているスレッドも解放される)
                raise StorageError("共有に接続できません(共有名が間違っているか、サーバーが応答しません)")
            if "err" in result:
                if _smb_not_found(result["err"]):
                    raise StorageError("共有名が見つかりません(共有名の綴りを確認してください)")
                raise _smb_error(result["err"])
            self._registered = True
            self._gen = _SMB_GEN[0]

    def _call(self, fn):
        """SMB 操作を実行する。NASの再起動などで接続が切れていたら1回だけ繋ぎ直す。"""
        from smbprotocol import exceptions as x
        if not self._registered or self._gen != _SMB_GEN[0]:
            self.connect()
        try:
            return fn(_smb())
        except (x.SMBConnectionClosed, ConnectionResetError, BrokenPipeError, EOFError):
            _smb_reset()
            self._registered = False
            self.connect()
            try:
                return fn(_smb())
            except Exception as e:  # noqa: BLE001
                raise _smb_error(e)
        except Exception as e:  # noqa: BLE001
            raise _smb_error(e)

    def exists(self, rel):

        def f(c):
            try:
                c.stat(self._unc(rel), **self._kw())
                return True
            except Exception as e:  # noqa: BLE001
                if _smb_not_found(e):
                    return False
                raise
        return self._call(f)

    def ensure_dir(self, rel):
        self._call(lambda c: c.makedirs(self._unc(rel), exist_ok=True, **self._kw()))

    def listdir(self, rel):
        return self._call(lambda c: c.listdir(self._unc(rel), **self._kw()))

    def walk(self, rel):
        base = clean_rel(rel)
        if not self.exists(base):
            return [], []
        files, dirs = [], []

        def f(c):
            stack = [base]
            while stack:
                cur = stack.pop()
                for entry in c.scandir(self._unc(cur), **self._kw()):
                    r = join_rel(cur, entry.name)
                    if entry.is_dir():
                        dirs.append(r)
                        stack.append(r)
                    else:
                        files.append(r)
        self._call(f)
        return files, dirs

    def _write_from(self, fobj, rel):
        def f(c):
            c.makedirs(self._unc(parent_rel(clean_rel(rel))), exist_ok=True, **self._kw())
            with c.open_file(self._unc(rel), mode="wb", **self._kw()) as out:
                shutil.copyfileobj(fobj, out, 1024 * 1024)
        self._call(f)
        self._index_add(clean_rel(rel))

    def put(self, local_src, rel):
        with open(local_src, "rb") as fobj:
            self._write_from(fobj, rel)
        os.unlink(local_src)

    def write_bytes(self, rel, data):
        import io
        self._write_from(io.BytesIO(data), rel)

    def fetch(self, rel, local_dst):
        def f(c):
            with c.open_file(self._unc(rel), mode="rb", **self._kw()) as src, open(local_dst, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
        self._call(f)

    def open_read(self, rel):
        return self._call(lambda c: c.open_file(self._unc(rel), mode="rb", **self._kw()))

    def delete(self, rel):

        def f(c):
            try:
                c.remove(self._unc(rel), **self._kw())
            except Exception as e:  # noqa: BLE001
                if not _smb_not_found(e):
                    raise
        self._call(f)
        self._index_remove(clean_rel(rel))

    def rmdir_if_empty(self, rel):
        from smbprotocol import exceptions as x

        def f(c):
            try:
                c.rmdir(self._unc(rel), **self._kw())
            except (x.DirectoryNotEmpty, OSError):
                pass  # 空でない・既に無い、はどちらも「何もしない」でよい
        self._call(f)

    def move(self, src_rel, dst_rel):
        def f(c):
            c.makedirs(self._unc(parent_rel(clean_rel(dst_rel))), exist_ok=True, **self._kw())
            c.rename(self._unc(src_rel), self._unc(dst_rel), **self._kw())
        self._call(f)
        self._index_remove(clean_rel(src_rel))
        self._index_add(clean_rel(dst_rel))


# --------------------------------------------------------------------------
# WebDAV (Nextcloud など)
# --------------------------------------------------------------------------
_DAV = "{DAV:}"


def nextcloud_dav_url(url, username):
    """Nextcloud のサーバーURLだけが入力された場合、WebDAV のURLを組み立てる。

    https://cloud.example.com  →  https://cloud.example.com/remote.php/dav/files/<ユーザー名>
    すでに /remote.php/ などのパスが入っている場合はそのまま使う。
    """
    url = (url or "").strip().rstrip("/")
    if not url:
        return url
    if "://" not in url:
        url = "https://" + url
    path = urlsplit(url).path
    if path in ("", "/") and username:
        url = f"{url}/remote.php/dav/files/{quote(username, safe='')}"
    return url


class WebDavStorage(BaseStorage):
    TIMEOUT = 15

    def __init__(self, url, subpath="", username="", password="", verify_tls=True):
        super().__init__()
        try:
            import requests
        except ImportError:
            raise StorageError("WebDAV用のライブラリ(requests)がインストールされていません")
        self.base = nextcloud_dav_url(url, username)
        self.subpath = clean_rel(subpath)
        self.session = requests.Session()
        if username:
            self.session.auth = (username, password)
        self.session.verify = verify_tls
        self.session.headers["User-Agent"] = "craftshelf"
        if not verify_tls:
            try:
                import urllib3
                urllib3.disable_warnings()
            except Exception:  # noqa: BLE001
                pass
        self._root_path = urlsplit(self._url("")).path.rstrip("/") + "/"

    def describe(self):
        return self._url("")

    def _url(self, rel, is_dir=False):
        parts = [p for p in (self.subpath, clean_rel(rel)) if p]
        tail = "/".join(quote(seg, safe="") for p in parts for seg in p.split("/"))
        u = self.base + ("/" + tail if tail else "")
        return u + "/" if is_dir else u

    def _req(self, method, url, ok=(200, 201, 204, 207), **kw):
        import requests
        kw.setdefault("timeout", self.TIMEOUT)
        try:
            r = self.session.request(method, url, **kw)
        except requests.exceptions.SSLError:
            raise StorageError("SSL証明書を検証できません(自己署名証明書なら「証明書を検証しない」をオンにしてください)")
        except requests.exceptions.Timeout:
            raise StorageError("サーバーが応答しません(URL・ネットワークを確認してください)")
        except requests.exceptions.ConnectionError:
            raise StorageError("サーバーに接続できません(URL・電源・ネットワークを確認してください)")
        if r.status_code in ok:
            return r
        if r.status_code == 401:
            raise StorageError("認証に失敗しました(ユーザー名・パスワードを確認してください。"
                               "Nextcloudで二段階認証を使っている場合は「アプリパスワード」が必要です)")
        if r.status_code == 403:
            raise StorageError("アクセスが拒否されました(権限を確認してください)")
        if r.status_code == 404:
            raise StorageError("URL・フォルダが見つかりません(WebDAVのURLを確認してください)")
        if r.status_code == 507:
            raise StorageError("保存先の容量が不足しています")
        raise StorageError(f"WebDAVエラー: HTTP {r.status_code} ({method})")

    def capacity(self):
        # RFC 4331 のクォータ情報(Nextcloud などが対応)。無ければ None
        body = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
                '<d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>')
        r = self._req("PROPFIND", self._url("", is_dir=True), ok=(207,), data=body,
                      headers={"Depth": "0", "Content-Type": "application/xml"})
        try:
            root = ET.fromstring(r.content)
        except ET.ParseError:
            return None
        num = {}
        for tag in ("quota-available-bytes", "quota-used-bytes"):
            el = root.find(f".//{{DAV:}}{tag}")
            try:
                num[tag] = int(el.text) if el is not None and el.text else None
            except ValueError:
                num[tag] = None
        free, used = num["quota-available-bytes"], num["quota-used-bytes"]
        if free is None or free < 0:  # 無制限(-3 など)や未対応
            return None
        return {"total": free + (used or 0), "free": free}

    def _propfind(self, rel, depth):
        body = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
                '<d:resourcetype/></d:prop></d:propfind>')
        r = self._req("PROPFIND", self._url(rel, is_dir=depth == "1"), ok=(207, 404),
                      data=body, headers={"Depth": depth, "Content-Type": "application/xml"})
        if r.status_code == 404:
            return None
        out = []  # [(rel, is_dir)]
        try:
            tree = ET.fromstring(r.content)
        except ET.ParseError:
            raise StorageError("WebDAVサーバーからの応答を読み取れません(URLを確認してください)")
        for resp in tree.iter(_DAV + "response"):
            href = resp.findtext(_DAV + "href") or ""
            path = unquote(urlsplit(href).path)
            is_dir = resp.find(f".//{_DAV}resourcetype/{_DAV}collection") is not None
            root = unquote(self._root_path)
            if path.rstrip("/") + "/" == root:
                r_ = ""
            elif path.startswith(root):
                r_ = path[len(root):].strip("/")
            else:
                continue
            out.append((r_, is_dir))
        return out

    def connect(self):
        self._propfind("", "0")  # 認証・URLが正しいかだけ確認(フォルダが無くてもOK)

    def exists(self, rel):
        return self._propfind(rel, "0") is not None

    def listdir(self, rel):
        res = self._propfind(rel, "1")
        if res is None:
            raise StorageError("指定したフォルダが見つかりません")
        me = clean_rel(rel)
        return [r.rsplit("/", 1)[-1] for r, _d in res if r != me]

    def ensure_dir(self, rel):
        # サブフォルダ(subpath)も含め、ルートから順に作る。既にあれば 405 が返る
        parts = [p for p in (self.subpath.split("/") if self.subpath else [])]
        prefix = self.base
        for seg in parts:
            prefix += "/" + quote(seg, safe="")
            self._req("MKCOL", prefix + "/", ok=(201, 405))
        cur = ""
        for seg in [p for p in clean_rel(rel).split("/") if p]:
            cur = join_rel(cur, seg)
            self._req("MKCOL", self._url(cur, is_dir=True), ok=(201, 405))

    def walk(self, rel):
        base = clean_rel(rel)
        files, dirs = [], []
        stack = [base]
        first = True
        while stack:
            cur = stack.pop()
            res = self._propfind(cur, "1")  # Nextcloud は Depth: infinity を許可しないので1階層ずつ
            if res is None:
                if first:
                    return [], []
                continue
            first = False
            for r, is_dir in res:
                if r == cur:
                    continue
                if is_dir:
                    dirs.append(r)
                    stack.append(r)
                else:
                    files.append(r)
        return files, dirs

    def _put_stream(self, rel, data):
        self.ensure_dir(parent_rel(clean_rel(rel)))
        self._req("PUT", self._url(rel), ok=(200, 201, 204), data=data, timeout=(self.TIMEOUT, None))
        self._index_add(clean_rel(rel))

    def put(self, local_src, rel):
        with open(local_src, "rb") as f:
            self._put_stream(rel, f)
        os.unlink(local_src)

    def write_bytes(self, rel, data):
        self._put_stream(rel, data)

    def fetch(self, rel, local_dst):
        r = self._req("GET", self._url(rel), ok=(200,), stream=True, timeout=(self.TIMEOUT, None))
        with open(local_dst, "wb") as out:
            for chunk in r.iter_content(1024 * 1024):
                out.write(chunk)

    def open_read(self, rel):
        r = self._req("GET", self._url(rel), ok=(200,), stream=True, timeout=(self.TIMEOUT, None))
        r.raw.decode_content = True
        return r.raw

    def delete(self, rel):
        self._req("DELETE", self._url(rel), ok=(200, 204, 404))
        self._index_remove(clean_rel(rel))

    def rmdir_if_empty(self, rel):
        if not clean_rel(rel):
            return
        res = self._propfind(rel, "1")
        if res is not None and all(r == clean_rel(rel) for r, _d in res):
            self._req("DELETE", self._url(rel, is_dir=True), ok=(200, 204, 404))

    def move(self, src_rel, dst_rel):
        self.ensure_dir(parent_rel(clean_rel(dst_rel)))
        self._req("MOVE", self._url(src_rel), ok=(201, 204),
                  headers={"Destination": self._url(dst_rel), "Overwrite": "F"})
        self._index_remove(clean_rel(src_rel))
        self._index_add(clean_rel(dst_rel))
