// 圧縮ファイルを安全に展開する(サーバーの「ファイル」タブ)。フォルダのサーバー(local.ts)とエージェント(src/agent/main.ts)が同じ処理を使う。
// 方針は 安全 > 便利。次を重ねる(docs/DESIGN.md「圧縮ファイルの展開」):
//   1. 読むだけの事前の確かめ(ディスクに 1 バイトも書かない): 形式・名前・リンク・数と大きさ・圧縮率・衝突・容量(予約領域つき)
//   2. 展開中の見張り: 同じボリュームの一時フォルダにだけ書き、書いた量を数え、一定量ごとに空き容量を測り直す。最後に rename で置く
//   3. 失敗・キャンセル・終了のときは、一時フォルダを丸ごと消す(起動のときも古いものを掃除する)
import { createHash, randomBytes } from "node:crypto";
import { rmSync, createReadStream, realpathSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { Readable, type Writable } from "node:stream";
import { createGunzip, createInflateRaw, crc32, inflateRawSync } from "node:zlib";
import { type ArchiveFormat, archiveBase, formatOf, unsupportedReason } from "../lib/archive";
import { fmtSize } from "../lib/format";
import { fileSource } from "./jar";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** 上限(サーバーの設定では変えられない。docs/DESIGN.md に同じ値を書く) */
export const EXTRACT_LIMITS = {
  files: 20_000, // ファイルとフォルダの合計
  depth: 32,
  fileBytes: 2 * GiB,
  totalBytes: 10 * GiB,
  ratio: 200, // 展開後 ÷ 圧縮ファイル
  ratioFloor: 64 * MiB, // これより小さい展開は率を見ない(jar など)
  archiveBytes: 4 * GiB,
  pteroArchiveBytes: 512 * MiB, // Pterodactyl はメモリに読んで確かめるので小さく
  pteroUnlimitedBytes: GiB, // Pterodactyl のディスクに上限が無いときの、合計の上限
  nameBytes: 255,
  pathBytes: 1024,
  reserveMin: GiB, // 予約領域 = max(これ, ボリュームの 5%)
  reservePercent: 0.05,
  pteroReservePercent: 0.1, // Pterodactyl はそのサーバーのディスクの上限の 10%
  usable: 0.8, // 「空き − 予約領域」の 80% まで
  checkEvery: 16 * MiB, // 書いた量がこれ増えるごとに空き容量を測り直す
  checkEveryFiles: 2000,
  staleMs: 10 * 60_000, // 印があり、生きている持ち主のいない一時フォルダが、これより古ければ掃除する(持ち主が死んでいると分かればすぐ)
  keepJobsMs: 10 * 60_000,
  listCalls: 5000, // 「ここに展開」の衝突の確かめでフォルダを読む回数
  metaBytes: 64 * 1024, // フォルダ・リンク・拡張ヘッダーの「データ部」の上限(読み捨てる量)
  tarSlack: 64 * MiB, // tar を読む総量は、合計の上限にこれを足した量まで
  pteroReadSlots: 2, // Pterodactyl の確かめ(圧縮ファイルをメモリに読む)の同時の数
  pteroReadBytes: 768 * MiB, // 同時に読み込んでいる合計の上限
  hashBytes: 32 * MiB, // Pterodactyl で取り消しのときに中身を読んで比べる 1 ファイルの上限
};
export type Limits = typeof EXTRACT_LIMITS;
export const mergeLimits = (p?: Partial<Limits>): Limits => ({ ...EXTRACT_LIMITS, ...p });

export type Mode = "folder" | "here";
export const STAGING = ".craftshelf-extract-";

/** 断る理由・止めた理由(画面に出せる言葉) */
export class ExtractError extends Error {
  readonly cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.name = "ExtractError";
    this.cancelled = cancelled;
  }
}
/** ビルドで束が分かれても見分けられるように(HttpError と同じ) */
export const isExtractError = (e: unknown): e is ExtractError => (e as { name?: unknown } | null)?.name === "ExtractError";

// ---- 名前の確かめ ----

// Windows の予約名(上付きの数字の COM¹・LPT² と、CONIN$・CONOUT$・CLOCK$ を含む)
const RESERVED = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i;
// 制御文字・見えない文字・向きを変える文字(表示と実際の名前が食い違う)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;
// Windows の 8.3 の短い名前の形(PROGRA~1・LONGFI~1.TXT)。長い名前の別名になって、あるファイルに重なるおそれがある
const SHORT83 = /^[^.]{1,6}~[0-9]+(\.[^.]{0,3})?$/;
/** 画面・記録に出す名前: 制御文字・見えない文字・向きを変える文字は、\uXXXX の形で見える形にする */
export const show = (s: string) => {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu, (c) => {
    const n = c.codePointAt(0)!;
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  }).replace(/\p{Surrogate}/gu, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

/**
 * 圧縮ファイルの中の 1 つの名前を確かめる。先頭の「./」だけは外す(tar の . から始まる名前)。
 * 問題があれば理由を返す(1 つでもあれば、全体を断る)
 */
export function cleanEntryName(raw: string): { name: string; dir: boolean; skip?: true; problem?: string } {
  const bad = (problem: string) => ({ name: "", dir: false, problem });
  if (raw === "") return bad("名前が空です");
  if (CONTROL.test(raw) || /\p{Surrogate}/u.test(raw)) return bad("制御文字(NUL など)・見えない文字を含む名前");
  if (raw.includes("\\")) return bad("バックスラッシュを含む名前");
  let s = raw;
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "" || s === ".") return { name: "", dir: true, skip: true };
  if (s.startsWith("/")) return bad("絶対パス(/ から始まる名前)");
  if (/^[A-Za-z]:/.test(s)) return bad("ドライブ名(C: など)から始まる名前");
  const dir = s.endsWith("/");
  const parts = (dir ? s.slice(0, -1) : s).split("/");
  let bytes = 0;
  for (const p of parts) {
    if (p === "") return bad("空の要素(//)を含むパス");
    if (p === "..") return bad("「..」を含むパス(展開先の外へ出ようとしています)");
    if (p === ".") return bad("「.」を含むパス");
    if (Buffer.byteLength(p) > EXTRACT_LIMITS.nameBytes) return bad(`名前が長すぎます(1 つの名前は ${EXTRACT_LIMITS.nameBytes} バイトまで)`);
    if (/[<>:"|?*]/.test(p)) return bad("Windows で使えない文字(< > : \" | ? *)を含む名前");
    if (/[. ]$/.test(p)) return bad("末尾が「.」か空白の名前");
    if (RESERVED.test(p.split(".")[0].trimEnd())) return bad("Windows の予約名(CON・NUL・COM1 など)");
    if (p.toLowerCase().startsWith(".craftshelf-")) return bad("「.craftshelf-」で始まる名前(CraftShelf が使う名前)");
    if (SHORT83.test(p)) return bad("Windows の短い名前(8.3)の形(PROGRA~1 など)");
    bytes += Buffer.byteLength(p) + 1;
  }
  if (bytes - 1 > EXTRACT_LIMITS.pathBytes) return bad(`パスが長すぎます(${EXTRACT_LIMITS.pathBytes} バイトまで)`);
  return { name: parts.join("/"), dir };
}

// 衝突を見る鍵: Unicode の正規化(NFC)をそろえ、大文字小文字を同じにする(Windows・macOS で同じ名前になるもの)
// 大文字にして小文字に戻す(ſ・ı・ς・µ など、小文字にしただけでは同じにならないものも同じにする)
const keyOf = (name: string) => name.normalize("NFC").toUpperCase().toLowerCase();

/** 大きさ・件数として使える数(0 以上の安全な整数)。NaN・Infinity・負・小数・2^53 以上は偽 */
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
/** 容量として使える数(有限で 0 以上) */
const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** 同じ理由はまとめて、名前を数個だけ見せる */
class Problems {
  private map = new Map<string, { n: number; names: string[] }>();
  add(msg: string, name?: string) {
    const m = this.map.get(msg) ?? { n: 0, names: [] };
    m.n++;
    if (name !== undefined && m.names.length < 3 && !m.names.includes(name)) m.names.push(name);
    this.map.set(msg, m);
  }
  get size() { return this.map.size; }
  list(): string[] {
    return [...this.map].map(([msg, { n, names }]) => (names.length
      ? `${msg}: ${names.map((x) => `「${show(x)}」`).join("")}${n > names.length ? ` ほか ${n - names.length} 個` : ""}`
      : n > 1 ? `${msg}(${n} 個)` : msg));
  }
}

/** 中の 1 つずつを確かめて数える(事前の確かめは理由を集め、展開中は strict で最初の違反で止める) */
export class Guard {
  readonly problems = new Problems();
  files = 0; dirs = 0; bytes = 0; maxFile = 0; depth = 0; stopped = false;
  private seen = new Map<string, { name: string; dir: boolean }>();
  private ancestors = new Set<string>();
  private totalTold = false;
  constructor(readonly L: Limits, private strict = false) {}

  report(msg: string, name?: string) {
    if (this.strict) throw new ExtractError(name === undefined ? msg : `${msg}: 「${show(name)}」`);
    this.problems.add(msg, name);
  }

  /** 1 つのエントリー。名前を整えて返す(飛ばすもの・違反のものは null) */
  add(raw: string, dirHint: boolean, size: number): { name: string; dir: boolean } | null {
    if (this.stopped) return null;
    // 大きさは、0 以上の安全な整数だけ(NaN・負・小数・2^53 以上は、数えられないので全体を断る)
    if (!isCount(size)) { this.report("大きさが正しくありません(数字でない・負・大きすぎる)", raw); this.stopped = true; return null; }
    const c = cleanEntryName(raw);
    if (c.skip) return null;
    if (c.problem) { this.report(c.problem, raw); return null; }
    const dir = dirHint || c.dir;
    const name = c.name;
    if (dir && size > 0) this.report("フォルダなのに中身があります", name);
    const key = keyOf(name);
    const prev = this.seen.get(key);
    if (prev) {
      this.report(prev.name === name ? "同じ名前が 2 回出てきます"
        : prev.name.normalize("NFC") === name.normalize("NFC") ? "Unicode の正規化(NFC/NFD)で同じになる名前" : "大文字小文字だけが違う名前", name);
    }
    const parts = name.split("/");
    if (parts.length > this.L.depth) this.report(`フォルダが深すぎます(${this.L.depth} 段まで)`, name);
    this.depth = Math.max(this.depth, parts.length);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const k = keyOf(acc);
      const s = this.seen.get(k);
      if (s && !s.dir) this.report("ファイルとフォルダが同じ名前", acc);
      this.ancestors.add(k);
    }
    if (!dir && this.ancestors.has(key)) this.report("ファイルとフォルダが同じ名前", name);
    this.seen.set(key, { name, dir });
    if (dir) this.dirs++;
    else {
      this.files++;
      // 合計が 2^53 を超える(桁あふれ)ときも、上限を超えたものとして扱う
      const sum = this.bytes + size;
      const overflow = !Number.isSafeInteger(sum);
      this.bytes = overflow ? Number.MAX_SAFE_INTEGER : sum;
      this.maxFile = Math.max(this.maxFile, size);
      if (overflow && !this.totalTold) { this.totalTold = true; this.report(`展開後の合計が大きすぎます(${fmtSize(this.L.totalBytes)} まで)`); this.stopped = true; }
      if (!(size <= this.L.fileBytes)) this.report(`1 つのファイルが大きすぎます(${fmtSize(this.L.fileBytes)} まで)`, name);
      if (!(this.bytes <= this.L.totalBytes) && !this.totalTold) {
        this.totalTold = true;
        this.report(`展開後の合計が大きすぎます(${fmtSize(this.L.totalBytes)} まで)`);
        this.stopped = true;
      }
    }
    if (!(this.files + this.dirs <= this.L.files) && !this.stopped) {
      this.report(`ファイルが多すぎます(${this.L.files.toLocaleString("en-US")} 個まで)`);
      this.stopped = true;
    }
    return { name, dir };
  }
}

/** 展開先に入れない場所(ワールド・ログ。.craftshelf-* は名前の確かめで別に断る) */
/** server.properties を Java の Properties と同じに読む(区切りは = : 空白・# ! のコメント・\ の継続行とエスケープ・同じ項目は最後が勝つ) */
export function parseProps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const ws = /^[ \t\f]+/;
  const unescape = (s: string) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c === "f" ? "\f" : c));
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(ws, "");
    if (!line || line[0] === "#" || line[0] === "!") continue;
    // 行の終わりの \ が奇数個なら、次の行に続く
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(ws, "");
    let k = 0;
    while (k < line.length && !"=: \t\f".includes(line[k])) k += line[k] === "\\" ? 2 : 1;
    const key = line.slice(0, k);
    let rest = line.slice(k).replace(ws, "");
    if (rest[0] === "=" || rest[0] === ":") rest = rest.slice(1).replace(ws, "");
    out.set(unescape(key), unescape(rest));
  }
  return out;
}
/** ワールドのフォルダの名前(level-name)。読めない・無いときは "" */
export const levelOf = (text: string | null | undefined) => (text ? parseProps(text).get("level-name") ?? "" : "");

