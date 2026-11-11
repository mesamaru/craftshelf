// アップロードされた jar(zip)の中の、プラグイン・Mod の説明ファイルを読む(名前・版・動くサーバーの種類)。
// zip の目次(セントラルディレクトリ)だけを見て、決まったファイルだけを取り出す(全体は展開しない)
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export type JarInfo = { name: string; version: string; projectType: "plugin" | "mod" | null; loaders: string[]; mcVersions: string[] };

const MAX_ENTRY = 1024 * 1024; // 説明ファイルは 1 MB まで
const WANTED = ["plugin.yml", "paper-plugin.yml", "bungee.yml", "velocity-plugin.json", "fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"];

// 読む元: メモリの中身か、ディスクのファイル(大きいアップロードを、全体を読み込まずに調べる)
type ZipSource = { size: number; read(pos: number, len: number): Buffer };
const MAX_DIR = 64 * 1024 * 1024; // 目次は 64 MB まで

/** ファイルを、必要なところだけ読む元にする(使い終わったら close) */
export function fileSource(path: string): ZipSource & { close(): void } {
  const fd = openSync(path, "r");
  return {
    size: fstatSync(fd).size,
    read(pos, len) {
      const b = Buffer.alloc(Math.max(0, len));
      return b.subarray(0, readSync(fd, b, 0, b.length, pos));
    },
    close: () => closeSync(fd),
  };
}

/** zip から、名前の決まったファイルの中身(テキスト)を取り出す。zip でなければ null */
export function readZipTexts(buf: Uint8Array | ZipSource, names: string[] | ((name: string) => boolean) = WANTED): Map<string, string> | null {
  const want = typeof names === "function" ? names : (n: string) => names.includes(n);
  let src: ZipSource;
  if (buf instanceof Uint8Array) {
    const all = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    src = { size: all.length, read: (pos, len) => all.subarray(pos, pos + len) };
  } else src = buf;
  // 目次の終わり(EOCD)を後ろから探す
  const tailAt = Math.max(0, src.size - 22 - 65535);
  const tail = src.read(tailAt, src.size - tailAt);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return null;
  const count = tail.readUInt16LE(e + 10);
  const dirSize = tail.readUInt32LE(e + 12);
  const dirAt = tail.readUInt32LE(e + 16);
  if (dirSize > MAX_DIR || dirAt + dirSize > src.size) return null;
  const b = src.read(dirAt, dirSize);
  let p = 0;
  const out = new Map<string, string>();
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) return null;
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28);
    const xlen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (!want(name) || usize > MAX_ENTRY || csize > 2 * MAX_ENTRY || local + 30 > src.size) continue;
    const head = src.read(local, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) continue;
    const data = src.read(local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), csize);
    try {
      const raw = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) : null;
      if (raw) out.set(name, raw.toString("utf8"));
    } catch { /* 壊れたものは読まない */ }
  }
  return out;
}

// YAML の一番上の段の「key: value」だけを読む(説明ファイルに要るのはそれだけ)
const yamlTop = (text: string) => Object.fromEntries(text.split(/\r?\n/).map((l) => l.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)).filter((m) => !!m)
  .map((m) => [m![1], m![2].replace(/^["']|["']$/g, "")]));
const tomlFirst = (text: string, key: string) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1] ?? "";
const json = (text: string) => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
};

// YAML の「key: [A, B]」・「key: A」・「key:」の下の「- A」の並びを、文字の配列にする
function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return [];
  const clean = (s: string) => s.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const v = lines[i].slice(key.length + 1).replace(/\s+#.*$/, "").trim();
  if (v.startsWith("[")) return v.replace(/^\[|\]$/g, "").split(",").map(clean).filter(Boolean);
  if (v) return [clean(v)];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^\s+-\s*(.+?)\s*$/);
    if (m) out.push(clean(m[1]));
    else if (l.trim() && !l.trim().startsWith("#")) break;
  }
  return out.filter(Boolean);
}

// paper-plugin.yml の dependencies.server の、必須(required が false でない)のものの名前
function paperDeps(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^dependencies:\s*$/.test(l));
  if (start < 0) return [];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  let i = start + 1;
  while (i < lines.length && !/^\s+server:\s*$/.test(lines[i])) {
    if (lines[i].trim() && indentOf(lines[i]) === 0) return [];
    i++;
  }
  if (i >= lines.length) return [];
  const base = indentOf(lines[i]);
  const out: string[] = [];
  let cur: { name: string; required: boolean } | null = null;
  const flush = () => { if (cur?.required) out.push(cur.name); cur = null; };
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = indentOf(l);
    if (ind <= base) break;
    const m = l.trim().match(/^["']?([^"':\s]+)["']?:\s*(.*)$/);
    if (!m) continue;
    if (ind === base + 2) { flush(); cur = { name: m[1], required: true }; if (/required\s*:\s*false/.test(m[2])) cur.required = false; }
    else if (cur && m[1] === "required" && m[2].trim() === "false") cur.required = false;
  }
  flush();
  return out;
}

