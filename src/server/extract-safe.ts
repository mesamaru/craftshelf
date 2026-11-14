// 圧縮ファイルを安全に展開する(サーバーの「ファイル」タブ)。フォルダのサーバー(local.ts)とエージェント(src/agent/main.ts)が同じ処理を使う。
// 方針は 安全 > 便利。次を重ねる(docs/DESIGN.md「圧縮ファイルの展開」):
//   1. 読むだけの事前の確かめ(ディスクに 1 バイトも書かない): 形式・名前・リンク・数と大きさ・圧縮率・衝突・容量(予約領域つき)
//   2. 展開中の見張り: 同じボリュームの一時フォルダにだけ書き、書いた量を数え、一定量ごとに空き容量を測り直す。最後に rename で置く
//   3. 失敗・キャンセル・終了のときは、一時フォルダを丸ごと消す(起動のときも古いものを掃除する)
import { randomBytes } from "node:crypto";
import { rmSync, createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, statfs, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { Readable, type Writable } from "node:stream";
import { createGunzip, createInflateRaw, crc32 } from "node:zlib";
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
  staleMs: 60 * 60_000, // 古い一時フォルダを掃除する(起動のとき)
  keepJobsMs: 10 * 60_000,
  listCalls: 5000, // 「ここに展開」の衝突の確かめでフォルダを読む回数
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

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const show = (s: string) => {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

/**
 * 圧縮ファイルの中の 1 つの名前を確かめる。先頭の「./」だけは外す(tar の . から始まる名前)。
 * 問題があれば理由を返す(1 つでもあれば、全体を断る)
 */
export function cleanEntryName(raw: string): { name: string; dir: boolean; skip?: true; problem?: string } {
  const bad = (problem: string) => ({ name: "", dir: false, problem });
  if (raw === "") return bad("名前が空です");
  if (CONTROL.test(raw)) return bad("制御文字(NUL など)を含む名前");
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
    if (p.startsWith(STAGING) || p.startsWith(".craftshelf-")) return bad("「.craftshelf-」で始まる名前(CraftShelf が使う名前)");
    bytes += Buffer.byteLength(p) + 1;
  }
  if (bytes - 1 > EXTRACT_LIMITS.pathBytes) return bad(`パスが長すぎます(${EXTRACT_LIMITS.pathBytes} バイトまで)`);
  return { name: parts.join("/"), dir };
}

// 衝突を見る鍵: Unicode の正規化(NFC)をそろえ、大文字小文字を同じにする(Windows・macOS で同じ名前になるもの)
const keyOf = (name: string) => name.normalize("NFC").toLowerCase();

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
      this.bytes += size;
      this.maxFile = Math.max(this.maxFile, size);
      if (size > this.L.fileBytes) this.report(`1 つのファイルが大きすぎます(${fmtSize(this.L.fileBytes)} まで)`, name);
      if (this.bytes > this.L.totalBytes && !this.totalTold) {
        this.totalTold = true;
        this.report(`展開後の合計が大きすぎます(${fmtSize(this.L.totalBytes)} まで)`);
        this.stopped = true;
      }
    }
    if (this.files + this.dirs > this.L.files && !this.stopped) {
      this.report(`ファイルが多すぎます(${this.L.files.toLocaleString("en-US")} 個まで)`);
      this.stopped = true;
    }
    return { name, dir };
  }
}

