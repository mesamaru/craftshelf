"""v03(開発版)への切り替え(Docker・install.sh で動かしているとき)。

v03 は Node.js で動くので、GitHub のプレリリース(dev-v03.xx.xx)に付いた「ビルド済みの一式」と、公式の Node.js を
/data/v03 に取ってきて(どちらもチェックサムで確かめる)、次の起動から v03 で動かす。乗り換えは、Docker なら
gunicorn.conf.py(gunicorn がポートを開く前に読む)、install.sh なら launcher.py が maybe_exec() で行う。
v03 は v02 のデータを読むだけなので、v03 の画面の「イメージの版に戻す」(= versions/current を消す)で v02 に戻れる。
"""
import hashlib
import io
import os
import platform
import re
import shutil
import signal
import sys
import tarfile
from pathlib import Path

import requests

REPO = "mesamaru/craftshelf"
NODE_INDEX = "https://nodejs.org/dist/latest-v24.x/"
_TAG = re.compile(r"^(dev-)?v(03\.\d{2}\.\d{2})$")  # v03.xx.xx = 安定版 / dev-v03.xx.xx = 開発版
_UA = {"User-Agent": "craftshelf"}


class SwitchError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def data_dir():
    return Path(os.environ.get("DATA_DIR") or Path(__file__).resolve().parent / "data")


def _root():
    return data_dir() / "v03"


def unsupported():
    """切り替えられない理由(切り替えられるなら None)。"""
    if getattr(sys, "frozen", False):
        return "インストーラー版は、まだ v03 に対応していません(Docker で試せます)"
    if not sys.platform.startswith("linux"):
        return "v03 への切り替えは、Linux(Docker・install.sh)で動かしているときだけできます"
    if not _arch():
        return f"この CPU({platform.machine()})では v03 を動かせません"
    return None


def _arch():
    return {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())


def _get(url, timeout=(15, 300)):
    try:
        r = requests.get(url, timeout=timeout, headers=_UA)
    except requests.RequestException as e:
        raise SwitchError(f"ダウンロードできません({e.__class__.__name__})")
    if r.status_code != 200:
        raise SwitchError(f"ダウンロードできません(HTTP {r.status_code})")
    return r


def sum_for(text, name):
    """SHA256SUMS(sha256sum の形)から、そのファイルの値。"""
    for line in (text or "").splitlines():
        m = re.match(r"^([0-9a-f]{64})\s+\*?(.+)$", line.strip())
        if m and m.group(2) == name:
            return m.group(1)
    return None


def pick_releases(items):
    """GitHub のリリースの一覧から、一式と SHA256SUMS がそろった v03 の版(新しい順)。"""
    out = []
    for r in items if isinstance(items, list) else []:
        m = _TAG.match(str((r or {}).get("tag_name") or ""))
        if not m:
            continue
        version, stable = m.group(2), not m.group(1)
        assets = {a.get("name"): a.get("browser_download_url") for a in r.get("assets") or [] if isinstance(a, dict)}
        url, sums = assets.get(f"craftshelf-v03-{version}.tar.gz"), assets.get("SHA256SUMS")
        if url and sums:
            out.append({"version": version, "stable": stable, "url": url, "sums_url": sums, "notes": str(r.get("body") or "")[:2000],
                        "published_at": r.get("published_at") or ""})
    # 同じ版が安定版と開発版の両方にあれば、安定版を使う
    best = {}
    for r in out:
        if r["version"] not in best or r["stable"]:
            best[r["version"]] = r
    return sorted(best.values(), key=lambda x: x["version"], reverse=True)


def preflight(conn):
    """v03 に移るときに引き継がないもの(画面で先に知らせる)。v03 の取り込み(import-v02.ts)に合わせる。"""
    def n(sql):
        try:
            return conn.execute(sql).fetchone()[0] or 0
        except Exception:  # noqa: BLE001  古い版のデータで表が無いとき
            return 0

    def setting(key):
        try:
            r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return r[0] if r else ""
        except Exception:  # noqa: BLE001
            return ""

    out = []
    other = n("SELECT COUNT(*) FROM items WHERE category NOT IN ('plugin', 'mod')")
    if other:
        out.append(f"データパック・リソースパックなど {other} 件(v03 はプラグインと Mod だけを扱います)")
    if n("SELECT COUNT(*) FROM passkeys"):
        out.append("パスキー(移ったあとで登録し直してください)")
    if n("SELECT COUNT(*) FROM api_tokens"):
        out.append("API トークン(v03 で作り直してください)")
    if n("SELECT COUNT(*) FROM shares"):
        out.append("共有リンク(v03 で作り直してください)")
    if setting("discord_webhook"):
        out.append("Discord への通知の設定(v03 の「チーム」で設定し直してください)")
    if n("SELECT COUNT(*) FROM set_items WHERE version_id IS NOT NULL"):
        out.append("セットの版の固定(v03 はいつもサーバーに合う新しい版を入れます)")
    if n("SELECT COUNT(*) FROM users WHERE perms IS NOT NULL AND perms != '' AND perms != '[]'"):
        out.append("ユーザーに個別に付けた権限(v03 の役割に置き換わります)")
    if n("SELECT COUNT(*) FROM users WHERE totp_enabled=1"):
        out.append("二段階認証の予備のコード(認証アプリのコードはそのまま使えます)")
    return out


