"""CraftShelf 本体。層ごとのモジュールに分かれている(下の層は上の層を使わない)。

core → analysis → auth → events → jobs → library → accounts → upstream → servers → system

読み込むと、すべての API を登録する。データベースの準備と予約の処理は start() で始める
(テストなどで、個々のモジュールだけを読み込めるように)。
"""
from . import core, analysis, auth, events, jobs, library, accounts, upstream, servers, system  # noqa: F401(API の登録)
from .core import app, get_setting, init_storage, running_version
from .system import _migrate_mod_filters, start_scheduler

import selfupdate

MODULES = (core, analysis, auth, events, jobs, library, accounts, upstream, servers, system)

_started = False


def start():
    """データベースを準備し、予約の処理を始める(app.py・launcher から一度だけ呼ぶ)。"""
    global _started
    if _started:
        return
    _started = True
    init_storage()
    with app.app_context():
        selfupdate.set_channel(get_setting("update_channel", "stable"))
        try:
            _migrate_mod_filters()
        except Exception:  # noqa: BLE001
            app.logger.exception("migrate mod filters")
    start_scheduler()
