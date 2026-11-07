// アップロードされた jar(zip)の中の、プラグイン・Mod の説明ファイルを読む(名前・版・動くサーバーの種類)。
// zip の目次(セントラルディレクトリ)だけを見て、決まったファイルだけを取り出す(全体は展開しない)
import { inflateRawSync } from "node:zlib";

export type JarInfo = { name: string; version: string; projectType: "plugin" | "mod" | null; loaders: string[]; mcVersions: string[] };

const MAX_ENTRY = 1024 * 1024; // 説明ファイルは 1 MB まで
const WANTED = ["plugin.yml", "paper-plugin.yml", "bungee.yml", "velocity-plugin.json", "fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"];

/** zip から、名前の決まったファイルの中身(テキスト)を取り出す。zip でなければ null */
export function readZipTexts(buf: Uint8Array, names: string[] | ((name: string) => boolean) = WANTED): Map<string, string> | null {
  const want = typeof names === "function" ? names : (n: string) => names.includes(n);
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  // 目次の終わり(EOCD)を後ろから探す
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
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
    if (!want(name) || usize > MAX_ENTRY || local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + csize);
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

/** jar を調べる。プラグイン・Mod として読めなければ projectType が null */
export function analyzeJar(buf: Uint8Array, filename: string): JarInfo {
  const files = readZipTexts(buf) ?? new Map<string, string>();
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
