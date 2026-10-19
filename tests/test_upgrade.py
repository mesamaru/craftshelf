"""古い版のデータを今の版で開けるか・今の版のデータを橋渡しの版(01.24)で開けるかを、本物の古いコードで試す。

git のタグ(v01.12.00・dev-v01.24.00)を使う。タグが無い環境(浅い clone など)では飛ばす。
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent / "upgrade"
OLD = "v01.12.00"      # 01.13 の持ち主の移行より前
BRIDGE = "dev-v01.24.00"  # 02 の保存方法を読める最初の 01


def _git(*args, check=True):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=check)


def _has_tag(tag):
    return shutil.which("git") and _git("rev-parse", "-q", "--verify", f"refs/tags/{tag}", check=False).returncode == 0


def _run(script, code, data):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "MCPL_NO_SCHEDULER": "1", "CRAFTSHELF_TELEMETRY_URL": ""}
    r = subprocess.run([sys.executable, str(script), str(code), str(data)], cwd=code, env=env, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=600)
    return r.returncode, r.stdout + r.stderr


@pytest.fixture
def worktree(tmp_path):
    """その版のファイルだけを取り出す(git archive。作業ツリーの記録は残さない)。"""
    def add(tag):
        import io
        import tarfile
        d = tmp_path / tag.replace("/", "_")
        d.mkdir()
        tar = subprocess.run(["git", "-C", str(ROOT), "archive", "--format=tar", tag], capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(tar)) as t:
            t.extractall(d, filter="data")
        return d
    return add


@pytest.mark.skipif(not _has_tag(OLD), reason=f"タグ {OLD} が無い(git fetch --tags してください)")
def test_upgrade_from_v01_12_and_back_to_bridge(tmp_path, worktree):
    data = tmp_path / "data"
    old = worktree(OLD)
    code, out = _run(HERE / "seed_v01_12.py", old, data)
    assert code == 0 and "seeded" in out, out[-2000:]

    code, out = _run(HERE / "check_upgrade.py", ROOT, data)  # 今の版で開く
    assert code == 0 and "FAILS: 0" in out, out[-3000:]
    code, out = _run(HERE / "use_v2.py", ROOT, data)  # 02 で足した表を使う
    assert code == 0 and "FAILS: 0" in out, out[-3000:]

    if _has_tag(BRIDGE):  # 今の版で使ったデータを、橋渡しの版で開き直し、また今の版で開く
        bridge = worktree(BRIDGE)
        code, out = _run(HERE / "check_upgrade.py", bridge, data)
        assert code == 0 and "FAILS: 0" in out, "橋渡しの版で開けません\n" + out[-3000:]
        code, out = _run(HERE / "check_v2_again.py", ROOT, data)
        assert code == 0 and "FAILS: 0" in out, "橋渡しの版のあと、02 のデータが残っていません\n" + out[-3000:]
