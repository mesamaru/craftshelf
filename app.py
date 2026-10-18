#!/usr/bin/env python3
"""CraftShelf の入口(gunicorn の app:app・launcher.py・python app.py から読み込む)。

本体は craftshelf パッケージにある。ここでは、これまでどおり app.<名前> で中身を参照できるように、
各モジュールの名前をまとめて見せる(テストや外部のスクリプトのため)。
"""
import os

import craftshelf
from craftshelf import app, running_version

for _m in craftshelf.MODULES:
    globals().update({k: v for k, v in vars(_m).items() if not k.startswith("__")})
del _m

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"{craftshelf.core.APP_NAME} {running_version()}: http://{host}:{port}  (ローカル保存先: {craftshelf.core.LOCAL_DIR})")
    app.run(host=host, port=port, threaded=True)
