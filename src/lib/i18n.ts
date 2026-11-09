// 英語表示: 画面の日本語を、辞書(i18n-en.ts)で置き換える(v02 と同じやり方)。
// 言語はブラウザごと(localStorage)。利用者が入力した名前など translate="no" の中は訳さない
import { EN, EN_PUNCT, EN_RULES, EN_WHOLE } from "./i18n-en";

const KEY = "craftshelf.lang";
const JA = /[぀-ヿ㐀-鿿！-｠]/;
let re: RegExp | null = null;

export const getLang = (): "ja" | "en" => {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "ja";
  } catch {
    return "ja";
  }
};

export function setLang(lang: "ja" | "en") {
  localStorage.setItem(KEY, lang);
  location.reload(); // 日本語に戻すときは書き換えた文字を戻せないので、読み込み直す
}

/** 日本語の文を英語にする(辞書に無いところは日本語のまま) */
export function translate(s: string): string {
  if (!JA.test(s)) return s;
  const t = s.trim();
  if (t in EN_WHOLE) return s.replace(t, EN_WHOLE[t]);
  if (Object.hasOwn(EN, t)) return s.replace(t, EN[t]); // 文全体が辞書にあれば、数字の規則より先に当てる(「1 台」などが先に訳されて辞書と合わなくなるため)
  re ??= new RegExp(Object.keys(EN).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  for (const [r, to] of EN_RULES) s = s.replace(r, to as never);
  s = s.replace(re, (m) => EN[m]);
  for (const [r, to] of EN_PUNCT) s = s.replace(r, to);
  return s;
}

const ATTRS = ["placeholder", "title", "aria-label"];
const skip = (el: Element | null) => !!el?.closest("[translate=no], script, style, textarea, code");
// 属性(placeholder など)は入力欄でも訳す。中身(textarea の文字)は訳さない
const skipAttr = (el: Element | null) => !!el?.closest("[translate=no], script, style, code");

// サーバーで描いた画面を React が受け取る(ハイドレーション)前に文字を書き換えると、食い違いのエラー(React #418)になる。
// React は受け取った要素に印(__reactFiber$…)を付けるので、まだのところは飛ばし(pending)、受け取り終わってから訳す
let pending = false;
const hydrated = (el: Element | null) => !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));

// 同じ値を書き戻すと監視がまた反応して繰り返すので、変わるときだけ書き換える
function textNode(n: Node) {
  const v = n.nodeValue;
  if (!v || !JA.test(v) || skip(n.parentElement)) return;
  if (!hydrated(n.parentElement)) return void (pending = true);
  const t = translate(v);
  if (t !== v) n.nodeValue = t;
}
function attr(el: Element, a: string) {
  const v = el.getAttribute(a);
  if (!v || !JA.test(v) || skipAttr(el)) return;
  if (!hydrated(el)) return void (pending = true);
  const t = translate(v);
  if (t !== v) el.setAttribute(a, t);
}
function tree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return textNode(root);
  if (!(root instanceof Element) || skipAttr(root)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) textNode(w.currentNode);
  for (const el of [root, ...root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(","))]) for (const a of ATTRS) attr(el, a);
}

/** 英語表示を始める(読み込んだあと、画面が変わるたびに訳す) */
export function startEnglish() {
  document.documentElement.lang = "en";
  for (const name of ["confirm", "alert", "prompt"] as const) {
    const orig = window[name].bind(window) as (m?: string, d?: string) => never;
    (window as unknown as Record<string, unknown>)[name] = (m?: string, d?: string) => orig(m && translate(String(m)), d);
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") textNode(m.target);
      else if (m.type === "attributes") attr(m.target as Element, m.attributeName!);
      else m.addedNodes.forEach(tree);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // まだ受け取っていないところ(あとから読み込む画面の部品)があれば、受け取り終わるまで見直す(15 秒まで)
  const until = Date.now() + 15_000;
  const scan = () => {
    pending = false;
    tree(document.body);
    if (pending && Date.now() < until) setTimeout(scan, 100);
  };
  scan();
}
