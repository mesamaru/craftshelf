// 設定ファイルの中のポート番号を読む・書き換える。properties(key=value)と、字下げで入れ子にする形
// (YAML・HOCON・TOML・Dynmap の configuration.txt)を扱う。ファイル全体は解釈せず、その 1 行だけを見る
import { isPort } from "~/lib/ports";

export type Found = { key: string; port: number; line: number };

const isProperties = (file: string) => file.endsWith(".properties");
// 値から番号を取り出す: 8100 / "8100" / "0.0.0.0:25577"
const numberOf = (v: string) => {
  const m = v.trim().replace(/\s+#.*$/, "").match(/^["']?(?:[^"':]*:)?(\d{1,5})["']?,?$/);
  const n = m ? Number(m[1]) : NaN;
  return isPort(n) ? n : null;
};

/** ファイルの中の、番号の値を持つ項目をすべて(項目の名前は入れ子を . でつなぐ) */
export function numericEntries(file: string, text: string): Found[] {
  const out: Found[] = [];
  const lines = text.split(/\r?\n/);
  if (isProperties(file)) {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/);
      const n = m && numberOf(m[2]);
      if (m && n) out.push({ key: m[1], port: n, line: i });
    });
    return out;
  }
  const stack: { indent: number; name: string }[] = [];
  let section = ""; // TOML の [a.b]
  lines.forEach((l, i) => {
    if (/^\s*(#|\/\/|$)/.test(l)) return;
    const sec = l.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) { section = sec[1].trim(); stack.length = 0; return; }
    const m = l.match(/^(\s*)(?:-\s+)?["']?([A-Za-z0-9_.\-]+)["']?\s*[:=]\s*(.*)$/);
    if (!m) return;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const value = m[3].trim();
    if (value === "" || value === "{") { stack.push({ indent, name: m[2] }); return; }
    const n = numberOf(value);
    if (n) out.push({ key: [section, ...stack.map((s) => s.name), m[2]].filter(Boolean).join("."), port: n, line: i });
  });
  return out;
}

/** 決まった項目の番号(見つからなければ null)。項目名の大文字・小文字は区別しない */
export function readPort(file: string, text: string, key: string): Found | null {
  return numericEntries(file, text).find((e) => e.key.toLowerCase() === key.toLowerCase()) ?? null;
}

/** ポートらしい項目(名前に port を含む番号)。知らないプラグインの設定から見つけるのに使う */
export const portLike = (file: string, text: string) => numericEntries(file, text).filter((e) => /port/i.test(e.key.split(".").pop() ?? ""));

/** その項目の行の番号だけを書き換える(ほかの行・書き方はそのまま) */
export function writePort(file: string, text: string, key: string, port: number): string | null {
  const f = readPort(file, text, key);
  if (!f || !isPort(port)) return null;
  const lines = text.split(/(?<=\n)/);
  const l = lines[f.line];
  const at = l.lastIndexOf(String(f.port));
  lines[f.line] = l.slice(0, at) + String(port) + l.slice(at + String(f.port).length);
  return lines.join("");
}
