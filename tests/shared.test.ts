// 画面で同じ問い合わせをまとめる仕組み(src/lib/shared.ts)。ブラウザの中だけで覚える・書き込みで捨てる
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
const realFetch = g.fetch;
let calls: string[];
let mod: typeof import("~/lib/shared");

beforeEach(async () => {
  vi.resetModules(); // fetch を包むのは 1 度だけなので、毎回読み直す
  calls = [];
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response("{}");
  }) as typeof fetch;
  g.window = globalThis;
  mod = await import("~/lib/shared");
});
afterEach(() => {
  g.fetch = realFetch;
  delete g.window;
  vi.useRealTimers();
});

describe("shared", () => {
  it("同時の呼び出しも、ttl のあいだの呼び出しも 1 回にまとめる。ttl を過ぎたら取り直す", async () => {
    vi.useFakeTimers();
    let n = 0;
    const load = async () => ++n;
    const [a, b] = await Promise.all([mod.shared("k", load, 3000), mod.shared("k", load, 3000)]);
    expect([a, b, n]).toEqual([1, 1, 1]);
    vi.advanceTimersByTime(2999);
    expect(await mod.shared("k", load, 3000)).toBe(1);
    vi.advanceTimersByTime(2);
    expect(await mod.shared("k", load, 3000)).toBe(2);
    // 呼ぶ側が、どれだけ古い結果まで受け入れるかを決める
    vi.advanceTimersByTime(20_000);
    expect(await mod.shared("k", load, 50_000)).toBe(2);
    expect(await mod.shared("k", load, 10_000)).toBe(3);
  });

  it("キーが違えば別。失敗は覚えない", async () => {
    let n = 0;
    expect(await mod.shared("a", async () => ++n)).toBe(1);
    expect(await mod.shared("b", async () => ++n)).toBe(2);
    await expect(mod.shared("c", async () => { throw new Error("だめ"); })).rejects.toThrow("だめ");
    expect(await mod.shared("c", async () => "取り直した")).toBe("取り直した");
  });

  it("GET 以外の通信があったら、覚えたものをすべて捨てる(GET は捨てない)", async () => {
    let n = 0;
    const load = async () => ++n;
    expect(await mod.shared("k", load)).toBe(1);
    await fetch("/api/x");
    expect(await mod.shared("k", load)).toBe(1);
    await fetch("/_serverFn/x", { method: "POST", body: "{}" });
    expect(await mod.shared("k", load)).toBe(2);
    expect(calls).toEqual(["GET /api/x", "POST /_serverFn/x"]);
    // 書き込みの最中に始まった読み込みも、書き込みが終わったら捨てる
    const post = fetch("/_serverFn/y", { method: "POST" });
    expect(await mod.shared("k", load)).toBe(3);
    await post;
    expect(await mod.shared("k", load)).toBe(4);
  });

  it("forgetShared は prefix で捨てる。ブラウザでなければ(サーバーでの描画)覚えない = 利用者をまたがない", async () => {
    let n = 0;
    const load = async () => ++n;
    await mod.shared("status:1", load);
    await mod.shared("servers", load);
    mod.forgetShared("status:");
    expect(await mod.shared("status:1", load)).toBe(3);
    expect(await mod.shared("servers", load)).toBe(2);
    delete g.window;
    expect(await mod.shared("servers", load)).toBe(4);
    expect(await mod.shared("servers", load)).toBe(5);
  });
});