// サーバーのフォルダからの相対パスにそろえる(\ → /・./ や .. をたたむ・先頭と末尾の / を外す)。外を指す・絶対パス・空は "" にする
function normRel(p: string) {
  const n = posix.normalize(String(p ?? "").replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return !n || n === "." || n === ".." || n.startsWith("../") || n.startsWith("/") || /^[A-Za-z]:/.test(n) ? "" : n;
}
/** 展開先に入れない場所(ワールド・ログ。.craftshelf-* は名前の確かめで別に断る)。level-name は正規化してから使う。読めない・空・外を指すときは world */
export const protectedOf = (level: string) => {
  const l = normRel(level) || "world";
  const names = new Set([l, l.replace(/[. ]+$/, "")]); // Windows は末尾の空白・ドットを無視する
  return [...names].filter(Boolean).flatMap((n) => [n, `${n}_nether`, `${n}_the_end`]).concat("logs");
};
/** サーバーのフォルダからの相対パス rel が、守る場所の中か(正規化・大文字小文字・末尾のスラッシュは見ない) */
export function protectedHit(rel: string, protect: string[]) {
  const k = keyOf(normRel(rel) || String(rel ?? "").replace(/\\/g, "/"));
  if (k.split("/").some((p) => p.startsWith(".craftshelf-"))) return "CraftShelf が使うフォルダ(.craftshelf-…)";
  const hit = protect.find((p) => { const q = keyOf(normRel(p) || p); return k === q || k.startsWith(`${q}/`); });
  return hit ? (hit === "logs" ? "ログのフォルダ(logs)" : `ワールドのフォルダ(${hit})`) : null;
}

// ---- 中の一覧を読む(読むだけ) ----

export type Entry = { name: string; dir: boolean; size: number; csize: number; method: number; crc: number; local: number };
export type Scan = { format: ArchiveFormat; entries: Entry[]; guard: Guard; fatal: string[] };
type ZipSrc = { size: number; read(pos: number, len: number): Buffer };
export const memorySource = (b: Uint8Array): ZipSrc => {
  const all = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return { size: all.length, read: (pos, len) => all.subarray(pos, pos + len) };
};

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_Z64 = 0x07064b50;
const MAX_CD = 16 * MiB;
const LINKS = "シンボリックリンク・ハードリンク・デバイス・FIFO は展開できません";

function zipName(raw: Buffer, flags: number, g: Guard): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    if (flags & 0x800) { g.report("名前が UTF-8 として正しくありません", raw.toString("latin1")); return null; }
    return new TextDecoder("shift_jis").decode(raw); // 古い Windows の zip(日本語)
  }
}

