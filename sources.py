"""外部の配布サイト(Modrinth / SpigotMC / CurseForge)から、プラグイン・Modの情報を取得する。

- Modrinth  : 公開API。ファイルのハッシュ(SHA-1)から、どのプロジェクトのどの版かを特定できる
- SpigotMC  : Spiget(非公式の公開API)を使う。ハッシュ検索はできないので、名前検索かURLで紐付ける
- CurseForge: 公式APIキー(無料、https://console.curseforge.com で発行)が必要。
              ファイルのフィンガープリントから特定できる
NeoForge / Forge / Fabric は「Mod ローダー」の種類で、Mod 自体は Modrinth / CurseForge で配布されている。
そのため、ローダーの違いは検索時の絞り込み条件(loaders)として扱う。

このモジュールは Flask にも DB にも依存せず、辞書を返すだけにしてある。
"""
import base64
import hashlib
import json
import re
import struct
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit

import requests

UA = "CraftShelf/1.0 (self-hosted Minecraft plugin/mod library; https://github.com/mesamaru/craftshelf)"
TIMEOUT = 20
MAX_DOWNLOAD = 512 * 1024 * 1024  # 1ファイルあたりの上限

PROVIDERS = {"modrinth": "Modrinth", "spigot": "SpigotMC", "curseforge": "CurseForge"}

MODRINTH = "https://api.modrinth.com/v2"
SPIGET = "https://api.spiget.org/v2"
CURSEFORGE = "https://api.curseforge.com/v1"
CF_GAME_MINECRAFT = 432
# CurseForge の分類(classId)
CF_CLASSES = {6: "mod", 5: "plugin", 12: "resourcepack", 6945: "datapack", 6552: "shader", 4471: "modpack"}
# CurseForge の modLoaderType
CF_LOADERS = {"forge": 1, "fabric": 4, "quilt": 5, "neoforge": 6}


class SourceError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


_S = requests.Session()
MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"


def mc_releases():
    """Mojang の公式一覧から、正式リリースの MC バージョンを新しい順で返す。"""
    r = _S.get(MOJANG_MANIFEST, timeout=15)
    r.raise_for_status()
    return [v["id"] for v in r.json().get("versions", []) if v.get("type") == "release"]


_S.headers["User-Agent"] = UA


def _req(method, url, *, api_key=None, ok=(200,), **kw):
    headers = kw.pop("headers", {})
    if api_key:
        headers["x-api-key"] = api_key
    kw.setdefault("timeout", TIMEOUT)
    try:
        r = _S.request(method, url, headers=headers, **kw)
    except requests.exceptions.Timeout:
        raise SourceError(f"{urlsplit(url).hostname} が応答しません")
    except requests.exceptions.RequestException:
        raise SourceError(f"{urlsplit(url).hostname} に接続できません(インターネット接続を確認してください)")
    if r.status_code in ok:
        return r
    if r.status_code == 403 and "curseforge" in url:
        raise SourceError("CurseForge のAPIキーが無効です(設定画面で確認してください)")
    if r.status_code == 404:
        raise SourceError("配布ページが見つかりません(削除されたか、IDが違います)")
    if r.status_code == 429:
        raise SourceError("アクセスが集中しています。しばらく待ってから再度お試しください")
    raise SourceError(f"{urlsplit(url).hostname} からエラーが返りました (HTTP {r.status_code})")


def _json(method, url, **kw):
    r = _req(method, url, **kw)
    try:
        return r.json()
    except ValueError:
        raise SourceError(f"{urlsplit(url).hostname} からの応答を読み取れません")


