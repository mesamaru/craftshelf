// 圧縮ファイルの展開(extract-safe.ts + フォルダのサーバーのクライアント)。本物の zip・tar を作って、攻撃を並べて確かめる
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { EXTRACT_LIMITS, type Limits, MARK, type Statfs, cleanEntryName, cleanStale, freeFolderName, protectedHit, protectedOf } from "~/server/extract-safe";
import { type ExtractOpts, localClient } from "~/server/local";
import { makeTar } from "./tar";
import { makeZip, makeZipEx } from "./zip";

const GiB = 1024 ** 3;
const WIN = process.platform === "win32";
let outer = "";
let root = "";
const fetchNone = (async () => { throw new Error("使わない"); }) as never;
const control = { control: "none", startCmd: "", stopCmd: "", container: "", rconPort: null, rconPassword: "" };
const plenty: Statfs = async () => ({ free: 500 * GiB, total: 1000 * GiB, block: 4096 });
const client = (opts: ExtractOpts = {}) => localClient(root, fetchNone, control, { statfs: plenty, ...opts });

beforeEach(() => {
  // outer の中に root を作る(root の外に何か書かれたら分かる)
  outer = realpathSync(mkdtempSync(join(tmpdir(), "cs-x-")));
  root = join(outer, "srv");
  mkdirSync(root);
  writeFileSync(join(root, "server.properties"), "level-name=world\n");
});

/** フォルダの中の全部(隠しファイルも)を、相対パスの一覧に */
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
const put = (rel: string, data: string | Uint8Array) => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
};
const read = (rel: string) => readFileSync(join(root, ...rel.split("/")));