/** 展開先に入れない場所(ワールド・ログ。.craftshelf-* は名前の確かめで別に断る) */
export const protectedOf = (level: string) => {
  const l = level && !level.startsWith("/") && !level.split(/[\\/]/).includes("..") ? level.replace(/\\/g, "/").replace(/\/+$/, "") : "world";
  return [l, `${l}_nether`, `${l}_the_end`, "logs"];
};
/** サーバーのフォルダからの相対パス rel が、守る場所の中か(大文字小文字・正規化は見ない) */
export function protectedHit(rel: string, protect: string[]) {
  const k = keyOf(rel);
  if (k.split("/").some((p) => p.startsWith(".craftshelf-"))) return "CraftShelf が使うフォルダ(.craftshelf-…)";
  const hit = protect.find((p) => k === keyOf(p) || k.startsWith(`${keyOf(p)}/`));
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
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { e = i; break; }
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
    if (host === 3 && (fmt === 0o120000 || fmt === 0o020000 || fmt === 0o060000 || fmt === 0o010000 || fmt === 0o140000)) { g.report(LINKS, name); continue; }
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

type TarHead = { name: string; size: number; type: string };
type Sink = { write(b: Buffer): Promise<void> | void; end(): Promise<void> | void };
const STOP = Symbol("stop");
const TAR_LINKS = new Set(["1", "2", "3", "4", "6"]); // ハードリンク・シンボリックリンク・キャラクタデバイス・ブロックデバイス・FIFO
const nul = (b: Buffer) => b.toString("utf8").replace(/\0[\s\S]*$/, "");

function paxOf(data: Buffer) {
  const out: { path?: string; size?: number } = {};
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const len = Number(data.subarray(p, sp).toString());
    if (sp < 0 || !Number.isInteger(len) || len <= sp - p + 1 || p + len > data.length) throw new ExtractError("tar の拡張ヘッダーが壊れています");
    const rec = data.subarray(sp + 1, p + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    const key = rec.slice(0, eq);
    if (key === "path") out.path = rec.slice(eq + 1);
    else if (key === "size") out.size = Number(rec.slice(eq + 1));
    p += len;
  }
  return out;
}

/**
 * tar を先頭から読み、エントリーごとに onEntry を呼ぶ(ファイルなら中身を返された sink に渡す)。全体をメモリに持たない。
 * 違反・壊れ・切れは ExtractError。onEntry が STOP を投げたら、そこでやめる
 */
async function walkTar(input: AsyncIterable<Buffer>, onEntry: (h: TarHead) => Promise<Sink | null> | Sink | null) {
  let pending: Buffer = Buffer.alloc(0);
  let phase: "head" | "data" | "pad" = "head";
  let remain = 0;
  let padLeft = 0;
  let sink: Sink | null = null;
  let meta: { kind: string; chunks: Buffer[] } | null = null;
  let pax: { path?: string; size?: number } = {};
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
        if (h[124] & 0x80) throw new ExtractError("1 つのファイルが大きすぎます(tar の大きさの書き方)");
        const size = parseInt(nul(h.subarray(124, 136)).trim() || "0", 8);
        if (!Number.isFinite(size) || size < 0) throw new ExtractError("tar のヘッダーが壊れています(大きさ)");
        if (type === "x" || type === "g" || type === "L" || type === "K") {
          if (size > MiB) throw new ExtractError("tar の拡張ヘッダーが大きすぎます");
          meta = { kind: type, chunks: [] };
          remain = size;
          padLeft = toPad(size);
          phase = remain ? "data" : "pad";
          if (!remain) { finishMeta(); if (!padLeft) phase = "head"; }
          continue;
        }
        const magic = h.subarray(257, 262).toString();
        const prefix = magic === "ustar" ? nul(h.subarray(345, 500)) : "";
        const base = nul(h.subarray(0, 100));
        const name = pax.path ?? (longName || (prefix ? `${prefix}/${base}` : base));
        const real = pax.size ?? size;
        pax = {};
        longName = "";
        sink = await onEntry({ name, size: real, type });
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
    if (m.kind === "x") pax = { ...pax, ...paxOf(data) };
    else if (m.kind === "L") longName = nul(data);
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

/** tar を先頭から読んで、一覧・数・大きさを数える(ファイルには書かない) */
export async function scanTar(src: AsyncIterable<Buffer>, format: ArchiveFormat, L: Limits): Promise<Scan> {
  const g = new Guard(L);
  const out: Scan = { format, entries: [], guard: g, fatal: [] };
  try {
    await walkTar(src, (h) => {
      if (g.stopped) throw STOP;
      if (TAR_LINKS.has(h.type)) { g.report(LINKS, h.name); return null; }
      if (h.type !== "0" && h.type !== "5" && h.type !== "7") { g.report(`対応していない種類のエントリー(型 ${h.type})`, h.name); return null; }
      const dir = h.type === "5";
      const c = g.add(h.name, dir, dir ? 0 : h.size);
      if (c) out.entries.push({ name: c.name, dir: c.dir, size: c.dir ? 0 : h.size, csize: 0, method: 0, crc: 0, local: 0 });
      // 大きすぎるファイル・上限を超えた合計は、もう数えなくてよい(中身を読み飛ばして時間を使わない)
      if (g.stopped || (!dir && h.size > L.fileBytes)) throw STOP;
      return null;
    });
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
    const s = await statfs(p);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize), block: Number(s.bsize) || 4096 };
  } catch {
    return null;
  }
};
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
/** ディスクに置いたときの大きさの、確実な上限(1 つ 1 つをブロックの大きさに切り上げる) */
export const diskNeed = (entries: Entry[], block: number) => entries.reduce((s, e) => s + (e.dir ? block : blocks(e.size, block)), 0);