/** zip の中央ディレクトリを読む。暗号化・マルチパート・ZIP64・自己展開・データの重なり・名前の食い違いは断る */
export function scanZip(src: ZipSrc, L: Limits): Scan {
  const g = new Guard(L);
  const out: Scan = { format: "zip", entries: [], guard: g, fatal: [] };
  const fatal = (m: string) => { out.fatal.push(m); return out; };
  const tailAt = Math.max(0, src.size - 22 - 65535);
  const tail = src.read(tailAt, src.size - tailAt);
  // 末尾の EOCD は「最後に見つかった署名」(Go の archive/zip・Python の zipfile と同じ読み方。Wings が違う EOCD を読まないように)。
  // その EOCD のコメントが、ちょうどファイルの終わりまで届いていなければ、曖昧として断る(コメントに別の EOCD を入れた zip)
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
  if (e >= 0 && e + 22 + tail.readUInt16LE(e + 20) !== tail.length) return fatal("zip として読めません(末尾の目次の終わりが、ファイルの終わりと合いません。末尾に余分なデータがある・偽の目次を疑います)");
  if (e < 0) return fatal("zip として読めません(壊れているか、zip ではありません。末尾に余分なデータがある zip も断ります)");
  const count = tail.readUInt16LE(e + 10);
  const dirSize = tail.readUInt32LE(e + 12);
  const dirAt = tail.readUInt32LE(e + 16);
  if (tail.readUInt16LE(e + 4) || tail.readUInt16LE(e + 6) || tail.readUInt16LE(e + 8) !== count) return fatal("複数のファイルに分かれた zip(マルチパート)は展開できません");
  if (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff || (e >= 20 && tail.readUInt32LE(e - 20) === SIG_Z64)) return fatal("ZIP64 の zip は展開できません");
  if (count > L.files) return fatal(`ファイルが多すぎます(${L.files.toLocaleString("en-US")} 個まで。この zip は ${count.toLocaleString("en-US")} 個)`);
  const eocd = tailAt + e;
  if (dirSize > MAX_CD || dirAt + dirSize > eocd) return fatal("zip の目次が壊れています");
  const b = src.read(dirAt, dirSize);
  if (b.length < dirSize) return fatal("zip の目次が壊れています");
  const raws: Buffer[] = [];
  let p = 0;
  let encrypted = false;
  let multi = false;
  let zip64 = false;
  const methods = new Set<number>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== SIG_CEN) return fatal("zip の目次が壊れています");
    const made = b.readUInt16LE(p + 4);
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28);
    const xlen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const disk = b.readUInt16LE(p + 34);
    const ext = b.readUInt32LE(p + 38);
    const local = b.readUInt32LE(p + 42);
    if (p + 46 + nlen + xlen + clen > b.length) return fatal("zip の目次が壊れています");
    const raw = b.subarray(p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (flags & 0x41) encrypted = true;
    if (disk) multi = true;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) zip64 = true;
    const name = zipName(raw, flags, g);
    if (name === null) continue;
    // 種類(Unix の mode)。リンク・デバイス・FIFO は作らない
    const host = made >> 8;
    const fmt = (ext >>> 16) & 0o170000;
    // 作った OS が Unix でなくても(macOS・NTFS など)、Unix のモードがリンク・デバイス・FIFO なら断る
    if (fmt === 0o120000 || fmt === 0o020000 || fmt === 0o060000 || fmt === 0o010000 || fmt === 0o140000) { g.report(LINKS, name); continue; }
    if (host !== 3 && (ext & 0x400)) { g.report(LINKS, name); continue; }
    if (method !== 0 && method !== 8) methods.add(method);
    if (method === 0 && csize !== usize) g.report("保存のみの形式なのに大きさが合いません", name);
    if (usize > L.fileBytes || (usize > L.ratioFloor && csize > 0 && usize / csize > L.ratio) || (usize > 0 && csize === 0 && method === 8)) {
      if (usize > L.fileBytes) g.report(`1 つのファイルが大きすぎます(${fmtSize(L.fileBytes)} まで)`, name);
      else g.report(`圧縮率が高すぎます(${L.ratio} 倍まで。zip 爆弾の疑い)`, name);
      continue;
    }
    const c = g.add(name, name.endsWith("/") || (host === 3 && fmt === 0o040000), usize);
    if (g.stopped) break;
    if (!c) continue;
    raws.push(raw);
    out.entries.push({ name: c.name, dir: c.dir, size: c.dir ? 0 : usize, csize, method, crc, local });
  }
  if (encrypted) g.report("暗号化された zip は展開できません");
  if (multi) g.report("複数のファイルに分かれた zip(マルチパート)は展開できません");
  if (zip64) g.report("ZIP64 の zip は展開できません");
  if (methods.size) g.report(`この圧縮の方式(${[...methods].join("・")})は展開できません(deflate か無圧縮だけ)`);
  if (g.problems.size || g.stopped) return out;
  // 局所ヘッダー: 名前が目次と同じか・データが重ならないか・先頭に余分なものが無いか
  const order = out.entries.map((x, i) => ({ x, raw: raws[i] })).sort((a, z) => a.x.local - z.x.local);
  let end = 0;
  for (const { x, raw } of order) {
    const head = src.read(x.local, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOC) { g.report("zip のデータの場所が壊れています", x.name); break; }
    const nlen = head.readUInt16LE(26);
    const xlen = head.readUInt16LE(28);
    if (!src.read(x.local + 30, nlen).equals(raw)) { g.report("目次と中身で名前が食い違っています", x.name); break; }
    if (x.local < end) { g.report("データが重なっています(zip 爆弾の疑い)", x.name); break; }
    const dataEnd = x.local + 30 + nlen + xlen + x.csize;
    if (dataEnd > dirAt) { g.report("zip のデータの場所が壊れています", x.name); break; }
    end = dataEnd;
  }
  if (!g.problems.size && order.length && order[0].x.local !== 0) g.report("先頭に余分なデータがあります(自己展開形式など)");
  return out;
}

// ---- tar ----

type TarHead = { name: string; size: number; type: string; sparse: boolean };
/** tar を読む総量・エントリーの数の上限(フォルダ・リンクの大きなデータ部を読み捨てて、CPU を使い続けさせない) */
type TarLimit = { bytes: number; entries: number };
const tarLimit = (L: Limits): TarLimit => ({ bytes: L.totalBytes + L.tarSlack, entries: L.files * 3 });
type Sink = { write(b: Buffer): Promise<void> | void; end(): Promise<void> | void };
const STOP = Symbol("stop");
const TAR_LINKS = new Set(["1", "2", "3", "4", "6"]); // ハードリンク・シンボリックリンク・キャラクタデバイス・ブロックデバイス・FIFO
const nul = (b: Buffer) => b.toString("utf8").replace(/\0[\s\S]*$/, "");

type Pax = { path?: string; size?: number; sparse?: boolean };
function paxOf(data: Buffer): Pax {
  const out: Pax = {};
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const lenText = sp < 0 ? "" : data.subarray(p, sp).toString();
    const len = /^[0-9]{1,9}$/.test(lenText) ? Number(lenText) : Number.NaN;
    if (sp < 0 || !Number.isInteger(len) || len <= sp - p + 1 || p + len > data.length) throw new ExtractError("tar の拡張ヘッダーが壊れています");
    const rec = data.subarray(sp + 1, p + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    const key = eq < 0 ? rec : rec.slice(0, eq);
    const value = eq < 0 ? "" : rec.slice(eq + 1);
    if (key === "path") out.path = value;
    else if (key === "size") {
      // 大きさは 10 進の数字だけ(abc・負・小数・指数・16 進・空・2^53 以上は、その tar 全体を断る)
      const n = /^[0-9]{1,16}$/.test(value) ? Number(value) : Number.NaN;
      if (!isCount(n)) throw new ExtractError("tar の拡張ヘッダーの大きさが正しくありません(数字でない・負・小数・大きすぎる)");
      out.size = n;
    } else if (key.startsWith("GNU.sparse.")) out.sparse = true; // 穴あきファイル(sparse)は、地図とデータの並びが普通のファイルに見えるので、断る
    p += len;
  }
  return out;
}
/** tar のヘッダーの 8 進の欄(大きさ)。8 進の数字だけ。それ以外は壊れているとして断る */
function octalField(b: Buffer) {
  const t = nul(b).trim();
  if (t === "") return 0;
  const n = /^[0-7]{1,16}$/.test(t) ? Number.parseInt(t, 8) : Number.NaN;
  if (!isCount(n)) throw new ExtractError("tar のヘッダーが壊れています(大きさ)");
  return n;
}

/**
 * tar を先頭から読み、エントリーごとに onEntry を呼ぶ(ファイルなら中身を返された sink に渡す)。全体をメモリに持たない。
 * 違反・壊れ・切れは ExtractError。onEntry が STOP を投げたら、そこでやめる
 */
async function walkTar(input: AsyncIterable<Buffer>, onEntry: (h: TarHead) => Promise<Sink | null> | Sink | null, lim: TarLimit, metaBytes: number) {
  let walked = 0;
  let count = 0;
  let pending: Buffer = Buffer.alloc(0);
  let phase: "head" | "data" | "pad" = "head";
  let remain = 0;
  let padLeft = 0;
  let sink: Sink | null = null;
  let meta: { kind: string; chunks: Buffer[] } | null = null;
  let pax: Pax = {};
  let longName = "";
  let zero = 0;
  let finished = false;
  const toPad = (n: number) => (512 - (n % 512)) % 512;
  for await (const chunk of input) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (!finished) {
      if (phase === "head") {
        if (pending.length < 512) break;
        const h = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (h.every((x) => x === 0)) { if (++zero >= 2) finished = true; continue; }
        zero = 0;
        let sum = 0;
        let signed = 0;
        for (let i = 0; i < 512; i++) {
          const v = i >= 148 && i < 156 ? 0x20 : h[i];
          sum += v;
          signed += v > 127 ? v - 256 : v;
        }
        const stored = parseInt(nul(h.subarray(148, 156)).trim() || "x", 8);
        if (stored !== sum && stored !== signed) throw new ExtractError("tar のヘッダーが壊れています(チェックサムが合いません)");
        const type = String.fromCharCode(h[156] || 48);
        if (++count > lim.entries) throw new ExtractError("tar のエントリーが多すぎます");
        if (h[124] & 0x80) throw new ExtractError("1 つのファイルが大きすぎます(tar の大きさの書き方)");
        const size = octalField(h.subarray(124, 136));
        const isFile = type === "0" || type === "7";
        const isMeta = type === "x" || type === "g" || type === "L" || type === "K";
        // フォルダ・リンク・拡張ヘッダーの「データ部」は、小さいものだけ(大きなデータ部を読み捨てさせて CPU を使わせない)
        if (!isFile && size > metaBytes) throw new ExtractError(isMeta ? "tar の拡張ヘッダーが大きすぎます" : "フォルダ・リンクなどの中身が大きすぎます(tar のデータ部)");
        if (isMeta) {
          meta = { kind: type, chunks: [] };
          walked += size;
          if (!(walked <= lim.bytes)) throw new ExtractError("tar の中身の合計が大きすぎます");
          remain = size;
          padLeft = toPad(size);
          phase = remain ? "data" : "pad";
          if (!remain) { finishMeta(); if (!padLeft) phase = "head"; }
          continue;
        }
        // prefix を使うのは POSIX の ustar(「ustar」+ NUL)だけ。GNU 形式(「ustar  」)の 345 バイト目以降は、時刻などが入っている
        const magic = h.toString("latin1", 257, 263);
        const prefix = magic === "ustar\0" ? nul(h.subarray(345, 500)) : "";
        const base = nul(h.subarray(0, 100));
        const name = pax.path ?? (longName || (prefix ? `${prefix}/${base}` : base));
        const real = isFile ? pax.size ?? size : size;
        const sparse = !!pax.sparse;
        pax = {};
        longName = "";
        walked += real;
        if (!(walked <= lim.bytes)) throw new ExtractError("tar の中身の合計が大きすぎます");
        sink = await onEntry({ name, size: real, type, sparse });
        remain = real;
        padLeft = toPad(real);
        phase = remain ? "data" : "pad";
        if (!remain) { await sink?.end(); sink = null; if (!padLeft) phase = "head"; }
        continue;
      }
      if (phase === "data") {
        if (!pending.length) break;
        const take = Math.min(remain, pending.length);
        const part = pending.subarray(0, take);
        pending = pending.subarray(take);
        if (meta) meta.chunks.push(part);
        else await sink?.write(part);
        remain -= take;
        if (remain === 0) {
          if (meta) finishMeta(); else { await sink?.end(); sink = null; }
          phase = padLeft ? "pad" : "head";
        }
        continue;
      }
      if (!pending.length) break;
      const skip = Math.min(padLeft, pending.length);
      pending = pending.subarray(skip);
      padLeft -= skip;
      if (padLeft === 0) phase = "head";
    }
    if (finished) break;
  }
  if (!finished && (phase !== "head" || pending.length)) throw new ExtractError("tar が途中で切れています");

  function finishMeta() {
    const m = meta!;
    meta = null;
    const data = Buffer.concat(m.chunks);
    if (m.kind === "x") { const p = paxOf(data); pax = { ...pax, ...p, sparse: !!(pax.sparse || p.sparse) }; }
    else if (m.kind === "g") {
      // 全体に効く拡張ヘッダーは、ツールによって扱いが違う(後ろの全部に path を当てるものもある)ので、名前・大きさ・sparse を含むものは断る
      const g = paxOf(data);
      if (g.path !== undefined || g.size !== undefined || g.sparse) throw new ExtractError("全体に効く拡張ヘッダー(g)の path・size・sparse は扱えません");
    } else if (m.kind === "L") longName = nul(data);
  }
}

