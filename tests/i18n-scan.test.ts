// 英語表示の訳し漏れを、画面のソースから探す: 属性(placeholder・aria-label・title・label)に直接書いた日本語と、タグの間に直接書いた日本語(変数の入らないもの)が、
// 辞書を通すと日本語が残らないこと。新しい日本語の文言を足して英訳を忘れると、ここで失敗する
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEnglish, translate } from "~/lib/i18n";

beforeAll(() => loadEnglish());
const JA = /[぀-ヿ㐀-鿿]/;

const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".tsx")) files.push(p); } };
walk("src");

// 利用規約・プライバシーは日本語の文書として出す(訳さない)。言語の名前(日本語)もそのまま
const SKIP_FILES = /(terms|privacy)\.tsx$/;
// 変数やタグで途中から切れた文の一部(助詞から始まる・開き括弧で終わる)は、辞書に文の形で持たない
const FRAGMENT = /^[がのはをにでともやへ、。)」）]|[(「（]$|^(#|日本語$)/;

function strings(src: string) {
  src = src.replace(/^\s*\/\/.*$/gm, ""); // コメント
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:placeholder|aria-label|title|label)="([^"{}]*)"/g)) if (JA.test(m[1])) out.push(m[1]);
  for (const m of src.matchAll(/>([^<>{}\n]*[぀-ヿ㐀-鿿][^<>{}\n]*)</g)) out.push(m[1].trim());
  return out.filter((s) => s && !FRAGMENT.test(s));
}

describe("画面に直接書いた日本語は、英語表示で残らない", () => {
  it("属性とタグの間の文言(変数の入らないもの)", () => {
    const left: string[] = [];
    for (const f of files.filter((x) => !SKIP_FILES.test(x))) {
      for (const s of strings(readFileSync(f, "utf8"))) {
        const t = translate(s);
        if (JA.test(t.replace(/[「」、。・〜！？：（）]/g, ""))) left.push(`${f.replace(/\\/g, "/")}: ${s} => ${t}`);
      }
    }
    expect(left).toEqual([]);
  });
});
