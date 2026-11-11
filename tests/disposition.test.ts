// ダウンロードの Content-Disposition: 日本語・記号・改行の入った名前でも、ヘッダーが作れて、名前が戻せる
import { describe, expect, it } from "vitest";
import { attachment } from "~/lib/disposition";

describe("Content-Disposition", () => {
  it("日本語の名前でも Response のヘッダーにできる。filename*= で元の名前に戻る", () => {
    const h = attachment("ワールド 1.21(バックアップ).tar.gz");
    expect(() => new Response("x", { headers: { "Content-Disposition": h } })).not.toThrow();
    expect(h.match(/filename="([^"]*)"/)![1]).toMatch(/^[ -~]+$/);
    expect(decodeURIComponent(h.match(/filename\*=UTF-8''(.+)$/)![1])).toBe("ワールド 1.21(バックアップ).tar.gz");
  });
  it("(これまで)日本語の名前をそのまま入れると、Response が例外になる", () => {
    expect(() => new Response("x", { headers: { "Content-Disposition": `attachment; filename="日本語.jar"` } })).toThrow();
  });
  it("ふつうの名前はそのまま。引用符・改行・% は ASCII 側で置き換え、filename* では守る", () => {
    expect(attachment("LuckPerms-5.4.0.jar")).toBe(`attachment; filename="LuckPerms-5.4.0.jar"; filename*=UTF-8''LuckPerms-5.4.0.jar`);
    const h = attachment('a"b\r\nc%d\'e.jar');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.match(/filename="([^"]*)"/)![1]).toBe("a_b__c_d'e.jar");
    expect(h).toContain("a%22b%0D%0Ac%25d%27e.jar");
    expect(() => new Response("x", { headers: { "Content-Disposition": h } })).not.toThrow();
  });
});