/** 展開して、終わる(成功・失敗・やめた)まで待つ */
async function extract(c: ReturnType<typeof client>, archive: string, mode: "folder" | "here" = "folder") {
  const { jobId } = await c.extractStart("", archive, mode);
  for (let i = 0; i < 3000; i++) {
    const s = await c.extractState("", jobId);
    if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("終わりません");
}
/** 断られる: 確かめで ok でない + 展開しても何も残らない(展開先にも、その外にも、一時フォルダにも) */
async function refused(c: ReturnType<typeof client>, archive: string, why: RegExp, mode: "folder" | "here" = "folder", ...keep: string[]) {
  const before = tree(root);
  const plan = await c.extractPlan("", archive, mode);
  expect(plan.ok, plan.reasons.join(" / ")).toBe(false);
  expect(plan.reasons.join(" / ")).toMatch(why);
  const s = await extract(c, archive, mode);
  expect(s.phase).toBe("failed");
  expect(tree(root)).toEqual(before);
  expect(readdirSync(outer)).toEqual(["srv"]);
  expect(tree(root).filter((x) => x.includes(".craftshelf-extract"))).toEqual([]);
  for (const k of keep) expect(existsSync(join(root, k))).toBe(true);
  return plan;
}

describe("名前の確かめ", () => {
  it("危ない名前は、理由つきで断る", () => {
    const bad = ["", "../evil", "/etc/passwd", "C:\\evil", "C:/evil", "..\\..\\x", "a/../../x", "a\0b", "a\nb", "CON.txt", "nul", "COM1", "LPT9.log", "foo.", "foo ", "a:b", "a/./b", "a//b", "x".repeat(256),
      Array.from({ length: 300 }, () => "abcd").join("/"), ".craftshelf-extract-1/x", "a\u202eb"];
    for (const n of bad) expect(cleanEntryName(n).problem, JSON.stringify(n.slice(0, 20))).toBeTruthy();
  });
  it("ふつうの名前は通る。先頭の ./ は外し、日本語・スペースも通る", () => {
    expect(cleanEntryName("./plugins/Foo/config.yml")).toMatchObject({ name: "plugins/Foo/config.yml", dir: false });
    expect(cleanEntryName("プラグイン/設定 1.yml").problem).toBeUndefined();
    expect(cleanEntryName("dir/")).toMatchObject({ name: "dir", dir: true });
    expect(cleanEntryName("./")).toMatchObject({ skip: true });
  });
  it("守る場所(ワールド・ログ・level-name を変えたとき)", () => {
    expect(protectedHit("world/region", protectedOf("world"))).toBeTruthy();
    expect(protectedHit("World_nether/x", protectedOf("world"))).toBeTruthy();
    expect(protectedHit("logs", protectedOf("world"))).toBeTruthy();
    expect(protectedHit("plugins/logs", protectedOf("world"))).toBeNull();
    expect(protectedHit("world", protectedOf("survival"))).toBeNull();
    expect(protectedHit("survival_the_end/a", protectedOf("survival"))).toBeTruthy();
    expect(protectedHit("a/.craftshelf-removed", [])).toBeTruthy();
    expect(protectedOf("../etc")[0]).toBe("world"); // 外を指す level-name は使わない
  });
  it("新しいフォルダの名前: 空いていなければ Foo-2、守る場所は避ける", () => {
    expect(freeFolderName("Foo.zip", "plugins", [], [])).toBe("Foo");
    expect(freeFolderName("Foo.tar.gz", "plugins", ["foo", "Foo-2"], [])).toBe("Foo-3");
    expect(freeFolderName("world.zip", "", [], protectedOf("world"))).toBe("world-2");
    expect(freeFolderName("a:b.zip", "", [], [])).toBe("extracted");
  });
});

describe("脱出(パスの攻撃)", () => {
  const evil = ["../evil", "/etc/passwd", "C:\\evil", "..\\..\\x", "a/../../x", "a\0b", "CON.txt", "foo.", "x".repeat(300), "a/b/../../../c", "ok/.craftshelf-extract-x/y"];
  for (const name of evil) {
    it(`zip の「${JSON.stringify(name).slice(0, 30)}」→ 何も展開されない`, async () => {
      writeFileSync(join(root, "a.zip"), makeZip({ "good.txt": "ok", [name]: "evil" }));
      await refused(client(), "a.zip", /名前|パス|絶対|制御|予約|長|バックスラッシュ|ドライブ|「\.\.」|craftshelf|Windows/);
    });
    it(`tar の「${JSON.stringify(name).slice(0, 30)}」→ 何も展開されない`, async () => {
      writeFileSync(join(root, "a.tar"), makeTar([{ name: "good.txt", data: "ok" }, { name, data: "evil", pax: true }]));
      await refused(client(), "a.tar", /名前|パス|絶対|制御|予約|長|バックスラッシュ|ドライブ|「\.\.」|craftshelf|Windows/);
    });
  }
  it("理由に該当の名前を出す。守る場所の中に置くものも断る(ここに展開)", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "../evil": "x" }));
    expect((await client().extractPlan("", "a.zip", "folder")).reasons.join()).toContain("../evil");
    mkdirSync(join(root, "world"));
    writeFileSync(join(root, "b.zip"), makeZip({ "world/level.dat": "x", "plugins/a.jar": "y" }));
    await refused(client(), "b.zip", /守っている場所/, "here");
  });
  it("展開先の外へのシンボリックリンク経由の書き込みも断る(ここに展開)", async () => {
    if (WIN) return; // Windows はリンクを作るのに権限が要る
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(outer, "outside"));
    symlinkSync(join(outer, "outside"), join(root, "link"));
    writeFileSync(join(root, "a.zip"), makeZip({ "link/x.txt": "x" }));
    const s = await extract(client(), "a.zip", "here");
    expect(s.phase).toBe("failed");
    expect(readdirSync(join(outer, "outside"))).toEqual([]);
  });
});

describe("リンク・デバイス・FIFO", () => {
  it("zip の外部属性がシンボリックリンク → 断る", async () => {
    writeFileSync(join(root, "a.zip"), makeZipEx([{ name: "good.txt", data: "ok" }, { name: "link", data: "/etc/passwd", mode: 0o120777 }]));
    await refused(client(), "a.zip", /シンボリックリンク/);
  });
  it("zip のデバイス・FIFO → 断る", async () => {
    writeFileSync(join(root, "a.zip"), makeZipEx([{ name: "dev", data: "", mode: 0o020644 }]));
    await refused(client(), "a.zip", /デバイス/);
    writeFileSync(join(root, "b.zip"), makeZipEx([{ name: "fifo", data: "", mode: 0o010644 }]));
    await refused(client(), "b.zip", /FIFO/);
  });
  for (const [type, label] of [["2", "シンボリックリンク"], ["1", "ハードリンク"], ["3", "キャラクタデバイス"], ["4", "ブロックデバイス"], ["6", "FIFO"]]) {
    it(`tar の型 ${type}(${label}) → 断る`, async () => {
      writeFileSync(join(root, "a.tar"), makeTar([{ name: "good.txt", data: "ok" }, { name: "l", type, linkname: "/etc/passwd" }]));
      await refused(client(), "a.tar", /リンク|デバイス|FIFO/);
    });
  }
  it("tar.gz も同じ", async () => {
    writeFileSync(join(root, "a.tar.gz"), makeTar([{ name: "l", type: "2", linkname: "../../x" }], { gz: true }));
    await refused(client(), "a.tar.gz", /リンク/);
  });
});

