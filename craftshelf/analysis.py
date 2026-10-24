"""CraftShelf: ファイルの中身(plugin.yml / fabric.mod.json など)からの名前・バージョン・前提の読み取り。"""

from pathlib import Path
import io
import json
import re
import zipfile

from .core import clean_version

try:  # Python 3.11+
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None


_EXT_RE = re.compile(r"(\.(jar|zip|rar|7z|mcpack|disabled))+$", re.I)


def parse_filename(filename):
    """ファイル名から (名前, バージョン or None) を推測する。"""
    stem = _EXT_RE.sub("", Path(filename).name)
    stem = re.sub(r"\s*\(\d+\)$", "", stem).strip()  # ブラウザの重複DL "(1)"
    m = re.match(r"^(.+?)[\s._-]+[vV]?(\d+(?:\.\d+)+.*)$", stem) or re.match(
        r"^(.+?)[\s._-]+[vV](\d+.*)$", stem
    )
    if m:
        name, ver = m.group(1), m.group(2)
    else:
        name, ver = stem, None
    name = name.strip(" ._-") or stem or "unnamed"
    return name, clean_version(ver)


_PRE = {
    "dev": 0, "snapshot": 0, "nightly": 0,
    "alpha": 1, "a": 1,
    "beta": 2, "b": 2,
    "pre": 3, "preview": 3,
    "rc": 4, "cr": 4,
}


def version_key(v):
    """バージョン文字列の自然順ソート用キー。1.10 > 1.9、1.0.0 > 1.0.0-beta など。"""
    v = re.sub(r"^[vV](?=\d)", "", (v or "").strip())
    toks = []
    for t in re.findall(r"\d+|[A-Za-z]+", v):
        if t.isdigit():
            toks.append((2, int(t), ""))
        else:
            tl = t.lower()
            toks.append((-1, _PRE[tl], "") if tl in _PRE else (1, 0, tl))
    toks.append((0, 0, ""))  # 終端。これでリリースバージョンがプレリリースより上になる
    return toks


# --------------------------------------------------------------------------
# ファイル解析 (jar / zip の中身から名前・バージョン・種類を読む)
# --------------------------------------------------------------------------
def _read(z, name, limit=2_000_000):
    try:
        with z.open(name) as f:
            return f.read(limit).decode("utf-8-sig", errors="replace")
    except KeyError:
        return None


def _json(z, name):
    text = _read(z, name)
    if text is None:
        return None
    try:
        data = json.loads(text, strict=False)
        return data
    except ValueError:
        return None


def _toml(text):
    if not text or tomllib is None:
        return None
    try:
        return tomllib.loads(text)
    except Exception:
        return None


def _yaml_top(text):
    """plugin.yml のトップレベルから name/version/description/api-version だけ抜く。"""
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"^([A-Za-z_-]+)\s*:\s*(.*?)\s*$", line)
        if not m or m.group(1) not in ("name", "version", "description", "api-version"):
            continue
        key, val = m.group(1), m.group(2)
        if key in out:
            continue
        if val[:1] in ("'", '"'):
            q = val[0]
            end = val.find(q, 1)
            val = val[1:end] if end > 0 else val[1:]
        else:
            val = re.sub(r"\s+#.*$", "", val)
        if val in ("", ">", "|", ">-", "|-"):
            continue
        out[key] = val
    return out


def _flatten_text(d):
    if isinstance(d, str):
        return d
    if isinstance(d, list):
        return "".join(_flatten_text(x) for x in d)
    if isinstance(d, dict):
        s = d.get("text") if isinstance(d.get("text"), str) else ""
        return s + _flatten_text(d.get("extra", []))
    return ""


def _short(s, n=200):
    s = re.sub(r"§.", "", str(s or "")).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:n]


def _manifest_version(z):
    text = _read(z, "META-INF/MANIFEST.MF") or ""
    m = re.search(r"^Implementation-Version:\s*(.+?)\s*$", text, re.M)
    return m.group(1) if m else None