function capacity(space: Space, need: number, bytes: number, L: Limits) {
  const extra = reserveEnv();
  if (space.kind === "unlimited") {
    const reasons = bytes > L.pteroUnlimitedBytes ? [`サーバーのディスクの上限が決まっていないので、展開できるのは合計 ${fmtSize(L.pteroUnlimitedBytes)} までです(この圧縮ファイルは ${fmtSize(bytes)})`] : [];
    return { reasons, info: { free: null, total: null, reserve: 0, need, usable: L.pteroUnlimitedBytes, after: null, unlimited: true, unknown: false } };
  }
  const total = space.kind === "volume" ? space.total : space.limit;
  const free = space.free;
  const reserve = Math.max(space.kind === "volume" ? Math.max(L.reserveMin, (total ?? 0) * L.reservePercent) : space.limit * L.pteroReservePercent, extra);
  if (free === null) {
    return { reasons: ["空き容量が分からないので展開しません"], info: { free: null, total, reserve, need, usable: null, after: null, unlimited: false, unknown: true } };
  }
  const usable = Math.max(0, (free - reserve) * L.usable);
  const reasons: string[] = [];
  if (need > usable) {
    reasons.push(`空き容量が足りません(展開に最大 ${fmtSize(need)} が要ります。空き ${fmtSize(free)} から予約領域 ${fmtSize(reserve)} を残すと、使えるのは ${fmtSize(usable)} までです)`);
  }
  return { reasons, info: { free, total, reserve, need, usable, after: free - need, unlimited: false, unknown: false } };
}

/** 事前の確かめの結果をまとめる(展開先・衝突・容量・守る場所を含む) */
export function assemblePlan(a: {
  archive: string; format: ArchiveFormat | null; archiveBytes: number; scan: Scan | null; mode: Mode; destRel: string; how: "self" | "panel";
  conflicts: string[]; conflictCount: number; space: Space; protect: string[]; pre: string[]; L: Limits;
}): Plan {
  const { scan, L } = a;
  const g = scan?.guard;
  const reasons = [...a.pre, ...(scan?.fatal ?? []), ...(g?.problems.list() ?? [])];
  const bytes = g?.bytes ?? 0;
  if (scan && !scan.fatal.length && !g!.stopped) {
    if (g!.files + g!.dirs === 0) reasons.push("圧縮ファイルの中身が空です");
    if (bytes > L.ratioFloor && a.archiveBytes > 0 && bytes / a.archiveBytes > L.ratio) {
      reasons.push(`圧縮率が高すぎます(${L.ratio} 倍まで。この圧縮ファイルは約 ${Math.round(bytes / a.archiveBytes)} 倍。zip 爆弾の疑い)`);
    }
    const dest = protectedHit(a.destRel, a.protect);
    if (dest) reasons.push(`展開先が守っている場所です: ${dest}`);
    else {
      const hits = scan.entries.map((e) => ({ e, why: protectedHit(a.destRel ? `${a.destRel}/${e.name}` : e.name, a.protect) })).filter((x) => x.why);
      if (hits.length) reasons.push(`守っている場所(${hits[0].why})の中に展開するものがあります: 「${show(hits[0].e.name)}」${hits.length > 1 ? ` ほか ${hits.length - 1} 個` : ""}`);
    }
    if (a.conflictCount) reasons.push(`同じ名前のファイル・フォルダが、展開先にすでにあります(${a.conflictCount} 個。上書きはしません)`);
  }
  const block = a.space.block || 4096;
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

export type Created = { dirs: string[]; files: [string, number, number][] };
export type ExtractResult = { base: string; mode: Mode; files: number; dirs: number; bytes: number; created: Created };
export type Phase = "checking" | "extracting" | "placing" | "done" | "failed" | "cancelled";
export type JobState = { id: string; phase: Phase; written: number; total: number; files: number; filesTotal: number; error: string; result: ExtractResult | null; plan: Plan | null; startedAt: number; finishedAt: number };
type Job = JobState & { key: string; ctrl: AbortController };

const jobs = new Map<string, Job>();
const busy = new Map<string, string>();
const temps = new Set<string>();
// プロセスが終わるとき、使っていた一時フォルダを消す(強制終了でも残ったものは、次の起動で掃除する)
process.once("exit", () => { for (const t of temps) try { rmSync(t, { recursive: true, force: true }); } catch { /* 次の起動で掃除する */ } });

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
type Prepared = { plan: Plan; scan: Scan | null; full: string; parentAbs: string; destAbs: string; destRel: string; parentRel: string };

export const relOf = (archive: string) => {
  const r = String(archive ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!r || r.split("/").some((p) => p === ".." || p === "." || p === "")) throw new ExtractError("圧縮ファイルの場所が正しくありません");
  return r;
};

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
  const names = await readdir(parentAbs).catch(() => [] as string[]);
  let destRel = parentRel;
  let conflicts: string[] = [];
  if (mode === "folder") {
    const f = freeFolderName(name, parentRel, names, ctx.protect);
    if (!f) pre.push("展開先のフォルダの名前を決められません");
    destRel = joinRel(parentRel, f ?? "extracted");
  } else if (scan && !scan.fatal.length && !scan.guard.problems.size && !scan.guard.stopped) {
    conflicts = await findConflicts(parentRel, scan.entries, async (r) => {
      const d = await readdir(ctx.abs(r), { withFileTypes: true }).catch(() => null);
      return d && d.map((x) => ({ name: x.name, isFile: !x.isDirectory() }));
    }, L.listCalls).then((r) => r.bad, (e) => { pre.push((e as Error).message); return [] as string[]; });
  }
  const fs = await ctx.statfs(parentAbs);
  const space: Space = { kind: "volume", free: fs?.free ?? null, total: fs?.total ?? null, block: Math.max(4096, fs?.block ?? 4096) };
  const plan = assemblePlan({ archive: rel, format, archiveBytes: st.size, scan, mode, destRel, how: "self", conflicts, conflictCount: conflicts.length, space, protect: ctx.protect, pre, L });
  return { plan, scan, full, parentAbs, destAbs: join(parentAbs, basename(destRel)), destRel, parentRel };
}
export const planLocal = async (ctx: Ctx, archive: string, mode: Mode) => (await prepare(ctx, archive, mode)).plan;