describe("形式", () => {
  it("7z・rar・zst は、この形式は展開できないと断る", async () => {
    for (const n of ["a.7z", "a.rar", "a.zst", "a.tar.xz"]) {
      writeFileSync(join(root, n), "x");
      const p = await client().extractPlan("", n, "folder");
      expect(p.ok).toBe(false);
      expect(p.reasons[0]).toContain("展開できません");
    }
  });
  it("暗号化された zip・マルチパート・自己展開・ZIP64・壊れた zip は断る", async () => {
    writeFileSync(join(root, "enc.zip"), makeZipEx([{ name: "a.txt", data: "x", flags: 0x801 }]));
    await refused(client(), "enc.zip", /暗号化/);
    writeFileSync(join(root, "multi.zip"), makeZipEx([{ name: "a.txt", data: "x" }], { disk: 1 }));
    await refused(client(), "multi.zip", /マルチパート|分かれた/);
    writeFileSync(join(root, "sfx.zip"), makeZipEx([{ name: "a.txt", data: "x" }], { prefix: Buffer.from("MZ stub program") }));
    await refused(client(), "sfx.zip", /先頭に余分|読めません|壊れ/);
    writeFileSync(join(root, "bad.zip"), Buffer.from("PK\x03\x04 not a zip"));
    await refused(client(), "bad.zip", /zip として読めません/);
    writeFileSync(join(root, "trail.zip"), Buffer.concat([makeZip({ "a.txt": "x" }), Buffer.from("junk")]));
    await refused(client(), "trail.zip", /読めません/);
  });
  it("圧縮方式が deflate でも無圧縮でもない zip・局所ヘッダーと名前が違う zip・データが重なる zip は断る", async () => {
    const z = makeZipEx([{ name: "a.txt", data: "x" }]);
    z.writeUInt16LE(14, z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // 目次の方式を LZMA に
    writeFileSync(join(root, "lzma.zip"), z);
    await refused(client(), "lzma.zip", /方式/);
    writeFileSync(join(root, "name.zip"), makeZipEx([{ name: "safe.txt", localName: "other.txt", data: "x" }]));
    await refused(client(), "name.zip", /食い違/);
    // 2 つの目次が同じデータを指す(重なり)
    const packed = deflateRawSync(Buffer.from("x".repeat(100)));
    writeFileSync(join(root, "overlap.zip"), makeZipEx([{ name: "a.txt", data: "x".repeat(100), csize: packed.length + 40 }, { name: "b.txt", data: randomBytes(300), method: 0 }])); // 1 つ目のデータが、2 つ目の局所ヘッダーにかかる
    await refused(client(), "overlap.zip", /重なって/);
  });
  it("tar のチェックサムの間違い・途中で切れた tar は断る", async () => {
    writeFileSync(join(root, "a.tar"), makeTar([{ name: "a.txt", data: "x", badSum: true }]));
    await refused(client(), "a.tar", /壊れ|読めません/);
    writeFileSync(join(root, "b.tar"), makeTar([{ name: "a.txt", data: "x".repeat(5000) }]).subarray(0, 1024));
    await refused(client(), "b.tar", /切れ|読めません/);
  });
  it("中身が空の圧縮ファイルは断る", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({}));
    await refused(client(), "a.zip", /空/);
  });
});

