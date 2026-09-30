"""インストーラー版をビルドする(GitHub Actions のリリースで実行。手元でも実行できる)。

    pip install -r requirements.txt -r packaging/requirements-build.txt
    python packaging/build.py

dist/ に次のものができる。
- Windows: CraftShelf-Setup-<版>.exe(Inno Setup が必要)
- macOS  : CraftShelf-<版>-macos-<arm64|x64>.dmg
- Linux  : CraftShelf-<版>-linux-x64.tar.gz
"""
import os
import platform
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "packaging"
DIST = ROOT / "dist"
BUILD = ROOT / "build"
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def run(cmd):
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def make_icons():
    from PIL import Image
    BUILD.mkdir(exist_ok=True)
    im = Image.open(PKG / "icon.png").convert("RGBA")
    ico, icns = BUILD / "icon.ico", BUILD / "icon.icns"
    im.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    im.save(icns)
    return ico, icns


def pyinstaller(icon):
    sep = ";" if os.name == "nt" else ":"
    data = [(ROOT / "static", "static"), (ROOT / "VERSION", "."), (ROOT / "CHANGELOG.md", "."),
            (PKG / "icon.png", "packaging")]
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--name", "CraftShelf", "--windowed",
           "--icon", icon, "--distpath", DIST, "--workpath", BUILD / "pyi", "--specpath", BUILD,
           "--osx-bundle-identifier", "io.github.mesamaru.craftshelf",
           "--hidden-import", "app", "--collect-submodules", "waitress", "--collect-submodules", "pystray"]
    for src, dst in data:
        cmd += ["--add-data", f"{src}{sep}{dst}"]
    run(cmd + [ROOT / "launcher.py"])


def windows():
    ico, _ = make_icons()
    pyinstaller(ico)
    iscc = shutil.which("iscc") or r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    numeric = ".".join(str(int(x)) for x in VERSION.split("."))
    run([iscc, f"/DAppVersion={VERSION}", f"/DAppNumericVersion={numeric}", f"/DSourceDir={DIST / 'CraftShelf'}",
         f"/DOutputDir={DIST}", f"/DIconFile={ico}", PKG / "windows" / "craftshelf.iss"])


def macos():
    _, icns = make_icons()
    pyinstaller(icns)
    arch = "arm64" if platform.machine() == "arm64" else "x64"
    stage = BUILD / "dmg"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copytree(DIST / "CraftShelf.app", stage / "CraftShelf.app", symlinks=True)
    os.symlink("/Applications", stage / "Applications")
    run(["hdiutil", "create", "-volname", "CraftShelf", "-srcfolder", stage, "-ov", "-format", "UDZO",
         DIST / f"CraftShelf-{VERSION}-macos-{arch}.dmg"])


def linux():
    ico, _ = make_icons()
    pyinstaller(ico)
    out = DIST / f"CraftShelf-{VERSION}-linux-x64.tar.gz"
    with tarfile.open(out, "w:gz") as t:
        t.add(DIST / "CraftShelf", arcname=f"CraftShelf-{VERSION}")
    print("created", out)


if __name__ == "__main__":
    {"win32": windows, "darwin": macos}.get(sys.platform, linux)()
