"use strict";
/* CraftShelf — 画面の処理 */

const $ = (s, root = document) => root.querySelector(s);
const CATS = { plugin: "プラグイン", mod: "Mod", datapack: "データパック", resourcepack: "リソースパック", other: "その他" };
const CAT_LETTER = { plugin: "P", mod: "M", datapack: "D", resourcepack: "R", other: "?" };
const PROVIDERS = { modrinth: "Modrinth", spigot: "SpigotMC", curseforge: "CurseForge" };
const SRC_STATUS = { up_to_date: "最新", update: "更新あり", error: "確認できません", unchecked: "未確認" };
const state = {
  items: [], cat: "all", q: "", sortKey: "name", sortDir: 1, selected: null, verOrder: "desc",
  storage: {}, version: null, build: null, user: null, roles: {}, jobs: [], candidates: {}, targets: [], selfUpd: null,
};

/* ---------------- icons (SF Symbols 風の線画) ---------------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  tray: '<path d="M4 13h4l1.5 3h5L16 13h4"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12l9-9M16 7l3 3M18 5l2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  wand: '<path d="M4 20L15 9"/><path d="M14 4v3M12.5 5.5h3M19 9v3M17.5 10.5h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  arrows: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  stack: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
};
const icon = (name, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* ---------------- 予期しないエラーを画面に出す(原因を突き止めやすくする) ---------------- */
let lastErrAt = 0;
function reportError(msg) {
  if (Date.now() - lastErrAt < 3000) return;
  lastErrAt = Date.now();
  try { toast(`画面でエラーが発生しました: ${msg}(画面を再読み込みしてください)`, true); } catch { /* */ }
}
window.addEventListener("error", (e) => reportError(e.message || "不明なエラー"));
window.addEventListener("unhandledrejection", (e) => reportError((e.reason && e.reason.message) || String(e.reason)));

/* ---------------- utils ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* 外部から来たURLは http(s) のみ許可(javascript: などを防ぐ) */
const safeUrl = (u) => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : "#"; } catch { return "#"; } };
const fmtSize = (n) => {
  if (!n && n !== 0) return "-";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + " " + u[i];
};
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }) : "";
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const verLabel = (v) => v || "バージョン不明";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEditor = () => state.user && (state.user.role === "editor" || state.user.role === "admin");
const isAdmin = () => state.user && state.user.role === "admin";

async function api(path, opts = {}) {
  opts.headers = { "X-Requested-With": "mcpl", ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
    opts.method = opts.method || "POST";
  }
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error("サーバーに接続できません"); }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (res.status === 401 && !path.startsWith("/api/auth/")) showAuth(false);
  if (!res.ok) throw new Error((data && data.error) || `エラー (HTTP ${res.status})`);
  return data;
}
function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast glass" + (isErr ? " err" : "");
  el.innerHTML = `<span class="ic">${icon(isErr ? "x" : "check")}</span><span></span>`;
  el.lastChild.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3800);
}
/* ボタンを押したら処理中の表示にして、終わるまで押せなくする(連打防止) */
async function busy(btn, fn, label = "処理中…") {
  if (!btn) return fn();
  if (btn.classList.contains("is-busy")) return undefined;
  const html = btn.innerHTML;
  btn.classList.add("is-busy"); btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${label ? `<span>${esc(label)}</span>` : ""}`;
  try { return await fn(); }
  finally { if (btn.isConnected) { btn.classList.remove("is-busy"); btn.disabled = false; btn.innerHTML = html; } }
}

/* ---------------- dialogs (sheet) ---------------- */
function sheet(html, setup, { wide = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $("#dlg"), form = $("#dlgForm");
    dlg.classList.toggle("wide", wide);
    form.innerHTML = html;
    let finished = false;
    const done = (val) => { if (finished) return; finished = true; dlg.onclose = null; if (dlg.open) dlg.close(); resolve(val); };
    form.onsubmit = (e) => e.preventDefault();
    // close イベントは閉じた少し後に届くため、直前に閉じたシートの分が届いても、
    // 表示中のシートまで閉じてしまわないよう「本当に閉じているか」を確かめる
    dlg.onclose = () => { if (!dlg.open) done(null); };
    form.onclick = (e) => { if (e.target.closest("[data-close]")) done(null); };
    setup && setup(form, done);
    if (!dlg.open) dlg.showModal();
    const f = form.querySelector("[autofocus], input:not([type=hidden]):not([type=checkbox]), select");
    if (f) f.focus();
  });
}
const sheetHead = (title, left = "", right = `<button class="close-x" type="button" data-close aria-label="閉じる">${icon("x")}</button>`) =>
  `<div class="dh"><div class="l">${left}</div><h3>${esc(title)}</h3><div class="r">${right}</div></div>`;

/* 入力フォームのシート。OK で入力内容、キャンセルで null */
function formSheet(title, bodyHTML, okLabel = "保存", { danger = false, validate } = {}) {
  return sheet(`${sheetHead(title)}<div class="db">${bodyHTML}</div>
    <div class="df row2"><button class="btn" type="button" data-close>キャンセル</button>
    <button class="btn filled${danger ? " danger" : ""}" type="button" data-ok>${esc(okLabel)}</button></div>`, (form, done) => {
    const submit = () => {
      const d = Object.fromEntries(new FormData(form).entries());
      form.querySelectorAll("input[type=checkbox][name]").forEach((c) => { d[c.name] = c.checked; });
      const bad = [...form.querySelectorAll("[required]")].find((x) => !String(x.value || "").trim());
      if (bad) { bad.focus(); return; }
      const err = validate && validate(d);
      if (err) { toast(err, true); return; }
      done(d);
    };
    form.querySelector("[data-ok]").onclick = submit;
    form.onkeydown = (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") { e.preventDefault(); submit(); } };
  });
}
function confirmSheet(title, text, okLabel, danger = true) {
  return sheet(`<div class="db" style="padding-top:22px;text-align:center"><h3 style="margin:0;font-size:18px">${esc(title)}</h3>
    <p style="white-space:pre-wrap">${esc(text)}</p></div>
    <div class="df row2"><button class="btn" type="button" data-close>キャンセル</button>
    <button class="btn filled${danger ? " danger" : ""}" type="button" data-ok>${esc(okLabel)}</button></div>`,
  (form, done) => { form.querySelector("[data-ok]").onclick = () => done(true); }).then((v) => !!v);
}
const field = (label, inner) => `<label class="field"><span>${esc(label)}</span>${inner}</label>`;
const toggle = (name, title, sub, checked) => `<label class="toggle-row"><span class="main">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</span>
  <input type="checkbox" class="switch" name="${name}"${checked ? " checked" : ""}></label>`;

/* ---------------- popover menu ---------------- */
function openMenu(anchor, items) {
  const m = $("#menu");
  m.innerHTML = items.map((it, i) => it === "-" ? "<hr>" :
    `<button type="button" role="menuitem" data-i="${i}"${it.admin ? ' class="need-admin"' : ""}><span>${esc(it.label)}</span>${icon(it.icon)}</button>`).join("");
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  m.style.top = `${r.bottom + 8}px`;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  const close = () => { m.hidden = true; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc_); };
  const outside = (e) => { if (!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  const esc_ = (e) => { if (e.key === "Escape") close(); };
  m.onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; close(); items[Number(b.dataset.i)].run(); };
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc_); }, 0);
  m.querySelector("button")?.focus();
}

/* ---------------- テーマ・背景 ---------------- */
/* tone: 背景の明るさ。大見出しの文字色を合わせる(dark=白文字 / light=黒文字 / null=通常) */
const PIXELS = "repeating-conic-gradient(rgba(0,0,0,.05) 0 25%, transparent 0 50%) 0 0 / 32px 32px";
const STARS = [
  "radial-gradient(1.4px 1.4px at 20px 30px, rgba(255,255,255,.9), transparent) 0 0 / 140px 140px",
  "radial-gradient(1px 1px at 90px 70px, rgba(255,255,255,.7), transparent) 0 0 / 190px 190px",
  "radial-gradient(1.8px 1.8px at 50px 160px, rgba(220,200,255,.8), transparent) 0 0 / 230px 230px",
].join(", ");
const THEMES = [
  { id: "mint", name: "ミント", tone: null, bg: null },
  { id: "aurora", name: "オーロラ", tone: "dark", bg: "radial-gradient(60% 50% at 20% 15%, rgba(61,255,170,.55), transparent 70%), radial-gradient(50% 45% at 85% 25%, rgba(138,92,255,.6), transparent 70%), radial-gradient(60% 50% at 55% 95%, rgba(0,180,255,.4), transparent 70%), linear-gradient(160deg, #050b1f, #0b1a33 50%, #06201f)" },
  { id: "sunset", name: "サンセット", tone: "dark", bg: "radial-gradient(70% 60% at 15% 5%, #ffc27a, transparent 60%), radial-gradient(60% 55% at 90% 20%, #ff6f91, transparent 65%), radial-gradient(80% 60% at 50% 105%, #5b3cff, transparent 70%), linear-gradient(180deg, #ff9a7b, #ff5f86 50%, #6e45d6)" },
  { id: "ocean", name: "オーシャン", tone: "dark", bg: "radial-gradient(60% 50% at 85% 5%, rgba(0,229,255,.5), transparent 70%), radial-gradient(70% 60% at 5% 95%, rgba(0,114,255,.55), transparent 70%), linear-gradient(170deg, #021b33, #063d5c 55%, #0a6b7a)" },
  { id: "overworld", name: "オーバーワールド", tone: "light", bg: `linear-gradient(180deg, #6fbfff 0%, #a9dcff 48%, #d3f0ff 64%, #6cc24a 64%, #57a43a 76%, #7a5230 76%, #5e3e22 100%)` },
  { id: "nether", name: "ネザー", tone: "dark", bg: `${PIXELS}, radial-gradient(55% 45% at 20% 90%, rgba(255,110,0,.7), transparent 70%), radial-gradient(45% 40% at 85% 75%, rgba(255,40,40,.5), transparent 70%), radial-gradient(60% 50% at 50% 0%, rgba(130,0,40,.65), transparent 70%), linear-gradient(180deg, #1a0508, #3a0a0a 60%, #5a1405)` },
  { id: "end", name: "ジ・エンド", tone: "dark", bg: `${STARS}, radial-gradient(60% 50% at 70% 25%, rgba(170,90,255,.45), transparent 70%), radial-gradient(50% 40% at 15% 85%, rgba(230,220,140,.18), transparent 70%), linear-gradient(180deg, #07040f, #140a26 60%, #1e1036)` },
  { id: "pastel", name: "パステル", tone: "light", bg: "radial-gradient(50% 50% at 10% 10%, #ffcfe6, transparent 70%), radial-gradient(50% 50% at 90% 15%, #c6e2ff, transparent 70%), radial-gradient(60% 60% at 25% 90%, #d3f6e2, transparent 70%), radial-gradient(50% 50% at 90% 90%, #fff0bf, transparent 70%), #f8f6ff" },
  { id: "graphite", name: "グラファイト", tone: "dark", bg: "radial-gradient(60% 50% at 30% 0%, rgba(255,255,255,.12), transparent 70%), radial-gradient(40% 40% at 90% 90%, rgba(255,255,255,.05), transparent 70%), linear-gradient(180deg, #232326, #0c0c0e)" },
];
const bgUrl = (file) => `/api/backgrounds/${encodeURIComponent(file)}`;
function readCachedTheme() { try { return JSON.parse(localStorage.getItem("craftshelf.theme") || "null"); } catch { return null; } }
function writeCachedTheme(p) { try { localStorage.setItem("craftshelf.theme", JSON.stringify(p)); } catch { /* 保存できない環境 */ } }
function applyTheme(prefs, { loggedIn = true } = {}) {
  prefs = prefs || {};
  const body = document.body, st = body.style;
  let id = prefs.theme || "mint";
  let bg = null, tone = null;
  if (id === "custom" && prefs.bg_file && loggedIn) {
    bg = `url("${bgUrl(prefs.bg_file)}") center / cover no-repeat, #111`;
    tone = prefs.tone || "dark";
  } else {
    const t = THEMES.find((x) => x.id === id) || THEMES[0];
    id = t.id; bg = t.bg; tone = t.tone;
  }
  if (bg) st.setProperty("--app-bg", bg); else st.removeProperty("--app-bg");
  const custom = id === "custom";
  st.setProperty("--bg-dim", String((bg ? (prefs.bg_dim ?? (custom ? 20 : 0)) : 0) / 100));
  st.setProperty("--bg-blur", `${bg ? (prefs.bg_blur ?? 0) : 0}px`);
  body.classList.toggle("has-bg", !!bg);
  body.classList.toggle("tone-dark", tone === "dark");
  body.classList.toggle("tone-light", tone === "light");
  writeCachedTheme({ theme: prefs.theme, bg_dim: prefs.bg_dim, bg_blur: prefs.bg_blur });
}
/* アップロードした画像の明るさを調べ、上の方が暗ければ白文字にする */
function detectTone(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = 32; c.height = 32;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0, 32, 32);
        const d = g.getImageData(0, 0, 32, 12).data;
        let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        resolve(sum / (d.length / 4) < 150 ? "dark" : "light");
      } catch { resolve("dark"); }
    };
    img.onerror = () => resolve("dark");
    img.src = bgUrl(file);
  });
}
async function savePrefs(patch) {
  const r = await api("/api/me/prefs", { method: "PATCH", json: patch });
  const tone = state.prefs && state.prefs.tone;
  state.prefs = { ...r.prefs, tone };
  applyTheme(state.prefs);
  return state.prefs;
}

