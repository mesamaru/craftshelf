// 設定ファイルの書き方の確かめ(保存する前)
import { describe, expect, it } from "vitest";
import { jsonErrorAt, syntaxError } from "~/lib/syntax";
import { translate } from "~/lib/i18n";

describe("書き方の確かめ", () => {
  it("正しいもの・見ない種類・空のファイルは null", async () => {
    expect(await syntaxError("a.json", '{ "a": 1 }')).toBeNull();
    expect(await syntaxError("config.yml", "a:\n  b: 1\n")).toBeNull();
    expect(await syntaxError("x.toml", 'a = 1\n[b]\nc = "d"\n')).toBeNull();
    expect(await syntaxError("server.properties", "motd=\\u3042\nlevel-name=world\n")).toBeNull();
    expect(await syntaxError("notes.txt", "{")).toBeNull();
    expect(await syntaxError("a.json", "  \n")).toBeNull();
  });

  it("誤りは行番号つきで知らせる", async () => {
    expect(await syntaxError("a.json", '{\n  "a": 1,\n  "b": \n}')).toMatch(/^4 行目: JSON の書き方が正しくありません/);
    expect(await syntaxError("config.yml", "a:\n\tb: 1\n")).toMatch(/^2 行目: YAML の書き方が正しくありません/);
    expect(await syntaxError("config.yml", "a: [1, 2\nb: 3\n")).toMatch(/行目: YAML の書き方が正しくありません/);
    expect(await syntaxError("x.toml", "a = 1\nb = = 2\n")).toMatch(/^2 行目: TOML の書き方が正しくありません/);
    expect(await syntaxError("server.properties", "a=1\nmotd=\\u30\n")).toMatch(/^2 行目: properties の書き方が正しくありません/);
    expect(await syntaxError("server.properties", "path=C:\\\\users\n# \\uZZ\n")).toBeNull(); // \\ のあとの u・コメントは見ない
  });

  it("JSON の誤りの場所を自分で探す(ブラウザが場所を言わないとき)", () => {
    for (const ok of ['{"a":[1,2.5e3,-0.1E+2,true,null,"x\\"y"]}', "[]", ' "s" ', "{ }"]) expect(jsonErrorAt(ok)).toBe(-1);
    expect(jsonErrorAt('{"a":1,}')).toBe(7);
    expect(jsonErrorAt('{"a":1 "b":2}')).toBe(7);
    expect(jsonErrorAt('["a]')).toBe(4);
    expect(jsonErrorAt('{"a":01}')).toBe(6);
    expect(jsonErrorAt("[1] x")).toBe(4);
  });

  it("英語表示", () => {
    expect(translate("4 行目: JSON の書き方が正しくありません(Unexpected token)")).toBe("Line 4: invalid JSON syntax (Unexpected token)");
    expect(translate("4 行目: JSON の書き方が正しくありません(Unexpected token)\n\nそれでも保存しますか?")).toBe("Line 4: invalid JSON syntax (Unexpected token)\n\nSave anyway?");
  });
});
