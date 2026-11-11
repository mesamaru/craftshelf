// 個人の設定(見た目): アカウントに保存して、どの端末でも同じにする。知らない値は既定にそろえる。本人だけ・API トークンでは変えない
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { maybeImportV02Backgrounds, prefsReportPath } from "~/server/import-v02";
import { HttpError } from "~/server/guard";
import { PREF_LIMITS, prefService } from "~/server/prefs";
import { DEFAULT_THEME, cleanTheme, inkOn } from "~/lib/theme";
import { setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let prefs: ReturnType<typeof prefService>;

beforeAll(async () => {
  t = await setup();
  prefs = prefService({ db: t.db, auth: t.auth });
});

describe("見た目の設定", () => {
  it("保存したものは、その人のアカウントから読める(ほかの人には関係しない)", async () => {
    const a = t.headers(await t.signUp("A", "a@example.com"));
    const b = t.headers(await t.signUp("B", "b@example.com"));
    const idOf = async (h: Headers) => (await t.auth.api.getSession({ headers: h }))!.user.id;
    expect(await prefs.theme(await idOf(a))).toBeNull();
    await prefs.setTheme(a, { mode: "dark", accent: "green", preset: "ocean", dim: 25, blur: 6, background: "data:image/jpeg;base64,xx" });
    expect(await prefs.theme(await idOf(a))).toEqual({ mode: "dark", accent: "green", preset: "ocean", dim: 25, blur: 6 }); // 背景画像は見た目とは別に保存する(setBackground)
    await prefs.setTheme(a, { mode: "light", accent: "auto", preset: "end", dim: 10, blur: 0 });
    expect((await prefs.theme(await idOf(a)))?.preset).toBe("end");
    expect(await prefs.theme(await idOf(b))).toBeNull();
  });

  it("知らない値・範囲の外は既定にそろえる。ログインしていない・API トークンでは保存できない", async () => {
    expect(cleanTheme({ mode: "x", accent: "red", preset: "<script>", dim: 999, blur: -3 })).toEqual({ mode: "auto", accent: "auto", preset: "standard", dim: 80, blur: 0 });
    // 初めは v02 と同じオーロラ。緑など明るいアクセントの上の文字は暗く、青の上は白
    expect(DEFAULT_THEME.preset).toBe("aurora");
    expect(inkOn("#30d18a")).toContain("#000");
    expect(inkOn("#0a84ff")).toBe("#fff");
    await expect(prefs.setTheme(new Headers(), {})).rejects.toBeInstanceOf(HttpError);
    await expect(prefs.setTheme(new Headers({ "x-api-key": "cs_wrongwrongwrong" }), {})).rejects.toMatchObject({ status: 401 });
  });
});

describe("背景画像", () => {
  const jpeg = (n: number) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(n)]).toString("base64")}`;
  it("アカウントに保存し、本人だけが読める。外すと空になる。まだ決めていない人は null", async () => {
    const a = t.headers(await t.signUp("C", "c@example.com"));
    const b = t.headers(await t.signUp("D", "d@example.com"));
    const idOf = async (h: Headers) => (await t.auth.api.getSession({ headers: h }))!.user.id;
    expect(await prefs.backgroundUrl(await idOf(a))).toBeNull();
    const url = await prefs.setBackground(a, jpeg(100));
    expect(url).toMatch(/^\/api\/me\/background\?v=\d+$/);
    expect(await prefs.backgroundUrl(await idOf(a))).toBe(url);
    expect(await prefs.background(a)).toMatchObject({ type: "image/jpeg" });
    expect((await prefs.background(a))!.data.length).toBe(104);
    expect(await prefs.background(b)).toBeNull(); // ほかの人のものは読めない
    await prefs.setTheme(a, { mode: "dark" });
    expect(await prefs.backgroundUrl(await idOf(a))).toBe(url); // 見た目を変えても背景画像は残る
    expect(await prefs.setBackground(a, null)).toBe("");
    expect(await prefs.backgroundUrl(await idOf(a))).toBe("");
    expect(await prefs.background(a)).toBeNull();
  });

  it("画像でないもの・上限を超えるものは断る。ログインしていない・API トークンでは変えられない", async () => {
    const a = t.headers(await t.signUp("E", "e@example.com"));
    await expect(prefs.setBackground(a, "data:image/svg+xml;base64,PHN2Zz4=")).rejects.toMatchObject({ status: 400 });
    await expect(prefs.setBackground(a, `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`)).rejects.toMatchObject({ status: 400 });
    await expect(prefs.setBackground(a, jpeg(PREF_LIMITS.backgroundBytes))).rejects.toMatchObject({ status: 400 });
    await expect(prefs.setBackground(new Headers(), jpeg(10))).rejects.toBeInstanceOf(HttpError);
    await expect(prefs.setBackground(new Headers({ "x-api-key": "cs_wrongwrongwrong" }), jpeg(10))).rejects.toMatchObject({ status: 401 });
  });
});

describe("v02 の背景画像の取り込み", () => {
  it("「マイ画像」を使っていた人の背景画像を一度だけ引き継ぐ(v03 で決めた人は上書きしない・大きすぎるものは理由を残す)", async () => {
    const v02Dir = mkdtempSync(join(tmpdir(), "cs-v02bg-"));
    const v03Dir = mkdtempSync(join(tmpdir(), "cs-v03bg-"));
    mkdirSync(join(v02Dir, "backgrounds"));
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(50)]);
    writeFileSync(join(v02Dir, "backgrounds", "u1-0123456789abcdef.png"), png);
    writeFileSync(join(v02Dir, "backgrounds", "u2-0123456789abcdef.jpg"), Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(PREF_LIMITS.backgroundBytes)]));
    writeFileSync(join(v02Dir, "backgrounds", "u3-0123456789abcdef.png"), png);
    const d = new DatabaseSync(join(v02Dir, "index.db"));
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, prefs TEXT NOT NULL DEFAULT '{}')");
    const add = d.prepare("INSERT INTO users (id, username, prefs) VALUES (?,?,?)");
    add.run(1, "画像の人", JSON.stringify({ theme: "custom", bg_file: "u1-0123456789abcdef.png" }));
    add.run(2, "大きい人", JSON.stringify({ theme: "custom", bg_file: "u2-0123456789abcdef.jpg" }));
    add.run(3, "決め直した人", JSON.stringify({ theme: "custom", bg_file: "u3-0123456789abcdef.png" }));
    add.run(4, "テーマの人", JSON.stringify({ theme: "aurora", bg_file: "u1-0123456789abcdef.png" }));
    d.close();
    const h: Headers[] = [];
    for (const n of [1, 2, 3, 4]) h.push(t.headers(await t.signUp(`v02-${n}`, `u${n}@v02.craftshelf.invalid`)));
    const idOf = async (x: Headers) => (await t.auth.api.getSession({ headers: x }))!.user.id;
    await prefs.setBackground(h[2], null); // v03 で外した人
    expect(await maybeImportV02Backgrounds(t.db, { v02Dir, v03Dir })).toBeNull(); // 見た目の取り込みのあとで
    writeFileSync(prefsReportPath(v03Dir), "{}");
    const r = (await maybeImportV02Backgrounds(t.db, { v02Dir, v03Dir }))!;
    expect(r.users).toEqual(["画像の人"]);
    expect(r.skipped.map((x) => x.what)).toEqual(["背景画像: 大きい人"]);
    expect((await prefs.background(h[0]))?.data.equals(png)).toBe(true);
    expect(await prefs.backgroundUrl(await idOf(h[2]))).toBe("");
    expect(await prefs.backgroundUrl(await idOf(h[3]))).toBeNull();
    expect(await maybeImportV02Backgrounds(t.db, { v02Dir, v03Dir })).toBeNull();
  });
});