def _analyze_zip(z, info):
    names = z.namelist()
    nameset = set(names)

    # ---- サーバープラグイン ----
    for fname, loader in (
        ("paper-plugin.yml", "Paper"),
        ("plugin.yml", "Bukkit / Spigot / Paper"),
        ("bungee.yml", "BungeeCord"),
    ):
        if fname in nameset:
            y = _yaml_top(_read(z, fname))
            if fname == "plugin.yml" and str(y.get("folia-supported") or "").lower() == "true":
                loader = "Bukkit / Spigot / Paper / Folia"
            info.update(
                category="plugin", loader=loader, name=y.get("name"),
                version=y.get("version"), description=_short(y.get("description")),
            )
            if y.get("api-version"):
                info["mc"] = str(y["api-version"])
            return
    if "velocity-plugin.json" in nameset:
        d = _json(z, "velocity-plugin.json") or {}
        info.update(
            category="plugin", loader="Velocity", name=d.get("name") or d.get("id"),
            version=d.get("version"), description=_short(d.get("description")),
        )
        return

    # ---- Mod ----
    if "fabric.mod.json" in nameset:
        d = _json(z, "fabric.mod.json") or {}
        mc = (d.get("depends") or {}).get("minecraft")
        if isinstance(mc, list):
            mc = ", ".join(str(x) for x in mc)
        info.update(
            category="mod", loader="Fabric", name=d.get("name") or d.get("id"),
            version=d.get("version"), description=_short(d.get("description")),
            mc=str(mc) if mc else None,
        )
        return
    if "quilt.mod.json" in nameset:
        d = _json(z, "quilt.mod.json") or {}
        ql = d.get("quilt_loader") or {}
        mc = None
        for dep in ql.get("depends") or []:
            if isinstance(dep, dict) and dep.get("id") == "minecraft":
                mc = dep.get("versions")
                if isinstance(mc, list):
                    mc = ", ".join(str(x) for x in mc)
        meta = d.get("metadata") or {}
        info.update(
            category="mod", loader="Quilt", name=meta.get("name") or ql.get("id"),
            version=ql.get("version"), description=_short(meta.get("description")),
            mc=str(mc) if mc else None,
        )
        return
    for path, loader in (
        ("META-INF/neoforge.mods.toml", "NeoForge"),
        ("META-INF/mods.toml", "Forge"),
    ):
        if path in nameset:
            text = _read(z, path) or ""
            data = _toml(text)
            name = version = desc = mc = None
            if data:
                mods = data.get("mods") or [{}]
                m0 = mods[0] if isinstance(mods, list) and mods else {}
                name = m0.get("displayName") or m0.get("modId")
                version = m0.get("version")
                desc = m0.get("description")
                for lst in (data.get("dependencies") or {}).values():
                    if isinstance(lst, list):
                        for dep in lst:
                            if isinstance(dep, dict) and dep.get("modId") == "minecraft":
                                mc = dep.get("versionRange")
            else:  # tomllib が無い / 壊れている場合の簡易パース
                m = re.search(r'displayName\s*=\s*"([^"]*)"', text) or re.search(r'modId\s*=\s*"([^"]*)"', text)
                name = m.group(1) if m else None
                m = re.search(r'^\s*version\s*=\s*"([^"]*)"', text, re.M)
                version = m.group(1) if m else None
            if not clean_version(version):  # ${file.jarVersion} など
                version = _manifest_version(z)
            info.update(
                category="mod", loader=loader, name=name, version=version,
                description=_short(desc), mc=str(mc) if mc else None,
            )
            return
    if "mcmod.info" in nameset:
        d = _json(z, "mcmod.info")
        if isinstance(d, dict):
            d = d.get("modList")
        if isinstance(d, list) and d and isinstance(d[0], dict):
            m0 = d[0]
            info.update(
                category="mod", loader="Forge", name=m0.get("name") or m0.get("modid"),
                version=m0.get("version"), description=_short(m0.get("description")),
                mc=m0.get("mcversion") or None,
            )
            return

    # ---- Modパック(Modrinth .mrpack / CurseForge) ----
    if "modrinth.index.json" in nameset:
        d = _json(z, "modrinth.index.json") or {}
        deps = d.get("dependencies") or {}
        loader = next((k.replace("-loader", "").capitalize() for k in deps if k != "minecraft"), None)
        info.update(category="modpack", loader=f"Modrinth / {loader}" if loader else "Modrinth", name=d.get("name"),
                    version=d.get("versionId"), description=_short(d.get("summary")),
                    mc=str(deps["minecraft"]) if deps.get("minecraft") else None)
        return
    if "manifest.json" in nameset and any(n.startswith("overrides/") for n in names):
        d = _json(z, "manifest.json") or {}
        mc = (d.get("minecraft") or {})
        loader = ((mc.get("modLoaders") or [{}])[0].get("id") or "").split("-")[0].capitalize() or None
        info.update(category="modpack", loader=f"CurseForge / {loader}" if loader else "CurseForge", name=d.get("name"),
                    version=d.get("version"), description=_short(d.get("author") and f"by {d['author']}"),
                    mc=str(mc["version"]) if mc.get("version") else None)
        return

    # ---- シェーダー(Iris / OptiFine) ----
    tops = {n.split("/", 1)[0] for n in names}
    if "shaders" in tops or any(n.split("/")[1:2] == ["shaders"] for n in names if n.count("/") >= 2):
        info.update(category="shader", loader="Iris / OptiFine")
        return

    # ---- データパック / リソースパック ----
    mcmeta = None
    if "pack.mcmeta" in nameset:
        mcmeta = "pack.mcmeta"
    else:  # フォルダごとzip化されたもの
        for n in names:
            if n.endswith("/pack.mcmeta") and n.count("/") == 1:
                mcmeta = n
                break
    prefix = mcmeta[: -len("pack.mcmeta")] if mcmeta else ""
    has_data = any(n.startswith(prefix + "data/") for n in names)
    has_assets = any(n.startswith(prefix + "assets/") for n in names)
    if has_data or has_assets:
        pack = ((_json(z, mcmeta) if mcmeta else None) or {}).get("pack") or {}
        info["category"] = "datapack" if has_data else "resourcepack"
        info["description"] = _short(_flatten_text(pack.get("description")))
        fmt = pack.get("pack_format", pack.get("min_format"))
        if fmt is not None:
            info["pack_format"] = str(fmt)


