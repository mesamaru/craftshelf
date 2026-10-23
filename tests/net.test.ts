// 外へつなぐときの安全策(SSRF)と、API キーの暗号化
import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPublicUrl, isPublicAddress, safeFetch } from "~/server/net";
import { open, seal } from "~/server/secrets";

describe("公開されたアドレスかどうか", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fe80::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:010a", "64:ff9b::a00:1",
  ])("%s は使えない", (a) => expect(isPublicAddress(a)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s は使える", (a) =>
    expect(isPublicAddress(a)).toBe(true));
});

describe("入力した URL の確認", () => {
  it("https の公開された名前だけを受け付け、形をそろえる", () => {
    expect(checkPublicUrl("https://panel.example.com/")).toBe("https://panel.example.com");
    expect(checkPublicUrl("panel.example.com")).toBe("https://panel.example.com");
    expect(checkPublicUrl("https://example.com/panel/")).toBe("https://example.com/panel");
  });

  it.each([
    "http://panel.example.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.5:8080", "https://192.168.1.10",
    "https://[::1]", "https://[::ffff:127.0.0.1]", "https://169.254.169.254", "https://nas", "https://nas.local",
    "https://user:pass@panel.example.com", "ftp://panel.example.com", "file:///etc/passwd", "https://",
  ])("%s は断る", (u) => expect(() => checkPublicUrl(u)).toThrow());
});

describe("名前を引いた先の確認", () => {
  afterEach(() => vi.restoreAllMocks());

  it("公開された名前でも、引いた先が LAN の中ならつながない", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) =>
      cb(null, [{ address: "192.168.1.1", family: 4 }])) as never);
    const err = await safeFetch("https://rebind.example.com/").then(() => null, (e) => e);
    expect(dns.lookup).toHaveBeenCalled();
    // つなぎに行って失敗したのではなく、こちらで断ったこと
    expect(err?.cause?.code).toBe("EUNSAFEADDR");
  });
});

describe("API キーの暗号化", () => {
  const secret = "s".repeat(40);

  it("戻せる。保存した文字列にキーそのものは入らない", () => {
    const sealed = seal(secret, "ptlc_abcdefghijklmnop", "ptero:team:1");
    expect(sealed).not.toContain("ptlc_");
    expect(open(secret, sealed, "ptero:team:1")).toBe("ptlc_abcdefghijklmnop");
  });

  it("別の行・別の鍵・書き換えられたものは読めない", () => {
    const sealed = seal(secret, "ptlc_abcdefghijklmnop", "ptero:team:1");
    expect(() => open(secret, sealed, "ptero:team:2")).toThrow();
    expect(() => open("t".repeat(40), sealed, "ptero:team:1")).toThrow();
    const parts = sealed.split(":");
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("A") ? "BB" : "AA");
    expect(() => open(secret, parts.join(":"), "ptero:team:1")).toThrow();
  });
});
