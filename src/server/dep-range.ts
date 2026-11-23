// 前提の版の範囲(fabric.mod.json・quilt.mod.json の depends、mods.toml の versionRange)を、入っている版が満たすか。
// 読めない版・範囲は「満たす」とみなす(誤って「版が合わない」と出すより、見逃すほうがよい)

/** fabric = fabric.mod.json(版だけなら「その版」)/ quilt = quilt.mod.json(版だけなら「その版以上」とみなす)/ maven = mods.toml([1.0,2.0) など。版だけなら「その版以上」) */
export type VersionRange = { style: "fabric" | "quilt" | "maven"; any: string[] };

type V = { nums: number[]; pre: string[] };
type Test = (v: V) => boolean;

/** 版を、数の並びとプレリリースの印に分ける。+ のあと(ビルドの印)は見ない。読めなければ null */
export function parseVersion(s: string): V | null {
  const m = s.trim().split("+")[0].match(/^v?(\d+(?:\.\d+)*)(?:-([0-9a-z.-]+))?$/i);
  if (!m) return null;
  const nums = m[1].split(".").map(Number);
  const pre = m[2] ? m[2].toLowerCase().split(/[.-]/).filter(Boolean) : [];
  // 1.20.1-47.2.0 のように - のあとが数で始まるものは、プレリリースではなく番号の続きとみる(Forge の版の書き方。Maven でも 1.0-1 は 1.0 より新しい)
  while (/^\d+$/.test(pre[0] ?? "")) nums.push(Number(pre.shift()));
  return { nums, pre };
}

/** a と b の新旧(-1・0・1)。足りない桁は 0(1.21 = 1.21.0)。プレリリースは正式版より古い(1.0.0-beta.2 < 1.0.0) */
export function compareVersions(a: V, b: V): number {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    const d = nx && ny ? Number(x) - Number(y) : nx !== ny ? (nx ? -1 : 1) : x < y ? -1 : x > y ? 1 : 0;
    if (d) return Math.sign(d);
  }
  return 0;
}

const below = (nums: number[]): Test => (v) => compareVersions(v, { nums, pre: [] }) < 0;

// Fabric・Quilt の 1 つの条件(>=0.5・~1.21・^1.0・1.20.x・* など)
function term(t: string, bare: string): Test | null {
  if (t === "*") return () => true;
  const [, explicit, ver] = t.match(/^(>=|<=|>|<|=|~|\^)?(.+)$/) ?? [];
  if (!ver) return null;
  const op = explicit ?? bare;
  // 1.20.x・1.20.*: 頭の番号が同じもの(=・版だけのときだけ)
  const wild = ver.match(/^(\d+(?:\.\d+)*)\.[xX*]$/);
  if (wild) return !explicit || explicit === "=" ? (v) => wild[1].split(".").map(Number).every((n, i) => (v.nums[i] ?? 0) === n) : null;
  const r = parseVersion(ver);
  if (!r) return null;
  const c = (v: V) => compareVersions(v, r);
  switch (op) {
    case ">=": return (v) => c(v) >= 0;
    case ">": return (v) => c(v) > 0;
    case "<=": return (v) => c(v) <= 0;
    case "<": return (v) => c(v) < 0;
    case "=": return (v) => c(v) === 0;
    case "~": return (v) => c(v) >= 0 && below(r.nums.length > 1 ? [r.nums[0], r.nums[1] + 1] : [r.nums[0] + 1])(v);
    default: return (v) => c(v) >= 0 && below([r.nums[0] + 1])(v); // ^
  }
}

// Fabric・Quilt の範囲: 空白で区切ったものは全部(AND)
function fabricRange(s: string, bare: string): Test | null {
  const terms = s.replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1").trim().split(/\s+/).filter(Boolean).map((t) => term(t, bare));
  return terms.some((t) => !t) ? null : (v) => terms.every((t) => t!(v));
}

// Maven の範囲([1.0,2.0)・[1.0,)・(,2.0]・[1.20.1])。カンマでつないだ組はどれか(OR)。版だけなら「その版以上」
const SET = /([[(])([^\])]*)([\])])/g;
function mavenRange(s: string): Test | null {
  s = s.trim();
  if (!s || s === "*") return () => true;
  if (!/^[[(]/.test(s)) {
    const r = parseVersion(s);
    return r && ((v) => compareVersions(v, r) >= 0);
  }
  if (s.replace(SET, "").replace(/[\s,]/g, "")) return null;
  const sets = [...s.matchAll(SET)].map(([, open, body, close]): Test | null => {
    const [lo, hi, ...rest] = body.split(",").map((x) => x.trim());
    if (rest.length) return null;
    if (hi === undefined) {
      const r = parseVersion(lo);
      return r && open === "[" && close === "]" ? (v) => compareVersions(v, r) === 0 : null;
    }
    const l = lo ? parseVersion(lo) : undefined, h = hi ? parseVersion(hi) : undefined;
    if (l === null || h === null) return null;
    return (v) => (!l || compareVersions(v, l) >= (open === "[" ? 0 : 1)) && (!h || compareVersions(v, h) <= (close === "]" ? 0 : -1));
  });
  return sets.some((t) => !t) ? null : (v) => sets.some((t) => t!(v));
}

/** version が range を満たすか。版・範囲が読めなければ true */
export function satisfies(version: string, range: VersionRange): boolean {
  const v = parseVersion(version);
  const tests = range.any.map((r) => (range.style === "maven" ? mavenRange(r) : fabricRange(r, range.style === "quilt" ? ">=" : "=")));
  if (!v || !tests.length || tests.some((t) => !t)) return true;
  return tests.some((t) => t!(v)); // 並び(配列)は、どれかを満たせばよい
}

/** 画面に出す範囲の文字(並びは || でつなぐ) */
export const rangeText = (range: VersionRange) => range.any.join(" || ");
