// 展開を「壊す側」から調べて見つかった穴(03.78.01)。攻撃のファイルで再現して、断られる・止まる・何も壊れないことを確かめる
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, copyFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createGzip, gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { EXTRACT_LIMITS, Guard, MARK, type Limits, type Statfs, cleanEntryName, cleanStale, cleanupTempsSync, levelOf, manifestOf, mergeLimits, parseProps, placeNoOverwrite, protectedHit, protectedOf, removeCreated, reserveRead } from "~/server/extract-safe";
import { type ExtractOpts, localClient } from "~/server/local";
import { entry, hdr, makeTar, paxEntry, tarOf } from "./tar";
import { makeZip, makeZipEx } from "./zip";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
let outer = "";
let root = "";
const fetchNone = (async () => { throw new Error("使わない"); }) as never;
const control = { control: "none", startCmd: "", stopCmd: "", container: "", rconPort: null, rconPassword: "" };
const plenty: Statfs = async () => ({ free: 500 * GiB, total: 1000 * GiB, block: 4096 });
const client = (opts: ExtractOpts = {}) => localClient(root, fetchNone, control, { statfs: plenty, ...opts });

beforeEach(() => {
  outer = realpathSync(mkdtempSync(join(tmpdir(), "cs-h-")));
  root = join(outer, "srv");
  mkdirSync(root);
  writeFileSync(join(root, "server.properties"), "level-name=world\n");
});