/** tar(を gzip で包んだもの)の中身を、少しずつ返す。使い終わったら入力も閉じる */
async function* rawTar(input: Readable, gz: boolean): AsyncGenerator<Buffer> {
  const out: Readable = gz ? createGunzip({ chunkSize: MiB }) : input;
  if (gz) {
    input.on("error", (e) => out.destroy(e));
    input.pipe(out as unknown as Writable);
  }
  try {
    for await (const c of out) yield c as Buffer;
  } finally {
    input.destroy();
    out.destroy();
  }
}
const localTar = (path: string, gz: boolean) => rawTar(createReadStream(path, { highWaterMark: MiB }), gz);
export const memoryTar = (b: Uint8Array, gz: boolean) => rawTar(Readable.from([Buffer.from(b.buffer, b.byteOffset, b.byteLength)]), gz);

/** 展開できない種類のエントリーなら、その理由(確かめと展開で同じ判定を使う) */
function tarProblem(h: TarHead): string | null {
  if (TAR_LINKS.has(h.type)) return LINKS;
  if (h.type !== "0" && h.type !== "5" && h.type !== "7") return `対応していない種類のエントリー(型 ${h.type})`;
  if (h.sparse) return "穴あきファイル(sparse)は展開できません";
  return null;
}

/** tar を先頭から読んで、一覧・数・大きさを数える(ファイルには書かない) */
export async function scanTar(src: AsyncIterable<Buffer>, format: ArchiveFormat, L: Limits): Promise<Scan> {
  const g = new Guard(L);
  const out: Scan = { format, entries: [], guard: g, fatal: [] };
  try {
    await walkTar(src, (h) => {
      if (g.stopped) throw STOP;
      const bad = tarProblem(h);
      if (bad) { g.report(bad, h.name); return null; }
      const dir = h.type === "5";
      const c = g.add(h.name, dir, dir ? 0 : h.size);
      if (c) out.entries.push({ name: c.name, dir: c.dir, size: c.dir ? 0 : h.size, csize: 0, method: 0, crc: 0, local: 0 });
      // 大きすぎるファイル・上限を超えた合計は、もう数えなくてよい(中身を読み飛ばして時間を使わない)
      if (g.stopped || (!dir && !(h.size <= L.fileBytes))) throw STOP;
      return null;
    }, tarLimit(L), L.metaBytes);
  } catch (e) {
    if (e === STOP) return out;
    if (isExtractError(e)) out.fatal.push((e as ExtractError).message);
    else out.fatal.push("tar として読めません(壊れているか、tar.gz ではありません)");
  }
  return out;
}

// ---- 容量・計画 ----

export type Statfs = (path: string) => Promise<{ free: number; total: number; block: number } | null>;
export const realStatfs: Statfs = async (p) => {
  try {
    const s = await statfs(p, { bigint: true }); // 掛け算の前に BigInt にそろえる(number と BigInt が混ざらない)
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    if (free > BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER) || s.bsize <= 0n) return null;
    return { free: Number(free), total: Number(total), block: Number(s.bsize) };
  } catch {
    return null;
  }
};
/** statfs の結果が、使える数(空き・全体が有限で 0 以上、全体は 0 より大きく、ブロックは正)か。使えなければ null(空き容量が分からない) */
export function validFs(f: { free: number; total: number; block: number } | null | undefined) {
  return f && isAmount(f.free) && isAmount(f.total) && f.total > 0 && isAmount(f.block) && f.block > 0 && f.free <= Number.MAX_SAFE_INTEGER && f.total <= Number.MAX_SAFE_INTEGER ? f : null;
}
/** 容量の確かめの前提: volume = ボリュームの空き / limit = Pterodactyl のディスクの上限(MB)と使用中 / unlimited = 上限なし */
export type Space = { kind: "volume"; free: number | null; total: number | null; block: number } | { kind: "limit"; free: number | null; limit: number; block: number } | { kind: "unlimited"; block: number };

/** 予約領域を増やす環境変数(増やす向きにだけ効く。減らせない) */
const reserveEnv = () => {
  const n = Number(process.env.CRAFTSHELF_EXTRACT_RESERVE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export type Plan = {
  ok: boolean; reasons: string[]; archive: string; name: string; format: ArchiveFormat | null; archiveBytes: number;
  mode: Mode; dest: string; how: "self" | "panel";
  files: number; dirs: number; bytes: number; maxFile: number; depth: number; ratio: number;
  conflicts: string[]; conflictCount: number;
  space: { free: number | null; total: number | null; reserve: number; need: number; usable: number | null; after: number | null; unlimited: boolean; unknown: boolean };
};

const blocks = (n: number, block: number) => Math.ceil(Math.max(n, 1) / block) * block;
/** ディスクに置いたときの大きさの、確実な上限(1 つ 1 つをブロックの大きさに切り上げる)。数が使えなければ Infinity(通さない側) */
export const diskNeed = (entries: Entry[], block: number) => {
  if (!(isAmount(block) && block > 0)) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const e of entries) {
    if (!e.dir && !isCount(e.size)) return Number.POSITIVE_INFINITY;
    sum += e.dir ? block : blocks(e.size, block);
  }
  return Number.isSafeInteger(sum) ? sum : Number.POSITIVE_INFINITY;
};

// 容量・上限の比較は、すべて「通る条件」を肯定形で書く(NaN・Infinity・負・undefined は、通さずに止める側に倒れる)
function capacity(space: Space, need: number, bytes: number, L: Limits) {
  const extra = reserveEnv();
  const unknown = (total: number | null, reserve: number) => ({
    reasons: ["空き容量が分からないので展開しません"],
    info: { free: null, total, reserve, need: Number.isFinite(need) ? need : 0, usable: null, after: null, unlimited: false, unknown: true },
  });
  if (space.kind === "unlimited") {
    const passes = isAmount(bytes) && bytes <= L.pteroUnlimitedBytes;
    const reasons = passes ? [] : [`サーバーのディスクの上限が決まっていないので、展開できるのは合計 ${fmtSize(L.pteroUnlimitedBytes)} までです(この圧縮ファイルは ${fmtSize(bytes)})`];
    return { reasons, info: { free: null, total: null, reserve: 0, need: Number.isFinite(need) ? need : 0, usable: L.pteroUnlimitedBytes, after: null, unlimited: true, unknown: false } };
  }
  const total = space.kind === "volume" ? space.total : space.limit;
  const free = space.free;
  if (!isAmount(total) || !(total > 0) || !isAmount(free)) return unknown(isAmount(total) ? total : null, 0);
  const reserve = Math.max(space.kind === "volume" ? Math.max(L.reserveMin, total * L.reservePercent) : total * L.pteroReservePercent, extra);
  if (!isAmount(reserve)) return unknown(total, 0);
  const usable = Math.max(0, (free - reserve) * L.usable);
  const reasons: string[] = [];
  if (!(isAmount(need) && isAmount(usable) && need <= usable)) {
    reasons.push(`空き容量が足りません(展開に最大 ${fmtSize(need)} が要ります。空き ${fmtSize(free)} から予約領域 ${fmtSize(reserve)} を残すと、使えるのは ${fmtSize(usable)} までです)`);
  }
  return { reasons, info: { free, total, reserve, need: Number.isFinite(need) ? need : 0, usable, after: free - (Number.isFinite(need) ? need : 0), unlimited: false, unknown: false } };
}

/** 事前の確かめの結果をまとめる(展開先・衝突・容量・守る場所を含む) */
export function assemblePlan(a: {
  archive: string; format: ArchiveFormat | null; archiveBytes: number; scan: Scan | null; mode: Mode; destRel: string; how: "self" | "panel";
  conflicts: string[]; conflictCount: number; space: Space; protect: string[]; pre: string[]; L: Limits;
}): Plan {
  const { scan, L } = a;
  const g = scan?.guard;
  const reasons = [...new Set([...a.pre, ...(scan?.fatal ?? []), ...(g?.problems.list() ?? [])])];
  const bytes = g?.bytes ?? 0;
  if (scan && !scan.fatal.length && !g!.stopped) {
    if (g!.files + g!.dirs === 0) reasons.push("圧縮ファイルの中身が空です");
    if (bytes > L.ratioFloor && !(a.archiveBytes > 0 && bytes / a.archiveBytes <= L.ratio)) {
      reasons.push(`圧縮率が高すぎます(${L.ratio} 倍まで。この圧縮ファイルは約 ${Math.round(bytes / a.archiveBytes)} 倍。zip 爆弾の疑い)`);
    }
    const dest = protectedHit(a.destRel, a.protect);
    if (dest) { const m = `展開先が守っている場所です: ${dest}`; if (!reasons.includes(m)) reasons.push(m); }
    else {
      const hits = scan.entries.map((e) => ({ e, why: protectedHit(a.destRel ? `${a.destRel}/${e.name}` : e.name, a.protect) })).filter((x) => x.why);
      if (hits.length) reasons.push(`守っている場所(${hits[0].why})の中に展開するものがあります: 「${show(hits[0].e.name)}」${hits.length > 1 ? ` ほか ${hits.length - 1} 個` : ""}`);
    }
    if (a.conflictCount) reasons.push(`同じ名前のファイル・フォルダが、展開先にすでにあります(${a.conflictCount} 個。上書きはしません)`);
  }
  const block = isAmount(a.space.block) && a.space.block > 0 ? a.space.block : 4096;
  const need = scan ? diskNeed(scan.entries, block) : 0;
  const cap = capacity(a.space, need, bytes, L);
  if (scan && !scan.fatal.length && !g!.stopped) reasons.push(...cap.reasons);
  const name = basename(a.archive);
  return {
    ok: reasons.length === 0 && !!scan, reasons, archive: a.archive, name, format: a.format, archiveBytes: a.archiveBytes, mode: a.mode, dest: a.destRel, how: a.how,
    files: g?.files ?? 0, dirs: g?.dirs ?? 0, bytes, maxFile: g?.maxFile ?? 0, depth: g?.depth ?? 0, ratio: a.archiveBytes ? bytes / a.archiveBytes : 0,
    conflicts: a.conflicts.slice(0, 20), conflictCount: a.conflictCount, space: cap.info,
  };
}

const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const joinRel = (a: string, b: string) => (a ? `${a}/${b}` : b);

/** 「新しいフォルダ」の名前: 圧縮ファイルの名前から、空いていて守る場所でもない名前を選ぶ(Foo → Foo-2 …) */
export function freeFolderName(archiveName: string, parentRel: string, existing: string[], protect: string[]) {
  const c = cleanEntryName(archiveBase(archiveName));
  const base = c.problem || c.skip || c.name.includes("/") ? "extracted" : c.name;
  const taken = new Set(existing.map(keyOf));
  for (let i = 1; i < 1000; i++) {
    const cand = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(keyOf(cand)) && !protectedHit(joinRel(parentRel, cand), protect)) return cand;
  }
  return null;
}

