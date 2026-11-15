// Pterodactyl への問い合わせの覚え: 同じ読みはまとめる・書いたら捨てる・fresh は読み直す・429 は 1 回だけ待ってやり直す
import { describe, expect, it, vi } from "vitest";
import { READ_TTL, forgetPteroReadsFor, pteroClient } from "../src/server/ptero";
import type { FetchLike } from "../src/server/net";

function fake() {
  const calls: string[] = [];
  let busy = 0;
  let peak = 0;
  let limited = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    busy++;
    peak = Math.max(peak, busy);
    await new Promise((r) => setTimeout(r, 5));
    busy--;
    if (limited > 0) { limited--; return new Response("", { status: 429, headers: { "retry-after": "1" } }); }
    if (u.pathname.endsWith("/files/list")) return Response.json({ data: [{ attributes: { name: "a.jar", is_file: true, size: 1 } }] });
    if (u.pathname.endsWith("/files/contents")) return new Response("level-name=world\n");
    return new Response(null, { status: 204 });
  }) as unknown as FetchLike;
  return { fetch, calls, peak: () => peak, limit: (n: number) => { limited = n; } };
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

  it("429 は読むときだけ 1 回待ってやり直す", async () => {
    const f = fake();
    const c = pteroClient("https://memo4.example", "ptlc_aaaaaaaaaaaa", f.fetch);
    f.limit(1);
    expect((await c.listFiles("abcd1234", "x"))[0].name).toBe("a.jar");
    expect(n(f.calls, "files/list")).toBe(2);
    f.limit(1);
    await expect(c.writeFile("abcd1234", "a.txt", "x")).rejects.toThrow(/多すぎます/);
  }, 10_000);
});