# --------------------------------------------------------------------------
# 前提(依存)プラグイン・Mod の読み取り
# --------------------------------------------------------------------------
# ローダーやゲーム本体など、ライブラリで管理しない依存は無視する
_IGNORE_DEPS = {"minecraft", "java", "fabricloader", "fabricloader", "fabric-loader", "quiltloader", "quilt_loader",
                "forge", "neoforge", "fml", "javafml", "lowcodefml", "quiltbase", "quilted_fabric_api_base"}


def _yaml_list(text, key):
    """plugin.yml の「depend: [A, B]」「depend:\\n  - A」形式の一覧を読む。"""
    lines = (text or "").splitlines()
    for i, line in enumerate(lines):
        m = re.match(rf"^{re.escape(key)}\s*:\s*(.*?)\s*$", line)
        if not m:
            continue
        val = re.sub(r"\s+#.*$", "", m.group(1)).strip()
        if val.startswith("["):
            return [x.strip().strip("'\"") for x in val.strip("[]").split(",") if x.strip().strip("'\"")]
        if val and val not in ("|", ">", "[]"):
            return [val.strip("'\"")]
        out = []
        for nxt in lines[i + 1:]:
            mm = re.match(r"^\s*-\s*(.+?)\s*$", nxt)
            if mm:
                out.append(mm.group(1).strip("'\""))
            elif nxt.strip() and not nxt.lstrip().startswith("#"):
                break
        return out
    return []


def _paper_deps(text):
    """paper-plugin.yml の dependencies: server: 名前: {required: true} を読む。"""
    req, soft = [], []
    lines = (text or "").splitlines()
    in_deps = in_server = False
    cur = None
    name_indent = None
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        s = line.strip()
        if indent == 0:
            in_deps = s.startswith("dependencies:")
            in_server = False
            continue
        if not in_deps:
            continue
        if s.startswith("server:") and (name_indent is None or indent < name_indent):
            in_server, name_indent, cur = True, None, None
            continue
        if not in_server:
            continue
        m = re.match(r"^([^:#]+):\s*$", s)
        if m and (name_indent is None or indent == name_indent):
            name_indent = indent
            cur = m.group(1).strip().strip("'\"")
            soft.append(cur)
            continue
        if cur and re.match(r"^required\s*:\s*true\b", s):
            if cur in soft:
                soft.remove(cur)
            req.append(cur)
    return req, soft


_NESTED_DIRS = ("META-INF/jars/", "META-INF/jarjar/")  # Fabric / Quilt と Forge / NeoForge の jar-in-jar