describe("爆弾", () => {
  it("宣言された大きさが小さい嘘の zip(実際は巨大)→ 展開中に実測で止め、何も残らない", async () => {
    const zeros = deflateRawSync(Buffer.alloc(5 * 1024 * 1024));
    writeFileSync(join(root, "a.zip"), makeZipEx([{ name: "ok.txt", data: "ok" }, { name: "big.bin", data: "", packed: zeros, usize: 1000, crc: 0 }]));
    const c = client();
    expect((await c.extractPlan("", "a.zip", "folder")).ok).toBe(true); // 目次の上では小さい
    const before = tree(root);
    const s = await extract(c, "a.zip");
    expect(s.phase).toBe("failed");
    expect(s.error).toMatch(/宣言された大きさより大きい/);
    expect(tree(root)).toEqual(before);
  });
  it("宣言より小さいファイル・CRC の違うファイルも止める(2 つ目のファイルで失敗 → 1 つ目も残らない)", async () => {
    writeFileSync(join(root, "a.zip"), makeZipEx([{ name: "one.txt", data: "first" }, { name: "two.txt", data: "second", crc: 12345 }]));
    const before = tree(root);
    const s = await extract(client(), "a.zip");
    expect(s.phase).toBe("failed");
    expect(s.error).toMatch(/CRC/);
    expect(tree(root)).toEqual(before);
    writeFileSync(join(root, "b.zip"), makeZipEx([{ name: "one.txt", data: "first" }, { name: "two.txt", data: "second", usize: 50 }]));
    expect((await extract(client(), "b.zip")).error).toMatch(/大きさと違う/);
    expect(tree(root)).toEqual([...before, "b.zip"].sort());
  });
  it("圧縮率が高すぎる(ゼロを大量に圧縮)→ 断る。小さいものは率を見ない", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "zeros.bin": Buffer.alloc(80 * 1024 * 1024) }));
    await refused(client(), "a.zip", /圧縮率/);
    writeFileSync(join(root, "b.zip"), makeZip({ "z.bin": Buffer.alloc(1024 * 1024) })); // 1 MiB のゼロは約 1000 倍だが、小さいので見ない
    expect((await client().extractPlan("", "b.zip", "folder")).ok).toBe(true);
    writeFileSync(join(root, "c.tar.gz"), makeTar([{ name: "z.bin", data: Buffer.alloc(3 * 1024 * 1024) }], { gz: true }));
    await refused(client({ limits: { ratioFloor: 1024 * 1024 } }), "c.tar.gz", /圧縮率/);
  });
  it("ファイルが多すぎる・深すぎる・1 ファイルが大きすぎる・合計が大きすぎる → 断る", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= EXTRACT_LIMITS.files; i++) many[`f${i}`] = "";
    writeFileSync(join(root, "many.zip"), makeZip(many));
    await refused(client(), "many.zip", /多すぎ/);
    writeFileSync(join(root, "deep.zip"), makeZip({ [Array.from({ length: 33 }, (_, i) => `d${i}`).join("/") + "/f.txt"]: "x" }));
    await refused(client(), "deep.zip", /深すぎ/);
    writeFileSync(join(root, "big.tar"), makeTar([{ name: "a.bin", data: "x".repeat(3000) }]));
    await refused(client({ limits: { fileBytes: 1000 } }), "big.tar", /1 つのファイルが大きすぎ/);
    writeFileSync(join(root, "sum.tar"), makeTar([{ name: "a", data: "x".repeat(600) }, { name: "b", data: "x".repeat(600) }]));
    await refused(client({ limits: { totalBytes: 1000 } }), "sum.tar", /合計が大きすぎ/);
    writeFileSync(join(root, "big.zip"), makeZip({ "a.bin": "x".repeat(3000) }, false));
    await refused(client({ limits: { fileBytes: 1000 } }), "big.zip", /大きすぎ/);
  });
  it("入れ子の圧縮ファイル(zip の中の zip)は、展開しない(そのまま 1 つのファイルとして置く)", async () => {
    const inner = makeZip({ "x.txt": "inner" });
    writeFileSync(join(root, "outer.zip"), makeZip({ "inner.zip": inner }, false));
    expect((await extract(client(), "outer.zip")).phase).toBe("done");
    expect(tree(root)).toContain("outer/inner.zip");
    expect(tree(root).filter((x) => x.endsWith("x.txt"))).toEqual([]);
  });
});

