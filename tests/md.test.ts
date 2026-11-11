// ホームのメモ(Markdown)。先にエスケープするので、スクリプトは入らない
import { describe, expect, it } from "vitest";
import { mdToHtml } from "~/lib/md";

describe("メモの Markdown", () => {
  it("見出し・太字・リスト・チェック・リンクを HTML にする", () => {
    const h = mdToHtml("# 題\n\n**太字** と *斜体*\n\n- a\n- [x] b\n\n1. 一\n2. 二\n\n[リンク](https://example.com/a?b=1&c=2)");
    expect(h).toContain("<h3>題</h3>");
    expect(h).toContain("<b>太字</b>");
    expect(h).toContain("<i>斜体</i>");
    expect(h).toContain("<li>a</li>");
    expect(h).toContain("<li>☑ b</li>");
    expect(h).toContain("<ol><li>一</li><li>二</li></ol>");
    expect(h).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">リンク</a>');
  });

  it("HTML・スクリプト・http でないリンクは文字として出す", () => {
    const h = mdToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n[y](https://a.example/"onclick="x)');
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain('href="javascript');
    expect(h).not.toMatch(/href="[^"]*"[^>]*onclick/);
  });

  it("コードのかたまりの中は変換しない", () => {
    expect(mdToHtml("```\n**x**\n```")).toBe("<pre><code>**x**</code></pre>");
  });
});