# --------------------------------------------------------------------------
# ハッシュ
# --------------------------------------------------------------------------
def sha1_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def cf_fingerprint(path):
    """CurseForge のフィンガープリント(空白類を除いた内容の MurmurHash2、seed=1)。"""
    with open(path, "rb") as f:
        data = bytes(b for b in f.read() if b not in (9, 10, 13, 32))
    m, length = 0x5BD1E995, len(data)
    h = (1 ^ length) & 0xFFFFFFFF
    i = 0
    while length >= 4:
        k = struct.unpack_from("<I", data, i)[0]
        k = (k * m) & 0xFFFFFFFF
        k ^= k >> 24
        k = (k * m) & 0xFFFFFFFF
        h = ((h * m) & 0xFFFFFFFF) ^ k
        i += 4
        length -= 4
    if length == 3:
        h ^= data[i + 2] << 16
    if length >= 2:
        h ^= data[i + 1] << 8
    if length >= 1:
        h ^= data[i]
        h = (h * m) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * m) & 0xFFFFFFFF
    h ^= h >> 15
    return h


# --------------------------------------------------------------------------
# ローダー(絞り込み条件)
# --------------------------------------------------------------------------
def default_loaders(category, loader_label):
    """登録済みファイルの解析結果から、Modrinth で使う loaders の既定値を決める。"""
    lab = (loader_label or "").lower()
    if category == "datapack":
        return ["datapack"]
    if category == "resourcepack":
        return ["minecraft"]
    if category in ("shader", "modpack"):
        return []
    if "neoforge" in lab:
        return ["neoforge"]
    if "forge" in lab:
        return ["forge"]
    if "quilt" in lab:
        return ["quilt", "fabric"]
    if "fabric" in lab:
        return ["fabric"]
    if "velocity" in lab:
        return ["velocity"]
    if "bungee" in lab:
        return ["bungeecord", "waterfall"]
    if category == "plugin" or "bukkit" in lab or "paper" in lab:
        return ["paper", "spigot", "bukkit", "purpur", "folia"]
    return []


def _norm(v):
    return re.sub(r"[^0-9a-z]+", "", (v or "").lower().lstrip("v"))


def same_version(a, b):
    """'v5.5.71-bukkit' と '5.5.71' のような表記揺れを許して、同じ版か判定する。"""
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    nums_a = re.findall(r"\d+(?:\.\d+)+", a or "")
    nums_b = re.findall(r"\d+(?:\.\d+)+", b or "")
    return bool(nums_a and nums_b and nums_a[0] == nums_b[0])


# --------------------------------------------------------------------------
# URL から配布元を判定
# --------------------------------------------------------------------------
def parse_url(url):
    """配布ページのURLから (provider, id_or_slug, 補足) を読み取る。"""
    u = urlsplit((url or "").strip())
    host = (u.hostname or "").lower()
    parts = [p for p in u.path.split("/") if p]
    if host.endswith("modrinth.com") and len(parts) >= 2:
        return "modrinth", parts[1], None
    if host.endswith("spigotmc.org") and len(parts) >= 2 and parts[0] == "resources":
        m = re.search(r"(?:\.|^)(\d+)$", parts[1])
        if m:
            return "spigot", m.group(1), None
    if host.endswith("curseforge.com") and len(parts) >= 3 and parts[0] == "minecraft":
        return "curseforge", parts[2], parts[1]
    raise SourceError("対応していないURLです(Modrinth / SpigotMC / CurseForge の配布ページのURLを入力してください)")


# --------------------------------------------------------------------------
# Modrinth
# --------------------------------------------------------------------------
def _mr_file(version):
    files = version.get("files") or []
    f = next((x for x in files if x.get("primary")), files[0] if files else None)
    if not f:
        return None
    return {
        "version": version.get("version_number") or "",
        "version_id": version.get("id"),
        "file_name": f.get("filename"),
        "url": f.get("url"),
        "sha1": (f.get("hashes") or {}).get("sha1", ""),
        "size": f.get("size"),
        "date": version.get("date_published") or "",
        "game_versions": version.get("game_versions") or [],
        "loaders": version.get("loaders") or [],
        "downloadable": bool(f.get("url")),
    }


def modrinth_project(id_or_slug):
    p = _json("GET", f"{MODRINTH}/project/{quote(id_or_slug, safe='')}")
    return {"provider": "modrinth", "project_id": p["id"], "slug": p.get("slug") or "",
            "title": p.get("title") or p.get("slug") or p["id"],
            "page_url": f"https://modrinth.com/{p.get('project_type', 'project')}/{p.get('slug') or p['id']}"}