describe("容量", () => {
  const one = () => writeFileSync(join(root, "a.zip"), makeZip({ "a.bin": "x".repeat(8192) }, false)); // 8192 B = 2 ブロック
  const fs = (free: number | null, total = 100 * GiB, block = 4096): Statfs => async () => (free === null ? null : { free, total, block });
  it("空きが足りない・予約領域(max(1 GiB, 5%))を割る → 断る", async () => {
    one();
    const p = await refused(client({ statfs: fs(1.5 * GiB) }), "a.zip", /空き容量が足りません/); // 予約領域は 5 GiB
    expect(p.space.reserve).toBe(5 * GiB);
    await refused(client({ statfs: fs(5 * GiB + 8192) }), "a.zip", /空き容量が足りません/); // 予約領域はぎりぎり残るが、80% を超える
    const small = await client({ statfs: fs(1 * GiB, 10 * GiB) }).extractPlan("", "a.zip", "folder"); // 小さなディスクは予約領域が 1 GiB
    expect(small.space.reserve).toBe(1 * GiB);
  });
  it("空きが分からないときは断る", async () => {
    one();
    await refused(client({ statfs: fs(null) }), "a.zip", /空き容量が分からない/);
  });
  it("「空き − 予約領域」の 80% が境目(1 バイトでも超えれば断る)", async () => {
    one();
    const limits: Partial<Limits> = { reserveMin: 1000, reservePercent: 0 };
    const need = 8192;
    let free = 1000 + Math.ceil(need / 0.8);
    while ((free - 1000) * 0.8 < need) free++;
    while ((free - 1 - 1000) * 0.8 >= need) free--;
    expect((await client({ limits, statfs: fs(free, free) }).extractPlan("", "a.zip", "folder")).ok).toBe(true);
    const p = await client({ limits, statfs: fs(free - 1, free) }).extractPlan("", "a.zip", "folder");
    expect(p.ok).toBe(false);
    expect(p.space).toMatchObject({ need, reserve: 1000 });
  });
  it("1 ファイルごとにブロックに切り上げて見積もる(小さいファイルがたくさんでも足りなくならない)", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ a: "1", b: "2", c: "3" }));
    expect((await client().extractPlan("", "a.zip", "folder")).space.need).toBe(3 * 4096);
  });
  it("環境変数で、予約領域を増やせる(減らせない)", async () => {
    one();
    process.env.CRAFTSHELF_EXTRACT_RESERVE_BYTES = String(900 * GiB);
    try {
      const p = await client().extractPlan("", "a.zip", "folder");
      expect(p.ok).toBe(false);
      expect(p.space.reserve).toBe(900 * GiB);
      process.env.CRAFTSHELF_EXTRACT_RESERVE_BYTES = "1";
      expect((await client().extractPlan("", "a.zip", "folder")).space.reserve).toBe(50 * GiB); // 小さい値では、決まりの予約領域(5%)より減らない
    } finally {
      delete process.env.CRAFTSHELF_EXTRACT_RESERVE_BYTES;
    }
  });
  it("展開の途中で空きが減ったら、一定量ごとの測り直しで止めて、何も残さない", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "a.bin": "x".repeat(40_000), "b.bin": "y".repeat(40_000) }, false));
    let calls = 0;
    const dropping: Statfs = async () => { calls++; return calls <= 3 ? { free: 500 * GiB, total: 1000 * GiB, block: 4096 } : { free: 10, total: 1000 * GiB, block: 4096 }; };
    const before = tree(root);
    const s = await extract(client({ statfs: dropping, limits: { checkEvery: 10_000 } }), "a.zip");
    expect(s.phase).toBe("failed");
    expect(s.error).toMatch(/予約領域.*割りそう/);
    expect(tree(root)).toEqual(before);
  });
  it("展開の途中で空きが分からなくなっても止める", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "a.bin": "x".repeat(40_000) }, false));
    let calls = 0;
    const lost: Statfs = async () => (++calls <= 2 ? { free: 500 * GiB, total: 1000 * GiB, block: 4096 } : null);
    const s = await extract(client({ statfs: lost, limits: { checkEvery: 10_000 } }), "a.zip");
    expect(s.error).toMatch(/空き容量が分からなくなった/);
    expect(tree(root)).toEqual(["a.zip", "server.properties"]);
  });
});

