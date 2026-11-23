// 前提の版の範囲(Fabric・Quilt・Maven)を、入っている版が満たすか
import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, satisfies } from "~/server/dep-range";

const cmp = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!);
const fabric = (v: string, ...any: string[]) => satisfies(v, { style: "fabric", any });
const quilt = (v: string, ...any: string[]) => satisfies(v, { style: "quilt", any });
const maven = (v: string, r: string) => satisfies(v, { style: "maven", any: [r] });

describe("版を比べる", () => {
  it.each([
    ["1.21.1", "1.21", 1], ["1.21", "1.21.0", 0], ["1.9", "1.10", -1], ["0.100.0", "0.92.6", 1],
    ["1.0.0-beta.2", "1.0.0", -1], ["1.0.0-beta.2", "1.0.0-beta.10", -1], ["1.0.0-alpha", "1.0.0-beta", -1], ["1.0.0-beta", "1.0.0-beta.1", -1],
    ["1.0.0-rc.1", "1.0.0-beta.9", 1], ["1.0.0-1", "1.0.0-alpha", 1],
    ["0.92.2+1.20.1", "0.92.2", 0], ["0.92.2+1.20.1", "0.92.2+1.21", 0], ["v2.0", "2.0", 0],
    ["1.20.1-47.2.0", "1.20.1", 1], ["1.20.1-47.2.0", "1.20.1-47.10.0", -1], ["1.20.1-0.5.0-beta", "1.20.1-0.5.0", -1],
    ["1.0-SNAPSHOT", "1.0", -1],
  ])("%s と %s → %i", (a, b, want) => expect(cmp(a, b)).toBe(want));

  it("読めない版は null", () => {
    for (const s of ["", "abc", "${version}", "24w14a", "1..2", "1.0.0-", "mc1.20.1-1.0"]) expect(parseVersion(s)).toBeNull();
  });
});

describe("Fabric の範囲", () => {
  it.each([
    ["0.5.0", "*", true], ["0.5.0", ">=0.5", true], ["0.4.9", ">=0.5", false], ["0.5.0", ">0.5", false], ["0.5.1", ">0.5", true],
    ["2.0", "<2.0", false], ["1.99", "<2.0", true], ["2.0", "<=2.0", true], ["2.0.1", "<=2.0", false],
    ["1.0.0", "=1.0.0", true], ["1.0.1", "=1.0.0", false], ["1.0.0", "1.0.0", true], ["1.0.1", "1.0.0", false],
    ["1.21.4", "~1.21", true], ["1.22", "~1.21", false], ["1.20.9", "~1.21", false], ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.9", "~1", true], ["2.0", "~1", false],
    ["1.9.9", "^1.0", true], ["2.0.0", "^1.0", false], ["0.9", "^1.0", false],
    ["1.20.4", "1.20.x", true], ["1.20", "1.20.x", true], ["1.21", "1.20.x", false], ["1.20.6", "1.20.*", true], ["1.5", "1.x", true], ["2.0", "1.x", false], ["1.20.1", "=1.20.x", true],
    ["1.5", ">=1.0 <2.0", true], ["2.0", ">=1.0 <2.0", false], ["0.9", ">=1.0 <2.0", false], ["1.5", ">= 1.0 < 2.0", true],
    ["0.92.2+1.20.1", ">=0.92.0", true], ["0.15.0-beta.2", ">=0.15", false], ["0.15.0-beta.2", ">=0.15.0-beta.1", true],
  ])("%s は %s を満たす: %s", (v, r, want) => expect(fabric(v, r)).toBe(want));

  it("並び(配列)はどれかを満たせばよい", () => {
    expect(fabric("1.20.1", "1.19.x", "1.20.x")).toBe(true);
    expect(fabric("1.21", "1.19.x", "1.20.x")).toBe(false);
    expect(fabric("1.5", ">=1", "<3")).toBe(true);
  });

  it("読めない版・範囲は満たすとみなす(誤って出さない)", () => {
    expect(fabric("${version}", ">=99")).toBe(true);
    expect(fabric("", ">=99")).toBe(true);
    expect(fabric("1.0", ">=abc")).toBe(true);
    expect(fabric("1.0", ">=2.x")).toBe(true); // 演算子つきの x は読まない
    expect(fabric("1.0", ">=2 || <0.5")).toBe(true);
    expect(fabric("1.0", ">=2", "???")).toBe(true); // どれか 1 つでも読めなければ
    expect(fabric("1.0")).toBe(true); // 範囲が空
  });

  it("Quilt は版だけなら「その版以上」", () => {
    expect(quilt("1.2", "1.0")).toBe(true);
    expect(quilt("0.9", "1.0")).toBe(false);
    expect(quilt("1.2", "=1.0")).toBe(false);
    expect(quilt("1.0.5", "1.0.x")).toBe(true);
  });
});

describe("Maven の範囲(Forge・NeoForge)", () => {
  it.each([
    ["1.5", "[1.0,2.0)", true], ["2.0", "[1.0,2.0)", false], ["1.0", "[1.0,2.0)", true], ["1.0", "(1.0,2.0)", false], ["2.0", "[1.0,2.0]", true],
    ["99", "[1.0,)", true], ["0.9", "[1.0,)", false], ["2.0", "(,2.0]", true], ["2.0.1", "(,2.0]", false], ["0.1", "(,2.0)", true],
    ["1.20.1", "[1.20.1]", true], ["1.20.2", "[1.20.1]", false],
    ["4.4.9", "4.4", true], ["4.3", "4.4", false], ["47.2.0", "[47,)", true], ["46.9", "[47,)", false],
    ["0.5", "[1.0,2.0),[3.0,)", false], ["3.5", "[1.0,2.0),[3.0,)", true], ["1.5", "[1.0,2.0), [3.0,)", true],
    ["1.20.1-47.2.0", "[1.20.1-47.1.0,)", true], ["1.20.1-47.0.0", "[1.20.1-47.1.0,)", false],
    ["1.0-SNAPSHOT", "[1.0,)", false], ["4.4.9+1.20.1", "[4.4,)", true],
    ["1.0", "*", true], ["1.0", "", true],
  ])("%s は %s を満たす: %s", (v, r, want) => expect(maven(v, r)).toBe(want));

  it("読めない範囲は満たすとみなす", () => {
    for (const r of ["[1.0", "(1.0)", "[a,b)", "[1,2,3]", "[1.0,2.0) junk", "${range}"]) expect(maven("0.1", r)).toBe(true);
  });
});