/** 「ここに展開」: 圧縮ファイルの中の名前が、展開先にすでにあるものを探す(フォルダ同士は中へ進む。ファイルが同じ名前・種類が違うなら衝突) */
export async function findConflicts(destRel: string, entries: Entry[], list: (rel: string) => Promise<{ name: string; isFile: boolean }[] | null>, maxCalls = EXTRACT_LIMITS.listCalls) {
  const bad: string[] = [];
  const existing = new Set<string>(); // 展開先にもともとあったフォルダ(取り消しで消さない)
  // 展開先からの相対パスを、親ごとにまとめる
  const kids = new Map<string, Map<string, { name: string; dir: boolean }>>();
  const put = (path: string, dir: boolean) => {
    const parent = parentOf(path);
    const m = kids.get(parent) ?? new Map();
    const n = path.slice(parent ? parent.length + 1 : 0);
    if (!m.has(keyOf(n))) m.set(keyOf(n), { name: n, dir });
    kids.set(parent, m);
  };
  for (const e of entries) {
    const parts = e.name.split("/");
    for (let i = 1; i < parts.length; i++) put(parts.slice(0, i).join("/"), true);
    put(e.name, e.dir);
  }
  let calls = 0;
  const walk = async (rel: string) => {
    const children = kids.get(rel);
    if (!children) return;
    if (++calls > maxCalls) throw new ExtractError("展開先のフォルダが多すぎて、同じ名前がないか確かめきれません");
    const have = await list(joinRel(destRel, rel));
    if (!have) return; // 無いフォルダ
    const names = new Map(have.map((h) => [keyOf(h.name), h]));
    for (const [k, c] of children) {
      const hit = names.get(k);
      const path = joinRel(rel, c.name);
      if (!hit) continue;
      if (c.dir && !hit.isFile) { existing.add(path); await walk(path); } else bad.push(path);
    }
  };
  await walk("");
  return { bad, existing };
}

// ---- 展開の実行(同じボリュームの一時フォルダに書いてから、置く) ----

/** 展開で作ったファイル: 名前・大きさ・更新の時刻・内容の sha256(空 = 作った側で確かめられなかった) */
export type FileRec = [string, number, number, string];
export type Created = { dirs: string[]; files: FileRec[] };
export type ExtractResult = { base: string; mode: Mode; files: number; dirs: number; bytes: number; created: Created };
export type Phase = "checking" | "extracting" | "placing" | "done" | "failed" | "cancelled";
export type JobState = { id: string; phase: Phase; written: number; total: number; files: number; filesTotal: number; error: string; result: ExtractResult | null; plan: Plan | null; startedAt: number; finishedAt: number };
type Job = JobState & { key: string; ctrl: AbortController };

const jobs = new Map<string, Job>();
const busy = new Map<string, string>();
/** 使っている一時フォルダ(作ったときの実際の場所と、印のファイル) */
const temps = new Map<string, { real: string; marker: string }>();
/** この起動の ID(別の起動が残した一時フォルダと見分ける) */
const BOOT = randomBytes(8).toString("hex");
/** 一時フォルダの中に置く、こちらが作った印(起動 ID・pid・作った時刻・サーバーのフォルダ) */
export const MARK = ".craftshelf-extract.mark";

/** 使っている一時フォルダを、同期で消す(プロセスが終わるとき・SIGTERM・SIGINT。差し替えられていないものだけ) */
export function cleanupTempsSync() {
  for (const [tmp, { real, marker }] of temps) {
    try {
      if (realpathSync(tmp) === real) rmSync(real, { recursive: true, force: true });
    } catch { /* 次の起動で掃除する */ }
    try { rmSync(marker, { force: true }); } catch { /* 同上 */ }
  }
  temps.clear();
}
process.once("exit", cleanupTempsSync);
// Docker の停止(SIGTERM)・Ctrl+C(SIGINT)でも消す。ほかに受け手がいなければ、そのまま終わらせる
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    cleanupTempsSync();
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  });
}

/** Pterodactyl の確かめは、圧縮ファイルをメモリに読む。同時の数と、読み込み中の合計に上限を置く(戻す関数を返す。二重に呼んでも数は狂わない) */
const reads = { n: 0, bytes: 0 };
export function reserveRead(bytes: number): () => void {
  if (!(isAmount(bytes) && reads.n < EXTRACT_LIMITS.pteroReadSlots && reads.bytes + bytes <= EXTRACT_LIMITS.pteroReadBytes)) {
    throw new ExtractError("いま、ほかの圧縮ファイルの確かめでメモリを使っています。しばらくしてからやり直してください");
  }
  reads.n++;
  reads.bytes += bytes;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    reads.n--;
    reads.bytes -= bytes;
  };
}

/** key(サーバーのフォルダ)ごとに 1 つだけ動かす。2 つ目は断る */
export function startJob(key: string, run: (job: JobState, signal: AbortSignal) => Promise<ExtractResult>): string {
  if (busy.has(key)) throw new ExtractError("このサーバーでは、すでに展開しています。終わるまでお待ちください");
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > EXTRACT_LIMITS.keepJobsMs) jobs.delete(id);
  const id = randomBytes(8).toString("hex");
  const job: Job = { id, key, phase: "checking", written: 0, total: 0, files: 0, filesTotal: 0, error: "", result: null, plan: null, startedAt: now, finishedAt: 0, ctrl: new AbortController() };
  jobs.set(id, job);
  busy.set(key, id);
  run(job, job.ctrl.signal).then((r) => { job.result = r; job.phase = "done"; }, (e) => {
    job.phase = isExtractError(e) && e.cancelled ? "cancelled" : "failed";
    job.error = isExtractError(e) ? e.message : "展開できませんでした(書き込みの権限・空きを確かめてください。何も残していません)";
    if (!isExtractError(e)) console.error("[展開]", e);
  }).finally(() => { job.finishedAt = Date.now(); busy.delete(key); });
  return id;
}
export function jobState(id: string, key: string): JobState {
  const j = jobs.get(String(id));
  if (!j || j.key !== key) throw new ExtractError("その展開は見つかりません");
  const { ctrl: _c, key: _k, ...s } = j;
  return { ...s };
}
export function cancelJob(id: string, key: string) {
  const j = jobs.get(String(id));
  if (!j || j.key !== key) throw new ExtractError("その展開は見つかりません");
  if (!j.finishedAt) j.ctrl.abort();
}