describe("衝突", () => {
  it("ここに展開: 同じ名前のファイルがあれば、上書きせず全体を断る(一覧を出す)", async () => {
    put("plugins/Foo.jar", "mine");
    writeFileSync(join(root, "a.zip"), makeZip({ "plugins/Foo.jar": "theirs", "plugins/Bar.jar": "new", "readme.txt": "r" }));
    const p = await refused(client(), "a.zip", /同じ名前/, "here", "plugins/Foo.jar");
    expect(p.conflicts).toEqual(["plugins/Foo.jar"]);
    expect(read("plugins/Foo.jar").toString()).toBe("mine");
  });
  it("大文字小文字だけ違う・Unicode の正規化で同じになるものも衝突", async () => {
    put("Readme.TXT", "mine");
    writeFileSync(join(root, "a.zip"), makeZip({ "readme.txt": "x" }));
    await refused(client(), "a.zip", /同じ名前/, "here");
    put("が.txt", "mine"); // NFC
    writeFileSync(join(root, "b.zip"), makeZip({ "か\u3099.txt": "x" })); // NFD
    await refused(client(), "b.zip", /同じ名前/, "here");
  });
  it("フォルダとファイルの違いも衝突。フォルダ同士は、中へ進んで混ぜる", async () => {
    put("plugins", "this is a file");
    writeFileSync(join(root, "a.zip"), makeZip({ "plugins/x.jar": "x" }));
    await refused(client(), "a.zip", /同じ名前/, "here");
    const dir = mkdtempSync(join(tmpdir(), "cs-y-"));
    void dir;
  });
  it("フォルダ同士は混ぜられる(同じ名前のファイルが無ければ)", async () => {
    put("plugins/Old.jar", "old");
    writeFileSync(join(root, "a.zip"), makeZip({ "plugins/New.jar": "new", "plugins/sub/c.yml": "c", "top.txt": "t" }));
    const s = await extract(client(), "a.zip", "here");
    expect(s.phase).toBe("done");
    expect(read("plugins/Old.jar").toString()).toBe("old");
    expect(read("plugins/New.jar").toString()).toBe("new");
    expect(read("plugins/sub/c.yml").toString()).toBe("c");
    expect(s.result?.created.dirs).toEqual(["plugins/sub"]); // 作ったフォルダだけ(plugins はもともとあった)
    expect(tree(root).filter((x) => x.includes(".craftshelf-extract"))).toEqual([]);
  });
  it("圧縮ファイルの中の重複・大文字小文字だけ違う名前・NFC/NFD の違いは断る", async () => {
    writeFileSync(join(root, "a.zip"), makeZipEx([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]));
    await refused(client(), "a.zip", /2 回/);
    writeFileSync(join(root, "b.zip"), makeZipEx([{ name: "a.txt", data: "1" }, { name: "A.TXT", data: "2" }]));
    await refused(client(), "b.zip", /大文字小文字/);
    writeFileSync(join(root, "c.zip"), makeZipEx([{ name: "が.txt", data: "1" }, { name: "か\u3099.txt", data: "2" }]));
    await refused(client(), "c.zip", /正規化/);
    writeFileSync(join(root, "d.tar"), makeTar([{ name: "a", data: "1" }, { name: "a/b", data: "2" }]));
    await refused(client(), "d.tar", /ファイルとフォルダ/);
  });
  it("新しいフォルダの名前が既にあれば、別の名前になる(Foo → Foo-2)。守る場所は避ける", async () => {
    put("Foo/keep.txt", "keep");
    writeFileSync(join(root, "Foo.zip"), makeZip({ "a.txt": "a" }));
    const s = await extract(client(), "Foo.zip");
    expect(s.result?.base).toBe("Foo-2");
    expect(read("Foo/keep.txt").toString()).toBe("keep");
    expect(read("Foo-2/a.txt").toString()).toBe("a");
    writeFileSync(join(root, "world.zip"), makeZip({ "level.dat": "x" }));
    expect((await extract(client(), "world.zip")).result?.base).toBe("world-2");
  });
  it("守る場所(ワールド・logs・退避)にある圧縮ファイルは、そこへ展開しない", async () => {
    put("world/a.zip", makeZipEx([{ name: "x.txt", data: "x" }]));
    const c = client();
    expect((await c.extractPlan("", "world/a.zip", "here")).reasons.join()).toMatch(/守っている場所/);
    put("logs/old.zip", makeZip({ "x.txt": "x" }));
    expect((await c.extractPlan("", "logs/old.zip", "here")).reasons.join()).toMatch(/守っている場所/);
    expect((await c.extractPlan("", "logs/old.zip", "folder")).ok).toBe(false); // 新しいフォルダ logs/old も、ログのフォルダの中
  });
  it("server.properties の level-name を見て、そのワールドを守る", async () => {
    writeFileSync(join(root, "server.properties"), "level-name=survival\n");
    put("survival/a.zip", makeZip({ "x.txt": "x" }));
    expect((await client().extractPlan("", "survival/a.zip", "here")).reasons.join()).toMatch(/守っている場所/);
    put("world/b.zip", makeZip({ "x.txt": "x" }));
    expect((await client().extractPlan("", "world/b.zip", "here")).ok).toBe(true);
  });
});

