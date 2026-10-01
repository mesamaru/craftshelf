"""CraftShelf 自身のアップデート(GitHub から最新版を取得して入れ替え、再起動する)。

バージョンはリポジトリ直下の VERSION ファイルに「00.00.00」(メジャー.マイナー.修正)の形で書く。
更新内容は CHANGELOG.md の「## 01.02.03 - 2026-09-30」形式の見出しごとに書く。
"""
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent
REPO = (os.environ.get("GITHUB_REPO") or "").strip() or "mesamaru/craftshelf"
BRANCH = (os.environ.get("GITHUB_BRANCH") or "").strip() or "main"
DEV_BRANCH = (os.environ.get("GITHUB_DEV_BRANCH") or "").strip() or "dev"
# 受け取る版: "stable"(main ブランチ・正式リリース)/ "dev"(dev ブランチ・プレリリース)。app.py が設定から入れる
CHANNEL = "stable"
_cache_lock = threading.Lock()
_cache = {"at": 0.0, "data": None}


def set_channel(ch):
    global CHANNEL
    CHANNEL = "dev" if ch == "dev" else "stable"
    with _cache_lock:
        _cache.update(at=0.0, data=None)


def branch():
    return DEV_BRANCH if CHANNEL == "dev" else BRANCH
CHECK_TTL = 600  # 秒。GitHub への確認結果をこの間は使い回す
# インストーラー版(実行ファイル)は自分自身を書き換えられないので、GitHub のリリースを見て
# 新しいインストーラーのダウンロードを案内する。それ以外(Docker・git から入れたもの)はコードを入れ替える。
FROZEN = getattr(sys, "frozen", False)
MODE = "installer" if FROZEN else "git"

_VER_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