export type Ctx = { root: string; abs: (rel: string) => string; protect: string[]; statfs: Statfs; limits: Limits };
type Prepared = { plan: Plan; scan: Scan | null; full: string; parentAbs: string; parentReal: string; rootReal: string; destAbs: string; destRel: string; parentRel: string };

export const relOf = (archive: string) => {
  const r = String(archive ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!r || r.split("/").some((p) => p === ".." || p === "." || p === "")) throw new ExtractError("圧縮ファイルの場所が正しくありません");
  return r;
};

const within = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
/** サーバーのフォルダからの実際の相対パス(リンクをたどったあと)。フォルダの外なら null */
async function realRel(abs: string, rootReal: string) {
  const r = await realpath(abs).catch(() => null);
  if (!r || !within(r, rootReal)) return null;
  return relative(rootReal, r).split(sep).join("/");
}

/** 読むだけの事前の確かめ(ディスクには書かない)。フォルダのサーバー・エージェントの側 */
async function prepare(ctx: Ctx, archive: string, mode: Mode): Promise<Prepared> {
  const L = ctx.limits;
  const rel = relOf(archive);
  const name = basename(rel);
  const parentRel = parentOf(rel);
  const full = ctx.abs(rel);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new ExtractError("圧縮ファイルが見つかりません");
  const parentAbs = ctx.abs(parentRel);
  const rootReal = await realpath(ctx.root);
  const parentReal = await realpath(parentAbs);
  const format = formatOf(name);
  const pre: string[] = [];
  if (!format) pre.push(unsupportedReason(name) ?? "この形式は展開できません(対応しているのは .zip・.tar・.tar.gz・.tgz です)");
  else if (st.size > L.archiveBytes) pre.push(`圧縮ファイルが大きすぎます(${fmtSize(L.archiveBytes)} まで)`);
  let scan: Scan | null = null;
  if (!pre.length && format) {
    if (format === "zip") {
      const src = fileSource(full);
      try { scan = scanZip(src, L); } finally { src.close(); }
    } else scan = await scanTar(localTar(full, format === "tar.gz"), format, L);
  }
  // リンクをたどった実際の場所も、サーバーのフォルダの中で、守る場所の外であること(root の中のリンク経由で、ワールドへ展開させない)
  const parentRelReal = within(parentReal, rootReal) ? relative(rootReal, parentReal).split(sep).join("/") : null;
  if (parentRelReal === null) pre.push("展開先がサーバーのフォルダの外を指しています");
  else { const hit = protectedHit(parentRelReal, ctx.protect); if (hit) pre.push(`展開先が守っている場所です: ${hit}`); }
  const names = await readdir(parentAbs).catch(() => [] as string[]);
  let destRel = parentRel;
  let conflicts: string[] = [];
  if (mode === "folder") {
    const f = freeFolderName(name, parentRel, names, ctx.protect);
    if (!f) pre.push("展開先のフォルダの名前を決められません");
    destRel = joinRel(parentRel, f ?? "extracted");
  } else if (scan && !scan.fatal.length && !scan.guard.problems.size && !scan.guard.stopped) {
    // 圧縮ファイルの中のフォルダの名前が、すでにあるリンクなら、その行き先(実際の場所)も確かめる
    const dirsIn = new Set<string>();
    for (const e of scan.entries) {
      const parts = e.name.split("/");
      for (let i = 1; i <= parts.length - (e.dir ? 0 : 1); i++) dirsIn.add(parts.slice(0, i).join("/"));
    }
    let n = 0;
    for (const d of dirsIn) {
      if (++n > L.listCalls) break;
      const abs = join(parentAbs, ...d.split("/"));
      if (!(await lstat(abs).catch(() => null))?.isSymbolicLink()) continue;
      const rr = await realRel(abs, rootReal);
      if (rr === null) { pre.push(`サーバーのフォルダの外を指すリンクがあります: 「${show(d)}」`); break; }
      const hit = protectedHit(rr, ctx.protect);
      if (hit) { pre.push(`守っている場所(${hit})の中に展開するものがあります: 「${show(d)}」`); break; }
    }
    conflicts = await findConflicts(parentRel, scan.entries, async (r) => {
      const d = await readdir(ctx.abs(r), { withFileTypes: true }).catch(() => null);
      return d && d.map((x) => ({ name: x.name, isFile: !x.isDirectory() }));
    }, L.listCalls).then((r) => r.bad, (e) => { pre.push((e as Error).message); return [] as string[]; });
  }
  const fs = validFs(await ctx.statfs(parentAbs));
  const space: Space = { kind: "volume", free: fs ? fs.free : null, total: fs ? fs.total : null, block: fs ? Math.max(4096, fs.block) : 4096 };
  const plan = assemblePlan({ archive: rel, format, archiveBytes: st.size, scan, mode, destRel, how: "self", conflicts, conflictCount: conflicts.length, space, protect: ctx.protect, pre, L });
  return { plan, scan, full, parentAbs, parentReal, rootReal, destAbs: join(parentAbs, basename(destRel)), destRel, parentRel };
}
export const planLocal = async (ctx: Ctx, archive: string, mode: Mode) => (await prepare(ctx, archive, mode)).plan;

async function exists(p: string) {
  return !!(await lstat(p).catch(() => null));
}

/** 置く処理(確かめ用に差し替えられる) */
export type PlaceOps = { link(a: string, b: string): Promise<void>; unlink(a: string): Promise<void>; rename(a: string, b: string): Promise<void>; exists(p: string): Promise<boolean> };
const realOps: PlaceOps = { link, unlink, rename, exists };

/**
 * 重ねて書かないで置く。まず hard link(同じ名前があれば EEXIST で失敗する = 確かめと置くあいだに作られても上書きしない)。
 * link が使えない場所(別の方式のファイルシステムなど)では、同じ名前の有無を確かめてから rename。
 * link ができたあとに元の名前を消せなくても、置けていれば成功(元は一時フォルダごと消える)
 */