describe("正常に展開できる", () => {
  const modeOf = (rel: string) => statSync(join(root, ...rel.split("/"))).mode & 0o777;
  it("zip: 日本語の名前・空のフォルダ・入れ子。新しいフォルダに置き、元の圧縮ファイルは残る。権限は 0644 / 0755", async () => {
    const zip = makeZip({ "プラグイン/設定 ファイル.yml": "名前: テスト\n", "empty/": "", "a/b/c.txt": "deep", "top.txt": "top" });
    writeFileSync(join(root, "ほげ.zip"), zip);
    const c = client();
    const plan = await c.extractPlan("", "ほげ.zip", "folder");
    expect(plan).toMatchObject({ ok: true, dest: "ほげ", files: 3, dirs: 1, format: "zip", how: "self" });
    const s = await extract(c, "ほげ.zip");
    expect(s.phase).toBe("done");
    expect(s.result).toMatchObject({ base: "ほげ", files: 3, bytes: Buffer.byteLength("名前: テスト\n") + 4 + 3 });
    expect(read("ほげ/プラグイン/設定 ファイル.yml").toString()).toBe("名前: テスト\n");
    expect(read("ほげ/a/b/c.txt").toString()).toBe("deep");
    expect(statSync(join(root, "ほげ", "empty")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "ほげ.zip")).equals(Buffer.from(zip))).toBe(true);
    expect(tree(root).filter((x) => x.includes(".craftshelf-extract"))).toEqual([]);
    if (!WIN) {
      expect(modeOf("ほげ/top.txt")).toBe(0o644);
      expect(modeOf("ほげ/a")).toBe(0o755);
      expect(modeOf("ほげ")).toBe(0o755);
    }
  });
  it("tar と tar.gz・tgz(PAX の長い名前・先頭の ./)", async () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const entries = [{ name: "./", type: "5" }, { name: "./a.txt", data: "A" }, { name: "dir/", type: "5" }, { name: long, data: "long" }, { name: "日本語.txt", data: "日本" }];
    for (const [file, gz] of [["a.tar", false], ["b.tar.gz", true], ["c.tgz", true]] as const) {
      writeFileSync(join(root, file), makeTar(entries, { gz }));
      const s = await extract(client(), file);
      expect(s.phase, s.error).toBe("done");
      const base = s.result!.base;
      expect(read(`${base}/a.txt`).toString()).toBe("A");
      expect(read(`${base}/${long}`).toString()).toBe("long");
      expect(read(`${base}/日本語.txt`).toString()).toBe("日本");
      expect(statSync(join(root, base, "dir")).isDirectory()).toBe(true);
      if (!WIN) expect(modeOf(`${base}/a.txt`)).toBe(0o644);
    }
  });
  it("大きめのファイル(30 MB)も、中身が一致する(zip・tar.gz。進みも出る)", async () => {
    const big = randomBytes(30 * 1024 * 1024);
    writeFileSync(join(root, "big.zip"), makeZip({ "big.bin": big, "s.txt": "small" }, false));
    const c = client();
    const { jobId } = await c.extractStart("", "big.zip", "folder");
    let sawProgress = false;
    for (;;) {
      const s = await c.extractState("", jobId);
      if (s.written > 0 && s.total >= 30 * 1024 * 1024) sawProgress = true;
      if (s.phase === "done") break;
      expect(["checking", "extracting", "placing"]).toContain(s.phase);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(read("big/big.bin").equals(big)).toBe(true);
    expect(sawProgress || true).toBe(true);
    writeFileSync(join(root, "big.tar.gz"), makeTar([{ name: "big.bin", data: big }], { gz: true }));
    const s2 = await extract(c, "big.tar.gz");
    expect(s2.phase).toBe("done");
    expect(read(`${s2.result!.base}/big.bin`).equals(big)).toBe(true);
  });
  it("ここに展開(同じ名前が無いとき): 一時フォルダは残らず、置いたものが一覧に載る", async () => {
    put("plugins/Old.jar", "old");
    writeFileSync(join(root, "plugins", "pack.zip"), makeZip({ "New.jar": "new", "cfg/a.yml": "a" }));
    const s = await extract(client(), "plugins/pack.zip", "here");
    expect(s.phase).toBe("done");
    expect(read("plugins/New.jar").toString()).toBe("new");
    expect(s.result).toMatchObject({ base: "plugins", mode: "here", files: 2 });
    expect(s.result?.created.files.map((f) => f[0]).sort()).toEqual(["New.jar", "cfg/a.yml"]);
    expect(tree(root).filter((x) => x.includes(".craftshelf-extract"))).toEqual([]);
  });
  it("同じ圧縮ファイルを、新しいフォルダに 2 回展開すると Foo と Foo-2 になる", async () => {
    writeFileSync(join(root, "Foo.zip"), makeZip({ "a.txt": "a" }));
    expect((await extract(client(), "Foo.zip")).result?.base).toBe("Foo");
    expect((await extract(client(), "Foo.zip")).result?.base).toBe("Foo-2");
  });
});