function tree(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(base, p).split("\\").join("/");
    out.push(e.isDirectory() ? `${rel}/` : rel);
    if (e.isDirectory()) out.push(...tree(p, base));
  }
  return out.sort();
}
const put = (rel: string, data: string | Uint8Array) => { const p = join(root, ...rel.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); };
async function extract(c: ReturnType<typeof client>, archive: string, mode: "folder" | "here" = "folder") {
  const { jobId } = await c.extractStart("", archive, mode);
  for (let i = 0; i < 3000; i++) {
    const s = await c.extractState("", jobId);
    if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("終わりません");
}
/** 断られる: 確かめで ok でなく、展開しても何も残らない */
async function refused(c: ReturnType<typeof client>, archive: string, why: RegExp, mode: "folder" | "here" = "folder") {
  const before = tree(root);
  const plan = await c.extractPlan("", archive, mode);
  expect(plan.ok, plan.reasons.join(" / ")).toBe(false);
  expect(plan.reasons.join(" / ")).toMatch(why);
  expect(Number.isNaN(plan.bytes) || Number.isNaN(plan.space.need)).toBe(false);
  const s = await extract(c, archive, mode);
  expect(s.phase).toBe("failed");
  expect(tree(root)).toEqual(before);
  expect(readdirSync(outer)).toEqual(["srv"]);
}

// ---- A-1: 数字でない・負・小数・巨大の大きさで、容量の検査がすり抜けない ----
describe("A-1 数字の確かめ", () => {
  const sizes: [string, string][] = [["abc", "nan"], ["-100", "neg"], ["Infinity", "inf"], ["1.5", "frac"], ["", "empty"], ["1e3", "exp"], ["9007199254740993", "unsafe"], ["0x10", "hex"], ["5 ", "space"]];
  for (const [v, label] of sizes) {
    it(`tar の pax size=${JSON.stringify(v)}(${label})は、その tar 全体を断る`, async () => {
      writeFileSync(join(root, "a.tar"), tarOf(paxEntry({ size: v, path: "a.txt" }), entry(hdr({ name: "x", size: 5 }), "hello")));
      await refused(client(), "a.tar", /拡張ヘッダー|壊れ|大きすぎ|大きさ/, "here");
    });
  }
  it("NaN の大きさを混ぜても、事前の見積もり・展開中の見張りは止まる(予約領域を割らない)", async () => {
    const zeros = Buffer.alloc(MiB);
    const f = (n: string) => entry(hdr({ name: n, size: MiB }), zeros);
    writeFileSync(join(root, "nan.tar.gz"), gzipSync(tarOf(...["a", "b", "c", "d"].map(f), paxEntry({ size: "abc" }), entry(hdr({ name: "last" })))));
    // 4 MiB はほぼ入らない(使えるのは (空き − 予約領域) の 80%)ディスク
    const fs: Statfs = async () => ({ free: 4 * MiB + 1000, total: 100 * MiB, block: 4096 });
    await refused(client({ statfs: fs, limits: { reserveMin: 1000, reservePercent: 0, ratioFloor: GiB } }), "nan.tar.gz", /拡張ヘッダー|壊れ|大きさ|空き容量/);
  });
  it("Guard は、大きさ・件数が数字でないもの・負・小数・2^53 以上・合計の桁あふれを断る", () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53, Number.MAX_SAFE_INTEGER + 2]) {
      const g = new Guard(mergeLimits());
      g.add("a", false, bad);
      expect(g.problems.size, String(bad)).toBeGreaterThan(0);
      expect(g.stopped).toBe(true);
    }
    const g = new Guard(mergeLimits({ fileBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER }));
    g.add("a", false, Number.MAX_SAFE_INTEGER - 5);
    g.add("b", false, 100); // 合計が 2^53 を超える
    expect(g.stopped).toBe(true);
    expect(Number.isSafeInteger(g.bytes)).toBe(true);
  });
  it("statfs が NaN・Infinity・負・block が NaN・total が NaN を返したら、空き容量が分からないものとして断る", async () => {
    put("a.zip", makeZipEx([{ name: "f", data: "x".repeat(1000) }]));
    const bad = [{ free: Number.NaN, total: 100 * GiB, block: 4096 }, { free: Number.POSITIVE_INFINITY, total: 100 * GiB, block: 4096 }, { free: -5, total: 100 * GiB, block: 4096 },
      { free: 50 * GiB, total: 100 * GiB, block: Number.NaN }, { free: 50 * GiB, total: Number.NaN, block: 4096 }, { free: 50 * GiB, total: -1, block: 4096 }, { free: 50 * GiB, total: 100 * GiB, block: 0 }];
    for (const v of bad) {
      const p = await client({ statfs: async () => v }).extractPlan("", "a.zip", "folder");
      expect(p.ok, JSON.stringify(v)).toBe(false);
      expect(p.reasons.join()).toMatch(/空き容量/);
      expect(Number.isNaN(p.space.reserve) || Number.isNaN(p.space.need)).toBe(false);
    }
  });
  it("展開の途中で statfs が NaN を返したら止めて、何も残さない", async () => {
    put("a.zip", makeZip({ "a.bin": "x".repeat(40_000), "b.bin": "y".repeat(40_000) }, false));
    let calls = 0;
    const s = await extract(client({ statfs: async () => (++calls <= 2 ? { free: 500 * GiB, total: 1000 * GiB, block: 4096 } : { free: Number.NaN, total: 1000 * GiB, block: 4096 }), limits: { checkEvery: 10_000 } }), "a.zip");
    expect(s.phase).toBe("failed");
    expect(tree(root)).toEqual(["a.zip", "server.properties"]);
  });
  it("GNU.sparse の pax・型 S は、普通のファイルとして展開せず断る。全体に効く拡張ヘッダー(g)の path・size も断る", async () => {
    writeFileSync(join(root, "a.tar"), tarOf(paxEntry({ "GNU.sparse.major": "1", "GNU.sparse.minor": "0", "GNU.sparse.name": "real.bin", "GNU.sparse.realsize": String(GiB) }), entry(hdr({ name: "GNUSparseFile.0/real.bin", size: 5 }), "MAP\n!")));
    await refused(client(), "a.tar", /sparse|穴/);
    writeFileSync(join(root, "b.tar"), tarOf(entry(hdr({ name: "s.bin", type: "S", size: 3 }), "abc")));
    await refused(client(), "b.tar", /対応していない/);
    writeFileSync(join(root, "c.tar"), tarOf(paxEntry({ path: "../evil" }, "g"), entry(hdr({ name: "ok", size: 1 }), "x")));
    await refused(client(), "c.tar", /全体に効く|拡張ヘッダー/);
  });
});

