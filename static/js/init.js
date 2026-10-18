"use strict";
/* ---------------- init ---------------- */
(function init() {
  try { const c = localStorage.getItem("craftshelf.cat"); if (c && (c === "all" || CATS[c])) state.cat = c; } catch { /* */ }
  let lang = "ja";
  try { lang = localStorage.getItem("craftshelf.lang") || ((navigator.language || "").startsWith("ja") ? "ja" : "en"); } catch { /* */ }
  setLang(lang);
  applyTheme(readCachedTheme(), { loggedIn: false });
  const sel = $("#catOverride");
  for (const [k, n] of Object.entries(CATS)) sel.insertAdjacentHTML("beforeend", `<option value="${k}">${n}として登録</option>`);
  checkAuth();
})();
