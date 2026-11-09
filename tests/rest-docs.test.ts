// API の説明(画面の /api-docs と GET /api/v1)は src/server/rest.ts のルートの定義から作る。説明・範囲の無いものは失敗にする(v02 の test_structure と同じ考え)
import { describe, expect, it } from "vitest";
import { TOKEN_SCOPES } from "~/lib/permissions";
import { ROUTES, routeDocs } from "~/server/rest";

describe("API の説明", () => {
  it("どのルートにも、ひとことの説明と要る範囲がある。同じメソッド・パスは 2 つない", () => {
    for (const r of ROUTES) {
      expect(r.summary.trim().length, `${r.method} ${r.path}`).toBeGreaterThan(3);
      expect(TOKEN_SCOPES).toContain(r.scope);
    }
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("説明の一覧は /api/v1 を付けたパスと、範囲の名前・役割を持つ", () => {
    const d = routeDocs();
    expect(d.length).toBe(ROUTES.length);
    expect(d.find((x) => x.path === "/api/v1/servers/:id/power")).toMatchObject({ method: "POST", scope: "control", role: "editor", example: { signal: "restart" } });
  });
});

describe("API の説明の英語表示", () => {
  it("説明・範囲の名前は、日本語を残さずに訳せる", async () => {
    const { translate } = await import("~/lib/i18n");
    const { SCOPE_LABELS, SCOPE_SHORT } = await import("~/lib/permissions");
    const left = [...ROUTES.map((r) => r.summary), ...Object.values(SCOPE_LABELS), ...Object.values(SCOPE_SHORT)]
      .filter((s) => /[぀-ヿ㐀-鿿]/.test(translate(s)));
    expect(left).toEqual([]);
  });
});