def _mod_ids(z):
    """jar の中の Mod の ID と、その Mod が「代わりになる」と宣言している ID(provides)。"""
    names = set(z.namelist())
    ids = []
    if "fabric.mod.json" in names:
        d = _json(z, "fabric.mod.json") or {}
        ids += [d.get("id")] + [p for p in d.get("provides") or [] if isinstance(p, str)]
    if "quilt.mod.json" in names:
        ql = (_json(z, "quilt.mod.json") or {}).get("quilt_loader") or {}
        ids += [ql.get("id")] + [p if isinstance(p, str) else (p or {}).get("id") for p in ql.get("provides") or []]
    for path in ("META-INF/neoforge.mods.toml", "META-INF/mods.toml"):
        if path in names:
            ids += [m.get("modId") for m in (_toml(_read(z, path)) or {}).get("mods") or [] if isinstance(m, dict)]
    return [str(x) for x in ids if isinstance(x, str) and x]


def _provided_ids(z, depth=0):
    """同梱している jar(jar-in-jar)の Mod の ID。Fabric API なら fabric-api-base など、中の部品がすべて入る。"""
    out = []
    for n in z.namelist():
        if not (n.startswith(_NESTED_DIRS) and n.endswith(".jar")):
            continue
        try:
            if z.getinfo(n).file_size > 32 * 1024 * 1024:
                continue
            with zipfile.ZipFile(io.BytesIO(z.read(n))) as inner:
                out += _mod_ids(inner)
                if depth < 1:
                    out += _provided_ids(inner, depth + 1)
        except Exception:  # noqa: BLE001  壊れた中身は無視する
            continue
    return out


def _analyze_deps(z, info):
    names = set(z.namelist())
    deps, soft, mod_id = [], [], None
    provides = []
    if "paper-plugin.yml" in names:
        deps, soft = _paper_deps(_read(z, "paper-plugin.yml"))
    elif "plugin.yml" in names or "bungee.yml" in names:
        text = _read(z, "plugin.yml" if "plugin.yml" in names else "bungee.yml")
        deps = _yaml_list(text, "depend") + _yaml_list(text, "depends")
        soft = _yaml_list(text, "softdepend") + _yaml_list(text, "softDepends")
    elif "velocity-plugin.json" in names:
        d = _json(z, "velocity-plugin.json") or {}
        mod_id = d.get("id")
        for dep in d.get("dependencies") or []:
            if isinstance(dep, dict) and dep.get("id"):
                (soft if dep.get("optional") else deps).append(dep["id"])
    elif "fabric.mod.json" in names:
        d = _json(z, "fabric.mod.json") or {}
        mod_id = d.get("id")
        deps = [k for k in (d.get("depends") or {}) if isinstance(k, str)]
        soft = [k for k in (d.get("recommends") or {}) if isinstance(k, str)]
    elif "quilt.mod.json" in names:
        ql = (_json(z, "quilt.mod.json") or {}).get("quilt_loader") or {}
        mod_id = ql.get("id")
        for dep in ql.get("depends") or []:
            dep_id = dep.get("id") if isinstance(dep, dict) else dep if isinstance(dep, str) else None
            if dep_id:
                (soft if isinstance(dep, dict) and dep.get("optional") else deps).append(dep_id)
    else:
        for path in ("META-INF/neoforge.mods.toml", "META-INF/mods.toml"):
            if path in names:
                data = _toml(_read(z, path)) or {}
                mods = data.get("mods") or [{}]
                mod_id = (mods[0] if isinstance(mods, list) and mods else {}).get("modId")
                for lst in (data.get("dependencies") or {}).values():
                    for dep in lst if isinstance(lst, list) else []:
                        if not isinstance(dep, dict) or not dep.get("modId"):
                            continue
                        required = dep.get("mandatory") is True or str(dep.get("type", "")).lower() == "required"
                        (deps if required else soft).append(dep["modId"])
                break
    # この jar 自身が同梱しているもの(・代わりになると宣言しているもの)は、前提として数えない
    own = [x for x in _mod_ids(z) if x != mod_id] + _provided_ids(z)
    provides = sorted({str(x).strip() for x in own if str(x).strip()})[:300]
    have = {_norm(x) for x in provides}
    clean = lambda xs: sorted({x.strip() for x in xs  # noqa: E731
                               if x and x.strip().lower() not in _IGNORE_DEPS and _norm(x) not in have})[:50]
    info["depends"], info["softdepends"] = clean(deps), clean(soft)
    if provides:
        info["provides"] = provides
    if mod_id:
        info["mod_id"] = str(mod_id)[:80]


