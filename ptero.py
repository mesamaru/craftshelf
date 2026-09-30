"""Pterodactyl パネルとの連携(クライアントAPI)。

パネルの「アカウント → API 認証情報」で作る Client API キー(ptlc_...)を使う。
そのキーのユーザーが操作できるサーバーのファイル一覧・アップロード・削除・再起動ができる。
ファイルの送受信は、パネルが発行する署名付きURLを使って Wings(ノード)と直接やりとりする。
"""
from urllib.parse import quote, urlsplit

import requests

TIMEOUT = 20


class PteroError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


class Ptero:
    def __init__(self, url, api_key, verify_tls=True):
        url = (url or "").strip().rstrip("/")
        if url and "://" not in url:
            url = "https://" + url
        if not url or not api_key:
            raise PteroError("Pterodactyl の URL と APIキーを設定してください")
        self.base = url
        self.s = requests.Session()
        self.s.verify = verify_tls
        self.s.headers.update({"Authorization": f"Bearer {api_key}", "Accept": "application/json",
                               "User-Agent": "CraftShelf"})
        if not verify_tls:
            try:
                import urllib3
                urllib3.disable_warnings()
            except Exception:  # noqa: BLE001
                pass

    def _req(self, method, path_or_url, ok=(200, 201, 204), **kw):
        url = path_or_url if path_or_url.startswith("http") else self.base + path_or_url
        kw.setdefault("timeout", TIMEOUT)
        try:
            r = self.s.request(method, url, **kw)
        except requests.exceptions.SSLError:
            raise PteroError("SSL証明書を検証できません(自己署名証明書なら「証明書を検証しない」をオンにしてください)")
        except requests.exceptions.Timeout:
            raise PteroError(f"{urlsplit(url).hostname} が応答しません")
        except requests.exceptions.RequestException:
            raise PteroError(f"{urlsplit(url).hostname} に接続できません(URL・ネットワークを確認してください)")
        if r.status_code in ok:
            return r
        if r.status_code in (401, 403):
            raise PteroError("APIキーが無効か、このサーバーを操作する権限がありません(Client API キー ptlc_… を使ってください)")
        if r.status_code == 404:
            raise PteroError("サーバーまたはファイルが見つかりません")
        if r.status_code == 409:
            raise PteroError("サーバーが処理中のため操作できません(インストール中・移行中など)")
        if r.status_code == 429:
            raise PteroError("Pterodactyl へのリクエストが多すぎます。しばらく待ってからお試しください")
        try:
            detail = r.json()["errors"][0]["detail"]
        except Exception:  # noqa: BLE001
            detail = ""
        raise PteroError(f"Pterodactyl からエラーが返りました (HTTP {r.status_code}){' ' + detail[:200] if detail else ''}")

    def _list(self, type_=None):
        out, page = [], 1
        while True:
            params = {"page": page, "per_page": 100}
            if type_:
                params["type"] = type_
            d = self._req("GET", "/api/client", params=params).json()
            for x in d.get("data") or []:
                a = x.get("attributes") or {}
                out.append({"identifier": a.get("identifier"), "uuid": a.get("uuid"), "name": a.get("name") or "",
                            "node": a.get("node") or "", "description": a.get("description") or ""})
            pg = ((d.get("meta") or {}).get("pagination") or {})
            if page >= int(pg.get("total_pages") or 1):
                return out
            page += 1

    def servers(self):
        """操作できるサーバーの一覧。

        標準では「そのユーザーが所有者・サブユーザーのサーバー」しか返らないため、
        パネルの管理者のキーなら type=admin-all で全サーバーも取得して合わせる。
        """
        out = self._list()
        try:
            out += self._list("admin-all")
        except PteroError:
            pass  # 管理者ではないキー
        seen, uniq = set(), []
        for s in out:
            if s["identifier"] and s["identifier"] not in seen:
                seen.add(s["identifier"])
                uniq.append(s)
        return uniq

    def _srv(self, ident):
        if not ident or not all(c.isalnum() or c == "-" for c in ident):
            raise PteroError("サーバーIDが不正です")
        return f"/api/client/servers/{ident}"

    def list_dir(self, ident, directory):
        d = self._req("GET", self._srv(ident) + "/files/list", params={"directory": directory}).json()
        return [{"name": a.get("name"), "size": a.get("size") or 0, "is_file": bool(a.get("is_file")),
                 "modified": a.get("modified_at") or ""}
                for a in ((x.get("attributes") or {}) for x in d.get("data") or [])]

    def download(self, ident, path, dest, max_bytes=512 * 1024 * 1024):
        url = self._req("GET", self._srv(ident) + "/files/download", params={"file": path}).json()["attributes"]["url"]
        r = self._req("GET", url, stream=True, timeout=(TIMEOUT, 300), headers={"Authorization": None})
        total = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise PteroError("ファイルが大きすぎます")
                f.write(chunk)

    def upload(self, ident, directory, local_path, filename):
        url = self._req("GET", self._srv(ident) + "/files/upload").json()["attributes"]["url"]
        sep = "&" if "?" in url else "?"
        with open(local_path, "rb") as f:
            self._req("POST", f"{url}{sep}directory={quote(directory, safe='/')}", timeout=(TIMEOUT, 600),
                      files={"files": (filename, f, "application/java-archive")}, headers={"Authorization": None})

    def delete(self, ident, root, names):
        if names:
            self._req("POST", self._srv(ident) + "/files/delete", json={"root": root, "files": list(names)})

    def create_folder(self, ident, root, name):
        self._req("POST", self._srv(ident) + "/files/create-folder", json={"root": root, "name": name}, ok=(200, 204, 422, 500))

    def power(self, ident, signal):
        if signal not in ("start", "stop", "restart", "kill"):
            raise PteroError("不正な操作です")
        self._req("POST", self._srv(ident) + "/power", json={"signal": signal})

    def resources(self, ident):
        a = self._req("GET", self._srv(ident) + "/resources").json().get("attributes") or {}
        return {"state": a.get("current_state") or "unknown"}
