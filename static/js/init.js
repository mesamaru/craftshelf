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

/* ---------------- ホーム画面に追加(PWA) ---------------- */
/* サービスワーカーは HTTPS か localhost のときだけ使える(LAN の http では、ブラウザの「ホーム画面に追加」だけになる) */
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
const pwa = {
  prompt: null,
  standalone: () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
  ios: () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
  available() { return !this.standalone() && (!!this.prompt || this.ios()); },
  async install() {
    if (this.prompt) {
      this.prompt.prompt();
      const r = await this.prompt.userChoice.catch(() => null);
      this.prompt = null;
      if (r && r.outcome === "accepted") toast("ホーム画面に追加しました");
      return;
    }
    if (this.ios()) {
      await sheet(`${sheetHead("ホーム画面に追加")}<div class="db">
        <ol class="pwa-steps"><li>Safari の下(iPad は上)の ${icon("share")} 共有ボタンを押します</li>
        <li>「ホーム画面に追加」を選びます</li><li>右上の「追加」を押すと、アプリのように開けます</li></ol></div>`);
    }
  },
};
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); pwa.prompt = e; });
window.addEventListener("appinstalled", () => { pwa.prompt = null; });