export async function placeNoOverwrite(from: string, to: string, ops: PlaceOps = realOps) {
  const same = () => new ExtractError("同じ名前のファイルができていたので、展開をやめました");
  try {
    await ops.link(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw same();
    if (await ops.exists(to)) throw same();
    await ops.rename(from, to);
    return;
  }
  await ops.unlink(from).catch(() => {});
}

async function run(ctx: Ctx, archive: string, mode: Mode, job: JobState, signal: AbortSignal): Promise<ExtractResult> {
  const stopped = () => { if (signal.aborted) throw new ExtractError("キャンセルしました。何も残していません", true); };
  const p = await prepare(ctx, archive, mode);
  job.plan = p.plan;
  if (!p.plan.ok || !p.scan) throw new ExtractError(`展開できません。${p.plan.reasons.join(" / ")}`);
  stopped();
  const L = ctx.limits;
  const { plan, scan, rootReal, parentReal } = p;
  job.total = plan.bytes;
  job.filesTotal = plan.files;
  job.phase = "extracting";
  const id = randomBytes(6).toString("hex");
  const tmp = join(p.parentAbs, `${STAGING}${id}`);
  const marker = join(ctx.root, `${STAGING}${id}.job`);
  const dirs = new Set<string>();
  const files: FileRec[] = [];
  let tmpReal = "";
  let sinceCheck = 0;
  let filesSince = 0;
  let current: { abort(): Promise<void> } | null = null;
  const swapped = () => new ExtractError("展開先のフォルダが差し替えられたので、展開を止めました。何も残していません");
  // 書く直前ごとに、一時フォルダがさっき作ったままの場所(サーバーのフォルダの中)にあることを確かめる(リンクへの差し替えで、外に書かれないように)
  const verifyTmp = async () => {
    const r = await realpath(tmp).catch(() => "");
    if (!tmpReal || r !== tmpReal) throw swapped();
  };
  // 一定量ごとに空き容量を測り直す: 残りを書いたあとの空きが予約領域を割りそうなら、すぐ止める
  const check = async () => {
    stopped();
    sinceCheck = 0;
    filesSince = 0;
    const f = validFs(await ctx.statfs(p.parentAbs));
    if (!f) throw new ExtractError("空き容量が分からなくなったので、展開を止めました。何も残していません");
    const remaining = Math.max(0, plan.space.need - job.written);
    if (!(f.free - remaining >= plan.space.reserve)) {
      throw new ExtractError(`空き容量が予約領域(${fmtSize(plan.space.reserve)})を割りそうなので、展開を止めました。何も残していません(残り ${fmtSize(f.free)})`);
    }
    const now = new Date();
    await utimes(marker, now, now).catch(() => {});
    await utimes(join(tmp, MARK), now, now).catch(() => {});
  };
  // フォルダは 1 段ずつ作る(recursive にしない。差し替えられても、外に作り直さない)。作る前に、一時フォルダの場所を確かめる
  const mkdirs = async (rel: string) => {
    if (!rel) return;
    await verifyTmp();
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const sub = parts.slice(0, i + 1).join("/");
      if (dirs.has(sub)) continue;
      const abs = join(tmp, ...parts.slice(0, i + 1));
      try {
        await mkdir(abs, { mode: 0o755 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const st = await lstat(abs);
      if (!st.isDirectory() || st.isSymbolicLink()) throw swapped();
      dirs.add(sub);
    }
  };
  /** 1 つのファイルを書く入れ物。実際に書いた量を、宣言と合計の上限に突き合わせる(CRC があれば確かめる。sha256 を数えて残す) */
  const openFile = async (name: string, size: number, crc?: number) => {
    const out = join(tmp, ...name.split("/"));
    if (!out.startsWith(tmp + sep)) throw new ExtractError("展開先の外に出ようとしています");
    await mkdirs(parentOf(name));
    await verifyTmp();
    const dirReal = await realpath(dirname(out)).catch(() => "");
    if (!tmpReal || !within(dirReal, tmpReal)) throw swapped();
    const fh = await open(out, "wx", 0o644);
    const hash = createHash("sha256");
    let n = 0;
    let sum = 0;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await fh.close(); } };
    const w = {
      async write(c: Buffer) {
        n += c.length;
        if (!(n <= size)) throw new ExtractError(`宣言された大きさより大きいファイルがありました(zip 爆弾の疑い): 「${show(name)}」。何も残していません`);
        job.written += c.length;
        sinceCheck += c.length;
        if (!(job.written <= plan.bytes)) throw new ExtractError("見積もりより多く書こうとしたので止めました。何も残していません");
        if (crc !== undefined) sum = crc32(c, sum);
        hash.update(c);
        await fh.write(c);
        if (sinceCheck >= L.checkEvery) await check();
        else stopped();
      },
      async end() {
        if (n !== size) throw new ExtractError(`宣言された大きさと違うファイルがあります: 「${show(name)}」。何も残していません`);
        if (crc !== undefined && sum >>> 0 !== crc) throw new ExtractError(`中身が壊れています(CRC が合いません): 「${show(name)}」。何も残していません`);
        await fh.chmod(0o644).catch(() => {});
        const mtime = Math.floor((await fh.stat()).mtimeMs);
        await close();
        current = null;
        job.files++;
        files.push([name, size, mtime, hash.digest("hex")]);
        if (++filesSince >= L.checkEveryFiles) await check();
      },
      abort: close,
    };
    current = w;
    return w;
  };
  try {
    await writeFile(marker, JSON.stringify({ id, tmp: relative(ctx.root, tmp).split(sep).join("/"), boot: BOOT, pid: process.pid }), { flag: "wx" });
    await mkdir(tmp, { mode: 0o755 });
    tmpReal = await realpath(tmp);
    temps.set(tmp, { real: tmpReal, marker });
    // 作った一時フォルダが、確かに「確かめた展開先の親」の中・サーバーのフォルダの中にあること
    if (tmpReal !== join(parentReal, basename(tmp)) || !within(tmpReal, rootReal)) throw swapped();
    await writeFile(join(tmp, MARK), JSON.stringify({ v: 1, id, boot: BOOT, pid: process.pid, at: Date.now(), root: rootReal }), { flag: "wx" });
    await check();
    if (scan.format === "zip") {
      for (const e of [...scan.entries].sort((a, b) => a.local - b.local)) {
        stopped();
        if (e.dir) { await mkdirs(e.name); continue; }
        const w = await openFile(e.name, e.size, e.crc);
        if (e.csize > 0) {
          const head = await readHead(p.full, e.local);
          const start = e.local + 30 + head.n + head.x;
          const raw = createReadStream(p.full, { start, end: start + e.csize - 1, highWaterMark: MiB });
          for await (const c of e.method === 8 ? inflated(raw) : closing(raw)) await w.write(c);
        }
        await w.end();
      }
    } else {
      // 展開中も、名前・種類・数・大きさを確かめ直す(圧縮ファイルが途中で書き換えられても)。フォルダかどうかは、確かめと同じ判定(c.dir)
      const g = new Guard(L, true);
      await walkTar(localTar(p.full, scan.format === "tar.gz"), async (h) => {
        stopped();
        const bad = tarProblem(h);
        if (bad) throw new ExtractError(`${bad}: 「${show(h.name)}」。何も残していません`);
        const c = g.add(h.name, h.type === "5", h.type === "5" ? 0 : h.size);
        if (!c) return null;
        if (c.dir) { await mkdirs(c.name); return null; }
        if (g.files > plan.files) throw new ExtractError("見積もりより多くのファイルがあります。何も残していません");
        return openFile(c.name, h.size);
      }, tarLimit(L), L.metaBytes);
      if (files.length !== plan.files) throw new ExtractError("見積もりと違うファイルの数でした。何も残していません");
    }
    stopped();
    job.phase = "placing";
    await verifyTmp();
    for (const d of dirs) await chmod(join(tmp, ...d.split("/")), 0o755).catch(() => {});
    await verifyTmp();
    const destParentReal = await realpath(mode === "folder" ? dirname(p.destAbs) : p.parentAbs).catch(() => "");
    if (destParentReal !== parentReal) throw swapped();
    if (mode === "folder") {
      if (await exists(p.destAbs)) throw new ExtractError("展開先と同じ名前のフォルダが、いまできていました。何も展開していません");
      await rename(tmp, p.destAbs);
      temps.delete(tmp);
      await rm(join(p.destAbs, MARK), { force: true }).catch(() => {}); // 一時フォルダの印は、置いたフォルダに残さない
      return { base: p.destRel, mode, files: files.length, dirs: dirs.size + 1, bytes: job.written, created: { dirs: ["", ...dirs], files } };
    }
    const made = await placeHere(tmp, p.parentAbs, rootReal, ctx.protect, [...dirs], files, verifyTmp);
    return { base: p.parentRel, mode, files: files.length, dirs: made.length, bytes: job.written, created: { dirs: made, files } };
  } finally {
    await (current as { abort(): Promise<void> } | null)?.abort().catch(() => {}); // 開いたままのファイルを閉じてから消す(Windows は開いていると消せない)
    // 差し替えられていないときだけ、一時フォルダを消す(差し替え後の道は、外へ続いているおそれがある)
    if (tmpReal && (await realpath(tmp).catch(() => "")) === tmpReal) await rm(tmpReal, { recursive: true, force: true }).catch(() => {});
    temps.delete(tmp);
    await rm(marker, { force: true }).catch(() => {});
  }
}

async function readHead(path: string, at: number) {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(30);
    await fh.read(b, 0, 30, at);
    if (b.readUInt32LE(0) !== SIG_LOC) throw new ExtractError("zip のデータの場所が壊れています。何も残していません");
    return { n: b.readUInt16LE(26), x: b.readUInt16LE(28) };
  } finally {
    await fh.close();
  }
}

async function* closing(raw: Readable): AsyncGenerator<Buffer> {
  try {
    for await (const c of raw) yield c as Buffer;
  } finally {
    raw.destroy();
  }
}
async function* inflated(raw: Readable): AsyncGenerator<Buffer> {
  const z = createInflateRaw({ chunkSize: 256 * 1024 });
  raw.on("error", (e) => z.destroy(e));
  raw.pipe(z);
  try {
    for await (const c of z) yield c as Buffer;
  } catch (e) {
    if (isExtractError(e)) throw e;
    throw new ExtractError("圧縮されたデータが壊れています。何も残していません");
  } finally {
    raw.destroy();
    z.destroy();
  }
}

/** 「ここに展開」: 一時フォルダから 1 つずつ置く。同じ名前が出たらそこでやめて、置いたものを戻す。置く直前ごとに、置き先の実際の場所を確かめる */
async function placeHere(tmp: string, parentAbs: string, rootReal: string, protect: string[], dirList: string[], files: FileRec[], verifyTmp: () => Promise<void>) {
  const made: string[] = [];
  const state: { files: string[]; dirs: string[] } = { files: [], dirs: [] };
  const need = async (rel: string) => {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      const abs = join(parentAbs, ...sub.split("/"));
      const st = await lstat(abs).catch(() => null);
      if (!st) { await mkdir(abs, { mode: 0o755 }); made.push(sub); state.dirs.push(abs); } else if (st.isSymbolicLink() || !st.isDirectory()) {
        const real = st.isSymbolicLink() ? await realpath(abs).catch(() => "") : "";
        const ok = st.isSymbolicLink() && real && within(real, rootReal) && (await stat(abs)).isDirectory();
        if (!ok) throw new ExtractError(`同じ名前のファイルがあるので、展開をやめました: 「${show(sub)}」`);
      }
    }
    const real = await realpath(join(parentAbs, ...parts));
    if (!within(real, rootReal)) throw new ExtractError("サーバーのフォルダの外を指すリンクがあるので、展開をやめました");
    const hit = protectedHit(relative(rootReal, real).split(sep).join("/"), protect);
    if (hit) throw new ExtractError(`守っている場所(${hit})の中には展開しません。何も展開していません`);
  };
  try {
    for (const d of [...dirList].sort((a, b) => a.split("/").length - b.split("/").length)) { await verifyTmp(); await need(d); }
    for (const [rel] of files) {
      await verifyTmp();
      const parent = parentOf(rel);
      if (parent) await need(parent);
      const to = join(parentAbs, ...rel.split("/"));
      await placeNoOverwrite(join(tmp, ...rel.split("/")), to);
      state.files.push(to);
    }
    return made;
  } catch (e) {
    for (const f of state.files.reverse()) await unlink(f).catch(() => {});
    for (const d of state.dirs.reverse()) await rmdir(d).catch(() => {});
    throw e;
  }
}

