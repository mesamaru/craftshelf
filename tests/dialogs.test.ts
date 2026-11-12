// 確認・入力のダイアログ(標準の confirm / prompt / alert の代わり): 順番待ちの動きと、標準の窓が画面のソースに戻ってこないこと
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dialogs, wordOk } from "~/lib/dialog-queue";

const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(p)) files.push(p); } };
walk("src");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("確認", () => {
  it("実行 → true、キャンセル・Esc(cancel)→ false", async () => {
    const a = dialogs.confirm({ message: "外しますか?", danger: true });
    expect(dialogs.current()?.kind).toBe("confirm");
    dialogs.close(true);
    expect(await a).toBe(true);
    const b = dialogs.confirm({ message: "外しますか?" });
    dialogs.cancel();
    expect(await b).toBe(false);
    expect(dialogs.current()).toBeUndefined();
  });

  it("同時に開くのは 1 つ。あとのものは前が閉じてから出る(順番どおり)", async () => {
    const seen: string[] = [];
    const a = dialogs.confirm({ message: "1" }).then((v) => seen.push(`a${v}`));
    const b = dialogs.confirm({ message: "2" }).then((v) => seen.push(`b${v}`));
    expect((dialogs.current() as { message: string }).message).toBe("1");
    await tick();
    expect(seen).toEqual([]);
    dialogs.close(true);
    await a;
    expect((dialogs.current() as { message: string }).message).toBe("2");
    dialogs.cancel();
    await b;
    expect(seen).toEqual(["atrue", "bfalse"]);
    expect(dialogs.current()).toBeUndefined();
  });

  it("2 段目で言葉を入力させるときは、合うまで実行できない(前後の空白は無視)", () => {
    expect(wordOk("", undefined)).toBe(true);
    expect(wordOk("", "戻す")).toBe(false);
    expect(wordOk("戻す ", "戻す")).toBe(true);
    expect(wordOk("戻", "戻す")).toBe(false);
    expect(wordOk("Restore", "戻す", "Restore")).toBe(true); // 英語表示で画面に出る訳
    expect(wordOk("Restore", "戻す")).toBe(false);
  });
});

describe("入力", () => {
  it("決定(Enter)→ 前後の空白を除いた文字。やめる → null", async () => {
    const a = dialogs.prompt({ title: "タグ", value: "x" });
    expect(dialogs.submit("  新しい  ")).toBeNull();
    expect(await a).toBe("新しい");
    const b = dialogs.prompt({ title: "タグ" });
    dialogs.cancel();
    expect(await b).toBeNull();
  });

  it("空・長すぎ・呼び出し側の検査に通らないときは、閉じずにエラーを返す", async () => {
    const a = dialogs.prompt({ title: "タグ", max: 5, validate: (v) => (v === "ng" ? "使えません" : null) });
    expect(dialogs.submit("   ")).toBe("入力してください");
    expect(dialogs.submit("123456")).toBe("5 文字までです");
    expect(dialogs.submit("ng")).toBe("使えません");
    expect(dialogs.current()?.kind).toBe("prompt"); // まだ開いたまま
    expect(dialogs.submit("ok")).toBeNull();
    expect(await a).toBe("ok");
  });

  it("確認のダイアログに submit しても何も起きない", () => {
    void dialogs.confirm({ message: "x" });
    expect(dialogs.submit("a")).toBeNull();
    expect(dialogs.current()?.kind).toBe("confirm");
    dialogs.cancel();
  });
});

describe("標準の窓は使わない(確認・入力は useConfirm・usePrompt)", () => {
  it("画面のソースに window.confirm( / prompt( / alert( も、単独の confirm( / prompt( / alert( も無い", () => {
    const found: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // 名前の一部(confirmDialog・useConfirm・.confirm( などのメソッド)は除く
      for (const m of src.matchAll(/(?<![\w$.])(?:window\.|globalThis\.)?(confirm|prompt|alert)\s*\(|\bwindow\.(confirm|prompt|alert)\b/g)) found.push(`${f.replace(/\\/g, "/")}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});

describe("ダイアログの文言は英語表示でも訳される", () => {
  it("ok: \"…\"(実行のボタン)・既定の文言・入力の案内・title / placeholder(promptDialog)", async () => {
    const { loadEnglish, translate } = await import("~/lib/i18n");
    await loadEnglish();
    const JA = /[぀-ヿ㐀-鿿]/;
    const words = new Set(["実行", "決定", "キャンセル", "入力してください", "5 文字までです", "確認のため「戻す」と入力", "書き方に問題があります"]);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bok: "([^"]+)"/g)) words.add(m[1]);
      for (const m of src.matchAll(/promptDialog\(\{ title: "([^"]+)", placeholder: "([^"]+)"/g)) { words.add(m[1]); words.add(m[2]); }
    }
    const left = [...words].filter((w) => JA.test(translate(w)));
    expect(left).toEqual([]);
  });
});
