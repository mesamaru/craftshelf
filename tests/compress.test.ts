// 動的な応答(server function の JSON・API)の gzip 圧縮(src/server/compress.ts)。
// 圧縮しないもの: 1 KB 未満・すでに圧縮されているもの(Content-Encoding・画像・zip・tar.gz)・ダウンロード(Content-Disposition)・Range・ストリーム(SSE)・HTML
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gzipResponse } from "~/server/compress";

const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `アイテム ${i}`, note: "x".repeat(20) })) });
const req = (headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br" }, method = "GET") => new Request("http://localhost/x", { method, headers });
const json = (body = big, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } });
const text = async (res: Response) => (res.headers.get("content-encoding") === "gzip" ? gunzipSync(Buffer.from(await res.arrayBuffer())).toString() : await res.text());

describe("gzip 圧縮", () => {
  it("1 KB 以上の JSON を gzip にする(中身は同じ。Content-Length は外し、Vary を付ける。Set-Cookie・ステータスはそのまま)", async () => {
    const res = json(big, { status: 201, headers: { "content-length": String(Buffer.byteLength(big)), etag: '"abc"' } });
    res.headers.append("set-cookie", "a=1; Path=/");
    res.headers.append("set-cookie", "b=2; Path=/");
    const out = await gzipResponse(req(), res);
    expect(out.status).toBe(201);
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("vary")).toMatch(/Accept-Encoding/i);
    expect(out.headers.get("etag")).toBe('W/"abc"');
    expect(out.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const raw = Buffer.from(await out.clone().arrayBuffer());
    expect(raw.length).toBeLessThan(Buffer.byteLength(big) / 2);
    expect(await text(out)).toBe(big);
  });

  it("長さが分からないもの(ストリームかもしれない)も、1 KB を超えたら圧縮する。超えなければそのまま", async () => {
    const chunks = [big.slice(0, 600), big.slice(600, 1500), big.slice(1500)];
    const stream = () => new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
    const out = await gzipResponse(req(), new Response(stream(), { headers: { "content-type": "application/json; charset=utf-8" } }));
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(await text(out)).toBe(big);
    const tiny = new ReadableStream<Uint8Array>({ start(c) { for (const x of ["a".repeat(10), "b".repeat(10), "c".repeat(10)]) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
    const small = await gzipResponse(req(), new Response(tiny, { headers: { "content-type": "application/json" } }));
    expect(small.headers.get("content-encoding")).toBeNull();
    expect((await small.text()).length).toBe(30);
  });

  it("1 KB 未満・Accept-Encoding が無い・gzip を断っている(q=0)ものは、圧縮しない", async () => {
    const tiny = await gzipResponse(req(), json(JSON.stringify({ ok: true })));
    expect(tiny.headers.get("content-encoding")).toBeNull();
    expect(await tiny.text()).toBe('{"ok":true}');
    const known = await gzipResponse(req(), json("x".repeat(500), { headers: { "content-length": "500" } }));
    expect(known.headers.get("content-encoding")).toBeNull();
    for (const h of [{} as Record<string, string>, { "accept-encoding": "identity" }, { "accept-encoding": "br" }, { "accept-encoding": "gzip;q=0, br" }]) {
      const out = await gzipResponse(req(h), json());
      expect(out.headers.get("content-encoding")).toBeNull();
      expect(await out.text()).toBe(big);
    }
    expect((await gzipResponse(req({ "accept-encoding": "br, gzip;q=0.5" }), json())).headers.get("content-encoding")).toBe("gzip");
  });

  it("すでに Content-Encoding が付いているもの(リバースプロキシ・事前に圧縮した静的ファイル)は二重にしない", async () => {
    const res = json(big, { headers: { "content-encoding": "br" } });
    expect(await gzipResponse(req(), res)).toBe(res);
  });

  it("ダウンロード(Content-Disposition)・画像・zip・tar.gz・Range・HEAD・304 は、圧縮せず Content-Length もそのまま", async () => {
    const body = "z".repeat(5000);
    const cases: [string, Response, Request][] = [
      ["ダウンロード", new Response(body, { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="a.json"', "content-length": "5000" } }), req()],
      ["jar", new Response(body, { headers: { "content-type": "application/java-archive", "content-length": "5000" } }), req()],
      ["zip", new Response(body, { headers: { "content-type": "application/zip", "content-length": "5000" } }), req()],
      ["tar.gz", new Response(body, { headers: { "content-type": "application/gzip", "content-length": "5000" } }), req()],
      ["画像", new Response(body, { headers: { "content-type": "image/png", "content-length": "5000" } }), req()],
      ["Range の要求", json(body, { headers: { "content-length": "5000" } }), req({ "accept-encoding": "gzip", range: "bytes=0-99" })],
      ["206", new Response(body, { status: 206, headers: { "content-type": "application/json", "content-range": "bytes 0-4999/9999", "content-length": "5000" } }), req()],
      ["HEAD", json(body, { headers: { "content-length": "5000" } }), req({ "accept-encoding": "gzip" }, "HEAD")],
      ["no-transform", json(body, { headers: { "cache-control": "no-transform", "content-length": "5000" } }), req()],
    ];
    for (const [name, res, r] of cases) {
      const out = await gzipResponse(r, res);
      expect(out, name).toBe(res);
      expect(out.headers.get("content-encoding"), name).toBeNull();
    }
    expect(res304().status).toBe(304);
    expect(await gzipResponse(req(), res304())).toMatchObject({ status: 304 });
    expect((await gzipResponse(req(), res304())).headers.get("content-encoding")).toBeNull();
  });

  it("SSE・HTML(ストリームで描く)は圧縮しない。流れは止まらない(最初の塊がすぐ届く)", async () => {
    let push!: (s: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); close = () => c.close(); } });
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out = await gzipResponse(req(), res);
    expect(out).toBe(res);
    push("data: 1\n\n");
    const reader = out.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    close();
    const html = new Response(big, { headers: { "content-type": "text/html; charset=utf-8" } });
    expect(await gzipResponse(req(), html)).toBe(html);
  });
});

const res304 = () => new Response(null, { status: 304, headers: { "content-type": "application/json" } });