def modrinth_by_hashes(sha1s):
    """{sha1: {"project_id","version"...}} 見つかったものだけ返す。"""
    if not sha1s:
        return {}
    d = _json("POST", f"{MODRINTH}/version_files", json={"hashes": list(sha1s), "algorithm": "sha1"})
    return {h: v for h, v in d.items()} if isinstance(d, dict) else {}


def modrinth_search(name, project_type=None, size=8):
    facets = [[f"project_type:{project_type}"]] if project_type else None
    params = {"query": name, "limit": size}
    if facets:
        params["facets"] = json.dumps(facets)
    d = _json("GET", f"{MODRINTH}/search", params=params)
    return [{"provider": "modrinth", "project_id": h["project_id"], "title": h.get("title") or "",
             "summary": h.get("description") or "", "downloads": h.get("downloads") or 0,
             "page_url": f"https://modrinth.com/{h.get('project_type', 'project')}/{h.get('slug')}"}
            for h in d.get("hits") or []]


def modrinth_latest(project_id, loaders=None, game_versions=None, stable_only=True):
    params = {"include_changelog": "false"}
    if loaders:
        params["loaders"] = json.dumps(loaders)
    if game_versions:
        params["game_versions"] = json.dumps(game_versions)
    vs = _json("GET", f"{MODRINTH}/project/{quote(project_id, safe='')}/version", params=params)
    if not vs:
        return None
    if stable_only:
        vs = [v for v in vs if v.get("version_type") == "release"] or vs
    vs.sort(key=lambda v: v.get("date_published") or "", reverse=True)
    return _mr_file(vs[0])


# --------------------------------------------------------------------------
# SpigotMC (Spiget)
# --------------------------------------------------------------------------
def spigot_project(resource_id):
    d = _json("GET", f"{SPIGET}/resources/{int(resource_id)}")
    return {"provider": "spigot", "project_id": str(d["id"]), "slug": "", "title": d.get("name") or str(d["id"]),
            "page_url": f"https://www.spigotmc.org/resources/{d['id']}/"}


def spigot_search(name, size=8):
    q = re.sub(r"[^\w\s.-]+", " ", name or "").strip()
    if not q:
        return []
    d = _json("GET", f"{SPIGET}/search/resources/{quote(q, safe='')}", ok=(200, 404),
              params={"field": "name", "size": size, "sort": "-downloads"})
    if not isinstance(d, list):
        return []
    return [{"provider": "spigot", "project_id": str(x["id"]), "title": x.get("name") or "",
             "summary": x.get("tag") or "", "downloads": x.get("downloads") or 0,
             "page_url": f"https://www.spigotmc.org/resources/{x['id']}/"} for x in d]