// forge・neoforge の mods.toml の、必須の前提の modId(minecraft・forge 本体などは除く)
function tomlDeps(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/^\s*\[\[dependencies\./m).slice(1)) {
    const section = block.split(/^\s*\[/m)[0];
    const id = section.match(/modId\s*=\s*["']([^"']+)["']/)?.[1];
    if (!id || /type\s*=\s*["'](?:optional|incompatible|discouraged)["']/.test(section) || /mandatory\s*=\s*false/.test(section)) continue;
    out.push(id);
  }
  return out;
}

const BUILT_IN = new Set(["minecraft", "java", "fabricloader", "fabric-loader", "quilt_loader", "forge", "neoforge", "fml", "javafml"]);

export type JarMeta = {
  /** 見分ける名前(jarKey と同じ) */
  key: string;
  /** 表示する名前・版(説明ファイルが無ければ "") */
  name: string;
  version: string;
  /** 必須の前提(key は見分ける名前、name は書いてあったままの名前) */
  depends: { key: string; name: string }[];
};

/**
 * 同じものかを見分ける名前(plugin.yml・paper-plugin.yml の name、velocity-plugin.json・fabric.mod.json・quilt.mod.json の id、mods.toml の modId)と、
 * 表示する名前・版・必須の前提(plugin.yml の depend、paper-plugin.yml の dependencies、mod の depends)を、1 回の読み取りで返す。
 * Paper は同じ名前のプラグインを 2 つ読み込めない。説明ファイルが無ければ key は ""(ファイル名からは決めない)
 */
export function jarMeta(buf: Uint8Array | ZipSource): JarMeta {
  const files = readZipTexts(buf) ?? new Map<string, string>();
  const key = (kind: string, v: unknown) => (typeof v === "string" && v.trim() ? `${kind}:${v.trim().toLowerCase()}` : "");
  const keys = (kind: string, list: string[]) => {
    const seen = new Map<string, string>();
    for (const x of list) if (x && !BUILT_IN.has(x.toLowerCase()) && key(kind, x) && !seen.has(key(kind, x))) seen.set(key(kind, x), x.trim());
    return [...seen].map(([k, name]) => ({ key: k, name }));
  };
  const info = analyzeFiles(files, "");
  const base = { name: info.projectType ? info.name : "", version: info.projectType ? info.version : "" };
  for (const f of ["paper-plugin.yml", "plugin.yml", "bungee.yml"]) {
    const t = files.get(f);
    if (!t) continue;
    const depends = f === "paper-plugin.yml" ? paperDeps(t) : yamlList(t, f === "bungee.yml" ? "depends" : "depend");
    return { key: key("plugin", yamlTop(t).name), ...base, depends: keys("plugin", depends) };
  }
  const velocity = files.get("velocity-plugin.json");
  if (velocity) {
    const j = json(velocity);
    const deps = Array.isArray(j.dependencies) ? (j.dependencies as { id?: unknown; optional?: unknown }[]).filter((d) => d && d.optional !== true).map((d) => String(d.id ?? "")) : [];
    return { key: key("velocity", j.id), ...base, depends: keys("velocity", deps) };
  }
  for (const f of ["fabric.mod.json", "quilt.mod.json"]) {
    const t = files.get(f);
    if (!t) continue;
    const j = json(t);
    const q = j.quilt_loader as Record<string, unknown> | undefined;
    const d = (f === "fabric.mod.json" ? j.depends : q?.depends) as unknown;
    const ids = Array.isArray(d) ? d.map((x) => (typeof x === "string" ? x : String((x as { id?: unknown })?.id ?? ""))) : d && typeof d === "object" ? Object.keys(d) : [];
    return { key: key("mod", j.id ?? q?.id), ...base, depends: keys("mod", ids) };
  }
  for (const f of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
    const t = files.get(f);
    if (t) return { key: key("mod", tomlFirst(t, "modId")), ...base, depends: keys("mod", tomlDeps(t)) };
  }
  return { key: "", ...base, depends: [] };
}

/** 同じものかを見分ける名前(jarMeta の key)。説明ファイルが無ければ "" */
export const jarKey = (buf: Uint8Array | ZipSource): string => jarMeta(buf).key;

/** jar を調べる。プラグイン・Mod として読めなければ projectType が null */
export function analyzeJar(buf: Uint8Array | ZipSource, filename: string): JarInfo {
  return analyzeFiles(readZipTexts(buf) ?? new Map<string, string>(), filename);
}

function analyzeFiles(files: Map<string, string>, filename: string): JarInfo {
  const loaders = new Set<string>();
  let name = "";
  let version = "";
  let projectType: JarInfo["projectType"] = null;
  const mcVersions: string[] = [];
  const take = (n: unknown, v: unknown) => {
    if (!name && typeof n === "string") name = n.trim();
    if (!version && (typeof v === "string" || typeof v === "number")) version = String(v).trim();
  };

  for (const f of ["paper-plugin.yml", "plugin.yml", "bungee.yml"]) {
    const t = files.get(f);
    if (!t) continue;
    const y = yamlTop(t);
    take(y.name, y.version);
    projectType = "plugin";
    if (f === "bungee.yml") ["bungeecord", "waterfall"].forEach((l) => loaders.add(l));
    else {
      (f === "plugin.yml" ? ["bukkit", "spigot", "paper", "purpur"] : ["paper", "purpur"]).forEach((l) => loaders.add(l));
      if (y["folia-supported"] === "true") loaders.add("folia");
    }
  }
  const velocity = files.get("velocity-plugin.json");
  if (velocity) {
    const v = json(velocity);
    take(v.name ?? v.id, v.version);
    projectType = "plugin";
    loaders.add("velocity");
  }
  for (const f of ["fabric.mod.json", "quilt.mod.json"]) {
    const t = files.get(f);
    if (!t) continue;
    const j = json(t);
    const q = (j.quilt_loader ?? {}) as Record<string, unknown>;
    take(j.name ?? (q.metadata as Record<string, unknown> | undefined)?.name ?? j.id ?? q.id, j.version ?? q.version);
    projectType = "mod";
    if (f === "fabric.mod.json") ["fabric", "quilt"].forEach((l) => loaders.add(l));
    else loaders.add("quilt");
    const mc = (j.depends as Record<string, unknown> | undefined)?.minecraft;
    if (typeof mc === "string") mcVersions.push(...(mc.match(/\d+\.\d+(?:\.\d+)?/g) ?? []));
  }
  for (const f of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
    const t = files.get(f);
    if (!t) continue;
    take(tomlFirst(t, "displayName") || tomlFirst(t, "modId"), tomlFirst(t, "version"));
    projectType = "mod";
    loaders.add(f.includes("neoforge") || /modId\s*=\s*["']neoforge["']/.test(t) ? "neoforge" : "forge");
  }
  // 版が ${file.jarVersion} のような置き換え前のものなら、ファイル名から取る
  // (Mod は「名前-MC の版-Mod の版.jar」が多いので、いちばん後ろの番号を使う)
  if (!version || version.includes("${")) version = [...filename.matchAll(/[-_ ]v?(\d+(?:\.\d+)+)/g)].at(-1)?.[1] ?? "";
  if (!name) name = filename.replace(/\.(jar|zip)$/i, "").replace(/[-_ ]v?\d+(?:\.\d+)+.*$/, "");
  return { name: name.slice(0, 80), version: version.slice(0, 40), projectType, loaders: [...loaders], mcVersions: [...new Set(mcVersions)] };
}

export type PackInfo = Omit<JarInfo, "projectType"> & { projectType: "datapack" | "resourcepack" | "shader" | "modpack" | null };

/**
 * .zip・.mrpack を調べる(v02 の解析と同じ): Modパック(modrinth.index.json・overrides の入った manifest.json)/ シェーダー(shaders/)/
 * データパック(pack.mcmeta と data/)/ リソースパック(pack.mcmeta と assets/)。読めなければ projectType が null
 */
export function analyzePack(buf: Uint8Array | ZipSource, filename: string): PackInfo {
  const names: string[] = [];
  const files = readZipTexts(buf, (n) => (names.push(n), n === "modrinth.index.json" || n === "manifest.json")) ?? new Map<string, string>();
  const stem = filename.replace(/\.(zip|mrpack)$/i, "");
  let name = stem.replace(/[-_ ]v?\d+(?:\.\d+)+.*$/, "");
  let version = [...stem.matchAll(/[-_ ]v?(\d+(?:\.\d+)+)/g)].at(-1)?.[1] ?? "";
  let projectType: PackInfo["projectType"] = null;
  const mcVersions: string[] = [];
  const take = (n: unknown, v: unknown, mc: unknown) => {
    if (typeof n === "string" && n.trim()) name = n.trim();
    if (typeof v === "string" && v.trim()) version = v.trim();
    if (typeof mc === "string" && mc) mcVersions.push(mc);
  };
  const tops = new Set(names.map((n) => n.split("/")[0]));
  if (files.has("modrinth.index.json")) {
    const d = json(files.get("modrinth.index.json")!);
    projectType = "modpack";
    take(d.name, d.versionId, (d.dependencies as Record<string, unknown> | undefined)?.minecraft);
  } else if (files.has("manifest.json") && names.some((n) => n.startsWith("overrides/"))) {
    const d = json(files.get("manifest.json")!);
    projectType = "modpack";
    take(d.name, d.version, (d.minecraft as Record<string, unknown> | undefined)?.version);
  } else if (tops.has("shaders") || names.some((n) => n.split("/")[1] === "shaders")) {
    projectType = "shader";
  } else {
    // フォルダごと zip にしたもの(<フォルダ>/pack.mcmeta)も読む
    const meta = names.includes("pack.mcmeta") ? "pack.mcmeta" : names.find((n) => n.endsWith("/pack.mcmeta") && n.split("/").length === 2);
    const prefix = meta ? meta.slice(0, -"pack.mcmeta".length) : "";
    if (names.some((n) => n.startsWith(`${prefix}data/`))) projectType = "datapack";
    else if (names.some((n) => n.startsWith(`${prefix}assets/`))) projectType = "resourcepack";
  }
  return { name: (name || stem).slice(0, 80), version: version.slice(0, 40), projectType, loaders: [], mcVersions };
}
