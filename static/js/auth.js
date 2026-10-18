"use strict";
/* ---------------- auth ---------------- */
async function checkAuth() {
  let me;
  try { me = await api("/api/auth/me"); } catch (e) { toast(e.message, true); return; }
  state.roles = me.roles || {}; state.appVersion = me.version;
  if (!me.user) { showAuth(me.setup_required); return; }
  state.user = me.user;
  state.prefs = me.prefs || {};
  if (state.prefs.lang) setLang(state.prefs.lang);
  if (state.prefs.sort && $(`#sortSel option[value="${state.prefs.sort}"]`)) {
    $("#sortSel").value = state.prefs.sort;
    const [k, d] = state.prefs.sort.split(":"); state.sortKey = k; state.sortDir = Number(d);
  }
  if (state.prefs.theme === "custom" && state.prefs.bg_file) state.prefs.tone = await detectTone(state.prefs.bg_file);
  applyTheme(state.prefs);
  $("#auth").hidden = true;
  $("#app").hidden = false;
  document.body.classList.toggle("can-edit", isEditor());
  document.body.classList.toggle("can-admin", isAdmin());
  let v = "library"; try { v = localStorage.getItem("craftshelf.view") || "library"; } catch { /* */ }
  setView(v === "dash" ? "dash" : "library");
  refresh();
  pollJobs();
  loadTelemetry().then(() => { if (can("system")) setTimeout(askTelemetry, 1500); });
  if (can("system")) {
    checkSelfUpdate(false);
    if (!state.updTimer) state.updTimer = setInterval(() => checkSelfUpdate(false), 3 * 3600 * 1000);
  }
}
function showAuth(setup) {
  state.user = null;
  applyTheme(readCachedTheme(), { loggedIn: false });
  $("#app").hidden = true;
  closePanel();
  const dlg = $("#dlg"); if (dlg.open) dlg.close();
  document.body.classList.remove("can-edit", "can-admin");
  const f = $("#authForm");
  const logo = `<img class="logo" src="/static/icon.svg" alt="" aria-hidden="true">`;
  f.innerHTML = setup ? `${logo}
    <h2>CraftShelf へようこそ</h2>
    <p>最初に管理者アカウントを作成してください。ほかのユーザーの追加やストレージの設定は、このアカウントで行います。</p>
    ${field("ユーザー名", `<input type="text" name="username" autocomplete="username" required>`)}
    ${field("パスワード(8文字以上)", `<input type="password" name="password" autocomplete="new-password" minlength="8" required>`)}
    ${field("パスワード(確認)", `<input type="password" name="password2" autocomplete="new-password" required>`)}
    <div class="err" id="authErr"></div>
    <button class="btn filled block" type="submit">はじめる</button>` : `${logo}
    <h2>CraftShelf</h2>
    <p>ログインしてください</p>
    ${field("ユーザー名", `<input type="text" name="username" autocomplete="username" required>`)}
    ${field("パスワード", `<input type="password" name="password" autocomplete="current-password" required>`)}
    <div class="err" id="authErr"></div>
    <button class="btn filled block" type="submit">ログイン</button>`;
  f.insertAdjacentHTML("beforeend", `<div class="ver">${state.appVersion ? `v${esc(state.appVersion)} · ` : ""}<button class="linkish" type="button" id="langToggle" translate="no">${I18N.lang === "en" ? "日本語" : "English"}</button></div>`);
  $("#langToggle").onclick = () => { setLang(I18N.lang === "en" ? "ja" : "en"); showAuth(setup); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    const err = $("#authErr");
    if (setup && d.password !== d.password2) { err.textContent = "確認用のパスワードが一致しません"; return; }
    await busy(f.querySelector("[type=submit]"), async () => {
      try {
        const r = await api(setup ? "/api/auth/setup" : "/api/auth/login", { json: { username: d.username, password: d.password } });
        if (r.need_totp) { showTotpStep(); return; }
        await checkAuth();
      } catch (ex) { err.textContent = ex.message; }
    }, setup ? "作成中…" : "ログイン中…");
  };
  $("#auth").hidden = false;
  f.querySelector("input")?.focus();
}

function showTotpStep() {
  const f = $("#authForm");
  f.innerHTML = `<img class="logo" src="/static/icon.svg" alt="" aria-hidden="true">
    <h2>二段階認証</h2><p>認証アプリに表示されている 6 桁のコードを入力してください。スマホが手元にない場合は回復コードも使えます。</p>
    ${field("確認コード", `<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required>`)}
    <div class="err" id="authErr"></div>
    <button class="btn filled block" type="submit">確認</button>
    <button class="btn plain block" type="button" id="totpBack">最初からやり直す</button>`;
  $("#totpBack").onclick = () => showAuth(false);
  f.onsubmit = async (e) => {
    e.preventDefault();
    await busy(f.querySelector("[type=submit]"), async () => {
      try { await api("/api/auth/totp", { json: { code: f.querySelector("[name=code]").value } }); await checkAuth(); }
      catch (ex) { $("#authErr").textContent = ex.message; }
    }, "確認中…");
  };
  f.querySelector("input").focus();
}

