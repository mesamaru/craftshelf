// 展開の断る理由・エラー(サーバーが日本語で返す)が、英語表示で日本語を残さずに訳されること
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTRACT_LIMITS, type Limits } from "~/server/extract-safe";
import { localClient } from "~/server/local";
import { loadEnglish, translate } from "~/lib/i18n";
import { entry, hdr, makeTar, paxEntry, tarOf } from "./tar";
import { makeZip, makeZipEx } from "./zip";

beforeAll(() => loadEnglish());
const JA = /[぀-ヿ㐀-鿿]/;
const GiB = 1024 ** 3;
const control = { control: "none", startCmd: "", stopCmd: "", container: "", rconPort: null, rconPassword: "" };

describe("展開の理由・エラーの英訳", () => {
  it("事前の確かめの理由と、展開中のエラーに、日本語が残らない", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-i18n-")));
    writeFileSync(join(root, "server.properties"), "level-name=world\n");
    mkdirSync(join(root, "world"));
    mkdirSync(join(root, "logs"));
    const write = (n: string, b: Uint8Array | string) => writeFileSync(join(root, n), b);
    const fs = (free: number | null) => async () => (free === null ? null : { free, total: 100 * GiB, block: 4096 });
    const mk = (limits?: Partial<Limits>, free: number | null = 500 * GiB) => localClient(root, null as never, control, { statfs: fs(free), limits });
    const many: Record<string, string> = {};
    for (let i = 0; i <= EXTRACT_LIMITS.files; i++) many[`f${i}`] = "";
    type Case = [string, Uint8Array | string, "folder" | "here", Partial<Limits>?, (number | null)?];
    const cases: Case[] = [
      ["a1.zip", makeZip({ "../x": "1", "/etc/p": "1", "C:\\y": "1", "a\\b": "1", "a/../b": "1", "a\0b": "1", "CON.txt": "1", "e.": "1", "x:y": "1", "a//b": "1", "a/./b": "1", ["y".repeat(300)]: "1", [".craftshelf-x/y"]: "1", ["d/".repeat(600) + "f"]: "1" }), "folder"],
      ["a2.zip", makeZipEx([{ name: "a", data: "1" }, { name: "a", data: "2" }, { name: "B", data: "3" }, { name: "b", data: "4" }, { name: "é", data: "5" }, { name: "é", data: "6" }, { name: "f", data: "7" }, { name: "f/g", data: "8" }, { name: "dir/", data: "x" }]), "folder"],
      ["a3.zip", makeZipEx([{ name: "l", data: "x", mode: 0o120777 }, { name: "e", data: "x", flags: 0x801 }]), "folder"],
      ["a4.zip", makeZip({ [Array.from({ length: 40 }, (_, i) => `d${i}`).join("/") + "/f"]: "x" }), "folder"],
      ["a5.zip", makeZip({ a: "x".repeat(3000) }, false), "folder", { fileBytes: 1000, totalBytes: 2000 }],
      ["a6.zip", makeZip(many), "folder"],
      ["a7.zip", Buffer.from("junk"), "folder"],
      ["a8.zip", makeZip({}), "folder"],
      ["a9.zip", makeZip({ z: Buffer.alloc(3 * 1024 * 1024) }), "folder", { ratioFloor: 1024 }],
      ["b1.zip", makeZip({ "world/x": "1" }), "here"],
      ["b2.zip", makeZip({ "x.txt": "1" }), "folder", undefined, 1 * GiB],
      ["b3.zip", makeZip({ "x.txt": "1" }), "folder", undefined, null],
      ["c1.tar", makeTar([{ name: "l", type: "2", linkname: "x" }, { name: "w", type: "x" }, { name: "c", badSum: true }]), "folder"],
      ["c2.tar", makeTar([{ name: "a", data: "x".repeat(5000) }]).subarray(0, 1024), "folder"],
      ["c3.tar.gz", Buffer.from("not gzip"), "folder"],
      ["d1.7z", "x", "folder"],
      ["d2.dat.rar", "x", "folder"],
      ["e1.zip", makeZip({ "a.txt": "1" }), "here"],
      ["f1.tar", tarOf(paxEntry({ size: "abc" }), entry(hdr({ name: "x", size: 1 }), "x")), "folder"],
      ["f2.tar", tarOf(paxEntry({ "GNU.sparse.major": "1" }), entry(hdr({ name: "x", size: 1 }), "x")), "folder"],
      ["f3.tar", tarOf(paxEntry({ path: "../x" }, "g"), entry(hdr({ name: "x", size: 1 }), "x")), "folder"],
      ["f4.tar", tarOf(entry(hdr({ name: "d/", type: "5", size: 100_000 }), Buffer.alloc(100_000))), "folder"],
      ["f5.zip", makeZip({ "LONGFI~1.TXT": "1", "a\u202eb": "2", "COM\u00b9": "3" }), "folder"],
    ];
    write("a.txt", "exists");
    write("e1.zip", makeZip({ "a.txt": "1" }));
    mkdirSync(join(root, "world", "sub"), { recursive: true });
    write("world/w.zip", makeZip({ "a.txt": "1" }));
    const left: string[] = [];
    const seen: string[] = [];
    const check = (s: string) => { seen.push(s); const t = translate(s); if (JA.test(t.replace(/[「」、。・〜！？：（）]/g, ""))) left.push(`${s} => ${t}`); };
    for (const [name, data, mode, limits, free] of cases) {
      write(name, data);
      const c = mk(limits, free === undefined ? 500 * GiB : free);
      const plan = await c.extractPlan("", name, mode);
      plan.reasons.forEach(check);
      const { jobId } = await c.extractStart("", name, mode);
      let s = await c.extractState("", jobId);
      for (let i = 0; i < 300 && !["done", "failed", "cancelled"].includes(s.phase); i++) { await new Promise((r) => setTimeout(r, 10)); s = await c.extractState("", jobId); }
      if (s.error) check(s.error);
    }
    const w = await mk().extractPlan("", "world/w.zip", "here");
    w.reasons.forEach(check);
    for (const m of ["展開できません。", "展開中の失敗"]) void m;
    expect(seen.length).toBeGreaterThan(25);
    expect(left).toEqual([]);
  });
});
