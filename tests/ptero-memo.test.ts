// Pterodactyl への問い合わせの覚え: 同じ読みはまとめる・書いたら捨てる・fresh は読み直す・429 は言われた時間だけ止めてやり直す・残りが少なければ見回りは覚えで済ませる
import { describe, expect, it, vi } from "vitest";
import { READ_TTL, forgetPteroReadsFor, pteroClient } from "../src/server/ptero";
import type { FetchLike } from "../src/server/net";

function fake() {
  const calls: string[] = [];
  let busy = 0;
  let peak = 0;
  let limited = 0;
  let wait = "1";
  let left = 700;
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    busy++;
    peak = Math.max(peak, busy);
    await new Promise((r) => setTimeout(r, 5));
    busy--;
    if (limited > 0) { limited--; return new Response("", { status: 429, headers: { "retry-after": wait } }); }
    const rl = { "x-ratelimit-limit": "720", "x-ratelimit-remaining": String(left) };
    if (u.pathname.endsWith("/resources")) return Response.json({ attributes: { current_state: "running", resources: {} } }, { headers: rl });
    if (u.pathname.endsWith("/files/list")) return Response.json({ data: [{ attributes: { name: "a.jar", is_file: true, size: 1 } }] });
    if (u.pathname.endsWith("/files/contents")) return new Response("level-name=world\n");
    return new Response(null, { status: 204 });
  }) as unknown as FetchLike;
  return { fetch, calls, peak: () => peak, limit: (n: number, w = "1") => { limited = n; wait = w; }, left: (n: number) => { left = n; } };
}
const n = (calls: string[], what: string) => calls.filter((c) => c.includes(what)).length;

describe("Pterodactyl への問い合わせの覚え", () => {
  it("同じ読みは 1 回にまとめ、書くと捨て、fresh は読み直す", async () => {
    const f = fake();
    const c = pteroClient("https://memo1.example", "ptlc_aaaaaaaaaaaa", f.fetch);
    const [a, b] = await Promise.all([c.listFiles("abcd1234", "plugins"), c.listFiles("abcd1234", "/plugins/")]);
    expect(n(f.calls, "files/list")).toBe(1);
    a[0].name = "changed"; // 呼ぶ側が変えても、覚えには響かない
    expect((await c.listFiles("abcd1234", "plugins"))[0].name).toBe("a.jar");
    expect(b[0].name).toBe("a.jar");
    expect(n(f.calls, "files/list")).toBe(1);

    await c.readFile("abcd1234", "server.properties");
    await c.readFile("abcd1234", "server.properties");
    expect(n(f.calls, "files/contents")).toBe(1);

    await c.writeFile("abcd1234", "server.properties", "x");
    await c.listFiles("abcd1234", "plugins");
    await c.readFile("abcd1234", "server.properties");
    expect(n(f.calls, "files/list")).toBe(2);
    expect(n(f.calls, "files/contents")).toBe(2);

    await c.readFile("abcd1234", "server.properties", true);
    expect(n(f.calls, "files/contents")).toBe(3);

    // 別のサーバー・別のキーは別に覚える
    await c.listFiles("efgh5678", "plugins");
    await pteroClient("https://memo1.example", "ptlc_bbbbbbbbbbbb", f.fetch).listFiles("abcd1234", "plugins");
    expect(n(f.calls, "files/list")).toBe(4);
  });

  it("覚えは時間がたつと読み直す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const f = fake();
      const c = pteroClient("https://memo2.example", "ptlc_aaaaaaaaaaaa", f.fetch);
      await c.listFiles("abcd1234", "/");
      vi.setSystemTime(Date.now() + READ_TTL.list - 1000);
      await c.listFiles("abcd1234", "/");
      expect(n(f.calls, "files/list")).toBe(1);
      vi.setSystemTime(Date.now() + 2000);
      await c.listFiles("abcd1234", "/");
      expect(n(f.calls, "files/list")).toBe(2);
      // 「読み直す」: そのパネルの覚えを捨てる
      forgetPteroReadsFor("https://memo2.example");
      await c.listFiles("abcd1234", "/");
      expect(n(f.calls, "files/list")).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同時の問い合わせはパネルごとに 6 つまで", async () => {
    const f = fake();
    const c = pteroClient("https://memo3.example", "ptlc_aaaaaaaaaaaa", f.fetch);
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.listFiles("abcd1234", `d${i}`)));
    expect(n(f.calls, "files/list")).toBe(20);
    expect(f.peak()).toBeLessThanOrEqual(6);
  });

  it("429 は言われた時間だけその種類を止めてやり直す(書き込みも。パネルが処理する前に断ったものなので)", async () => {
    const f = fake();
    const c = pteroClient("https://memo4.example", "ptlc_aaaaaaaaaaaa", f.fetch);
    f.limit(1);
    expect((await c.listFiles("abcd1234", "x"))[0].name).toBe("a.jar");
    expect(n(f.calls, "files/list")).toBe(2);
    f.limit(2);
    const t = Date.now();
    await c.writeFile("abcd1234", "a.txt", "x"); // 1 秒・1 秒待って 3 回目で通る
    expect(n(f.calls, "files/write")).toBe(3);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
    f.limit(1, "600"); // 長く待てと言われたら、待たずに理由を返す
    await expect(c.writeFile("abcd1234", "b.txt", "x")).rejects.toThrow(/600 秒ほど待って/);
  }, 15_000);

  it("回数の残りが少ないときは、サーバーの状態を前の結果で済ませる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const f = fake();
      const c = pteroClient("https://memo5.example", "ptlc_aaaaaaaaaaaa", f.fetch);
      await c.resources("abcd1234");
      vi.setSystemTime(Date.now() + READ_TTL.resources + 1);
      await c.resources("abcd1234"); // 残りが多いので読み直す
      expect(n(f.calls, "/resources")).toBe(2);
      f.left(10); // 次の応答で、残りが少ないと分かる
      vi.setSystemTime(Date.now() + READ_TTL.resources + 1);
      await c.resources("abcd1234");
      vi.setSystemTime(Date.now() + READ_TTL.resources + 1);
      await c.resources("abcd1234"); // 期限は切れたが、前の結果で済ませる
      expect(n(f.calls, "/resources")).toBe(3);
      await c.listFiles("abcd1234", "plugins"); // ファイル(利用者の操作)はいつもどおり読む
      expect(n(f.calls, "files/list")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("回数の上限が小さいパネル", () => {
  it("1 秒に 10 回までのパネルに 60 件の書き込みを一度に頼んでも、すべて通る(断られた分は待ってやり直す)", async () => {
    let start = Date.now();
    let used = 0;
    let done = 0;
    const fetch = (async () => {
      if (Date.now() - start >= 1000) { start = Date.now(); used = 0; }
      if (used >= 10) return new Response("", { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil((1000 - (Date.now() - start)) / 1000))) } });
      used++;
      done++;
      return new Response(null, { status: 204, headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": String(10 - used) } });
    }) as unknown as FetchLike;
    const c = pteroClient("https://memo6.example", "ptlc_aaaaaaaaaaaa", fetch);
    await Promise.all(Array.from({ length: 60 }, (_, i) => c.writeFile(`abcd${String(1000 + i)}`, "a.txt", "x")));
    expect(done).toBe(60);
  }, 20_000);
});