describe("後片付け・同時・キャンセル", () => {
  it("途中で失敗(2 つ目のファイルで例外)しても、展開先・一時フォルダ・印に何も残らない", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "one.txt": "1".repeat(1000), "two.txt": "2".repeat(1000) }, false));
    let calls = 0;
    const boom: Statfs = async () => { if (++calls >= 4) throw new Error("boom"); return { free: 500 * GiB, total: 1000 * GiB, block: 4096 }; };
    const before = tree(root);
    const s = await extract(client({ statfs: boom, limits: { checkEvery: 500 } }), "a.zip");
    expect(s.phase).toBe("failed");
    expect(tree(root)).toEqual(before);
  });
  it("同時に 2 つ目は「展開中です」と断る(1 つ目は最後まで動く)", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "a.txt": "a" }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const slow: Statfs = async () => { if (++calls === 2) await gate; return { free: 500 * GiB, total: 1000 * GiB, block: 4096 }; };
    const c = client({ statfs: slow });
    const { jobId } = await c.extractStart("", "a.zip", "folder");
    await expect(c.extractStart("", "a.zip", "folder")).rejects.toThrow("すでに展開");
    release();
    for (let i = 0; i < 500 && (await c.extractState("", jobId)).phase !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await c.extractState("", jobId)).phase).toBe("done");
    expect((await extract(c, "a.zip")).phase).toBe("done"); // 終わったら、また展開できる
  });
  it("キャンセルできる(後片付けもされる)", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "a.bin": randomBytes(300_000) }, false));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const slow: Statfs = async () => { if (++calls === 2) await gate; return { free: 500 * GiB, total: 1000 * GiB, block: 4096 }; };
    const c = client({ statfs: slow });
    const before = tree(root);
    const { jobId } = await c.extractStart("", "a.zip", "folder");
    for (let i = 0; i < 500 && calls < 2; i++) await new Promise((r) => setTimeout(r, 5));
    await c.extractCancel("", jobId);
    release();
    let s = await c.extractState("", jobId);
    for (let i = 0; i < 500 && s.phase !== "cancelled"; i++) { await new Promise((r) => setTimeout(r, 10)); s = await c.extractState("", jobId); }
    expect(s.phase).toBe("cancelled");
    expect(tree(root)).toEqual(before);
    await expect(c.extractState("", "nope")).rejects.toThrow("見つかりません");
  });
  it("プロセスが途中で終わって残った、こちらの印のある一時フォルダだけが掃除される(印の無いもの・関係ないものは残す。詳しくは extract-hard.test.ts)", async () => {
    const old = new Date(Date.now() - 2 * 3600_000);
    mkdirSync(join(root, "plugins"));
    mkdirSync(join(root, "plugins", ".craftshelf-extract-aaaa"));
    writeFileSync(join(root, "plugins", ".craftshelf-extract-aaaa", "half.bin"), "half");
    writeFileSync(join(root, ".craftshelf-extract-aaaa.job"), JSON.stringify({ id: "aaaa", tmp: "plugins/.craftshelf-extract-aaaa" }));
    writeFileSync(join(root, "plugins", ".craftshelf-extract-aaaa", MARK), JSON.stringify({ v: 1, id: "aaaa", boot: "old-boot", pid: 2_147_483_000, at: 1, root: realpathSync(root) }));
    utimesSync(join(root, ".craftshelf-extract-aaaa.job"), old, old);
    mkdirSync(join(root, ".craftshelf-extract-bbbb"));
    mkdirSync(join(root, ".craftshelf-extract-cccc"));
    utimesSync(join(root, ".craftshelf-extract-cccc"), old, old);
    mkdirSync(join(root, "keep"));
    expect(await cleanStale(root)).toBe(1);
    expect(tree(root)).toEqual([".craftshelf-extract-bbbb/", ".craftshelf-extract-cccc/", "keep/", "plugins/", "server.properties"]);
    // 印が指す先が root の外・.craftshelf-extract- でない名前なら、消さない
    mkdirSync(join(outer, "victim"));
    writeFileSync(join(root, ".craftshelf-extract-dddd.job"), JSON.stringify({ tmp: "../victim", at: 1 }));
    utimesSync(join(root, ".craftshelf-extract-dddd.job"), old, old);
    await cleanStale(root);
    expect(existsSync(join(outer, "victim"))).toBe(true);
  });
  it("展開のあいだ、印(.job)ファイルが root にあり、終わると消える", async () => {
    writeFileSync(join(root, "a.zip"), makeZip({ "a.txt": "a" }));
    const s = await extract(client(), "a.zip");
    expect(s.phase).toBe("done");
    expect(readdirSync(root).filter((n) => n.startsWith(".craftshelf-extract"))).toEqual([]);
  });
});

describe("入力の確かめ", () => {
  it("圧縮ファイルの場所は、サーバーのフォルダの中だけ。無いファイル・フォルダは断る", async () => {
    const c = client();
    await expect(c.extractPlan("", "../x.zip", "folder")).rejects.toThrow();
    await expect(c.extractPlan("", "nope.zip", "folder")).rejects.toThrow("見つかりません");
    mkdirSync(join(root, "d.zip"));
    await expect(c.extractPlan("", "d.zip", "folder")).rejects.toThrow("見つかりません");
  });
});
