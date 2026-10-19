// 英語表示の辞書(static/i18n-en.js)で、画面の文がどう置き換わるかを試す(tests/test_structure.py から呼ぶ)。
// 画面と同じ順番: 数の規則 → 辞書(長いものから) → 句読点。結果を 1 行ずつ JSON で出す。
global.window = {};
require(process.argv[2]);
const map = window.CS_EN;
const keys = Object.keys(map).sort((a, b) => b.length - a.length);
const re = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
function tr(s) {
  for (const [r, t] of window.CS_EN_RULES) s = s.replace(r, t);
  s = s.replace(re, (m) => map[m]);
  for (const [r, t] of window.CS_EN_PUNCT) s = s.replace(r, t);
  return s;
}
for (const s of JSON.parse(process.argv[3])) console.log(JSON.stringify(tr(s)));
