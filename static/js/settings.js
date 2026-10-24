"use strict";
/* ---------------- settings(iOS の設定アプリ風) ---------------- */
const settingsNav = { stack: [] };
async function openSettings(start) {
  settingsNav.stack = [{ page: "root" }];
  if (start) settingsNav.stack.push({ page: start });
  await sheet(`<div id="setRoot" style="display:contents"></div>`, (form) => {
    settingsNav.form = form;
    renderSettings();
  }, { wide: false });
  settingsNav.form = null;
  state.dashSettings = null;
  if (isAdmin()) loadGuide();  // 設定で済ませた手順に印を付ける
  if (state.view === "dash") renderDash();
}
function pushSettings(page, arg) { settingsNav.stack.push({ page, arg }); renderSettings(); }
function popSettings() { settingsNav.stack.pop(); renderSettings(); }
async function renderSettings() {
  const form = settingsNav.form; if (!form) return;
  const cur = settingsNav.stack[settingsNav.stack.length - 1];
  const prev = settingsNav.stack[settingsNav.stack.length - 2];
  const page = SETTINGS_PAGES[cur.page];
  const back = prev ? `<button class="btn plain small" type="button" data-sback>${icon("back")}${esc(SETTINGS_PAGES[prev.page].title(prev.arg))}</button>` : "";
  const root = $("#setRoot", form);
  // 同じページを描き直すときは、スクロールの位置を残す(テーマを選んで上に飛ばないように)
  const same = settingsNav.lastPage === cur.page;
  settingsNav.lastPage = cur.page;
  const scrollers = [form.closest("dialog"), form, $("#setBody", root)].filter(Boolean);
  const keep = same ? scrollers.map((el) => el.scrollTop) : null;
  root.innerHTML = `${sheetHead(page.title(cur.arg), back)}<div class="db" id="setBody"><div style="text-align:center;padding:30px"><span class="spinner lg"></span></div></div>`;
  $("[data-sback]", root)?.addEventListener("click", popSettings);
  const body = $("#setBody", root);
  try { await page.render(body, cur.arg); }
  catch (e) { body.innerHTML = `<div class="result err">${esc(e.message)}</div>`; }
  if (keep) [form.closest("dialog"), form, $("#setBody", root)].filter(Boolean).forEach((el, i) => { if (keep[i] !== undefined) el.scrollTop = keep[i]; });
}
const themeName = (p) => (p && p.theme === "custom" ? "マイ画像" : (THEMES.find((t) => t.id === ((p && p.theme) || DEFAULT_THEME)) || THEMES[0]).name);
const rowBtn = (key, ic, color, title, val = "", extra = "") =>
  `<button class="row" type="button" data-go="${key}" ${extra}><span class="cicon sm ${color}">${icon(ic)}</span><span class="main"><span class="title">${esc(title)}</span></span><span class="trail">${val}${icon("chev", "i chev")}</span></button>`;