async function exists(p: string) {
  return !!(await lstat(p).catch(() => null));
}

/** 重ねて書かないで置く(同じ名前があれば失敗。hard link が使えない場所では、確かめてから rename) */
async function placeNoOverwrite(from: string, to: string) {
  try {
    await link(from, to);
    await unlink(from);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ExtractError("同じ名前のファイルができていたので、展開をやめました");
  }
  if (await exists(to)) throw new ExtractError("同じ名前のファイルができていたので、展開をやめました");
  await rename(from, to);
}

async function run(ctx: Ctx, archive: string, mode: Mode, job: JobState, signal: AbortSignal): Promise<ExtractResult> {
  const stopped = () => { if (signal.aborted) throw new ExtractError("キャンセルしました。何も残していません", true); };
  const p = await prepare(ctx, archive, mode);
  job.plan = p.plan;
  if (!p.plan.ok || !p.scan) throw new ExtractError(`展開できません。${p.plan.reasons.join(" / ")}`);
  stopped();
  const L = ctx.limits;
  const { plan, scan } = p;
  job.total = plan.bytes;
  job.filesTotal = plan.files;
  job.phase = "extracting";
  const id = randomBytes(6).toString("hex");
  const tmp = join(p.parentAbs, `${STAGING}${id}`);
  const marker = join(ctx.root, `${STAGING}${id}.job`);
  const rootReal = await realpath(ctx.root);
  temps.add(tmp);
  const dirs = new Set<string>();
  const files: [string, number, number][] = [];
  let sinceCheck = 0;
  let filesSince = 0;
  let current: { abort(): Promise<void> } | null = null;
  // 一定量ごとに空き容量を測り直す: 残りを書いたあとの空きが予約領域を割りそうなら、すぐ止める
  const check = async () => {
    stopped();
    sinceCheck = 0;
    filesSince = 0;
    const f = await ctx.statfs(p.parentAbs);
    if (!f) throw new ExtractError("空き容量が分からなくなったので、展開を止めました。何も残していません");
    const remaining = Math.max(0, plan.space.need - job.written);
    if (f.free - remaining < plan.space.reserve) {
      throw new ExtractError(`空き容量が予約領域(${fmtSize(plan.space.reserve)})を割りそうなので、展開を止めました。何も残していません(残り ${fmtSize(f.free)})`);
    }
    await utimes(marker, new Date(), new Date()).catch(() => {});
  };
  const mkdirs = async (rel: string) => {
    if (!rel) return;
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    await mkdir(join(tmp, ...parts), { recursive: true, mode: 0o755 });
  };
  /** 1 つのファイルを書く入れ物。実際に書いた量を、宣言と合計の上限に突き合わせる(CRC があれば確かめる) */
  const openFile = async (name: string, size: number, crc?: number) => {
    const out = join(tmp, ...name.split("/"));
    if (!out.startsWith(tmp + sep)) throw new ExtractError("展開先の外に出ようとしています");
    await mkdirs(parentOf(name));
    const fh = await open(out, "wx", 0o644);
    let n = 0;
    let sum = 0;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await fh.close(); } };
    const w = {
      async write(c: Buffer) {
        n += c.length;
        if (n > size) throw new ExtractError(`宣言された大きさより大きいファイルがありました(zip 爆弾の疑い): 「${show(name)}」。何も残していません`);
        job.written += c.length;
        sinceCheck += c.length;
        if (job.written > plan.bytes) throw new ExtractError("見積もりより多く書こうとしたので止めました。何も残していません");
        if (crc !== undefined) sum = crc32(c, sum);
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
        files.push([name, size, mtime]);
        if (++filesSince >= L.checkEveryFiles) await check();
      },
      abort: close,
    };
    current = w;
    return w;
  };
  try {
    await writeFile(marker, JSON.stringify({ tmp: relative(ctx.root, tmp).split(sep).join("/"), at: Date.now() }), { flag: "wx" });
    await mkdir(tmp, { mode: 0o755 });
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
      // 展開中も、名前・種類・数・大きさを確かめ直す(圧縮ファイルが途中で書き換えられても)
      const g = new Guard(L, true);
      await walkTar(localTar(p.full, scan.format === "tar.gz"), async (h) => {
        stopped();
        if (h.type !== "0" && h.type !== "5" && h.type !== "7") throw new ExtractError(`${TAR_LINKS.has(h.type) ? LINKS : "対応していない種類のエントリー"}: 「${show(h.name)}」。何も残していません`);
        const dir = h.type === "5";
        const c = g.add(h.name, dir, dir ? 0 : h.size);
        if (!c) return null;
        if (dir) { await mkdirs(c.name); return null; }
        if (g.files > plan.files) throw new ExtractError("見積もりより多くのファイルがあります。何も残していません");
        return openFile(c.name, h.size);
      });
      if (files.length !== plan.files) throw new ExtractError("見積もりと違うファイルの数でした。何も残していません");
    }
    stopped();
    job.phase = "placing";
    for (const d of dirs) await chmod(join(tmp, ...d.split("/")), 0o755).catch(() => {});
    if (mode === "folder") {
      if (await exists(p.destAbs)) throw new ExtractError("展開先と同じ名前のフォルダが、いまできていました。何も展開していません");
      await rename(tmp, p.destAbs);
      return { base: p.destRel, mode, files: files.length, dirs: dirs.size + 1, bytes: job.written, created: { dirs: ["", ...dirs], files } };
    }
    const made = await placeHere(tmp, p.parentAbs, rootReal, [...dirs], files);
    return { base: p.parentRel, mode, files: files.length, dirs: made.length, bytes: job.written, created: { dirs: made, files } };
  } finally {
    await (current as { abort(): Promise<void> } | null)?.abort().catch(() => {}); // 開いたままのファイルを閉じてから消す(Windows は開いていると消せない)
    temps.delete(tmp);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
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

/** 「ここに展開」: 一時フォルダから 1 つずつ置く。同じ名前が出たらそこでやめて、置いたものを戻す */
async function placeHere(tmp: string, parentAbs: string, rootReal: string, dirList: string[], files: [string, number, number][]) {
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
        const ok = st.isSymbolicLink() && real && (real === rootReal || real.startsWith(rootReal + sep)) && (await stat(abs)).isDirectory();
        if (!ok) throw new ExtractError(`同じ名前のファイルがあるので、展開をやめました: 「${show(sub)}」`);
      }
    }
    const real = await realpath(join(parentAbs, ...parts));
    if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new ExtractError("サーバーのフォルダの外を指すリンクがあるので、展開をやめました");
  };
  try {
    for (const d of [...dirList].sort((a, b) => a.split("/").length - b.split("/").length)) await need(d);
    for (const [rel] of files) {
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

/** 古い一時フォルダ・印を掃除する(起動のとき・展開を始める前。staleMs より古いもの。動いている展開のものは触らない) */
export async function cleanStale(root: string, now = Date.now(), staleMs = EXTRACT_LIMITS.staleMs) {
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(STAGING)) continue;
    const abs = join(root, name);
    const st = await stat(abs).catch(() => null);
    if (!st || now - st.mtimeMs <= staleMs || temps.has(abs)) continue;
    if (name.endsWith(".job")) {
      try {
        const tmp = String(JSON.parse(await readFile(abs, "utf8")).tmp ?? "");
        const full = join(root, ...tmp.split("/"));
        // 印が指す先が、サーバーのフォルダの外へのリンクを通らないことも確かめる(印はフォルダに書ける人が作れるため)
        const parent = await realpath(dirname(full)).catch(() => "");
        const rootReal = await realpath(root);
        const inside = parent === rootReal || parent.startsWith(rootReal + sep);
        if (tmp && inside && !tmp.split("/").includes("..") && basename(full).startsWith(STAGING) && !temps.has(full)) await rm(full, { recursive: true, force: true });
      } catch { /* 読めない印は、消すだけ */ }
      await rm(abs, { force: true });
    } else await rm(abs, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// ---- 取り消し(展開で作ったものだけを消す) ----

export type Manifest = { v: 1; base: string; files: [string, number, number][]; dirs: string[] };
export type FilesApi = {
  listFiles(ident: string, dir: string): Promise<{ name: string; size: number; isFile: boolean; modifiedAt: string }[]>;
  deleteFiles(ident: string, dir: string, files: string[]): Promise<void>;
};

/** 展開のあとに、大きさ(分かれば更新の時刻も)が変わったファイルは、利用者が変えたものとして残す。空になった私たちのフォルダだけを消す */
export async function removeCreated(api: FilesApi, ident: string, m: Manifest) {
  let removed = 0;
  let kept = 0;
  const byDir = new Map<string, [string, number, number][]>();
  for (const f of m.files) {
    const d = parentOf(f[0]);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const at = (rel: string) => (rel ? `${m.base ? `${m.base}/` : ""}${rel}` : m.base);
  for (const [dir, list] of byDir) {
    const have = await api.listFiles(ident, at(dir) || "/").catch(() => []);
    const del: string[] = [];
    for (const [rel, size, mtime] of list) {
      const name = rel.slice(dir ? dir.length + 1 : 0);
      const f = have.find((x) => x.isFile && x.name === name);
      if (!f) continue;
      if (f.size === size && (!mtime || !f.modifiedAt || Math.abs(Date.parse(f.modifiedAt) - mtime) < 2000)) del.push(name);
      else kept++;
    }
    if (del.length) { await api.deleteFiles(ident, at(dir) || "/", del); removed += del.length; }
  }
  let dirsRemoved = 0;
  for (const d of [...new Set(m.dirs)].sort((a, b) => b.split("/").length - a.split("/").length || b.length - a.length)) {
    const path = at(d);
    if (!path) continue;
    if ((await api.listFiles(ident, path).catch(() => [{ name: "?", size: 0, isFile: true, modifiedAt: "" }])).length) continue;
    await api.deleteFiles(ident, parentOf(path) || "/", [path.slice(parentOf(path) ? parentOf(path).length + 1 : 0)]).then(() => dirsRemoved++, () => {});
  }
  return { removed, kept, dirsRemoved };
}

/** 展開の結果から、取り消しのための記録を作る(Pterodactyl は、圧縮ファイルの一覧から) */
export function manifestOf(result: ExtractResult): Manifest {
  return { v: 1, base: result.base, files: result.created.files, dirs: result.created.dirs };
}
export const entriesManifest = (base: string, mode: Mode, entries: Entry[], existing: Set<string> = new Set()): Manifest => {
  const dirs = new Set<string>(mode === "folder" ? [""] : []);
  for (const e of entries) {
    const parts = e.name.split("/");
    for (let i = 1; i <= parts.length - (e.dir ? 0 : 1); i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const d of existing) dirs.delete(d);
  return { v: 1, base, files: entries.filter((e) => !e.dir).map((e) => [e.name, e.size, 0] as [string, number, number]), dirs: [...dirs] };
};