def spigot_latest(resource_id):
    rid = int(resource_id)
    res = _json("GET", f"{SPIGET}/resources/{rid}")
    ver = _json("GET", f"{SPIGET}/resources/{rid}/versions/latest")
    ftype = ((res.get("file") or {}).get("type") or "").lower()
    downloadable = not res.get("premium") and not res.get("external") and ftype in (".jar", ".zip")
    name = re.sub(r"[^\w.+-]+", "_", res.get("name") or f"resource-{rid}").strip("_")
    vname = str(ver.get("name") or "")
    vsafe = re.sub(r"[^\w.+-]+", "_", vname)
    ext = ftype if ftype in (".jar", ".zip") else ".jar"
    from datetime import datetime, timezone
    date = ""
    if ver.get("releaseDate"):
        date = datetime.fromtimestamp(int(ver["releaseDate"]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "version": vname,
        "version_id": str(ver.get("id") or ""),
        "file_name": f"{name}-{vsafe}{ext}",
        "url": f"{SPIGET}/resources/{rid}/download" if downloadable else None,
        "sha1": "",
        "size": None,
        "date": date,
        "game_versions": res.get("testedVersions") or [],
        "loaders": [],
        "downloadable": downloadable,
        "note": "" if downloadable else ("有料リソースのため自動ダウンロードできません" if res.get("premium")
                                         else "外部サイトで配布されているため自動ダウンロードできません"),
    }


# --------------------------------------------------------------------------
# CurseForge
# --------------------------------------------------------------------------
def _need_key(api_key):
    if not api_key:
        raise SourceError("CurseForge を使うには APIキーが必要です(設定画面で登録してください)")


def _cf_project_dict(m):
    links = m.get("links") or {}
    return {"provider": "curseforge", "project_id": str(m["id"]), "slug": m.get("slug") or "",
            "title": m.get("name") or str(m["id"]), "page_url": links.get("websiteUrl") or ""}


def curseforge_project(id_or_slug, api_key, class_hint=None):
    _need_key(api_key)
    if str(id_or_slug).isdigit():
        return _cf_project_dict(_json("GET", f"{CURSEFORGE}/mods/{id_or_slug}", api_key=api_key)["data"])
    hint = {"mc-mods": 6, "bukkit-plugins": 5, "texture-packs": 12, "data-packs": 6945, "shaders": 6552, "modpacks": 4471}.get(class_hint or "")
    for class_id in ([hint] if hint else []) + [c for c in CF_CLASSES if c != hint]:
        d = _json("GET", f"{CURSEFORGE}/mods/search", api_key=api_key,
                  params={"gameId": CF_GAME_MINECRAFT, "classId": class_id, "slug": id_or_slug})
        if d.get("data"):
            return _cf_project_dict(d["data"][0])
    raise SourceError("CurseForge でプロジェクトが見つかりません")


def curseforge_by_fingerprints(fps, api_key):
    """{fingerprint: {"project_id", "file": {...}}} 見つかったものだけ返す。"""
    _need_key(api_key)
    if not fps:
        return {}
    d = _json("POST", f"{CURSEFORGE}/fingerprints/{CF_GAME_MINECRAFT}", api_key=api_key,
              json={"fingerprints": [int(x) for x in fps]})
    out = {}
    for m in (d.get("data") or {}).get("exactMatches") or []:
        f = m.get("file") or {}
        out[int(f.get("fileFingerprint") or 0)] = {"project_id": str(m.get("id")), "file": f}
    return out


def _cf_file(f):
    sha1 = next((h.get("value") for h in f.get("hashes") or [] if h.get("algo") == 1), "")
    return {
        "version": f.get("displayName") or f.get("fileName") or "",
        "version_id": str(f.get("id") or ""),
        "file_name": f.get("fileName"),
        "url": f.get("downloadUrl"),
        "sha1": sha1 or "",
        "size": f.get("fileLength"),
        "date": f.get("fileDate") or "",
        "game_versions": [g for g in f.get("gameVersions") or [] if re.match(r"^\d", g)],
        "loaders": [g.lower() for g in f.get("gameVersions") or [] if g.lower() in CF_LOADERS],
        "downloadable": bool(f.get("downloadUrl")),
        "note": "" if f.get("downloadUrl") else "作者が外部ツールからのダウンロードを許可していないため、自動ダウンロードできません",
    }


def curseforge_latest(project_id, api_key, loaders=None, game_versions=None, stable_only=True):
    _need_key(api_key)
    params = {"pageSize": 50}
    loader_ids = [CF_LOADERS[x] for x in (loaders or []) if x in CF_LOADERS]
    if len(loader_ids) == 1:
        params["modLoaderType"] = loader_ids[0]
    if game_versions:
        params["gameVersion"] = game_versions[0]
    d = _json("GET", f"{CURSEFORGE}/mods/{int(project_id)}/files", api_key=api_key, params=params)
    files = d.get("data") or []
    if stable_only:
        files = [f for f in files if f.get("releaseType") == 1] or files  # 1=release 2=beta 3=alpha
    if not files:
        return None
    files.sort(key=lambda f: f.get("fileDate") or "", reverse=True)
    return _cf_file(files[0])


# --------------------------------------------------------------------------
# 共通
# --------------------------------------------------------------------------
def project_info(provider, project_id, api_key=None):
    if provider == "modrinth":
        return modrinth_project(project_id)
    if provider == "spigot":
        return spigot_project(project_id)
    if provider == "curseforge":
        return curseforge_project(project_id, api_key)
    raise SourceError("未対応の配布元です")


def latest(provider, project_id, *, loaders=None, game_versions=None, stable_only=True, api_key=None):
    if provider == "modrinth":
        return modrinth_latest(project_id, loaders, game_versions, stable_only)
    if provider == "spigot":
        return spigot_latest(project_id)
    if provider == "curseforge":
        return curseforge_latest(project_id, api_key, loaders, game_versions, stable_only)
    raise SourceError("未対応の配布元です")


_ALLOWED_DL_HOSTS = ("modrinth.com", "spiget.org", "forgecdn.net", "curseforge.com", "spigotmc.org")


ICON_HOSTS = ("modrinth.com", "forgecdn.net", "curseforge.com")


def image_type(b):
    """画像の種類(PNG / JPEG / GIF / WebP)を中身から判定する。SVG などは扱わない。"""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if b[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "image/webp"
    return ""


def fetch_icon(provider, project_id, api_key=None, limit=1024 * 1024):
    """配布元のプロジェクトのアイコン画像(bytes)を返す。無ければ None。"""
    if provider == "spigot":
        d = _json("GET", f"{SPIGET}/resources/{int(project_id)}")
        data = (d.get("icon") or {}).get("data") or ""
        if not data:
            return None
        b = base64.b64decode(data, validate=False)
        return b if image_type(b) and len(b) <= limit else None
    if provider == "modrinth":
        url = _json("GET", f"{MODRINTH}/project/{quote(str(project_id), safe='')}").get("icon_url") or ""
    elif provider == "curseforge":
        _need_key(api_key)
        m = _json("GET", f"{CURSEFORGE}/mods/{int(project_id)}", api_key=api_key)["data"]
        url = (m.get("logo") or {}).get("thumbnailUrl") or ""
    else:
        return None
    host = (urlsplit(url).hostname or "").lower()
    if not url.startswith("https://") or not any(host == h or host.endswith("." + h) for h in ICON_HOSTS):
        return None
    with _S.get(url, timeout=20, stream=True, allow_redirects=False) as r:
        if r.status_code != 200:
            return None
        b = b""
        for chunk in r.iter_content(65536):
            b += chunk
            if len(b) > limit:
                return None
    return b if image_type(b) else None


def download(url, dest, expected_sha1="", extra_hosts=()):
    """配布サイトからファイルをダウンロードする(https・既知のホストのみ、サイズ上限あり)。"""
    def check_host(u):
        p = urlsplit(u)
        host = (p.hostname or "").lower()
        if p.scheme != "https" or not any(host == h or host.endswith("." + h) for h in _ALLOWED_DL_HOSTS + tuple(extra_hosts)):
            raise SourceError(f"想定外のダウンロード先のため中止しました: {host}")

    # リダイレクトは自動で追わず、行き先を確かめてから1段ずつ進む(想定外のホストへ接続しないため)
    for _ in range(6):
        check_host(url)
        r = _req("GET", url, stream=True, timeout=(TIMEOUT, 120), allow_redirects=False,
                 ok=(200, 301, 302, 303, 307, 308))
        if r.status_code in (301, 302, 303, 307, 308):
            url = requests.compat.urljoin(url, r.headers.get("location", ""))
            r.close()
            continue
        break
    else:
        raise SourceError("リダイレクトが多すぎます")
    sha1 = hashlib.sha1()
    total = 0
    with open(dest, "wb") as out:
        for chunk in r.iter_content(1024 * 1024):
            total += len(chunk)
            if total > MAX_DOWNLOAD:
                raise SourceError("ファイルが大きすぎます")
            sha1.update(chunk)
            out.write(chunk)
    if total == 0:
        raise SourceError("ダウンロードしたファイルが空です")
    if expected_sha1 and sha1.hexdigest() != expected_sha1.lower():
        raise SourceError("ダウンロードしたファイルが壊れています(ハッシュ不一致)")
    return sha1.hexdigest()


# --------------------------------------------------------------------------
# 変更履歴(チェンジログ)
# --------------------------------------------------------------------------
class _TextOnly(HTMLParser):
    """HTML からテキストだけを取り出す(タグは一切残さないので、画面に出しても安全)。"""
    BLOCK = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "pre", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag == "li":
            self.out.append("・")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(html_text, limit=4000):
    p = _TextOnly()
    try:
        p.feed(html_text or "")
    except Exception:  # noqa: BLE001
        return re.sub(r"<[^>]+>", "", html_text or "")[:limit]
    text = "".join(p.out)
    text = re.sub(r"[ \t ]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:limit]


def changelogs(provider, project_id, *, have_versions=(), loaders=None, game_versions=None,
               stable_only=True, api_key=None, limit=5):
    """保存している版より新しい版の変更内容を、新しい順に最大 limit 件返す。[{version, date, text}]"""
    out = []

    def seen(v):
        return any(same_version(v, h) for h in have_versions)

    if provider == "modrinth":
        params = {"include_changelog": "true"}
        if loaders:
            params["loaders"] = json.dumps(loaders)
        if game_versions:
            params["game_versions"] = json.dumps(game_versions)
        vs = _json("GET", f"{MODRINTH}/project/{quote(project_id, safe='')}/version", params=params)
        if stable_only:
            vs = [v for v in vs if v.get("version_type") == "release"] or vs
        vs.sort(key=lambda v: v.get("date_published") or "", reverse=True)
        for v in vs:
            if seen(v.get("version_number")) or len(out) >= limit:
                break
            out.append({"version": v.get("version_number") or "", "date": v.get("date_published") or "",
                        "text": (v.get("changelog") or "").strip()[:4000] or "(変更内容の記載はありません)"})
    elif provider == "spigot":
        ups = _json("GET", f"{SPIGET}/resources/{int(project_id)}/updates", ok=(200, 404),
                    params={"size": limit, "sort": "-date"})
        from datetime import datetime, timezone
        for u in ups if isinstance(ups, list) else []:
            desc = u.get("description") or ""
            try:
                desc = base64.b64decode(desc).decode("utf-8", errors="replace")
            except (ValueError, TypeError):
                pass
            date = datetime.fromtimestamp(int(u["date"]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if u.get("date") else ""
            out.append({"version": u.get("title") or "", "date": date,
                        "text": html_to_text(desc) or "(変更内容の記載はありません)"})
    elif provider == "curseforge":
        info = curseforge_latest(project_id, api_key, loaders, game_versions, stable_only)
        if info and info.get("version_id"):
            d = _json("GET", f"{CURSEFORGE}/mods/{int(project_id)}/files/{int(info['version_id'])}/changelog",
                      api_key=api_key)
            out.append({"version": info.get("version") or "", "date": info.get("date") or "",
                        "text": html_to_text(d.get("data") or "") or "(変更内容の記載はありません)"})
    return out


# --------------------------------------------------------------------------
# 検索(パネルから配布サイトを探す)
# --------------------------------------------------------------------------
_MR_TYPES = {"plugin": "plugin", "mod": "mod", "datapack": "datapack", "resourcepack": "resourcepack", "shader": "shader", "modpack": "modpack"}
_CF_CLASS_OF = {"mod": 6, "plugin": 5, "resourcepack": 12, "datapack": 6945, "shader": 6552, "modpack": 4471}


def search(provider, q, *, kind=None, loader=None, mc=None, api_key=None, size=24):
    out = []
    if provider == "modrinth":
        facets = []
        if kind in _MR_TYPES:
            facets.append([f"project_type:{_MR_TYPES[kind]}"])
        if loader:
            facets.append([f"categories:{loader}"])
        if mc:
            facets.append([f"versions:{mc}"])
        params = {"query": q, "limit": size, "index": "relevance" if q else "downloads"}
        if facets:
            params["facets"] = json.dumps(facets)
        d = _json("GET", f"{MODRINTH}/search", params=params)
        for h in d.get("hits") or []:
            out.append({"provider": "modrinth", "project_id": h["project_id"], "title": h.get("title") or "",
                        "summary": h.get("description") or "", "author": h.get("author") or "",
                        "downloads": h.get("downloads") or 0, "icon": h.get("icon_url") or "",
                        "kind": h.get("project_type") or "", "updated": h.get("date_modified") or "",
                        "page_url": f"https://modrinth.com/{h.get('project_type', 'project')}/{h.get('slug')}"})
    elif provider == "curseforge":
        _need_key(api_key)
        params = {"gameId": CF_GAME_MINECRAFT, "searchFilter": q, "pageSize": size, "sortField": 2, "sortOrder": "desc"}
        if kind in _CF_CLASS_OF:
            params["classId"] = _CF_CLASS_OF[kind]
        if loader in CF_LOADERS:
            params["modLoaderType"] = CF_LOADERS[loader]
        if mc:
            params["gameVersion"] = mc
        d = _json("GET", f"{CURSEFORGE}/mods/search", api_key=api_key, params=params)
        for m in d.get("data") or []:
            out.append({"provider": "curseforge", "project_id": str(m["id"]), "title": m.get("name") or "",
                        "summary": m.get("summary") or "", "author": ((m.get("authors") or [{}])[0]).get("name", ""),
                        "downloads": int(m.get("downloadCount") or 0), "icon": (m.get("logo") or {}).get("thumbnailUrl") or "",
                        "kind": CF_CLASSES.get(m.get("classId"), ""), "updated": m.get("dateModified") or "",
                        "page_url": (m.get("links") or {}).get("websiteUrl") or ""})
    elif provider == "spigot":
        qq = re.sub(r"[^\w\s.-]+", " ", q or "").strip()
        if qq:
            d = _json("GET", f"{SPIGET}/search/resources/{quote(qq, safe='')}", ok=(200, 404),
                      params={"field": "name", "size": size, "sort": "-downloads"})
        else:
            d = _json("GET", f"{SPIGET}/resources", params={"size": size, "sort": "-downloads"})
        for x in d if isinstance(d, list) else []:
            icon = (x.get("icon") or {}).get("data") or ""
            out.append({"provider": "spigot", "project_id": str(x["id"]), "title": x.get("name") or "",
                        "summary": x.get("tag") or "", "author": "", "downloads": x.get("downloads") or 0,
                        "icon": f"data:image/png;base64,{icon}" if icon and re.fullmatch(r"[A-Za-z0-9+/=]+", icon) else "",
                        "kind": "plugin", "updated": "", "page_url": f"https://www.spigotmc.org/resources/{x['id']}/"})
    else:
        raise SourceError("未対応の配布元です")
    return out


def curseforge_files(file_ids, api_key):
    """{fileId: {url, file_name, sha1}}(Modパックの読み込み用)"""
    _need_key(api_key)
    out = {}
    for i in range(0, len(file_ids), 100):
        d = _json("POST", f"{CURSEFORGE}/mods/files", api_key=api_key, json={"fileIds": file_ids[i:i + 100]})
        for f in d.get("data") or []:
            info = _cf_file(f)
            out[int(f["id"])] = {"url": info["url"], "file_name": info["file_name"], "sha1": info["sha1"]}
    return out


# --------------------------------------------------------------------------
# バージョンの一覧(検索画面で、条件に合う版を選んでダウンロードする)
# --------------------------------------------------------------------------
def _mr_deps(version):
    out = []
    for d in version.get("dependencies") or []:
        if d.get("project_id") and d.get("dependency_type") in ("required", "optional"):
            out.append({"provider": "modrinth", "project_id": d["project_id"], "required": d["dependency_type"] == "required"})
    return out


def _cf_deps(f):
    out = []
    for d in f.get("dependencies") or []:
        if d.get("modId") and d.get("relationType") in (2, 3):  # 2=任意 3=必須
            out.append({"provider": "curseforge", "project_id": str(d["modId"]), "required": d["relationType"] == 3})
    return out


def versions(provider, project_id, *, loaders=None, game_versions=None, api_key=None, limit=30):
    """条件に合う版の一覧(新しい順)。各版に前提(deps)も付ける。"""
    out = []
    if provider == "modrinth":
        params = {"include_changelog": "false"}
        if loaders:
            params["loaders"] = json.dumps(loaders)
        if game_versions:
            params["game_versions"] = json.dumps(game_versions)
        vs = _json("GET", f"{MODRINTH}/project/{quote(project_id, safe='')}/version", params=params)
        vs.sort(key=lambda v: v.get("date_published") or "", reverse=True)
        for v in vs[:limit]:
            f = _mr_file(v)
            if f:
                f.update(type=v.get("version_type") or "release", deps=_mr_deps(v))
                out.append(f)
    elif provider == "curseforge":
        _need_key(api_key)
        params = {"pageSize": 50}
        ids = [CF_LOADERS[x] for x in (loaders or []) if x in CF_LOADERS]
        if len(ids) == 1:
            params["modLoaderType"] = ids[0]
        if game_versions:
            params["gameVersion"] = game_versions[0]
        files = _json("GET", f"{CURSEFORGE}/mods/{int(project_id)}/files", api_key=api_key, params=params).get("data") or []
        files.sort(key=lambda f: f.get("fileDate") or "", reverse=True)
        for f in files[:limit]:
            info = _cf_file(f)
            info.update(type={1: "release", 2: "beta", 3: "alpha"}.get(f.get("releaseType"), "release"), deps=_cf_deps(f))
            out.append(info)
    elif provider == "spigot":
        info = spigot_latest(project_id)  # Spiget は最新版しかダウンロードできない
        info.update(type="release", deps=[])
        out.append(info)
    else:
        raise SourceError("未対応の配布元です")
    return out


def version_info(provider, project_id, version_id, api_key=None):
    """特定の版の情報(ダウンロード用)。"""
    if provider == "modrinth":
        v = _json("GET", f"{MODRINTH}/version/{quote(str(version_id), safe='')}")
        if v.get("project_id") != project_id:
            raise SourceError("バージョンの指定が正しくありません")
        f = _mr_file(v)
        f.update(deps=_mr_deps(v))
        return f
    if provider == "curseforge":
        _need_key(api_key)
        f = _json("GET", f"{CURSEFORGE}/mods/{int(project_id)}/files/{int(version_id)}", api_key=api_key).get("data") or {}
        info = _cf_file(f)
        info.update(deps=_cf_deps(f))
        return info
    if provider == "spigot":
        info = spigot_latest(project_id)
        info.update(deps=[])
        return info
    raise SourceError("未対応の配布元です")


def project_titles(provider, ids, api_key=None):
    """前提の名前を表示するため、プロジェクトIDから名前を引く。{id: {"title", "page_url"}}"""
    ids = [i for i in dict.fromkeys(ids) if i]
    if not ids:
        return {}
    out = {}
    if provider == "modrinth":
        for p in _json("GET", f"{MODRINTH}/projects", params={"ids": json.dumps(ids)}):
            out[p["id"]] = {"title": p.get("title") or p["id"],
                            "page_url": f"https://modrinth.com/{p.get('project_type', 'project')}/{p.get('slug') or p['id']}"}
    elif provider == "curseforge" and api_key:
        d = _json("POST", f"{CURSEFORGE}/mods", api_key=api_key, json={"modIds": [int(i) for i in ids]})
        for m in d.get("data") or []:
            out[str(m["id"])] = {"title": m.get("name") or str(m["id"]), "page_url": (m.get("links") or {}).get("websiteUrl") or ""}
    return out
