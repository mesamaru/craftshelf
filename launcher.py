"""CraftShelf を Docker なしで起動する(Windows / macOS / Linux)。

- インストーラー版(Windows / macOS)はこのファイルを実行ファイルにしたもの。タスクトレイ(メニューバー)に
  アイコンを出し、ブラウザで画面を開く。
- Linux のサーバーでは install.sh が systemd から  --no-browser --no-tray  で起動する。

設定は引数・環境変数、または保存先フォルダの launcher.json({"host": "0.0.0.0", "port": 8765})で変えられる。
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

APP_NAME = "CraftShelf"
FROZEN = getattr(sys, "frozen", False)


def default_data_dir():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "craftshelf"


def resource(name):
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / name


def open_folder(path):
    try:
        if os.name == "nt":
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except OSError:
        pass


def parse_args():
    ap = argparse.ArgumentParser(prog="craftshelf", description=f"{APP_NAME} を起動します")
    ap.add_argument("--data-dir", help="保存先フォルダ(既定: ユーザーのアプリデータ)")
    ap.add_argument("--host", help="待ち受けるアドレス(既定 127.0.0.1。LAN の他の端末から使うなら 0.0.0.0)")
    ap.add_argument("--port", type=int, help="ポート(既定 8765)")
    ap.add_argument("--no-browser", action="store_true", help="起動時にブラウザを開かない")
    ap.add_argument("--no-tray", action="store_true", help="タスクトレイのアイコンを出さない")
    return ap.parse_args()


def main():
    args = parse_args()
    data_dir = Path(args.data_dir or os.environ.get("DATA_DIR") or default_data_dir()).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["DATA_DIR"] = str(data_dir)
    os.environ.setdefault("CRAFTSHELF_NATIVE", "1")

    conf = {}
    try:
        conf = json.loads((data_dir / "launcher.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    host = args.host or os.environ.get("HOST") or conf.get("host") or "127.0.0.1"
    port = int(args.port or os.environ.get("PORT") or conf.get("port") or 8765)

    # ウィンドウを持たない実行ファイルでは標準出力が無いので、ログをファイルに書く
    if FROZEN or sys.stdout is None:
        log = open(data_dir / "craftshelf.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        sys.stdout = sys.stderr = log

    import app as craftshelf  # 環境変数を決めてから読み込む
    from waitress import create_server

    try:
        server = create_server(craftshelf.app, host=host, port=port, threads=8,
                               channel_timeout=3600, max_request_body_size=8 * 1024 ** 3)
    except OSError as e:
        print(f"{host}:{port} で起動できません(ほかのプログラムが使っている可能性があります): {e}", flush=True)
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{port}/")  # すでに起動している CraftShelf を開く
        sys.exit(1)

    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}/"
    print(f"{APP_NAME} {craftshelf.running_version()}: {url}  (保存先: {data_dir})", flush=True)
    threading.Thread(target=server.run, daemon=True, name="http").start()
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, [url]).start()

    if not args.no_tray and run_tray(url, data_dir, server):
        return
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.close()


def run_tray(url, data_dir, server):
    """タスクトレイ(macOS はメニューバー)にアイコンを出す。使えない環境では False を返す。"""
    try:
        import pystray
        from PIL import Image
        image = Image.open(resource("packaging/icon.png"))
    except Exception:  # noqa: BLE001
        return False

    def quit_(icon, _item):
        icon.stop()
        server.close()

    menu = pystray.Menu(
        pystray.MenuItem(f"{APP_NAME} を開く", lambda *_: webbrowser.open(url), default=True),
        pystray.MenuItem("保存先フォルダを開く", lambda *_: open_folder(data_dir)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("終了", quit_),
    )
    try:
        pystray.Icon("craftshelf", image, APP_NAME, menu).run()
    except Exception:  # noqa: BLE001
        return False
    return True


if __name__ == "__main__":
    main()
