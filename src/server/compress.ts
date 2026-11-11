// 動的な応答(server function の JSON・API)の gzip 圧縮。静的ファイル(JS・CSS)は、ビルドのときに gzip・brotli にして配る(vite.config.ts の compressPublicAssets)。
// 圧縮しないもの: 1 KB 未満 / すでに Content-Encoding があるもの(リバースプロキシが圧縮している・事前に圧縮した静的ファイル。二重にしない) /
// 圧縮に向かない種類(画像・zip・tar.gz・jar など。JSON・テキスト・XML・SVG だけ圧縮する。ストリームで描く HTML と SSE も外す) /
// ダウンロード(Content-Disposition)・Range の要求・206・HEAD・本文の無い応答(Content-Length・Range を壊さない)
const MIN = 1024;
const COMPRESSIBLE = /^(application\/(json|[\w.+-]+\+json|javascript|xml)|text\/(plain|css|javascript|xml|csv|markdown)|image\/svg\+xml)\s*(;|$)/i;

/** Accept-Encoding が gzip を受け取れるか(q=0 は断っている) */
const acceptsGzip = (v: string | null) => !!v && v.split(",").some((p) => {
  const [name, ...params] = p.trim().split(";");
  return name.trim().toLowerCase() === "gzip" && !params.some((x) => /^\s*q\s*=\s*0(\.0*)?\s*$/i.test(x));
});

export async function gzipResponse(req: Request, res: Response): Promise<Response> {
  const h = res.headers;
  if (!res.body || req.method === "HEAD" || req.headers.has("range") || res.status < 200 || [204, 205, 206, 304].includes(res.status)) return res;
  if (h.has("content-encoding") || h.has("content-range") || h.has("content-disposition") || /no-transform/i.test(h.get("cache-control") ?? "")) return res;
  if (!COMPRESSIBLE.test(h.get("content-type") ?? "") || !acceptsGzip(req.headers.get("accept-encoding"))) return res;
  if (h.has("content-length") && Number(h.get("content-length")) < MIN) return res;

  // 長さが分からないものは、1 KB に届くまで読んでから決める(届かなければそのまま返す)
  const reader = res.body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < MIN && !done) {
    const r = await reader.read();
    if (r.done) done = true;
    else { head.push(r.value); size += r.value.byteLength; }
  }
  if (done && size < MIN) return new Response(Buffer.concat(head), { status: res.status, statusText: res.statusText, headers: h });
  const source = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of head) c.enqueue(ch); if (done) c.close(); },
    async pull(c) {
      if (done) return;
      const r = await reader.read();
      if (r.done) c.close(); else c.enqueue(r.value);
    },
    cancel: (why) => reader.cancel(why),
  });
  const headers = new Headers(h);
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  headers.append("vary", "Accept-Encoding");
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`); // 中身のバイト列が変わるので弱い ETag にする
  return new Response(source.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), { status: res.status, statusText: res.statusText, headers });
}
