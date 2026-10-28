"""v03(開発版)への切り替え: 一式と Node.js を確かめて置く・起動のときに v03 に乗り換える・起動できなければ v02 に戻る。"""
import hashlib
import io
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import v03switch  # noqa: E402

V = "03.09.00"
NODE = "node-v24.1.0-linux-x64"


def targz(files):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode="w:gz") as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            t.addfile(info, io.BytesIO(data))
    return b.getvalue()


BUNDLE = targz({".output/server/index.mjs": b"// app", "drizzle/0000.sql": b"", "VERSION": V.encode()})
NODE_TGZ = targz({f"{NODE}/bin/node": b"#!node"})


class Resp:
    def __init__(self, status=200, content=b"", data=None):
        self.status_code, self.content, self._data = status, content, data
        self.text = content.decode("utf-8", "replace")

    def json(self):
        return self._data


@pytest.fixture
def world(tmp_path, monkeypatch):
    """GitHub と nodejs.org の代わり。bundle を書き換えると、壊れた一式を返す。"""
    w = {"bundle": BUNDLE}
    sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731

    def get(url, timeout=None, headers=None):
        if "/releases?" in url:
            return Resp(data=[{"tag_name": "dev-v02.21.00", "assets": []}, {"tag_name": f"dev-v{V}", "assets": [
                {"name": f"craftshelf-v03-{V}.tar.gz", "browser_download_url": "https://gh/app"},
                {"name": "SHA256SUMS", "browser_download_url": "https://gh/sums"}]}])
        if url == "https://gh/sums":
            return Resp(content=f"{sha(BUNDLE)}  craftshelf-v03-{V}.tar.gz\n".encode())
        if url == "https://gh/app":
            return Resp(content=w["bundle"])
        if url.endswith("SHASUMS256.txt"):
            return Resp(content=f"{sha(NODE_TGZ)}  {NODE}.tar.gz\n{'0' * 64}  {NODE}.tar.xz\n".encode())
        if url.endswith(f"{NODE}.tar.gz"):
            return Resp(content=NODE_TGZ)
        return Resp(status=404)

    monkeypatch.setattr(v03switch.requests, "get", get)
    monkeypatch.setattr(v03switch.sys, "platform", "linux")
    monkeypatch.setattr(v03switch.platform, "machine", lambda: "x86_64")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("CONFIG_DIR", raising=False)
    monkeypatch.delenv("DB_DIR", raising=False)
    w["root"] = tmp_path / "v03"
    return w


def test_pick_releases_and_sums():
    assert [r["version"] for r in v03switch.pick_releases([{"tag_name": "dev-v03.01.00", "assets": []}])] == []
    assert v03switch.pick_releases({"message": "rate limited"}) == []
    h = "a" * 64
    assert v03switch.sum_for(f"{h}  x.tar.gz\n{'b' * 64} *y", "x.tar.gz") == h
    assert v03switch.sum_for(f"{h}  x.tar.gz", "y") is None


def test_install_puts_bundle_and_node(world):
    v03switch.install(V, note=lambda m: None)
    root = world["root"]
    assert (root / "versions" / "current").read_text().strip() == V
    assert (root / "versions" / V / ".output" / "server" / "index.mjs").is_file()
    assert (root / "node" / NODE / NODE / "bin" / "node").is_file()


def test_install_rejects_bad_downloads(world):
    world["bundle"] = BUNDLE + b"x"
    with pytest.raises(v03switch.SwitchError, match="チェックサム"):
        v03switch.install(V, note=lambda m: None)
    with pytest.raises(v03switch.SwitchError, match="見つかりません"):
        v03switch.install("03.99.99", note=lambda m: None)
    assert not (world["root"] / "versions" / "current").exists()


def test_extract_refuses_paths_outside(tmp_path):
    with pytest.raises(tarfile.TarError):
        v03switch._extract(targz({"../evil": b"x"}), tmp_path / "out")
    assert not (tmp_path / "evil").exists()


def test_maybe_exec(world, monkeypatch):
    calls = []
    monkeypatch.setattr(v03switch.os, "execve", lambda path, args, env: calls.append((path, args, env)))
    monkeypatch.setattr(v03switch.os, "chdir", lambda d: None)
    v03switch.maybe_exec(8080)  # 切り替えていない: 何もしない
    assert calls == []

    v03switch.install(V, note=lambda m: None)
    v03switch.maybe_exec(8080)
    path, args, env = calls[-1]
    assert Path(path).parts[-4:] == (NODE, NODE, "bin", "node") and args[1] == ".output/server/index.mjs"
    assert env["PORT"] == "8080" and env["CRAFTSHELF_MODE"] == "self" and env["V02_CONFIG_DIR"] == env["DATA_DIR"]
    marker = world["root"] / "versions" / V / ".starting"
    assert marker.exists()

    # v03 がしるしを消さないまま再起動した(= うまく起動しなかった): v02 で起動し、切り替えをやめる
    v03switch.maybe_exec(8080)
    assert len(calls) == 1
    assert not (world["root"] / "versions" / "current").exists() and not marker.exists()


def test_unsupported(monkeypatch):
    monkeypatch.setattr(v03switch.sys, "platform", "win32")
    assert "Linux" in v03switch.unsupported()
    monkeypatch.setattr(v03switch.sys, "platform", "linux")
    monkeypatch.setattr(v03switch.platform, "machine", lambda: "riscv64")
    assert "CPU" in v03switch.unsupported()
    monkeypatch.setattr(v03switch.sys, "frozen", True, raising=False)
    assert "インストーラー" in v03switch.unsupported()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="gunicorn は Linux だけで動く")
def test_gunicorn_hands_over_to_v03(tmp_path):
    """本物の gunicorn が gunicorn.conf.py を読み、ポートを開く前に v03(ここでは偽の node)に乗り換える。"""
    import os
    import subprocess
    root = tmp_path / "v03"
    app = root / "versions" / V
    (app / ".output" / "server").mkdir(parents=True)
    (app / ".output" / "server" / "index.mjs").write_text("// app")
    node = root / "node" / NODE / NODE / "bin" / "node"
    node.parent.mkdir(parents=True)
    node.write_text(f'#!/bin/sh\necho "$PORT $CRAFTSHELF_MODE $(pwd)" > "{tmp_path}/ran"\n')
    node.chmod(0o755)
    (root / "node" / "current").write_text(f"{NODE}/{NODE}\n")
    (root / "versions" / "current").write_text(V + "\n")
    repo = Path(__file__).resolve().parent.parent
    env = {**os.environ, "DATA_DIR": str(tmp_path), "MCPL_NO_SCHEDULER": "1", "CRAFTSHELF_TELEMETRY_URL": ""}
    subprocess.run([sys.executable, "-m", "gunicorn", "-b", "127.0.0.1:0", "app:app"], cwd=repo, env=env, timeout=60)
    assert (tmp_path / "ran").read_text().split() == ["8080", "self", str(app)]