def releases():
    return pick_releases(_get(f"https://api.github.com/repos/{REPO}/releases?per_page=50", timeout=15).json())


def _fetch_verified(url, sums_text, name, note):
    want = sum_for(sums_text, name)
    if not want:
        raise SwitchError(f"{name} を確かめるための値がありません")
    note(f"{name} をダウンロードしています…")
    blob = _get(url).content
    if hashlib.sha256(blob).hexdigest() != want:
        raise SwitchError(f"{name} が壊れています(チェックサムが合いません)")
    return blob


def _extract(blob, dest):
    """tar.gz を dest に展開する(中身がフォルダの外へ出るものは受け付けない)。"""
    tmp = dest.with_name(dest.name + ".part")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
        t.extractall(tmp, filter="data")
    shutil.rmtree(dest, ignore_errors=True)
    tmp.rename(dest)


def install(version, note=print):
    """その版の一式と Node.js を取ってきて、次の起動で v03 を使うようにする。"""
    reason = unsupported()
    if reason:
        raise SwitchError(reason)
    rel = next((r for r in releases() if r["version"] == version), None)
    if not rel:
        raise SwitchError("その版は見つかりません")
    root = _root()
    versions, nodes = root / "versions", root / "node"
    name = f"craftshelf-v03-{version}.tar.gz"
    blob = _fetch_verified(rel["url"], _get(rel["sums_url"], timeout=15).text, name, note)
    _extract(blob, versions / version)
    if not (versions / version / ".output" / "server" / "index.mjs").is_file():
        raise SwitchError("一式の中身が足りません")

    sums = _get(NODE_INDEX + "SHASUMS256.txt", timeout=15).text
    m = re.search(rf"\s(node-v24\.\d+\.\d+-linux-{_arch()})\.tar\.gz$", sums, re.M)
    if not m:
        raise SwitchError("この CPU 向けの Node.js が見つかりません")
    node_name = m.group(1)
    if not (nodes / node_name / node_name / "bin" / "node").is_file():
        _extract(_fetch_verified(NODE_INDEX + node_name + ".tar.gz", sums, node_name + ".tar.gz", note), nodes / node_name)
    # Node.js の tar.gz は中に node-v…/ のフォルダが 1 つある
    (nodes / "current").write_text(node_name + "/" + node_name + "\n", encoding="utf-8")
    (versions / "current").write_text(version + "\n", encoding="utf-8")
    note(f"v{version} に切り替える準備ができました")


def maybe_exec(port, host="0.0.0.0"):
    """v03 に切り替えていれば、このプロセスを v03(Node.js)に置き換える。切り替えていなければ何もしない。

    前回 v03 がうまく起動しなかった(v03 が消す .starting が残っている)ときは、v02 で起動する。
    """
    root = _root()
    cur = root / "versions" / "current"
    if not cur.is_file():
        return
    version = re.sub(r"[^0-9.]", "", cur.read_text(encoding="utf-8"))
    d = root / "versions" / version
    marker = d / ".starting"
    node_cur = root / "node" / "current"
    node = root / "node" / re.sub(r"[^\w.\-/]", "", node_cur.read_text(encoding="utf-8").strip()) / "bin" / "node" if node_cur.is_file() else None
    if marker.exists() or not (d / ".output" / "server" / "index.mjs").is_file() or not node or not node.is_file():
        print(f"[v03] v{version} を起動できなかったので、v02 で起動します", flush=True)
        cur.unlink(missing_ok=True)
        marker.unlink(missing_ok=True)
        return
    marker.touch()
    env = {**os.environ, "NODE_ENV": "production", "PORT": str(port), "HOST": host, "DATA_DIR": str(data_dir()),
           "V02_CONFIG_DIR": os.environ.get("CONFIG_DIR") or os.environ.get("DB_DIR") or str(data_dir()),
           "CRAFTSHELF_MODE": "self", "MIGRATIONS_DIR": str(d / "drizzle")}
    print(f"[v03] v{version} で起動します", flush=True)
    os.chdir(d)
    os.execve(str(node), [str(node), ".output/server/index.mjs"], env)


def restart():
    """プロセスを終わらせて、Docker(restart の設定)・systemd に起動し直してもらう。"""
    if "gunicorn" in sys.modules or "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
        os.kill(os.getppid(), signal.SIGTERM)  # gunicorn の親(コンテナの最初のプロセス)ごと終わらせる
    else:
        os._exit(0)
