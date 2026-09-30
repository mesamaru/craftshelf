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
        r = requests.get(url, params={"ref": BRANCH}, timeout=15,
                         headers={"Accept": "application/vnd.github.raw", "User-Agent": "craftshelf"})
        if r.status_code == 200:
            return r.text
        if r.status_code == 404:
            raise UpdateError(f"GitHub に {path} が見つかりません({REPO} / {BRANCH})")
    except requests.RequestException:
        pass
    # API の回数制限などで失敗したら raw を試す
    try:
        r = requests.get(f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{path}", timeout=15,
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


_cache = {"at": 0.0, "data": None}
_cache_lock = threading.Lock()


def check(force=False):
    with _cache_lock:
        if not force and _cache["data"] and time.monotonic() - _cache["at"] < CHECK_TTL:
            return dict(_cache["data"], current=current_version())
    cur = current_version()
    data = {"repo": REPO, "branch": BRANCH, "current": cur, "latest": None, "update_available": False,
            "notes": [], "error": None, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "mode": MODE, "download_url": f"https://github.com/{REPO}/releases/latest"}
    try:
        latest = _latest_release() if FROZEN else _github_file("VERSION").strip()
        if not parse_version(latest):
            raise UpdateError(f"GitHub の VERSION の形式が不正です: {latest[:20]}")
        data["latest"] = latest
        data["update_available"] = parse_version(latest) > parse_version(cur)
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
    try:
        r = requests.get(f"https://api.github.com/repos/{REPO}/releases/latest", timeout=15,
                         headers={"Accept": "application/vnd.github+json", "User-Agent": "craftshelf"})
    except requests.RequestException as e:
        raise UpdateError(f"GitHub に接続できません: {e}") from e
    if r.status_code == 404:
        raise UpdateError("GitHub にリリースがまだありません")
    if r.status_code != 200:
        raise UpdateError(f"GitHub からリリース情報を取得できません(HTTP {r.status_code})")
    return str(r.json().get("tag_name") or "").lstrip("vV").strip()


def _run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, **kw)
    if r.returncode != 0:
        raise UpdateError(f"{cmd[0]} が失敗しました: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout.strip()


def apply(note=print):
    """最新版を取得して /app を入れ替える。成功したら (旧, 新) を返す(再起動は restart() で別に行う)。"""
    if FROZEN:
        raise UpdateError("インストーラー版は、新しいインストーラーをダウンロードして上書きインストールしてください")
    if os.name != "posix":
        raise UpdateError("この環境(Windows での直接実行)では自動更新できません。Docker で動かしてください")
    for tool in ("git", "rsync"):
        if not shutil.which(tool):
            raise UpdateError(f"{tool} が見つかりません(Docker イメージを作り直してください)")
    old = current_version()
    work = Path(tempfile.mkdtemp(prefix="craftshelf-update-"))
    try:
        note(f"GitHub ({REPO} / {BRANCH}) から最新版をダウンロードしています…")
        _run(["git", "clone", "--depth", "1", "--branch", BRANCH, f"https://github.com/{REPO}.git", str(work / "src")])
        src = work / "src"
        new = (src / "VERSION").read_text(encoding="utf-8").strip() if (src / "VERSION").exists() else ""
        if not parse_version(new):
            raise UpdateError("取得したコードに正しい VERSION がありません")
        if parse_version(new) <= parse_version(old):
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


def restart(delay=1.5):
    """新しいコードで動かし直す。gunicorn なら親プロセスに HUP を送り、ワーカーを入れ替えてもらう。"""
    def go():
        time.sleep(delay)
        if "gunicorn" in sys.modules or "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
            os.kill(os.getppid(), signal.SIGHUP)
        else:
            os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=go, daemon=True).start()
