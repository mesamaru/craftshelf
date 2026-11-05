// ファイル比較の行の並べ方
import { describe, expect, it } from "vitest";
import { alignAll, splitLines } from "~/lib/diff";

describe("行の差分", () => {
  it("基準にそろえて、違う行・無い行・こちらだけの行を並べる", () => {
    const base = splitLines("a=1\nb=2\nc=3\n");
    const one = splitLines("a=1\r\nb=5\r\nc=3\r\nd=4\r\n"); // 改行コードの違いは見ない
    const two = splitLines("a=1\nc=3\n");
    const rows = alignAll(base, [one, two]);
    const kinds = rows.map((r) => [r.base, ...r.cells.map((c) => c.kind)]);
    expect(kinds).toEqual([
      [0, "same", "same"],
      [1, "chg", "miss"],
      [2, "same", "same"],
      [null, "extra", "gap"],
    ]);
    expect(rows.map((r) => r.diff)).toEqual([false, true, false, true]);
    expect(rows[1].cells[0].i).toBe(1);
    expect(rows[3].cells[0].i).toBe(3);
  });

  it("同じ中身なら違いは無い。空のファイルも扱える", () => {
    expect(alignAll(["x"], [["x"]]).every((r) => !r.diff)).toBe(true);
    expect(alignAll([], [["y"]])).toEqual([{ base: null, cells: [{ i: 0, kind: "extra" }], diff: true }]);
  });
});
