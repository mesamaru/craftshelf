"""tests/flows/ の通しテストを、1 本ずつ別のプロセスで動かす(それぞれ自分のデータの置き場所を作るため)。

どれも「FAILS: 0」か「RESULT: ALL PASS」を出し、終了コード 0 で終わること。ファイルが無い・途中で落ちた・
結果を出さなかった場合は失敗にする(何も出さずに終わったものを合格にしない)。

- CRAFTSHELF_TEST_OFFLINE=1 : 外部のサービス(Modrinth・SpigotMC・PaperMC など)を使うものを飛ばす
- CRAFTSHELF_TEST_SMB_SERVER / CRAFTSHELF_TEST_SMB_SHARE : 指定すると SMB の保存先も試す
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FLOWS = sorted((ROOT / "tests" / "flows").glob("*.py"))
NETWORK = {"auth_storage", "features_core", "features_more", "features_prefs", "newer_and_beta", "server_extras"}


@pytest.mark.parametrize("flow", FLOWS, ids=[f.stem for f in FLOWS])
def test_flow(flow):
    if flow.stem in NETWORK and os.environ.get("CRAFTSHELF_TEST_OFFLINE") == "1":
        pytest.skip("外部のサービスを使うため(CRAFTSHELF_TEST_OFFLINE=1)")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "MCPL_NO_SCHEDULER": "1", "CRAFTSHELF_TELEMETRY_URL": ""}
    r = subprocess.run([sys.executable, str(flow), str(ROOT)], cwd=ROOT, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=900)
    out = r.stdout + r.stderr
    ng = [ln for ln in out.splitlines() if ln.startswith("  NG ")]
    passed = "FAILS: 0" in out or "RESULT: ALL PASS" in out
    assert r.returncode == 0 and passed and not ng, (
        f"{flow.name} が失敗しました(終了コード {r.returncode})\n" + "\n".join(ng[:30]) + "\n--- 最後の出力 ---\n" + out[-3000:])