/* ---------------- auth ---------------- */
async function checkAuth() {
  let me;
  try { me = await api("/api/auth/me"); } catch (e) { toast(e.message, true); return; }
  state.roles = me.roles || {}; state.appVersion = me.version;
  if (!me.user) { showAuth(me.setup_required); return; }
  state.user = me.user;
  state.prefs = me.prefs || {};
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
  if (isAdmin()) checkSelfUpdate(false);
}
function showAuth(setup) {
  state.user = null;
  applyTheme(readCachedTheme(), { loggedIn: false });
  $("#app").hidden = true;
  closePanel();
  const dlg = $("#dlg"); if (dlg.open) dlg.close();
  document.body.classList.remove("can-edit", "can-admin");
  const f = $("#authForm");
  const logo = `<div class="logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8"/></svg></div>`;
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
  if (state.appVersion) f.insertAdjacentHTML("beforeend", `<div class="ver">v${esc(state.appVersion)}</div>`);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    const err = $("#authErr");
    if (setup && d.password !== d.password2) { err.textContent = "確認用のパスワードが一致しません"; return; }
    await busy(f.querySelector("[type=submit]"), async () => {
      try {
        await api(setup ? "/api/auth/setup" : "/api/auth/login", { json: { username: d.username, password: d.password } });
        await checkAuth();
      } catch (ex) { err.textContent = ex.message; }
    }, setup ? "作成中…" : "ログイン中…");
  };
  $("#auth").hidden = false;
  f.querySelector("input")?.focus();
}

/* ---------------- data ---------------- */
let refreshTimer = null;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }
async function refresh() {
  try {
    const d = await api("/api/library");
    state.items = d.items; state.storage = d.storage; state.version = d.version; state.build = d.build;
    if (state.selected && !state.items.some((i) => i.id === state.selected)) closePanel();
    render();
  } catch (e) { if (state.user) toast("読み込みに失敗しました: " + e.message, true); }
}

/* ---------------- list ---------------- */
function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = state.items.filter((it) => state.cat === "all" || it.category === state.cat
    || (state.cat === "__upd" && it.source && it.source.status === "update")
    || (state.cat === "__deps" && (it.missing_deps || []).length)
    || (state.cat === "__unlinked" && !it.source)
    || (state.cat === "__nomc" && !mcOf(it)));
  if (state.mc) list = list.filter((it) => mcSupports(mcOf(it), state.mc) === true);
  if (q) list = list.filter((it) => it.name.toLowerCase().includes(q)
    || it.versions.some((v) => v.filename.toLowerCase().includes(q) || v.version.toLowerCase().includes(q)));
  const k = state.sortKey, dir = state.sortDir;
  const cmpName = (a, b) => a.name.localeCompare(b.name, "ja", { numeric: true, sensitivity: "base" });
  return list.sort((a, b) => {
    let r = 0;
    if (k === "name") r = cmpName(a, b);
    else if (k === "count") r = a.versions.length - b.versions.length;
    else if (k === "size") r = a.total_size - b.total_size;
    else if (k === "added") r = a.last_added < b.last_added ? -1 : a.last_added > b.last_added ? 1 : 0;
    return (r * dir) || cmpName(a, b);
  });
}
function render() {
  const total = state.items.reduce((s, i) => s + i.total_size, 0);
  const nv = state.items.reduce((s, i) => s + i.versions.length, 0);
  $("#stats").textContent = `${state.items.length} 件 · ${nv} ファイル · ${fmtSize(total)}${state.version ? ` · v${state.version}` : ""}`;
  $("#stats").title = state.build || "";
  renderStorage();

  const counts = { all: state.items.length };
  for (const k of Object.keys(CATS)) counts[k] = state.items.filter((i) => i.category === k).length;
  const nUpd = state.items.filter((i) => i.source && i.source.status === "update").length;
  const nDeps = state.items.filter((i) => (i.missing_deps || []).length).length;
  $("#chips").innerHTML = ["all", ...Object.keys(CATS)].filter((k) => k === "all" || counts[k] > 0 || state.cat === k)
    .map((k) => `<button class="seg" type="button" data-cat="${k}" aria-pressed="${state.cat === k}">${k === "all" ? "すべて" : CATS[k]}<span class="n">${counts[k]}</span></button>`).join("")
    + (nUpd || state.cat === "__upd" ? `<button class="seg upd" type="button" data-cat="__upd" aria-pressed="${state.cat === "__upd"}">更新あり<span class="n">${nUpd}</span></button>` : "")
    + (nDeps || state.cat === "__deps" ? `<button class="seg upd" type="button" data-cat="__deps" aria-pressed="${state.cat === "__deps"}">前提が不足<span class="n">${nDeps}</span></button>` : "")
    + (state.cat === "__unlinked" ? `<button class="seg" type="button" data-cat="__unlinked" aria-pressed="true">未連携<span class="n">${state.items.filter((i) => !i.source).length}</span></button>` : "")
    + (state.cat === "__nomc" ? `<button class="seg" type="button" data-cat="__nomc" aria-pressed="true">MC不明<span class="n">${state.items.filter((i) => !mcOf(i)).length}</span></button>` : "");
  const mcSel = $("#mcSel");
  if (mcSel.options.length === 1) mcSel.insertAdjacentHTML("beforeend", MC_LINES.map((v) => `<option value="${v}">MC ${v} で使える</option>`).join(""));
  mcSel.value = state.mc || "";

  const list = filtered();
  if (!list.length) {
    $("#list").innerHTML = `<div class="empty"><div class="big">📦</div>${state.items.length ? `条件に合うものがありません${state.mc ? `<br><small>MC ${esc(state.mc)} で使えると判定できたものだけを表示しています。対応MCバージョンが不明なものは表示されません</small>` : ""}`
      : isEditor() ? "まだ何も登録されていません。<br>ファイルをドロップするか、右上の ＋ から追加してください" : "まだ何も登録されていません"}</div>`;
  } else {
    $("#list").innerHTML = list.map((it) => {
      const latest = it.versions.find((v) => v.id === it.latest_id) || it.versions[0];
      const upd = it.source && it.source.status === "update";
      const missing = it.versions.some((v) => v.missing);
      const mc = mcOf(it);
      const page = it.source && it.source.page_url ? safeUrl(it.source.page_url) : "";
      return `<div class="row${state.selected === it.id ? " sel" : ""}" role="button" tabindex="0" data-id="${it.id}">
        <span class="cicon c-${it.category}">${CAT_LETTER[it.category]}</span>
        <span class="main"><span class="title">${esc(it.name)}</span>
          <span class="subtitle">${esc(verLabel(latest.version))}${mc ? ` · MC ${esc(mc)}` : ""} · ${it.versions.length} バージョン<span class="hide-s"> · ${fmtSize(it.total_size)} · ${fmtDate(it.last_added)}</span></span></span>
        <span class="trail">${missing ? '<span class="badge err">欠損</span>' : ""}${(it.missing_deps || []).length ? `<span class="badge err" title="足りない前提: ${esc(it.missing_deps.join(", "))}">前提が不足</span>` : ""}${upd ? `<span class="badge upd">更新 ${esc(it.source.latest.version || "")}</span>` : ""}
          ${page !== "" && page !== "#" ? `<a class="linkbtn hide-s" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="${esc(it.source.provider_label)} の配布ページを開く">${esc(it.source.provider_label)} ${icon("external")}</a>` : ""}
          ${icon("chev", "i chev")}</span>
      </div>`;
    }).join("");
  }
  if (state.selected) renderPanel();
  if (state.view === "dash") renderDash();
  if (state.view === "sets" && state.sets) renderSets();
}
function renderStorage() {
  const s = state.storage || {}, t = s.target;
  const label = t ? (t.name === t.protocol_label ? t.name : `${t.name} · ${t.protocol_label}`) : "";
  $("#storageInfo").innerHTML = t ? `<span class="status-dot ${s.error ? "err" : "ok"}"></span><span class="t">${esc(label)}${s.path ? ` · ${esc(s.path)}` : ""}</span>` : "";
  $("#storageInfo").title = s.path || "";
  const banner = $("#storageBanner");
  banner.hidden = !s.error;
  banner.innerHTML = s.error ? `<span>⚠️ ${esc(s.error)}</span>${isAdmin() ? `<button class="btn small tinted" type="button" id="bannerOpen">ストレージ設定を開く</button>` : ""}` : "";
  $("#bannerOpen")?.addEventListener("click", () => openSettings("storage"));
  $("#drop").classList.toggle("disabled", !!s.error);
}

$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]"); if (!b) return;
  state.cat = b.dataset.cat; render();
});
$("#search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#mcSel").addEventListener("change", (e) => { state.mc = e.target.value; render(); });
$("#sortSel").addEventListener("change", (e) => {
  const [k, d] = e.target.value.split(":"); state.sortKey = k; state.sortDir = Number(d); render();
});
$("#list").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;  // 配布ページのリンクはそのまま開く
  const r = e.target.closest(".row[data-id]"); if (r) openPanel(Number(r.dataset.id));
});
$("#list").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".row[data-id]")) { e.preventDefault(); openPanel(Number(e.target.dataset.id)); }
});

/* ---------------- 対応MCバージョン ---------------- */
const mcOf = (it) => it.mc_versions || it.mc_auto || "";

/* ---------------- 表示の切り替え(下のタブバー) ---------------- */
const VIEWS = { library: "ライブラリ", dash: "ダッシュボード", sets: "セット", servers: "サーバー" };
function setView(view) {
  if (!VIEWS[view]) view = "library";
  state.view = view;
  document.querySelectorAll("#tabbar [data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $("#viewTitle").textContent = VIEWS[view];
  $("#libView").hidden = view !== "library";
  $("#dash").hidden = view !== "dash";
  $("#setsView").hidden = view !== "sets";
  $("#serversView").hidden = view !== "servers";
  try { localStorage.setItem("craftshelf.view", view); } catch { /* 保存できない環境 */ }
  window.scrollTo({ top: 0 });
  if (view === "dash") renderDash();
  if (view === "sets") loadSets();
  if (view === "servers") loadServers();
}
$("#tabbar").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });

/* ---------------- 対応MCバージョンでの絞り込み ---------------- */
const MC_LINES = ["1.21", "1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12", "1.8"];
const verNums = (v) => (String(v).match(/\d+(?:\.\d+)*/) || [""])[0].split(".").filter(Boolean).map(Number);
const cmpVer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
/* 「1.20 以降」「1.20.1〜1.21.4」「1.20.1, 1.20.2」「[1.20.1,1.21)」などを解釈し、指定の系列(例 1.21)で使えるか判定する */
function mcSupports(text, line) {
  if (!text) return null;
  const L = verNums(line), Lend = [L[0], L[1] + 1];
  const t = String(text).replace(/\s/g, "");
  let m;
  if ((m = t.match(/^([\d.]+)以降$/)) || (m = t.match(/^>=?([\d.]+)$/)) || (m = t.match(/^\[([\d.]+),\)$/))) return cmpVer(verNums(m[1]), Lend) < 0;
  if ((m = t.match(/^([\d.]+)[〜~\-–]([\d.]+)$/)) || (m = t.match(/^\[([\d.]+),([\d.]+)[)\]]$/))) {
    const lo = verNums(m[1]), hi = verNums(m[2]);
    return cmpVer(lo, Lend) < 0 && cmpVer(hi, L) >= 0;
  }
  const parts = t.split(/[,、]/).filter(Boolean);
  if (parts.length) return parts.some((p) => { const n = verNums(p); return n[0] === L[0] && n[1] === L[1]; });
  return null;
}

/* ---------------- ダッシュボード ---------------- */
async function renderDash() {
  const items = state.items;
  const nFiles = items.reduce((s, i) => s + i.versions.length, 0);
  const size = items.reduce((s, i) => s + i.total_size, 0);
  const upd = items.filter((i) => i.source && i.source.status === "update");
  const linked = items.filter((i) => i.source);
  const errs = items.filter((i) => i.source && i.source.status === "error");
  const missing = items.filter((i) => i.versions.some((v) => v.missing));
  const depMissing = items.filter((i) => (i.missing_deps || []).length);
  const unknownMc = items.filter((i) => !mcOf(i));
  const recent = [...items].sort((a, b) => (a.last_added < b.last_added ? 1 : -1)).slice(0, 6);
  const counts = Object.keys(CATS).map((k) => [k, items.filter((i) => i.category === k).length]).filter(([, n]) => n > 0);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const s = state.storage || {}, t = s.target;
  if (!state.dashSettings) { try { state.dashSettings = await api("/api/settings"); } catch { state.dashSettings = {}; } }
  const st = state.dashSettings;
  const itemRow = (it, trail) => `<div class="row" role="button" tabindex="0" data-open="${it.id}">
      <span class="cicon sm c-${it.category}">${CAT_LETTER[it.category]}</span>
      <span class="main"><span class="title">${esc(it.name)}</span><span class="subtitle">${esc(verLabel((it.versions.find((v) => v.id === it.latest_id) || it.versions[0]).version))}${mcOf(it) ? ` · MC ${esc(mcOf(it))}` : ""}</span></span>
      <span class="trail">${trail}${icon("chev", "i chev")}</span></div>`;
  const intervalLabel = { 0: "しない", 6: "6時間ごと", 12: "12時間ごと", 24: "1日ごと", 168: "1週間ごと" }[st.check_interval_hours] || `${st.check_interval_hours || 0}時間ごと`;
  const tile = (go, cls, ic, k, v, sub) => `<button class="tile${cls}" type="button" data-go="${go}"><span class="k">${icon(ic)}${k}</span><span class="v">${v}</span><span class="s">${sub}</span></button>`;
  $("#dash").innerHTML = `
    <div class="tiles">
      ${tile("all", "", "box", "登録しているもの", `${items.length}<small>件</small>`, `${nFiles} ファイル`)}
      ${tile("storage", "", "server", "使用している容量", esc(fmtSize(size)), esc(t ? t.name : ""))}
      ${tile("upd", upd.length ? " warn" : "", "refresh", "更新があるもの", `${upd.length}<small>件</small>`, `${linked.length} 件を確認対象にしています`)}
      ${tile("unlinked", "", "link", "配布元の連携", `${items.length ? Math.round(linked.length / items.length * 100) : 0}<small>%</small>`, `${linked.length} / ${items.length} 件`)}
    </div>
    <div class="dash-grid">
      <div class="card">
        <div class="card-h"><h4>更新があるもの</h4>${upd.length ? `<button class="btn small filled need-editor" type="button" data-dact="dlall">${icon("download")}すべて保存</button>` : ""}</div>
        <div class="card-b">${upd.length ? upd.map((it) => itemRow(it, `<span class="badge upd">${esc(it.source.latest.version || "")}</span>`)).join("")
          : `<div class="dash-empty">${linked.length ? "すべて最新です 🎉" : "配布元を紐付けると、ここに更新が表示されます"}</div>`}
          <div class="chips need-editor" style="margin-top:8px"><button class="btn small" type="button" data-dact="check">${icon("refresh")}今すぐ確認</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h4>種類ごとの件数</h4></div>
        <div class="card-b">${counts.length ? counts.map(([k, n]) => `<button class="barrow" type="button" data-cat="${k}" title="${esc(CATS[k])}: ${n} 件(クリックで一覧を表示)">
            <span class="lab"><span class="cicon sm c-${k}" style="width:22px;height:22px;border-radius:6px;font-size:11px">${CAT_LETTER[k]}</span><span>${esc(CATS[k])}</span></span>
            <span class="track"><span class="fill" style="width:${(n / max * 100).toFixed(1)}%"></span></span><span class="n">${n}</span></button>`).join("")
          : `<div class="dash-empty">まだ何も登録されていません</div>`}</div>
      </div>
      <div class="card">
        <div class="card-h"><h4>確認が必要なもの</h4></div>
        <div class="card-b">${missing.length || errs.length || depMissing.length || unknownMc.length ? `
          ${depMissing.map((it) => itemRow(it, `<span class="badge err">前提が不足: ${esc(it.missing_deps.join(", "))}</span>`)).join("")}
          ${missing.map((it) => itemRow(it, '<span class="badge err">ファイルが見つかりません</span>')).join("")}
          ${errs.map((it) => itemRow(it, '<span class="badge err">更新を確認できません</span>')).join("")}
          ${unknownMc.length ? `<button class="kv linkish" type="button" data-go="nomc"><span>対応MCバージョンが不明</span><span>${unknownMc.length} 件 ›</span></button>` : ""}`
          : `<div class="dash-empty">問題はありません 👍</div>`}</div>
      </div>
      <div class="card">
        <div class="card-h"><h4>最近追加したもの</h4></div>
        <div class="card-b">${recent.length ? recent.map((it) => itemRow(it, `<span class="val" style="font-size:13px">${esc(fmtDate(it.last_added))}</span>`)).join("") : `<div class="dash-empty">まだ何も登録されていません</div>`}</div>
      </div>
      <div class="card">
        <div class="card-h"><h4>配布元の連携</h4></div>
        <div class="card-b">
          <div class="meter" title="連携済み ${linked.length} / ${items.length} 件"><i style="width:${items.length ? linked.length / items.length * 100 : 0}%"></i></div>
          <div class="kv"><span>連携済み</span><span>${linked.length} 件</span></div>
          <div class="kv"><span>未連携</span><span>${items.length - linked.length} 件</span></div>
          <div class="kv"><span>確認できないもの</span><span>${errs.length} 件</span></div>
          <div class="kv"><span>自動確認</span><span>${esc(intervalLabel)}${st.last_auto_check ? `(前回 ${esc(fmtDateTime(st.last_auto_check))})` : ""}</span></div>
          ${items.length - linked.length ? `<div class="chips need-editor" style="margin-top:8px"><button class="btn small tinted" type="button" data-dact="detect">${icon("wand")}未連携の配布元を探す</button></div>` : ""}
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h4>保存先とバックアップ</h4>${isAdmin() ? `<button class="btn small" type="button" data-dact="storage">設定</button>` : ""}</div>
        <div class="card-b">${t ? `
          <div class="kv"><span>保存先</span><span>${esc(t.name)}(${esc(t.protocol_label)})</span></div>
          <div class="kv"><span>状態</span><span><span class="status-dot ${s.error ? "err" : "ok"}" style="display:inline-block;margin-right:6px"></span>${s.error ? esc(s.error) : "接続しています"}</span></div>` : ""}
          <div class="kv"><span>自動バックアップ</span><span>${st.backup_target_id ? `毎日${st.last_backup ? `(前回 ${esc(fmtDateTime(st.last_backup))})` : ""}` : "設定されていません"}</span></div>
        </div>
      </div>
    </div>`;
}
function gotoLibrary(cat) {
  state.cat = cat; state.mc = state.mc || ""; setView("library"); render();
}
$("#dash").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) { openPanel(Number(open.dataset.open)); return; }
  const catb = e.target.closest("[data-cat]");
  if (catb) { gotoLibrary(catb.dataset.cat); return; }
  const go = e.target.closest("[data-go]");
  if (go) {
    const g = go.dataset.go;
    if (g === "all") gotoLibrary("all");
    else if (g === "upd") gotoLibrary("__upd");
    else if (g === "unlinked") gotoLibrary("__unlinked");
    else if (g === "nomc") gotoLibrary("__nomc");
    else if (g === "storage") { if (isAdmin()) openSettings("storage"); else gotoLibrary("all"); }
    return;
  }
  const b = e.target.closest("[data-dact]"); if (!b) return;
  const a = b.dataset.dact;
  if (a === "check") await busy(b, () => runUpdates({ check: true }), "開始しています…");
  if (a === "detect") await busy(b, () => runUpdates({ detect: true, check: true }), "開始しています…");
  if (a === "dlall") await busy(b, () => runUpdates({ check: true, download: true }), "開始しています…");
  if (a === "storage") openSettings("storage");
});
$("#dash").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-open]")) { e.preventDefault(); openPanel(Number(e.target.dataset.open)); }
});

