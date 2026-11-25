import { describe, expect, it } from "vitest";
import { csp, securityHeaders } from "../src/server/security";

describe("セキュリティヘッダー", () => {
  it("足りないものを足し、API はキャッシュさせない", () => {
    const r = securityHeaders(new Request("http://x/api/health"), new Response("ok"));
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
  it("ページに付けた nonce 入りの CSP・決めたキャッシュは変えない", () => {
    const res = new Response("<p>", { headers: { "Content-Security-Policy": csp("abc"), "Cache-Control": "private" } });
    const r = securityHeaders(new Request("http://x/api/me/background"), res);
    expect(r.headers.get("content-security-policy")).toContain("'nonce-abc'");
    expect(r.headers.get("cache-control")).toBe("private");
    expect(securityHeaders(new Request("http://x/"), new Response("")).headers.get("cache-control")).toBeNull();
  });
  it("ヘッダーを変えられない応答は写して付ける", () => {
    const r = securityHeaders(new Request("http://x/login"), Response.redirect("http://x/", 302));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://x/");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });
});