// ---- A-2: 展開の途中で、リンクに差し替えられても、サーバーの外に書かない ----
describe("A-2 差し替え(TOCTOU)", () => {
  it("展開の途中で archive のあるフォルダを、外へのリンクに差し替えても、外には何も書かれない", async () => {
    const outside = join(outer, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, "plugins"));
    put("plugins/x.zip", makeZip({ "f1.txt": "one", "d/f2.txt": "two", "d/f3.txt": "three" }));
    let calls = 0;
    let swapped = false;
    const statfs: Statfs = async () => {
      calls++;
      if (calls === 3 && !swapped) {
        swapped = true;
        renameSync(join(root, "plugins"), join(root, "plugins.bak"));
        copyFileSync(join(root, "plugins.bak", "x.zip"), join(outside, "x.zip"));
        symlinkSync(outside, join(root, "plugins"), "junction");
      }
      return { free: 500 * GiB, total: 1000 * GiB, block: 4096 };
    };
    const s = await extract(client({ statfs, limits: { checkEveryFiles: 1 } }), "plugins/x.zip");
    expect(swapped).toBe(true);
    expect(s.phase).toBe("failed");
    expect(s.error).toMatch(/差し替え|外を指す|リンク/);
    expect(readdirSync(outside)).toEqual(["x.zip"]); // 攻撃者が置いたものだけ
  });
  it("展開先の親を差し替えられたときの最後の rename も、外へは置かない(ここに展開)", async () => {
    const outside = join(outer, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, "plugins"));
    put("plugins/x.zip", makeZip({ "f1.txt": "one", "f2.txt": "two" }));
    let calls = 0;
    const statfs: Statfs = async () => {
      if (++calls === 3) {
        renameSync(join(root, "plugins"), join(root, "plugins.bak"));
        symlinkSync(outside, join(root, "plugins"), "junction");
      }
      return { free: 500 * GiB, total: 1000 * GiB, block: 4096 };
    };
    const s = await extract(client({ statfs, limits: { checkEveryFiles: 1 } }), "plugins/x.zip", "here");
    expect(s.phase).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
  });
});

