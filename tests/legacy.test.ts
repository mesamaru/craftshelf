// v02 のデータの形(本物の v02 のコードで作った値)を読めるか
import { describe, expect, it } from "vitest";
import { decryptV02Secret, totpCode, verifyV02Totp, verifyWerkzeug } from "~/server/legacy";

// v02(Werkzeug・cryptography)で作った値
export const V02 = {
  scrypt: "scrypt:32768:8:1$4A8JGifZIBuePSpP$513081b153da85eebb802a0bc713e99472dda6987910a9d497a11142df1d62adbab4584a8e57837f168047aae9b4cb23833be3b08ef39b102145fa5d4e9b223e",
  pbkdf2: "pbkdf2:sha256:600000$aRPq3Kll3u4UKwUv$54e163b73d0cc120ee147bf3a3cd4ee0500a810bbfac82c5a67f8caaba8954b3",
  fernetKey: "nS6wfCrd1PMdX9B45MHXA4ctHe5g6VO_yM6ZyyOsYD8=",
  fernetToken: "enc:gAAAAABq3MyCi5qj1JQsE1TuLZTHo17AZ2gtr_Szakiyj72oKTvpy2CLs0KbDcCjkFLEWKIL-u4GbzOxD_ITe9e8euJ0sthKedFR4h5lUxKdusCKNRvZksI=",
};

describe("v02 のパスワード", () => {
  it("scrypt・pbkdf2 の形を確かめられる", () => {
    expect(verifyWerkzeug(V02.scrypt, "password123")).toBe(true);
    expect(verifyWerkzeug(V02.scrypt, "password124")).toBe(false);
    expect(verifyWerkzeug(V02.pbkdf2, "password123")).toBe(true);
    expect(verifyWerkzeug(V02.pbkdf2, "wrong")).toBe(false);
  });
  it("v02 の形でなければ null(v03 の形として確かめる)", () => {
    expect(verifyWerkzeug("abcdef:0123", "x")).toBeNull();
  });
});

describe("v02 の暗号化した値", () => {
  it("Fernet を戻せる", () => {
    expect(decryptV02Secret(V02.fernetToken, V02.fernetKey)).toBe("ptlc_abcdefghij0123456789");
    expect(decryptV02Secret("plain:" + Buffer.from("x").toString("base64url"), V02.fernetKey)).toBe("x");
  });
  it("鍵が違う・書き換えられたものは戻せない", () => {
    expect(() => decryptV02Secret(V02.fernetToken, "a".repeat(43) + "=")).toThrow();
    const t = V02.fernetToken.slice(0, -6) + "AAAAAA";
    expect(() => decryptV02Secret(t, V02.fernetKey)).toThrow();
  });
});

describe("v02 の二段階認証", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  it("いまのコードと前後 1 つを受け付ける", () => {
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyV02Totp(secret, totpCode(secret, step), now)).toBe(true);
    expect(verifyV02Totp(secret, totpCode(secret, step - 1), now)).toBe(true);
    expect(verifyV02Totp(secret, totpCode(secret, step + 2), now)).toBe(false);
    expect(verifyV02Totp(secret, "12345", now)).toBe(false);
  });
});
