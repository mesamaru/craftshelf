"use strict";
/* ---------------- ブラウザ・スマホの「戻る」「進む」で、アプリの前の画面へ ----------------
   画面(ライブラリ・ホーム・サーバーの中のタブやファイル比較など)が変わるたびに履歴に積む。
   シート・詳細を開いたときも 1 つ積み、「戻る」ではまずそれを閉じる(設定の中のページは 1 つ前へ)。 */
const navSnap = () => {
  const srv = state.view === "servers", cd = srv && state.srvMode === "cfgdiff" ? state.cd : null;
  return { v: state.view || "library", m: srv ? state.srvMode || "list" : "", o: srv ? state.srvOpen || null : null,
    t: srv && state.srvOpen ? state.srvTab || "overview" : "", cp: cd ? cd.path || "" : "", cdd: cd && !cd.path ? cd.dir || "" : "" };
};
const navSame = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
const navOverlayOpen = () => $("#dlg").open || $("#panel").classList.contains("on");
let navApplying = false, navSkip = 0;

function navSync() {
  if (navApplying || navSkip) return;
  const st = history.state, s = navSnap();
  if (!st || !st.cs) { history.replaceState({ cs: 1, s }, ""); return; }
  if (st.ov) return;  // シートの下で変わった分は、閉じたあとに積む
  if (!navSame(st.s, s)) history.pushState({ cs: 1, s }, "");
}
// シート・詳細が開いたら 1 つ積み、アプリの中で閉じたらその分を戻す
function navOverlaySync() {
  if (navSkip) return;
  const st = history.state || {};
  if (navOverlayOpen() && !st.ov) history.pushState({ cs: 1, s: navSnap(), ov: 1 }, "");
  else if (!navOverlayOpen() && st.ov) { navSkip++; history.back(); }
}
function navLeaveOk(s) {
  const cd = state.cd;
  const leavingCd = state.view === "servers" && state.srvMode === "cfgdiff" && cd && cd.path && (s.v !== "servers" || s.m !== "cfgdiff" || s.cp !== cd.path);
  if (leavingCd && cd.files && Object.values(cd.files).some((f) => f.dirty) && !cfm("保存していない変更があります。破棄して移動しますか?")) return false;
  if (state.feDirty && state.feDirty() && !cfm("保存していない変更があります。破棄して移動しますか?")) return false;
  state.feDirty = null;
  return true;
}
function navApply(s) {
  navApplying = true;
  try {
    if (s.v === "servers") {
      state.srvMode = s.m || "list"; state.srvOpen = s.o || null; state.srvTab = s.t || "overview";
      if (s.m === "cfgdiff") {
        state.cd = state.cd || { ids: [], sync: true, onlyDiff: false, widths: {}, filter: "diff" };
        if ((state.cd.path || "") !== s.cp) { state.cd.path = s.cp || null; state.cd.files = null; }
        state.cd.dir = s.cdd || "";
      }
      if (s.m !== "cfgdiff") document.body.classList.remove("cd-on");
    }
    if (state.view !== s.v) setView(s.v);
    else if (s.v === "servers") renderServers();
    if (typeof renderSideServers === "function") renderSideServers();
  } finally { navApplying = false; }
}
window.addEventListener("popstate", (e) => {
  if (navSkip) { navSkip--; navOverlaySync(); navSync(); return; }
  const st = e.state;
  if (navOverlayOpen()) {
    // 設定の中のページは 1 つ前へ。それ以外は閉じる
    if ($("#dlg").open && settingsNav.form && settingsNav.form.isConnected && settingsNav.stack.length > 1) {
      history.pushState({ cs: 1, s: navSnap(), ov: 1 }, "");
      popSettings();
      return;
    }
    if ($("#dlg").open) $("#dlg").close();
    if ($("#panel").classList.contains("on")) closePanel();
    if (st && st.s && !navSame(st.s, navSnap())) navApply(st.s);
    return;
  }
  if (!st || !st.cs || st.ov) { navSync(); return; }  // 閉じたシートの分(進むで戻ってきたとき)は何もしない
  if (navSame(st.s, navSnap())) return;
  if (!navLeaveOk(st.s)) { history.pushState({ cs: 1, s: navSnap() }, ""); return; }
  navApply(st.s);
});
// 画面を変える操作のあとで、履歴に積む
document.addEventListener("click", () => setTimeout(navSync, 0));
document.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === "Escape") setTimeout(navSync, 0); });
(() => {
  const mo = new MutationObserver(() => navOverlaySync());
  mo.observe($("#dlg"), { attributes: true, attributeFilter: ["open"] });
  mo.observe($("#panel"), { attributes: true, attributeFilter: ["class"] });
})();