// ---- B-1: tar.gz のフォルダ・メタデータの巨大なデータ部 ----
describe("B-1 読み捨てるデータの上限", () => {
  it("フォルダ(型 5)に付けた 1 MiB のデータ部を断る(読み捨てを続けない)", async () => {
    const gzs = createGzip();
    const file = join(root, "bomb.tar.gz");
    const out = createWriteStream(file);
    gzs.pipe(out);
    gzs.write(hdr({ name: "d/", type: "5", size: 256 * MiB }));
    const chunk = Buffer.alloc(MiB);
    for (let i = 0; i < 256; i++) if (!gzs.write(chunk)) await once(gzs, "drain");
    gzs.write(Buffer.alloc(1024));
    gzs.end();
    await once(out, "close");
    const t0 = Date.now();
    await refused(client(), "bomb.tar.gz", /フォルダ|メタデータ|中身が大きすぎ|大きすぎ/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("メタデータ(x・L・K)の 100 KB のデータ部も断る。リンクのデータ部も同じ", async () => {
    writeFileSync(join(root, "a.tar"), tarOf(entry(hdr({ name: "././@LongLink", type: "L", size: 100_000 }), Buffer.alloc(100_000, 0x61)), entry(hdr({ name: "f", size: 1 }), "x")));
    await refused(client(), "a.tar", /大きすぎ|メタデータ/);
    writeFileSync(join(root, "b.tar"), tarOf(entry(hdr({ name: "ln", type: "2", size: 100_000 }), Buffer.alloc(100_000))));
    await refused(client(), "b.tar", /大きすぎ|リンク/);
  });
  it("リンク・未対応のエントリーを 20,001 個以上並べた tar も、数えて断る", async () => {
    const parts: Buffer[] = [];
    for (let i = 0; i < 70_000; i++) parts.push(entry(hdr({ name: `l${i}`, type: "2" })));
    writeFileSync(join(root, "a.tar"), tarOf(...parts));
    await refused(client(), "a.tar", /多すぎ|リンク/);
  });
});

// ---- B-2: v7 の tar のフォルダ(型 0 + 名前が / で終わる) ----
describe("B-2 v7 形式のフォルダ", () => {
  it("確かめも展開も同じ判定で、フォルダとして展開できる(EEXIST で失敗しない)", async () => {
    writeFileSync(join(root, "a.tar"), tarOf(entry(hdr({ name: "d/", type: "0", size: 0 })), entry(hdr({ name: "d/f.txt", size: 2 }), "hi"), entry(hdr({ name: "e/", type: "0" }))));
    const s = await extract(client(), "a.tar");
    expect(s.phase, s.error).toBe("done");
    expect(readFileSync(join(root, "a", "d", "f.txt"), "utf8")).toBe("hi");
    expect(statSync(join(root, "a", "e")).isDirectory()).toBe(true);
  });
});

// ---- B-3: 取り消しは、展開で作ったものだけを消す ----
describe("B-3 取り消し", () => {
  const zipIn = async (names: Record<string, string>, mode: "folder" | "here" = "folder") => {
    put("a.zip", makeZip(names));
    const c = client();
    const s = await extract(c, "a.zip", mode);
    expect(s.phase, s.error).toBe("done");
    return { c, m: manifestOf(s.result!) };
  };
  it("展開の直後に、同じ大きさで中身だけ違うファイルへ書き換えられたら、消さない(内容のハッシュで見る)", async () => {
    const { c, m } = await zipIn({ "f.txt": "AAAA", "g.txt": "GGGG" });
    writeFileSync(join(root, "a", "f.txt"), "BBBB");
    const r = await removeCreated(c as never, "", m);
    expect(existsSync(join(root, "a", "f.txt"))).toBe(true);
    expect(readFileSync(join(root, "a", "f.txt"), "utf8")).toBe("BBBB");
    expect(r).toMatchObject({ removed: 1, kept: 1 });
    expect(existsSync(join(root, "a", "g.txt"))).toBe(false);
  });
  it("時刻だけ戻して同じ大きさ・別の中身にしても消さない", async () => {
    const { c, m } = await zipIn({ "f.txt": "AAAA" });
    const t = statSync(join(root, "a", "f.txt")).mtime;
    writeFileSync(join(root, "a", "f.txt"), "BBBB");
    utimesSync(join(root, "a", "f.txt"), t, t);
    const r = await removeCreated(c as never, "", m);
    expect(r.removed).toBe(0);
    expect(readFileSync(join(root, "a", "f.txt"), "utf8")).toBe("BBBB");
  });
  it("Pterodactyl の一覧(時刻 0)の取り消しも、ハッシュが無い・合わないものは消さない", async () => {
    const { c, m } = await zipIn({ "f.txt": "AAAA" });
    const noHash = { ...m, files: m.files.map((f) => [f[0], f[1], 0, ""] as [string, number, number, string]) };
    const r = await removeCreated(c as never, "", noHash);
    expect(r).toMatchObject({ removed: 0 });
    expect(r.unverified).toBe(1);
    expect(existsSync(join(root, "a", "f.txt"))).toBe(true);
  });
  it("展開で作ったフォルダを消して同じ名前の「ファイル」に入れ替えられたら、そのファイルを消さない", async () => {
    const { c, m } = await zipIn({ "f.txt": "AAAA" });
    rmSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a"), "利用者の大事なファイル(フォルダではない)");
    const r = await removeCreated(c as never, "", m);
    expect(readFileSync(join(root, "a"), "utf8")).toContain("大事");
    expect(r.dirsRemoved).toBe(0);
  });
  it("展開で作ったファイルがリンクに入れ替えられていたら、消さずに残す(リンク先も消さない)", async () => {
    const { c, m } = await zipIn({ "f.txt": "AAAA" });
    const target = join(outer, "target.txt");
    writeFileSync(target, "AAAA");
    rmSync(join(root, "a", "f.txt"));
    try { symlinkSync(target, join(root, "a", "f.txt"), "file"); } catch { return; } // Windows は権限が要る
    const r = await removeCreated(c as never, "", m);
    expect(r.removed).toBe(0);
    expect(existsSync(target)).toBe(true);
  });
  it("結果に、消した・残した(変えられていた)・確かめられなかった・フォルダの数が出る", async () => {
    const { c, m } = await zipIn({ "x/f.txt": "AAAA", "x/g.txt": "GGGG", "y/h.txt": "H" });
    writeFileSync(join(root, "a", "x", "g.txt"), "CHANGED");
    put("a/y/mine.txt", "mine");
    const r = await removeCreated(c as never, "", m);
    expect(r).toMatchObject({ removed: 2, kept: 1, unverified: 0 });
    expect(r.dirsKept).toBeGreaterThanOrEqual(2); // x(g.txt が残る)・y(mine.txt が残る)・a
  });
});

// ---- B-4: 起動の掃除は、こちらが作った印のあるものだけ ----
describe("B-4 掃除", () => {
  const old = new Date(Date.now() - 3 * 3600_000);
  const dead = 2_147_483_000;
  it("利用者の .craftshelf-extract-… は、古くても消さない", async () => {
    mkdirSync(join(root, ".craftshelf-extract-mine"));
    writeFileSync(join(root, ".craftshelf-extract-mine", "keep.txt"), "利用者のもの");
    writeFileSync(join(root, ".craftshelf-extract-notes.txt"), "利用者のメモ");
    mkdirSync(join(root, "plugins", ".craftshelf-extract-nested"), { recursive: true });
    writeFileSync(join(root, "plugins", ".craftshelf-extract-nested", "k"), "x");
    writeFileSync(join(root, ".craftshelf-extract-aaaa.job"), JSON.stringify({ tmp: "plugins/.craftshelf-extract-nested" })); // 偽の印(中に、こちらの印が無い)
    for (const p of [".craftshelf-extract-mine", ".craftshelf-extract-notes.txt", ".craftshelf-extract-aaaa.job"]) utimesSync(join(root, p), old, old);
    await cleanStale(root);
    expect(tree(root)).toEqual([".craftshelf-extract-aaaa.job", ".craftshelf-extract-mine/", ".craftshelf-extract-mine/keep.txt", ".craftshelf-extract-notes.txt", "plugins/", "plugins/.craftshelf-extract-nested/", "plugins/.craftshelf-extract-nested/k", "server.properties"]);
  });
  const orphan = (id: string, mark: Record<string, unknown>, mtime?: Date) => {
    const tmp = `plugins/.craftshelf-extract-${id}`;
    mkdirSync(join(root, ...tmp.split("/")), { recursive: true });
    writeFileSync(join(root, ...tmp.split("/"), "half.bin"), "half");
    writeFileSync(join(root, ...tmp.split("/"), MARK), JSON.stringify({ v: 1, id, boot: "old-boot", pid: dead, at: Date.now(), root: realpathSync(root), ...mark }));
    writeFileSync(join(root, `.craftshelf-extract-${id}.job`), JSON.stringify({ id, tmp }));
    if (mtime) for (const p of [`.craftshelf-extract-${id}.job`, `${tmp}/${MARK}`]) utimesSync(join(root, ...p.split("/")), mtime, mtime);
  };
  it("こちらの印があり、別の起動で pid も生きていないものは、新しくてもすぐ消す", async () => {
    orphan("aaaa", {});
    expect(await cleanStale(root)).toBe(1);
    expect(tree(root)).toEqual(["plugins/", "server.properties"]);
  });
  it("pid が生きているものは、10 分より新しければ残し、10 分より古ければ消す。動いている展開(同じ起動)のものは触らない", async () => {
    orphan("bbbb", { pid: process.pid });
    expect(await cleanStale(root)).toBe(0);
    orphan("cccc", { pid: process.pid }, old);
    expect(await cleanStale(root)).toBe(1);
    expect(tree(root).some((x) => x.includes("cccc"))).toBe(false);
    expect(tree(root).some((x) => x.includes("bbbb"))).toBe(true);
  });
  it("印の id・サーバーの識別が合わないもの、指す先がサーバーの外・.craftshelf-extract- でない名前のものは消さない", async () => {
    orphan("dddd", { id: "other" });
    orphan("eeee", { root: join(outer, "elsewhere") });
    mkdirSync(join(outer, "victim", ".craftshelf-extract-zz"), { recursive: true });
    writeFileSync(join(root, ".craftshelf-extract-ffff.job"), JSON.stringify({ id: "ffff", tmp: "../victim/.craftshelf-extract-zz" }));
    mkdirSync(join(root, "plugins", "important"));
    writeFileSync(join(root, ".craftshelf-extract-gggg.job"), JSON.stringify({ id: "gggg", tmp: "plugins/important" }));
    await cleanStale(root);
    expect(tree(root).some((x) => x.includes("dddd/half.bin"))).toBe(true);
    expect(tree(root).some((x) => x.includes("eeee/half.bin"))).toBe(true);
    expect(existsSync(join(outer, "victim", ".craftshelf-extract-zz"))).toBe(true);
    expect(existsSync(join(root, "plugins", "important"))).toBe(true);
  });
  it("SIGTERM・SIGINT で一時フォルダを消す手当てがある(同期の掃除の関数も)", () => {
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    expect(typeof cleanupTempsSync).toBe("function");
    cleanupTempsSync();
  });
});

// ---- B-5: ワールドを守る level-name の読み方 ----
describe("B-5 level-name", () => {
  it("Java の Properties と同じに読む: = : 空白の区切り・コメント・最後が勝つ・エスケープ・継続行", () => {
    expect(levelOf("level-name:w\n")).toBe("w");
    expect(levelOf("level-name w\n")).toBe("w");
    expect(levelOf("  level-name  =  ./w \n")).toBe("./w ");
    expect(levelOf("# level-name=x\nlevel-name=w\n")).toBe("w");
    expect(levelOf("! level-name=x\nlevel-name=a\nlevel-name=b\n")).toBe("b");
    expect(levelOf("level-name=my\\u0077orld\n")).toBe("myworld");
    expect(levelOf("level-name=wor\\\n   ld\n")).toBe("world");
    expect(levelOf("level\\-name=w\n")).toBe("w");
    expect(levelOf(null)).toBe("");
    expect(parseProps("a=1\r\nb:2\rc 3").get("c")).toBe("3");
  });
  it("守る名前を正規化・小文字・末尾のスラッシュ除去してから比べる。読めない・空・外を指すときは world とそのネザー・エンド", () => {
    for (const v of ["./world", "world/./", "a/../world", "World", "world/", "world "]) expect(protectedHit("world/x", protectedOf(v)), v).toBeTruthy();
    expect(protectedHit("WORLD/./x", protectedOf("world"))).toBeTruthy();
    expect(protectedHit("a/../world/x", protectedOf("world"))).toBeTruthy();
    expect(protectedHit("world_nether", protectedOf("world"))).toBeTruthy();
    for (const v of ["", "/abs/w", "../w", ".", "a/../.."]) expect(protectedOf(v), v).toEqual(["world", "world_nether", "world_the_end", "logs"]);
    expect(protectedHit("world", protectedOf("survival"))).toBeNull();
    expect(protectedHit("survival_nether/x", protectedOf("./survival/"))).toBeTruthy();
  });
  for (const [label, props] of [["level-name:w", "level-name:w"], ["level-name w", "level-name w"], ["level-name = ./w", "level-name = ./w"], ["コメントのあと", "# level-name=x\nlevel-name=w"], ["複数行は最後", "level-name=x\nlevel-name=w"]] as const) {
    it(`server.properties の「${label}」のとき、フォルダ w の中へは展開しない`, async () => {
      writeFileSync(join(root, "server.properties"), `${props}\n`);
      put("w/sub/b.zip", makeZip({ "x.txt": "1" }));
      const p = await client().extractPlan("", "w/sub/b.zip", "here");
      expect(p.ok, p.reasons.join()).toBe(false);
      expect(p.reasons.join()).toMatch(/守っている場所/);
    });
  }
  it("root の中のリンク(w2 → world)経由で、守っているワールドの中へ展開しない", async () => {
    mkdirSync(join(root, "world"));
    writeFileSync(join(root, "world", "level.dat"), "x");
    try { symlinkSync(join(root, "world"), join(root, "w2"), "junction"); } catch { return; }
    put("a.zip", makeZip({ "w2/evil.txt": "hi" }));
    const p = await client().extractPlan("", "a.zip", "here");
    expect(p.ok).toBe(false);
    expect(readdirSync(join(root, "world"))).toEqual(["level.dat"]);
    const s = await extract(client(), "a.zip", "here");
    expect(s.phase).toBe("failed");
    expect(readdirSync(join(root, "world"))).toEqual(["level.dat"]);
    // 圧縮ファイルが、ワールドへのリンクの中にあるときも
    put("w3.zip", makeZip({ "x.txt": "1" }));
    try { symlinkSync(join(root, "world"), join(root, "w3"), "junction"); } catch { return; }
    copyFileSync(join(root, "w3.zip"), join(root, "world", "in.zip"));
    expect((await client().extractPlan("", "w3/in.zip", "here")).ok).toBe(false);
  });
});

// ---- B-6 / C: 名前の穴 ----
describe("B-6・C 名前", () => {
  it("Windows の 8.3 の短い名前の形(LONGFI~1.TXT)は、確かめで断る", () => {
    for (const n of ["LONGFI~1.TXT", "PROGRA~1", "a/b/Docume~2", "longfi~12.txt"]) expect(cleanEntryName(n).problem, n).toBeTruthy();
    for (const n of ["a~b.txt", "~$tmp", "x~.txt", "backup~final"]) expect(cleanEntryName(n).problem, n).toBeUndefined();
  });
  it("COM¹・LPT²・CONIN$・CONOUT$・CLOCK$ も予約名として断る", () => {
    for (const n of ["COM\u00b9.txt", "LPT\u00b2", "com\u00b3", "CONIN$", "conout$.txt", "CLOCK$", "a/CONIN$"]) expect(cleanEntryName(n).problem, n).toBeTruthy();
  });
  it("見えない文字・向きを変える文字・壊れたサロゲート・.CraftShelf-(大文字)も断る", () => {
    for (const n of ["a\u202egnp.exe", "a\u2066x", "a\u200dx", "\ufeffx", "a\u0085b", "a\u2028b", "a\ud800b", ".CraftShelf-x/y", "..\u{e0001}/x"]) expect(cleanEntryName(n).problem, JSON.stringify(n)).toBeTruthy();
    expect(cleanEntryName("日本語/é.txt").problem).toBeUndefined();
  });
  it("ŝ・ſ・ı・ς など、大文字にすると同じになる名前も、衝突として断る", async () => {
    put("a.zip", makeZipEx([{ name: "s.txt", data: "1" }, { name: "\u017f.txt", data: "2" }]));
    await refused(client(), "a.zip", /大文字小文字/);
  });
  it("GNU 形式の tar(ustar + 空白 2 つ)の 345 バイト目以降は、prefix として読まない", async () => {
    writeFileSync(join(root, "a.tar"), tarOf(entry(hdr({ name: "f.txt", size: 1, magic: "ustar  \0", prefix: "12345678901" }), "x")));
    const s = await extract(client(), "a.tar");
    expect(s.phase, s.error).toBe("done");
    expect(tree(root)).toContain("a/f.txt");
    // POSIX の ustar は prefix を使う
    writeFileSync(join(root, "b.tar"), tarOf(entry(hdr({ name: "f.txt", size: 1, prefix: "pre/dir" }), "x")));
    expect((await extract(client(), "b.tar")).phase).toBe("done");
    expect(tree(root)).toContain("b/pre/dir/f.txt");
  });
  it("zip の「作った OS」が Unix 以外でも、Unix のモードがシンボリックリンクのものは断る", async () => {
    for (const host of [19, 0, 10, 14, 3]) {
      const z = makeZipEx([{ name: "ln", data: "../../target", mode: 0o120777 }]);
      for (let p = 0; p + 4 < z.length; p++) if (z.readUInt32LE(p) === 0x02014b50) z.writeUInt16LE((host << 8) | 20, p + 4);
      put(`h${host}.zip`, z);
      await refused(client(), `h${host}.zip`, /リンク/);
    }
  });
  it("確かめの画面に出す理由では、向きを変える文字・見えない文字を \\uXXXX の形で見せる", async () => {
    put("a.zip", makeZip({ "a\u202egnp.exe": "x", "b\u200dc": "y" }));
    const p = await client().extractPlan("", "a.zip", "folder");
    const text = p.reasons.join("");
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("\u200d");
    expect(text).toContain("\\u202e");
  });
});

// ---- zip: 偽の EOCD ----
describe("zip の末尾の曖昧さ", () => {
  it("末尾の EOCD のコメントに、別の EOCD を含ませた zip は、曖昧として断る(Go の読み方と食い違わないように)", async () => {
    const real = makeZipEx([{ name: "good.txt", data: "ok" }]);
    const decoy = makeZipEx([{ name: "evil.txt", data: "bad" }]);
    const at = real.length - 22;
    const dAt = decoy.length - 22;
    const comment = Buffer.concat([decoy.subarray(decoy.readUInt32LE(dAt + 16), dAt), decoy.subarray(dAt), Buffer.from("TRAILING")]);
    const end = Buffer.from(real.subarray(at));
    end.writeUInt16LE(comment.length, 20);
    put("a.zip", Buffer.concat([real.subarray(0, at), end, comment]));
    await refused(client(), "a.zip", /末尾|EOCD|曖昧|読めません/);
  });
  it("ふつうの zip(中に無圧縮の zip を入れたもの)は、これまでどおり展開できる", async () => {
    const inner = makeZip({ "x.txt": "inner" });
    put("a.zip", makeZip({ "inner.zip": inner }, false));
    expect((await extract(client(), "a.zip")).phase).toBe("done");
  });
});

// ---- 置く処理 ----
describe("置くときに失敗しても、置いたものを取りこぼさない", () => {
  it("link は成功して unlink だけが失敗しても、置いたものとして扱い、同名ありの失敗にはしない", async () => {
    put("from.txt", "x");
    const ops = { link: async (a: string, b: string) => { writeFileSync(b, readFileSync(a)); }, unlink: async () => { throw new Error("EPERM"); }, rename: async () => { throw new Error("使わない"); }, exists: async () => false };
    await expect(placeNoOverwrite(join(root, "from.txt"), join(root, "to.txt"), ops)).resolves.toBeUndefined();
    expect(readFileSync(join(root, "to.txt"), "utf8")).toBe("x");
  });
  it("link が使えない場所では、確かめてから rename。同名があれば失敗して、あるものを消さない", async () => {
    put("from.txt", "x");
    put("to.txt", "mine");
    const noLink = { link: async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, unlink: async () => {}, rename: async (a: string, b: string) => { renameSync(a, b); }, exists: async (p: string) => existsSync(p) };
    await expect(placeNoOverwrite(join(root, "from.txt"), join(root, "to.txt"), noLink)).rejects.toThrow("同じ名前");
    expect(readFileSync(join(root, "to.txt"), "utf8")).toBe("mine");
    rmSync(join(root, "to.txt"));
    await placeNoOverwrite(join(root, "from.txt"), join(root, "to.txt"), noLink);
    expect(readFileSync(join(root, "to.txt"), "utf8")).toBe("x");
  });
});

// ---- Pterodactyl の確かめの同時数・メモリ ----
describe("Pterodactyl の確かめ(メモリに読む)", () => {
  it("同時に読めるのは 2 つまで・合計 768 MiB まで。超えたら「しばらくしてからやり直してください」。終わると戻る", () => {
    expect(EXTRACT_LIMITS.pteroReadSlots).toBe(2);
    expect(EXTRACT_LIMITS.pteroReadBytes).toBe(768 * MiB);
    const a = reserveRead(100 * MiB);
    const b = reserveRead(100 * MiB);
    expect(() => reserveRead(1)).toThrow("しばらくしてから");
    a();
    expect(() => reserveRead(700 * MiB)).toThrow("しばらくしてから"); // 100 + 700 > 768
    const c = reserveRead(600 * MiB);
    b();
    c();
    a(); // 二重に戻しても数が狂わない
    const d = reserveRead(512 * MiB);
    const e = reserveRead(256 * MiB);
    d();
    e();
  });
});