def _norm(name):
    return re.sub(r"[\W_]+", "", (name or "").lower())


# Fabric API の部品(fabric-api-base・fabric-networking-api-v1 など)。単体では配られず、Fabric API に入っている
_FABRIC_API_PART = re.compile(r"^fabric(-api-base|-[a-z0-9]+(-[a-z0-9]+)*-v\d+)$")


def canonical_dep(name):
    """前提の名前を、ライブラリで探す名前にそろえる(Fabric API の部品・古い ID「fabric」は Fabric API)。"""
    n = (name or "").strip()
    if n.lower() == "fabric" or _FABRIC_API_PART.match(n.lower()):
        return "fabric-api"
    return n


def analyze(path, filename):
    info = dict(category="other", name=None, version=None, loader=None,
                mc=None, description=None, pack_format=None)
    if zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as z:
                _analyze_zip(z, info)
                try:
                    _analyze_deps(z, info)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:
            pass
    fn_name, fn_ver = parse_filename(filename)
    info["name"] = (str(info["name"] or "")).strip() or fn_name
    info["version"] = clean_version(info["version"]) or fn_ver or ""
    return info


_MC_REL = re.compile(r"^1\.\d+(\.\d+)?$|^\d{2}\.\d+(\.\d+)?$")


def _mc_key(v):
    return tuple(int(x) for x in v.split("."))


def summarize_mc(versions):
    """["1.20.1", "1.20.2", ..., "1.21.4"] → "1.20.1〜1.21.4"(スナップショット等は除く)。"""
    vs = sorted({v for v in versions if isinstance(v, str) and _MC_REL.match(v)}, key=_mc_key)
    if not vs:
        return ""
    return vs[0] if len(vs) == 1 else (", ".join(vs) if len(vs) <= 3 else f"{vs[0]}〜{vs[-1]}")


def mc_max(versions):
    """対応バージョンの一覧から、いちばん新しい正式版(例 "1.21.4")。"""
    vs = [v for v in (versions or []) if isinstance(v, str) and _MC_REL.match(v)]
    return max(vs, key=_mc_key) if vs else ""


PLATFORM_IDS = {"bukkit", "paper", "purpur", "folia", "sponge", "velocity", "bungee", "fabric", "quilt", "forge",
                "neoforge", "shader", "datapack", "resourcepack"}
_PLATFORM_LEGACY = {"Paper": "paper", "Spigot / Paper": "bukkit", "Folia": "folia", "Velocity": "velocity",
                    "BungeeCord": "bungee", "Fabric": "fabric", "Quilt": "quilt", "Forge": "forge", "NeoForge": "neoforge",
                    "Iris / OptiFine": "shader", "Datapack": "datapack", "Minecraft": "resourcepack"}


def auto_mc_versions(meta, category, source):
    """保存しているファイルの中身・配布元の情報から、対応MCバージョンを推定する。"""
    mc = str((meta or {}).get("mc") or "").strip()
    if mc:
        if category == "plugin" and re.match(r"^\d+\.\d+(\.\d+)?$", mc):
            # plugin.yml の api-version は「このバージョン以降」の意味。保存しているバージョンが配布元の最新と
            # 同じなら、配布元が示す対応バージョンの上限を付けて「1.13〜1.21.4」のように表示する
            top = mc_max(((source or {}).get("latest") or {}).get("game_versions")) if (source or {}).get("status") == "up_to_date" else ""
            if top and _mc_key(top) > _mc_key(mc):
                return f"{mc}〜{top}"
            return f"{mc} 以降"
        mc = re.sub(r"^>=\s*(\S+)$", r"\1 以降", mc)
        mc = re.sub(r"^\[([^,\]]+),\s*\)$", r"\1 以降", mc)  # Forge の [1.20.1,)
        return mc.lstrip("~^=")[:60]
    if source:
        if source.get("game_versions"):
            return summarize_mc(source["game_versions"])
        if source.get("status") == "up_to_date":
            return summarize_mc((source.get("latest") or {}).get("game_versions") or [])
    return ""