class UpdateError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def parse_version(v):
    m = _VER_RE.match((v or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def current_version():
    try:
        v = (BASE_DIR / "VERSION").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return "00.00.00"
    return v if parse_version(v) else "00.00.00"


def build_info():
    """entrypoint.sh / 自己更新が書く、取得元のコミット情報(無ければ None)。"""
    try:
        return (BASE_DIR / ".version").read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def _github_file(path):
    """GitHub API 経由でファイルを取得(raw.githubusercontent.com はキャッシュで数分遅れることがあるため)。"""
    url = f"https://api.github.com/repos/{REPO}/contents/{path}"
    try:
        r = requests.get(url, params={"ref": branch()}, timeout=15,
                         headers={"Accept": "application/vnd.github.raw", "User-Agent": "craftshelf"})
        if r.status_code == 200:
            return r.text
        if r.status_code == 404:
            raise UpdateError(f"GitHub に {path} が見つかりません({REPO} / {branch()})")
    except requests.RequestException:
        pass
    # API の回数制限などで失敗したら raw を試す
    try:
        r = requests.get(f"https://raw.githubusercontent.com/{REPO}/{branch()}/{path}", timeout=15,
                         headers={"User-Agent": "craftshelf"})
    except requests.RequestException:
        raise UpdateError("GitHub に接続できません(インターネット接続を確認してください)")
    if r.status_code != 200:
        raise UpdateError(f"GitHub から取得できません (HTTP {r.status_code})")
    return r.text


def parse_changelog(text):
    """[{version, title, body}] を新しい順に返す。"""
    out, cur = [], None
    for line in (text or "").splitlines():
        m = re.match(r"^##\s+(\d{1,3}\.\d{1,3}\.\d{1,3})\b\s*[-–—]?\s*(.*)$", line)
        if m:
            cur = {"version": m.group(1), "title": m.group(2).strip(), "body": ""}
            out.append(cur)
        elif cur is not None:
            cur["body"] += line + "\n"
    for c in out:
        c["body"] = c["body"].strip()
    return out




def check(force=False):
    with _cache_lock:
        if not force and _cache["data"] and time.monotonic() - _cache["at"] < CHECK_TTL:
            return dict(_cache["data"], current=current_version())
    cur = current_version()
    data = {"repo": REPO, "branch": branch(), "channel": CHANNEL, "current": cur, "latest": None, "update_available": False,
            "downgrade": False,
            "notes": [], "error": None, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "mode": MODE, "download_url": f"https://github.com/{REPO}/releases/latest"}
    try:
        if FROZEN:
            latest, asset = _release_info()
            data["asset"] = asset
            data["can_apply"] = bool(asset and asset["url"] and asset["sha256"])
        else:
            latest = _github_file("VERSION").strip()
            data["can_apply"] = True
        if not parse_version(latest):
            raise UpdateError(f"GitHub の VERSION の形式が不正です: {latest[:20]}")
        data["latest"] = latest
        data["update_available"] = parse_version(latest) > parse_version(cur)
        # 開発ビルドから安定版に戻すとき(安定版の方が古い)は「安定版に戻す」を出す
        data["downgrade"] = CHANNEL == "stable" and parse_version(latest) < parse_version(cur)
        try:
            notes = parse_changelog(_github_file("CHANGELOG.md"))
        except UpdateError:
            notes = []
        data["notes"] = [n for n in notes if parse_version(n["version"]) and
                         parse_version(cur) < parse_version(n["version"]) <= parse_version(latest)][:20]
    except UpdateError as e:
        data["error"] = e.message
    with _cache_lock:
        _cache.update(at=time.monotonic(), data=data)
    return data


def _latest_release():
    """GitHub の最新リリースのバージョン(タグ v01.02.03 → 01.02.03)。"""
    return _release_info()[0]


def _tag_version(tag):
    """v01.02.03 / dev-v01.02.03 → 01.02.03"""
    return re.sub(r"^(dev-)?[vV]", "", str(tag or "")).strip()


def _asset_suffix():
    """この OS 向けの配布ファイルの名前の末尾。"""
    import platform
    if os.name == "nt":
        return ".exe"
    if sys.platform == "darwin":
        return "-macos-arm64.dmg" if platform.machine() == "arm64" else "-macos-x64.dmg"
    return "-linux-x64.tar.gz"


def _release_info():
    """(バージョン, この OS 向けの配布ファイル {name, url, size, sha256} または None)。"""
    url = f"https://api.github.com/repos/{REPO}/releases" + ("?per_page=30" if CHANNEL == "dev" else "/latest")
    try:
        r = requests.get(url, timeout=15, headers={"Accept": "application/vnd.github+json", "User-Agent": "craftshelf"})
    except requests.RequestException as e:
        raise UpdateError(f"GitHub に接続できません: {e}") from e
    if r.status_code == 404:
        raise UpdateError("GitHub にリリースがまだありません")
    if r.status_code != 200:
        raise UpdateError(f"GitHub からリリース情報を取得できません(HTTP {r.status_code})")
    d = r.json()
    if isinstance(d, list):  # 開発ビルド: 一覧からいちばん新しい版
        d = [x for x in d if not x.get("draft") and parse_version(_tag_version(x.get("tag_name")))]
        if not d:
            raise UpdateError("GitHub にリリースがまだありません")
        d = max(d, key=lambda x: parse_version(_tag_version(x.get("tag_name"))))
    ver = _tag_version(d.get("tag_name"))
    asset = None
    for a in d.get("assets") or []:
        if str(a.get("name", "")).endswith(_asset_suffix()) and str(a.get("name", "")).startswith("CraftShelf"):
            digest = str(a.get("digest") or "")
            asset = {"name": a["name"], "url": a.get("browser_download_url") or "", "size": int(a.get("size") or 0),
                     "sha256": digest.split(":", 1)[1] if digest.startswith("sha256:") else ""}
            break
    return ver, asset


def _run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, **kw)
    if r.returncode != 0:
        raise UpdateError(f"{cmd[0]} が失敗しました: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout.strip()


def apply(note=print):
    """最新版を取得して /app を入れ替える。成功したら (旧, 新) を返す(再起動は restart() で別に行う)。"""
    if FROZEN:
        return _apply_installer(note)
    if os.name != "posix":
        raise UpdateError("この環境(Windows での直接実行)では自動更新できません。Docker で動かしてください")
    for tool in ("git", "rsync"):
        if not shutil.which(tool):
            raise UpdateError(f"{tool} が見つかりません(Docker イメージを作り直してください)")
    old = current_version()
    work = Path(tempfile.mkdtemp(prefix="craftshelf-update-"))
    try:
        note(f"GitHub ({REPO} / {branch()}) から最新版をダウンロードしています…")
        _run(["git", "clone", "--depth", "1", "--branch", branch(), f"https://github.com/{REPO}.git", str(work / "src")])
        src = work / "src"
        new = (src / "VERSION").read_text(encoding="utf-8").strip() if (src / "VERSION").exists() else ""
        if not parse_version(new):
            raise UpdateError("取得したコードに正しい VERSION がありません")
        if parse_version(new) == parse_version(old) or (parse_version(new) < parse_version(old) and CHANNEL != "stable"):
            raise UpdateError(f"すでに最新です(現在 {old} / GitHub {new})")
        if not (src / "app.py").exists():
            raise UpdateError("取得したコードに app.py がありません")
        old_req = (BASE_DIR / "requirements.txt").read_text(encoding="utf-8") if (BASE_DIR / "requirements.txt").exists() else ""
        new_req = (src / "requirements.txt").read_text(encoding="utf-8") if (src / "requirements.txt").exists() else ""
        if new_req and new_req != old_req:
            note("必要なライブラリをインストールしています…")
            _run([sys.executable, "-m", "pip", "install", "--no-cache-dir", "--quiet", "-r", str(src / "requirements.txt")])
        commit = _run(["git", "-C", str(src), "rev-parse", "--short", "HEAD"])
        note(f"インストールしています… ({old} → {new})")
        _run(["rsync", "-a", "--delete", "--exclude", ".git", "--exclude", "data", "--exclude", ".version",
              str(src) + "/", str(BASE_DIR) + "/"])
        (BASE_DIR / ".version").write_text(f"{commit} ({time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})\n",
                                           encoding="utf-8")
        with _cache_lock:
            _cache.update(at=0.0, data=None)
        return old, new
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------
# インストーラー版(Windows / macOS / Linux の実行ファイル)の更新
# --------------------------------------------------------------------------
def _download_asset(asset, dest, note):
    """配布ファイルをダウンロードし、GitHub が公開している SHA-256 と一致するか確かめる。"""
    import hashlib
    if not asset or not asset.get("url") or not asset.get("sha256"):
        raise UpdateError("この OS 向けの配布ファイルが見つかりません。GitHub のリリースから手動でダウンロードしてください")
    note(f"{asset['name']} をダウンロードしています…")
    h = hashlib.sha256()
    size = 0
    try:
        with requests.get(asset["url"], stream=True, timeout=60, headers={"User-Agent": "craftshelf"}) as r:
            if r.status_code != 200:
                raise UpdateError(f"ダウンロードできません(HTTP {r.status_code})")
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1024 * 256):
                    size += len(chunk)
                    if size > 600 * 1024 * 1024:
                        raise UpdateError("ファイルが大きすぎます")
                    h.update(chunk)
                    f.write(chunk)
    except requests.RequestException as e:
        raise UpdateError(f"ダウンロードできません: {e}") from e
    if h.hexdigest() != asset["sha256"].lower():
        raise UpdateError("ダウンロードしたファイルが壊れているか、改ざんされています(SHA-256 が一致しません)")


def _detach(cmd):
    """この CraftShelf が終了しても動き続けるように、別のプロセスとして起動する。"""
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen(cmd, **kw)


def _exit_soon(delay=2.0):
    """インストーラーがファイルを置き換えられるよう、少し待ってからこの CraftShelf を終了する。"""
    def go():
        time.sleep(delay)
        os._exit(0)
    threading.Thread(target=go, daemon=True).start()


def _apply_installer(note):
    info = check(force=True)
    if info["error"]:
        raise UpdateError(info["error"])
    if not info["update_available"] and not info.get("downgrade"):
        raise UpdateError("すでに最新です")
    asset = info.get("asset")
    work = Path(tempfile.mkdtemp(prefix="craftshelf-update-"))
    dest = work / asset["name"] if asset else work / "update"
    _download_asset(asset, dest, note)
    note("インストールしています…(このあと CraftShelf が再起動します)")
    pid = os.getpid()
    exe = Path(sys.executable).resolve()
    if os.name == "nt":
        # Inno Setup を画面なしで実行する。終わると CraftShelf が自動で起動し直す(craftshelf.iss の [Run])
        _detach([str(dest), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", f"/LOG={work / 'install.log'}"])
    elif sys.platform == "darwin":
        app = next((p for p in exe.parents if p.suffix == ".app"), None)
        if not app:
            raise UpdateError("アプリの場所が分かりません。手動でアップデートしてください")
        script = work / "update.sh"
        script.write_text(f"""#!/bin/sh
while kill -0 {pid} 2>/dev/null; do sleep 0.5; done
MNT="{work}/mnt"; mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "{dest}" >/dev/null || exit 1
rm -rf "{app}.old"; mv "{app}" "{app}.old" && ditto "$MNT/CraftShelf.app" "{app}" && rm -rf "{app}.old" || mv "{app}.old" "{app}"
hdiutil detach "$MNT" >/dev/null
open "{app}" --args --no-browser
""", encoding="utf-8")
        _detach(["/bin/sh", str(script)])
    else:
        appdir = exe.parent
        script = work / "update.sh"
        script.write_text(f"""#!/bin/sh
while kill -0 {pid} 2>/dev/null; do sleep 0.5; done
mkdir -p "{work}/new" && tar -xzf "{dest}" -C "{work}/new" || exit 1
NEW="$(find "{work}/new" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
rm -rf "{appdir}.old"; mv "{appdir}" "{appdir}.old" && mv "$NEW" "{appdir}" && rm -rf "{appdir}.old" || mv "{appdir}.old" "{appdir}"
nohup "{appdir}/{exe.name}" --no-browser >/dev/null 2>&1 &
""", encoding="utf-8")
        _detach(["/bin/sh", str(script)])
    with _cache_lock:
        _cache.update(at=0.0, data=None)
    _exit_soon()
    return info["current"], info["latest"]


def restart(delay=1.5):
    """新しいコードで動かし直す。gunicorn なら親プロセスに HUP を送り、ワーカーを入れ替えてもらう。"""
    if FROZEN:
        return  # インストーラー版は _apply_installer が終了・再起動まで行う

    def go():
        time.sleep(delay)
        if "gunicorn" in sys.modules or "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
            os.kill(os.getppid(), signal.SIGHUP)
        else:
            os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=go, daemon=True).start()