/** 展開を始める(バックグラウンド)。key はサーバーのフォルダ。すぐ jobId を返す */
export function startLocal(ctx: Ctx, archive: string, mode: Mode): string {
  return startJob(ctx.root, (job, signal) => run(ctx, archive, mode, job, signal));
}

const pidAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const readJson = async (p: string) => { try { return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>; } catch { return null; } };

/**
 * 前に止まった展開の一時フォルダを掃除する(起動のとき・展開を始める前・1 時間ごと)。
 * 消すのは、こちらが作った印(サーバーのフォルダの一番上の .job が指す先に、同じ id・同じサーバーの印 `MARK` があるもの)だけ。
 * 印の無い .craftshelf-extract-… は利用者のものとして消さない。持ち主(別の起動・生きていない pid)がいなくなったものはすぐ、
 * そうでなければ staleMs(10 分)より古いものを消す。動いている展開(この起動のもの)は触らない
 */
export async function cleanStale(root: string, now = Date.now(), staleMs = EXTRACT_LIMITS.staleMs) {
  let removed = 0;
  const rootReal = await realpath(root).catch(() => "");
  if (!rootReal) return 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(STAGING) || !name.endsWith(".job")) continue;
    const pointer = join(root, name);
    const ptr = await readJson(pointer);
    const id = String(ptr?.id ?? "");
    const tmpRel = String(ptr?.tmp ?? "");
    if (!ptr || !id || !tmpRel || tmpRel.startsWith("/") || tmpRel.split("/").some((x) => x === ".." || x === "")) continue;
    const full = join(root, ...tmpRel.split("/"));
    if (!basename(full).startsWith(STAGING) || temps.has(full)) continue;
    const pst = await stat(pointer).catch(() => null);
    const st = await lstat(full).catch(() => null);
    if (!st) { // 指す先がもう無い: 古い印だけを片付ける
      if (pst && now - pst.mtimeMs > staleMs) { await rm(pointer, { force: true }); removed++; }
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const parent = await realpath(dirname(full)).catch(() => "");
    if (!within(parent, rootReal)) continue; // サーバーのフォルダの外へのリンクを通る道は消さない
    const mark = await readJson(join(full, MARK));
    if (!mark || mark.v !== 1 || mark.id !== id || mark.root !== rootReal) continue; // こちらが作った印が無い = 利用者のもの
    const mst = await stat(join(full, MARK)).catch(() => null);
    const last = Math.max(pst?.mtimeMs ?? 0, mst?.mtimeMs ?? 0);
    const ownerGone = mark.boot !== BOOT && !pidAlive(Number(mark.pid));
    if (!ownerGone && !(now - last > staleMs)) continue;
    await rm(full, { recursive: true, force: true });
    await rm(pointer, { force: true });
    removed++;
  }
  return removed;
}

// ---- 取り消し(展開で作ったものだけを消す) ----

export type Manifest = { v: 2; base: string; files: FileRec[]; dirs: string[] };
export type FilesApi = {
  listFiles(ident: string, dir: string): Promise<{ name: string; size: number; isFile: boolean; modifiedAt: string; link?: boolean }[]>;
  deleteFiles(ident: string, dir: string, files: string[]): Promise<void>;
  /** 中身の sha256(大きさが違う・ファイルでない・リンク・大きすぎて読めないものは null) */
  hashFiles(ident: string, dir: string, files: { name: string; size: number }[]): Promise<Record<string, string | null>>;
};

/**
 * 展開で作ったものだけを消す。ファイルは、種類(ファイル・リンクでない)・大きさ・内容の sha256 が展開したときと同じときだけ消す
 * (同じ大きさで中身だけ変えられたもの・リンクや別のものに入れ替えられたものは残す。ハッシュの無いもの・読めないものも残して「確かめられなかった」に数える)。
 * フォルダは、種類(フォルダ)を親の一覧で確かめ、空のときだけ消す(利用者が足したものがあれば残す)
 */
export async function removeCreated(api: FilesApi, ident: string, m: Manifest) {
  let removed = 0;
  let kept = 0;
  let unverified = 0;
  const byDir = new Map<string, FileRec[]>();
  for (const f of m.files) {
    const d = parentOf(f[0]);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const at = (rel: string) => (rel ? `${m.base ? `${m.base}/` : ""}${rel}` : m.base);
  for (const [dir, list] of byDir) {
    const have = await api.listFiles(ident, at(dir) || "/").catch(() => []);
    const cand: FileRec[] = [];
    for (const f of list) {
      const name = f[0].slice(dir ? dir.length + 1 : 0);
      const e = have.find((x) => x.name === name);
      if (!e) continue; // もう無い
      if (e.link || !e.isFile || e.size !== f[1]) { kept++; continue; } // リンク・別のもの・大きさが変わった = 利用者が変えたもの
      if (!f[3]) { unverified++; continue; }
      cand.push(f);
    }
    const del: string[] = [];
    for (let i = 0; i < cand.length; i += 200) {
      const part = cand.slice(i, i + 200);
      const got = await api.hashFiles(ident, at(dir) || "/", part.map((f) => ({ name: f[0].slice(dir ? dir.length + 1 : 0), size: f[1] }))).catch(() => ({}) as Record<string, string | null>);
      for (const f of part) {
        const name = f[0].slice(dir ? dir.length + 1 : 0);
        const h = got[name];
        if (typeof h !== "string") unverified++;
        else if (h === f[3]) del.push(name);
        else kept++;
      }
    }
    if (del.length) { await api.deleteFiles(ident, at(dir) || "/", del); removed += del.length; }
  }
  let dirsRemoved = 0;
  let dirsKept = 0;
  const listed = new Map<string, Awaited<ReturnType<FilesApi["listFiles"]>>>();
  const list = async (path: string) => {
    if (!listed.has(path)) listed.set(path, await api.listFiles(ident, path || "/").catch(() => []));
    return listed.get(path)!;
  };
  for (const d of [...new Set(m.dirs)].sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length)) {
    const path = at(d);
    if (!path) continue;
    const parent = parentOf(path);
    const name = path.slice(parent ? parent.length + 1 : 0);
    listed.delete(parent); // 子を消したあとの一覧で見る
    const e = (await list(parent)).find((x) => x.name === name);
    if (!e) continue; // もう無い
    if (e.isFile || e.link) { dirsKept++; continue; } // フォルダでなくなっている(ファイル・リンクに入れ替えられた)
    if ((await api.listFiles(ident, path).catch(() => [{ name: "?", size: 0, isFile: true, modifiedAt: "" }])).length) { dirsKept++; continue; }
    await api.deleteFiles(ident, parent || "/", [name]).then(() => dirsRemoved++, () => { dirsKept++; });
  }
  return { removed, kept, unverified, dirsRemoved, dirsKept };
}

/** 展開の結果から、取り消しのための記録を作る */
export function manifestOf(result: ExtractResult): Manifest {
  return { v: 2, base: result.base, files: result.created.files, dirs: result.created.dirs };
}
/** Pterodactyl は、圧縮ファイルの一覧から記録を作る(hashes = 圧縮ファイルの中身から数えた sha256。無いものは空) */
export const entriesManifest = (base: string, mode: Mode, entries: Entry[], existing: Set<string> = new Set(), hashes: Map<string, string> = new Map()): Manifest => {
  const dirs = new Set<string>(mode === "folder" ? [""] : []);
  for (const e of entries) {
    const parts = e.name.split("/");
    for (let i = 1; i <= parts.length - (e.dir ? 0 : 1); i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const d of existing) dirs.delete(d);
  return { v: 2, base, files: entries.filter((e) => !e.dir).map((e) => [e.name, e.size, 0, hashes.get(e.name) ?? ""] as FileRec), dirs: [...dirs] };
};

/** 圧縮ファイル(メモリ上)の中身から、ファイルごとの sha256 を数える(Pterodactyl の取り消しで、展開されたものと比べる)。hashBytes を超えるものは数えない */
export async function hashEntries(buf: Uint8Array, format: ArchiveFormat, entries: Entry[], L: Limits): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = new Map(entries.filter((e) => !e.dir && e.size <= L.hashBytes).map((e) => [e.name, e]));
  if (format === "zip") {
    const src = memorySource(buf);
    for (const e of want.values()) {
      try {
        const head = src.read(e.local, 30);
        const start = e.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
        const data = src.read(start, e.csize);
        const raw = e.method === 8 ? inflateRawSync(data, { maxOutputLength: e.size + 1 }) : data;
        if (raw.length === e.size) out.set(e.name, createHash("sha256").update(raw).digest("hex"));
      } catch { /* 数えられないものは、取り消しで「確かめられなかった」になる */ }
    }
    return out;
  }
  await walkTar(memoryTar(buf, format === "tar.gz"), (h) => {
    const c = h.type === "0" || h.type === "7" ? cleanEntryName(h.name) : null;
    const e = c && !c.problem && !c.skip ? want.get(c.name) : undefined;
    if (!e || e.size !== h.size) return null;
    const hash = createHash("sha256");
    return { write: (b) => { hash.update(b); }, end: () => { out.set(e.name, hash.digest("hex")); } };
  }, tarLimit(L), L.metaBytes).catch(() => {});
  return out;
}
