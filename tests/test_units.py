"""小さな関数の単体テスト(パネルを起動せずに、モジュールだけを読み込む)。"""
import io
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mcnet  # noqa: E402
import selfupdate  # noqa: E402
from craftshelf import analysis, servers  # noqa: E402


@pytest.mark.parametrize("a,b", [
    ("1.10", "1.9"), ("1.0.0", "1.0.0-beta"), ("2.0", "1.99.9"), ("5.12.1-SNAPSHOT", "5.12.0"),
    ("v1.2.3", "1.2.2"), ("1.0.0-rc2", "1.0.0-rc1"), ("1.0.0-beta", "1.0.0-alpha"),
])
def test_version_key_order(a, b):
    assert analysis.version_key(a) > analysis.version_key(b)


@pytest.mark.parametrize("text,line,expected", [
    ("1.20 以降", "1.21", True), ("1.21 以降", "1.20", False), ("1.20.1〜1.20.6", "1.21", False),
    ("1.20.1〜1.21.4", "1.21", True), ("1.20.1, 1.21.4", "1.21", True), ("[1.20.1,1.21)", "1.20", True),
    (">=1.19", "1.21", True), ("", "1.20", None), ("なにか", "1.20", None),
])
def test_mc_supports(text, line, expected):
    assert servers.mc_supports(text, line) is expected


@pytest.mark.parametrize("text,expected", [
    ("write=1\nread=2\n", (1, 2)), ("# memo\nwrite=2", (2, 2)), ("", (1, 1)), ("write=3\nread=2", (3, 3)),
])
def test_parse_data_format(text, expected):
    assert selfupdate.parse_data_format(text) == expected


@pytest.mark.parametrize("text,expected", [
    ("git-Paper-232 (MC: 1.21.4)", ("1.21.4", "232")), ("1.21.4-232-abcdef (MC: 1.21.4)", ("1.21.4", "232")),
    ("paper-1.21.4-232.jar", ("1.21.4", "232")), ("git-Purpur-2416 (MC: 1.21.4)", ("1.21.4", "2416")),
])
def test_parse_build(text, expected):
    assert mcnet.parse_build(text) == expected


def test_parse_address():
    assert mcnet.parse_address("a.b:25566") == ("a.b", 25566)
    assert mcnet.parse_address("[::1]:1") == ("::1", 1)
    assert mcnet.parse_address("host") == ("host", 25565)


@pytest.mark.parametrize("name,soft", [
    ("paper-1.21.4-232.jar", "paper"), ("purpur-1.21.4-2416.jar", "purpur"), ("velocity-3.4.0-SNAPSHOT-500.jar", "velocity"),
    ("fabric-server-mc.1.21.1-loader.0.16.9-launcher.1.0.1.jar", "fabric"), ("neoforge-21.1.1-installer.jar", "neoforge"),
    ("server.jar", ""),
])
def test_soft_from_jar(name, soft):
    assert servers._soft_from_jar(name) == soft


def _jar(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return b.getvalue()


def test_analyze_plugin(tmp_path):
    p = tmp_path / "x.jar"
    p.write_bytes(_jar({"plugin.yml": "name: Sample\nversion: 1.2.3\nmain: a.B\napi-version: 1.20\ndepend: [Vault]\n"}))
    info = analysis.analyze(p, "x.jar")
    assert (info["name"], info["version"], info["category"]) == ("Sample", "1.2.3", "plugin")


def test_analyze_fabric_mod(tmp_path):
    p = tmp_path / "m.jar"
    p.write_bytes(_jar({"fabric.mod.json": '{"id": "lithium", "name": "Lithium", "version": "0.14.0", "depends": {"minecraft": "~1.21"}}'}))
    info = analysis.analyze(p, "m.jar")
    assert (info["name"], info["version"], info["category"]) == ("Lithium", "0.14.0", "mod")


def test_analyze_datapack(tmp_path):
    p = tmp_path / "d.zip"
    p.write_bytes(_jar({"pack.mcmeta": '{"pack": {"pack_format": 48, "description": "Terrain"}}', "data/x/a.json": "{}"}))
    assert analysis.analyze(p, "d.zip")["category"] == "datapack"


@pytest.mark.parametrize("name, expected", [
    ("fabric-api-base", "fabric-api"), ("fabric-networking-api-v1", "fabric-api"), ("fabric-command-api-v2", "fabric-api"),
    ("fabric", "fabric-api"), ("fabric-api", "fabric-api"), ("fabric-language-kotlin", "fabric-language-kotlin"),
    ("fabricloader", "fabricloader"), ("worldedit", "worldedit"),
])
def test_canonical_dep(name, expected):
    assert analysis.canonical_dep(name) == expected


@pytest.mark.parametrize("version, rebuilt", [("02.21.00", False), ("02.99.99", False), ("03.00.00", True), ("04.01.00", True), ("", False)])
def test_rebuilt_versions_are_not_applied(version, rebuilt):
    """v03 からは作りが新しい(Python のパネルではない)ので、02 のパネルの自動更新では切り替えない。"""
    assert selfupdate.is_rebuilt(version) is rebuilt
