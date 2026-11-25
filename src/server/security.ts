// すべての応答に付けるセキュリティヘッダー(v02 の security_headers と同じ考え)。
// HTML のページは、ルーター(src/router.tsx)がリクエストごとの nonce を入れた CSP を付ける。ほかの応答には nonce なしの CSP を付ける

/** CSP。スクリプトは自分のものと nonce の付いたものだけ。画像は配布元のアイコン(https)も出す。
 * style の 'unsafe-inline' は、画面の style 属性(React の style={…})を描くため */
export const csp = (nonce?: string) => [
  "default-src 'self'",
  `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const BASE: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

/** 応答にヘッダーを足す(すでにあるものはそのまま)。API・server function の応答は、決めていなければキャッシュさせない */
export function securityHeaders(req: Request, res: Response): Response {
  const add: Record<string, string> = { ...BASE, "Content-Security-Policy": csp() };
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/_serverFn/")) add["Cache-Control"] = "no-store";
  const missing = Object.entries(add).filter(([k]) => !res.headers.has(k));
  if (!missing.length) return res;
  let out = res;
  try {
    for (const [k, v] of missing) out.headers.set(k, v);
  } catch { // fetch の応答・Response.redirect などはヘッダーを変えられない: 写して付ける
    out = new Response(res.body, res);
    for (const [k, v] of missing) out.headers.set(k, v);
  }
  return out;
}