/* ---------------- セット ---------------- */
function missingInSet(set) {
  const inSet = state.items.filter((i) => set.items.some((x) => x.item_id === i.id));
  const have = new Set(inSet.flatMap((i) => i.dep_key || []));
  const out = [];
  for (const it of inSet) for (const d of it.depends || []) if (!have.has(d.toLowerCase().replace(/[\W_]+/g, ""))) out.push(`${it.name} → ${d}`);
  return out;
}
async function loadSets() {
  try { state.sets = (await api("/api/sets")).sets; } catch (e) { $("#setsView").innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
  renderSets();
}
function renderSets() {
  const sets = state.sets || [];
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i]));
  $("#setsView").innerHTML = `
    <div class="view-head"><p>よく使う組み合わせを「セット」として保存し、zip でまとめてダウンロードしたり、サーバーへまとめて転送したりできます。</p>
      <button class="btn filled need-editor" type="button" data-sa="new">${icon("plus")}セットを作成</button></div>
    ${sets.length ? `<div class="dash-grid">${sets.map((s) => {
      const miss = missingInSet(s);
      const size = s.items.reduce((n, x) => n + ((byId[x.item_id] || {}).total_size ? ((byId[x.item_id].versions.find((v) => v.id === (x.version_id || byId[x.item_id].latest_id)) || {}).size || 0) : 0), 0);
      return `<div class="card" data-set="${s.id}">
        <div class="card-h"><h4>${esc(s.name)}</h4><span class="badge">${s.items.length} 件 · ${esc(fmtSize(size))}</span></div>
        <div class="card-b">
          ${s.description ? `<p class="muted" style="margin:0 0 8px">${esc(s.description)}</p>` : ""}
          ${miss.length ? `<div class="result err" style="margin-bottom:8px">前提が足りません: ${esc(miss.join(" / "))}</div>` : ""}
          ${s.items.map((x) => { const it = byId[x.item_id]; if (!it) return ""; const v = it.versions.find((vv) => vv.id === (x.version_id || it.latest_id)) || {};
            return `<div class="row" role="button" tabindex="0" data-open="${it.id}"><span class="cicon sm c-${it.category}">${CAT_LETTER[it.category]}</span>
              <span class="main"><span class="title">${esc(it.name)}</span><span class="subtitle">${esc(verLabel(v.version))}${x.version_id ? "(固定)" : "(常に最新)"}</span></span>${icon("chev", "i chev")}</div>`; }).join("")}
          <div class="chips" style="margin-top:10px">
            <a class="btn small tinted" href="/api/sets/${s.id}/download">${icon("download")}zip でダウンロード</a>
            <button class="btn small need-editor" type="button" data-sa="push">${icon("server")}サーバーへ転送</button>
            <button class="btn small need-editor" type="button" data-sa="edit">${icon("edit")}編集</button>
            <button class="btn small danger need-editor" type="button" data-sa="del">${icon("trash")}削除</button>
          </div>
        </div></div>`; }).join("")}</div>`
    : `<div class="card"><div class="empty"><div class="big">🧺</div>まだセットがありません</div></div>`}`;
}
$("#setsView").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) { openPanel(Number(open.dataset.open)); return; }
  const b = e.target.closest("[data-sa]"); if (!b) return;
  const sid = Number(b.closest("[data-set]")?.dataset.set);
  const set = (state.sets || []).find((s) => s.id === sid);
  if (b.dataset.sa === "new") editSet(null);
  if (b.dataset.sa === "edit") editSet(set);
  if (b.dataset.sa === "push") pushDialog({ set });
  if (b.dataset.sa === "del" && await confirmSheet(`「${set.name}」を削除しますか?`, "セットの組み合わせだけが削除されます。ライブラリのファイルは残ります。", "削除")) {
    try { await api(`/api/sets/${sid}`, { method: "DELETE" }); toast("削除しました"); loadSets(); } catch (ex) { toast(ex.message, true); }
  }
});
async function editSet(set) {
  const chosen = new Map((set ? set.items : []).map((x) => [x.item_id, x.version_id || ""]));
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const r = await sheet(`${sheetHead(set ? "セットを編集" : "セットを作成")}
    <div class="db">
      ${field("名前", `<input type="text" name="name" value="${esc(set?.name || "")}" placeholder="例: サバイバル鯖一式">`)}
      ${field("メモ(任意)", `<input type="text" name="description" value="${esc(set?.description || "")}">`)}
      <label class="search"><span>${icon("search")}</span><input type="search" id="setQ" placeholder="絞り込み"></label>
      <div class="group scroll" id="setItems">${items.map((it) => `<div class="toggle-row pick" data-name="${esc(it.name.toLowerCase())}">
          <span class="cicon sm c-${it.category}">${CAT_LETTER[it.category]}</span>
          <label class="main" for="si-${it.id}">${esc(it.name)}</label>
          <select data-ver="${it.id}" class="compact" aria-label="${esc(it.name)} のバージョン">
            <option value="">常に最新(${esc(verLabel(it.versions[0].version))})</option>
            ${it.versions.map((v) => `<option value="${v.id}"${String(chosen.get(it.id)) === String(v.id) ? " selected" : ""}>${esc(verLabel(v.version))} に固定</option>`).join("")}
          </select>
          <input type="checkbox" class="switch" id="si-${it.id}" data-item="${it.id}"${chosen.has(it.id) ? " checked" : ""}></div>`).join("")}</div>
      <div class="result err" id="setWarn" hidden></div>
    </div>
    <div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    const warn = () => {
      const tmp = { items: [...form.querySelectorAll("[data-item]:checked")].map((c) => ({ item_id: Number(c.dataset.item) })) };
      const miss = missingInSet(tmp);
      $("#setWarn", form).hidden = !miss.length;
      $("#setWarn", form).textContent = miss.length ? `前提が足りません: ${miss.join(" / ")}` : "";
    };
    form.addEventListener("change", warn); warn();
    $("#setQ", form).oninput = (ev) => { const q = ev.target.value.toLowerCase(); form.querySelectorAll(".pick").forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); }); };
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const body = {
        name: form.querySelector("[name=name]").value, description: form.querySelector("[name=description]").value,
        items: [...form.querySelectorAll("[data-item]:checked")].map((c) => ({ item_id: Number(c.dataset.item), version_id: Number(form.querySelector(`[data-ver="${c.dataset.item}"]`).value) || null })),
      };
      try {
        if (set) await api(`/api/sets/${set.id}`, { method: "PATCH", json: body }); else await api("/api/sets", { json: body });
        done(true);
      } catch (ex) { toast(ex.message, true); }
    });
  }, { wide: true });
  if (r) { toast("保存しました"); loadSets(); }
}

/* ---------------- サーバー(Pterodactyl) ---------------- */
async function loadServers() {
  try { const d = await api("/api/servers"); state.servers = d.servers; state.pteroConfigured = d.configured; }
  catch (e) { $("#serversView").innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
  renderServers();
  for (const s of state.servers) {
    api(`/api/servers/${s.id}/status`).then((st) => {
      const el = document.querySelector(`[data-srv="${s.id}"] .srv-state`);
      if (el) el.innerHTML = stateBadge(st.state);
    }).catch(() => {});
  }
}
const stateBadge = (s) => ({ running: '<span class="badge ok">稼働中</span>', offline: '<span class="badge">停止中</span>', starting: '<span class="badge upd">起動中</span>', stopping: '<span class="badge upd">停止処理中</span>' }[s] || '<span class="badge">状態不明</span>');
function renderServers() {
  const list = state.servers || [];
  $("#serversView").innerHTML = !state.pteroConfigured ? `<div class="card"><div class="empty"><div class="big">🦖</div>
      Pterodactyl と連携すると、保管しているプラグインをサーバーへ転送・同期できます。<br>
      ${isAdmin() ? `<button class="btn filled" type="button" data-va="setup" style="margin-top:12px">${icon("gear")}Pterodactyl を設定</button>` : "管理者に設定を依頼してください"}</div></div>`
    : `<div class="view-head"><p>サーバーのプラグインフォルダとライブラリを照らし合わせ、古いものの更新やまとめての転送ができます。</p>
        <button class="btn filled need-admin" type="button" data-va="add">${icon("plus")}サーバーを連携</button></div>
      ${list.length ? `<div class="dash-grid">${list.map((s) => `<div class="card" data-srv="${s.id}">
        <div class="card-h"><h4>${esc(s.name)}</h4><span class="srv-state"><span class="spinner"></span></span></div>
        <div class="card-b">
          <div class="kv"><span>フォルダ</span><span>${esc(s.plugin_dir)}</span></div>
          <div class="kv"><span>セット</span><span>${s.set_name ? esc(s.set_name) : "なし"}</span></div>
          <div class="kv"><span>最後の同期</span><span>${s.last_sync ? esc(fmtDateTime(s.last_sync)) : "-"}</span></div>
          <div class="chips" style="margin-top:10px">
            <button class="btn small tinted need-editor" type="button" data-va="inv">${icon("search")}中身を確認</button>
            <button class="btn small filled need-editor" type="button" data-va="sync">${icon("refresh")}同期</button>
            <button class="btn small need-editor" type="button" data-va="push">${icon("server")}転送</button>
            <button class="btn small need-editor" type="button" data-va="restart">再起動</button>
            <button class="btn small need-admin" type="button" data-va="edit">${icon("gear")}設定</button>
          </div>
        </div></div>`).join("")}</div>`
      : `<div class="card"><div class="empty"><div class="big">🖥️</div>まだサーバーを連携していません</div></div>`}`;
}
$("#serversView").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-va]"); if (!b) return;
  const sid = Number(b.closest("[data-srv]")?.dataset.srv);
  const s = (state.servers || []).find((x) => x.id === sid);
  const a = b.dataset.va;
  if (a === "setup") openSettings("ptero");
  if (a === "add") linkServerDialog();
  if (a === "edit") serverSettingsDialog(s);
  if (a === "inv") inventoryDialog(s);
  if (a === "push") pushDialog({ server: s });
  if (a === "sync") {
    const r = await formSheet(`「${s.name}」を同期`, `<p>サーバーの ${esc(s.plugin_dir)} を確認し、ライブラリに新しいバージョンがあるものを更新します${s.set_name ? `。連携中のセット「${esc(s.set_name)}」に入っていて、サーバーに無いものも追加します` : ""}。</p>
      <div class="group">${toggle("restart", "完了後にサーバーを再起動", "プラグインの入れ替えを反映させるには再起動が必要です", false)}</div>`, "同期する");
    if (!r) return;
    try { jobStarted(await api(`/api/servers/${sid}/sync`, { json: { restart: r.restart } })); } catch (ex) { toast(ex.message, true); }
  }
  if (a === "restart" && await confirmSheet(`「${s.name}」を再起動しますか?`, "プレイ中のプレイヤーは切断されます。", "再起動")) {
    await busy(b, async () => { try { await api(`/api/servers/${sid}/power`, { json: { signal: "restart" } }); toast("再起動しました"); } catch (ex) { toast(ex.message, true); } });
  }
});
async function linkServerDialog() {
  let ps;
  const tp = toastProgress("Pterodactyl からサーバーの一覧を取得しています…");
  try { ps = (await api("/api/ptero/servers")).servers; } catch (e) { toast(e.message, true); return; } finally { tp.remove(); }
  const avail = ps.filter((p) => !p.linked_id);
  if (!avail.length) { toast("連携できるサーバーがありません(すべて連携済みか、APIキーのユーザーが操作できるサーバーがありません)", true); return; }
  const setOpts = `<option value="">なし</option>${(state.sets || []).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}`;
  const r = await formSheet("サーバーを連携", `
    ${field("サーバー", `<select name="identifier">${avail.map((p) => `<option value="${esc(p.identifier)}">${esc(p.name)}(${esc(p.node)})</option>`).join("")}</select>`)}
    ${field("プラグインのフォルダ", `<input type="text" name="plugin_dir" value="/plugins" placeholder="/plugins(Mod サーバーなら /mods)">`)}
    ${field("セット(任意。同期のときにセットの中身を入れる)", `<select name="set_id">${setOpts}</select>`)}`, "連携する");
  if (!r) return;
  r.name = (avail.find((p) => p.identifier === r.identifier) || {}).name || r.identifier;
  try { await api("/api/servers", { json: r }); toast("連携しました"); loadServers(); } catch (e) { toast(e.message, true); }
}
async function serverSettingsDialog(s) {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}"${x.id === s.set_id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}`;
  const r = await sheet(`${sheetHead(`「${s.name}」の設定`)}<div class="db">
      ${field("表示名", `<input type="text" name="name" value="${esc(s.name)}">`)}
      ${field("プラグインのフォルダ", `<input type="text" name="plugin_dir" value="${esc(s.plugin_dir)}">`)}
      ${field("セット", `<select name="set_id">${setOpts}</select>`)}
      <button class="btn danger block" type="button" data-unlink>連携を解除</button>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const d = Object.fromEntries(new FormData(form).entries());
      try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: d }); done("saved"); } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-unlink]").onclick = async (ev) => {
      if (!confirm(`「${s.name}」の連携を解除しますか?(サーバーのファイルはそのままです)`)) return;
      await busy(ev.currentTarget, async () => { try { await api(`/api/servers/${s.id}`, { method: "DELETE" }); done("deleted"); } catch (ex) { toast(ex.message, true); } });
    };
  });
  if (r) { toast(r === "deleted" ? "連携を解除しました" : "保存しました"); loadServers(); }
}
const INV_STATUS = { latest: ["ok", "最新"], outdated: ["upd", "更新あり"], different: ["", "ライブラリと別のファイル"], unregistered: ["err", "未登録"] };
async function inventoryDialog(s) {
  await sheet(`${sheetHead(`「${s.name}」の ${s.plugin_dir}`)}<div class="db" id="invBody"><div style="text-align:center;padding:24px"><span class="spinner lg"></span><p style="margin-top:10px">サーバーのファイルを確認しています…(初回はファイルを読み込むため時間がかかります)</p></div></div>`, async (form, done) => {
    let d;
    try { d = await api(`/api/servers/${s.id}/inventory`); } catch (e) { $("#invBody", form).innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
    const unreg = d.files.filter((f) => f.status === "unregistered");
    const outd = d.files.filter((f) => f.status === "outdated");
    $("#invBody", form).innerHTML = `
      <div class="group">${d.files.map((f) => { const [c, l] = INV_STATUS[f.status]; return `<div class="row">
        <span class="main"><span class="title">${esc(f.item_name || f.plugin_name || f.name)}</span><span class="subtitle">${esc(f.name)} · ${esc(f.version || "")}${f.status === "outdated" && f.latest_version ? ` → ライブラリ: ${esc(f.latest_version)}` : ""}</span></span>
        <span class="trail">${f.status === "unregistered" ? `<input type="checkbox" class="switch" data-imp="${esc(f.name)}" title="ライブラリに取り込む">` : ""}<span class="badge ${c}">${l}</span></span></div>`; }).join("") || '<div class="empty">jar ファイルがありません</div>'}</div>
      ${d.missing.length ? `<div class="group-title">セットにあってサーバーに無いもの</div><div class="group">${d.missing.map((m) => `<div class="row noicon"><span class="main"><span class="title">${esc(m.item_name)}</span><span class="subtitle">${esc(m.version)}</span></span><span class="badge upd">未導入</span></div>`).join("")}</div>` : ""}
      <div class="df" style="padding:0">
        ${outd.length || d.missing.length ? `<button class="btn filled block" type="button" data-inv="sync">${icon("refresh")}${outd.length + d.missing.length} 件を同期する</button>` : `<div class="result ok">すべてライブラリの最新と一致しています</div>`}
        ${unreg.length ? `<button class="btn tinted block" type="button" data-inv="import">${icon("download")}選んだ未登録のファイルをライブラリに取り込む</button>` : ""}
      </div>`;
    form.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-inv]"); if (!b) return;
      if (b.dataset.inv === "sync") {
        try { jobStarted(await api(`/api/servers/${s.id}/sync`, { json: {} })); done(null); } catch (ex) { toast(ex.message, true); }
      } else {
        const names = [...form.querySelectorAll("[data-imp]:checked")].map((c) => c.dataset.imp);
        if (!names.length) { toast("取り込むファイルのスイッチをオンにしてください", true); return; }
        try { jobStarted(await api(`/api/servers/${s.id}/import`, { json: { names } })); done(null); } catch (ex) { toast(ex.message, true); }
      }
    });
  }, { wide: true });
}
async function pushDialog({ server = null, set = null, item = null } = {}) {
  if (!state.servers) { try { const d = await api("/api/servers"); state.servers = d.servers; state.pteroConfigured = d.configured; } catch { state.servers = []; } }
  if (!state.servers.length) { toast("先に「サーバー」タブでサーバーを連携してください", true); return; }
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const r = await sheet(`${sheetHead("サーバーへ転送")}<div class="db">
      ${field("転送先のサーバー", `<select name="srv">${state.servers.map((x) => `<option value="${x.id}"${server && x.id === server.id ? " selected" : ""}>${esc(x.name)}(${esc(x.plugin_dir)})</option>`).join("")}</select>`)}
      ${field("送るもの", `<select name="mode"><option value="set"${set ? " selected" : ""}>セット</option><option value="items"${!set ? " selected" : ""}>アイテムを選ぶ</option></select>`)}
      <div id="pSet">${field("セット", `<select name="set_id">${state.sets.map((x) => `<option value="${x.id}"${set && x.id === set.id ? " selected" : ""}>${esc(x.name)}(${x.items.length} 件)</option>`).join("") || "<option value=''>セットがありません</option>"}</select>`)}</div>
      <div id="pItems"><div class="group scroll">${items.map((it) => `<label class="toggle-row"><span class="cicon sm c-${it.category}">${CAT_LETTER[it.category]}</span>
        <span class="main">${esc(it.name)}<small>${esc(verLabel(it.versions[0].version))}(最新)</small></span>
        <input type="checkbox" class="switch" data-pi="${it.id}"${item && item.id === it.id ? " checked" : ""}></label>`).join("")}</div></div>
      <div class="group">${toggle("restart", "完了後にサーバーを再起動", "", false)}</div>
      <p style="font-size:12.5px">サーバーに同じプラグインの別のバージョンがある場合は、送ったものに置き換えます。</p>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>転送する</button></div>`, (form, done) => {
    const sync = () => { const m = form.querySelector("[name=mode]").value; $("#pSet", form).hidden = m !== "set"; $("#pItems", form).hidden = m !== "items"; };
    form.querySelector("[name=mode]").onchange = sync; sync();
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const srv = Number(form.querySelector("[name=srv]").value);
      const body = { restart: form.querySelector("[name=restart]").checked };
      if (form.querySelector("[name=mode]").value === "set") body.set_id = Number(form.querySelector("[name=set_id]").value) || null;
      else body.item_ids = [...form.querySelectorAll("[data-pi]:checked")].map((c) => Number(c.dataset.pi));
      try { jobStarted(await api(`/api/servers/${srv}/push`, { json: body })); done(true); } catch (ex) { toast(ex.message, true); }
    }, "開始しています…");
  }, { wide: true });
  return r;
}

/* ---------------- detail panel ---------------- */
function openPanel(id) {
  state.selected = id;
  $("#panel").classList.add("on"); $("#panel").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("on");
  render();
  $("#panel .close-x")?.focus();
}
function closePanel() {
  state.selected = null;
  $("#panel").classList.remove("on"); $("#panel").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("on");
  document.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
}
$("#scrim").addEventListener("click", closePanel);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#dlg").open && state.selected) closePanel(); });

function renderPanel() {
  const it = state.items.find((i) => i.id === state.selected);
  if (!it) return;
  const vs = state.verOrder === "desc" ? it.versions : [...it.versions].reverse();
  const latest = it.versions.find((v) => v.id === it.latest_id) || it.versions[0];
  const tags = (v) => [v.meta.loader, v.meta.mc && "MC " + v.meta.mc, v.meta.pack_format && "pack_format " + v.meta.pack_format]
    .filter(Boolean).map((t) => `<span class="badge">${esc(t)}</span>`).join("");
  $("#panel").innerHTML = `
    <div class="side-head">
      <div class="nav"><span class="badge cat c-${it.category}">${CATS[it.category]}</span>
        <button class="close-x" type="button" data-act="close" aria-label="閉じる">${icon("x")}</button></div>
      <h3>${esc(it.name)}</h3>
      <p class="desc">${it.versions.length} バージョン · 合計 ${fmtSize(it.total_size)}</p>
      <p class="desc">対応MCバージョン: <b style="color:var(--label)">${esc(mcOf(it) || "不明")}</b>${it.mc_versions ? "(手入力)" : it.mc_auto ? "(自動で判定)" : ""}</p>
      ${latest.meta.description ? `<p class="desc">${esc(latest.meta.description)}</p>` : ""}
      <div class="chips">
        ${it.source && safeUrl(it.source.page_url) !== "#" ? `<a class="btn small tinted" href="${esc(safeUrl(it.source.page_url))}" target="_blank" rel="noopener noreferrer">${icon("external")}配布ページ</a>` : ""}
        <button class="btn small need-editor" type="button" data-act="edit-item">${icon("edit")}情報を編集</button>
        <button class="btn small need-editor" type="button" data-act="push">${icon("server")}サーバーへ転送</button>
        <button class="btn small" type="button" data-act="order">${icon("arrows")}${state.verOrder === "desc" ? "新しい順" : "古い順"}</button>
        <button class="btn small danger need-editor" type="button" data-act="del-item">${icon("trash")}すべて削除</button>
      </div>
    </div>
    <div class="side-body">
      <div class="group-title">配布元</div>
      <div class="group">${sourceBoxHTML(it)}</div>
      ${depsHTML(it)}
      <div class="group-title">保存しているバージョン</div>
      <div class="group">
      ${vs.map((v) => `
        <div class="ver${v.missing ? " missing" : ""}" data-vid="${v.id}">
          <div class="vh"><span class="vnum">${esc(verLabel(v.version))}</span>
            ${v.id === it.latest_id ? '<span class="badge ok">最新</span>' : ""}
            ${v.missing ? '<span class="badge err">ファイルが見つかりません</span>' : ""}${tags(v)}</div>
          <div class="file">${esc(v.filename)} · ${fmtSize(v.size)} · ${fmtDateTime(v.added_at)}</div>
          ${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}
          <div class="acts">
            ${v.missing ? "" : `<a class="btn small tinted" href="/api/versions/${v.id}/download">${icon("download")}ダウンロード</a>`}
            <button class="btn small need-editor" type="button" data-act="edit-ver">編集</button>
            <button class="btn small danger need-editor" type="button" data-act="del-ver">削除</button>
          </div>
        </div>`).join("")}
      </div>
    </div>`;
}
$("#panel").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const it = state.items.find((i) => i.id === state.selected); if (!it) return;
  const vid = Number(b.closest("[data-vid]")?.dataset.vid);
  const v = it.versions.find((x) => x.id === vid);
  const act = b.dataset.act;
  if (act.startsWith("src-")) { await sourceAction(it, act, b); return; }
  if (act === "close") closePanel();
  else if (act === "push") pushDialog({ item: it });
  else if (act === "order") { state.verOrder = state.verOrder === "desc" ? "asc" : "desc"; renderPanel(); }
  else if (act === "edit-item") editItem(it);
  else if (act === "edit-ver") editVersion(v);
  else if (act === "del-ver") {
    if (await confirmSheet(`${verLabel(v.version)} を削除しますか?`, `${v.filename}\n保存先のファイルも削除され、元に戻せません。`, "削除")) {
      await run(() => api(`/api/versions/${v.id}`, { method: "DELETE" }), "削除しました");
    }
  } else if (act === "del-item") {
    if (await confirmSheet(`「${it.name}」をすべて削除しますか?`, `保存している ${it.versions.length} 個のファイルがすべて削除され、元に戻せません。`, "すべて削除")) {
      await run(() => api(`/api/items/${it.id}`, { method: "DELETE" }), "削除しました");
    }
  }
});
async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); return true; }
  catch (e) { toast(e.message, true); return false; }
}
async function editItem(it) {
  const r = await formSheet("情報を編集", `<p>同じ名前・種類のものが既にある場合は、そちらに統合されます。</p>
    ${field("名前", `<input type="text" name="name" value="${esc(it.name)}" required>`)}
    ${field("種類", `<select name="category">${Object.entries(CATS).map(([k, n]) => `<option value="${k}"${k === it.category ? " selected" : ""}>${n}</option>`).join("")}</select>`)}
    ${field("対応MCバージョン(例: 1.20.1〜1.21.4 / 1.20 以降)", `<input type="text" name="mc_versions" value="${esc(it.mc_versions || "")}" placeholder="${esc(it.mc_auto || "空欄なら自動で判定します")}">`)}
    <p style="font-size:12.5px">空欄のままにすると、ファイルの中身や配布元から自動で判定した${it.mc_auto ? `「${esc(it.mc_auto)}」` : "バージョン"}を表示します。</p>
    ${field("古いバージョンの自動整理", `<select name="keep_versions">${[[0, "しない(すべて残す)"], [1, "最新だけ残す"], [3, "新しい方から 3 つ残す"], [5, "新しい方から 5 つ残す"], [10, "新しい方から 10 個残す"]].map(([n, l]) => `<option value="${n}"${Number(it.keep_versions || 0) === n ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
    <p style="font-size:12.5px">新しいバージョンを追加したときに、残す数を超えた古いものを自動で削除します(セットで固定しているバージョンは残します)。</p>`);
  if (!r) return;
  await run(async () => {
    r.keep_versions = Number(r.keep_versions || 0);
    if (r.keep_versions && r.keep_versions < it.versions.length && !(await confirmSheet("古いバージョンを削除しますか?", `「${it.name}」は ${it.versions.length} 個のバージョンを保存しています。新しい方から ${r.keep_versions} 個を残し、それより古いものを削除します(元に戻せません)。`, "削除して保存"))) return;
    const res = await api(`/api/items/${it.id}`, { method: "PATCH", json: r });
    if (res.removed && res.removed.length) toast(`古いバージョンを ${res.removed.length} 個削除しました`);
    await refresh();
    const norm = (s) => s.toLowerCase().replace(/[\W_]+/g, "");
    const t = state.items.find((i) => i.category === r.category && norm(i.name) === norm(r.name));
    if (t) openPanel(t.id);
  }, "保存しました");
}
async function editVersion(v) {
  const r = await formSheet("バージョン情報", `<p>${esc(v.filename)}</p>
    ${field("バージョン", `<input type="text" name="version" value="${esc(v.version)}">`)}
    ${field("メモ(使っているサーバー、注意点など)", `<textarea name="note" rows="3">${esc(v.note)}</textarea>`)}`);
  if (!r) return;
  await run(() => api(`/api/versions/${v.id}`, { method: "PATCH", json: r }), "保存しました");
}

/* ---------------- 前提(依存)プラグイン ---------------- */
function depsHTML(it) {
  const deps = it.depends || [], soft = it.softdepends || [];
  if (!deps.length && !soft.length) return "";
  const have = new Set(state.items.flatMap((i) => i.dep_key || []));
  const has = (d) => have.has(d.toLowerCase().replace(/[\W_]+/g, ""));
  const row = (d, req) => `<div class="row noicon"><span class="main"><span class="title">${esc(d)}</span><span class="subtitle">${req ? "必須" : "任意(あると連携機能が使える)"}</span></span>
    <span class="trail">${has(d) ? '<span class="badge ok">ライブラリにあります</span>' : req ? '<span class="badge err">ライブラリにありません</span>' : '<span class="badge">なし</span>'}</span></div>`;
  return `<div class="group-title">前提プラグイン・Mod</div><div class="group">${deps.map((d) => row(d, true)).join("")}${soft.map((d) => row(d, false)).join("")}</div>`;
}

/* ---------------- 配布元(更新) ---------------- */
function sourceBoxHTML(it) {
  const s = it.source;
  const cands = state.candidates[it.id];
  if (!s) {
    return `<div class="srcbox">
      <div class="sh"><span class="cicon sm c-teal">${icon("link")}</span><div class="main"><div class="title" style="font-weight:600">未連携</div>
        <div class="muted" style="margin:0">Modrinth / SpigotMC / CurseForge と紐付けると、最新版の確認とダウンロードができます</div></div></div>
      <div class="acts need-editor">
        <button class="btn small filled" type="button" data-act="src-detect">${icon("wand")}自動で探す</button>
        <button class="btn small" type="button" data-act="src-link">${icon("link")}URLで紐付け</button>
      </div>
      ${cands ? (cands.length ? `<div class="muted">候補から選んでください</div>${cands.map((c, i) => `
        <div class="cand"><div class="main">${esc(c.title)}${c.exact ? ' <span class="badge ok">名前が一致</span>' : ""}<small>${esc(PROVIDERS[c.provider])} · ${(c.downloads || 0).toLocaleString()} DL${c.summary ? " · " + esc(c.summary.slice(0, 70)) : ""}</small></div>
          <a class="btn small" href="${esc(safeUrl(c.page_url))}" target="_blank" rel="noopener noreferrer">開く</a>
          <button class="btn small tinted need-editor" type="button" data-act="src-pick" data-i="${i}">選択</button></div>`).join("")}`
        : `<div class="muted">見つかりませんでした。配布ページのURLで紐付けてください。</div>`) : ""}
    </div>`;
  }
  const L = s.latest || {};
  const st = s.status === "update" ? '<span class="badge upd">更新あり</span>' : s.status === "up_to_date" ? '<span class="badge ok">最新</span>'
    : `<span class="badge${s.status === "error" ? " err" : ""}">${esc(SRC_STATUS[s.status] || s.status)}</span>`;
  return `<div class="srcbox">
    <div class="sh"><span class="cicon sm c-teal">${icon("link")}</span>
      <div class="main"><a href="${esc(safeUrl(s.page_url))}" target="_blank" rel="noopener noreferrer" style="font-weight:600">${esc(s.title)}</a>
        <div class="muted" style="margin:0">${esc(s.provider_label)}${s.linked_by === "name" ? " · 名前から推定" : ""}</div></div>${st}</div>
    ${L.version ? `<div class="latest">配布元の最新: <b>${esc(L.version)}</b>${L.date ? ` <span class="muted">(${fmtDate(L.date)})</span>` : ""}
      ${L.file_name ? `<div class="muted" style="margin-top:2px">${esc(L.file_name)}</div>` : ""}</div>` : ""}
    ${s.message ? `<div class="muted">${esc(s.message)}</div>` : ""}
    <div class="muted">絞り込み: ローダー ${s.loaders.length ? esc(s.loaders.join(", ")) : "指定なし"} / MC ${s.game_versions.length ? esc(s.game_versions.join(", ")) : "指定なし"}${s.checked_at ? ` · 確認 ${fmtDateTime(s.checked_at)}` : ""}</div>
    <div class="acts">
      ${safeUrl(s.page_url) !== "#" ? `<a class="btn small tinted" href="${esc(safeUrl(s.page_url))}" target="_blank" rel="noopener noreferrer">${icon("external")}配布ページを開く</a>` : ""}
    </div>
    <div class="acts need-editor">
      ${s.status === "update" && L.downloadable ? `<button class="btn small filled" type="button" data-act="src-download">${icon("download")}${esc(L.version || "最新版")} を保存</button>` : ""}
      <button class="btn small" type="button" data-act="src-check">${icon("refresh")}確認</button>
      <button class="btn small" type="button" data-act="src-changelog">${icon("doc")}変更履歴</button>
      <button class="btn small" type="button" data-act="src-filter">絞り込み</button>
      <button class="btn small" type="button" data-act="src-link">紐付け直す</button>
      <button class="btn small danger" type="button" data-act="src-unlink">解除</button>
    </div>
  </div>`;
}
async function sourceAction(it, act, btn) {
  try {
    if (act === "src-detect") {
      const r = await busy(btn, () => api(`/api/items/${it.id}/source/detect`, { method: "POST" }), "探しています…");
      if (r.linked) { toast(r.how); delete state.candidates[it.id]; }
      else { state.candidates[it.id] = r.candidates; toast(r.candidates.length ? "候補が見つかりました。正しいものを選んでください" : "見つかりませんでした", !r.candidates.length); }
    } else if (act === "src-pick") {
      const c = state.candidates[it.id][Number(btn.dataset.i)];
      await busy(btn, () => api(`/api/items/${it.id}/source`, { json: { provider: c.provider, project_id: c.project_id } }), "");
      delete state.candidates[it.id]; toast("紐付けました");
    } else if (act === "src-link") {
      const r = await formSheet("配布元をURLで紐付け", `<p>Modrinth / SpigotMC / CurseForge の配布ページのURLを貼り付けてください。</p>
        ${field("URL", `<input type="url" name="url" placeholder="https://modrinth.com/plugin/luckperms" required>`)}`, "紐付け");
      if (!r) return;
      await api(`/api/items/${it.id}/source`, { json: { url: r.url } }); toast("紐付けました");
    } else if (act === "src-changelog") {
      await sheet(`${sheetHead(`${it.name} の変更履歴`)}<div class="db" id="clBody"><div style="text-align:center;padding:24px"><span class="spinner lg"></span></div></div>`, async (form) => {
        try {
          const d = await api(`/api/items/${it.id}/source/changelog`);
          $("#clBody", form).innerHTML = (d.entries.length ? d.entries.map((e) => `<div class="notes"><h4>${esc(e.version)}${e.date ? ` <span class="muted" style="font-weight:400">${esc(fmtDate(e.date))}</span>` : ""}</h4><div class="body">${esc(e.text)}</div></div>`).join("")
            : `<div class="result">保存しているバージョンより新しい変更履歴はありません</div>`)
            + (safeUrl(d.page_url) !== "#" ? `<a class="btn tinted block" href="${esc(safeUrl(d.page_url))}" target="_blank" rel="noopener noreferrer">${icon("external")}配布ページで詳しく見る</a>` : "");
        } catch (ex) { $("#clBody", form).innerHTML = `<div class="result err">${esc(ex.message)}</div>`; }
      }, { wide: true });
      return;
    } else if (act === "src-check") {
      const r = await busy(btn, () => api(`/api/items/${it.id}/source/check`, { method: "POST" }), "確認中…");
      toast(r.source.message || SRC_STATUS[r.source.status], r.source.status === "error");
    } else if (act === "src-download") {
      const r = await busy(btn, () => api(`/api/items/${it.id}/source/download`, { method: "POST" }), "ダウンロード中…");
      toast(r.status === "added" ? `保存しました: ${r.version || ""}` : (r.message || "すでに保存済みです"));
    } else if (act === "src-filter") {
      const s = it.source;
      const r = await formSheet("絞り込み条件", `<p>最新版を探すときの条件です。Mod は Minecraft のバージョンを指定しないと、別のバージョン向けのものが「最新」になることがあります。カンマ区切りで複数指定できます。</p>
        ${field("ローダー(例: paper, spigot / fabric / neoforge / forge)", `<input type="text" name="loaders" value="${esc(s.loaders.join(", "))}">`)}
        ${field("Minecraft のバージョン(例: 1.20.1, 1.21.1)", `<input type="text" name="game_versions" value="${esc(s.game_versions.join(", "))}">`)}`, "保存して確認");
      if (!r) return;
      await api(`/api/items/${it.id}/source`, { method: "PATCH", json: r });
    } else if (act === "src-unlink") {
      if (!(await confirmSheet("紐付けを解除しますか?", "保存しているファイルはそのまま残ります。", "解除"))) return;
      await api(`/api/items/${it.id}/source`, { method: "DELETE" });
    }
    await refresh();
  } catch (e) { toast(e.message, true); renderPanel(); }
}
async function runUpdates(opts) {
  try { jobStarted(await api("/api/updates/run", { json: opts })); } catch (e) { toast(e.message, true); }
}

/* ---------------- top bar actions ---------------- */
$("#addBtn").innerHTML = icon("plus");
$("#tiLib").innerHTML = icon("box");
$("#tiDash").innerHTML = icon("grid");
$("#tiSets").innerHTML = icon("stack");
$("#tiSrv").innerHTML = icon("server");
$("#updBtn").innerHTML = icon("refresh");
$("#settingsBtn").innerHTML = icon("gear");
$("#dropIcon").innerHTML = icon("tray");
$("#searchIcon").innerHTML = icon("search");
$("#addBtn").addEventListener("click", (e) => openMenu(e.currentTarget, [
  { label: "ファイルを選択", icon: "doc", run: () => $("#fileInput").click() },
  { label: "フォルダを選択", icon: "folder", run: () => $("#dirInput").click() },
  { label: "URLから追加", icon: "link", run: importFromUrl },
  "-",
  { label: "inbox を取り込む", icon: "tray", run: scanInbox },
]));
$("#updBtn").addEventListener("click", (e) => openMenu(e.currentTarget, [
  { label: "更新を確認", icon: "refresh", run: () => runUpdates({ check: true }) },
  { label: "未連携の配布元を探して確認", icon: "wand", run: () => runUpdates({ detect: true, check: true }) },
  { label: "確認して更新をすべて保存", icon: "download", run: () => runUpdates({ check: true, download: true }) },
]));
$("#settingsBtn").addEventListener("click", () => openSettings());

async function importFromUrl() {
  const r = await formSheet("URLから追加", `<p>Modrinth / SpigotMC / CurseForge の配布ページのURLから最新版をダウンロードして登録し、配布元も紐付けます。</p>
    ${field("URL", `<input type="url" name="url" placeholder="https://modrinth.com/mod/fabric-api" required>`)}
    ${field("ローダー(Mod は指定を推奨。例: fabric / neoforge / forge / paper)", `<input type="text" name="loaders">`)}
    ${field("Minecraft のバージョン(Mod は指定を推奨。例: 1.20.1)", `<input type="text" name="game_versions">`)}`, "取得して登録");
  if (!r) return;
  const t = toastProgress("取得しています…");
  try {
    const d = await api("/api/import", { json: r });
    toast(d.status === "added" ? `追加しました: ${d.name} ${d.version || ""}` : `登録済みです: ${d.name} ${d.version || ""}`);
    await refresh();
    if (d.item_id) openPanel(d.item_id);
  } catch (e) { toast(e.message, true); }
  finally { t.remove(); }
}
function toastProgress(msg) {
  const el = document.createElement("div");
  el.className = "toast glass";
  el.innerHTML = `<span class="spinner"></span><span></span>`;
  el.lastChild.textContent = msg;
  $("#toasts").appendChild(el);
  return el;
}
async function scanInbox() {
  const t = toastProgress("inbox を取り込んでいます…");
  try {
    const r = await api("/api/scan", { method: "POST" });
    const parts = [`${r.added} 件追加`];
    if (r.duplicates) parts.push(`${r.duplicates} 件は登録済み(inbox に残っています)`);
    if (r.missing) parts.push(`見つからないファイル ${r.missing} 件`);
    toast(r.scanned || r.missing ? "取り込み完了: " + parts.join("、") : "取り込むファイルはありませんでした", r.errors.length > 0);
    r.errors.slice(0, 3).forEach((m) => toast(m, true));
    await refresh();
  } catch (e) { toast(e.message, true); }
  finally { t.remove(); }
}

/* ---------------- jobs ---------------- */
let jobTimer = null;
const seenDone = new Set();
async function pollJobs() {
  clearTimeout(jobTimer);
  if (!state.user) return;
  try {
    const { jobs } = await api("/api/jobs");
    const first = !state.jobsLoaded; state.jobsLoaded = true;
    for (const j of jobs) {
      if (j.status !== "running" && !seenDone.has(j.id)) {
        seenDone.add(j.id);
        if (!first && j.kind !== "selfupdate") { toast(`${j.title}: ${j.status === "done" ? "完了しました" : "エラーで終了しました"}`, j.status !== "done"); refresh(); }
      }
    }
    state.jobs = jobs.filter((j) => j.kind !== "selfupdate" && (j.status === "running" || Date.now() - new Date(j.finished).getTime() < 5 * 60 * 1000) && !state.hiddenJobs?.has(j.id));
    renderJobs();
    jobTimer = setTimeout(pollJobs, jobs.some((j) => j.status === "running") ? 1500 : 15000);
  } catch { jobTimer = setTimeout(pollJobs, 15000); }
}
function renderJobs() {
  $("#jobs").innerHTML = state.jobs.map((j) => {
    const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    return `<div class="job${j.status === "error" ? " error" : ""}">
      <div class="jl"><div class="l">${j.status === "running" ? '<span class="spinner"></span>' : `<span class="cicon sm ${j.status === "done" ? "c-mod" : "c-red"}">${icon(j.status === "done" ? "check" : "x")}</span>`}
        <div><div style="font-weight:600">${esc(j.title)}</div><div class="muted">${j.status === "running" ? `実行中 ${j.done} / ${j.total || "?"}` : j.status === "done" ? "完了" : "エラーで終了"}${j.user ? ` · ${esc(j.user)}` : ""}</div></div></div>
        ${j.status !== "running" ? `<button class="close-x" type="button" data-jclose="${j.id}" aria-label="閉じる">${icon("x")}</button>` : ""}</div>
      ${j.status === "running" ? `<div class="progress${j.total ? "" : " indet"}"><i style="width:${pct}%"></i></div>` : ""}
      ${j.log.length ? `<details${j.status !== "running" ? " open" : ""}><summary>記録 (${j.log.length})</summary><div class="log">${esc(j.log.slice(-40).join("\n"))}</div></details>` : ""}
    </div>`;
  }).join("");
}
$("#jobs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-jclose]"); if (!b) return;
  (state.hiddenJobs ||= new Set()).add(b.dataset.jclose);
  state.jobs = state.jobs.filter((j) => j.id !== b.dataset.jclose); renderJobs();
});
function jobStarted(j) { toast(`${j.title}を開始しました`); seenDone.delete(j.id); pollJobs(); }

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
  root.innerHTML = `${sheetHead(page.title(cur.arg), back)}<div class="db" id="setBody"><div style="text-align:center;padding:30px"><span class="spinner lg"></span></div></div>`;
  $("[data-sback]", root)?.addEventListener("click", popSettings);
  const body = $("#setBody", root);
  try { await page.render(body, cur.arg); }
  catch (e) { body.innerHTML = `<div class="result err">${esc(e.message)}</div>`; }
}
const themeName = (p) => (p && p.theme === "custom" ? "マイ画像" : (THEMES.find((t) => t.id === (p && p.theme)) || THEMES[0]).name);
const rowBtn = (key, ic, color, title, val = "", extra = "") =>
  `<button class="row" type="button" data-go="${key}" ${extra}><span class="cicon sm ${color}">${icon(ic)}</span><span class="main"><span class="title">${esc(title)}</span></span><span class="trail">${val}${icon("chev", "i chev")}</span></button>`;

const SETTINGS_PAGES = {
  root: {
    title: () => "設定",
    async render(body) {
      const u = state.user;
      const upd = state.selfUpd && state.selfUpd.update_available;
      body.innerHTML = `
        <div class="group">${rowBtn("appearance", "sparkle", "c-resourcepack", "テーマと背景", `<span class="val">${esc(themeName(state.prefs))}</span>`)}</div>
        <div class="group-title">アカウント</div>
        <div class="group"><div class="row"><span class="cicon c-teal">${icon("person")}</span>
          <span class="main"><span class="title">${esc(u.username)}</span><span class="subtitle">${esc(u.role_label)}</span></span></div>
          ${rowBtn("password", "key", "c-gray", "パスワードを変更")}
          <button class="row danger" type="button" data-go="logout"><span class="cicon sm c-red">${icon("logout")}</span><span class="main"><span class="title">ログアウト</span></span></button>
        </div>
        ${isAdmin() ? `<div class="group-title">管理</div><div class="group">
          ${rowBtn("storage", "server", "c-plugin", "ストレージ", `<span class="val">${esc(state.storage?.target?.name || "")}</span>`)}
          ${rowBtn("users", "users", "c-resourcepack", "ユーザー")}
          ${rowBtn("updates", "clock", "c-datapack", "配布元の更新確認")}
          ${rowBtn("curseforge", "key", "c-other", "CurseForge APIキー")}
        </div>
        <div class="group-title">連携と運用</div><div class="group">
          ${rowBtn("ptero", "server", "c-teal", "Pterodactyl 連携")}
          ${rowBtn("discord", "sparkle", "c-plugin", "Discord 通知")}
          ${rowBtn("backup", "download", "c-mod", "バックアップ")}
          ${rowBtn("audit", "doc", "c-gray", "操作の記録")}
        </div>` : ""}
        <div class="group-title">CraftShelf</div><div class="group">
          ${isAdmin() ? rowBtn("selfupdate", "sparkle", "c-mod", "パネルのアップデート", upd ? `<span class="badge upd">v${esc(state.selfUpd.latest)}</span>` : `<span class="val">v${esc(state.version || "")}</span>`)
          : `<div class="row"><span class="cicon sm c-mod">${icon("sparkle")}</span><span class="main"><span class="title">バージョン</span></span><span class="trail">v${esc(state.version || "")}</span></div>`}
        </div>
        <div class="group-foot">CraftShelf v${esc(state.version || "")}${state.build ? ` · ${esc(state.build)}` : ""}</div>`;
      body.onclick = async (e) => {
        const b = e.target.closest("[data-go]"); if (!b) return;
        if (b.dataset.go === "logout") {
          await api("/api/auth/logout", { method: "POST" }).catch(() => {});
          $("#dlg").close(); showAuth(false); return;
        }
        pushSettings(b.dataset.go);
      };
    },
  },
  appearance: {
    title: () => "テーマと背景",
    async render(body) {
      const p = state.prefs || {};
      const cur = p.theme || "mint";
      const tile = (id, name, bgCss) => `<button class="theme-tile" type="button" data-theme="${id}" aria-pressed="${cur === id}">
        <span class="sw" style="background:${esc(bgCss)}">${cur === id ? `<span class="ck">${icon("check")}</span>` : ""}</span>${esc(name)}</button>`;
      const mintBg = "radial-gradient(120% 80% at 10% 0%, rgba(52,199,89,.35), transparent 60%), radial-gradient(90% 70% at 100% 0%, rgba(0,122,255,.25), transparent 60%), #f2f2f7";
      const dim = p.bg_dim ?? (cur === "custom" ? 20 : 0);
      body.innerHTML = `<p>パネルの背景を選べます。設定はアカウントごとに保存されます。</p>
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
      body.innerHTML = `<p>Pterodactyl パネルの「アカウント → API 認証情報」で作った <b>Client API キー(ptlc_…)</b>を登録すると、そのユーザーが操作できるサーバーへプラグインを転送・同期できます。</p>
        ${field("パネルの URL", `<input type="url" name="url" value="${esc(st.ptero_url || "")}" placeholder="https://panel.example.com">`)}
        ${field(st.ptero_key_set ? "APIキー(登録済み。変更する場合のみ)" : "APIキー", `<input type="password" name="key" autocomplete="off" placeholder="ptlc_…">`)}
        <div class="group">${toggle("insecure", "証明書を検証しない", "自己署名証明書を使っている場合", st.ptero_insecure)}</div>
        <div class="result" id="ptRes" hidden></div>
        <div class="df row2" style="padding:0"><button class="btn" type="button" id="ptTest">接続テスト</button><button class="btn filled" type="button" id="ptSave">保存</button></div>`;
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
      body.innerHTML = `<p>Discord のチャンネル設定 → 「連携サービス」→「ウェブフック」で作った URL を登録すると、選んだ出来事を通知します。</p>
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
        <div class="group-title">保存されているバックアップ</div><div class="group" id="bkList"><div class="empty"><span class="spinner"></span></div></div>`;
      const save = () => api("/api/settings", { method: "PATCH", json: { backup_target_id: Number($("[name=target]", body).value), backup_keep: Number($("[name=keep]", body).value) } });
      $("#bkSave", body).onclick = (e) => busy(e.currentTarget, async () => { try { await save(); toast("保存しました"); renderSettings(); } catch (ex) { toast(ex.message, true); } });
      $("#bkRun", body).onclick = (e) => busy(e.currentTarget, async () => {
        try { await save(); jobStarted(await api("/api/backup/run", { method: "POST" })); } catch (ex) { toast(ex.message, true); }
      }, "開始しています…");
      try {
        const l = await api("/api/backup/list");
        $("#bkList", body).innerHTML = l.files.length ? l.files.map((f) => `<a class="row noicon" href="/api/backup/download/${encodeURIComponent(f)}"><span class="main"><span class="title">${esc(f)}</span><span class="subtitle">${esc(l.target)}</span></span><span class="trail">${icon("download")}</span></a>`).join("")
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
      body.innerHTML = `<p>閲覧のみ: 見る・ダウンロード / 編集者: 登録・編集・削除・更新の取得 / 管理者: すべて</p>
        <div class="group">${users.map((u) => `<button class="row" type="button" data-uid="${u.id}"><span class="cicon sm c-teal">${icon("person")}</span>
          <span class="main"><span class="title">${esc(u.username)}${u.id === state.user.id ? "(自分)" : ""}</span><span class="subtitle">${esc(u.role_label)}${u.last_login ? ` · 最終ログイン ${fmtDateTime(u.last_login)}` : ""}</span></span>
          <span class="trail">${icon("chev", "i chev")}</span></button>`).join("")}</div>
        <button class="btn tinted block" type="button" id="uAdd">${icon("plus")}ユーザーを追加</button>`;
      body.onclick = (e) => {
        const r = e.target.closest("[data-uid]"); if (r) pushSettings("user", users.find((u) => u.id === Number(r.dataset.uid)));
      };
      $("#uAdd", body).onclick = () => pushSettings("user", null);
    },
  },
  user: {
    title: (u) => (u ? u.username : "ユーザーを追加"),
    async render(body, u) {
      const roleOpts = Object.entries(state.roles).map(([k, n]) => `<option value="${k}"${(u ? u.role : "editor") === k ? " selected" : ""}>${esc(n)}</option>`).join("");
      body.innerHTML = `${u ? "" : field("ユーザー名", `<input type="text" name="username" autocomplete="off">`)}
        ${field("権限", `<select name="role">${roleOpts}</select>`)}
        ${field(u ? "新しいパスワード(変更する場合のみ・8文字以上)" : "パスワード(8文字以上)", `<input type="password" name="password" autocomplete="new-password">`)}
        <button class="btn filled block" type="button" id="uSave">${u ? "保存" : "追加"}</button>
        ${u && u.id !== state.user.id ? `<button class="btn danger block" type="button" id="uDel">このユーザーを削除</button>` : ""}`;
      $("#uSave", body).onclick = (e) => busy(e.currentTarget, async () => {
        const d = { role: $("[name=role]", body).value };
        const pw = $("[name=password]", body).value;
        try {
          if (u) { if (pw) d.password = pw; await api(`/api/users/${u.id}`, { method: "PATCH", json: d }); }
          else { d.username = $("[name=username]", body).value.trim(); d.password = pw; await api("/api/users", { json: d }); }
          toast("保存しました"); popSettings();
        } catch (ex) { toast(ex.message, true); }
      });
      $("#uDel", body)?.addEventListener("click", async (e) => {
        if (!confirm(`「${u.username}」を削除しますか?`)) return;
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
            if (!confirm(`「${t.name}」を削除しますか?`)) return;
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
        <div class="group scroll">${d.items.map((i) => `<div class="row"><span class="cicon sm c-${i.category}">${CAT_LETTER[i.category]}</span>
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
        if (mode === "move" && !confirm(`コピーに成功したファイルは「${src.name}」から削除されます。よろしいですか?`)) return;
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
      body.innerHTML = `<div class="big-version"><div class="logo"><svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8"/></svg></div>
          <div class="v">${d.update_available ? `v${esc(d.latest)}` : `v${esc(d.current)}`}</div>
          <p>${d.error ? esc(d.error) : d.update_available ? `現在 v${esc(d.current)} · 新しいバージョンがあります` : "CraftShelf は最新です"}</p></div>
        ${d.notes && d.notes.length ? `<div class="notes">${d.notes.map((n) => `<h4>v${esc(n.version)} ${esc(n.title)}</h4><div class="body">${esc(n.body)}</div>`).join("")}</div>` : ""}
        ${d.update_available ? `<button class="btn filled block" type="button" id="suGo">ダウンロードしてインストール</button>
          <div class="group-foot" style="text-align:center">インストール後に自動で再起動します(数秒〜数十秒)。保存したファイルや登録情報はそのまま残ります。</div>`
          : `<button class="btn tinted block" type="button" id="suRe">${icon("refresh")}もう一度確認</button>`}
        <div class="group" style="margin-top:6px">${toggle("self_auto_update", "自動アップデート", "6時間ごとに確認し、新しいバージョンがあれば自動でインストールします", (await api("/api/settings")).self_auto_update)}</div>
        <div class="group-foot">取得元: <a href="https://github.com/${esc(d.repo)}" target="_blank" rel="noopener noreferrer">github.com/${esc(d.repo)}</a> (${esc(d.branch)})</div>`;
      $("#suRe", body)?.addEventListener("click", (e) => busy(e.currentTarget, () => renderSettings(), "確認中…"));
      $("#suGo", body)?.addEventListener("click", (e) => busy(e.currentTarget, () => startSelfUpdate(d), "開始しています…"));
      body.onchange = async (e) => {
        if (e.target.name !== "self_auto_update") return;
        try { await api("/api/settings", { method: "PATCH", json: { self_auto_update: e.target.checked } }); toast("保存しました"); }
        catch (ex) { toast(ex.message, true); }
      };
    },
  },
};

/* ---------------- パネル自身のアップデート ---------------- */
async function checkSelfUpdate(force) {
  try {
    const d = await api("/api/system/update" + (force ? "?force=1" : ""));
    state.selfUpd = d;
    const btn = $("#settingsBtn");
    btn.querySelector(".dot")?.remove();
    if (d.update_available) btn.insertAdjacentHTML("beforeend", '<span class="dot" title="パネルの新しいバージョンがあります"></span>');
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
  draw(0, "GitHub から取得しています…(画面を閉じずにお待ちください)");
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

/* ---------------- upload ---------------- */
const OKEXT = /\.(jar|zip|7z|rar|mcpack|disabled)$/i;
const tasks = []; let active = 0; let batchAdded = 0, batchDup = 0, batchErr = 0, queueRaf = 0;
function enqueue(files) {
  if (!isEditor()) { toast("登録するには編集者以上の権限が必要です", true); return; }
  if (state.storage && state.storage.error) { toast("保存先に接続できていないため、登録できません", true); return; }
  files = files.filter(Boolean);
  if (!files.length) { toast("対象のファイルが見つかりませんでした", true); return; }
  const category = $("#catOverride").value;
  for (const file of files) tasks.push({ file, category, status: "wait", pct: 0, msg: "待機中" });
  $("#queue").hidden = false;
  drawQueue(); pump();
}
function pump() {
  while (active < 3) {
    const t = tasks.find((x) => x.status === "wait");
    if (!t) break;
    t.status = "run"; active++;
    upload(t).then(() => { active--; pump(); if (!active && !tasks.some((x) => x.status === "wait")) finishBatch(); });
  }
}
function upload(t) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/upload?filename=" + encodeURIComponent(t.file.name) + (t.category ? "&category=" + t.category : ""));
    xhr.setRequestHeader("X-Requested-With", "mcpl");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) { t.pct = Math.round((e.loaded / e.total) * 100); t.msg = t.pct >= 100 ? "解析中…" : `アップロード中 ${t.pct}%`; scheduleQueue(); }
    };
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300 && d) {
        t.pct = 100;
        if (d.status === "added") { t.status = "added"; batchAdded++; t.msg = `追加: ${d.name} ${d.version || "(版不明)"} [${CATS[d.category]}]`; scheduleRefresh(); }
        else { t.status = "dup"; batchDup++; t.msg = `登録済み: ${d.name} ${d.version || ""}`; }
      } else { t.status = "error"; batchErr++; t.msg = (d && d.error) || `エラー (HTTP ${xhr.status})`; }
      scheduleQueue(); resolve();
    };
    xhr.onerror = () => { t.status = "error"; batchErr++; t.msg = "通信に失敗しました"; scheduleQueue(); resolve(); };
    xhr.send(t.file);
  });
}
function finishBatch() {
  const parts = [`${batchAdded} 件追加`];
  if (batchDup) parts.push(`${batchDup} 件は登録済み`);
  if (batchErr) parts.push(`${batchErr} 件エラー`);
  toast("登録完了: " + parts.join("、"), batchErr > 0);
  batchAdded = batchDup = batchErr = 0;
  refresh();
}
function scheduleQueue() { if (!queueRaf) queueRaf = requestAnimationFrame(() => { queueRaf = 0; drawQueue(); }); }
function drawQueue() {
  const done = tasks.filter((t) => ["added", "dup", "error"].includes(t.status)).length;
  $("#queueSummary").textContent = `${done} / ${tasks.length} 件完了`;
  $("#queueList").innerHTML = tasks.slice(-300).map((t) => `
    <div class="qrow ${t.status === "added" ? "added" : t.status === "error" ? "error" : ""}">
      <div class="fn" title="${esc(t.file.name)}">${esc(t.file.name)}</div>
      <div><div class="st" title="${esc(t.msg)}">${esc(t.msg)}</div>${t.status === "run" ? `<div class="progress"><i style="width:${t.pct}%"></i></div>` : ""}</div>
    </div>`).join("");
  const list = $("#queueList"); if (tasks.some((t) => t.status === "run")) list.scrollTop = list.scrollHeight;
}
$("#queueClear").addEventListener("click", () => {
  for (let i = tasks.length - 1; i >= 0; i--) if (["added", "dup", "error"].includes(tasks[i].status)) tasks.splice(i, 1);
  if (!tasks.length) $("#queue").hidden = true; else drawQueue();
});
$("#pickFiles").addEventListener("click", () => $("#fileInput").click());
$("#pickDir").addEventListener("click", () => $("#dirInput").click());
$("#fileInput").addEventListener("change", (e) => { enqueue([...e.target.files]); e.target.value = ""; });
$("#dirInput").addEventListener("change", (e) => { enqueue([...e.target.files].filter((f) => OKEXT.test(f.name))); e.target.value = ""; });

/* drag & drop(ウィンドウ全体で受ける / フォルダも再帰的に読む) */
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
let dragDepth = 0;
const canDrop = () => isEditor() && !$("#dlg").open;
window.addEventListener("dragenter", (e) => { if (!hasFiles(e) || !canDrop()) return; e.preventDefault(); dragDepth++; $("#overlay").classList.add("on"); });
window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = canDrop() ? "copy" : "none"; });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#overlay").classList.remove("on"); });
window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("#overlay").classList.remove("on");
  if (!canDrop()) return;
  enqueue(await collectDropped(e.dataTransfer));
});
async function collectDropped(dt) {
  const entries = [], loose = [];
  for (const it of [...(dt.items || [])]) {
    if (it.kind !== "file") continue;
    const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (en) entries.push(en); else { const f = it.getAsFile(); if (f) loose.push(f); }
  }
  if (!entries.length && !loose.length) return [...(dt.files || [])];
  const out = loose;
  for (const en of entries) await walk(en, out, false);
  return out;
}
async function walk(entry, out, inDir) {
  if (entry.isFile) {
    const f = await new Promise((res) => entry.file(res, () => res(null)));
    if (f && (!inDir || OKEXT.test(f.name))) out.push(f);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      for (const e of batch) await walk(e, out, true);
    } while (batch.length);
  }
}

/* ---------------- init ---------------- */
(function init() {
  applyTheme(readCachedTheme(), { loggedIn: false });
  const sel = $("#catOverride");
  for (const [k, n] of Object.entries(CATS)) sel.insertAdjacentHTML("beforeend", `<option value="${k}">${n}として登録</option>`);
  checkAuth();
})();