const SETTINGS_PAGES = {
  root: {
    title: () => "設定",
    async render(body) {
      const grp = (title, rows) => { const r = rows.filter(Boolean); return r.length ? `<div class="group-title">${title}</div><div class="group">${r.join("")}</div>` : ""; };
      const u = state.user;
      const upd = state.selfUpd && state.selfUpd.update_available;
      body.innerHTML = `
        <div class="group"><button class="row account-row" type="button" data-go="account">
          <span class="avatar">${esc((u.username || "?").slice(0, 1).toUpperCase())}</span>
          <span class="main"><span class="title">${esc(u.username)}</span><span class="subtitle">${esc(u.role_label)} · アカウント・セキュリティ・連携の状況</span></span>
          <span class="trail">${icon("chev", "i chev")}</span></button></div>
        ${grp("管理", [
          can("storage") && rowBtn("storage", "server", "c-plugin", "ストレージ", `<span class="val">${esc(state.storage?.target?.name || "")}</span>`),
          can("users") && rowBtn("users", "users", "c-resourcepack", "ユーザーと権限"),
          can("users") && rowBtn("usage", "chart", "c-teal", "ユーザーごとの利用状況"),
          can("system") && rowBtn("updates", "clock", "c-datapack", "配布元の更新確認")])}
        ${grp("連携", can("integrations") ? [
          rowBtn("ptero", "server", "c-teal", "Pterodactyl"),
          rowBtn("discord", "bell", "c-plugin", "Discord 通知"),
          rowBtn("curseforge", "key", "c-other", "CurseForge APIキー")] : [])}
        ${grp("運用", [
          can("storage") && rowBtn("backup", "download", "c-mod", "バックアップ"),
          can("audit") && rowBtn("audit", "doc", "c-gray", "操作の記録"),
          rowBtn("shares", "share", "c-teal", "共有リンク")])}
        ${isEditor() ? `<div class="group-title">ツール</div><div class="group">${rowBtn("cleanup", "wand", "c-mod", "アドオンの整理", '<span class="val">重複・古いもの</span>')}</div>` : ""}
        ${state.tele && state.tele.available ? `<div class="group-title">サポート</div><div class="group">
          ${rowBtn("feedback", "chat", "c-teal", "お問い合わせ・要望")}
          ${can("system") ? rowBtn("telemetry", "chart", "c-gray", "利用状況の送信", `<span class="val">${state.tele.enabled ? "送信する" : "送信しない"}</span>`) : ""}
        </div>` : ""}
        <div class="group-title">表示</div><div class="group">
          ${rowBtn("appearance", "sparkle", "c-resourcepack", "見た目とテーマ", `<span class="val">${esc((state.prefs && state.prefs.skin && state.prefs.skin !== "glass") ? (SKINS.find((k) => k.id === state.prefs.skin) || {}).name || "" : themeName(state.prefs))}</span>`)}
          ${rowBtn("lang", "globe", "c-plugin", "言語 / Language", `<span class="val" translate="no">${I18N.lang === "en" ? "English" : "日本語"}</span>`)}
          ${isAdmin() && state.guide && state.guide.hidden ? `<button class="row" type="button" data-guide><span class="cicon sm c-teal">${icon("sparkle")}</span><span class="main"><span class="title">はじめの設定ガイド</span><span class="subtitle">ライブラリの上にまた出します</span></span></button>` : ""}
          ${pwa.available() ? `<button class="row" type="button" data-pwa><span class="cicon sm c-mod">${icon("download")}</span><span class="main"><span class="title">ホーム画面に追加</span><span class="subtitle">アプリのように全画面で開けます</span></span></button>` : ""}
        </div>
        <div class="group-title">CraftShelf</div><div class="group">
          ${can("system") ? rowBtn("selfupdate", "sparkle", "c-mod", "パネルのアップデート", upd ? `<span class="badge upd">v${esc(state.selfUpd.latest)}</span>` : `<span class="val">v${esc(state.version || "")}${state.selfUpd && state.selfUpd.channel === "dev" ? "(開発ビルド)" : state.selfUpd && state.selfUpd.channel === "preview" ? "(プレビュー)" : ""}</span>`)
          : `<div class="row"><span class="cicon sm c-mod">${icon("sparkle")}</span><span class="main"><span class="title">バージョン</span></span><span class="trail">v${esc(state.version || "")}</span></div>`}
        </div>
        <div class="group" style="margin-top:18px"><button class="row danger" type="button" data-go="logout"><span class="cicon sm c-red">${icon("logout")}</span><span class="main"><span class="title">ログアウト</span></span></button></div>
        <div class="group-foot">CraftShelf v${esc(state.version || "")}${state.build ? ` · ${esc(state.build)}` : ""}</div>`;
      body.onclick = async (e) => {
        if (e.target.closest("[data-pwa]")) { pwa.install(); return; }
        if (e.target.closest("[data-guide]")) { await guidePost({ hide: false }); toast("はじめの設定ガイドを出しました"); renderSettings(); return; }
        const b = e.target.closest("[data-go]"); if (!b) return;
        if (b.dataset.go === "logout") {
          await api("/api/auth/logout", { method: "POST" }).catch(() => {});
          $("#dlg").close(); showAuth(false); return;
        }
        pushSettings(b.dataset.go);
      };
    },
  },
  lang: {
    title: () => "言語 / Language",
    async render(body) {
      body.innerHTML = `<p>画面の言語を選べます。アカウントごとに保存されます。</p>
        <div class="group">${[["ja", "日本語"], ["en", "English"]].map(([k, n]) => `<button class="row noicon" type="button" data-lang="${k}" translate="no">
          <span class="main"><span class="title">${n}</span></span><span class="trail">${I18N.lang === k ? icon("check") : ""}</span></button>`).join("")}</div>`;
      body.onclick = async (e) => {
        const b = e.target.closest("[data-lang]"); if (!b) return;
        const lang = b.dataset.lang;
        try { await savePrefs({ lang }); } catch (ex) { toast(ex.message, true); return; }
        if (lang === "ja" && I18N.lang === "en") { setLang("ja"); location.reload(); return; }  // 日本語に戻すときは画面を作り直す
        setLang(lang); toast("言語を変更しました"); renderSettings();
      };
    },
  },
  shares: {
    title: () => "共有リンク",
    async render(body) {
      const { shares } = await api("/api/shares");
      body.innerHTML = `<p>一覧で選んだものを「共有」すると、ログインしていない人でもダウンロードできる期限付きのリンクを作れます。不要になったら削除してください。</p>
        <div class="group">${shares.map((x) => `<div class="row noicon"><span class="main"><span class="title" translate="no">${esc(x.name)}</span>
          <span class="subtitle">${x.count} 件 · ${esc(x.created_by)} · ${x.expired ? "期限切れ" : `${esc(fmtDateTime(x.expires_at))} まで`} · ${x.downloads} 回ダウンロード</span></span>
          <button class="icon-btn sm danger" type="button" data-del="${x.id}" title="削除" aria-label="削除">${icon("trash")}</button></div>`).join("") || `<div class="empty">共有リンクはありません</div>`}</div>`;
      body.onclick = async (e) => {
        const d = e.target.closest("[data-del]"); if (!d) return;
        try { await api(`/api/shares/${d.dataset.del}`, { method: "DELETE" }); toast("削除しました"); renderSettings(); } catch (ex) { toast(ex.message, true); }
      };
    },
  },
  account: {
    title: () => "アカウント",
    async render(body) {
      const [me, st] = await Promise.all([api("/api/auth/me"), api("/api/settings")]);
      state.user = me.user;
      const u = me.user;
      const stat = (ok, on, off) => `<span class="trail"><span class="status-dot ${ok ? "ok" : ""}"></span>${ok ? on : off}${icon("chev", "i chev")}</span>`;
      const need = { ptero: "integrations", discord: "integrations", curseforge: "integrations", backup: "storage", updates: "system" };
      const go = (page, ic, color, title, trail) => `<button class="row" type="button" data-go="${page}"${need[page] && !can(need[page]) ? " disabled" : ""}><span class="cicon sm ${color}">${icon(ic)}</span><span class="main"><span class="title">${esc(title)}</span></span>${trail}</button>`;
      body.innerHTML = `
        <div class="big-version"><span class="avatar lg">${esc(u.username.slice(0, 1).toUpperCase())}</span><div class="v">${esc(u.username)}</div><p>${esc(u.role_label)}${u.last_login ? ` · 最終ログイン ${esc(fmtDateTime(u.last_login))}` : ""}</p></div>
        <div class="group-title">プロフィール</div><div class="group">
          ${rowBtn("username", "person", "c-teal", "ユーザー名を変更", `<span class="val">${esc(u.username)}</span>`)}
          ${rowBtn("password", "key", "c-gray", "パスワードを変更")}
        </div>
        <div class="group-title">セキュリティ</div><div class="group">
          ${rowBtn("totp", "shield", "c-mod", "二段階認証", u.totp_enabled ? '<span class="badge ok">オン</span>' : '<span class="badge">オフ</span>')}
          ${rowBtn("passkeys", "key", "c-teal", "パスキー")}
          ${rowBtn("tokens", "key", "c-plugin", "APIトークン")}
        </div>
        <div class="group-title">連携の状況</div><div class="group">
          ${go("ptero", "server", "c-teal", "Pterodactyl", stat(st.ptero_url && st.ptero_key_set, "接続先を設定済み", "未設定"))}
          ${go("discord", "bell", "c-plugin", "Discord 通知", stat(st.discord_set, `${st.discord_events.length} 種類を通知`, "未設定"))}
          ${go("curseforge", "key", "c-other", "CurseForge APIキー", stat(st.cf_api_key_set, "登録済み", "未登録"))}
          ${go("backup", "download", "c-mod", "自動バックアップ", stat(st.backup_target_id, st.last_backup ? `前回 ${fmtDateTime(st.last_backup)}` : "毎日", "オフ"))}
          ${go("updates", "clock", "c-datapack", "更新の自動確認", stat(st.check_interval_hours, `${st.check_interval_hours} 時間ごと`, "オフ"))}
        </div>
        ${!can("integrations") ? `<div class="group-foot">連携の設定は、管理者か「連携の設定」の権限を持つ人が行います</div>` : ""}
        ${(u.perms || []).length && u.role !== "admin" ? `<div class="group-title">管理者からもらっている権限</div><div class="group">${u.perms.map((p) => `<div class="row"><span class="cicon sm c-teal">${icon("shield")}</span><span class="main"><span class="title">${esc(PERM_LABELS[p] ? PERM_LABELS[p][0] : p)}</span><span class="subtitle">${esc(PERM_LABELS[p] ? PERM_LABELS[p][1] : "")}</span></span></div>`).join("")}</div>` : ""}`;
      body.onclick = (e) => { const b = e.target.closest("[data-go]:not([disabled])"); if (b) pushSettings(b.dataset.go); };
    },
  },
  username: {
    title: () => "ユーザー名を変更",
    async render(body) {
      body.innerHTML = `${field("新しいユーザー名", `<input type="text" name="username" value="${esc(state.user.username)}" autocomplete="username">`)}
        ${field("確認のため現在のパスワード", `<input type="password" name="password" autocomplete="current-password">`)}
        <button class="btn filled block" type="button" id="unSave">変更する</button>`;
      $("#unSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          await api("/api/auth/username", { json: { username: $("[name=username]", body).value.trim(), password: $("[name=password]", body).value } });
          state.user = (await api("/api/auth/me")).user; toast("ユーザー名を変更しました"); popSettings();
        } catch (ex) { toast(ex.message, true); }
      });
    },
  },
  totp: {
    title: () => "二段階認証",
    async render(body) {
      const u = (await api("/api/auth/me")).user;
      if (u.totp_enabled) {
        body.innerHTML = `<div class="result ok">二段階認証はオンです。ログインのときに、認証アプリの 6 桁のコードが必要です。</div>
          ${field("オフにするには現在のパスワードを入力", `<input type="password" name="password" autocomplete="current-password">`)}
          <button class="btn danger block" type="button" id="tfOff">二段階認証をオフにする</button>`;
        $("#tfOff", body).onclick = (e) => busy(e.currentTarget, async () => {
          try { await api("/api/me/totp/disable", { json: { password: $("[name=password]", body).value } }); toast("オフにしました"); renderSettings(); }
          catch (ex) { toast(ex.message, true); }
        });
        return;
      }
      body.innerHTML = `<p>パスワードに加えて、スマホの認証アプリ(Google Authenticator、1Password、Microsoft Authenticator など)に表示される 6 桁のコードでログインするようにします。</p>
        <button class="btn filled block" type="button" id="tfStart">設定を始める</button><div id="tfBody"></div>`;
      const startBtn = $("#tfStart", body);
      startBtn.onclick = () => busy(startBtn, async () => {
        let s;
        try { s = await api("/api/me/totp/setup", { method: "POST" }); } catch (ex) { toast(ex.message, true); return; }
        startBtn.hidden = true;
        $("#tfBody", body).innerHTML = `
          <div class="group-title">1. 認証アプリで QR コードを読み取る</div>
          <div class="qr">${s.qr_svg || ""}</div>
          <p style="font-size:12.5px;word-break:break-all">読み取れない場合はキーを入力: <code>${esc(s.secret)}</code></p>
          <div class="group-title">2. アプリに表示された 6 桁のコードを入力</div>
          ${field("確認コード", `<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">`)}
          <button class="btn filled block" type="button" id="tfOn">オンにする</button>`;
        $("#tfOn", body).onclick = (ev) => busy(ev.currentTarget, async () => {
          try {
            const r = await api("/api/me/totp/enable", { json: { code: $("[name=code]", body).value } });
            $("#tfBody", body).innerHTML = `<div class="result ok">二段階認証をオンにしました。</div>
              <div class="group-title">回復コード(必ず保存してください)</div>
              <p style="font-size:12.5px">スマホをなくしたときに、6 桁のコードの代わりに使えます。それぞれ 1 回だけ使えます。この画面を閉じると二度と表示されません。</p>
              <div class="filelist">${esc(r.recovery_codes.join("\n"))}</div>`;
            state.user.totp_enabled = true;
          } catch (ex) { toast(ex.message, true); }
        });
      }, "準備中…");
    },
  },
  passkeys: {
    title: () => "パスキー",
    async render(body) {
      const { passkeys } = await api("/api/me/passkeys");
      const ok = passkeySupported();
      body.innerHTML = `<p>パスワードの代わりに、端末の指紋・顔・PIN やセキュリティキーでログインできます。パスキーは端末の中にあり、パネルには公開鍵だけを保存します(二段階認証のコードも要りません)。</p>
        ${ok ? "" : `<div class="result warn">${location.protocol !== "https:" && location.hostname !== "localhost" ? "パスキーは HTTPS で開いたときだけ使えます。" : "このブラウザ・この開き方ではパスキーを使えません。"}IP アドレスではなく、名前(ドメイン)で開いてください。</div>`}
        <div class="group">${passkeys.map((k) => `<div class="row"><span class="cicon sm c-teal">${icon("key")}</span><span class="main"><span class="title" translate="no">${esc(k.name)}</span>
          <span class="subtitle">登録 ${esc(fmtDate(k.created_at))}${k.last_used ? ` · 最終使用 ${esc(fmtDateTime(k.last_used))}` : " · 未使用"}</span></span>
          <span class="trail"><button class="icon-btn sm" type="button" data-pkren="${k.id}" title="名前を変更" aria-label="名前を変更">${icon("edit")}</button>
          <button class="icon-btn sm danger" type="button" data-pkdel="${k.id}" title="削除" aria-label="削除">${icon("trash")}</button></span></div>`).join("") || `<div class="empty">まだありません</div>`}</div>
        ${ok ? `${field("この端末の名前", `<input type="text" id="pkName" value="${esc(pkGuessName())}" maxlength="60">`)}<button class="btn filled block" type="button" id="pkAdd">${icon("plus")}この端末をパスキーとして登録</button>` : ""}`;
      $("#pkAdd", body)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        try { await passkeyRegister($("#pkName", body).value.trim()); toast("パスキーを登録しました。次からログインの画面で使えます"); renderSettings(); }
        catch (ex) { toast(ex.message, true); }
      }, "登録中…"));
      body.onclick = async (e) => {
        const del = e.target.closest("[data-pkdel]");
        if (del) {
          if (!cfm("このパスキーを削除しますか?(端末側のパスキーは、端末の設定から消してください)")) return;
          try { await api(`/api/me/passkeys/${del.dataset.pkdel}`, { method: "DELETE" }); toast("削除しました"); renderSettings(); } catch (ex) { toast(ex.message, true); }
          return;
        }
        const ren = e.target.closest("[data-pkren]");
        if (ren) {
          const cur = passkeys.find((k) => String(k.id) === ren.dataset.pkren);
          const name = prompt(trText("新しい名前"), cur ? cur.name : "");
          if (!name || !name.trim()) return;
          try { await api(`/api/me/passkeys/${ren.dataset.pkren}`, { method: "PATCH", json: { name: name.trim() } }); renderSettings(); } catch (ex) { toast(ex.message, true); }
        }
      };
    },
  },
  apidocs: {
    title: () => "API の説明",
    async render(body) {
      const d = await api("/api/docs");
      const origin = location.origin;
      body.innerHTML = `<ul class="api-notes">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
        <pre class="api-ex mono" translate="no">curl -H "Authorization: Bearer cs_…" ${esc(origin)}/api/library
curl -X POST -H "Authorization: Bearer cs_…" -H "Content-Type: application/json" \
     -d '{"item_ids": [1, 2]}' ${esc(origin)}/api/servers/1/push</pre>
        <label class="search"><span>${icon("search")}</span><input type="search" id="adQ" placeholder="パス・説明で絞り込み"></label>
        <div id="adList"></div>
        <p class="group-foot">CraftShelf v${esc(d.version)} · ${d.endpoints.length} 件。この一覧はパネルの実際の API から作っています(<span class="mono">GET /api/docs</span> で JSON でも取れます)。</p>`;
      const draw = (q) => {
        q = q.toLowerCase();
        const list = d.endpoints.filter((e) => !q || e.path.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.group.toLowerCase().includes(q));
        const groups = [...new Set(list.map((e) => e.group))];
        $("#adList", body).innerHTML = groups.map((g) => `<div class="group-title">${esc(g)}</div><div class="group">${list.filter((e) => e.group === g).map((e) =>
          `<div class="row noicon api-row"><span class="main"><span class="title" translate="no">${e.methods.map((m) => `<span class="api-m m-${m.toLowerCase()}">${m}</span>`).join("")} <span class="mono">${esc(e.path)}</span></span>
            <span class="subtitle" style="white-space:normal"><span translate="no">${esc(e.summary)}</span> · ${esc(e.need)}${e.token ? "" : " · トークンでは使えません"}</span></span></div>`).join("")}</div>`).join("")
          || `<div class="empty">あてはまる API はありません</div>`;
      };
      $("#adQ", body).addEventListener("input", (e) => draw(e.target.value.trim()));
      draw("");
    },
  },
  tokens: {
    title: () => "APIトークン",
    async render(body) {
      const { tokens } = await api("/api/me/tokens");
      body.innerHTML = `<p>外部のスクリプトや CI から CraftShelf を操作するためのトークンです。<code>Authorization: Bearer cs_…</code> ヘッダーで送ります。トークンの権限は、あなたの権限以下で選べます。</p>
        <div class="group">${tokens.map((t) => `<div class="row noicon"><span class="main"><span class="title">${esc(t.name)}</span>
          <span class="subtitle">${esc(t.prefix)}… · ${esc((state.roles || {})[t.role] || t.role)} · 作成 ${esc(fmtDate(t.created_at))}${t.last_used ? ` · 最終使用 ${esc(fmtDateTime(t.last_used))}` : " · 未使用"}</span></span>
          <button class="icon-btn sm danger" type="button" data-del="${t.id}" title="削除" aria-label="削除">${icon("trash")}</button></div>`).join("") || `<div class="empty">まだありません</div>`}</div>
        <div class="group-title">新しいトークン</div>
        ${field("名前(用途)", `<input type="text" name="name" placeholder="例: 自動デプロイ用">`)}
        ${field("権限", `<select name="role">${Object.entries(state.roles || {}).filter(([k]) => ["viewer", "editor", "admin"].indexOf(k) <= ["viewer", "editor", "admin"].indexOf(state.user.role)).map(([k, n]) => `<option value="${k}"${k === "viewer" ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`)}
        <button class="btn filled block" type="button" id="tkNew">作成</button><div id="tkOut"></div>
        <div class="group" style="margin-top:18px">${rowBtn("apidocs", "braces", "c-gray", "API の説明", '<span class="val">使える API の一覧</span>')}</div>`;
      body.onclick = async (e) => {
        if (e.target.closest('[data-go="apidocs"]')) { pushSettings("apidocs"); return; }
        const d = e.target.closest("[data-del]"); if (!d) return;
        if (!cfm("このトークンを削除しますか?(使っているスクリプトは動かなくなります)")) return;
        try { await api(`/api/me/tokens/${d.dataset.del}`, { method: "DELETE" }); toast("削除しました"); renderSettings(); } catch (ex) { toast(ex.message, true); }
      };
      $("#tkNew", body).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          const r = await api("/api/me/tokens", { json: { name: $("[name=name]", body).value, role: $("[name=role]", body).value } });
          $("#tkOut", body).innerHTML = `<div class="result ok">作成しました。このトークンは今しか表示されません。コピーして保管してください。</div><div class="filelist">${esc(r.token)}</div>`;
        } catch (ex) { toast(ex.message, true); }
      });
    },
  },
  appearance: {
    title: () => "見た目とテーマ",
    async render(body) {
      const p = state.prefs || {};
      const cur = p.theme || DEFAULT_THEME;
      const tile = (id, name, bgCss) => `<button class="theme-tile" type="button" data-theme="${id}" aria-pressed="${cur === id}">
        <span class="sw" style="background:${esc(bgCss)}">${cur === id ? `<span class="ck">${icon("check")}</span>` : ""}</span>${esc(name)}</button>`;
      const mintBg = "radial-gradient(120% 80% at 10% 0%, rgba(52,199,89,.35), transparent 60%), radial-gradient(90% 70% at 100% 0%, rgba(0,122,255,.25), transparent 60%), #f2f2f7";
      const dim = p.bg_dim ?? (cur === "custom" ? 20 : 0);
      const skin = p.skin || "glass";
      const themed = !!(SKINS.find((k) => k.id === skin) || SKINS[0]).themes;
      body.innerHTML = `<div class="group-title" style="margin-top:0">見た目の種類</div>
        <div class="skins">${SKINS.map((k) => `<button class="skin-tile" type="button" data-skin="${k.id}" aria-pressed="${skin === k.id}">
          <span class="sk-prev" style="background:${k.prev[0]}"><i style="background:${k.prev[2]}"></i><b style="background:${k.prev[1]}"></b>${skin === k.id ? `<span class="ck">${icon("check")}</span>` : ""}</span>
          <span class="sk-n">${esc(k.name)}</span><span class="sk-d">${esc(k.note)}</span></button>`).join("")}</div>
        ${themed ? "" : `<p class="muted small">${icon("sparkle")} テーマ(背景と色)は、ガラス・フロスト・ネオンのときに選べます。</p>`}
        <div class="themed-only"${themed ? "" : " hidden"}>
        <div class="group-title">テーマ(背景と色)</div>
        <p>パネルの背景を選べます。設定はアカウントごとに保存されます。</p>
        <div class="themes">
          ${THEMES.map((t) => tile(t.id, t.name, t.bg || mintBg)).join("")}
          ${p.bg_file ? tile("custom", "マイ画像", `url("${bgUrl(p.bg_file)}") center / cover no-repeat`)
            : `<button class="theme-tile" type="button" data-upload><span class="sw"><span class="add">${icon("plus")}</span></span>画像を追加</button>`}
        </div>
        <div class="group-title">背景画像</div>
        <div class="group">
          <button class="row noicon tint" type="button" data-upload><span class="main"><span class="title">${p.bg_file ? "画像を変更" : "画像をアップロード"}</span><span class="subtitle">PNG / JPEG / WebP / GIF・15MBまで</span></span></button>
          ${p.bg_file ? `<button class="row noicon danger" type="button" data-bgdel><span class="main"><span class="title">画像を削除</span></span></button>` : ""}
        </div>
        <div class="group-title">見やすさの調整</div>
        <div class="group">
          <label class="slider-row"><span class="lab"><span>暗さ</span><span id="vDim">${dim}%</span></span>
            <input type="range" name="bg_dim" min="0" max="80" value="${dim}"></label>
          <label class="slider-row"><span class="lab"><span>ぼかし</span><span id="vBlur">${p.bg_blur ?? 0}px</span></span>
            <input type="range" name="bg_blur" min="0" max="40" value="${p.bg_blur ?? 0}"></label>
        </div>
        <div class="group-foot">「ミント」以外では、カードが半透明のガラスになり背景が透けて見えます。「ミント」では暗さ・ぼかしは使われません。</div>
        </div>
        <input type="file" id="bgFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden>`;
      const paint = (el) => el.style.setProperty("--p", `${(el.value - el.min) / (el.max - el.min) * 100}%`);
      body.querySelectorAll("input[type=range]").forEach(paint);
      let timer = null;
      body.oninput = (e) => {
        const el = e.target; if (el.type !== "range") return;
        paint(el);
        $(el.name === "bg_dim" ? "#vDim" : "#vBlur", body).textContent = el.name === "bg_dim" ? `${el.value}%` : `${el.value}px`;
        state.prefs = { ...state.prefs, [el.name]: Number(el.value) };
        applyTheme(state.prefs);
        clearTimeout(timer);
        timer = setTimeout(() => savePrefs({ [el.name]: Number(el.value) }).catch((ex) => toast(ex.message, true)), 400);
      };
      body.onclick = async (e) => {
        const sk = e.target.closest("button[data-skin]");
        if (sk) {
          try { await savePrefs({ skin: sk.dataset.skin }); renderSettings(); } catch (ex) { toast(ex.message, true); }
          return;
        }
        const tb = e.target.closest("[data-theme]");
        if (tb) {
          try {
            await savePrefs({ theme: tb.dataset.theme });
            if (tb.dataset.theme === "custom" && state.prefs.bg_file) { state.prefs.tone = await detectTone(state.prefs.bg_file); applyTheme(state.prefs); }
            renderSettings();
          } catch (ex) { toast(ex.message, true); }
          return;
        }
        if (e.target.closest("[data-upload]")) { $("#bgFile", body).click(); return; }
        const del = e.target.closest("[data-bgdel]");
        if (del) {
          await busy(del, async () => {
            try { const r = await api("/api/me/background", { method: "DELETE" }); state.prefs = r.prefs; applyTheme(state.prefs); toast("削除しました"); renderSettings(); }
            catch (ex) { toast(ex.message, true); }
          });
        }
      };
      $("#bgFile", body).onchange = async (e) => {
        const f = e.target.files[0]; e.target.value = "";
        if (!f) return;
        if (f.size > 15 * 1024 * 1024) { toast("画像が大きすぎます(15MBまで)", true); return; }
        const tp = toastProgress("画像をアップロードしています…");
        try {
          const r = await api("/api/me/background", { method: "PUT", body: f, headers: { "Content-Type": f.type || "application/octet-stream" } });
          state.prefs = r.prefs;
          state.prefs.tone = await detectTone(state.prefs.bg_file);
          applyTheme(state.prefs); toast("背景を変更しました"); renderSettings();
        } catch (ex) { toast(ex.message, true); }
        finally { tp.remove(); }
      };
    },
  },
  ptero: {
    title: () => "Pterodactyl 連携",
    async render(body) {
      const st = await api("/api/settings");
      let srvs = [];
      if (st.ptero_url && st.ptero_key_set) { try { srvs = (await api("/api/servers")).servers; } catch { /* */ } }
      const reg = st.ptero_url && st.ptero_key_set ? `<div class="group-title">登録済み</div>
        <div class="group"><div class="card-b" style="padding:12px 14px">
          <div class="kv"><span>パネル</span><span translate="no"><a href="${esc(safeUrl(st.ptero_url))}" target="_blank" rel="noopener noreferrer">${esc(st.ptero_url)}</a></span></div>
          <div class="kv"><span>APIキー</span><span translate="no">${esc(st.ptero_key_hint || "登録済み")}</span></div>
          <div class="kv"><span>連携しているサーバー</span><span>${srvs.length ? `${srvs.length} 台` : "なし(「サーバー」タブで追加)"}</span></div>
          ${srvs.map((x) => `<div class="kv sub"><span translate="no">・${esc(x.name)}</span><span translate="no">${esc(dirsLabel(x))}</span></div>`).join("")}
        </div></div>
        <div class="group-title">変更する</div>` : "";
      body.innerHTML = `${reg}<p>Pterodactyl パネルの「アカウント → API 認証情報」で作った <b>Client API キー(ptlc_…)</b>を登録すると、そのユーザーが操作できるサーバーへプラグインを転送・同期できます。</p>
        ${field("パネルの URL", `<input type="url" name="url" value="${esc(st.ptero_url || "")}" placeholder="https://panel.example.com">`)}
        ${field(st.ptero_key_set ? "APIキー(登録済み。変更する場合のみ)" : "APIキー", `<input type="password" name="key" autocomplete="off" placeholder="ptlc_…">`)}
        <div class="group">${toggle("insecure", "証明書を検証しない", "自己署名証明書を使っている場合", st.ptero_insecure)}</div>
        <div class="result" id="ptRes" hidden></div>
        <div class="df row2" style="padding:0">${st.ptero_key_set ? `<button class="btn danger" type="button" id="ptDel">解除</button>` : ""}<button class="btn" type="button" id="ptTest">接続テスト</button><button class="btn filled" type="button" id="ptSave">保存</button></div>`;
      $("#ptDel", body)?.addEventListener("click", async (e) => {
        if (!(await cfm("Pterodactyl 連携を解除しますか?(連携したサーバーの登録は残りますが、転送・同期はできなくなります)"))) return;
        busy(e.currentTarget, async () => {
          try { await api("/api/settings", { method: "PATCH", json: { ptero_url: "", ptero_key: "" } }); toast("解除しました"); state.servers = null; renderSettings(); }
          catch (ex) { toast(ex.message, true); }
        });
      });
      const vals = () => ({ url: $("[name=url]", body).value.trim(), key: $("[name=key]", body).value.trim(), insecure: $("[name=insecure]", body).checked });
      const res = $("#ptRes", body);
      $("#ptTest", body).onclick = (e) => busy(e.currentTarget, async () => {
        try { const r = await api("/api/ptero/test", { json: vals() }); res.hidden = false; res.className = "result " + (r.ok ? "ok" : "err"); res.textContent = r.message; }
        catch (ex) { res.hidden = false; res.className = "result err"; res.textContent = ex.message; }
      }, "接続中…");
      $("#ptSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        const v = vals(); const d = { ptero_url: v.url, ptero_insecure: v.insecure };
        if (v.key) d.ptero_key = v.key;
        try { await api("/api/settings", { method: "PATCH", json: d }); toast("保存しました"); state.servers = null; if (state.view === "servers") loadServers(); popSettings(); }
        catch (ex) { res.hidden = false; res.className = "result err"; res.textContent = ex.message; }
      });
    },
  },
  discord: {
    title: () => "Discord 通知",
    async render(body) {
      const st = await api("/api/settings");
      const di = st.discord_info || {};
      const on = Object.entries(st.discord_event_labels).filter(([k]) => st.discord_events.includes(k)).map(([, l]) => l);
      const reg = st.discord_set ? `<div class="group-title">登録済み</div>
        <div class="group"><div class="card-b" style="padding:12px 14px">
          <div class="kv"><span>Webhook</span><span translate="no">${di.name ? `「${esc(di.name)}」` : "登録済み"}${di.id_tail ? ` (…${esc(di.id_tail)})` : ""}</span></div>
          ${di.channel_id ? `<div class="kv"><span>チャンネル</span><span translate="no">#${esc(di.channel_id)}</span></div>` : ""}
          <div class="kv"><span>通知する出来事</span><span>${on.length ? esc(on.join("、")) : "なし"}</span></div>
        </div></div>
        <div class="group-title">変更する</div>` : "";
      body.innerHTML = `${reg}<p>Discord のチャンネル設定 → 「連携サービス」→「ウェブフック」で作った URL を登録すると、選んだ出来事を通知します。</p>
        ${field(st.discord_set ? "Webhook URL(登録済み。変更する場合のみ)" : "Webhook URL", `<input type="url" name="url" autocomplete="off" placeholder="https://discord.com/api/webhooks/…">`)}
        <div class="group-title">通知する出来事</div>
        <div class="group">${Object.entries(st.discord_event_labels).map(([k, label]) => toggle(`ev_${k}`, label, "", st.discord_events.includes(k))).join("")}</div>
        <div class="result" id="dcRes" hidden></div>
        <div class="df row2" style="padding:0">
          ${st.discord_set ? `<button class="btn danger" type="button" id="dcDel">解除</button>` : ""}
          <button class="btn" type="button" id="dcTest">テスト送信</button><button class="btn filled" type="button" id="dcSave">保存</button></div>`;
      const res = $("#dcRes", body);
      const show = (ok, msg) => { res.hidden = false; res.className = "result " + (ok ? "ok" : "err"); res.textContent = msg; };
      $("#dcTest", body).onclick = (e) => busy(e.currentTarget, async () => {
        try { await api("/api/settings/discord/test", { json: { url: $("[name=url]", body).value.trim() } }); show(true, "送信しました。Discord を確認してください"); }
        catch (ex) { show(false, ex.message); }
      }, "送信中…");
      $("#dcSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        const d = { discord_events: Object.keys(st.discord_event_labels).filter((k) => $(`[name=ev_${k}]`, body).checked) };
        const url = $("[name=url]", body).value.trim(); if (url) d.discord_webhook = url;
        try { await api("/api/settings", { method: "PATCH", json: d }); toast("保存しました"); popSettings(); } catch (ex) { show(false, ex.message); }
      });
      $("#dcDel", body)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        try { await api("/api/settings", { method: "PATCH", json: { discord_webhook: "" } }); toast("解除しました"); renderSettings(); } catch (ex) { show(false, ex.message); }
      }));
    },
  },
  backup: {
    title: () => "バックアップ",
    async render(body) {
      const [st, tg] = await Promise.all([api("/api/settings"), api("/api/storage/targets")]);
      body.innerHTML = `<p>登録情報(index.db)・暗号鍵・背景画像を毎日1回 zip にまとめて、選んだ保存先の「_craftshelf_backup」フォルダに保存します。</p>
        ${field("保存先", `<select name="target"><option value="0">自動バックアップしない</option>${tg.targets.map((t) => `<option value="${t.id}"${t.id === st.backup_target_id ? " selected" : ""}>${esc(t.name)}(${esc(t.protocol_label)})</option>`).join("")}</select>`)}
        ${field("残す数", `<select name="keep">${[7, 14, 30, 60, 90].map((n) => `<option value="${n}"${n === st.backup_keep ? " selected" : ""}>${n} 個</option>`).join("")}</select>`)}
        <div class="group-foot" style="margin:0">${st.last_backup ? `前回のバックアップ: ${esc(fmtDateTime(st.last_backup))}` : "まだバックアップしていません"}</div>
        <p style="font-size:12.5px">⚠ バックアップには保存先のパスワードなどを復号する鍵(secret.key)が含まれます。保存先のアクセス権に注意してください。</p>
        <div class="df row2" style="padding:0"><button class="btn" type="button" id="bkRun">今すぐバックアップ</button><button class="btn filled" type="button" id="bkSave">保存</button></div>
        <div class="group-title">保存されているバックアップ</div><div class="group" id="bkList"><div class="empty"><span class="spinner"></span></div></div>
        ${isAdmin() ? `<div class="group-title">バックアップから戻す</div>
        <p style="font-size:12.5px">登録情報(アイテム・ユーザー・設定)・暗号鍵・背景画像を、バックアップの時点に戻します。保存先にあるアドオンのファイルはそのままです。いまのデータは「パネルのアップデート」の「アップデートの前の状態」に残るので、そこから元に戻せます。入れ直したあとでも、手元の zip から戻せます。</p>
        <div class="df" style="padding:0"><button class="btn" type="button" id="bkUp">${icon("tray")}zip ファイルから戻す</button></div>
        <input type="file" id="bkFile" accept=".zip,application/zip" hidden>` : ""}`;
      const save = () => api("/api/settings", { method: "PATCH", json: { backup_target_id: Number($("[name=target]", body).value), backup_keep: Number($("[name=keep]", body).value) } });
      const restored = (r) => { toast(r.restart ? "戻して再起動します…" : "次の起動で戻します。CraftShelf を終了して、もう一度起動してください"); if (r.restart) setTimeout(() => location.reload(), 6000); };
      const askRestore = (what) => cfm(`${what} の時点に戻しますか?

登録情報・ユーザー・設定・暗号鍵が入れ替わり、パネルが再起動します。いまのデータは「アップデートの前の状態」に残ります。`);
      body.addEventListener("click", (e) => {
        const b = e.target.closest("[data-bkrestore]"); if (!b) return;
        if (!askRestore(b.dataset.bkrestore)) return;
        busy(b, async () => { try { restored(await api(`/api/backup/restore/${encodeURIComponent(b.dataset.bkrestore)}`, { method: "POST" })); } catch (ex) { toast(ex.message, true); } }, "");
      });
      $("#bkUp", body)?.addEventListener("click", () => $("#bkFile", body).click());
      $("#bkFile", body)?.addEventListener("change", async (e) => {
        const f = e.target.files[0]; e.target.value = "";
        if (!f || !askRestore(f.name)) return;
        const fd = new FormData(); fd.append("file", f);
        await busy($("#bkUp", body), async () => { try { restored(await api("/api/backup/restore-upload", { method: "POST", body: fd })); } catch (ex) { toast(ex.message, true); } }, "確かめています…");
      });
      $("#bkSave", body).onclick = (e) => busy(e.currentTarget, async () => { try { await save(); toast("保存しました"); renderSettings(); } catch (ex) { toast(ex.message, true); } });
      $("#bkRun", body).onclick = (e) => busy(e.currentTarget, async () => {
        try { await save(); jobStarted(await api("/api/backup/run", { method: "POST" })); } catch (ex) { toast(ex.message, true); }
      }, "開始しています…");
      try {
        const l = await api("/api/backup/list");
        $("#bkList", body).innerHTML = l.files.length ? l.files.map((f) => `<div class="row noicon"><span class="main"><span class="title">${esc(f)}</span><span class="subtitle">${esc(l.target)}</span></span>
            <span class="trail">${isAdmin() ? `<button class="btn small" type="button" data-bkrestore="${esc(f)}">戻す</button>` : ""}<a class="btn small" href="/api/backup/download/${encodeURIComponent(f)}" aria-label="ダウンロード" title="ダウンロード">${icon("download")}</a></span></div>`).join("")
          : `<div class="empty">まだありません</div>`;
      } catch (ex) { $("#bkList", body).innerHTML = `<div class="empty">${esc(ex.message)}</div>`; }
    },
  },
  audit: {
    title: () => "操作の記録",
    async render(body) {
      let offset = 0, q = "";
      body.innerHTML = `<label class="search"><span>${icon("search")}</span><input type="search" id="auQ" placeholder="ユーザー名・操作・対象で検索"></label>
        <div class="group" id="auList"></div><button class="btn tinted block" type="button" id="auMore" hidden>さらに表示</button>`;
      const load = async (append) => {
        const d = await api(`/api/audit?limit=100&offset=${offset}&q=${encodeURIComponent(q)}`);
        const html = d.entries.map((e) => `<div class="row noicon"><span class="main"><span class="title">${esc(e.action)}${e.target ? ` · ${esc(e.target)}` : ""}</span>
          <span class="subtitle" style="white-space:normal">${esc(fmtDateTime(e.at))} · ${esc(e.username)}${e.detail ? ` · ${esc(e.detail)}` : ""}</span></span></div>`).join("");
        $("#auList", body).innerHTML = (append ? $("#auList", body).innerHTML : "") + (html || (append ? "" : `<div class="empty">記録はありません</div>`));
        offset += d.entries.length;
        $("#auMore", body).hidden = offset >= d.total;
      };
      let t = null;
      $("#auQ", body).oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); offset = 0; load(false).catch((ex) => toast(ex.message, true)); }, 300); };
      $("#auMore", body).onclick = (e) => busy(e.currentTarget, () => load(true).catch((ex) => toast(ex.message, true)));
      await load(false);
    },
  },
  password: {
    title: () => "パスワードを変更",
    async render(body) {
      body.innerHTML = `${field("現在のパスワード", `<input type="password" name="current" autocomplete="current-password">`)}
        ${field("新しいパスワード(8文字以上)", `<input type="password" name="new" autocomplete="new-password">`)}
        <button class="btn filled block" type="button" id="pwSave">変更する</button>`;
      $("#pwSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          await api("/api/auth/password", { json: { current: $("[name=current]", body).value, new: $("[name=new]", body).value } });
          toast("パスワードを変更しました"); popSettings();
        } catch (ex) { toast(ex.message, true); }
      });
    },
  },
  updates: {
    title: () => "配布元の更新確認",
    async render(body) {
      const st = await api("/api/settings");
      body.innerHTML = `<div class="group">
          <div class="toggle-row"><span class="main">自動で確認<small>紐付けた配布元の新しいバージョンを定期的に確認します</small></span>
            <select name="check_interval_hours" class="compact" style="width:auto">${[[0, "しない"], [6, "6時間ごと"], [12, "12時間ごと"], [24, "1日ごと"], [168, "1週間ごと"]]
              .map(([v, n]) => `<option value="${v}"${st.check_interval_hours === v ? " selected" : ""}>${n}</option>`).join("")}</select></div>
          ${toggle("auto_download", "見つかった更新を自動で保存", "ダウンロードしてライブラリに追加します", st.auto_download)}
          ${toggle("stable_only", "安定版のみ", "ベータ版・アルファ版を対象にしません", st.stable_only)}
        </div>
        ${st.last_auto_check ? `<div class="group-foot">前回の自動確認: ${fmtDateTime(st.last_auto_check)}</div>` : ""}`;
      body.onchange = async (e) => {
        const el = e.target; if (!el.name) return;
        const val = el.type === "checkbox" ? el.checked : Number(el.value);
        try { await api("/api/settings", { method: "PATCH", json: { [el.name]: val } }); toast("保存しました"); }
        catch (ex) { toast(ex.message, true); }
      };
    },
  },
  curseforge: {
    title: () => "CurseForge APIキー",
    async render(body) {
      const st = await api("/api/settings");
      body.innerHTML = `<p>CurseForge の Mod を確認・ダウンロードするには公式APIキーが必要です。<a href="https://console.curseforge.com/" target="_blank" rel="noopener noreferrer">console.curseforge.com</a> で無料で発行できます。</p>
        <div class="result ${st.cf_api_key_set ? "ok" : ""}">${st.cf_api_key_set ? "登録済みです" : "まだ登録されていません"}</div>
        ${field(st.cf_api_key_set ? "新しいキー(変更する場合のみ)" : "APIキー", `<input type="password" name="cf" autocomplete="off">`)}
        <div class="df row2" style="padding:0"><button class="btn danger" type="button" id="cfDel"${st.cf_api_key_set ? "" : " hidden"}>削除</button><button class="btn filled" type="button" id="cfSave">保存</button></div>`;
      const save = (val, btn) => busy(btn, async () => {
        try { await api("/api/settings", { method: "PATCH", json: { cf_api_key: val } }); toast(val ? "保存しました" : "削除しました"); renderSettings(); }
        catch (ex) { toast(ex.message, true); }
      });
      $("#cfSave", body).onclick = (e) => { const v = $("[name=cf]", body).value.trim(); if (v) save(v, e.currentTarget); };
      $("#cfDel", body).onclick = (e) => save("", e.currentTarget);
    },
  },
  users: {
    title: () => "ユーザー",
    async render(body) {
      const { users } = await api("/api/users");
      body.innerHTML = `<p>アドオンやサーバーは基本的に<b>本人だけ</b>のものです(共有したものだけ、ほかの人に見えます)。<br>閲覧のみ: 共有されたものを見る・ダウンロード / 編集者: 自分のライブラリを持てる / 管理者: すべての管理。管理者は、ユーザーごとに管理の権限を個別に付けられます。</p>
        <div class="group">${users.map((u) => `<button class="row" type="button" data-uid="${u.id}"><span class="cicon sm c-teal">${icon("person")}</span>
          <span class="main"><span class="title">${esc(u.username)}${u.id === state.user.id ? "(自分)" : ""}</span><span class="subtitle">${esc(u.role_label)}${u.role !== "admin" && (u.perms || []).length ? ` + ${u.perms.map((p) => esc(PERM_LABELS[p] ? PERM_LABELS[p][0] : p)).join("・")}` : ""}${u.last_login ? ` · 最終ログイン ${fmtDateTime(u.last_login)}` : ""}</span></span>
          <span class="trail">${icon("chev", "i chev")}</span></button>`).join("")}</div>
        <button class="btn tinted block" type="button" id="uAdd">${icon("plus")}ユーザーを追加</button>`;
      body.onclick = (e) => {
        const r = e.target.closest("[data-uid]"); if (r) pushSettings("user", users.find((u) => u.id === Number(r.dataset.uid)));
      };
      $("#uAdd", body).onclick = () => pushSettings("user", null);
    },
  },
  cleanup: {
    title: () => "アドオンの整理",
    async render(body) {
      const own = (it) => !it.access || it.access === "owner";
      const editable = (it) => it.access !== "view";
      const latestOf = (it) => it.versions.find((v) => v.id === it.latest_id) || it.versions[0];
      const monthsAgo = (iso) => (Date.now() - new Date(iso).getTime()) / (30.4 * 86400000);
      const CONDS = {
        oldver: { label: "古いバージョン(新しい方から決まった数だけ残す)", param: ["残す数", 3], unit: "個" },
        dupver: { label: "同じバージョンの重複(同じバージョンのファイルが複数ある)" },
        stale_src: { label: "配布元で長く更新されていない", param: ["期間", 12], unit: "か月以上" },
        stale_lib: { label: "ライブラリに長く新しいバージョンが追加されていない", param: ["期間", 12], unit: "か月以上" },
        missing: { label: "保存先にファイルが見つからない(記録だけ残っている)" },
        samename: { label: "同じ名前のアドオンが別の種類で登録されている" },
      };
      body.innerHTML = `<p>条件に当てはまるものを抽出して、確かめてから削除できます。削除できるのは自分のアドオン(と、編集を任されたもののバージョン)だけです。</p>
        ${field("条件", `<select name="cond">${Object.entries(CONDS).map(([k, c]) => `<option value="${k}">${esc(c.label)}</option>`).join("")}</select>`)}
        <div id="cuParam"></div>
        ${field("種類(任意)", `<select name="cat"><option value="">すべての種類</option>${Object.entries(CATS).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select>`)}
        <button class="btn tinted block" type="button" id="cuRun">${icon("search")}抽出</button>
        <div id="cuOut"></div>`;
      const drawParam = () => {
        const c = CONDS[$("[name=cond]", body).value];
        $("#cuParam", body).innerHTML = c.param ? field(c.param[0], `<div class="chips"><input type="number" name="param" min="1" max="120" value="${c.param[1]}" class="compact-num"><span>${c.unit}</span></div>`) : "";
      };
      $("[name=cond]", body).onchange = () => { drawParam(); $("#cuOut", body).innerHTML = ""; };
      drawParam();
      let found = [];
      const extract = () => {
        const cond = $("[name=cond]", body).value, cat = $("[name=cat]", body).value;
        const n = Number($("[name=param]", body)?.value || 0);
        const items = state.items.filter((it) => !cat || it.category === cat);
        const out = [];  // { kind: "item"|"version", item, version?, reason, size }
        if (cond === "oldver") {
          for (const it of items.filter(editable)) {
            // it.versions は新しい順(バージョン番号 → 追加日時の順)に並んでいる
            const keep = new Set([it.latest_id, ...it.versions.slice(0, Math.max(1, n)).map((v) => v.id)]);
            for (const v of it.versions) if (!keep.has(v.id)) out.push({ kind: "version", item: it, version: v, reason: `${verLabel(v.version)}(${fmtDate(v.added_at)} 追加)`, size: v.size });
          }
        } else if (cond === "dupver") {
          for (const it of items.filter(editable)) {
            const groups = {};
            for (const v of it.versions) (groups[String(v.version).trim().toLowerCase() || "?"] ||= []).push(v);  // 新しい順のまま
            for (const g of Object.values(groups)) {
              if (g.length < 2) continue;
              // 先頭(いちばん新しいもの・最新として使っているもの)を残す
              for (const v of g.slice(1)) if (v.id !== it.latest_id) out.push({ kind: "version", item: it, version: v, reason: `${verLabel(v.version)} が ${g.length} 個(いちばん新しく追加したものを残します)`, size: v.size });
            }
          }
        } else if (cond === "stale_src") {
          for (const it of items.filter(own)) {
            const d = it.source && it.source.latest && it.source.latest.date;
            if (d && monthsAgo(d) >= n) out.push({ kind: "item", item: it, reason: `配布元の最終更新 ${fmtDate(d)}`, size: it.total_size });
          }
        } else if (cond === "stale_lib") {
          for (const it of items.filter(own)) if (monthsAgo(it.last_added) >= n) out.push({ kind: "item", item: it, reason: `最後に追加 ${fmtDate(it.last_added)}`, size: it.total_size });
        } else if (cond === "missing") {
          for (const it of items.filter(editable)) for (const v of it.versions) if (v.missing) out.push({ kind: "version", item: it, version: v, reason: `${verLabel(v.version)} のファイルが見つかりません`, size: 0 });
        } else if (cond === "samename") {
          const norm = (s) => s.toLowerCase().replace(/[\W_]+/g, "");
          const by = {};
          for (const it of items) (by[norm(it.name)] ||= []).push(it);
          for (const g of Object.values(by)) {
            if (new Set(g.map((x) => x.category)).size < 2) continue;
            for (const it of g.filter(own)) out.push({ kind: "item", item: it, reason: `${CATS[it.category]} として登録(ほかに ${g.filter((x) => x !== it).map((x) => CATS[x.category]).join("・")} にもあります)`, size: it.total_size, keepDefault: true });
          }
        }
        return out;
      };
      const drawOut = () => {
        const total = found.reduce((s, f) => s + f.size, 0);
        $("#cuOut", body).innerHTML = !found.length ? `<div class="result ok">条件に当てはまるものはありません</div>`
          : `<div class="group-title">${found.length} 件が見つかりました(${fmtSize(total)})</div>
          <div class="chips" style="margin:0 2px 6px"><button class="btn plain small" type="button" data-all="1">すべて選ぶ</button><button class="btn plain small" type="button" data-all="0">すべて外す</button></div>
          <div class="group scroll cu-list">${found.map((f, i) => `<label class="cu-row"><input type="checkbox" class="cbox" data-i="${i}"${f.keepDefault ? "" : " checked"}>
            ${itemIcon(f.item, true)}<span class="main"><span class="title" translate="no">${esc(f.item.name)}${f.kind === "version" ? ` <span class="badge">${esc(verLabel(f.version.version))}</span>` : ' <span class="badge err">アドオンごと</span>'}</span>
            <span class="subtitle">${esc(f.reason)}${f.size ? ` · ${fmtSize(f.size)}` : ""}</span></span></label>`).join("")}</div>
          ${found.some((f) => f.keepDefault) ? `<div class="group-foot">「同じ名前」は、どちらを消すべきか自動では決められないので、最初はすべて外してあります。残したいものを外したまま、消すものだけを選んでください。</div>` : ""}
          <button class="btn danger block" type="button" id="cuDel">${icon("trash")}選んだものを削除</button>`;
      };
      $("#cuRun", body).onclick = () => { found = extract(); drawOut(); };
      body.addEventListener("click", async (e) => {
        const all = e.target.closest("[data-all]");
        if (all) { body.querySelectorAll(".cu-list [data-i]").forEach((c) => { c.checked = all.dataset.all === "1"; }); return; }
        const del = e.target.closest("#cuDel"); if (!del) return;
        const pick = [...body.querySelectorAll(".cu-list [data-i]:checked")].map((c) => found[Number(c.dataset.i)]);
        if (!pick.length) { toast("削除するものを選んでください", true); return; }
        const nItems = pick.filter((f) => f.kind === "item").length, nVers = pick.length - nItems;
        if (!cfm(`${nItems ? `アドオン ${nItems} 件(保存しているすべてのバージョン)` : ""}${nItems && nVers ? "と" : ""}${nVers ? `バージョン ${nVers} 個` : ""}を削除します。\n保存先のファイルも削除され、元に戻せません。よろしいですか?`)) return;
        await busy(del, async () => {
          let ok = 0, ng = 0;
          for (const f of pick) {
            try { await api(f.kind === "item" ? `/api/items/${f.item.id}` : `/api/versions/${f.version.id}`, { method: "DELETE" }); ok++; }
            catch { ng++; }
          }
          toast(ng ? `${ok} 件を削除しました(${ng} 件は削除できませんでした)` : `${ok} 件を削除しました`, !!ng);
          await refresh();
          found = extract(); drawOut();
        }, "削除しています…");
      });
    },
  },
  feedback: {
    title: () => "お問い合わせ・要望",
    async render(body) {
      let kind = "request";
      body.innerHTML = `<p>機能の要望・不具合・質問などを、CraftShelf の開発者に送れます。</p>
        <div class="segmented seg-wide" role="group" aria-label="種類">${[["request", "要望"], ["bug", "不具合"], ["question", "質問"], ["other", "その他"]].map(([k, n]) => `<button class="seg" type="button" data-k="${k}" aria-pressed="${k === kind}">${n}</button>`).join("")}</div>
        ${field("内容", `<textarea name="message" rows="7" maxlength="4000" placeholder="例: サーバーの一覧をフォルダで分けられるようにしてほしい"></textarea>`)}
        ${field("返信先(任意。Discord の名前やメールアドレスなど)", `<input type="text" name="contact" maxlength="200" autocomplete="off">`)}
        <div class="group">${toggle("include_env", "バージョンと OS を添える", "不具合の調査に役立ちます(名前やアドレスなどは送りません)", true)}</div>
        <button class="btn filled block" type="button" id="fbSend">${icon("send")}送信する</button>
        <div class="group-foot">送った内容は開発者だけが見ます。返信先を書かなかった場合、開発者からの返信はできません。</div>`;
      body.querySelectorAll("[data-k]").forEach((b) => { b.onclick = () => { kind = b.dataset.k; body.querySelectorAll("[data-k]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); }; });
      $("#fbSend", body).onclick = (e) => busy(e.currentTarget, async () => {
        const message = $("[name=message]", body).value.trim();
        if (message.length < 2) { toast("内容を入力してください", true); return; }
        try {
          await api("/api/feedback", { json: { kind, message, contact: $("[name=contact]", body).value.trim(), include_env: $("[name=include_env]", body).checked } });
          toast("送信しました。ありがとうございます!");
          body.innerHTML = `<div class="empty sent-ok"><span class="cicon c-mod">${icon("check")}</span>
            <div class="title">送信しました</div><p>お問い合わせを開発者に届けました。ありがとうございます!</p>
            <button class="btn filled" type="button" id="fbBack">設定に戻る</button></div>`;
          $("#fbBack", body).onclick = () => popSettings();
        } catch (ex) { toast(ex.message, true); }
      }, "送信中…");
    },
  },
  telemetry: {
    title: () => "利用状況の送信",
    async render(body) {
      const t = await loadTelemetry();
      body.innerHTML = `<p>CraftShelf の改善のため、匿名の利用状況を 1 日 1 回、開発者に送ります。送る内容は次のものだけです。</p>
        ${teleWhat}
        <div class="group">${toggle("tele_on", "利用状況を送信する", t.last_sent ? `前回の送信: ${fmtDateTime(t.last_sent)}` : "", t.enabled)}</div>
        <details class="sect"><summary><span>実際に送る内容</span></summary><pre class="telepre">${esc(JSON.stringify(t.preview || {}, null, 2))}</pre></details>`;
      body.onchange = async (e) => {
        if (e.target.name !== "tele_on") return;
        try { await api("/api/settings", { method: "PATCH", json: { telemetry_enabled: e.target.checked } }); toast(e.target.checked ? "送信します。ありがとうございます!" : "送信をやめました"); await loadTelemetry(); }
        catch (ex) { toast(ex.message, true); e.target.checked = !e.target.checked; }
      };
    },
  },
  usage: {
    title: () => "ユーザーごとの利用状況",
    async render(body) {
      const d = await api("/api/admin/usage");
      const max = Math.max(1, ...d.users.map((u) => u.bytes));
      body.innerHTML = `<p>だれが、どれくらいのアドオン・サーバーを持っているかの一覧です。本人だけのもの(共有していないもの)は件数と容量だけを表示し、名前は表示しません。</p>
        <div class="group"><div class="card-b" style="padding:12px 14px"><div class="kv"><span>全員の合計</span><span>${fmtSize(d.total_bytes)} · ${d.users.reduce((n, u) => n + u.items, 0)} 件</span></div></div></div>
        ${d.users.map((u) => `<div class="group-title" translate="no">${esc(u.username)} <span class="muted" style="font-weight:400">${esc(u.role_label)}</span></div>
        <div class="group"><div class="card-b" style="padding:12px 14px">
          <div class="meter"><i style="width:${(u.bytes / max * 100).toFixed(1)}%"></i></div>
          <div class="kv"><span>アドオン</span><span>${u.items} 件 · ${u.files} ファイル · ${fmtSize(u.bytes)}</span></div>
          ${Object.keys(u.categories).length ? `<div class="kv sub"><span>内訳</span><span>${Object.entries(u.categories).map(([c, n]) => `${esc(CATS[c] || c)} ${n}`).join("・")}</span></div>` : ""}
          <div class="kv"><span>サーバー</span><span translate="no">${u.servers.length ? esc(u.servers.join("、")) : "なし"}</span></div>
          <div class="kv"><span>セット</span><span>${u.sets} 個</span></div>
          <div class="kv"><span>共有</span><span>ほかの人へ ${u.shared_out} 件 / ほかの人から ${u.shared_in} 件</span></div>
          ${u.shared_names.length ? `<div class="kv sub"><span>共有しているもの</span><span translate="no">${esc(u.shared_names.join("、"))}</span></div>` : ""}
          ${u.role !== "admin" && u.perms.length ? `<div class="kv"><span>管理の権限</span><span>${u.perms.map((p) => esc(PERM_LABELS[p] ? PERM_LABELS[p][0] : p)).join("・")}</span></div>` : ""}
          <div class="kv"><span>最終ログイン</span><span>${u.last_login ? esc(fmtDateTime(u.last_login)) : "なし"}</span></div>
        </div></div>`).join("")}`;
    },
  },
  user: {
    title: (u) => (u ? u.username : "ユーザーを追加"),
    async render(body, u) {
      const roleOpts = Object.entries(state.roles).map(([k, n]) => `<option value="${k}"${(u ? u.role : "editor") === k ? " selected" : ""}>${esc(n)}</option>`).join("");
      body.innerHTML = `${u ? "" : field("ユーザー名", `<input type="text" name="username" autocomplete="off">`)}
        ${field("権限", `<select name="role">${roleOpts}</select>`)}
        ${field(u ? "新しいパスワード(変更する場合のみ・8文字以上)" : "パスワード(8文字以上)", `<input type="password" name="password" autocomplete="new-password">`)}
        ${isAdmin() ? `<div class="group-title" id="uPermT">管理の権限(管理者はすべて持っています)</div>
          <div class="group" id="uPerms">${Object.entries(PERM_LABELS).map(([k, [t, d]]) => toggle(`perm_${k}`, t, d, !!u && (u.perms || []).includes(k))).join("")}</div>` : ""}
        <button class="btn filled block" type="button" id="uSave">${u ? "保存" : "追加"}</button>
        ${u && u.totp_enabled && u.id !== state.user.id ? `<button class="btn block" type="button" id="uTotp">二段階認証をリセット(スマホを紛失した場合)</button>` : ""}
        ${u && u.passkeys && u.id !== state.user.id ? `<button class="btn block" type="button" id="uPk">パスキーをすべて削除(${u.passkeys} 件。端末を紛失した場合)</button>` : ""}
        ${u && u.id !== state.user.id ? `<button class="btn danger block" type="button" id="uDel">このユーザーを削除</button>` : ""}`;
      $("#uPk", body)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        if (!cfm(`「${u.username}」のパスキーをすべて削除しますか?(このユーザーはパスワードでログインし、パスキーを登録し直します)`)) return;
        try { await api(`/api/users/${u.id}`, { method: "PATCH", json: { reset_passkeys: true } }); toast("パスキーを削除しました"); popSettings(); } catch (ex) { toast(ex.message, true); }
      }));
      $("#uTotp", body)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        if (!cfm(`「${u.username}」の二段階認証をリセットしますか?`)) return;
        try { await api(`/api/users/${u.id}`, { method: "PATCH", json: { reset_totp: true } }); toast("リセットしました"); popSettings(); } catch (ex) { toast(ex.message, true); }
      }));
      const syncPerm = () => { const adm = $("[name=role]", body).value === "admin"; $("#uPerms", body) && ($("#uPerms", body).hidden = adm); $("#uPermT", body) && ($("#uPermT", body).hidden = adm); };
      $("[name=role]", body).addEventListener("change", syncPerm); syncPerm();
      $("#uSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        const d = { role: $("[name=role]", body).value };
        if (isAdmin()) d.perms = Object.keys(PERM_LABELS).filter((k) => $(`[name=perm_${k}]`, body)?.checked);
        const pw = $("[name=password]", body).value;
        try {
          if (u) { if (pw) d.password = pw; await api(`/api/users/${u.id}`, { method: "PATCH", json: d }); }
          else { d.username = $("[name=username]", body).value.trim(); d.password = pw; await api("/api/users", { json: d }); }
          toast("保存しました"); popSettings();
        } catch (ex) { toast(ex.message, true); }
      });
      $("#uDel", body)?.addEventListener("click", async (e) => {
        if (!cfm(`「${u.username}」を削除しますか?\nこの人のアドオン・サーバー・セットは、あなたに引き継がれます。`)) return;
        await busy(e.currentTarget, async () => {
          try { await api(`/api/users/${u.id}`, { method: "DELETE" }); toast("削除しました"); popSettings(); }
          catch (ex) { toast(ex.message, true); }
        });
      });
    },
  },
  storage: {
    title: () => "ストレージ",
    async render(body) {
      state.targets = (await api("/api/storage/targets")).targets;
      body.innerHTML = `<p>保存先ごとに独立したライブラリを持ちます。切り替えると一覧もその保存先のものに変わります。</p>
        <div class="group">${state.targets.map((t) => `<button class="row" type="button" data-tid="${t.id}">
          <span class="cicon sm ${t.protocol === "local" ? "c-gray" : t.protocol === "webdav" ? "c-teal" : "c-plugin"}">${icon(t.protocol === "local" ? "box" : "server")}</span>
          <span class="main"><span class="title">${esc(t.name)}</span><span class="subtitle">${esc(t.protocol_label)} · ${t.item_count ?? 0} 件${t.protocol !== "local" ? ` · ${esc(t.server)}` : ""}</span></span>
          <span class="trail">${t.active ? '<span class="badge ok">使用中</span>' : ""}<span class="status-dot ${t.mounted ? "ok" : "err"}"></span>${icon("chev", "i chev")}</span></button>`).join("")}</div>
        <button class="btn tinted block" type="button" id="tAdd">${icon("plus")}接続を追加</button>`;
      body.onclick = (e) => { const r = e.target.closest("[data-tid]"); if (r) pushSettings("target", Number(r.dataset.tid)); };
      $("#tAdd", body).onclick = () => pushSettings("targetEdit", null);
    },
  },
  target: {
    title: (tid) => state.targets.find((t) => t.id === tid)?.name || "保存先",
    async render(body, tid) {
      state.targets = (await api("/api/storage/targets")).targets;
      const t = state.targets.find((x) => x.id === tid);
      if (!t) { popSettings(); return; }
      const detail = t.protocol === "local" ? "コンテナにつないだフォルダ(/data)"
        : t.protocol === "webdav" ? `${t.server}${t.subpath ? " / " + t.subpath : ""}`
        : `\\\\${t.server}\\${t.share}${t.subpath ? "\\" + t.subpath : ""}`;
      body.innerHTML = `<div class="group">
          <div class="row noicon"><span class="main"><span class="title">種類</span></span><span class="trail">${esc(t.protocol_label)}</span></div>
          <div class="row noicon"><span class="main"><span class="title">場所</span><span class="subtitle" style="white-space:normal;word-break:break-all">${esc(detail)}</span></span></div>
          ${t.protocol !== "local" ? `<div class="row noicon"><span class="main"><span class="title">ユーザー</span></span><span class="trail">${t.username ? esc(t.username) : t.protocol === "smb" ? "ゲスト" : "なし"}</span></div>` : ""}
          <div class="row noicon"><span class="main"><span class="title">状態</span></span><span class="trail"><span class="status-dot ${t.mounted ? "ok" : "err"}"></span>${t.mounted ? "接続中" : "未接続"}</span></div>
          <div class="row noicon"><span class="main"><span class="title">登録数</span></span><span class="trail">${t.item_count ?? 0} 件</span></div>
        </div>
        ${!t.supported ? `<div class="result err">この方式には対応しなくなりました。「編集」で SMB に変更してください。</div>` : ""}
        ${t.last_error ? `<div class="result err">前回のエラー: ${esc(t.last_error)}</div>` : ""}
        <div class="result" id="tRes" hidden></div>
        <div class="group">
          ${t.active && (t.protocol === "local" || t.mounted) ? "" : `<button class="row tint noicon" type="button" data-ta="activate"><span class="main"><span class="title">${t.active ? "再接続" : "この保存先を使う"}</span></span></button>`}
          <button class="row noicon" type="button" data-ta="contents"><span class="main"><span class="title">中身を確認</span></span><span class="trail">${icon("chev", "i chev")}</span></button>
          <button class="row noicon" type="button" data-ta="migrate"><span class="main"><span class="title">ほかの保存先へ移行</span></span><span class="trail">${icon("chev", "i chev")}</span></button>
          ${t.protocol !== "local" ? `<button class="row noicon" type="button" data-ta="test"><span class="main"><span class="title">接続テスト</span></span></button>
          <button class="row noicon" type="button" data-ta="edit"><span class="main"><span class="title">編集</span></span><span class="trail">${icon("chev", "i chev")}</span></button>` : ""}
          ${t.protocol !== "local" && !t.active ? `<button class="row danger noicon" type="button" data-ta="delete"><span class="main"><span class="title">この接続を削除</span></span></button>` : ""}
        </div>`;
      body.onclick = async (e) => {
        const b = e.target.closest("[data-ta]"); if (!b) return;
        const a = b.dataset.ta;
        if (a === "contents") return pushSettings("contents", tid);
        if (a === "migrate") return pushSettings("migrate", tid);
        if (a === "edit") return pushSettings("targetEdit", t);
        const res = $("#tRes", body);
        const title = $(".title", b);
        const old = title.innerHTML;
        title.innerHTML = `<span class="spinner"></span> 処理中…`; b.disabled = true;
        try {
          if (a === "activate") {
            await api(`/api/storage/targets/${tid}/activate`, { method: "POST" });
            toast(`「${t.name}」に切り替えました`); await refresh(); renderSettings(); return;
          }
          if (a === "test") {
            const r = await api(`/api/storage/targets/${tid}/test`, { method: "POST" });
            res.hidden = false; res.className = "result " + (r.ok ? "ok" : "err");
            res.textContent = r.message + (r.entries ? (r.entries.length ? `\n中身(先頭${r.entries.length}件): ${r.entries.join(", ")}` : "\n(空のフォルダです)") : "");
          }
          if (a === "delete") {
            if (!cfm(`「${t.name}」を削除しますか?`)) return;
            await api(`/api/storage/targets/${tid}`, { method: "DELETE" }); toast("削除しました"); popSettings(); return;
          }
        } catch (ex) { res.hidden = false; res.className = "result err"; res.textContent = ex.message; }
        finally { if (b.isConnected) { title.innerHTML = old; b.disabled = false; } }
      };
    },
  },
  targetEdit: {
    title: (t) => (t ? "接続を編集" : "接続を追加"),
    async render(body, t) {
      const proto = t && t.supported ? t.protocol : "smb";
      body.innerHTML = `
        ${field("名前", `<input type="text" name="name" value="${esc(t?.name || "")}" placeholder="例: Unraid">`)}
        ${field("種類", `<select name="protocol"><option value="smb"${proto === "smb" ? " selected" : ""}>SMB(Windows共有 / Unraid・TrueNAS)</option><option value="webdav"${proto === "webdav" ? " selected" : ""}>WebDAV(Nextcloud など)</option></select>`)}
        <p id="pHint"></p>
        <label class="field"><span id="pServer">サーバー</span><input type="text" name="server" value="${esc(t?.server || "")}"></label>
        <label class="field" id="pShare"><span>共有名</span><input type="text" name="share" value="${esc(t?.share || "")}" placeholder="minecraft"></label>
        ${field("サブフォルダ(任意)", `<input type="text" name="subpath" value="${esc(t?.subpath || "")}" placeholder="例: minecraft/library">`)}
        <label class="field"><span id="pUser">ユーザー名</span><input type="text" name="username" value="${esc(t?.username || "")}" autocomplete="off"></label>
        ${field(t ? "パスワード(変更しない場合は空欄)" : "パスワード", `<input type="password" name="password" autocomplete="new-password">`)}
        <label class="field" id="pDomain"><span>ドメイン(任意)</span><input type="text" name="domain" value="${esc(t?.domain || "")}"></label>
        <div class="group" id="pTls">${toggle("tls_insecure", "証明書を検証しない", "自己署名証明書を使っている場合", t?.tls_insecure)}</div>
        <div class="result" id="pRes" hidden></div>
        <div class="df row2" style="padding:0"><button class="btn" type="button" id="pTest">接続テスト</button><button class="btn filled" type="button" id="pSave">保存</button></div>`;
      const sel = $("[name=protocol]", body);
      const sync = () => {
        const smb = sel.value === "smb";
        $("#pShare", body).hidden = !smb; $("#pDomain", body).hidden = !smb; $("#pTls", body).hidden = smb;
        $("#pServer", body).textContent = smb ? "サーバー(IPアドレス・ホスト名)" : "URL";
        $("[name=server]", body).placeholder = smb ? "192.168.1.10" : "https://cloud.example.com";
        $("#pUser", body).textContent = smb ? "ユーザー名(空欄ならゲスト接続)" : "ユーザー名";
        $("#pHint", body).textContent = smb ? "Unraid の「パブリック」共有なら、ユーザー名は空欄で接続できます。"
          : "Nextcloud ならサーバーのURLだけでOKです。二段階認証を使っている場合は「アプリパスワード」を入力してください。";
      };
      sel.onchange = sync; sync();
      const collect = () => {
        const d = {};
        body.querySelectorAll("[name]").forEach((x) => { d[x.name] = x.type === "checkbox" ? x.checked : x.value; });
        return d;
      };
      const res = $("#pRes", body);
      $("#pTest", body).onclick = (e) => busy(e.currentTarget, async () => {
        const d = collect();
        try {
          const r = t && !d.password ? await api(`/api/storage/targets/${t.id}/test`, { method: "POST" }) : await api("/api/storage/targets/test", { json: d });
          res.hidden = false; res.className = "result " + (r.ok ? "ok" : "err");
          res.textContent = r.message + (r.entries ? (r.entries.length ? `\n中身(先頭${r.entries.length}件): ${r.entries.join(", ")}` : "\n(空のフォルダです)") : "");
        } catch (ex) { res.hidden = false; res.className = "result err"; res.textContent = ex.message; }
      }, "接続中…");
      $("#pSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        const d = collect();
        if (t && !d.password) delete d.password;
        try {
          if (t) await api(`/api/storage/targets/${t.id}`, { method: "PATCH", json: d });
          else await api("/api/storage/targets", { json: d });
          toast(t ? "更新しました" : "追加しました"); popSettings();
        } catch (ex) { res.hidden = false; res.className = "result err"; res.textContent = ex.message; }
      });
    },
  },
  contents: {
    title: () => "中身",
    async render(body, tid) {
      body.innerHTML = `<div style="text-align:center;padding:24px"><span class="spinner lg"></span><p style="margin-top:10px">読み込んでいます…(ネットワーク上の保存先は時間がかかることがあります)</p></div>`;
      const d = await api(`/api/storage/targets/${tid}/contents`);
      body.innerHTML = `<p style="word-break:break-all">${esc(d.where)}</p>
        <div class="group"><div class="row noicon"><span class="main"><span class="title">${d.totals.items} 件 · ${d.totals.files} ファイル</span></span><span class="trail">${fmtSize(d.totals.size)}</span></div>
          ${d.totals.missing ? `<div class="row noicon danger"><span class="main"><span class="title">見つからないファイル</span></span><span class="trail">${d.totals.missing}</span></div>` : ""}</div>
        <div class="group-title">登録されているもの</div>
        <div class="group scroll">${d.items.map((i) => `<div class="row"><span class="cicon sm c-${i.category}">${catGlyph(i.category)}</span>
          <span class="main"><span class="title">${esc(i.name)}</span><span class="subtitle">${esc(verLabel(i.latest))} · ${i.versions} バージョン · ${fmtSize(i.total_size)}</span></span>
          ${i.missing ? '<span class="badge err">欠損</span>' : ""}</div>`).join("") || `<div class="empty">登録されたものはありません</div>`}</div>
        ${d.unregistered.count ? `<div class="group-title">未登録のファイル(${d.unregistered.count})</div><div class="filelist">${esc(d.unregistered.files.join("\n"))}</div>
          <div class="group-foot">この保存先に切り替えて「inbox を取り込む」で登録できます</div>` : ""}
        ${d.inbox.count ? `<div class="group-title">inbox(${d.inbox.count})</div><div class="filelist">${esc(d.inbox.files.join("\n"))}</div>` : ""}`;
    },
  },
  migrate: {
    title: () => "移行",
    async render(body, tid) {
      state.targets = (await api("/api/storage/targets")).targets;
      const src = state.targets.find((x) => x.id === tid);
      const others = state.targets.filter((x) => x.id !== tid);
      if (!others.length) { body.innerHTML = `<div class="result">移行先になる保存先がありません。先に「接続を追加」してください。</div>`; return; }
      body.innerHTML = `<p>「${esc(src.name)}」に登録されているファイルと情報(バージョン・メモ・配布元の紐付け)を、別の保存先へ移します。移行先に同じファイルがあればスキップするので、何度実行しても重複しません。</p>
        ${field("移行先", `<select name="dest">${others.map((x) => `<option value="${x.id}">${esc(x.name)}(${esc(x.protocol_label)})</option>`).join("")}</select>`)}
        ${field("方法", `<select name="mode"><option value="copy">コピー(移行元にも残す)</option><option value="move">移動(コピーできたものを移行元から削除)</option></select>`)}
        <button class="btn filled block" type="button" id="mGo">移行を開始</button>`;
      $("#mGo", body).onclick = (e) => busy(e.currentTarget, async () => {
        const mode = $("[name=mode]", body).value;
        if (mode === "move" && !cfm(`コピーに成功したファイルは「${src.name}」から削除されます。よろしいですか?`)) return;
        try {
          jobStarted(await api("/api/storage/migrate", { json: { source_id: tid, dest_id: Number($("[name=dest]", body).value), mode } }));
          $("#dlg").close();
        } catch (ex) { toast(ex.message, true); }
      }, "開始しています…");
    },
  },
  selfupdate: {
    title: () => "パネルのアップデート",
    async render(body) {
      const d = await checkSelfUpdate(true);
      if (!d) throw new Error("確認できませんでした");
      const CH = {
        stable: ["安定版", "おすすめ", "動作を確認した正式なバージョンだけを受け取ります。"],
        dev: ["開発ビルド", "", "新しい機能をいち早く試せる代わりに、不具合が含まれることがあります。いつでも安定版に戻せます。"],
        preview: ["プレビュー", "v03・開発中", "次の大きなバージョン(v03)の開発の様子を確かめられます。v03 は作りが新しくなるため、このパネルからは切り替えられません(移る方法は、v03 の公開に合わせて案内します)。"],
      };
      const ch = CH[d.channel] ? d.channel : "stable";
      const back = d.downgrade ? (d.major_down ? `プレビュー v${esc(d.current)} から` : `いまは v${esc(d.current)} です。`) : "";
      body.innerHTML = `<div class="big-version"><img class="logo" src="/static/icon.svg" alt="" aria-hidden="true">
          <div class="v">${d.update_available ? `v${esc(d.latest)}` : `v${esc(d.current)}`}${ch !== "stable" ? ` <span class="badge upd">${CH[ch][0]}</span>` : ""}</div>
          <p>${d.error ? esc(d.error) : d.update_available ? `現在 v${esc(d.current)} · 新しいバージョンがあります`
            : d.downgrade ? `${back}${CH[ch][0]}の最新は v${esc(d.latest)} です` : "CraftShelf は最新です"}</p></div>
        ${d.data_too_new ? `<div class="result err">このデータは、このバージョンより新しいバージョンで作られています。表示や操作がおかしい場合は、下の「アップデートの前の状態」から戻すか、元の受け取り先に戻してください。</div>` : ""}
        <div class="group-title">受け取るアップデート</div>
        <div class="group">${Object.entries(CH).map(([k, [n, tag, desc]]) => `<label class="toggle-row ch-row"><span class="main">${n}${tag ? ` <span class="badge${k === "preview" ? " upd" : " ok"}">${tag}</span>` : ""}<small>${desc}</small></span>
          <input type="radio" class="switch" name="update_channel" value="${k}"${k === ch ? " checked" : ""}></label>`).join("")}</div>
        ${d.blocked ? `<div class="result warn">${esc(d.blocked)}</div>` : ""}
        ${d.major_up && d.update_available && !d.blocked ? `<div class="result">${icon("shield")} v${esc(d.current)} → v${esc(d.latest)} は大きなアップデートです。インストールの前に、いまのデータを自動で退避します(下の「アップデートの前の状態」からいつでも戻せます)。</div>` : ""}
        ${d.downgrade && !d.blocked ? `<button class="btn tinted block" type="button" id="suDown">${icon("download")}${CH[ch][0]} v${esc(d.latest)} に戻す</button>` : ""}
        ${d.notes && d.notes.length ? (() => {  // 最新の更新内容だけを開いて出し、それより前のものはたたむ
          const note = (n) => `<h4>v${esc(n.version)} ${esc(n.title)}</h4><div class="body">${esc(n.body)}</div>`;
          const [head, ...rest] = d.notes;
          return `<div class="notes">${note(head)}${rest.length ? `<details class="notes-more"><summary>それより前の更新(${rest.length} 件)</summary>${rest.map(note).join("")}</details>` : ""}</div>`;
        })() : ""}
        ${d.blocked ? "" : d.update_available && d.mode === "installer" && !d.can_apply ? `<a class="btn filled block" href="${esc(safeUrl(d.download_url))}" target="_blank" rel="noopener noreferrer">${icon("download")}新しいインストーラーをダウンロード</a>
          <div class="group-foot" style="text-align:center">ダウンロードしたインストーラーを実行すると、上書きでアップデートされます。保存したファイルや登録情報はそのまま残ります。</div>`
          : d.update_available ? `<button class="btn filled block" type="button" id="suGo">ダウンロードしてインストール</button>
          <div class="group-foot" style="text-align:center">インストールの前にデータを退避し、インストール後に自動で再起動します(数秒〜数十秒)。</div>`
          : `<button class="btn tinted block" type="button" id="suRe">${icon("refresh")}もう一度確認</button>`}
        ${d.mode === "installer" && !d.can_apply ? "" : `<div class="group" style="margin-top:6px">${toggle("self_auto_update", "自動アップデート", "6時間ごとに確認し、新しいバージョンがあれば自動でインストールします(大きなバージョンアップは自動では行いません)", (await api("/api/settings")).self_auto_update)}</div>`}
        <div class="group-title">アップデートの前の状態</div>
        <div id="suSnaps"><div class="empty"><span class="spinner"></span></div></div>
        <div class="group-foot">取得元: <a href="https://github.com/${esc(d.repo)}" target="_blank" rel="noopener noreferrer">github.com/${esc(d.repo)}</a> (${esc(d.branch)}${d.mode === "installer" ? " · リリース" : ""}) · データの保存方法 ${esc(String(d.data_in_use || 1))}(このバージョンは ${esc(String((d.this_format || {}).read || 1))} まで読めます)</div>`;
      const loadSnaps = async () => {
        let s;
        try { s = await api("/api/system/snapshots"); } catch (ex) { $("#suSnaps", body).innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
        $("#suSnaps", body).innerHTML = `${s.pending ? `<div class="result">次の起動で「${esc(s.pending)}」の状態に戻します${s.frozen ? "。CraftShelf を終了して、もう一度起動してください" : ""}</div>` : ""}
          <div class="group">${s.snapshots.map((x) => `<div class="row"><span class="cicon sm c-teal">${icon("clock")}</span>
            <span class="main"><span class="title">v${esc(x.version || "?")} · ${esc(x.created_at ? fmtDateTime(x.created_at) : x.name)}</span><span class="subtitle">${esc(x.reason || "")} · ${fmtSize(x.size)}</span></span>
            <span class="trail">${x.can_restore ? `<button class="btn small" type="button" data-snap="${esc(x.name)}">この状態に戻す</button>` : '<span class="badge">このバージョンでは読めません</span>'}</span></div>`).join("")
            || `<div class="empty">まだありません(アップデートのたびに自動で作られます)</div>`}</div>
          <div class="group-foot">アップデートの直前に、登録情報(データベース)と鍵を退避しています(直近 5 回分)。保存しているアドオンのファイルはそのままです。</div>`;
      };
      loadSnaps();
      $("#suSnaps", body).addEventListener("click", async (e) => {
        const b = e.target.closest("[data-snap]"); if (!b) return;
        if (!(cfm(["この状態に戻しますか?", "登録情報(アドオン・サーバー・設定など)を、そのときの状態に戻します。それ以降に変えた登録情報は戻した状態になります(いまのデータも念のため残します)。CraftShelf を再起動します。"].join("\n\n")))) return;
        try { const r = await api(`/api/system/snapshots/${encodeURIComponent(b.dataset.snap)}/restore`, { method: "POST" }); toast(r.restart ? "戻して再起動します…" : "次の起動で戻します。CraftShelf を終了して、もう一度起動してください"); if (r.restart) setTimeout(() => location.reload(), 6000); else loadSnaps(); }
        catch (ex) { toast(ex.message, true); }
      });
      $("#suRe", body)?.addEventListener("click", (e) => busy(e.currentTarget, () => renderSettings(), "確認中…"));
      $("#suGo", body)?.addEventListener("click", async (e) => {
        if (d.major_up && !(cfm([`v${d.latest} にアップデートしますか?`, "大きなアップデートです。いまのデータを自動で退避してからインストールします。不具合があれば、安定版・開発ビルドに切り替えて戻せます。"].join("\n\n")))) return;
        busy(e.currentTarget, () => startSelfUpdate(d), "開始しています…");
      });
      $("#suDown", body)?.addEventListener("click", async (e) => {
        if (!(cfm([`${CH[ch][0]} v${d.latest} に戻しますか?`, "いまのバージョンで追加された機能は使えなくなります。登録したファイルや情報はそのまま残ります(戻す前の状態も自動で退避します)。"].join("\n\n")))) return;
        busy(e.currentTarget, () => startSelfUpdate(d), "開始しています…");
      });
      body.onchange = async (e) => {
        if (e.target.name === "update_channel") {
          const k = e.target.value;
          if (k === "dev" && !(cfm(["開発ビルドを受け取りますか?", CH.dev[2]].join("\n\n")))) { renderSettings(); return; }
          if (k === "preview" && !(cfm(["プレビュー(v03・開発中)を受け取りますか?", CH.preview[2]].join("\n\n")))) { renderSettings(); return; }
          try { await api("/api/settings", { method: "PATCH", json: { update_channel: k } }); toast(`${CH[k][0]}を受け取ります`); renderSettings(); }
          catch (ex) { toast(ex.message, true); }
          return;
        }
        if (e.target.name !== "self_auto_update") return;
        try { await api("/api/settings", { method: "PATCH", json: { self_auto_update: e.target.checked } }); toast("保存しました"); }
        catch (ex) { toast(ex.message, true); }
      };
    },
  },
};

/* ---------------- パネル自身のアップデート ---------------- */
/* ---------------- 匿名の利用状況・お問い合わせ ---------------- */
async function loadTelemetry() {
  try { state.tele = await api("/api/telemetry"); } catch { state.tele = null; }
  return state.tele;
}
const teleWhat = `<ul class="telelist">
  <li>CraftShelf のバージョン・受け取っているバージョン(安定版 / 開発ビルド)</li>
  <li>OS・CPU の種類・導入方法(Docker / インストーラー / install.sh)・表示言語</li>
  <li>アドオン・ユーザー・サーバー・セットの<b>おおよその数</b>(「10〜49」のような幅だけ)</li>
  <li>使っている保存先の種類・機能(Pterodactyl 連携を使っているか、など)・扱っている種類</li>
  <li>ランダムな設置 ID(どの人・どのサーバーかは分かりません)</li></ul>
  <p class="teleno">アドオンやサーバーの名前、ファイル名、ユーザー名、アドレス、IP アドレスなどは<b>送りません</b>。</p>`;
async function askTelemetry() {
  const t = state.tele;
  if (!t || !t.available || t.asked || $("#dlg").open || !can("system")) return;
  const r = await sheet(`<div class="db" style="padding-top:22px">
      <div class="big-version" style="margin-bottom:6px"><img class="logo" src="/static/icon.svg" alt="" aria-hidden="true"></div>
      <h3 style="text-align:center;margin:0 0 6px">CraftShelf の改善にご協力ください</h3>
      <p>どんな環境でどの機能が使われているかを知るために、<b>匿名の利用状況</b>を 1 日 1 回、開発者に送ってもよいですか? 送る内容は次のものだけです。</p>
      ${teleWhat}
      <details class="sect"><summary><span>実際に送る内容を見る</span></summary><pre class="telepre">${esc(JSON.stringify(t.preview || {}, null, 2))}</pre></details>
      <p style="font-size:12.5px;color:var(--label-2)">あとから ⚙ →「利用状況の送信」でいつでも変えられます。</p>
    </div><div class="df row2"><button class="btn" type="button" data-no>送らない</button><button class="btn filled" type="button" data-yes>送って協力する</button></div>`, (form, done) => {
    form.querySelector("[data-no]").onclick = () => done("0");
    form.querySelector("[data-yes]").onclick = () => done("1");
  });
  if (r === null) return;  // 閉じただけなら、次回また聞く
  try { await api("/api/settings", { method: "PATCH", json: { telemetry_enabled: r === "1" } }); state.tele.asked = true; state.tele.enabled = r === "1"; toast(r === "1" ? "ありがとうございます!" : "送らない設定にしました"); }
  catch (e) { toast(e.message, true); }
}

/* パネルの新しいバージョンのお知らせ(閉じたら、そのバージョンでは出さない) */
function drawUpdBanner(d) {
  const b = $("#updBanner");
  let dismissed = "";
  try { dismissed = localStorage.getItem("craftshelf.updDismissed") || ""; } catch { /* */ }
  const show = d && d.update_available && d.latest && dismissed !== d.latest;
  b.hidden = !show;
  if (!show) return;
  const first = (d.notes || [])[0];
  b.innerHTML = `<span>${icon("sparkle")} <b>CraftShelf v${esc(d.latest)}</b> が公開されています${first && first.title ? `: ${esc(first.title)}` : ""}</span>
    <span class="sp"></span><button class="btn small filled" type="button" id="updOpen">${d.mode === "installer" ? "内容を見る" : "内容を見てアップデート"}</button>
    <button class="icon-btn sm" type="button" id="updClose" title="閉じる" aria-label="閉じる">${icon("x")}</button>`;
  $("#updOpen").onclick = () => openSettings("selfupdate");
  $("#updClose").onclick = () => { try { localStorage.setItem("craftshelf.updDismissed", d.latest); } catch { /* */ } b.hidden = true; };
}
async function checkSelfUpdate(force) {
  try {
    const d = await api("/api/system/update" + (force ? "?force=1" : ""));
    state.selfUpd = d;
    const btn = $("#settingsBtn");
    btn.querySelector(".dot")?.remove();
    if (d.update_available) btn.insertAdjacentHTML("beforeend", '<span class="dot" title="パネルの新しいバージョンがあります"></span>');
    drawUpdBanner(d);
    return d;
  } catch (e) { if (force) toast(e.message, true); return null; }
}
async function startSelfUpdate(d) {
  let job;
  try { job = await api("/api/system/update", { method: "POST" }); }
  catch (e) { toast(e.message, true); return; }
  if ($("#dlg").open) $("#dlg").close();
  const from = d.current, to = d.latest;
  const ov = $("#updating"), card = $("#updatingCard");
  ov.hidden = false;
  const steps = ["ダウンロード", "インストール", "再起動"];
  const draw = (stepIdx, msg, failed = false) => {
    card.innerHTML = `${failed ? `<span class="cicon c-red" style="width:56px;height:56px;border-radius:50%">${icon("x")}</span>` : stepIdx >= 3 ? `<span class="cicon c-mod" style="width:56px;height:56px;border-radius:50%">${icon("check")}</span>` : '<span class="spinner lg"></span>'}
      <h3>${failed ? "アップデートできませんでした" : stepIdx >= 3 ? `v${esc(to)} になりました` : `v${esc(to)} にアップデート中`}</h3>
      <div class="steps">${steps.map((s, i) => `<div class="step ${i < stepIdx ? "done" : i === stepIdx && !failed ? "doing" : ""}"><span class="mk">${i < stepIdx ? icon("check") : i === stepIdx && !failed ? '<span class="spinner" style="width:14px;height:14px"></span>' : ""}</span>${s}</div>`).join("")}</div>
      <p style="margin:0;color:var(--label-2);font-size:13px">${esc(msg)}</p>
      ${failed ? '<button class="btn filled block" type="button" id="updClose">閉じる</button>' : ""}`;
    $("#updClose")?.addEventListener("click", () => { ov.hidden = true; });
  };
  draw(0, d.mode === "installer" ? "GitHub から新しいバージョンをダウンロードしています…(画面を閉じずにお待ちください)" : "GitHub から取得しています…(画面を閉じずにお待ちください)");
  const t0 = Date.now();
  let restarting = false;
  while (Date.now() - t0 < 6 * 60 * 1000) {
    await sleep(1500);
    if (!restarting) {
      try {
        const j = await api(`/api/jobs/${job.id}`);
        const log = j.log.join("\n");
        if (j.status === "error") { draw(1, j.log[j.log.length - 1] || "エラーが発生しました", true); return; }
        if (j.status === "done") { restarting = true; draw(2, "再起動しています…"); continue; }
        draw(/インストール/.test(log) ? 1 : 0, j.log[j.log.length - 1] || "");
      } catch { restarting = true; draw(2, "再起動しています…"); }
    } else {
      try {
        const info = await (await fetch("/api/system/info", { cache: "no-store" })).json();
        if (info.version && info.version !== from) { draw(3, "画面を読み込み直します…"); await sleep(1200); location.reload(); return; }
      } catch { /* 再起動中 */ }
    }
  }
  draw(2, "時間がかかっています。しばらくしてから画面を再読み込みしてください", true);
}

