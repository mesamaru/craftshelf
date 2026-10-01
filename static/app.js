"use strict";
/* CraftShelf — 画面の処理 */

const $ = (s, root = document) => root.querySelector(s);
const CATS = { plugin: "プラグイン", mod: "Mod", datapack: "データパック", resourcepack: "リソースパック", shader: "シェーダー", modpack: "Modパック", other: "その他" };
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
  puzzle: '<path d="M9 3h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v7H4v-7a2 2 0 1 0 0-4V3z"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  braces: '<path d="M8 4c-2 0-3 1-3 3v3l-2 2 2 2v3c0 2 1 3 3 3M16 4c2 0 3 1 3 3v3l2 2-2 2v3c0 2-1 3-3 3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8" r="1.4"/>',
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
    const dlg = $("#dlg");
    // 前のシートで付けたイベントが残って誤作動しないよう、フォームは毎回作り直す
    const oldForm = $("#dlgForm"), form = oldForm.cloneNode(false);
    oldForm.replaceWith(form);
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
    `<button type="button" role="menuitem" data-i="${i}" class="${it.admin ? "need-admin" : ""}${it.danger ? " danger" : ""}"><span>${esc(it.label)}</span>${icon(it.icon)}</button>`).join("");
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
  if (state.prefs.lang) setLang(state.prefs.lang);
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

/* ---------------- data ---------------- */
let refreshTimer = null;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }
async function refresh() {
  try {
    const d = await api("/api/library");
    state.items = d.items; state.storage = d.storage; state.version = d.version; state.build = d.build;
    await loadPresence();
    if (!state.mcLoaded) { state.mcLoaded = true; loadMcVersions(); }
    if (state.selected && !state.items.some((i) => i.id === state.selected)) closePanel();
    render();
  } catch (e) { if (state.user) toast("読み込みに失敗しました: " + e.message, true); }
}

/* ---------------- 種類・配布元のアイコン ---------------- */
const CAT_ICON = { plugin: "puzzle", mod: "cube", datapack: "braces", resourcepack: "image", shader: "sun", modpack: "stack", other: "doc" };
const catGlyph = (cat) => icon(CAT_ICON[cat] || "doc");
const PROVIDER_STYLE = { modrinth: ["M", "#1bd96a", "#04210d"], spigot: ["S", "#ed8106", "#fff"], curseforge: ["C", "#f16436", "#fff"] };
function providerBadge(p, title = "") {
  const [ch, bg, fg] = PROVIDER_STYLE[p] || ["?", "var(--gray)", "#fff"];
  return `<span class="pbadge" style="background:${bg};color:${fg}" title="${esc(title || PROVIDERS[p] || p)}" aria-label="${esc(PROVIDERS[p] || p)}">${ch}</span>`;
}

