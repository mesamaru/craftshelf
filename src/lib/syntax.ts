// 設定ファイルの書き方の確かめ(保存する前に画面で読んでみる。v02 の check_syntax と同じ考え)。
// JSON・YAML・TOML・properties だけを見る。読むための部品(yaml・smol-toml)は、使うときに読み込む

const first = (s: string) => s.split("\n")[0].trim();
const lineAt = (text: string, pos: number) => text.slice(0, pos).split("\n").length;
const say = (kind: string, line: number | null | undefined, detail: string) =>
  `${line ? `${line} 行目: ` : ""}${kind} の書き方が正しくありません(${detail})`;

const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
/** JSON の誤りの場所(文字の位置。誤りが無ければ -1)。JSON.parse が失敗したときだけ使う */
export function jsonErrorAt(t: string): number {
  let i = 0;
  const fail = (): never => { throw i; };
  const ws = () => { while (i < t.length && " \t\n\r".includes(t[i])) i++; };
  const str = () => {
    i++;
    while (i < t.length && t[i] !== '"') {
      if (t[i] < " ") fail();
      i += t[i] === "\\" ? 2 : 1;
    }
    if (i >= t.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const open = t[i];
    if (open === "{" || open === "[") {
      const close = open === "{" ? "}" : "]";
      i++;
      ws();
      if (t[i] === close) return void i++;
      for (;;) {
        if (open === "{") {
          ws();
          if (t[i] !== '"') fail();
          str();
          ws();
          if (t[i] !== ":") fail();
          i++;
        }
        value();
        ws();
        if (t[i] === close) return void i++;
        if (t[i] !== ",") fail();
        i++;
      }
    }
    if (open === '"') return str();
    NUM.lastIndex = i;
    if (!NUM.test(t)) fail();
    i = NUM.lastIndex;
  };
  try {
    value();
    ws();
    if (i < t.length) fail();
  } catch (p) {
    if (typeof p === "number") return p;
    return -1; // 入れ子が深すぎるなど
  }
  return -1;
}

/** 書き方の誤り(「N 行目: … の書き方が正しくありません(…)」)。誤りが無い・見ない種類なら null */
export async function syntaxError(path: string, text: string): Promise<string | null> {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (!text.trim()) return null; // 空のファイルは読み手に任せる
  if (ext === "json") {
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      // 場所はブラウザによって言わないことがあるので、自分で探す。説明は JSON.parse のものから場所と抜き出しを除く
      const m = first(e instanceof Error ? e.message : String(e));
      const at = jsonErrorAt(text);
      const detail = m.replace(/^JSON\.parse: /, "").replace(/,\s*".*$/, "").replace(/ in JSON at position.*$/, "").replace(/ at line \d+ column \d+ of the JSON data$/, "");
      return say("JSON", at >= 0 ? lineAt(text, at) : null, detail);
    }
  }
  if (ext === "yml" || ext === "yaml") {
    const { parseAllDocuments } = await import("yaml");
    const docs = parseAllDocuments(text);
    const err = Array.isArray(docs) ? docs.flatMap((d) => d.errors)[0] : undefined;
    return err ? say("YAML", err.linePos?.[0].line, first(err.message).replace(/ at line \d+, column \d+:?$/, "")) : null;
  }
  if (ext === "toml") {
    const { parse, TomlError } = await import("smol-toml");
    try {
      parse(text);
      return null;
    } catch (e) {
      if (!(e instanceof TomlError)) throw e;
      return say("TOML", e.line, first(e.message).replace(/^Invalid TOML document: /, ""));
    }
  }
  if (ext === "properties") {
    // Java の Properties が読めないのは、\u のあとに 16 進数 4 けたが無いときだけ
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trimStart();
      if (l.startsWith("#") || l.startsWith("!")) continue;
      if (/(?:^|[^\\])(?:\\\\)*\\u(?![0-9a-fA-F]{4})/.test(l)) return say("properties", i + 1, "\\u のあとに 16 進数 4 けたが要ります");
    }
  }
  return null;
}

/** 誤りがあれば知らせて、それでも保存するかを聞く(保存してよければ true) */
export async function confirmSyntax(path: string, text: string) {
  const err = await syntaxError(path, text);
  return !err || confirm(`${err}\n\nそれでも保存しますか?`);
}
