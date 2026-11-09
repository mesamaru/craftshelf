// 1 分ごとの処理: どれかが返ってこなくても、ほかは毎回動く。同じ処理は前の回が終わるまで飛ばす
import { describe, expect, it } from "vitest";
import { minuteTasks } from "~/server/startup";

describe("1 分ごとの処理", () => {
  it("処理ごとに独立して動き、終わっていない処理だけを飛ばす", async () => {
    const runs = { stuck: 0, quick: 0, broken: 0 };
    let release = () => {};
    const tick = minuteTasks([
      ["止まる", () => { runs.stuck++; return new Promise<void>((r) => { release = r; }); }],
      ["すぐ終わる", async () => { runs.quick++; }],
      ["失敗する", async () => { runs.broken++; throw new Error("x"); }],
    ]);
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const err = console.error;
    console.error = () => {};
    try {
      tick();
      await flush();
      tick();
      await flush();
      expect(runs).toEqual({ stuck: 1, quick: 2, broken: 2 });
      release();
      await flush();
      tick();
      await flush();
      expect(runs).toEqual({ stuck: 2, quick: 3, broken: 3 });
    } finally {
      console.error = err;
    }
  });
});