/* ---------------- サーバーへの配置状況(最後に確認した内容から) ---------------- */
async function loadPresence() {
  try { state.presence = await api("/api/servers/presence"); } catch { state.presence = null; }
}
function presenceOf(it) { return (state.presence && state.presence.items[it.id]) || []; }
function presenceBadge(it) {
  const p = presenceOf(it);
  if (!p.length) return "";
  const pending = p.filter((x) => x.status !== "latest");
  const tip = p.map((x) => `${x.server}: ${x.status === "latest" ? `最新 ${x.version}` : x.status === "outdated" ? `未同期(${x.version})` : "未導入"}`).join("\n");
  return `<span class="srvmark${pending.length ? " pending" : ""}" title="${esc(tip)}">${icon("server")}${p.length}${pending.length ? '<i class="pdot"></i>' : ""}</span>`;
}
function serversSectionHTML(it) {
  const p = presenceOf(it);
  if (!p.length) return "";
  const lbl = { latest: '<span class="badge ok">最新</span>', outdated: '<span class="badge upd">未同期</span>', missing: '<span class="badge upd">未導入</span>' };
  return `<details class="sect" data-sect="servers"${sectOpen("servers", true) ? " open" : ""}>
    <summary><span>サーバー</span><span class="sum-r">${p.some((x) => x.status !== "latest") ? '<span class="badge upd">未同期あり</span>' : '<span class="badge ok">同期済み</span>'}${icon("chev", "i chev")}</span></summary>
    <div class="group">${p.map((x) => `<div class="row"><span class="cicon sm c-teal">${icon("server")}</span>
      <span class="main"><span class="title">${esc(x.server)}</span><span class="subtitle">${x.version ? esc(x.version) : "入っていません"}</span></span>
      <span class="trail">${lbl[x.status] || ""}${x.status !== "latest" ? `<button class="btn small tinted need-editor" type="button" data-act="srv-sync" data-srv="${x.server_id}">同期</button>` : ""}</span></div>`).join("")}</div></details>`;
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
  if (state.tag) list = list.filter((it) => (it.tags || []).includes(state.tag));
  if (state.plat) list = list.filter((it) => platformOf(it) === state.plat);
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
  const emptyCats = Object.keys(CATS).filter((k) => !counts[k] && state.cat !== k && k !== "other");
  $("#chips").innerHTML = ["all", ...Object.keys(CATS)].filter((k) => k === "all" || counts[k] > 0 || state.cat === k)
    .map((k) => `<button class="seg${k !== "all" && !counts[k] ? " zero" : ""}" type="button" data-cat="${k}" aria-pressed="${state.cat === k}">${k === "all" ? "" : `<span class="segi c-${k}">${catGlyph(k)}</span>`}${k === "all" ? "すべて" : CATS[k]}<span class="n">${counts[k]}</span></button>`).join("")
    + (nUpd || state.cat === "__upd" ? `<button class="seg upd" type="button" data-cat="__upd" aria-pressed="${state.cat === "__upd"}">更新あり<span class="n">${nUpd}</span></button>` : "")
    + (nDeps || state.cat === "__deps" ? `<button class="seg upd" type="button" data-cat="__deps" aria-pressed="${state.cat === "__deps"}">前提が不足<span class="n">${nDeps}</span></button>` : "")
    + (state.cat === "__unlinked" ? `<button class="seg" type="button" data-cat="__unlinked" aria-pressed="true">未連携<span class="n">${state.items.filter((i) => !i.source).length}</span></button>` : "")
    + (state.cat === "__nomc" ? `<button class="seg" type="button" data-cat="__nomc" aria-pressed="true">MC不明<span class="n">${state.items.filter((i) => !mcOf(i)).length}</span></button>` : "")
    + (emptyCats.length ? `<button class="seg seg-more" type="button" id="catMore" aria-haspopup="menu">ほかの種類${icon("down")}</button>` : "");
  state.emptyCats = emptyCats;
  const tags = [...new Set(state.items.flatMap((i) => i.tags || []))].sort((a, b) => a.localeCompare(b, "ja"));
  if (state.tag && !tags.includes(state.tag)) state.tag = "";
  $("#tagChips").hidden = !tags.length;
  $("#tagChips").innerHTML = tags.length ? `<span class="tag-lab">${icon("tag")}</span>` + tags.map((t) => `<button class="tagchip" type="button" data-tagf="${esc(t)}" aria-pressed="${state.tag === t}">#${esc(t)}</button>`).join("") : "";
  const platSel = $("#platSel");
  const plats = PLATFORMS.map((p) => [p, state.items.filter((i) => platformOf(i) === p).length]).filter(([p, n]) => n || p === state.plat);
  platSel.innerHTML = `<option value="">サーバーソフト: すべて</option>` + plats.map(([p, n]) => `<option value="${esc(p)}" translate="no">${esc(p)}(${n})</option>`).join("");
  platSel.value = state.plat || "";
  const mcSel = $("#mcSel");
  if (mcSel.options.length === 1) mcSel.insertAdjacentHTML("beforeend", MC_LINES.map((v) => `<option value="${v}">MC ${v}</option>`).join(""));
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
      const plat = platformOf(it);
      const picked = state.selMode && state.sel.has(it.id);
      return `<div class="row${state.selected === it.id ? " sel" : ""}${picked ? " picked" : ""}" role="button" tabindex="0" data-id="${it.id}">
        ${state.selMode ? `<span class="pick${picked ? " on" : ""}" aria-hidden="true">${picked ? icon("check") : ""}</span>` : ""}
        ${itemIcon(it)}
        <span class="main"><span class="title" translate="no">${esc(it.name)}</span>
          <span class="subtitle">${plat ? `<span class="plat" translate="no">${esc(plat)}</span>` : ""}${esc(verLabel(latest.version))}${mc ? ` · MC ${esc(mc)}` : ""} · ${it.versions.length} バージョン<span class="hide-s"> · ${fmtSize(it.total_size)} · ${fmtDate(it.last_added)}</span></span>
          ${(it.tags || []).length ? `<span class="rtags">${it.tags.slice(0, 4).map((t) => `<span class="tagchip mini" translate="no">#${esc(t)}</span>`).join("")}</span>` : ""}</span>
        <span class="trail">${missing ? '<span class="badge err">欠損</span>' : ""}${(it.missing_deps || []).length ? `<span class="badge err" title="足りない前提: ${esc(it.missing_deps.join(", "))}">前提が不足</span>` : ""}${upd ? `<span class="badge upd">更新 ${esc(it.source.latest.version || "")}</span>` : ""}
          ${presenceBadge(it)}
          ${page !== "" && page !== "#" ? `<a class="plink" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="${esc(it.source.provider_label)} の配布ページを開く">${providerBadge(it.source.provider, `${it.source.provider_label}(${SRC_STATUS[it.source.status] || ""})`)}</a>` : ""}
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
  $("#storageInfo").innerHTML = t ? `<span class="status-dot ${s.error ? "err" : "ok"}"></span>${icon(t.protocol === "local" ? "box" : "server")}<span class="t">${esc(t.name)}</span>` : "";
  $("#storageInfo").title = t ? `保存先: ${t.name}(押すと状況を表示)` : "";
  const banner = $("#storageBanner");
  banner.hidden = !s.error;
  banner.innerHTML = s.error ? `<span>⚠️ ${esc(s.error)}</span>${isAdmin() ? `<button class="btn small tinted" type="button" id="bannerOpen">ストレージ設定を開く</button>` : ""}` : "";
  $("#bannerOpen")?.addEventListener("click", () => openSettings("storage"));
  $("#drop").classList.toggle("disabled", !!s.error);
}

/* 保存先(NAS など)の状況 */
async function storageStatusSheet() {
  const body = (d) => {
    if (!d) return `<div class="empty"><span class="spinner"></span></div>`;
    const t = d.target || {}, c = d.capacity, u = d.usage || {};
    const pct = c && c.total ? Math.min(100, Math.round((1 - c.free / c.total) * 100)) : null;
    const ours = c && c.total ? Math.max(0.5, (u.bytes / c.total) * 100) : 0;
    return `<div class="group"><div class="row noicon"><span class="main"><span class="title"><span class="status-dot ${d.connected ? "ok" : "err"}" style="display:inline-block;margin-right:8px"></span>${d.connected ? "接続しています" : "接続できません"}</span>
        ${d.error ? `<span class="subtitle brk">${esc(d.error)}</span>` : ""}</span>
        ${d.latency_ms != null ? `<span class="trail"><span class="badge ${d.latency_ms < 300 ? "ok" : d.latency_ms < 1500 ? "upd" : "err"}">応答時間 ${d.latency_ms} ms</span></span>` : ""}</div></div>
      <div class="group"><div class="card-b" style="padding:12px 14px">
        <div class="kv"><span>名前</span><span translate="no">${esc(t.name || "")}</span></div>
        <div class="kv"><span>種類</span><span>${esc(t.protocol_label || t.protocol || "")}</span></div>
        ${d.where ? `<div class="kv"><span>場所</span><span translate="no">${esc(d.where)}</span></div>` : ""}
      </div></div>
      <div class="group-title">保存先の容量</div>
      <div class="group"><div class="card-b" style="padding:12px 14px">
        ${c ? `<div class="meter stack"><i style="width:${pct}%"></i><b style="width:${Math.min(ours, pct)}%"></b></div>
          <div class="kv"><span>使用済み</span><span>${fmtSize(c.total - c.free)} / ${fmtSize(c.total)}(${pct}%)</span></div>
          <div class="kv"><span>空き容量</span><span>${fmtSize(c.free)}</span></div>`
          : `<div class="muted" style="margin:0">${d.connected ? "この保存先は容量の情報を返しません" : "接続できないため取得できません"}</div>`}
        <div class="kv"><span>CraftShelf の使用量</span><span>${fmtSize(u.bytes || 0)}(${u.items || 0} 件 · ${u.files || 0} ファイル)</span></div>
      </div></div>
      <div class="group"><div class="card-b" style="padding:12px 14px">
        <div class="kv"><span>自動バックアップ</span><span>${d.backup && d.backup.enabled ? `毎日${d.backup.last ? `(前回 ${esc(fmtDateTime(d.backup.last))})` : ""}` : "設定されていません"}</span></div>
      </div></div>`;
  };
  await sheet(`${sheetHead("保存先の状況")}<div class="db" id="nasBody">${body(null)}</div>
    <div class="df row2"><button class="btn" type="button" id="nasRe">${icon("refresh")}再確認</button>
    ${isAdmin() ? `<button class="btn tinted" type="button" id="nasSet">ストレージ設定</button>` : `<button class="btn" type="button" data-close>閉じる</button>`}</div>`, (form, done) => {
    const load = async () => {
      try { $("#nasBody", form).innerHTML = body(await api("/api/storage/status")); }
      catch (e) { $("#nasBody", form).innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    $("#nasRe", form).onclick = (e) => busy(e.currentTarget, load, "確認中…");
    const s = $("#nasSet", form);
    if (s) s.onclick = () => { done(null); openSettings("storage"); };
    load();
  });
}
$("#storageInfo").addEventListener("click", () => { if (state.storage && state.storage.target) storageStatusSheet(); });
$("#storageInfo").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#storageInfo").click(); } });

$("#chips").addEventListener("click", (e) => {
  const more = e.target.closest("#catMore");
  if (more) {
    openMenu(more, (state.emptyCats || []).map((k) => ({ label: `${CATS[k]}(0)`, icon: CAT_ICON[k] || "doc",
      run: () => { state.cat = k; render(); try { localStorage.setItem("craftshelf.cat", k); } catch { /* */ } } })));
    return;
  }
  const b = e.target.closest("[data-cat]"); if (!b) return;
  state.cat = b.dataset.cat; render();
  try { if (!state.cat.startsWith("__")) localStorage.setItem("craftshelf.cat", state.cat); } catch { /* */ }
});
$("#search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#mcSel").addEventListener("change", (e) => { state.mc = e.target.value; render(); });
$("#platSel").addEventListener("change", (e) => { state.plat = e.target.value; render(); });
$("#tagChips").addEventListener("click", (e) => { const b = e.target.closest("[data-tagf]"); if (!b) return; state.tag = state.tag === b.dataset.tagf ? "" : b.dataset.tagf; render(); });
$("#sortSel").addEventListener("change", (e) => {
  const [k, d] = e.target.value.split(":"); state.sortKey = k; state.sortDir = Number(d); render();
});
$("#list").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;  // 配布ページのリンクはそのまま開く
  const r = e.target.closest(".row[data-id]"); if (!r) return;
  if (state.selMode) {
    const id = Number(r.dataset.id);
    if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
    render(); drawSelBar(); return;
  }
  openPanel(Number(r.dataset.id));
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
let MC_LINES = ["1.21", "1.20", "1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12", "1.8"];
let MC_VERSIONS = ["1.21.4", "1.21.3", "1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.2", "1.20.1", "1.19.4", "1.19.2", "1.18.2", "1.17.1", "1.16.5", "1.15.2", "1.14.4", "1.13.2", "1.12.2", "1.8.9"];
/* Mojang の公式一覧から、系列(1.21 / 26.1 など)と主なバージョンを作り直す */
async function loadMcVersions() {
  let list;
  try { list = (await api("/api/mc/versions")).versions; } catch { return; }
  if (!list || !list.length) return;
  const lineOf = (v) => verNums(v).slice(0, 2).join(".");
  const lines = [...new Set(list.map(lineOf))].filter((l) => cmpVer(verNums(l), [1, 8]) >= 0);
  const recent = new Set(lines.slice(0, 2));  // 直近 2 系列は全部、それより前は各系列の最新と定番だけ
  const keep = new Set(MC_VERSIONS);
  const vers = list.filter((v, i) => cmpVer(verNums(v), [1, 8]) >= 0 && (recent.has(lineOf(v)) || keep.has(v) || list.findIndex((x) => lineOf(x) === lineOf(v)) === i));
  MC_LINES = lines.filter((l) => cmpVer(verNums(l), [1, 12]) >= 0 || l === "1.8");
  MC_VERSIONS = vers;
  const mcSel = $("#mcSel");
  if (mcSel) { const cur = mcSel.value; mcSel.length = 1; mcSel.insertAdjacentHTML("beforeend", MC_LINES.map((v) => `<option value="${v}">MC ${v}</option>`).join("")); mcSel.value = cur; }
}
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
      ${itemIcon(it, true)}
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
            <span class="lab"><span class="cicon sm c-${k}" style="width:22px;height:22px;border-radius:6px;font-size:11px">${catGlyph(k)}</span><span>${esc(CATS[k])}</span></span>
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
  arrangeDash();
}
/* ---------------- ダッシュボードのウィジェット(並べ替え・表示切り替え・幅) ---------------- */
const DASH_W = [["tiles", "概要"], ["updates", "更新があるもの"], ["cats", "種類ごとの件数"], ["attention", "確認が必要なもの"],
  ["recent", "最近追加したもの"], ["servers", "サーバー"], ["links", "配布元の連携"], ["storage", "保存先とバックアップ"]];
const DASH_DEFAULT = { order: DASH_W.map(([k]) => k), hidden: [], full: ["tiles"] };
function dashLayout() {
  const d = (state.prefs && state.prefs.dash) || {};
  const known = DASH_W.map(([k]) => k);
  const order = (d.order || []).filter((k) => known.includes(k));
  for (const k of known) if (!order.includes(k)) order.push(k);
  return { order, hidden: (d.hidden || []).filter((k) => known.includes(k)), full: d.full || DASH_DEFAULT.full };
}
function serversWidgetHTML() {
  const pr = state.presence;
  if (!pr || !pr.servers.length) return `<div class="card-h"><h4>サーバー</h4></div><div class="card-b"><div class="dash-empty">Pterodactyl のサーバーを連携すると、ここに同期の状況が表示されます</div></div>`;
  const rows = pr.servers.map((s) => {
    const entries = Object.values(pr.items).flat().filter((x) => x.server_id === s.id);
    const pend = entries.filter((x) => x.status !== "latest").length;
    return `<button class="row" type="button" data-srvgo="${s.id}"><span class="cicon sm c-teal">${icon("server")}</span>
      <span class="main"><span class="title" translate="no">${esc(s.name)}</span><span class="subtitle">${s.checked ? `${entries.length} 件を管理中` : "まだ中身を確認していません"}</span></span>
      <span class="trail">${!s.checked ? "" : pend ? `<span class="badge upd">未同期 ${pend}</span>` : '<span class="badge ok">同期済み</span>'}${icon("chev", "i chev")}</span></button>`;
  }).join("");
  return `<div class="card-h"><h4>サーバー</h4></div><div class="card-b">${rows}</div>`;
}
function arrangeDash() {
  const dash = $("#dash");
  const tiles = dash.querySelector(".tiles");
  const cards = [...dash.querySelectorAll(".dash-grid > .card")];
  const byId = { tiles };
  ["updates", "cats", "attention", "recent", "links", "storage"].forEach((k, i) => { byId[k] = cards[i]; });
  const sv = document.createElement("div"); sv.className = "card"; sv.innerHTML = serversWidgetHTML(); byId.servers = sv;
  const L = dashLayout();
  const edit = !!state.dashEdit;
  const grid = document.createElement("div");
  grid.className = "dash-grid" + (edit ? " editing" : "");
  for (const k of L.order) {
    const el = byId[k];
    if (!el || (!edit && L.hidden.includes(k))) continue;
    const w = document.createElement("section");
    w.className = "widget" + (L.full.includes(k) ? " full" : "") + (L.hidden.includes(k) ? " off" : "");
    w.dataset.w = k;
    if (edit) {
      w.draggable = true;
      w.insertAdjacentHTML("afterbegin", `<div class="wbar"><span class="whandle" title="ドラッグで並べ替え">${icon("grip")}</span>
        <span class="wname">${esc(DASH_W.find((x) => x[0] === k)[1])}</span><span class="sp"></span>
        <button class="icon-btn sm" type="button" data-wa="up" title="前へ" aria-label="前へ">${icon("up")}</button>
        <button class="icon-btn sm" type="button" data-wa="down" title="後ろへ" aria-label="後ろへ">${icon("down")}</button>
        <button class="icon-btn sm" type="button" data-wa="size" title="${L.full.includes(k) ? "半分の幅にする" : "全幅にする"}" aria-label="幅を切り替え">${icon(L.full.includes(k) ? "shrink" : "expand")}</button>
        <button class="icon-btn sm" type="button" data-wa="hide" title="${L.hidden.includes(k) ? "表示する" : "非表示にする"}" aria-label="表示を切り替え">${icon(L.hidden.includes(k) ? "eyeoff" : "eye")}</button></div>`);
    }
    w.appendChild(el);
    grid.appendChild(w);
  }
  dash.innerHTML = `<div class="dash-top"><span class="sp"></span>
    ${edit ? `<button class="btn small" type="button" data-de="reset">初期状態に戻す</button><button class="btn small filled" type="button" data-de="done">完了</button>`
      : `<button class="btn small" type="button" data-de="edit">${icon("edit")}ウィジェットを編集</button>`}</div>`;
  dash.appendChild(grid);
  if (edit) wireDashDrag(grid);
  else if (DASH_WIDE.matches) packDash(grid);
}
/* 半分の幅のウィジェットを、低いほうの列へ順に積んでいく(横の行でそろえないので隙間ができない) */
const DASH_WIDE = window.matchMedia("(min-width: 901px)");
DASH_WIDE.addEventListener("change", () => { if (state.view === "dash") renderDash(); });
function packDash(grid) {
  const ws = [...grid.children];
  const hs = new Map(ws.map((w) => [w, w.getBoundingClientRect().height]));
  grid.classList.add("packed");
  grid.textContent = "";
  let cols = null;
  for (const w of ws) {
    if (w.classList.contains("full")) { grid.appendChild(w); cols = null; continue; }
    if (!cols) {
      const box = document.createElement("div"); box.className = "dash-cols";
      cols = [[document.createElement("div"), 0], [document.createElement("div"), 0]];
      for (const [c] of cols) { c.className = "dash-col"; box.appendChild(c); }
      grid.appendChild(box);
    }
    const t = cols[0][1] <= cols[1][1] ? cols[0] : cols[1];
    t[0].appendChild(w); t[1] += hs.get(w) + 14;
  }
}
async function saveDash(L) {
  state.prefs = { ...state.prefs, dash: L };
  try { await savePrefs({ dash: L }); } catch (e) { toast(e.message, true); }
}
function wireDashDrag(grid) {
  let dragEl = null;
  grid.addEventListener("dragstart", (e) => { dragEl = e.target.closest(".widget"); if (dragEl) { dragEl.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; } });
  grid.addEventListener("dragend", () => { if (dragEl) dragEl.classList.remove("dragging"); dragEl = null; });
  grid.addEventListener("dragover", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const over = e.target.closest(".widget");
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    const after = (e.clientY - r.top) / r.height > .5 || (e.clientX - r.left) / r.width > .6;
    over[after ? "after" : "before"](dragEl);
  });
  grid.addEventListener("drop", (e) => {
    e.preventDefault();
    const L = dashLayout();
    L.order = [...grid.querySelectorAll(".widget")].map((w) => w.dataset.w);
    saveDash(L);
  });
}
$("#dash").addEventListener("click", async (e) => {
  const de = e.target.closest("[data-de]");
  if (de) {
    if (de.dataset.de === "edit") state.dashEdit = true;
    if (de.dataset.de === "done") state.dashEdit = false;
    if (de.dataset.de === "reset") await saveDash({ ...DASH_DEFAULT, order: [...DASH_DEFAULT.order] });
    renderDash(); return;
  }
  const wa = e.target.closest("[data-wa]");
  if (wa) {
    const k = wa.closest(".widget").dataset.w;
    const L = dashLayout();
    const i = L.order.indexOf(k);
    if (wa.dataset.wa === "up" && i > 0) [L.order[i - 1], L.order[i]] = [L.order[i], L.order[i - 1]];
    if (wa.dataset.wa === "down" && i < L.order.length - 1) [L.order[i + 1], L.order[i]] = [L.order[i], L.order[i + 1]];
    if (wa.dataset.wa === "size") L.full = L.full.includes(k) ? L.full.filter((x) => x !== k) : [...L.full, k];
    if (wa.dataset.wa === "hide") L.hidden = L.hidden.includes(k) ? L.hidden.filter((x) => x !== k) : [...L.hidden, k];
    await saveDash(L); renderDash(); return;
  }
  const sg = e.target.closest("[data-srvgo]");
  if (sg) { setView("servers"); }
}, true);

/* 配布元から取得したアイコンがあれば画像で、無ければ種類のアイコンで表示する */
function itemIcon(it, sm = false) {
  const v = it.source && it.source.icon_v;
  if (v) return `<span class="cicon img${sm ? " sm" : ""}"><img src="/api/items/${it.id}/icon?v=${v}" alt="" loading="lazy" decoding="async"></span>`;
  return `<span class="cicon${sm ? " sm" : ""} c-${it.category}">${catGlyph(it.category)}</span>`;
}
function gotoLibrary(cat) {
  state.cat = cat; state.mc = state.mc || ""; setView("library"); render();
}
$("#dash").addEventListener("click", async (e) => {
  if (state.dashEdit && !e.target.closest("[data-wa], [data-de]")) { e.preventDefault(); return; }
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
            return `<div class="row" role="button" tabindex="0" data-open="${it.id}">${itemIcon(it, true)}
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
          ${itemIcon(it, true)}
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
async function linkServerDialog() {
  let ps;
  const tp = toastProgress("Pterodactyl からサーバーの一覧を取得しています…");
  try { ps = (await api("/api/ptero/servers")).servers; } catch (e) { toast(e.message, true); return; } finally { tp.remove(); }
  const avail = ps.filter((p) => !p.linked_id);
  if (!ps.length) { toast("Pterodactyl からサーバーが 1 台も返りませんでした。APIキー(ptlc_…)を作ったユーザーに、サーバーの所有者・サブユーザー・管理者のいずれかの権限があるか確認してください", true); return; }
  if (!avail.length) { toast(`すべてのサーバー(${ps.length} 台)を連携済みです`); return; }
  const setOpts = `<option value="">なし</option>${(state.sets || []).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}`;
  const r = await formSheet("サーバーを連携", `
    ${field("サーバー", `<select name="identifier">${avail.map((p) => `<option value="${esc(p.identifier)}">${esc(p.name)}(${esc(p.node)})</option>`).join("")}</select>`)}
    ${field("プラグインのフォルダ", `<input type="text" name="plugin_dir" value="/plugins" placeholder="/plugins(Mod サーバーなら /mods)">`)}
    ${field("セット(任意。同期のときにセットの中身を入れる)", `<select name="set_id">${setOpts}</select>`)}`, "連携する");
  if (!r) return;
  r.name = (avail.find((p) => p.identifier === r.identifier) || {}).name || r.identifier;
  try { await api("/api/servers", { json: r }); toast("連携しました"); loadServers(); } catch (e) { toast(e.message, true); }
}
const DOW = ["月", "火", "水", "木", "金", "土", "日"];
const schedLabel = (s) => s.sched_mode === "daily" ? `毎日 ${s.sched_time}` : s.sched_mode === "weekly" ? `毎週${DOW[s.sched_dow] || ""}曜 ${s.sched_time}` : "なし";
function renderServers() {
  const list = state.servers || [];
  const mode = state.srvMode || "list";
  if (!state.pteroConfigured) {
    $("#serversView").innerHTML = `<div class="card"><div class="empty"><div class="big">🦖</div>
      Pterodactyl と連携すると、保管しているプラグインをサーバーへ転送・同期できます。<br>
      ${isAdmin() ? `<button class="btn filled" type="button" data-va="setup" style="margin-top:12px">${icon("gear")}Pterodactyl を設定</button>` : "管理者に設定を依頼してください"}</div></div>`;
    return;
  }
  $("#serversView").innerHTML = `
    <div class="view-head">
      <div class="segmented glass viewsw">${[["list", "一覧"], ["compare", "比較"]].map(([k, n]) => `<button class="seg" type="button" data-mode="${k}" aria-pressed="${mode === k}">${n}</button>`).join("")}</div>
      <button class="btn filled need-admin" type="button" data-va="add">${icon("plus")}サーバーを連携</button></div>
    <div id="srvBody"></div>`;
  if (mode === "compare") { renderCompare(); return; }
  $("#srvBody").innerHTML = list.length ? `<div class="dash-grid">${list.map((s) => `<div class="card" data-srv="${s.id}">
      <div class="card-h"><h4>${esc(s.name)}</h4><span class="srv-state"><span class="spinner"></span></span></div>
      <div class="card-b">
        <div class="kv"><span>フォルダ</span><span>${esc(s.plugin_dir)}</span></div>
        <div class="kv"><span>セット</span><span>${s.set_name ? esc(s.set_name) : "なし"}</span></div>
        <div class="kv"><span>予約同期</span><span>${esc(schedLabel(s))}</span></div>
        <div class="kv"><span>最後の同期</span><span>${s.last_sync ? esc(fmtDateTime(s.last_sync)) : "-"}</span></div>
        <div class="chips need-editor" style="margin-top:10px">
          <button class="btn small filled" type="button" data-va="sync">${icon("refresh")}同期</button>
          <button class="btn small tinted" type="button" data-va="inv">${icon("search")}中身</button>
          <button class="icon-btn sm" type="button" data-va="more" title="その他" aria-label="その他の操作">${icon("more")}</button>
        </div>
      </div></div>`).join("")}</div>`
    : `<div class="card"><div class="empty"><div class="big">🖥️</div>まだサーバーを連携していません</div></div>`;
}
$("#serversView").addEventListener("click", async (e) => {
  const md = e.target.closest("[data-mode]");
  if (md) { state.srvMode = md.dataset.mode; renderServers(); if (state.srvMode === "list") loadServers(); return; }
  const b = e.target.closest("[data-va]"); if (!b) return;
  const sid = Number(b.closest("[data-srv]")?.dataset.srv);
  const s = (state.servers || []).find((x) => x.id === sid);
  const a = b.dataset.va;
  if (a === "setup") openSettings("ptero");
  if (a === "add") linkServerDialog();
  if (a === "inv") inventoryDialog(s);
  if (a === "more") {
    openMenu(b, [
      { label: "転送する", icon: "server", run: () => pushDialog({ server: s }) },
      { label: "履歴と巻き戻し", icon: "clock", run: () => snapshotsDialog(s) },
      { label: "再起動", icon: "refresh", run: async () => {
        if (await confirmSheet(`「${s.name}」を再起動しますか?`, "プレイ中のプレイヤーは切断されます。", "再起動")) {
          try { await api(`/api/servers/${sid}/power`, { json: { signal: "restart" } }); toast("再起動しました"); } catch (ex) { toast(ex.message, true); }
        }
      } },
      ...(isAdmin() ? ["-", { label: "設定・予約同期", icon: "gear", run: () => serverSettingsDialog(s) }] : []),
    ]);
  }
  if (a === "sync") {
    const r = await formSheet(`「${s.name}」を同期`, `<p>サーバーの ${esc(s.plugin_dir)} を確認し、ライブラリに新しいバージョンがあるものを更新します${s.set_name ? `。連携中のセット「${esc(s.set_name)}」に入っていて、サーバーに無いものも追加します` : ""}。置き換えるファイルは自動で退避するので、あとから「履歴と巻き戻し」で元に戻せます。</p>
      <div class="group">${toggle("restart", "完了後にサーバーを再起動", "プラグインの入れ替えを反映させるには再起動が必要です", false)}</div>`, "同期する");
    if (!r) return;
    try { jobStarted(await api(`/api/servers/${sid}/sync`, { json: { restart: r.restart } })); } catch (ex) { toast(ex.message, true); }
  }
});
async function serverSettingsDialog(s) {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}"${x.id === s.set_id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}`;
  const r = await sheet(`${sheetHead(`「${s.name}」の設定`)}<div class="db">
      ${field("表示名", `<input type="text" name="name" value="${esc(s.name)}">`)}
      ${field("プラグインのフォルダ", `<input type="text" name="plugin_dir" value="${esc(s.plugin_dir)}">`)}
      ${field("セット(同期のときに、セットの中身もサーバーに入れる)", `<select name="set_id">${setOpts}</select>`)}
      <div class="group-title" style="margin:6px 4px 0">予約同期</div>
      ${field("タイミング", `<select name="sched_mode"><option value="off"${s.sched_mode === "off" ? " selected" : ""}>しない</option><option value="daily"${s.sched_mode === "daily" ? " selected" : ""}>毎日</option><option value="weekly"${s.sched_mode === "weekly" ? " selected" : ""}>毎週</option></select>`)}
      <div class="chips" id="schedRow">
        <select name="sched_dow" class="compact">${DOW.map((d, i) => `<option value="${i}"${Number(s.sched_dow) === i ? " selected" : ""}>${d}曜日</option>`).join("")}</select>
        <input type="time" name="sched_time" value="${esc(s.sched_time || "04:00")}" class="compact-time">
      </div>
      <div class="group">${toggle("sched_restart", "同期のあとに再起動", "更新があったときだけ再起動します", !!s.sched_restart)}</div>
      <button class="btn danger block" type="button" data-unlink>連携を解除</button>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    const sync = () => { const m = form.querySelector("[name=sched_mode]").value; $("#schedRow", form).hidden = m === "off"; form.querySelector("[name=sched_dow]").hidden = m !== "weekly"; };
    form.querySelector("[name=sched_mode]").onchange = sync; sync();
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const d = Object.fromEntries(new FormData(form).entries());
      d.sched_restart = form.querySelector("[name=sched_restart]").checked;
      d.sched_dow = Number(d.sched_dow || 0);
      try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: d }); done("saved"); } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-unlink]").onclick = async (ev) => {
      if (!cfm(`「${s.name}」の連携を解除しますか?(サーバーのファイルはそのままです)`)) return;
      await busy(ev.currentTarget, async () => { try { await api(`/api/servers/${s.id}`, { method: "DELETE" }); done("deleted"); } catch (ex) { toast(ex.message, true); } });
    };
  });
  if (r) { toast(r === "deleted" ? "連携を解除しました" : "保存しました"); loadServers(); }
}
async function snapshotsDialog(s) {
  await sheet(`${sheetHead(`「${s.name}」の履歴`)}<div class="db" id="snBody"><div class="empty"><span class="spinner lg"></span></div></div>`, async (form, done) => {
    let d;
    try { d = await api(`/api/servers/${s.id}/snapshots`); } catch (ex) { $("#snBody", form).innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
    $("#snBody", form).innerHTML = `<p>同期・転送のたびに、置き換えたファイルを退避しています(直近 10 回分)。「この前の状態に戻す」で、その同期の前に戻せます。</p>
      ${d.snapshots.length ? d.snapshots.map((x) => `<div class="card" style="margin-bottom:10px"><div class="card-h"><h4 style="font-size:15px">${esc(x.title || "同期")}</h4><span class="muted">${esc(fmtDateTime(x.created_at))}</span></div>
        <div class="card-b">
          ${x.added.length ? `<div class="kv"><span>入れたファイル</span><span>${esc(x.added.join(", "))}</span></div>` : ""}
          ${x.removed.length ? `<div class="kv"><span>退避したファイル</span><span>${esc(x.removed.map((r) => r.name).join(", "))}</span></div>` : ""}
          ${x.rolled_back ? `<div class="result">${esc(fmtDateTime(x.rolled_back))} に巻き戻しました</div>`
            : `<div class="chips need-editor" style="margin-top:8px"><button class="btn small tinted" type="button" data-rb="${x.id}">${icon("arrows")}この前の状態に戻す</button></div>`}
        </div></div>`).join("") : `<div class="empty">まだ履歴がありません</div>`}`;
    form.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-rb]"); if (!b) return;
      const restart = cfm("巻き戻したあとにサーバーを再起動しますか?(キャンセルで再起動しない)");
      try { jobStarted(await api(`/api/servers/${s.id}/snapshots/${b.dataset.rb}/rollback`, { json: { restart } })); done(null); }
      catch (ex) { toast(ex.message, true); }
    });
  }, { wide: true });
}

/* ---------------- サーバーの比較(Apple の製品比較のように横並び) ---------------- */
async function renderCompare() {
  const list = state.servers || [];
  const body = $("#srvBody");
  if (list.length < 2) { body.innerHTML = `<div class="card"><div class="empty"><div class="big">⚖️</div>比較するには 2 台以上のサーバーを連携してください</div></div>`; return; }
  state.cmpSel = state.cmpSel || list.slice(0, 4).map((s) => s.id);
  body.innerHTML = `<div class="cmp-pick">${list.map((s) => `<button class="seg" type="button" data-cmp="${s.id}" aria-pressed="${state.cmpSel.includes(s.id)}">${esc(s.name)}</button>`).join("")}
      <label class="cmp-diff"><input type="checkbox" class="switch" id="cmpDiff"${state.cmpDiff ? " checked" : ""}> 違いだけ表示</label></div>
    <div id="cmpTable"><div class="empty"><span class="spinner lg"></span><p>各サーバーの中身を確認しています…</p></div></div>`;
  body.querySelectorAll("[data-cmp]").forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.cmp);
    state.cmpSel = state.cmpSel.includes(id) ? state.cmpSel.filter((x) => x !== id) : [...state.cmpSel, id];
    renderCompare();
  });
  $("#cmpDiff").onchange = (e) => { state.cmpDiff = e.target.checked; drawCompare(); };
  const sel = list.filter((s) => state.cmpSel.includes(s.id));
  state.cmpData = {};
  await Promise.all(sel.map(async (s) => {
    try { state.cmpData[s.id] = await api(`/api/servers/${s.id}/inventory`); }
    catch (ex) { state.cmpData[s.id] = { error: ex.message, files: [], missing: [] }; }
  }));
  drawCompare();
}
function drawCompare() {
  const sel = (state.servers || []).filter((s) => (state.cmpSel || []).includes(s.id));
  const box = $("#cmpTable"); if (!box) return;
  if (!sel.length) { box.innerHTML = `<div class="empty">比較するサーバーを選んでください</div>`; return; }
  const rows = new Map();
  for (const s of sel) {
    for (const f of (state.cmpData[s.id] || {}).files || []) {
      const key = f.item_id ? `i${f.item_id}` : `n${(f.plugin_name || f.name).toLowerCase().replace(/[\W_]+/g, "")}`;
      if (!rows.has(key)) rows.set(key, { name: f.item_name || f.plugin_name || f.name, item_id: f.item_id, latest: f.latest_version, cells: {} });
      rows.get(key).cells[s.id] = f;
    }
  }
  let list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const differs = (r) => { const vals = sel.map((s) => (r.cells[s.id] ? r.cells[s.id].version || "?" : "-")); return new Set(vals).size > 1; };
  if (state.cmpDiff) list = list.filter(differs);
  const cell = (f, r) => {
    if (!f) return `<td class="cmp-cell none"><span class="cmp-dash">—</span></td>`;
    const cls = f.status === "latest" ? "ok" : f.status === "outdated" ? "upd" : f.status === "unregistered" ? "unk" : "";
    return `<td class="cmp-cell"><span class="cmp-mark ${cls}">${icon(f.status === "outdated" ? "refresh" : "check")}</span><div class="cmp-ver">${esc(f.version || "?")}</div>
      <div class="cmp-sub">${f.status === "outdated" ? `→ ${esc(r.latest || "")}` : f.status === "unregistered" ? "未登録" : f.status === "different" ? "別のファイル" : "最新"}</div></td>`;
  };
  box.innerHTML = `<div class="cmp-wrap"><table class="cmp">
    <thead><tr><th class="cmp-name"></th>${sel.map((s) => {
      const d = state.cmpData[s.id] || {};
      return `<th><div class="cmp-head"><span class="cicon c-teal">${icon("server")}</span><div class="cmp-title">${esc(s.name)}</div>
        <div class="cmp-sub">${d.error ? esc(d.error) : `${(d.files || []).length} 個 · ${esc(s.plugin_dir)}`}</div>
        ${d.files && d.files.some((f) => f.status === "outdated") ? `<span class="badge upd">更新あり ${d.files.filter((f) => f.status === "outdated").length}</span>` : d.error ? "" : '<span class="badge ok">最新</span>'}</div></th>`;
    }).join("")}</tr></thead>
    <tbody>${list.map((r) => `<tr class="${differs(r) ? "diff" : ""}"><th class="cmp-name">${r.item_id ? `<button class="linkish" type="button" data-open="${r.item_id}">${esc(r.name)}</button>` : esc(r.name)}</th>${sel.map((s) => cell(r.cells[s.id], r)).join("")}</tr>`).join("")
      || `<tr><td colspan="${sel.length + 1}"><div class="empty">${state.cmpDiff ? "違いはありません 🎉" : "プラグインがありません"}</div></td></tr>`}</tbody>
  </table></div>`;
  box.onclick = (e) => { const o = e.target.closest("[data-open]"); if (o) openPanel(Number(o.dataset.open)); };
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
async function pushDialog({ server = null, set = null, item = null, itemIds = null } = {}) {
  if (!state.servers) { try { const d = await api("/api/servers"); state.servers = d.servers; state.pteroConfigured = d.configured; } catch { state.servers = []; } }
  if (!state.servers.length) { toast("先に「サーバー」タブでサーバーを連携してください", true); return; }
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const r = await sheet(`${sheetHead("サーバーへ転送")}<div class="db">
      ${field("転送先のサーバー", `<select name="srv">${state.servers.map((x) => `<option value="${x.id}"${server && x.id === server.id ? " selected" : ""}>${esc(x.name)}(${esc(x.plugin_dir)})</option>`).join("")}</select>`)}
      ${field("送るもの", `<select name="mode"><option value="set"${set ? " selected" : ""}>セット</option><option value="items"${!set ? " selected" : ""}>アイテムを選ぶ</option></select>`)}
      <div id="pSet">${field("セット", `<select name="set_id">${state.sets.map((x) => `<option value="${x.id}"${set && x.id === set.id ? " selected" : ""}>${esc(x.name)}(${x.items.length} 件)</option>`).join("") || "<option value=''>セットがありません</option>"}</select>`)}</div>
      <div id="pItems"><div class="group scroll">${items.map((it) => `<label class="toggle-row">${itemIcon(it, true)}
        <span class="main">${esc(it.name)}<small>${esc(verLabel(it.versions[0].version))}(最新)</small></span>
        <input type="checkbox" class="switch" data-pi="${it.id}"${(item && item.id === it.id) || (itemIds && itemIds.includes(it.id)) ? " checked" : ""}></label>`).join("")}</div></div>
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

/* ---------------- 対応MCバージョンの範囲(前提プラグインとの対応確認) ---------------- */
function mcRange(text) {
  if (!text) return null;
  const t = String(text).replace(/\s/g, "");
  let m;
  if ((m = t.match(/^([\d.]+)以降$/)) || (m = t.match(/^>=?([\d.]+)$/)) || (m = t.match(/^\[([\d.]+),\)$/))) return [verNums(m[1]), null];
  if ((m = t.match(/^([\d.]+)[〜~\-–]([\d.]+)$/)) || (m = t.match(/^\[([\d.]+),([\d.]+)[)\]]$/))) return [verNums(m[1]), verNums(m[2])];
  const parts = t.split(/[,、]/).map(verNums).filter((x) => x.length >= 2).sort(cmpVer);
  return parts.length ? [parts[0], parts[parts.length - 1]] : null;
}
/* true = 重なる / false = 重ならない / null = 判定できない */
function mcCompatible(a, b) {
  const ra = mcRange(a), rb = mcRange(b);
  if (!ra || !rb) return null;
  const minor = (v) => v.slice(0, 2);
  const loA = minor(ra[0]), hiA = ra[1] ? minor(ra[1]) : [99, 99], loB = minor(rb[0]), hiB = rb[1] ? minor(rb[1]) : [99, 99];
  return cmpVer(loA, hiB) <= 0 && cmpVer(loB, hiA) <= 0;
}

/* ---------------- 詳細パネル ---------------- */
function sectOpen(key, def) { try { const v = localStorage.getItem(`craftshelf.sect.${key}`); return v === null ? def : v === "1"; } catch { return def; } }
function renderPanel() {
  const it = state.items.find((i) => i.id === state.selected);
  if (!it) return;
  const vs = state.verOrder === "desc" ? it.versions : [...it.versions].reverse();
  const latest = it.versions.find((v) => v.id === it.latest_id) || it.versions[0];
  const page = it.source && safeUrl(it.source.page_url) !== "#" ? safeUrl(it.source.page_url) : "";
  const tags = (v) => [v.meta.loader, v.meta.mc && "MC " + v.meta.mc, v.meta.pack_format && "pack_format " + v.meta.pack_format]
    .filter(Boolean).map((t) => `<span class="badge">${esc(t)}</span>`).join("");
  const nDeps = (it.dep_status || []).length, nMissing = (it.missing_deps || []).length;
  $("#panel").innerHTML = `
    <div class="side-head">
      <div class="nav"><span class="badge cat c-${it.category}">${CATS[it.category]}</span>
        <div class="navbtns">
          ${page ? `<a class="icon-btn sm" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="配布ページを開く" aria-label="配布ページを開く">${icon("external")}</a>` : ""}
          <button class="icon-btn sm need-editor" type="button" data-act="edit-item" title="情報を編集" aria-label="情報を編集">${icon("edit")}</button>
          <button class="icon-btn sm" type="button" data-act="more" title="その他" aria-label="その他の操作">${icon("more")}</button>
          <button class="close-x" type="button" data-act="close" aria-label="閉じる">${icon("x")}</button>
        </div></div>
      <h3 translate="no">${esc(it.name)}</h3>
      <p class="desc">${esc(verLabel(latest.version))} · ${it.versions.length} バージョン · ${fmtSize(it.total_size)}${mcOf(it) ? ` · MC ${esc(mcOf(it))}` : ""}</p>
      ${latest.meta.description ? `<p class="desc">${esc(latest.meta.description)}</p>` : ""}
      ${(it.tags || []).length ? `<div class="chips">${it.tags.map((t) => `<button class="tagchip" type="button" data-act="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
    </div>
    <div class="side-body">
      <div class="group-title">配布元</div>
      <div class="group">${sourceBoxHTML(it)}</div>
      ${serversSectionHTML(it)}
      ${nDeps ? `<details class="sect" data-sect="deps"${sectOpen("deps", nMissing > 0) || nMissing ? " open" : ""}>
        <summary><span>前提プラグイン・Mod</span><span class="sum-r">${nMissing ? `<span class="badge err">${nMissing} 件が不足</span>` : '<span class="badge ok">そろっています</span>'}${icon("chev", "i chev")}</span></summary>
        <div class="group">${depsHTML(it)}</div></details>` : ""}
      <details class="sect" data-sect="vers"${sectOpen("vers", true) ? " open" : ""}>
        <summary><span>保存しているバージョン(${it.versions.length})</span><span class="sum-r">
          <button class="btn plain small" type="button" data-act="order" title="並び順を切り替え">${icon("arrows")}${state.verOrder === "desc" ? "新しい順" : "古い順"}</button>${icon("chev", "i chev")}</span></summary>
        <div class="group">
        ${vs.map((v) => `
          <div class="ver${v.missing ? " missing" : ""}" data-vid="${v.id}">
            <div class="vrow">
              <div class="vmain">
                <div class="vh"><span class="vnum">${esc(verLabel(v.version))}</span>
                  ${v.id === it.latest_id ? '<span class="badge ok">最新</span>' : ""}
                  ${v.missing ? '<span class="badge err">ファイルが見つかりません</span>' : ""}${tags(v)}</div>
                <div class="file">${esc(v.filename)} · ${fmtSize(v.size)} · ${fmtDateTime(v.added_at)}</div>
              </div>
              <div class="vacts">
                ${v.missing ? "" : `<a class="icon-btn sm" href="/api/versions/${v.id}/download" title="ダウンロード" aria-label="ダウンロード">${icon("download")}</a>`}
                <button class="icon-btn sm need-editor" type="button" data-act="edit-ver" title="バージョン・ローダー・MC・メモを編集" aria-label="編集">${icon("edit")}</button>
                <button class="icon-btn sm danger need-editor" type="button" data-act="del-ver" title="削除" aria-label="削除">${icon("trash")}</button>
              </div>
            </div>
            ${v.note ? `<div class="note" translate="no">${esc(v.note)}</div>` : ""}
          </div>`).join("")}
        </div></details>
    </div>`;
  $("#panel").querySelectorAll("details.sect").forEach((d) => d.addEventListener("toggle", () => {
    try { localStorage.setItem(`craftshelf.sect.${d.dataset.sect}`, d.open ? "1" : "0"); } catch { /* */ }
  }));
}
$("#panel").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act], [data-open]"); if (!b) return;
  const it = state.items.find((i) => i.id === state.selected); if (!it) return;
  if (b.dataset.open) { e.preventDefault(); openPanel(Number(b.dataset.open)); return; }
  const act = b.dataset.act;
  if (act === "order") { e.preventDefault(); state.verOrder = state.verOrder === "desc" ? "asc" : "desc"; renderPanel(); return; }
  const vid = Number(b.closest("[data-vid]")?.dataset.vid);
  const v = it.versions.find((x) => x.id === vid);
  if (act.startsWith("src-")) { await sourceAction(it, act, b); return; }
  if (act.startsWith("dep-")) { await depAction(it, act, b); return; }
  if (act === "srv-sync") {
    const r = await formSheet("サーバーを同期", `<p>このサーバーの古いプラグインをライブラリの最新に入れ替えます。置き換えるファイルは自動で退避されます。</p>
      <div class="group">${toggle("restart", "完了後にサーバーを再起動", "", false)}</div>`, "同期する");
    if (!r) return;
    try { jobStarted(await api(`/api/servers/${b.dataset.srv}/sync`, { json: { restart: r.restart } })); } catch (ex) { toast(ex.message, true); }
    return;
  }
  if (act === "close") closePanel();
  else if (act === "tag") { state.tag = b.dataset.tag; closePanel(); setView("library"); render(); }
  else if (act === "more") {
    openMenu(b, [
      ...(isEditor() ? [{ label: "情報・タグを編集", icon: "edit", run: () => editItem(it) },
        { label: "サーバーへ転送", icon: "server", run: () => pushDialog({ item: it }) },
        { label: "セットに追加", icon: "stack", run: () => addToSet(it) }] : []),
      { label: state.verOrder === "desc" ? "古い順に並べる" : "新しい順に並べる", icon: "arrows", run: () => { state.verOrder = state.verOrder === "desc" ? "asc" : "desc"; renderPanel(); } },
      ...(isEditor() ? ["-", { label: "すべて削除", icon: "trash", danger: true, run: async () => {
        if (await confirmSheet(`「${it.name}」をすべて削除しますか?`, `保存している ${it.versions.length} 個のファイルがすべて削除され、元に戻せません。`, "すべて削除")) {
          await run(() => api(`/api/items/${it.id}`, { method: "DELETE" }), "削除しました");
        }
      } }] : []),
    ]);
  } else if (act === "edit-item") editItem(it);
  else if (act === "edit-ver") editVersion(v);
  else if (act === "del-ver") {
    if (await confirmSheet(`${verLabel(v.version)} を削除しますか?`, `${v.filename}\n保存先のファイルも削除され、元に戻せません。`, "削除")) {
      await run(() => api(`/api/versions/${v.id}`, { method: "DELETE" }), "削除しました");
    }
  }
});
async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); return true; }
  catch (e) { toast(e.message, true); return false; }
}
const allTags = () => [...new Set(state.items.flatMap((i) => i.tags || []))].sort((a, b) => a.localeCompare(b, "ja"));
async function editItem(it) {
  const r = await formSheet("情報を編集", `
    ${field("名前", `<input type="text" name="name" value="${esc(it.name)}" required>`)}
    ${field("種類", `<select name="category">${Object.entries(CATS).map(([k, n]) => `<option value="${k}"${k === it.category ? " selected" : ""}>${n}</option>`).join("")}</select>`)}
    <p style="font-size:12.5px">同じ名前・種類のものが既にある場合は、そちらに統合されます。</p>
    ${field("タグ(カンマ区切り。例: 必須, テスト中, サバイバル用)", `<input type="text" name="tags" value="${esc((it.tags || []).join(", "))}" list="tagList" autocomplete="off"><datalist id="tagList">${allTags().map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`)}
    ${allTags().length ? `<div class="chips">${allTags().map((t) => `<button class="tagchip" type="button" data-addtag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
    ${field("対応MCバージョン(例: 1.20.1〜1.21.4 / 1.20 以降)", `<input type="text" name="mc_versions" value="${esc(it.mc_versions || "")}" placeholder="${esc(it.mc_auto || "空欄なら自動で判定します")}">`)}
    <p style="font-size:12.5px">空欄のままにすると、ファイルの中身や配布元から自動で判定した${it.mc_auto ? `「${esc(it.mc_auto)}」` : "バージョン"}を表示します。</p>
    ${field("サーバーソフト・ローダー", `<select name="platform"><option value="">自動で判定(${esc(platformOf({ ...it, platform: "" }) || "不明")})</option>${PLATFORMS.map((p) => `<option value="${esc(p)}"${p === it.platform ? " selected" : ""} translate="no">${esc(p)}</option>`).join("")}</select>`)}
    <div class="group-title" style="margin-top:14px">配布元</div>
    ${field("配布ページのURL(Modrinth / SpigotMC / CurseForge)", `<input type="url" name="source_url" value="${esc((it.source && it.source.page_url) || "")}" placeholder="https://modrinth.com/plugin/…">`)}
    <p style="font-size:12.5px">URL を変えると紐付け直し、空にすると紐付けを解除します。</p>
    ${it.source ? `${field("更新を探すローダー(カンマ区切り。例: paper, spigot / fabric)", `<input type="text" name="src_loaders" value="${esc((it.source.loaders || []).join(", "))}" placeholder="空欄ならすべて">`)}
      ${field("更新を探すMCバージョン(カンマ区切り。例: 1.21.1, 1.21.4)", `<input type="text" name="src_mc" value="${esc((it.source.game_versions || []).join(", "))}" placeholder="空欄ならすべて">`)}` : ""}
    ${field("古いバージョンの自動整理", `<select name="keep_versions">${[[0, "しない(すべて残す)"], [1, "最新だけ残す"], [3, "新しい方から 3 つ残す"], [5, "新しい方から 5 つ残す"], [10, "新しい方から 10 個残す"]].map(([n, l]) => `<option value="${n}"${Number(it.keep_versions || 0) === n ? " selected" : ""}>${l}</option>`).join("")}</select>`)}
    <p style="font-size:12.5px">新しいバージョンを追加したときに、残す数を超えた古いものを自動で削除します(セットで固定しているバージョンは残します)。</p>`, "保存");
  if (!r) return;
  await run(async () => {
    r.keep_versions = Number(r.keep_versions || 0);
    r.tags = String(r.tags || "").split(/[,、]/).map((t) => t.trim()).filter(Boolean);
    if (r.keep_versions && r.keep_versions < it.versions.length && !(await confirmSheet("古いバージョンを削除しますか?", `「${it.name}」は ${it.versions.length} 個のバージョンを保存しています。新しい方から ${r.keep_versions} 個を残し、それより古いものを削除します(元に戻せません)。`, "削除して保存"))) return;
    const { source_url: srcUrl = "", src_loaders: srcLoaders, src_mc: srcMc } = r;
    delete r.source_url; delete r.src_loaders; delete r.src_mc;
    const res = await api(`/api/items/${it.id}`, { method: "PATCH", json: r });
    if (res.removed && res.removed.length) toast(`古いバージョンを ${res.removed.length} 個削除しました`);
    // 配布元: URL が変わったら紐付け直し、空なら解除。条件だけ変わったら条件を保存
    const oldUrl = (it.source && it.source.page_url) || "";
    const url = String(srcUrl).trim();
    if (url !== oldUrl.trim()) {
      if (url) await api(`/api/items/${it.id}/source`, { json: { url } });
      else if (it.source) await api(`/api/items/${it.id}/source`, { method: "DELETE" });
    } else if (it.source && srcLoaders !== undefined
      && (srcLoaders !== (it.source.loaders || []).join(", ") || srcMc !== (it.source.game_versions || []).join(", "))) {
      await api(`/api/items/${it.id}/source`, { method: "PATCH", json: { loaders: srcLoaders, game_versions: srcMc } });
    }
    await refresh();
    const norm = (s) => s.toLowerCase().replace(/[\W_]+/g, "");
    const t = state.items.find((i) => i.category === r.category && norm(i.name) === norm(r.name));
    if (t) openPanel(t.id);
  }, "保存しました");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-addtag]"); if (!b) return;
  const inp = b.closest("form")?.querySelector("[name=tags]"); if (!inp) return;
  const cur = inp.value.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
  if (!cur.includes(b.dataset.addtag)) cur.push(b.dataset.addtag);
  inp.value = cur.join(", ");
});
async function editVersion(v) {
  const m = v.meta || {};
  const autoLoader = "auto_loader" in m ? m.auto_loader : m.loader, autoMc = "auto_mc" in m ? m.auto_mc : m.mc;
  const r = await formSheet("バージョン情報", `<p>${esc(v.filename)}</p>
    ${field("バージョン", `<input type="text" name="version" value="${esc(v.version)}">`)}
    ${field("ローダー・サーバーソフト(例: Paper / Fabric / NeoForge)", `<input type="text" name="loader" value="${esc(m.user_loader ? m.loader : "")}" placeholder="${esc(autoLoader || "空欄なら自動")}" list="loaderList"><datalist id="loaderList">${PLATFORMS.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>`)}
    ${field("対応MCバージョン(例: 1.21.1 / 1.20.1〜1.21.4)", `<input type="text" name="mc" value="${esc(m.user_mc ? m.mc : "")}" placeholder="${esc(autoMc || "空欄なら自動")}">`)}
    <p style="font-size:12.5px">空欄にすると、ファイルから読み取った値に戻ります。</p>
    ${field("メモ(使っているサーバー、注意点など)", `<textarea name="note" rows="3">${esc(v.note)}</textarea>`)}`);
  if (!r) return;
  await run(() => api(`/api/versions/${v.id}`, { method: "PATCH", json: r }), "保存しました");
}
async function addToSet(it) {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  if (!state.sets.length) { toast("先に「セット」タブでセットを作成してください", true); return; }
  const r = await formSheet("セットに追加", field("セット", `<select name="sid">${state.sets.map((s) => `<option value="${s.id}">${esc(s.name)}(${s.items.length} 件)</option>`).join("")}</select>`), "追加");
  if (!r) return;
  const s = state.sets.find((x) => x.id === Number(r.sid));
  const items = s.items.filter((x) => x.item_id !== it.id).concat([{ item_id: it.id, version_id: null }]);
  try { await api(`/api/sets/${s.id}`, { method: "PATCH", json: { items } }); toast(`「${s.name}」に追加しました`); state.sets = null; }
  catch (e) { toast(e.message, true); }
}

/* ---------------- 前提(依存)プラグイン ---------------- */
function depsHTML(it) {
  return (it.dep_status || []).map((d) => {
    const dep = d.item_id ? state.items.find((i) => i.id === d.item_id) : null;
    if (dep) {
      const dv = dep.versions.find((v) => v.id === dep.latest_id) || dep.versions[0];
      const comp = mcCompatible(mcOf(it), mcOf(dep));
      return `<div class="row" role="button" tabindex="0" data-open="${dep.id}">
        ${itemIcon(dep, true)}
        <span class="main"><span class="title">${esc(d.name)}${dep.name.toLowerCase() !== d.name.toLowerCase() ? ` <span class="muted">→ ${esc(dep.name)}</span>` : ""}</span>
          <span class="subtitle">${d.required ? "必須" : "任意"} · ${esc(verLabel(dv.version))}${mcOf(dep) ? ` · MC ${esc(mcOf(dep))}` : ""}${d.manual ? " · 手動で紐付け" : ""}</span></span>
        <span class="trail">${dep.source && dep.source.status === "update" ? '<span class="badge upd">更新あり</span>' : ""}
          ${comp === true ? '<span class="badge ok" title="対応MCバージョンが重なっています">MC対応</span>' : comp === false ? '<span class="badge err" title="対応MCバージョンが重なっていません">MC要確認</span>' : ""}
          ${d.manual ? `<button class="icon-btn sm need-editor" type="button" data-act="dep-unlink" data-dep="${esc(d.name)}" title="紐付けを解除" aria-label="紐付けを解除">${icon("x")}</button>` : ""}
          ${icon("chev", "i chev")}</span></div>`;
    }
    return `<div class="row">
      <span class="cicon sm c-other">?</span>
      <span class="main"><span class="title">${esc(d.name)}</span><span class="subtitle">${d.required ? "必須 · ライブラリにありません" : "任意 · ライブラリにありません(あると連携機能が使えます)"}</span></span>
      <span class="trail">${d.required ? '<span class="badge err">不足</span>' : ""}
        <button class="icon-btn sm need-editor" type="button" data-act="dep-search" data-dep="${esc(d.name)}" title="配布サイトで探す" aria-label="配布サイトで探す">${icon("search")}</button>
        <button class="icon-btn sm need-editor" type="button" data-act="dep-link" data-dep="${esc(d.name)}" title="ライブラリのアイテムと紐付け" aria-label="ライブラリのアイテムと紐付け">${icon("link")}</button></span></div>`;
  }).join("");
}
async function depAction(it, act, btn) {
  const name = btn.dataset.dep;
  try {
    if (act === "dep-search") { openSearch({ q: name, kind: it.category === "mod" ? "mod" : "plugin" }); return; }
    if (act === "dep-unlink") { await api("/api/deps/link", { json: { name, item_id: null } }); toast("紐付けを解除しました"); }
    if (act === "dep-link") {
      const items = [...state.items].filter((i) => i.id !== it.id).sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
      const r = await formSheet(`「${name}」を紐付け`, `<p>名前が違っていても同じものの場合(例: 前提が「Vault」、ライブラリでは「VaultAPI」)に、ライブラリのアイテムと結び付けます。</p>
        ${field("ライブラリのアイテム", `<select name="item_id">${items.map((i) => `<option value="${i.id}">${esc(i.name)}(${CATS[i.category]})</option>`).join("")}</select>`)}`, "紐付け");
      if (!r) return;
      await api("/api/deps/link", { json: { name, item_id: Number(r.item_id) } }); toast("紐付けました");
    }
    await refresh();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 配布元(更新) ---------------- */
function sourceBoxHTML(it) {
  const s = it.source;
  const cands = state.candidates[it.id];
  if (!s) {
    return `<div class="srcbox">
      <div class="sh"><span class="cicon sm c-teal">${icon("link")}</span><div class="main"><div class="title" style="font-weight:600">未連携</div>
        <div class="muted" style="margin:0">Modrinth / SpigotMC / CurseForge と紐付けると、最新バージョンの確認とダウンロードができます</div></div></div>
      <div class="acts need-editor">
        <button class="btn small filled" type="button" data-act="src-detect">${icon("wand")}自動で探す</button>
        <button class="btn small" type="button" data-act="src-search">${icon("search")}検索</button>
        <button class="btn small" type="button" data-act="src-link">${icon("link")}URL</button>
      </div>
      ${cands ? (cands.length ? `<div class="muted">候補から選んでください</div>${cands.map((c, i) => `
        <div class="cand"><div class="main">${esc(c.title)}${c.exact ? ' <span class="badge ok">名前が一致</span>' : ""}<small>${esc(PROVIDERS[c.provider])} · ${(c.downloads || 0).toLocaleString()} DL${c.summary ? " · " + esc(c.summary.slice(0, 70)) : ""}</small></div>
          <a class="icon-btn sm" href="${esc(safeUrl(c.page_url))}" target="_blank" rel="noopener noreferrer" title="配布ページを開く" aria-label="配布ページを開く">${icon("external")}</a>
          <button class="btn small tinted need-editor" type="button" data-act="src-pick" data-i="${i}">選択</button></div>`).join("")}`
        : `<div class="muted">見つかりませんでした。「検索」か「URL」で紐付けてください。</div>`) : ""}
    </div>`;
  }
  const L = s.latest || {};
  const st = s.status === "update" ? '<span class="badge upd">更新あり</span>' : s.status === "up_to_date" ? '<span class="badge ok">最新</span>'
    : `<span class="badge${s.status === "error" ? " err" : ""}">${esc(SRC_STATUS[s.status] || s.status)}</span>`;
  return `<div class="srcbox">
    <div class="sh">${s.icon_v ? `<span class="srcicon"><img src="/api/items/${it.id}/icon?v=${s.icon_v}" alt="" decoding="async">${providerBadge(s.provider)}</span>`
      : providerBadge(s.provider).replace('class="pbadge"', 'class="pbadge lg"')}
      <div class="main"><a href="${esc(safeUrl(s.page_url))}" target="_blank" rel="noopener noreferrer" style="font-weight:600">${esc(s.title)} ${icon("external", "i ext")}</a>
        <div class="muted" style="margin:0">${esc(s.provider_label)}${s.linked_by === "name" ? " · 名前から推定" : ""}${s.checked_at ? ` · ${fmtDateTime(s.checked_at)} に確認` : ""}</div></div>${st}</div>
    ${L.version ? `<div class="latest"><div>配布元の最新: <b>${esc(L.version)}</b>${L.date ? ` <span class="muted">(${fmtDate(L.date)})</span>` : ""}</div>
      ${L.file_name ? `<div class="muted brk">${esc(L.file_name)}</div>` : ""}</div>` : ""}
    ${s.message ? `<div class="muted brk">${esc(s.message)}</div>` : ""}
    <div class="acts need-editor">
      ${s.status === "update" && L.downloadable ? `<button class="btn small filled" type="button" data-act="src-download">${icon("download")}${esc(L.version || "最新バージョン")} を保存</button>` : ""}
      <button class="btn small" type="button" data-act="src-check">${icon("refresh")}確認</button>
      <button class="btn small" type="button" data-act="src-changelog">${icon("doc")}変更履歴</button>
      <button class="icon-btn sm" type="button" data-act="src-more" title="その他" aria-label="配布元のその他の操作">${icon("more")}</button>
    </div>
  </div>`;
}
async function sourceAction(it, act, btn) {
  try {
    if (act === "src-more") {
      const s = it.source;
      openMenu(btn, [
        { label: `絞り込み(ローダー: ${s.loaders.join(", ") || "なし"} / MC: ${s.game_versions.join(", ") || "なし"})`, icon: "search", run: () => sourceAction(it, "src-filter", btn) },
        { label: "配布サイトから探し直す", icon: "search", run: () => sourceAction(it, "src-search", btn) },
        { label: "URLで紐付け直す", icon: "link", run: () => sourceAction(it, "src-link", btn) },
        "-",
        { label: "紐付けを解除", icon: "x", danger: true, run: () => sourceAction(it, "src-unlink", btn) },
      ]);
      return;
    }
    if (act === "src-search") { openSearch({ q: it.name, kind: it.category, linkTo: it }); return; }
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
      toast(r.status === "added" ? `保存しました: ${r.version || ""}` : (r.message || "すでに保存しています"));
    } else if (act === "src-filter") {
      const s = it.source;
      const r = await formSheet("絞り込み条件", `<p>最新バージョンを探すときの条件です。Mod は Minecraft のバージョンを指定しないと、別のバージョン向けのものが「最新」になることがあります。カンマ区切りで複数指定できます。</p>
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

/* ---------------- 配布サイトから探す ---------------- */
const SEARCH_LOADERS = { "": "すべてのサーバーソフト・ローダー", paper: "Paper", purpur: "Purpur", folia: "Folia", spigot: "Spigot", bukkit: "Bukkit",
  velocity: "Velocity", bungeecord: "BungeeCord", waterfall: "Waterfall", sponge: "Sponge",
  fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge", iris: "Iris(シェーダー)", optifine: "OptiFine(シェーダー)" };
async function openSearch({ q = "", kind = "", linkTo = null } = {}) {
  const st = { provider: "modrinth", q, kind: kind === "other" || kind === "all" || (kind || "").startsWith("__") ? "" : kind, loader: "", mc: state.mc && MC_VERSIONS.includes(state.mc) ? state.mc : "" };
  await sheet(`${sheetHead(linkTo ? `「${linkTo.name}」の配布元を探す` : "配布サイトから探す")}
    <div class="db">
      <div class="segmented" id="srProv">${Object.entries(PROVIDERS).map(([k, n]) => `<button class="seg" type="button" data-prov="${k}" aria-pressed="${k === st.provider}">${n}</button>`).join("")}</div>
      <label class="search"><span>${icon("search")}</span><input type="search" id="srQ" value="${esc(q)}" placeholder="名前で検索"></label>
      <div class="chips">
        <select id="srKind" class="compact"><option value="">すべての種類</option>${Object.entries(CATS).filter(([k]) => k !== "other").map(([k, n]) => `<option value="${k}"${k === st.kind ? " selected" : ""}>${n}</option>`).join("")}</select>
        <select id="srLoader" class="compact">${Object.entries(SEARCH_LOADERS).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select>
        <select id="srMc" class="compact"><option value="">すべてのMC</option>${MC_VERSIONS.map((v) => `<option value="${v}"${v === st.mc ? " selected" : ""}>MC ${v}</option>`).join("")}</select>
      </div>
      <div id="srRes" class="group"></div>
    </div>`, (form, done) => {
    let timer = null, seq = 0;
    const go = async () => {
      const my = ++seq;
      const box = $("#srRes", form);
      box.innerHTML = `<div class="empty"><span class="spinner lg"></span></div>`;
      try {
        const p = new URLSearchParams({ provider: st.provider, q: st.q, kind: st.kind, loader: st.loader, mc: st.mc });
        const { results } = await api(`/api/search?${p}`);
        if (my !== seq) return;
        box.innerHTML = results.length ? results.map((r, i) => `<div class="row result-row">
          ${r.icon && safeUrl(r.icon) !== "#" || String(r.icon).startsWith("data:image/png;base64,") ? `<img class="ricon" src="${esc(r.icon)}" alt="" loading="lazy">` : `<span class="cicon c-teal">${icon("box")}</span>`}
          <span class="main"><span class="title">${providerBadge(r.provider)} ${esc(r.title)}${r.item_id ? ' <span class="badge ok">ライブラリにあります</span>' : ""}</span>
            <span class="subtitle">${r.author ? `${esc(r.author)} · ` : ""}${(r.downloads || 0).toLocaleString()} DL${r.kind ? ` · ${esc(CATS[r.kind] || r.kind)}` : ""}</span>
            <span class="subtitle brk">${esc((r.summary || "").slice(0, 140))}</span></span>
          <span class="trail">
            <a class="icon-btn sm" href="${esc(safeUrl(r.page_url))}" target="_blank" rel="noopener noreferrer" title="配布ページを開く" aria-label="配布ページを開く">${icon("external")}</a>
            ${linkTo ? `<button class="btn small filled" type="button" data-pick="${i}">紐付け</button>`
              : r.item_id ? `<button class="btn small" type="button" data-show="${r.item_id}">表示</button>`
              : `<button class="btn small filled need-editor" type="button" data-add="${i}">追加</button>`}
          </span></div>`).join("") : `<div class="empty">見つかりませんでした</div>`;
        box._results = results;
      } catch (ex) { if (my === seq) box.innerHTML = `<div class="result err">${esc(ex.message)}</div>`; }
    };
    form.addEventListener("click", async (e) => {
      const pv = e.target.closest("[data-prov]");
      if (pv) { st.provider = pv.dataset.prov; form.querySelectorAll("[data-prov]").forEach((b) => b.setAttribute("aria-pressed", String(b === pv))); go(); return; }
      const res = $("#srRes", form)._results || [];
      const add = e.target.closest("[data-add]");
      if (add) {
        const r = res[Number(add.dataset.add)];
        done(null);
        await pickVersion(r, st);
        setTimeout(() => openSearch({ q: st.q, kind: st.kind }), 0);  // 検索に戻る
        return;
      }
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const r = res[Number(pick.dataset.pick)];
        await busy(pick, async () => {
          try { await api(`/api/items/${linkTo.id}/source`, { json: { provider: r.provider, project_id: r.project_id } }); toast("紐付けました"); done(true); refresh(); }
          catch (ex) { toast(ex.message, true); }
        }, "");
      }
      const show = e.target.closest("[data-show]");
      if (show) { done(null); await refresh(); openPanel(Number(show.dataset.show)); }
    });
    $("#srQ", form).addEventListener("input", (e) => { st.q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(go, 400); });
    $("#srKind", form).onchange = (e) => { st.kind = e.target.value; go(); };
    $("#srLoader", form).onchange = (e) => { st.loader = e.target.value; go(); };
    $("#srMc", form).onchange = (e) => { st.mc = e.target.value; go(); };
    go();
  }, { wide: true });
}

/* ---------------- 版を選んでダウンロード(前提もまとめて) ---------------- */
async function pickVersion(r, st) {
  const done = await sheet(`${sheetHead(`「${r.title}」を追加`)}
    <div class="db">
      <div class="chips">
        <select id="pvLoader" class="compact">${Object.entries(SEARCH_LOADERS).map(([k, n]) => `<option value="${k}"${k === st.loader ? " selected" : ""}>${n}</option>`).join("")}</select>
        <select id="pvMc" class="compact"><option value="">すべてのMC</option>${MC_VERSIONS.map((v) => `<option value="${v}"${v === st.mc ? " selected" : ""}>MC ${v}</option>`).join("")}</select>
      </div>
      <div id="pvList" class="group"></div>
      <div id="pvDeps"></div>
    </div>
    <div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok disabled>ダウンロードして追加</button></div>`, (form, finish) => {
    let vers = [], sel = 0;
    const drawDeps = () => {
      const v = vers[sel];
      const deps = (v && v.deps) || [];
      $("#pvDeps", form).innerHTML = deps.length ? `<div class="group-title">前提プラグイン・Mod</div><div class="group">${deps.map((d, i) => `<label class="toggle-row">
          <span class="main">${esc(d.title)}<small>${d.required ? "必須" : "任意"}${d.item_id ? " · ライブラリにあります" : ""}</small></span>
          ${d.item_id ? '<span class="badge ok">✓</span>' : `<input type="checkbox" class="switch" data-dep="${i}"${d.required ? " checked" : ""}>`}</label>`).join("")}</div>
        <div class="group-foot">オンにした前提も、同じ条件(サーバーソフト・MCバージョン)の最新版をまとめて追加します</div>` : "";
    };
    const draw = () => {
      $("#pvList", form).innerHTML = vers.length ? vers.map((v, i) => `<label class="toggle-row">
          <span class="main"><b>${esc(v.version)}</b>${v.type && v.type !== "release" ? ` <span class="badge upd">${esc(v.type)}</span>` : ""}
            <small>${v.date ? esc(fmtDate(v.date)) + " · " : ""}${esc((v.loaders || []).join(", "))}${(v.game_versions || []).length ? ` · MC ${esc(summarizeMc(v.game_versions))}` : ""}${v.downloadable ? "" : " · 自動ダウンロード不可"}</small></span>
          <input type="radio" name="pv" value="${i}"${i === sel ? " checked" : ""}${v.downloadable ? "" : " disabled"}></label>`).join("")
        : `<div class="empty">条件に合うバージョンがありません。サーバーソフトや MC バージョンを変えてください</div>`;
      form.querySelector("[data-ok]").disabled = !(vers[sel] && vers[sel].downloadable);
      drawDeps();
    };
    const load = async () => {
      $("#pvList", form).innerHTML = `<div class="empty"><span class="spinner lg"></span></div>`;
      $("#pvDeps", form).innerHTML = "";
      try {
        const p = new URLSearchParams({ provider: r.provider, project_id: r.project_id, loader: st.loader, mc: st.mc });
        vers = (await api(`/api/search/versions?${p}`)).versions;
        sel = Math.max(0, vers.findIndex((v) => v.downloadable && v.type === "release"));
      } catch (ex) { vers = []; toast(ex.message, true); }
      draw();
    };
    $("#pvLoader", form).onchange = (e) => { st.loader = e.target.value; load(); };
    $("#pvMc", form).onchange = (e) => { st.mc = e.target.value; load(); };
    form.addEventListener("change", (e) => { if (e.target.name === "pv") { sel = Number(e.target.value); draw(); } });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const v = vers[sel];
      const deps = [...form.querySelectorAll("[data-dep]:checked")].map((c) => v.deps[Number(c.dataset.dep)].project_id);
      try {
        const d = await api("/api/import", { json: { provider: r.provider, project_id: r.project_id, version_id: v.version_id,
          loaders: st.loader, game_versions: st.mc, category: st.kind || (r.kind in CATS ? r.kind : ""), with_deps: deps } });
        const extra = (d.deps || []).filter((x) => x.status === "added").length;
        toast(`${d.status === "added" ? "追加しました" : "登録済みです"}: ${d.name} ${d.version || ""}${extra ? `(前提 ${extra} 件も追加)` : ""}`);
        (d.deps || []).filter((x) => ["error", "notfound"].includes(x.status)).forEach((x) => toast(`前提「${x.title}」を追加できませんでした${x.message ? `: ${x.message}` : ""}`, true));
        r.item_id = d.item_id;
        finish(true);
        refresh();
      } catch (ex) { toast(ex.message, true); }
    }, "ダウンロード中…");
    load();
  }, { wide: true });
  return done;
}
function summarizeMc(list) {
  const rel = list.filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)).sort((a, b) => cmpVer(verNums(a), verNums(b)));
  if (!rel.length) return "";
  return rel.length <= 3 ? rel.join(", ") : `${rel[0]}〜${rel[rel.length - 1]}`;
}

/* ---------------- Modパックの読み込み ---------------- */
async function importModpack(file) {
  const r = await formSheet("Modパックを読み込む", `<p>「${esc(file.name)}」の中の Mod をダウンロードしてライブラリに登録します。Modrinth(.mrpack)と CurseForge(zip。APIキーが必要)に対応しています。</p>
    <div class="group">${toggle("set", "セットを作る", "パックの中身を 1 つのセットとして保存します", true)}${toggle("client", "クライアント専用の Mod も含める", "サーバーでは使わない Mod(描画系など)も登録します", false)}</div>`, "読み込む");
  if (!r) return;
  const tp = toastProgress("アップロードしています…");
  try {
    const job = await api(`/api/modpack?filename=${encodeURIComponent(file.name)}&set=${r.set ? 1 : 0}&client=${r.client ? 1 : 0}`, { method: "PUT", body: file, headers: { "Content-Type": "application/zip" } });
    jobStarted(job);
  } catch (e) { toast(e.message, true); }
  finally { tp.remove(); }
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
  { label: "配布サイトから探して追加", icon: "search", run: () => openSearch({ kind: state.cat }) },
  { label: "URLから追加", icon: "link", run: importFromUrl },
  { label: "Modパックを読み込む(.mrpack / zip)", icon: "stack", run: () => $("#packInput").click() },
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
        <div class="group"><button class="row account-row" type="button" data-go="account">
          <span class="avatar">${esc((u.username || "?").slice(0, 1).toUpperCase())}</span>
          <span class="main"><span class="title">${esc(u.username)}</span><span class="subtitle">${esc(u.role_label)} · アカウント・セキュリティ・連携の状況</span></span>
          <span class="trail">${icon("chev", "i chev")}</span></button></div>
        ${isAdmin() ? `<div class="group-title">管理</div><div class="group">
          ${rowBtn("storage", "server", "c-plugin", "ストレージ", `<span class="val">${esc(state.storage?.target?.name || "")}</span>`)}
          ${rowBtn("users", "users", "c-resourcepack", "ユーザー")}
          ${rowBtn("updates", "clock", "c-datapack", "配布元の更新確認")}
        </div>
        <div class="group-title">連携</div><div class="group">
          ${rowBtn("ptero", "server", "c-teal", "Pterodactyl")}
          ${rowBtn("discord", "bell", "c-plugin", "Discord 通知")}
          ${rowBtn("curseforge", "key", "c-other", "CurseForge APIキー")}
        </div>
        <div class="group-title">運用</div><div class="group">
          ${rowBtn("backup", "download", "c-mod", "バックアップ")}
          ${rowBtn("audit", "doc", "c-gray", "操作の記録")}
          ${rowBtn("shares", "share", "c-teal", "共有リンク")}
        </div>` : ""}
        <div class="group-title">表示</div><div class="group">
          ${rowBtn("appearance", "sparkle", "c-resourcepack", "テーマと背景", `<span class="val">${esc(themeName(state.prefs))}</span>`)}
          ${rowBtn("lang", "globe", "c-plugin", "言語 / Language", `<span class="val" translate="no">${I18N.lang === "en" ? "English" : "日本語"}</span>`)}
        </div>
        <div class="group-title">CraftShelf</div><div class="group">
          ${isAdmin() ? rowBtn("selfupdate", "sparkle", "c-mod", "パネルのアップデート", upd ? `<span class="badge upd">v${esc(state.selfUpd.latest)}</span>` : `<span class="val">v${esc(state.version || "")}</span>`)
          : `<div class="row"><span class="cicon sm c-mod">${icon("sparkle")}</span><span class="main"><span class="title">バージョン</span></span><span class="trail">v${esc(state.version || "")}</span></div>`}
        </div>
        <div class="group" style="margin-top:18px"><button class="row danger" type="button" data-go="logout"><span class="cicon sm c-red">${icon("logout")}</span><span class="main"><span class="title">ログアウト</span></span></button></div>
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
      const go = (page, ic, color, title, trail) => `<button class="row" type="button" data-go="${page}"${!isAdmin() && ["ptero", "discord", "curseforge", "backup"].includes(page) ? " disabled" : ""}><span class="cicon sm ${color}">${icon(ic)}</span><span class="main"><span class="title">${esc(title)}</span></span>${trail}</button>`;
      body.innerHTML = `
        <div class="big-version"><span class="avatar lg">${esc(u.username.slice(0, 1).toUpperCase())}</span><div class="v">${esc(u.username)}</div><p>${esc(u.role_label)}${u.last_login ? ` · 最終ログイン ${esc(fmtDateTime(u.last_login))}` : ""}</p></div>
        <div class="group-title">プロフィール</div><div class="group">
          ${rowBtn("username", "person", "c-teal", "ユーザー名を変更", `<span class="val">${esc(u.username)}</span>`)}
          ${rowBtn("password", "key", "c-gray", "パスワードを変更")}
        </div>
        <div class="group-title">セキュリティ</div><div class="group">
          ${rowBtn("totp", "shield", "c-mod", "二段階認証", u.totp_enabled ? '<span class="badge ok">オン</span>' : '<span class="badge">オフ</span>')}
          ${rowBtn("tokens", "key", "c-plugin", "APIトークン")}
        </div>
        <div class="group-title">連携の状況</div><div class="group">
          ${go("ptero", "server", "c-teal", "Pterodactyl", stat(st.ptero_url && st.ptero_key_set, "接続先を設定済み", "未設定"))}
          ${go("discord", "bell", "c-plugin", "Discord 通知", stat(st.discord_set, `${st.discord_events.length} 種類を通知`, "未設定"))}
          ${go("curseforge", "key", "c-other", "CurseForge APIキー", stat(st.cf_api_key_set, "登録済み", "未登録"))}
          ${go("backup", "download", "c-mod", "自動バックアップ", stat(st.backup_target_id, st.last_backup ? `前回 ${fmtDateTime(st.last_backup)}` : "毎日", "オフ"))}
          ${go("updates", "clock", "c-datapack", "更新の自動確認", stat(st.check_interval_hours, `${st.check_interval_hours} 時間ごと`, "オフ"))}
        </div>
        ${!isAdmin() ? `<div class="group-foot">連携の設定は管理者が行います</div>` : ""}`;
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
        <button class="btn filled block" type="button" id="tkNew">作成</button><div id="tkOut"></div>`;
      body.onclick = async (e) => {
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
        ${u && u.totp_enabled && u.id !== state.user.id ? `<button class="btn block" type="button" id="uTotp">二段階認証をリセット(スマホを紛失した場合)</button>` : ""}
        ${u && u.id !== state.user.id ? `<button class="btn danger block" type="button" id="uDel">このユーザーを削除</button>` : ""}`;
      $("#uTotp", body)?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
        if (!cfm(`「${u.username}」の二段階認証をリセットしますか?`)) return;
        try { await api(`/api/users/${u.id}`, { method: "PATCH", json: { reset_totp: true } }); toast("リセットしました"); popSettings(); } catch (ex) { toast(ex.message, true); }
      }));
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
        if (!cfm(`「${u.username}」を削除しますか?`)) return;
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
      body.innerHTML = `<div class="big-version"><img class="logo" src="/static/icon.svg" alt="" aria-hidden="true">
          <div class="v">${d.update_available ? `v${esc(d.latest)}` : `v${esc(d.current)}`}</div>
          <p>${d.error ? esc(d.error) : d.update_available ? `現在 v${esc(d.current)} · 新しいバージョンがあります` : "CraftShelf は最新です"}</p></div>
        ${d.notes && d.notes.length ? `<div class="notes">${d.notes.map((n) => `<h4>v${esc(n.version)} ${esc(n.title)}</h4><div class="body">${esc(n.body)}</div>`).join("")}</div>` : ""}
        ${d.update_available && d.mode === "installer" ? `<a class="btn filled block" href="${esc(safeUrl(d.download_url))}" target="_blank" rel="noopener noreferrer">${icon("download")}新しいインストーラーをダウンロード</a>
          <div class="group-foot" style="text-align:center">ダウンロードしたインストーラーを実行すると、上書きでアップデートされます。保存したファイルや登録情報はそのまま残ります。</div>`
          : d.update_available ? `<button class="btn filled block" type="button" id="suGo">ダウンロードしてインストール</button>
          <div class="group-foot" style="text-align:center">インストール後に自動で再起動します(数秒〜数十秒)。保存したファイルや登録情報はそのまま残ります。</div>`
          : `<button class="btn tinted block" type="button" id="suRe">${icon("refresh")}もう一度確認</button>`}
        ${d.mode === "installer" ? "" : `<div class="group" style="margin-top:6px">${toggle("self_auto_update", "自動アップデート", "6時間ごとに確認し、新しいバージョンがあれば自動でインストールします", (await api("/api/settings")).self_auto_update)}</div>`}
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
$("#packInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importModpack(f); });
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

/* ---------------- 英語表示(辞書で画面の日本語を置き換える) ---------------- */
const I18N = { lang: "ja", re: null, map: null, obs: null };
const JA_CHARS = /[぀-ヿ㐀-鿿！-｠]/;
function trText(s) {
  if (I18N.lang !== "en" || !s || !JA_CHARS.test(s) || !I18N.re) return s;
  for (const [re, to] of window.CS_EN_RULES || []) s = s.replace(re, to);
  s = s.replace(I18N.re, (m) => I18N.map[m]);
  for (const [re, to] of window.CS_EN_PUNCT || []) s = s.replace(re, to);
  return s;
}
const skipTr = (el) => el && el.closest && el.closest("[translate=no], script, style, textarea, input, code, .filelist, .log");
function trTree(root) {
  if (I18N.lang !== "en") return;
  if (root.nodeType === 3) { if (!skipTr(root.parentElement)) setTxt(root); return; }
  if (root.nodeType !== 1 || skipTr(root)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) if (!skipTr(n.parentElement)) setTxt(n);
  const els = [root, ...root.querySelectorAll("[placeholder], [title], [aria-label]")];
  for (const el of els) for (const a of ["placeholder", "title", "aria-label"]) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v && JA_CHARS.test(v)) { const t = trText(v); if (t !== v) el.setAttribute(a, t); }
  }
}
/* 同じ値を書き戻すと変更の監視がまた反応して無限に繰り返すため、変わるときだけ書き換える */
function setTxt(n) {
  const v = n.nodeValue;
  if (!v || !JA_CHARS.test(v)) return;
  const t = trText(v);
  if (t !== v) n.nodeValue = t;
}
function setLang(lang) {
  lang = lang === "en" ? "en" : "ja";
  const changed = I18N.lang !== lang;
  I18N.lang = lang;
  document.documentElement.lang = lang;
  try { localStorage.setItem("craftshelf.lang", lang); } catch { /* */ }
  if (lang === "en" && !I18N.re && window.CS_EN) {
    const keys = Object.keys(window.CS_EN).filter((k) => k).sort((a, b) => b.length - a.length);
    I18N.map = window.CS_EN;
    I18N.re = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  }
  if (lang === "en" && !I18N.obs) {
    I18N.obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") trTree(m.target);
        else if (m.type === "attributes") { const v = m.target.getAttribute(m.attributeName); if (v && JA_CHARS.test(v) && !skipTr(m.target)) { const t = trText(v); if (t !== v) m.target.setAttribute(m.attributeName, t); } }
        else m.addedNodes.forEach(trTree);
      }
    });
    I18N.obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "title", "aria-label"] });
  }
  if (lang === "en") { trTree(document.body); document.title = "CraftShelf"; }
  return changed;
}
const cfm = (m) => confirm(trText(m));

/* ---------------- サーバーソフト(プラットフォーム)の分類 ---------------- */
const PLATFORMS = ["Paper", "Spigot / Paper", "Folia", "Velocity", "BungeeCord", "Fabric", "Quilt", "Forge", "NeoForge", "Iris / OptiFine", "Datapack", "Minecraft"];
function platformOf(it) {
  if (it.platform) return it.platform;
  const latest = it.versions.find((v) => v.id === it.latest_id) || it.versions[0] || { meta: {} };
  const lab = String(latest.meta.loader || "").toLowerCase();
  const srcL = ((it.source && it.source.loaders) || []).join(" ");
  if (lab.includes("velocity") || (!lab && srcL === "velocity")) return "Velocity";
  if (lab.includes("bungee")) return "BungeeCord";
  if (lab === "paper") return "Paper";
  if (lab.includes("bukkit") || lab.includes("spigot")) return srcL.includes("folia") && !srcL.includes("spigot") ? "Folia" : "Spigot / Paper";
  if (lab.includes("neoforge")) return "NeoForge";
  if (lab.includes("forge")) return "Forge";
  if (lab.includes("quilt")) return "Quilt";
  if (lab.includes("fabric")) return "Fabric";
  if (it.category === "shader") return "Iris / OptiFine";
  if (it.category === "datapack") return "Datapack";
  if (it.category === "resourcepack") return "Minecraft";
  if (it.category === "plugin") return "Spigot / Paper";
  return "";
}

/* ---------------- 選択して一括操作 ---------------- */
state.sel = new Set();
function setSelMode(on) {
  state.selMode = on;
  if (!on) state.sel.clear();
  document.body.classList.toggle("selecting", on);
  $("#selBtn").textContent = on ? "完了" : "選択";
  $("#selBtn").classList.toggle("filled", on);
  render();
  drawSelBar();
}
function drawSelBar() {
  const bar = $("#selBar");
  bar.hidden = !state.selMode;
  if (!state.selMode) return;
  const n = state.sel.size;
  bar.innerHTML = `<span class="selcount">${n} 件選択</span>
    <button class="btn plain small" type="button" data-sb="all">${state.sel.size && state.sel.size === filtered().length ? "選択を解除" : "すべて選択"}</button>
    <span class="sp"></span>
    <button class="sbtn" type="button" data-sb="zip"${n ? "" : " disabled"}>${icon("download")}<span>ダウンロード</span></button>
    <button class="sbtn need-editor" type="button" data-sb="share"${n ? "" : " disabled"}>${icon("share")}<span>共有</span></button>
    <button class="sbtn need-editor" type="button" data-sb="server"${n ? "" : " disabled"}>${icon("server")}<span>サーバーへ</span></button>
    <button class="sbtn need-editor" type="button" data-sb="more"${n ? "" : " disabled"}>${icon("more")}<span>その他</span></button>`;
}
$("#selBtn").addEventListener("click", () => setSelMode(!state.selMode));
$("#selBar").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sb]"); if (!b || b.disabled) return;
  const ids = [...state.sel];
  const items = state.items.filter((i) => state.sel.has(i.id));
  const a = b.dataset.sb;
  if (a === "all") {
    const vis = filtered();
    if (state.sel.size === vis.length) state.sel.clear(); else vis.forEach((i) => state.sel.add(i.id));
    render(); drawSelBar(); return;
  }
  if (a === "zip") {
    const link = document.createElement("a");
    link.href = `/api/items/zip?ids=${ids.join(",")}`;
    link.download = "";
    document.body.appendChild(link); link.click(); link.remove();
    toast(`${ids.length} 件をまとめてダウンロードしています…`);
  }
  if (a === "share") shareDialog(items);
  if (a === "server") pushDialog({ itemIds: ids });
  if (a === "more") {
    openMenu(b, [
      { label: "セットに追加", icon: "stack", run: () => addManyToSet(items) },
      { label: "タグを付ける", icon: "tag", run: () => tagMany(items) },
      { label: "更新を確認", icon: "refresh", run: () => checkMany(items) },
      "-",
      { label: "削除", icon: "trash", danger: true, run: () => deleteMany(items) },
    ]);
  }
});
async function shareDialog(items) {
  await sheet(`${sheetHead("共有リンクを作る")}<div class="db">
      <p>ログインしていない人でもダウンロードできる、期限付きのリンクを作ります(${items.length} 件。1 件ならそのファイル、複数なら zip)。</p>
      ${field("名前(ダウンロードする人に見えます)", `<input type="text" name="name" value="${esc(items.length === 1 ? items[0].name : `${items[0].name} ほか ${items.length - 1} 件`)}">`)}
      ${field("有効期限", `<select name="hours"><option value="24">1日</option><option value="168" selected>7日</option><option value="720">30日</option></select>`)}
      <div id="shOut"></div>
    </div><div class="df row2"><button class="btn" type="button" data-close>閉じる</button><button class="btn filled" type="button" data-ok>リンクを作る</button></div>`, (form) => {
    const ok = form.querySelector("[data-ok]");
    ok.onclick = () => busy(ok, async () => {
      try {
        const r = await api("/api/shares", { json: { item_ids: items.map((i) => i.id), name: form.querySelector("[name=name]").value, hours: Number(form.querySelector("[name=hours]").value) } });
        $("#shOut", form).innerHTML = `<div class="result ok">リンクを作りました(${esc(fmtDateTime(r.expires_at))} まで有効)</div>
          <div class="sharelink"><input type="text" readonly value="${esc(r.url)}" translate="no"><button class="btn small tinted" type="button" data-copy>コピー</button>
          ${navigator.share ? `<button class="btn small" type="button" data-nshare>${icon("share")}送る</button>` : ""}</div>`;
        $("[data-copy]", form).onclick = async () => { try { await navigator.clipboard.writeText(r.url); toast("コピーしました"); } catch { form.querySelector(".sharelink input").select(); } };
        $("[data-nshare]", form)?.addEventListener("click", () => navigator.share({ title: r.name, url: r.url }).catch(() => {}));
        ok.hidden = true;
      } catch (ex) { toast(ex.message, true); }
    }, "作成中…");
  });
}
async function addManyToSet(items) {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  if (!state.sets.length) { toast("先に「セット」タブでセットを作成してください", true); return; }
  const r = await formSheet("セットに追加", field("セット", `<select name="sid">${state.sets.map((s) => `<option value="${s.id}">${esc(s.name)}(${s.items.length} 件)</option>`).join("")}</select>`), "追加");
  if (!r) return;
  const s = state.sets.find((x) => x.id === Number(r.sid));
  const have = new Set(s.items.map((x) => x.item_id));
  const add = items.filter((i) => !have.has(i.id)).map((i) => ({ item_id: i.id, version_id: null }));
  try { await api(`/api/sets/${s.id}`, { method: "PATCH", json: { items: s.items.concat(add) } }); toast(`「${s.name}」に ${add.length} 件追加しました`); state.sets = null; }
  catch (e) { toast(e.message, true); }
}
async function tagMany(items) {
  const r = await formSheet("タグを付ける", `${field("付けるタグ(カンマ区切り)", `<input type="text" name="tags" list="tagList2" autocomplete="off"><datalist id="tagList2">${allTags().map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`)}
    ${allTags().length ? `<div class="chips">${allTags().map((t) => `<button class="tagchip" type="button" data-addtag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}`, "付ける");
  if (!r) return;
  const add = String(r.tags || "").split(/[,、]/).map((t) => t.trim()).filter(Boolean);
  if (!add.length) return;
  const tp = toastProgress("タグを付けています…");
  try {
    for (const it of items) {
      await api(`/api/items/${it.id}`, { method: "PATCH", json: { name: it.name, category: it.category, tags: [...new Set([...(it.tags || []), ...add])] } });
    }
    toast(`${items.length} 件にタグを付けました`); await refresh();
  } catch (e) { toast(e.message, true); } finally { tp.remove(); }
}
async function checkMany(items) {
  const linked = items.filter((i) => i.source);
  if (!linked.length) { toast("配布元が紐付いているものがありません", true); return; }
  const tp = toastProgress(`${linked.length} 件の更新を確認しています…`);
  try { for (const it of linked) await api(`/api/items/${it.id}/source/check`, { method: "POST" }); toast("確認しました"); await refresh(); }
  catch (e) { toast(e.message, true); } finally { tp.remove(); }
}
async function deleteMany(items) {
  if (!(await confirmSheet(`${items.length} 件を削除しますか?`, `保存しているすべてのバージョンのファイルが削除され、元に戻せません。\n${items.slice(0, 8).map((i) => i.name).join(", ")}${items.length > 8 ? " ほか" : ""}`, "削除"))) return;
  const tp = toastProgress("削除しています…");
  try { for (const it of items) await api(`/api/items/${it.id}`, { method: "DELETE" }); toast(`${items.length} 件を削除しました`); state.sel.clear(); await refresh(); drawSelBar(); }
  catch (e) { toast(e.message, true); } finally { tp.remove(); }
}

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
