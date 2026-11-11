// メモのウィジェット用の小さな Markdown(見出し・太字・斜体・取り消し・コード・リスト・引用・リンク)。
// 先に全部エスケープしてから、決まった書き方だけを HTML にする(http(s) のリンクだけ。スクリプトは入れられない)
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const inline = (s: string) => s
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
  .replace(/~~([^~]+)~~/g, "<s>$1</s>")
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

export function mdToHtml(src: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let code: string[] | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; }
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const open = (kind: "ul" | "ol") => { if (list !== kind) { flush(); out.push(`<${kind}>`); list = kind; } };
  for (const raw of esc(src).split("\n")) {
    if (code !== null) {
      if (/^```/.test(raw)) { out.push(`<pre><code>${code.join("\n")}</code></pre>`); code = null; } else code.push(raw);
      continue;
    }
    if (/^```/.test(raw)) { flush(); code = []; continue; }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(raw.trim())) { flush(); out.push("<hr>"); continue; }
    if ((m = raw.match(/^&gt;\s?(.*)$/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = raw.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)$/i))) { if (para.length) flush(); open("ul"); out.push(`<li>${m[1].trim() ? "☑" : "☐"} ${inline(m[2])}</li>`); continue; }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) { if (para.length) flush(); open("ul"); out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) { if (para.length) flush(); open("ol"); out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (!raw.trim()) { flush(); continue; }
    if (list) flush();
    para.push(raw);
  }
  if (code !== null) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flush();
  return out.join("");
}
