"""コードの形の決まりを確かめる(層の順番・個人の情報・画面のスクリプトの文法)。"""
import ast
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "craftshelf"
LAYERS = ["core", "analysis", "auth", "events", "jobs", "library", "accounts", "upstream", "servers", "system"]


def _module_level_imports(path):
    """モジュールの最上位にある from .x import … の x の一覧(関数の中の import は除く)。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for n in tree.body:
        if isinstance(n, ast.ImportFrom) and n.level == 1:
            out.append(n.module or "")
        elif isinstance(n, ast.ImportFrom) and n.level == 1 and n.module is None:
            out.extend(a.name for a in n.names)
    return out


@pytest.mark.parametrize("mod", LAYERS)
def test_lower_layers_do_not_import_higher(mod):
    """下の層は、モジュールの最上位で上の層を読み込まない(循環 import を防ぐ)。"""
    mine = LAYERS.index(mod)
    for target in _module_level_imports(PKG / f"{mod}.py"):
        if target in LAYERS:
            assert LAYERS.index(target) < mine, f"{mod} が上の層 {target} を最上位で読み込んでいます"


def test_every_module_is_in_a_layer():
    names = {p.stem for p in PKG.glob("*.py") if p.stem != "__init__"}
    assert names == set(LAYERS), f"層に入っていないモジュール: {names ^ set(LAYERS)}"


# 公開リポジトリなので、個人の環境の情報を入れない(LAN のアドレス・共有名など)
PRIVATE = re.compile(r"\b(?:172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b|MCPackLibrary|@gmail\.com")
ALLOWED = {"192.168.1.10"}  # 画面の入力例として使っている、よくあるアドレス
SCAN = ["*.py", "craftshelf/*.py", "static/*.js", "static/js/*.js", "static/*.html", "tests/**/*.py", "*.md", "*.yml", "*.sh", "packaging/**/*"]


def test_no_private_information():
    hits = []
    for pat in SCAN:
        for p in ROOT.glob(pat):
            if p.is_file() and p.suffix not in (".png", ".ico", ".icns") and p.name != "test_structure.py":
                for i, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                    found = [m.group(0) for m in PRIVATE.finditer(line) if m.group(0) not in ALLOWED]
                    if found:
                        hits.append(f"{p.relative_to(ROOT)}:{i}: {line.strip()[:80]}")
    assert not hits, "個人の環境の情報が入っています:\n" + "\n".join(hits)


@pytest.mark.skipif(not shutil.which("node"), reason="node が無い環境")
@pytest.mark.parametrize("js", ["static/i18n-en.js", *sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "static" / "js").glob("*.js"))])
def test_javascript_syntax(js):
    r = subprocess.run(["node", "--check", str(ROOT / js)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_version_and_data_format_files():
    v = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert re.fullmatch(r"\d{2}\.\d{2}\.\d{2}", v)
    import sys
    sys.path.insert(0, str(ROOT))
    import selfupdate
    w, r = selfupdate.local_data_format()
    assert 1 <= w <= r
    head = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"## {v} - " in head, "CHANGELOG に今の版の見出しがありません"


def test_every_api_is_documented():
    """API の説明(/api/docs)に、すべての API の説明があること(新しく足したら docstring か API_SUMMARY に書く)。"""
    import os
    import subprocess
    import sys
    code = ("import os, sys, tempfile; t = tempfile.mkdtemp(); os.environ.update(DATA_DIR=t, MCPL_NO_SCHEDULER='1', "
            "CRAFTSHELF_TELEMETRY_URL=''); sys.path.insert(0, '.'); import app as A; "
            "print(chr(10).join(e['path'] + ' ' + ','.join(e['methods']) for e in A.api_reference() if not e['summary']))")
    r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"}, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    assert not r.stdout.strip(), "説明の無い API があります:\n" + r.stdout


@pytest.mark.skipif(not shutil.which("node"), reason="node が無い環境")
def test_english_translation_samples():
    """英語表示で、よく出る文が日本語を残さずに置き換わること(画面と同じ順番で辞書を当てる)。"""
    import json
    samples = ["キャンセル", "3 件を削除しますか?", "5 件を共有しました", "比較するには 2 台以上のサーバーを連携してください",
               "Pterodactyl からサーバーが 1 台も返りませんでした。APIキー(ptlc_…)を作ったユーザーに、サーバーの所有者・サブユーザー・管理者のいずれかの権限があるか確認してください",
               "お知らせ", "パスキーでログイン", "前提も一緒に入れる", "はじめの設定", "最近のログ", "API の説明", "ホーム画面に追加"]
    r = subprocess.run(["node", str(ROOT / "tests" / "i18n_check.js"), str(ROOT / "static" / "i18n-en.js"), json.dumps(samples)],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stderr
    out = [json.loads(line) for line in r.stdout.splitlines()]
    left = [f"{s} → {o}" for s, o in zip(samples, out) if re.search(r"[぀-ヿ一-鿿]", o)]
    assert not left, "日本語が残っています:\n" + "\n".join(left)


def test_skins_match():
    """画面の見た目の種類(base.js の SKINS)と、保存できる値(accounts.SKINS)・CSS(skins.css)がそろっていること。"""
    import re as _re
    js = (ROOT / "static" / "js" / "base.js").read_text(encoding="utf-8")
    ids = _re.findall(r'\{ id: "([a-z0-9]+)", name: "[^"]+", note:', js)
    py = (ROOT / "craftshelf" / "accounts.py").read_text(encoding="utf-8")
    allowed = set(_re.findall(r"'([a-z0-9]+)'", _re.search(r"^SKINS = \((.*?)\)", py, _re.M).group(1)))
    css = (ROOT / "static" / "skins.css").read_text(encoding="utf-8")
    assert ids and set(ids) == allowed, (ids, allowed)
    missing = [i for i in ids if i != "glass" and f'body[data-skin="{i}"] {{' not in css]
    assert not missing, f"skins.css に無い見た目: {missing}"
