# gunicorn は起動のたびに、この場所(/app)の gunicorn.conf.py を読む(Docker の CMD)。
# v03(開発版)に切り替えていれば、ポートを開く前に v03 に乗り換える(v03switch.py)
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v03switch  # noqa: E402

v03switch.maybe_exec(int(os.environ.get("PORT") or 8080))
