// 版の読み方と比べ方(旧 03.xx.xx と新 0.xx.xx。03.99.03 から)
import { describe, expect, it } from "vitest";
import { compareVersion, generationOf, isV03OrLater, isVersion, newerVersion, versionKey } from "~/lib/version";

describe("版の形", () => {
  it("旧 03.xx.xx と新 0.xx.xx を受け付け、ほかは断る", () => {
    for (const v of ["03.99.02", "02.26.00", "0.04.00", "1.00.00"]) expect(isVersion(v)).toBe(true);
    for (const v of ["", "03.99", "0.4.0", "0.04.00.1", "00.04", "v0.04.00", "10.04.00x"]) expect(isVersion(v)).toBe(false);
    expect(versionKey("03.99.02")).toEqual([0, 3, 99, 2]);
    expect(versionKey("0.04.01")).toEqual([0, 4, 1, 0]);
  });

  it("0.04.00 は 03.99.xx の次。文字の並びではなく、大型・メジャー・マイナーの数で比べる", () => {
    expect(compareVersion("0.04.00", "03.99.02")).toBeGreaterThan(0);
    expect(compareVersion("0.04.00", "03.99.99")).toBeGreaterThan(0);
    expect(compareVersion("03.99.03", "03.99.02")).toBeGreaterThan(0);
    expect(compareVersion("0.04.01", "0.04.00")).toBeGreaterThan(0);
    expect(compareVersion("0.10.00", "0.09.99")).toBeGreaterThan(0);
    expect(compareVersion("1.00.00", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersion("03.60.00", "0.04.00")).toBeLessThan(0);
    expect(compareVersion("0.04.00", "0.04.00")).toBe(0);
    expect(["03.62.00", "0.04.00", "03.99.03", "0.05.01"].sort((a, b) => compareVersion(b, a))).toEqual(["0.05.01", "0.04.00", "03.99.03", "03.62.00"]);
  });

  it("形の違うものは、どの版よりも古い", () => {
    expect(compareVersion("", "03.60.00")).toBeLessThan(0);
    expect(compareVersion("03.60.00", "x")).toBeGreaterThan(0);
    expect(newerVersion("03.60.00", "")).toBe("03.60.00");
    expect(newerVersion("03.60.00", "0.04.00")).toBe("0.04.00");
  });

  it("大型(世代)と、v03 以降か", () => {
    expect(generationOf("03.99.02")).toBe(0);
    expect(generationOf("0.04.00")).toBe(0);
    expect(generationOf("1.00.00")).toBe(1);
    expect(isV03OrLater("03.00.00")).toBe(true);
    expect(isV03OrLater("0.04.00")).toBe(true);
    expect(isV03OrLater("02.26.00")).toBe(false);
    expect(isV03OrLater("")).toBe(false);
  });
});
