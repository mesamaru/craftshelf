"use strict";
/* CraftShelf — 画面の処理 */

const $ = (s, root = document) => root.querySelector(s);

// iPhone / iPad: 16px より小さい入力欄を押すと画面が勝手に拡大されるので止める(iOS は指での拡大はこの指定でも使える)
if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
  document.querySelector("meta[name=viewport]")?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
}

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
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8" r="1.4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  stack: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7.5a8 8 0 1 0 11.4 0"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
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
/* 管理者がユーザーごとに付ける権限(管理者はすべて持つ) */
const PERM_LABELS = {
  storage: ["保存先の管理", "保存先の追加・切り替え・移行・バックアップ"],
  users: ["ユーザーの管理", "ユーザーの追加・削除・利用状況の確認"],
  integrations: ["連携の設定", "Pterodactyl・Discord・CurseForge"],
  system: ["パネル全体の設定", "パネルのアップデート・更新確認の間隔など"],
  audit: ["操作の記録", "誰がいつ何をしたかを見る"],
};
const can = (p) => !!state.user && (state.user.role === "admin" || (state.user.perms || []).includes(p));

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
/* お知らせはシート(dialog)より前に出す。popover で最前面の層に置き、出すたびに一番上へ上げ直す */
function toastHost() {
  const t = $("#toasts");
  if (t.showPopover) { try { if (t.matches(":popover-open")) t.hidePopover(); t.showPopover(); } catch { /* 古いブラウザ */ } }
  else if ($("#dlg").open && t.parentElement !== $("#dlg")) $("#dlg").appendChild(t);
  else if (!$("#dlg").open && t.parentElement !== document.body) document.body.appendChild(t);
  return t;
}
function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast glass" + (isErr ? " err" : "");
  el.innerHTML = `<span class="ic">${icon(isErr ? "x" : "check")}</span><span></span>`;
  el.lastChild.textContent = msg;
  toastHost().appendChild(el);
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
    // ウィンドウの外(背景)を押したら閉じる。押し始めも外だったときだけ(文字の選択で外に出ても閉じない)
    const outside = (e) => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
    let downOutside = false;
    dlg.onpointerdown = (e) => { downOutside = e.target === dlg && outside(e); };
    dlg.onclick = (e) => { if (downOutside && e.target === dlg && outside(e)) done(null); downOutside = false; };
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
  const w = m.offsetWidth, h = m.offsetHeight;
  const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
  m.style.top = `${h + 8 > below && above > below ? Math.max(8, r.top - 8 - h) : r.bottom + 8}px`;
  m.style.maxHeight = `${Math.max(160, Math.max(below, above) - 16)}px`;
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
  const hasUpd = (i) => (i.source && i.source.status === "update" ? 1 : 0);
  return list.sort((a, b) => {
    let r = 0;
    if (k === "fav") return (Number(!!b.favorite) - Number(!!a.favorite)) || cmpName(a, b);
    if (k === "upd") return (hasUpd(b) - hasUpd(a)) || cmpName(a, b);
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
  const platCounts = {};
  for (const i of state.items) { const p = platformOf(i); if (p) platCounts[p] = (platCounts[p] || 0) + 1; }
  platSel.innerHTML = `<option value="">サーバーソフト: すべて</option>` + platOptions(state.plat, platCounts);
  platSel.value = state.plat || "";
  const mcSel = $("#mcSel");
  if (mcSel.options.length === 1) mcSel.insertAdjacentHTML("beforeend", MC_LINES.map((v) => `<option value="${v}">MC ${v}</option>`).join(""));
  mcSel.value = state.mc || "";

  const list = filtered();
  const otherHint = state.cat === "other" && list.length && isEditor()
    ? `<div class="hint-row">${icon("wand")}<span>「その他」は種類を自動で判定できなかったものです。<b>選択</b> → <b>その他</b> → <b>種類を変更</b> で、まとめて正しい種類に直せます(1件ずつなら詳細の ✏️ から)。</span></div>` : "";
  const webFind = state.q && isEditor() ? `<button class="row webfind" type="button" data-webfind="1"><span class="cicon sm c-plugin">${icon("search")}</span>
    <span class="main"><span class="title">「${esc(state.q)}」を配布サイトで探す</span><span class="subtitle">Modrinth / SpigotMC / CurseForge から探して、MC バージョンを選んで保存できます</span></span>${icon("chev", "i chev")}</button>` : "";
  if (!list.length) {
    $("#list").innerHTML = `<div class="empty"><div class="big">📦</div>${state.items.length ? `条件に合うものがありません${state.mc ? `<br><small>MC ${esc(state.mc)} で使えると判定できたものだけを表示しています。対応MCバージョンが不明なものは表示されません</small>` : ""}`
      : isEditor() ? "まだ何も登録されていません。<br>ファイルをドロップするか、「配布サイトで探す」から追加してください" : "まだ何も登録されていません"}</div>${webFind}`;
  } else {
    const rowHTML = (it) => {
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
        <span class="main"><span class="title"><span translate="no">${esc(it.name)}</span>${favBtn(it)}</span>
          <span class="subtitle">${it.access && it.access !== "owner" ? `<span class="ownerb" translate="no">${icon("users")}${esc(it.owner_name)}</span>` : ""}${(it.shared_with || []).length ? `<span class="ownerb out" title="${esc(it.shared_with.map((x) => x.username).join(", "))} に共有中">${icon("share")}${it.shared_with.length}</span>` : ""}${plat ? `<span class="plat" translate="no">${esc(platShort(plat))}</span>` : ""}${esc(verLabel(latest.version))}${mc ? ` · MC ${esc(mc)}` : ""} · ${it.versions.length} バージョン<span class="hide-s"> · ${fmtSize(it.total_size)} · ${fmtDate(it.last_added)}</span></span>
          ${(it.tags || []).length ? `<span class="rtags">${it.tags.slice(0, 4).map((t) => `<span class="tagchip mini" translate="no">#${esc(t)}</span>`).join("")}</span>` : ""}</span>
        ${trailOf(it, upd, missing, page)}
        ${icon("chev", "i chev rowchev")}
      </div>`;
    };
    const mine = list.filter((it) => !it.access || it.access === "owner");
    const shared = list.filter((it) => it.access && it.access !== "owner");
    $("#list").innerHTML = otherHint + mine.map(rowHTML).join("")
      + (shared.length ? `<div class="list-sep">${icon("users")}共有されたもの<span>${shared.length} 件</span></div>${shared.map(rowHTML).join("")}` : "")
      + webFind;
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
  banner.innerHTML = s.error ? `<span>⚠️ ${esc(s.error)}</span>${can("storage") ? `<button class="btn small tinted" type="button" id="bannerOpen">ストレージ設定を開く</button>` : ""}` : "";
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
    ${can("storage") ? `<button class="btn tinted" type="button" id="nasSet">ストレージ設定</button>` : `<button class="btn" type="button" data-close>閉じる</button>`}</div>`, (form, done) => {
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
$("#list").addEventListener("click", (e) => { if (e.target.closest("[data-webfind]")) { e.stopPropagation(); openSearch({ q: state.q, kind: state.cat }); } }, true);
$("#mcSel").addEventListener("change", (e) => { state.mc = e.target.value; render(); });
$("#platSel").addEventListener("change", (e) => { state.plat = e.target.value; render(); });
$("#tagChips").addEventListener("click", (e) => { const b = e.target.closest("[data-tagf]"); if (!b) return; state.tag = state.tag === b.dataset.tagf ? "" : b.dataset.tagf; render(); });
$("#sortSel").addEventListener("change", (e) => {
  const [k, d] = e.target.value.split(":"); state.sortKey = k; state.sortDir = Number(d); render();
  savePrefs({ sort: e.target.value }).catch(() => {});
});
/* お気に入り(本人だけのしるし) */
const favBtn = (it) => `<button class="favbtn${it.favorite ? " on" : ""}" type="button" data-fav="${it.id}" aria-pressed="${!!it.favorite}" title="${it.favorite ? "お気に入りから外す" : "お気に入りに追加"}" aria-label="お気に入り">${icon("star")}</button>`;
async function toggleFav(id) {
  const it = state.items.find((i) => i.id === id); if (!it) return;
  const on = !it.favorite;
  it.favorite = on; render();
  try { await api(`/api/items/${id}/favorite`, { json: { on } }); }
  catch (e) { it.favorite = !on; render(); toast(e.message, true); }
}
document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-fav]"); if (!f) return;
  e.preventDefault(); e.stopPropagation();
  toggleFav(Number(f.dataset.fav));
}, true);
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
  document.body.classList.remove("srv-detail");
  if (state.jobs) renderJobs();
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

// 今の画面を読み込み直す(下に引っ張ったとき)
async function reloadView() {
  await refresh();
  if (state.view === "dash") renderDash();
  else if (state.view === "sets") await loadSets();
  else if (state.view === "servers") await loadServers();
}
// スマホ: 一番上で下に引っ張って離すと、今の画面を読み込み直す
(() => {
  const ind = document.createElement("div");
  ind.className = "ptr"; ind.setAttribute("aria-hidden", "true");
  ind.innerHTML = `<span class="ptr-ic">${icon("refresh")}</span>`;
  document.body.appendChild(ind);
  const ic = ind.firstChild, TH = 70;
  let y0 = null, x0 = 0, dy = 0, running = false;
  const reset = () => { ind.className = "ptr"; ind.style.transform = ""; ind.style.opacity = ""; ic.style.transform = ""; };
  const ready = () => !running && scrollY <= 0 && !document.body.classList.contains("scroll-locked") && !$("#dlg").open;
  addEventListener("touchstart", (e) => {
    y0 = e.touches.length === 1 && ready() ? e.touches[0].clientY : null;
    x0 = y0 === null ? 0 : e.touches[0].clientX; dy = 0;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    const t = e.touches[0];
    dy = t.clientY - y0;
    if (dy <= 0 || scrollY > 0 || Math.abs(t.clientX - x0) > dy) { if (dy < 0 || scrollY > 0) { y0 = null; reset(); } return; }
    const pull = Math.min(dy * 0.55, 90);
    ind.style.transform = `translate(-50%, ${pull}px)`;
    ind.style.opacity = String(Math.min(1, dy / TH));
    ic.style.transform = `rotate(${Math.min(dy / TH, 1.3) * 300}deg)`;
    ind.classList.add("drag"); ind.classList.toggle("ready", dy >= TH);
  }, { passive: true });
  const end = async () => {
    if (y0 === null) return;
    y0 = null;
    if (dy < TH) { reset(); return; }
    running = true;
    ind.classList.remove("drag"); ind.classList.add("spin"); ind.style.transform = "translate(-50%, 50px)"; ind.style.opacity = "1"; ic.style.transform = "";
    try { await reloadView(); } finally { running = false; reset(); }
  };
  addEventListener("touchend", end);
  addEventListener("touchcancel", () => { y0 = null; reset(); });
})();

// スマホ: 一覧を下へスクロールすると検索欄の下(絞り込み・並び順・種類)を畳み、上へ戻すか「絞り込み」で開く
// 畳んだ分は下の余白で埋めて、ページの高さを変えない(高さが変わるとスクロール位置が動き、開閉を繰り返してしまう)
(() => {
  const tb = $(".toolbar"), mq = matchMedia("(max-width: 700px)");
  let lastY = scrollY, acc = 0, until = 0;
  const filtered = () => !!(state.plat || $("#mcSel").value || state.tag || (state.cat && state.cat !== "all"));
  const stuck = () => tb.getBoundingClientRect().top <= parseFloat(getComputedStyle(tb).top) + 1;
  const set = (on) => {
    if (tb.classList.contains("tucked") === on) return;
    $("#tbMore .dot").hidden = !filtered();
    if (on) {
      const h = tb.offsetHeight, mb = parseFloat(getComputedStyle(tb).marginBottom);
      tb.classList.add("tucked"); tb.classList.remove("reveal");
      tb.style.marginBottom = `${mb + h - tb.offsetHeight}px`;
    } else {
      tb.classList.remove("tucked"); tb.classList.add("reveal");
      tb.style.marginBottom = "";
    }
    acc = 0; until = performance.now() + 350;  // 切り替えた直後はしばらく様子を見る
  };
  addEventListener("scroll", () => {
    if (document.body.classList.contains("scroll-locked")) return;
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    if (y < 0 || y > max) return;  // iOS の端での跳ね返りは数えない
    const d = y - lastY; lastY = y;
    if (!mq.matches || state.view !== "library" || document.activeElement === $("#search")) { acc = 0; return; }
    if (!stuck()) { set(false); return; }
    if (performance.now() < until) return;
    acc = (acc > 0) === (d > 0) ? acc + d : d;
    if (acc > 40) set(true);
    else if (acc < -80) set(false);
  }, { passive: true });
  mq.addEventListener("change", () => set(false));
  $("#tbMore").addEventListener("click", () => set(false));
})();

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
  const recent = [...items].sort((a, b) => (a.last_added < b.last_added ? 1 : -1)).slice(0, 30);
  const counts = Object.keys(CATS).map((k) => [k, items.filter((i) => i.category === k).length]).filter(([, n]) => n > 0);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const s = state.storage || {}, t = s.target;
  if (!state.dashSettings) { try { state.dashSettings = await api("/api/settings"); } catch { state.dashSettings = {}; } }
  const st = state.dashSettings;
  const itemRow = (it, trail) => `<div class="row" role="button" tabindex="0" data-open="${it.id}">
      ${itemIcon(it, true)}
      <span class="main"><span class="title">${esc(it.name)}</span><span class="subtitle">${esc(verLabel((it.versions.find((v) => v.id === it.latest_id) || it.versions[0]).version))}${mcOf(it) ? ` · MC ${esc(mcOf(it))}` : ""}</span></span>
      <span class="trail">${trail}${icon("chev", "i chev")}</span></div>`;
  // 一覧は数件だけ見せ、「もっと見る」で全部をシートに出す
  state.dashLists = {};
  const SHOW = 4;
  const limited = (key, title, rows) => {
    state.dashLists[key] = { title, rows };
    return rows.slice(0, SHOW).join("") + (rows.length > SHOW
      ? `<button class="kv linkish more" type="button" data-more="${key}"><span>もっと見る</span><span>残り ${rows.length - SHOW} 件 ›</span></button>` : "");
  };
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
        <div class="card-b">${upd.length ? limited("upd", "更新があるもの", upd.map((it) => itemRow(it, `<span class="badge upd">${esc(it.source.latest.version || "")}</span>`)))
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
        <div class="card-h"><h4>確認が必要なもの</h4><button class="btn small need-editor" type="button" data-dact="cleanup">${icon("wand")}整理</button></div>
        <div class="card-b">${missing.length || errs.length || depMissing.length || unknownMc.length ? `
          ${limited("attn", "確認が必要なもの", [
            ...depMissing.map((it) => itemRow(it, `<span class="badge err">前提が不足: ${esc(it.missing_deps.join(", "))}</span>`)),
            ...missing.map((it) => itemRow(it, '<span class="badge err">ファイルが見つかりません</span>')),
            ...errs.map((it) => itemRow(it, '<span class="badge err">更新を確認できません</span>'))])}
          ${unknownMc.length ? `<button class="kv linkish" type="button" data-go="nomc"><span>対応MCバージョンが不明</span><span>${unknownMc.length} 件 ›</span></button>` : ""}`
          : `<div class="dash-empty">問題はありません 👍</div>`}</div>
      </div>
      <div class="card">
        <div class="card-h"><h4>最近追加したもの</h4></div>
        <div class="card-b">${recent.length ? limited("recent", "最近追加したもの", recent.map((it) => itemRow(it, `<span class="val" style="font-size:13px">${esc(fmtDate(it.last_added))}</span>`))) : `<div class="dash-empty">まだ何も登録されていません</div>`}</div>
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
        <div class="card-h"><h4>保存先とバックアップ</h4>${can("storage") ? `<button class="btn small" type="button" data-dact="storage">設定</button>` : ""}</div>
        <div class="card-b">${t ? `
          <div class="kv"><span>保存先</span><span>${esc(t.name)}(${esc(t.protocol_label)})</span></div>
          <div class="kv"><span>状態</span><span><span class="status-dot ${s.error ? "err" : "ok"}" style="display:inline-block;margin-right:6px"></span>${s.error ? esc(s.error) : "接続しています"}</span></div>` : ""}
          <div class="kv"><span>自動バックアップ</span><span>${st.backup_target_id ? `毎日${st.last_backup ? `(前回 ${esc(fmtDateTime(st.last_backup))})` : ""}` : "設定されていません"}</span></div>
        </div>
      </div>
    </div>`;
  arrangeDash();
}
$("#dash").addEventListener("click", (e) => {
  const m = e.target.closest("[data-more]"); if (!m || state.dashEdit) return;
  e.stopPropagation();
  const L = (state.dashLists || {})[m.dataset.more]; if (!L) return;
  sheet(`${sheetHead(`${L.title}(${L.rows.length} 件)`)}<div class="db"><div class="group dash-list">${L.rows.join("")}</div></div>`, (form, done) => {
    form.addEventListener("click", (ev) => { const r = ev.target.closest("[data-open]"); if (r) { done(null); openPanel(Number(r.dataset.open)); } });
  }, { wide: true });
}, true);
/* ---------------- ダッシュボードのウィジェット(並べ替え・表示切り替え・幅) ---------------- */
const DASH_W = [["tiles", "概要"], ["updates", "更新があるもの"], ["cats", "種類ごとの件数"], ["attention", "確認が必要なもの"],
  ["recent", "最近追加したもの"], ["servers", "サーバー"], ["links", "配布元の連携"], ["storage", "保存先とバックアップ"]];
const DASH_DEFAULT = { order: DASH_W.map(([k]) => k), hidden: [], full: ["tiles"] };
function dashLayout() {
  const d = (state.prefs && state.prefs.dash) || {};
  const custom = Array.isArray(d.custom) ? d.custom : [];
  const known = [...DASH_W.map(([k]) => k), ...custom.map((c) => c.id)];
  const order = (d.order || []).filter((k) => known.includes(k));
  for (const k of known) if (!order.includes(k)) order.push(k);
  return { order, hidden: (d.hidden || []).filter((k) => known.includes(k)), full: (d.full || DASH_DEFAULT.full).filter((k) => known.includes(k)), custom };
}
/* ---- 追加できるウィジェット(メモ・ToDo・時計・今日の日付) ---- */
const CW_TYPES = { memo: ["メモ", "doc"], todo: ["ToDo リスト", "check"], clock: ["時計", "clock"], date: ["今日の日付", "calendar"] };
const cwName = (c) => c.title || CW_TYPES[c.type][0];
/* Markdown を安全に HTML にする(先にすべてエスケープし、決まった書き方だけを変換する) */
function mdToHtml(src) {
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = null, code = null, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(src).split("\n")) {
    if (code !== null) { if (/^```/.test(raw)) { out.push(`<pre><code>${code.join("\n")}</code></pre>`); code = null; } else code.push(raw); continue; }
    if (/^```/.test(raw)) { flush(); code = []; continue; }
    let m;
    if ((m = raw.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(raw.trim())) { flush(); out.push("<hr>"); continue; }
    if ((m = raw.match(/^&gt;\s?(.*)$/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = raw.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)$/i))) { if (para.length) flush(); if (list !== "ul") { flush(); out.push('<ul class="md-check">'); list = "ul"; } out.push(`<li>${m[1].trim() ? "☑" : "☐"} ${inline(m[2])}</li>`); continue; }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) { if (para.length) flush(); if (list !== "ul") { flush(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) { if (para.length) flush(); if (list !== "ol") { flush(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (!raw.trim()) { flush(); continue; }
    if (list) flush();
    para.push(raw);
  }
  if (code !== null) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flush();
  return out.join("");
}
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function clockSVG() {
  const t = new Date(), h = t.getHours() % 12, m = t.getMinutes(), s = t.getSeconds();
  const hand = (deg, len, w, cls) => { const r = (deg - 90) * Math.PI / 180; return `<line class="${cls}" x1="50" y1="50" x2="${(50 + Math.cos(r) * len).toFixed(2)}" y2="${(50 + Math.sin(r) * len).toFixed(2)}" stroke-width="${w}" stroke-linecap="round"/>`; };
  const ticks = Array.from({ length: 12 }, (_, i) => { const r = i * 30 * Math.PI / 180; return `<line x1="${(50 + Math.sin(r) * 40).toFixed(2)}" y1="${(50 - Math.cos(r) * 40).toFixed(2)}" x2="${(50 + Math.sin(r) * (i % 3 ? 43 : 45)).toFixed(2)}" y2="${(50 - Math.cos(r) * (i % 3 ? 43 : 45)).toFixed(2)}" class="tick" stroke-width="${i % 3 ? 1 : 2}"/>`; }).join("");
  return `<svg viewBox="0 0 100 100" class="aclock" role="img" aria-label="${t.toLocaleTimeString()}"><circle cx="50" cy="50" r="47" class="face"/>${ticks}
    ${hand((h + m / 60) * 30, 24, 3.2, "hh")}${hand((m + s / 60) * 6, 34, 2.2, "mh")}${hand(s * 6, 38, 1, "sh")}<circle cx="50" cy="50" r="2.2" class="sh-dot"/></svg>`;
}
function customWidgetHTML(c) {
  const head = (extra = "") => `<div class="card-h"><h4 translate="no">${esc(cwName(c))}</h4>${extra}</div>`;
  if (c.type === "memo") {
    return head(`<button class="icon-btn sm" type="button" data-cw="memo-edit" data-cid="${c.id}" title="メモを編集" aria-label="メモを編集">${icon("edit")}</button>`)
      + `<div class="card-b memo-body" translate="no">${(c.text || "").trim() ? (c.md ? `<div class="md">${mdToHtml(c.text)}</div>` : `<div class="plain">${esc(c.text)}</div>`)
        : `<div class="dash-empty">${icon("edit")} 右上のボタンからメモを書けます</div>`}</div>`;
  }
  if (c.type === "todo") {
    const items = c.items || [], left = items.filter((x) => !x.d).length;
    return head(`<span class="muted" style="font-size:12.5px">${items.length ? `残り ${left} 件` : ""}</span>`)
      + `<div class="card-b"><div class="todo" translate="no">${items.map((x, i) => `<div class="todo-row${x.d ? " done" : ""}">
          <input type="checkbox" class="cbox" data-cw="todo-toggle" data-cid="${c.id}" data-i="${i}"${x.d ? " checked" : ""} aria-label="完了">
          <span class="t">${esc(x.t)}</span>
          <button class="icon-btn sm" type="button" data-cw="todo-del" data-cid="${c.id}" data-i="${i}" title="削除" aria-label="削除">${icon("x")}</button></div>`).join("")}</div>
        <form class="todo-add" data-cid="${c.id}"><input type="text" maxlength="200" placeholder="やることを追加(Enter)" aria-label="やることを追加"><button class="btn small tinted" type="submit">${icon("plus")}</button></form>
        ${items.some((x) => x.d) ? `<button class="btn plain small" type="button" data-cw="todo-clear" data-cid="${c.id}" style="margin-top:4px">完了したものを消す</button>` : ""}</div>`;
  }
  if (c.type === "clock") {
    return head(`<button class="btn plain small" type="button" data-cw="clock-style" data-cid="${c.id}">${c.style === "analog" ? "デジタルにする" : "アナログにする"}</button>`)
      + `<div class="card-b"><div class="clockw ${c.style === "analog" ? "analog" : "digital"}" data-clock="${c.id}"></div></div>`;
  }
  const t = new Date();
  return head() + `<div class="card-b"><div class="datew"><div class="d1">${t.getFullYear()}年</div><div class="d2">${t.getMonth() + 1}月${t.getDate()}日<span>(${WD[t.getDay()]})</span></div>
    <div class="d3">今年の ${Math.ceil((t - new Date(t.getFullYear(), 0, 1)) / 86400000) + 1} 日目</div></div></div>`;
}
function tickClocks() {
  document.querySelectorAll("[data-clock]").forEach((el) => {
    const t = new Date();
    if (el.classList.contains("analog")) el.innerHTML = clockSVG();
    else el.innerHTML = `<div class="dig">${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}<span>:${String(t.getSeconds()).padStart(2, "0")}</span></div><div class="dig-sub">${t.getMonth() + 1}/${t.getDate()}(${WD[t.getDay()]})</div>`;
  });
}
setInterval(() => { if (state.view === "dash") tickClocks(); }, 1000);
function saveCustom(L) { saveDash({ order: L.order, hidden: L.hidden, full: L.full, custom: L.custom }); }
const cwSaveTimer = {};
function updateCustom(cid, fn, { rerender = true, delay = 0 } = {}) {
  const L = dashLayout();
  const c = L.custom.find((x) => x.id === cid); if (!c) return;
  fn(c);
  state.prefs = { ...state.prefs, dash: { ...L } };
  if (rerender) renderDash();
  clearTimeout(cwSaveTimer[cid]);
  cwSaveTimer[cid] = setTimeout(() => saveCustom(L), delay);
}
async function editMemo(cid) {
  const c = dashLayout().custom.find((x) => x.id === cid); if (!c) return;
  const r = await formSheet("メモを編集", `
    ${field("タイトル(空欄なら「メモ」)", `<input type="text" name="title" maxlength="40" value="${esc(c.title || "")}">`)}
    ${field("書き方", `<select name="md"><option value="0"${c.md ? "" : " selected"}>プレーンテキスト</option><option value="1"${c.md ? " selected" : ""}>Markdown(見出し・太字・リスト・リンクなど)</option></select>`)}
    ${field("内容", `<textarea name="text" rows="10" maxlength="10000" translate="no">${esc(c.text || "")}</textarea>`)}
    <p style="font-size:12px">Markdown の例: <code># 見出し</code> <code>**太字**</code> <code>- リスト</code> <code>- [ ] やること</code> <code>[リンク](https://…)</code></p>`, "保存");
  if (!r) return;
  updateCustom(cid, (x) => { x.title = r.title.trim(); x.md = r.md === "1"; x.text = r.text; });
}
async function addCustomWidget(type) {
  const L = dashLayout();
  if (L.custom.length >= 12) { toast("追加できるウィジェットは 12 個までです", true); return; }
  const id = "x" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  const c = { id, type, title: "" };
  if (type === "memo") Object.assign(c, { md: true, text: "" });
  if (type === "todo") c.items = [];
  if (type === "clock") c.style = "digital";
  L.custom.push(c);
  L.order = [id, ...L.order.filter((k) => k !== id)];
  await saveDash({ order: L.order, hidden: L.hidden, full: L.full, custom: L.custom });
  renderDash();
  if (type === "memo") editMemo(id);
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
  for (const c of L.custom) {
    const el = document.createElement("div"); el.className = `card cw cw-${c.type}`; el.innerHTML = customWidgetHTML(c); byId[c.id] = el;
  }
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
        <span class="wname">${esc(DASH_W.find((x) => x[0] === k)?.[1] || cwName(L.custom.find((c) => c.id === k)))}</span><span class="sp"></span>
        <button class="icon-btn sm" type="button" data-wa="up" title="前へ" aria-label="前へ">${icon("up")}</button>
        <button class="icon-btn sm" type="button" data-wa="down" title="後ろへ" aria-label="後ろへ">${icon("down")}</button>
        <button class="icon-btn sm" type="button" data-wa="size" title="${L.full.includes(k) ? "半分の幅にする" : "全幅にする"}" aria-label="幅を切り替え">${icon(L.full.includes(k) ? "shrink" : "expand")}</button>
        <button class="icon-btn sm" type="button" data-wa="hide" title="${L.hidden.includes(k) ? "表示する" : "非表示にする"}" aria-label="表示を切り替え">${icon(L.hidden.includes(k) ? "eyeoff" : "eye")}</button>
        ${k.startsWith("x") ? `<button class="icon-btn sm danger" type="button" data-wa="remove" title="このウィジェットを削除" aria-label="削除">${icon("trash")}</button>` : ""}</div>`);
    }
    w.appendChild(el);
    grid.appendChild(w);
  }
  dash.innerHTML = `<div class="dash-top"><span class="sp"></span>
    ${edit ? `<button class="btn small tinted" type="button" data-de="add">${icon("plus")}ウィジェットを追加</button><button class="btn small" type="button" data-de="reset">初期状態に戻す</button><button class="btn small filled" type="button" data-de="done">完了</button>`
      : `<button class="btn small" type="button" data-de="edit">${icon("edit")}ウィジェットを編集</button>`}</div>`;
  dash.appendChild(grid);
  tickClocks();
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
/* 追加ウィジェットの操作(編集中でなくても使う) */
$("#dash").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cw]"); if (!b || state.dashEdit) return;
  const cid = b.dataset.cid, a = b.dataset.cw;
  if (a === "memo-edit") editMemo(cid);
  if (a === "todo-toggle") updateCustom(cid, (c) => { c.items[Number(b.dataset.i)].d = b.checked; }, { delay: 600 });
  if (a === "todo-del") updateCustom(cid, (c) => { c.items.splice(Number(b.dataset.i), 1); });
  if (a === "todo-clear") updateCustom(cid, (c) => { c.items = c.items.filter((x) => !x.d); });
  if (a === "clock-style") updateCustom(cid, (c) => { c.style = c.style === "analog" ? "digital" : "analog"; });
});
$("#dash").addEventListener("submit", (e) => {
  const f = e.target.closest(".todo-add"); if (!f) return;
  e.preventDefault();
  const inp = f.querySelector("input"), t = inp.value.trim(); if (!t) return;
  const cid = f.dataset.cid;
  updateCustom(cid, (c) => { if ((c.items || []).length < 100) (c.items ||= []).push({ t, d: false }); });
  setTimeout(() => document.querySelector(`.todo-add[data-cid="${cid}"] input`)?.focus(), 0);
});
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
  if (de && de.dataset.de === "add") {
    openMenu(de, Object.entries(CW_TYPES).map(([t, [n, ic]]) => ({ label: n, icon: ic, run: () => addCustomWidget(t) })));
    return;
  }
  if (de) {
    if (de.dataset.de === "edit") state.dashEdit = true;
    if (de.dataset.de === "done") state.dashEdit = false;
    if (de.dataset.de === "reset") await saveDash({ ...DASH_DEFAULT, order: [...DASH_DEFAULT.order], custom: dashLayout().custom });
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
    if (wa.dataset.wa === "remove") {
      if (!cfm(`「${cwName(L.custom.find((c) => c.id === k))}」を削除しますか?`)) return;
      L.custom = L.custom.filter((c) => c.id !== k); L.order = L.order.filter((x) => x !== k);
    }
    await saveDash({ order: L.order, hidden: L.hidden, full: L.full, custom: L.custom }); renderDash(); return;
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
/* 一覧の行の右側(状態のバッジ・サーバー・配布元)。何も無ければ空文字 */
function trailOf(it, upd, missing, page) {
  const t = [missing ? '<span class="badge err">欠損</span>' : "",
    (it.missing_deps || []).length ? `<span class="badge err" title="足りない前提: ${esc(it.missing_deps.join(", "))}">前提が不足</span>` : "",
    upd ? `<span class="badge upd">更新 ${esc(it.source.latest.version || "")}</span>` : "",
    presenceBadge(it),
    page !== "" && page !== "#" ? `<a class="plink" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="${esc(it.source.provider_label)} の配布ページを開く">${providerBadge(it.source.provider, `${it.source.provider_label}(${SRC_STATUS[it.source.status] || ""})`)}</a>` : ""].join("").trim();
  return t ? `<span class="trail">${t}</span>` : "";
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
    else if (g === "storage") { if (can("storage")) openSettings("storage"); else gotoLibrary("all"); }
    return;
  }
  const b = e.target.closest("[data-dact]"); if (!b) return;
  const a = b.dataset.dact;
  if (a === "check") await busy(b, () => runUpdates({ check: true }), "開始しています…");
  if (a === "detect") await busy(b, () => runUpdates({ detect: true, check: true }), "開始しています…");
  if (a === "cleanup") openSettings("cleanup");
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
async function editSet(set, draft = null) {
  const chosen = draft ? draft.chosen : new Map((set ? set.items : []).map((x) => [x.item_id, x.version_id || ""]));
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const r = await sheet(`${sheetHead(set ? "セットを編集" : "セットを作成")}
    <div class="db">
      ${field("名前", `<input type="text" name="name" value="${esc(draft ? draft.name : set?.name || "")}" placeholder="例: サバイバル鯖一式">`)}
      ${field("メモ(任意)", `<input type="text" name="description" value="${esc(draft ? draft.description : set?.description || "")}">`)}
      <label class="search"><span>${icon("search")}</span><input type="search" id="setQ" placeholder="絞り込み"></label>
      <p style="font-size:12.5px;margin:4px 2px 8px">セットには、それぞれの<b>最新のバージョン</b>が入ります。</p>
      <div class="group scroll" id="setItems">${items.map((it) => {
        const pinned = chosen.get(it.id) ? it.versions.find((v) => String(v.id) === String(chosen.get(it.id))) : null;
        const page = it.source && safeUrl(it.source.page_url) !== "#" ? safeUrl(it.source.page_url) : "";
        return `<div class="setpick" data-name="${esc(it.name.toLowerCase())}" data-row="${it.id}">
          <input type="checkbox" class="cbox" id="si-${it.id}" data-item="${it.id}"${chosen.has(it.id) ? " checked" : ""}>
          ${itemIcon(it, true)}
          <div class="main"><label for="si-${it.id}" translate="no">${esc(it.name)}</label>
            <span class="sub">${esc(verLabel((it.versions.find((v) => v.id === it.latest_id) || it.versions[0]).version))}${platformOf(it) ? ` · ${esc(platShort(platformOf(it)))}` : ""}
              ${pinned ? `<span class="pinb" data-pin="${it.id}" title="押すと固定を外して最新にします">${esc(verLabel(pinned.version))} に固定中 ✕</span>` : ""}</span></div>
          ${page ? `<a class="icon-btn sm" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="配布ページで情報を見る" aria-label="配布ページで情報を見る">${icon("external")}</a>`
            : it.access !== "view" ? `<button class="btn plain small" type="button" data-assign="${it.id}" title="配布元(Modrinth / SpigotMC / CurseForge)を割り当てる">${icon("link")}割り当て</button>` : ""}
        </div>`;
      }).join("")}</div>
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
    $("#setQ", form).oninput = (ev) => { const q = ev.target.value.toLowerCase(); form.querySelectorAll(".setpick").forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); }); };
    form.addEventListener("click", (ev) => {
      const pin = ev.target.closest("[data-pin]");
      if (pin) { ev.preventDefault(); chosen.set(Number(pin.dataset.pin), ""); pin.remove(); return; }
      const as = ev.target.closest("[data-assign]");
      if (as) {  // 配布元の割り当て: 入力中の内容を覚えておき、検索で紐付けたあとセットの画面に戻る
        ev.preventDefault();
        const checked = new Set([...form.querySelectorAll("[data-item]:checked")].map((c) => Number(c.dataset.item)));
        for (const id of [...chosen.keys()]) if (!checked.has(id)) chosen.delete(id);
        for (const id of checked) if (!chosen.has(id)) chosen.set(id, "");
        done({ assign: Number(as.dataset.assign), draft: { chosen, name: form.querySelector("[name=name]").value, description: form.querySelector("[name=description]").value } });
      }
    });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const body = {
        name: form.querySelector("[name=name]").value, description: form.querySelector("[name=description]").value,
        items: [...form.querySelectorAll("[data-item]:checked")].map((c) => ({ item_id: Number(c.dataset.item), version_id: Number(chosen.get(Number(c.dataset.item))) || null })),
      };
      try {
        if (set) await api(`/api/sets/${set.id}`, { method: "PATCH", json: body }); else await api("/api/sets", { json: body });
        done(true);
      } catch (ex) { toast(ex.message, true); }
    });
  }, { wide: true });
  if (r && r.assign) {
    const it = state.items.find((i) => i.id === r.assign);
    if (it) { await openSearch({ q: it.name, kind: it.category, linkTo: it }); await refresh(); }
    return editSet(set, r.draft);
  }
  if (r) { toast("保存しました"); loadSets(); }
}

/* ---------------- サーバー(Pterodactyl) ---------------- */
async function loadServers() {
  try {
    const d = await api("/api/servers");
    state.servers = d.servers; state.pteroConfigured = d.configured; state.localOk = d.local_ok; state.dockerOk = d.docker;
  } catch (e) { $("#serversView").innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
  state.srvLive = state.srvLive || {};
  if (state.srvOpen && !state.servers.some((s) => s.id === state.srvOpen)) state.srvOpen = null;
  renderServers();
  for (const s of state.servers) loadLive(s.id);
}
/* 稼働状況・人数(一覧ではカードの右上、詳細では状態のパネルに出す) */
async function loadLive(id) {
  try { state.srvLive[id] = await api(`/api/servers/${id}/status`); } catch { state.srvLive[id] = { state: "unknown" }; }
  const srv = (state.servers || []).find((x) => x.id === id);
  if (!srv) return;
  document.querySelectorAll(`[data-sdot="${id}"]`).forEach((el) => { el.outerHTML = srvDot(id); });
  document.querySelectorAll(`[data-ssub="${id}"]`).forEach((el) => { el.textContent = srvSub(srv).replace(/&amp;/g, "&"); });
  if (state.srvOpen === id) {
    if ($("[data-livechip]")) $("[data-livechip]").innerHTML = liveStateChip(srv);
    if ($("#srvLivePanel")) $("#srvLivePanel").innerHTML = livePanel(srv);
  }
  const st = $(".sstats");
  if (st && state.view === "servers") {  // 上の集計(稼働・人数)も更新する
    const tmp = document.createElement("div"); tmp.innerHTML = srvListHTML(state.servers);
    st.replaceWith(tmp.querySelector(".sstats"));
  }
}
const STATE_LABEL = { running: ["ok", "稼働中"], offline: ["", "停止中"], starting: ["upd", "起動中"], stopping: ["upd", "停止処理中"], local: ["", "状態不明"], unknown: ["", "状態不明"] };
const stateBadge = (s) => { const [cl, l] = STATE_LABEL[s] || STATE_LABEL.unknown; return `<span class="badge ${cl}">${l}</span>`; };

/* ---------------- サーバーソフトと、種類ごとのフォルダ ---------------- */
const SRV_CATS = ["plugin", "mod", "datapack"];
const SRV_SOFT = { paper: "Paper", purpur: "Purpur", folia: "Folia", spigot: "Spigot", bukkit: "CraftBukkit", sponge: "Sponge",
  velocity: "Velocity", bungeecord: "BungeeCord", waterfall: "Waterfall", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" };
const SRV_SOFT_GROUPS = [["サーバー(プラグイン)", ["paper", "purpur", "folia", "spigot", "bukkit", "sponge"]],
  ["プロキシ", ["velocity", "bungeecord", "waterfall"]], ["Mod ローダー", ["fabric", "quilt", "forge", "neoforge"]]];
const SRV_DIR_HINT = { plugin: "plugins", mod: "mods", datapack: "world/datapacks" };
function defaultSrvDirs(soft, world = "world") {
  if (["velocity", "bungeecord", "waterfall"].includes(soft)) return { plugin: "plugins" };
  if (["fabric", "quilt", "forge", "neoforge"].includes(soft)) return { mod: "mods", datapack: `${world}/datapacks` };
  if (soft === "sponge") return { plugin: "plugins", mod: "mods", datapack: `${world}/datapacks` };
  return { plugin: "plugins", datapack: `${world}/datapacks` };
}
const softOptions = (sel) => `<option value="">わからない・指定しない</option>${SRV_SOFT_GROUPS.map(([g, ids]) =>
  `<optgroup label="${esc(g)}">${ids.map((id) => `<option value="${id}"${id === sel ? " selected" : ""}>${SRV_SOFT[id]}</option>`).join("")}</optgroup>`).join("")}`;
const dirsLabel = (s) => SRV_CATS.filter((c) => (s.dirs || {})[c]).map((c) => `${CATS[c]}: ${s.dirs[c]}`).join(" · ");

/* 追加・設定で共通の入力欄(サーバーソフト・フォルダ)。world はワールドのフォルダ名 */
const srvFields = (s = {}) => `
  ${field("サーバーソフト", `<select name="software">${softOptions(s.software || "")}</select>`)}
  <div class="group-title" style="margin:6px 4px 0">管理するフォルダ<small>(サーバーのフォルダから見た場所。空にすると管理しません)</small></div>
  <div class="group srv-dirs">${SRV_CATS.map((c) => `<label class="dir-row"><span class="cicon sm c-${c}">${catGlyph(c)}</span><span class="l">${CATS[c]}</span>
    <input type="text" name="dir_${c}" value="${esc((s.dirs || {})[c] || "")}" placeholder="${SRV_DIR_HINT[c]}" autocomplete="off" spellcheck="false"></label>`).join("")}</div>`;
function wireSrvFields(form, detectBody, onDetect = null) {
  let touched = false, world = "world";
  form.querySelectorAll(".srv-dirs input").forEach((i) => { i.oninput = () => { touched = true; }; });
  const setDirs = (dirs) => SRV_CATS.forEach((c) => { form.querySelector(`[name=dir_${c}]`).value = dirs[c] || ""; });
  form.querySelector("[name=software]").onchange = (e) => { if (!touched) setDirs(defaultSrvDirs(e.target.value, world)); };
  const out = form.querySelector("[data-dtout]");
  const detect = async (btn) => {
    const body = detectBody();
    if (!body) return;
    if (out) out.innerHTML = `<span class="spinner"></span> フォルダの中身を確認しています…`;
    try {
      const r = await api("/api/servers/detect", { json: body });
      world = r.world || "world";
      if (r.software) form.querySelector("[name=software]").value = r.software;
      setDirs(r.dirs); touched = false;
      if (onDetect) onDetect(r);
      if (out) out.innerHTML = r.software ? `${icon("check")}${esc(SRV_SOFT[r.software] || r.software)} と判定しました(ワールド: ${esc(world)})`
        : r.is_server ? `${icon("check")}サーバーソフトは判定できませんでした。フォルダは見つかったものを入れています`
          : `<span class="warn-t">サーバーのフォルダではないかもしれません(server.properties がありません)</span>`;
    } catch (ex) { if (out) out.innerHTML = `<span class="warn-t">${esc(ex.message)}</span>`; }
    return btn;
  };
  form.querySelector("[data-detect]")?.addEventListener("click", (ev) => busy(ev.currentTarget, () => detect(), "確認中…"));
  return { detect };
}
const readDirs = (form) => Object.fromEntries(SRV_CATS.map((c) => [c, form.querySelector(`[name=dir_${c}]`).value.trim()]).filter(([, v]) => v));

async function addServerMenu(btn) {
  const items = [
    state.pteroConfigured ? { label: "Pterodactyl のサーバーを連携", icon: "server", run: () => linkServerDialog() }
      : { label: "Pterodactyl を設定して連携", icon: "gear", run: () => (can("integrations") ? openSettings("ptero") : toast("Pterodactyl の設定は管理者に依頼してください", true)) },
    { label: "フォルダのサーバーを追加(このPC・NAS)", icon: "folder", run: () => (state.localOk ? localServerDialog() : toast("フォルダのサーバーは「パネル全体の設定」の権限がある人だけが追加できます", true)) },
  ];
  openMenu(btn, items);
}
async function linkServerDialog() {
  let ps;
  const tp = toastProgress("Pterodactyl からサーバーの一覧を取得しています…");
  try { ps = (await api("/api/ptero/servers")).servers; } catch (e) { toast(e.message, true); return; } finally { tp.remove(); }
  const avail = ps.filter((p) => !p.linked_id);
  if (!ps.length) { toast("Pterodactyl からサーバーが 1 台も返りませんでした。APIキー(ptlc_…)を作ったユーザーに、サーバーの所有者・サブユーザー・管理者のいずれかの権限があるか確認してください", true); return; }
  if (!avail.length) { toast(`すべてのサーバー(${ps.length} 台)を連携済みです`); return; }
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}`;
  const r = await sheet(`${sheetHead("Pterodactyl のサーバーを連携")}<div class="db">
      ${field("サーバー", `<select name="identifier">${avail.map((p) => `<option value="${esc(p.identifier)}">${esc(p.name)}(${esc(p.node)})</option>`).join("")}</select>`)}
      <div class="detect-out" data-dtout></div>
      ${srvFields({ dirs: defaultSrvDirs("") })}
      ${field("セット(任意。同期のときにセットの中身も入れる)", `<select name="set_id">${setOpts}</select>`)}
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>連携する</button></div>`, (form, done) => {
    const sel = form.querySelector("[name=identifier]");
    let mc = "";
    const { detect } = wireSrvFields(form, () => ({ identifier: sel.value }), (r) => { mc = r.mc || ""; });
    sel.onchange = () => detect(); detect();
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const dirs = readDirs(form);
      if (!Object.keys(dirs).length) { toast("管理するフォルダを 1 つ以上入力してください", true); return; }
      const body = { identifier: sel.value, name: (avail.find((p) => p.identifier === sel.value) || {}).name || sel.value,
        software: form.querySelector("[name=software]").value, dirs, set_id: form.querySelector("[name=set_id]").value, mc_version: mc };
      try { await api("/api/servers", { json: body }); done(true); } catch (ex) { toast(ex.message, true); }
    });
  });
  if (r) { toast("連携しました"); loadServers(); }
}
async function localServerDialog() {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}`;
  const r = await sheet(`${sheetHead("フォルダのサーバーを追加")}<div class="db">
      <p>このパネルから見えるフォルダにあるサーバー(同じ PC・NAS の共有フォルダなど)を、直接管理します。プラグイン・Mod・データパックの更新や同期ができます(起動・停止の操作はできません)。</p>
      ${field("サーバーのフォルダ(server.properties があるフォルダ)", `<div class="inline-input"><input type="text" name="root_dir" placeholder="例: /srv/minecraft/survival" autocomplete="off" spellcheck="false"><button class="btn tinted small" type="button" data-detect>${icon("search")}判定</button></div>`)}
      <div class="group-foot" style="margin-top:-6px">Docker で動かしている場合は、サーバーのフォルダをコンテナにマウントし、コンテナの中の場所(例: /servers/survival)を入力します。</div>
      <div class="detect-out" data-dtout></div>
      ${field("表示名", `<input type="text" name="name" placeholder="空ならフォルダの名前">`)}
      ${srvFields({ dirs: defaultSrvDirs("") })}
      ${field("セット(任意。同期のときにセットの中身も入れる)", `<select name="set_id">${setOpts}</select>`)}
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>追加する</button></div>`, (form, done) => {
    const root = form.querySelector("[name=root_dir]");
    let mc = "";
    const { detect } = wireSrvFields(form, () => (root.value.trim() ? { kind: "local", root_dir: root.value.trim() } : (toast("サーバーのフォルダを入力してください", true), null)), (r) => { mc = r.mc || ""; });
    root.onchange = () => { if (root.value.trim()) detect(); };
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const dirs = readDirs(form);
      if (!root.value.trim()) { toast("サーバーのフォルダを入力してください", true); return; }
      if (!Object.keys(dirs).length) { toast("管理するフォルダを 1 つ以上入力してください", true); return; }
      const body = { kind: "local", root_dir: root.value.trim(), name: form.querySelector("[name=name]").value.trim(),
        software: form.querySelector("[name=software]").value, dirs, set_id: form.querySelector("[name=set_id]").value, mc_version: mc };
      try { await api("/api/servers", { json: body }); done(true); } catch (ex) { toast(ex.message, true); }
    });
  });
  if (r) { toast("追加しました"); loadServers(); }
}
const DOW = ["月", "火", "水", "木", "金", "土", "日"];
const schedLabel = (s) => s.sched_mode === "daily" ? `毎日 ${s.sched_time}` : s.sched_mode === "weekly" ? `毎週${DOW[s.sched_dow] || ""}曜 ${s.sched_time}` : "なし";
const canPower = (s) => s.kind === "ptero" || (s.kind === "local" && ["command", "docker"].includes(s.control));
const srvSoftLabel = (s) => `${s.software ? esc(SRV_SOFT[s.software] || s.software) : ""}${s.mc_version || s.soft_info?.mc ? ` ${esc(s.mc_version || s.soft_info.mc)}` : ""}`.trim();
const srvUpdates = (s) => Object.values(s.summary || {}).reduce((n, c) => n + (c.outdated || 0), 0);
const srvFiles = (s) => Object.values(s.summary || {}).reduce((n, c) => n + (c.files || 0), 0);
/* 対応が必要か(一覧で上にまとめる) */
const srvNeeds = (s) => srvUpdates(s) > 0 || !!(s.soft_info || {}).update;
const wideSrv = () => matchMedia("(min-width: 900px)").matches;
/* タブの中身を出す場所: 指定があればそこへ、無ければシートで開く */
function host(container, title, html, setup, opts) {
  if (!container) return sheet(`${sheetHead(title)}${html}`, setup, opts);
  container.innerHTML = html;
  return new Promise((res) => setup(container, res));
}
function srvDot(id) {
  const l = (state.srvLive || {})[id];
  const cl = !l ? "wait" : l.state === "running" ? "ok" : ["starting", "stopping"].includes(l.state) ? "upd" : "";
  return `<span class="sdot ${cl}" data-sdot="${id}"></span>`;
}
function srvSub(s) {
  const l = (state.srvLive || {})[s.id];
  const st = !l ? "" : l.ping ? `${l.ping.players}/${l.ping.max}人` : l.state === "offline" ? "停止中" : l.state === "running" ? "稼働中" : "";
  return [srvSoftLabel(s) || (s.kind === "local" ? "フォルダ" : "Pterodactyl"), st].filter(Boolean).join(" · ");
}
function srvBadge(s) {
  const u = srvUpdates(s);
  if (u) return `<span class="spill warn">更新 ${u}</span>`;
  if ((s.soft_info || {}).update) return `<span class="spill acc">本体 新ビルド</span>`;
  if (s.checked) return `<span class="spill ok">最新</span>`;
  return "";
}
const srvRow = (s, sel = false) => `<button class="srow${sel ? " sel" : ""}" type="button" data-srvopen="${s.id}">
  ${srvDot(s.id)}<span class="m"><b translate="no">${esc(s.name)}</b><small data-ssub="${s.id}">${srvSub(s)}</small></span>${srvBadge(s)}${icon("chev")}</button>`;
/* 一覧(スマホ)・左の列(PC) */
function srvListHTML(list, selId = null) {
  const mine = list.filter((s) => !s.access || s.access === "owner"), shared = list.filter((s) => s.access && s.access !== "owner");
  const need = mine.filter(srvNeeds), ok = mine.filter((s) => !srvNeeds(s));
  const live = Object.values(state.srvLive || {});
  const running = list.filter((s) => ((state.srvLive || {})[s.id] || {}).state === "running").length;
  const players = live.reduce((n, l) => n + ((l && l.ping && l.ping.players) || 0), 0);
  const upd = list.reduce((n, s) => n + srvUpdates(s), 0);
  const group = (title, arr) => arr.length ? `<div class="sgrp">${title}</div><div class="slist">${arr.map((s) => srvRow(s, s.id === selId)).join("")}</div>` : "";
  const toSync = list.filter((s) => s.access !== "view" && srvUpdates(s) > 0);
  return `<div class="sstats"><div><small>稼働</small><b>${running}<i>/${list.length}</i></b></div><div><small>更新</small><b class="${upd ? "warn-t" : ""}">${upd}</b></div><div><small>人数</small><b>${players}</b></div></div>
    ${group(need.length ? "対応が必要" : "", need)}${group(need.length ? "問題なし" : "", ok)}${group(shared.length ? "共有されたサーバー" : "", shared)}
    ${toSync.length ? `<button class="sall" type="button" data-va="syncall">${icon("refresh")}<span class="m"><b>すべて最新にする</b><small>${toSync.length} 台・${toSync.reduce((n, s) => n + srvUpdates(s), 0)} 件</small></span><span class="btn small tinted">同期</span></button>` : ""}`;
}
function renderServers() {
  const list = state.servers || [];
  const view = $("#serversView");
  if (!list.length && !state.pteroConfigured && !state.localOk) {
    view.innerHTML = `<div class="card"><div class="empty"><div class="big">🦖</div>
      Pterodactyl と連携するか、このパネルから見えるフォルダのサーバーを追加すると、保管しているプラグイン・Mod・データパックをサーバーへ転送・同期できます。<br>
      ${can("integrations") ? `<button class="btn filled" type="button" data-va="setup" style="margin-top:12px">${icon("gear")}Pterodactyl を設定</button>` : "管理者に設定を依頼してください"}</div></div>`;
    return;
  }
  const head = `<div class="view-head srv-vh"><div class="chips">
      <button class="btn small${state.srvMode === "compare" ? " tinted" : ""}" type="button" data-mode="${state.srvMode === "compare" ? "list" : "compare"}">${icon(state.srvMode === "compare" ? "back" : "arrows")}${state.srvMode === "compare" ? "一覧に戻る" : "比較"}</button></div>
      <button class="btn filled need-editor" type="button" data-va="add">${icon("plus")}追加</button></div>`;
  if (state.srvMode === "compare") { view.innerHTML = `${head}<div id="srvBody"></div>`; renderCompare(); return; }
  if (!list.length) {
    view.innerHTML = `${head}<div class="card"><div class="empty"><div class="big">🖥️</div>まだサーバーがありません。「追加」から、Pterodactyl のサーバーか、このパネルから見えるフォルダのサーバーを追加できます</div></div>`;
    return;
  }
  let open = state.srvOpen && list.find((s) => s.id === state.srvOpen);
  document.body.classList.toggle("srv-detail", !!open && !wideSrv());  // スマホで詳細を開いている間は大きな見出しを隠す
  if (wideSrv()) {  // PC: 左に一覧、右に詳細
    open = open || list.find(srvNeeds) || list[0];
    state.srvOpen = open.id;
    view.innerHTML = `${head}<div class="srv-split"><aside class="srv-side">${srvListHTML(list, open.id)}</aside><div class="srv-main" id="srvMain"></div></div>`;
    renderServerPage(open, $("#srvMain"));
    return;
  }
  if (open) { view.innerHTML = `<div id="srvMain"></div>`; renderServerPage(open, $("#srvMain")); return; }
  view.innerHTML = `${head}${srvListHTML(list)}`;
}

/* ---------------- サーバーの詳細(概要・アドオン・保存・設定) ---------------- */
function livePanel(s) {
  const l = (state.srvLive || {})[s.id];
  if (!l) return `<div class="live-wait"><span class="spinner"></span> 状態を確認しています…</div>`;
  const p = l.ping;
  const kv = (k, v) => `<div class="lv"><span>${k}</span><b>${v}</b></div>`;
  const mem = l.memory ? `${(l.memory / 1024 ** 3).toFixed(1)} GB` : "";
  return `${p ? `<div class="live-grid">
        ${kv("人数", `${p.players}<small>/${p.max}</small>`)}
        ${kv("応答", `${p.latency}<small>ms</small>`)}
        ${kv("MC", `<span translate="no">${esc(s.mc_version || mcFromName(p.version) || "-")}</span>`)}
        ${l.cpu != null ? kv("CPU", `${Math.round(l.cpu)}<small>%</small>`) : ""}${mem ? kv("メモリ", mem) : ""}
      </div>
      ${p.sample && p.sample.length ? `<div class="live-players">${icon("users")}<span translate="no">${p.sample.map(esc).join("、")}</span></div>` : ""}`
    : `<div class="muted live-note">${l.address ? `人数を確認できませんでした(${esc(l.ping_error || "応答なし")})` : "「設定」でサーバーのアドレスを入れると、人数やバージョンを表示します"}</div>`}
    ${l.mc_detected && !s.mc_version ? `<button class="btn plain small" type="button" data-va="setmc" data-mc="${esc(l.mc_detected)}">${icon("check")}MC ${esc(l.mc_detected)} をこのサーバーのバージョンにする</button>` : ""}`;
}
const mcFromName = (n) => (String(n || "").match(/(?:^|\s)(1\.\d{1,2}(?:\.\d{1,2})?|2\d\.\d{1,2}(?:\.\d{1,2})?)(?![\d.])/) || [])[1] || "";
function liveStateChip(s) {
  const l = (state.srvLive || {})[s.id];
  if (!l) return `<span class="spill"><span class="spinner"></span></span>`;
  const [cl, label] = STATE_LABEL[l.state] || STATE_LABEL.unknown;
  return `<span class="spill ${cl === "ok" ? "ok" : cl === "upd" ? "warn" : ""}">● ${label}</span>`;
}
/* 今やること(無ければ「すべて最新」) */
function todoList(s) {
  const ro = s.access === "view", si = s.soft_info || {}, out = [];
  const row = (ic, cls, title, sub, btn) => `<div class="stodo"><span class="ti-ic ${cls}">${icon(ic)}</span><span class="m">${title}${sub ? `<small>${sub}</small>` : ""}</span>${btn || ""}</div>`;
  const u = srvUpdates(s);
  if (!s.checked) out.push(row("search", "", "中身をまだ確認していません", "アドオンのタブで確認します", `<button class="btn small" type="button" data-tab2="addons">確認</button>`));
  if (u) out.push(row("download", "warn", `${u} 件の更新があります`, s.mc_version ? `MC ${esc(s.mc_version)} に対応していない版は入れません` : "", ro ? "" : `<button class="btn small filled" type="button" data-va="sync">同期</button>`));
  if (si.update) out.push(row("server", "acc", `本体 #${esc(si.latest.build)} が出ています`, si.build ? `今は #${esc(si.build)}` : "", si.latest.url ? `<a class="btn small" href="${esc(si.latest.url)}" target="_blank" rel="noopener">取得</a>` : ""));
  const targets = (s.stage_targets || []).map((id) => (state.servers.find((x) => x.id === id) || {}).name).filter(Boolean);
  if (targets.length && !ro) out.push(row("arrows", "", "検証した構成を本番へ広げる", `${targets.map(esc).join("、")} へ`, `<button class="btn small" type="button" data-va="copy">反映</button>`));
  const old = !s.last_world || (Date.now() - Date.parse(s.last_world)) > 7 * 864e5;
  if (old && !ro) out.push(row("folder", "", s.last_world ? `ワールドの保存が ${Math.floor((Date.now() - Date.parse(s.last_world)) / 864e5)} 日前です` : "ワールドをまだ保存していません", s.world_mode === "off" ? "予約なし" : "", `<button class="btn small" type="button" data-tab2="backup">保存</button>`));
  return out.length ? out.join("") : `<div class="stodo"><span class="ti-ic ok">${icon("check")}</span><span class="m">すべて最新です<small>やることはありません</small></span></div>`;
}
function renderServerPage(s, el) {
  const ro = s.access === "view", owner = !s.access || s.access === "owner";
  const tab = state.srvTab || "overview";
  const tabs = [["overview", "概要"], ["addons", `アドオン${srvFiles(s) ? ` ${srvFiles(s)}` : ""}`], ["backup", "保存"], ...(ro ? [] : [["settings", "設定"]])];
  el.innerHTML = `<div class="srv-page" data-srv="${s.id}">
    ${wideSrv() ? "" : `<button class="btn plain small srv-back" type="button" data-va="back">${icon("back")}サーバー</button>`}
    <div class="srv-hero"><div class="m"><h3 translate="no">${esc(s.name)}</h3><small>${[srvSoftLabel(s), s.kind === "local" ? "フォルダ" : "Pterodactyl", !owner ? `${esc(s.owner_name)} さんが共有` : ""].filter(Boolean).join(" · ")}</small></div>
      <span data-livechip>${liveStateChip(s)}</span></div>
    <div class="segmented seg-wide srv-tabs" role="tablist">${tabs.map(([k, n]) => `<button class="seg" type="button" role="tab" data-tab2="${k}" aria-pressed="${k === tab}">${n}</button>`).join("")}</div>
    <div class="srv-pane" id="srvPane"></div></div>`;
  const pane = $("#srvPane", el);
  if (tab === "overview") {
    pane.innerHTML = `<div id="srvLivePanel">${livePanel(s)}</div>
      <div class="sgrp">やること</div><div class="slist stodo-list">${todoList(s)}</div>
      ${!ro ? `<div class="srv-quick">
        <button class="btn small" type="button" data-va="push">${icon("send")}転送</button>
        <button class="btn small" type="button" data-va="copy">${icon("arrows")}${(s.stage_targets || []).length ? "本番へ反映" : "構成をコピー"}</button>
        ${owner ? `<button class="btn small" type="button" data-va="share">${icon("users")}共有${(s.shared_with || []).length ? ` ${s.shared_with.length}` : ""}</button>` : ""}</div>` : ""}
      ${s.software ? `<div class="sgrp">サーバー本体</div><div class="slist pad" id="srvSoft">${softPanel(s, s.soft_info || {})}</div>` : ""}
      <div class="sgrp">情報</div><div class="slist pad">
        <div class="kv"><span>セット</span><span>${s.set_name ? esc(s.set_name) : "なし"}</span></div>
        <div class="kv"><span>自動更新</span><span>${s.auto_update === "auto" ? "オン" : "オフ"}</span></div>
        <div class="kv"><span>予約同期</span><span>${esc(schedLabel(s))}</span></div>
        <div class="kv"><span>最後の同期</span><span>${s.last_sync ? esc(fmtDateTime(s.last_sync)) : "-"}</span></div>
        <div class="kv"><span>フォルダ</span><span translate="no">${esc(dirsLabel(s))}</span></div>
        ${s.kind === "local" ? `<div class="kv"><span>場所</span><span translate="no" class="mono">${esc(s.root_dir || "")}</span></div>` : ""}</div>
      ${!ro && canPower(s) ? `<div class="pw-bar">
        <button class="btn" type="button" data-pw="start">${icon("play")}起動</button>
        <button class="btn" type="button" data-pw="stop">${icon("stop")}停止</button>
        <button class="btn" type="button" data-pw="restart">${icon("refresh")}再起動</button></div>` : ""}`;
    if (!(s.soft_info || {}).checked_at && s.software) refreshSoft(s, false);
  } else if (tab === "addons") {
    inventoryDialog(s, state.srvCat || "all", pane);
  } else if (tab === "backup") {
    pane.innerHTML = `<div class="sgrp">ワールドのバックアップ</div><div id="paneWorlds"></div><div class="sgrp">履歴と巻き戻し</div><div id="paneHist"></div>`;
    worldsDialog(s, $("#paneWorlds", pane)); snapshotsDialog(s, $("#paneHist", pane));
  } else if (tab === "settings") {
    serverSettingsDialog(s, pane);
  }
  clearInterval(state.srvLiveTimer);
  state.srvLiveTimer = setInterval(() => { if (state.view === "servers" && state.srvOpen === s.id && !document.hidden) loadLive(s.id); else clearInterval(state.srvLiveTimer); }, 20000);
}
function softPanel(s, si) {
  if (!si.checked_at) return `<div class="live-wait"><span class="spinner"></span> 確認しています…</div>`;
  const name = SRV_SOFT[s.software] || s.software;
  return `<div class="kv"><span>今のビルド</span><span translate="no">${esc(name)} ${esc(si.mc || "")}${si.build ? ` #${esc(si.build)}` : "(わかりません)"}</span></div>
    ${si.latest ? `<div class="kv"><span>最新のビルド</span><span translate="no">#${esc(si.latest.build)}${si.update ? ' <span class="spill acc">新しいビルド</span>' : si.build ? ' <span class="spill ok">最新</span>' : ""}</span></div>` : ""}
    ${si.newer_mc ? `<div class="kv"><span>新しい MC</span><span translate="no">${esc(name)} は ${esc(si.newer_mc)} まで出ています</span></div>` : ""}
    ${si.error ? `<div class="result warn">${esc(si.error)}</div>` : ""}
    <div class="chips" style="margin-top:6px">${si.latest && si.latest.url ? `<a class="btn small tinted" href="${esc(si.latest.url)}" target="_blank" rel="noopener">${icon("download")}${si.latest.file ? "最新のビルドをダウンロード" : "配布ページを開く"}</a>` : ""}
      <button class="btn small plain" type="button" data-va="softcheck">${icon("refresh")}今すぐ確認</button></div>
    <div class="qfoot">入れ替えは、サーバーを止めてから jar を置き換えてください。確認: ${esc(fmtDateTime(si.checked_at))}</div>`;
}
async function refreshSoft(s, force) {
  try {
    s.soft_info = await api(`/api/servers/${s.id}/software${force ? "?refresh=1" : ""}`);
    if ($("#srvSoft") && state.srvOpen === s.id) $("#srvSoft").innerHTML = softPanel(s, s.soft_info);
  } catch (ex) { if (force) toast(ex.message, true); }
}
async function powerAction(s, signal) {
  const label = { start: "起動", stop: "停止", restart: "再起動" }[signal];
  if (signal !== "start" && !await confirmSheet(`「${s.name}」を${label}しますか?`, "プレイ中のプレイヤーは切断されます。", label)) return;
  try {
    const r = await api(`/api/servers/${s.id}/power`, { json: { signal } });
    if (r.job) jobStarted(r.job); else toast(`${label}しました`);
    setTimeout(() => loadLive(s.id), 4000);
  } catch (ex) { toast(ex.message, true); }
}
async function syncDialog(s) {
  const r = await formSheet(`「${s.name}」を同期`, `<p>ライブラリに新しいバージョンがあるものを、サーバーの ${esc(dirsLabel(s))} で入れ替えます${s.set_name ? `。セット「${esc(s.set_name)}」にあってサーバーに無いものも入れます` : ""}。</p>
    <ul class="plain-list">
      <li>${icon("check")}置き換えるファイル${s.backup_config ? "とプラグインの設定フォルダ" : ""}は退避され、「保存」タブの履歴から戻せます</li>
      ${s.mc_version ? `<li>${icon("check")}MC ${esc(s.mc_version)} に対応していない版は入れません</li>` : `<li>${icon("clock")}「設定」で MC のバージョンを入れると、対応していない版を入れないようにできます</li>`}
      ${s.holds ? `<li>${icon("clock")}見送り中の ${s.holds} 件は入れ替えません</li>` : ""}
    </ul>
    ${canPower(s) ? `<div class="group">${toggle("restart", "完了後にサーバーを再起動", "入れ替えを反映させるには再起動が必要です", false)}</div>` : `<p class="muted">このサーバーはパネルから再起動できません。反映するにはサーバーを再起動してください。</p>`}`, "同期する");
  if (!r) return;
  try { jobStarted(await api(`/api/servers/${s.id}/sync`, { json: { restart: !!r.restart } })); } catch (ex) { toast(ex.message, true); }
}

matchMedia("(min-width: 900px)").addEventListener("change", () => { if (state.view === "servers" && state.servers) renderServers(); });
$("#serversView").addEventListener("click", async (e) => {
  const md = e.target.closest("[data-mode]");
  if (md) { state.srvMode = md.dataset.mode; renderServers(); if (state.srvMode === "list") loadServers(); return; }
  const op = e.target.closest("[data-srvopen]");
  if (op) { state.srvOpen = Number(op.dataset.srvopen); state.srvTab = "overview"; renderServers(); if (!wideSrv()) window.scrollTo({ top: 0 }); loadLive(state.srvOpen); return; }
  const sid = Number(e.target.closest("[data-srv]")?.dataset.srv);
  const s = (state.servers || []).find((x) => x.id === sid);
  const tb = e.target.closest("[data-tab2]");
  if (tb && s) { state.srvTab = tb.dataset.tab2; renderServerPage(s, $("#srvMain")); return; }
  const pw = e.target.closest("[data-pw]");
  if (pw && s) { powerAction(s, pw.dataset.pw); return; }
  const b = e.target.closest("[data-va]"); if (!b) return;
  const a = b.dataset.va;
  if (a === "setup") openSettings("ptero");
  if (a === "add") addServerMenu(b);
  if (a === "syncall") {
    const targets = (state.servers || []).filter((x) => x.access !== "view" && srvUpdates(x) > 0);
    if (!await confirmSheet("すべて最新にしますか?", `${targets.map((x) => x.name).join("、")} を同期します。対応していない版・見送り中のものは入れません。再起動はしません。`, "同期する", false)) return;
    for (const x of targets) { try { jobStarted(await api(`/api/servers/${x.id}/sync`, { json: {} })); } catch (ex) { toast(`${x.name}: ${ex.message}`, true); } }
    return;
  }
  if (!s) return;
  if (a === "back") { state.srvOpen = null; clearInterval(state.srvLiveTimer); renderServers(); }
  if (a === "softcheck") { if ($("#srvSoft")) $("#srvSoft").innerHTML = `<div class="live-wait"><span class="spinner"></span> 確認しています…</div>`; refreshSoft(s, true); }
  if (a === "setmc") { try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: { mc_version: b.dataset.mc } }); toast("保存しました"); loadServers(); } catch (ex) { toast(ex.message, true); } }
  if (a === "push") pushDialog({ server: s });
  if (a === "copy") copyDialog(s);
  if (a === "share") aclDialog("server", s);
  if (a === "sync") syncDialog(s);
});

/* 構成をコピー・本番へ反映 */
async function copyDialog(s) {
  const others = (state.servers || []).filter((x) => x.id !== s.id && x.access !== "view");
  if (!others.length) { toast("コピー先にできるサーバーがありません", true); return; }
  const staged = new Set(s.stage_targets || []);
  const modes = [["update", "更新だけ", "コピー先にあるアドオンだけ、このサーバーと同じバージョンにします(おすすめ)"],
    ["add", "足りないものも入れる", "このサーバーにあって、コピー先に無いものも入れます"],
    ["mirror", "まったく同じにする", "さらに、このサーバーに無い登録済みのアドオンをコピー先から取り除きます(退避されるので巻き戻せます)"]];
  const r = await sheet(`${sheetHead(staged.size ? "本番へ反映" : "構成をコピー")}<div class="db">
      <p>「${esc(s.name)}」に入っているアドオン(ライブラリにあるもの)を、ほかのサーバーへそろえます。${staged.size ? "検証用サーバーで試した構成を、本番のサーバーへ広げるのに使います。" : ""}</p>
      <div class="group-title">コピー先</div>
      <div class="group">${others.map((x) => `<label class="toggle-row"><span class="cicon sm c-teal">${icon(x.kind === "local" ? "folder" : "server")}</span>
        <span class="main" translate="no">${esc(x.name)}<small>${esc(dirsLabel(x))}</small></span>
        <input type="checkbox" class="switch" data-tg="${x.id}"${staged.size ? (staged.has(x.id) ? " checked" : "") : others.length === 1 ? " checked" : ""}></label>`).join("")}</div>
      <div class="group-title">そろえ方</div>
      <div class="group">${modes.map(([k, t, d], i) => `<label class="toggle-row"><span class="main">${t}<small>${d}</small></span><input type="radio" class="switch" name="mode" value="${k}"${i === 0 ? " checked" : ""}></label>`).join("")}</div>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>そろえる</button></div>`, (form, done) => {
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const targets = [...form.querySelectorAll("[data-tg]:checked")].map((c) => Number(c.dataset.tg));
      if (!targets.length) { toast("コピー先を選んでください", true); return; }
      const mode = form.querySelector("[name=mode]:checked").value;
      if (mode === "mirror" && !cfm("コピー先から、このサーバーに無いアドオンを取り除きます。よろしいですか?")) return;
      try { jobStarted(await api(`/api/servers/${s.id}/copy`, { json: { targets, mode } })); done(true); } catch (ex) { toast(ex.message, true); }
    });
  });
  if (r) loadServers();
}

/* ワールドのバックアップ */
async function worldsDialog(s, container = null) {
  const ro = s.access === "view";
  await host(container, `「${s.name}」のワールド`, `<div class="db" id="wbBody"><div class="empty"><span class="spinner lg"></span></div></div>`, async (form) => {
    const body = $("#wbBody", form);
    const load = async () => {
      let d;
      try { d = await api(`/api/servers/${s.id}/worlds`); } catch (ex) { body.innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
      body.innerHTML = `<p>ワールド(ネザー・エンドを含む)をまとめて、保存先「${esc(d.storage)}」に保存します。新しいものから ${d.keep} 個を残します。${s.has_rcon ? "RCON で書き込みを止めてから保存します。" : "RCON を設定すると、書き込みを止めてから保存するので安全です。"}</p>
        ${ro ? "" : `<button class="btn filled block" type="button" data-wb="now">${icon("download")}今すぐバックアップ</button>`}
        <div class="group-title">保存したもの</div>
        <div class="group">${d.backups.map((x) => `<div class="row noicon"><span class="main"><span class="title" translate="no">${esc(x.name)}</span></span>
          <span class="trail"><a class="icon-btn sm" href="/api/servers/${s.id}/worlds/${encodeURIComponent(x.name)}" download title="ダウンロード" aria-label="ダウンロード">${icon("download")}</a>
          ${ro ? "" : `<button class="icon-btn sm danger" type="button" data-wdel="${esc(x.name)}" title="削除" aria-label="削除">${icon("trash")}</button>`}</span></div>`).join("") || `<div class="empty">まだありません</div>`}</div>
        <div class="group-foot">定期的なバックアップは「設定」→「ワールドのバックアップ」で設定できます。</div>`;
    };
    body.addEventListener("click", async (e) => {
      const now = e.target.closest("[data-wb]");
      if (now) {
        await busy(now, async () => {
          try { const j = await api(`/api/servers/${s.id}/worlds`, { method: "POST" }); jobStarted(j); const r = await waitJob(j.id); if (r && r.status === "done") toast("ワールドを保存しました"); else if (r) toast((r.log || []).slice(-1)[0] || "保存できませんでした", true); await load(); }
          catch (ex) { toast(ex.message, true); }
        }, "保存中…");
      }
      const del = e.target.closest("[data-wdel]");
      if (del && cfm(`${del.dataset.wdel} を削除しますか?`)) {
        try { await api(`/api/servers/${s.id}/worlds/${encodeURIComponent(del.dataset.wdel)}`, { method: "DELETE" }); toast("削除しました"); await load(); } catch (ex) { toast(ex.message, true); }
      }
    });
    await load();
  }, { wide: true });
}

/* 設定(グループごと) */
async function serverSettingsDialog(s, container = null) {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const local = s.kind === "local", sys_ = can("system");
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}"${x.id === s.set_id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}`;
  const others = (state.servers || []).filter((x) => x.id !== s.id && x.access !== "view");
  const timeRow = (prefix, mode, dow, time) => `<div class="chips" data-${prefix}row>
      <select name="${prefix}_dow" class="compact">${DOW.map((d, i) => `<option value="${i}"${Number(dow) === i ? " selected" : ""}>${d}曜日</option>`).join("")}</select>
      <input type="time" name="${prefix}_time" value="${esc(time || "04:00")}" class="compact-time"></div>`;
  const sec = (id, title, html, open = false) => `<details class="set-sec"${open ? " open" : ""} data-sec="${id}"><summary>${title}${icon("chev")}</summary><div class="set-sec-b">${html}</div></details>`;
  const r = await host(container, `「${s.name}」の設定`, `<div class="db srv-settings">
      ${sec("basic", "基本", `
        ${field("表示名", `<input type="text" name="name" value="${esc(s.name)}">`)}
        ${local ? field("サーバーのフォルダ", `<div class="inline-input"><input type="text" name="root_dir" value="${esc(s.root_dir || "")}"${sys_ ? "" : " readonly"} spellcheck="false"><button class="btn tinted small" type="button" data-detect>${icon("search")}判定</button></div>`)
          : `<div class="inline-input" style="margin-bottom:10px"><span class="muted" style="flex:1">サーバーのフォルダの中身から、サーバーソフト・バージョン・フォルダを判定できます</span><button class="btn tinted small" type="button" data-detect>${icon("search")}判定</button></div>`}
        <div class="detect-out" data-dtout></div>
        ${field("MC のバージョン(対応していない版を入れないために使います)", `<input type="text" name="mc_version" value="${esc(s.mc_version || "")}" placeholder="例: 1.21.4" inputmode="decimal">`)}
        ${srvFields(s)}
        ${field("セット(同期のときに、セットの中身もサーバーに入れる)", `<select name="set_id">${setOpts}</select>`)}`, true)}
      ${sec("update", "更新の受け取り方", `
        <div class="group">
          ${toggle("auto_update", "自動で最新にする", "ライブラリに新しい版が入ったら、このサーバーへ自動で同期します(6 時間ごとに確認。見送り中・対応していない版は入れません)", s.auto_update === "auto")}
          ${toggle("backup_config", "プラグインの設定フォルダも退避する", "入れ替えるときに plugins/<名前>/ も保存し、巻き戻しで設定まで戻せるようにします", !!s.backup_config)}
          ${canPower(s) ? toggle("sched_restart", "自動・予約の同期のあとに再起動", "更新があったときだけ再起動します", !!s.sched_restart) : ""}
        </div>
        ${field("予約同期(決まった時刻に同期)", `<select name="sched_mode"><option value="off"${s.sched_mode === "off" ? " selected" : ""}>しない</option><option value="daily"${s.sched_mode === "daily" ? " selected" : ""}>毎日</option><option value="weekly"${s.sched_mode === "weekly" ? " selected" : ""}>毎週</option></select>`)}
        ${timeRow("sched", s.sched_mode, s.sched_dow, s.sched_time)}`)}
      ${sec("status", "状態・RCON", `
        <p class="muted">アドレスを入れると、稼働状況・人数・バージョンを表示します${s.kind === "ptero" ? "(空なら Pterodactyl の割り当てを使います)" : "(空ならこの PC の server-port に問い合わせます)"}。RCON を設定すると、ワールドの保存の前に書き込みを止めたり、停止に使ったりできます。</p>
        ${field("サーバーのアドレス", `<input type="text" name="address" value="${esc(s.address || "")}" placeholder="例: play.example.com:25565" autocomplete="off" spellcheck="false">`)}
        <div class="two-col">${field("RCON のポート", `<input type="number" name="rcon_port" value="${s.rcon_port || ""}" placeholder="25575" min="1" max="65535">`)}
        ${field(`RCON のパスワード${s.has_rcon ? "(設定済み)" : ""}`, `<input type="password" name="rcon_password" placeholder="${s.has_rcon ? "変えるときだけ入力" : "server.properties の rcon.password"}" autocomplete="new-password">`)}</div>
        <div class="chips"><button class="btn small tinted" type="button" data-rcontest>${icon("check")}RCON を試す</button>${s.has_rcon ? `<button class="btn small plain" type="button" data-rconclear>RCON の設定を消す</button>` : ""}</div>`)}
      ${local ? sec("power", "起動・停止", sys_ ? `
        <p class="muted">このパネルからサーバーを起動・停止する方法を選びます(設定できるのは「パネル全体の設定」の権限がある人だけです)。</p>
        ${field("方法", `<select name="control"><option value="none"${s.control === "none" ? " selected" : ""}>しない</option><option value="command"${s.control === "command" ? " selected" : ""}>コマンドを実行する</option><option value="docker"${s.control === "docker" ? " selected" : ""}>Docker のコンテナを操作する</option></select>`)}
        <div data-ctl="command">
          ${field("起動のコマンド(サーバーのフォルダで実行)", `<input type="text" name="start_cmd" value="${esc(s.start_cmd || "")}" placeholder="例: systemctl start minecraft / ./start.sh" spellcheck="false">`)}
          ${field("停止のコマンド(空なら RCON の stop)", `<input type="text" name="stop_cmd" value="${esc(s.stop_cmd || "")}" placeholder="例: systemctl stop minecraft" spellcheck="false">`)}
        </div>
        <div data-ctl="docker">
          ${field("コンテナ名", `<input type="text" name="container" value="${esc(s.container || "")}" placeholder="例: minecraft" spellcheck="false">`)}
          ${state.dockerOk ? "" : `<div class="result warn">Docker を操作するには、CraftShelf のコンテナに /var/run/docker.sock をマウントしてください</div>`}
        </div>` : `<p class="muted">起動・停止の方法は、「パネル全体の設定」の権限がある人が設定できます。</p>`) : ""}
      ${sec("world", "ワールドのバックアップ", `
        ${field("定期的に保存", `<select name="world_mode"><option value="off"${s.world_mode === "off" ? " selected" : ""}>しない</option><option value="daily"${s.world_mode === "daily" ? " selected" : ""}>毎日</option><option value="weekly"${s.world_mode === "weekly" ? " selected" : ""}>毎週</option></select>`)}
        ${timeRow("world", s.world_mode, s.world_dow, s.world_time || "05:00")}
        ${field("残す数", `<input type="number" name="world_keep" value="${s.world_keep || 5}" min="1" max="50">`)}`)}
      ${others.length ? sec("stage", "検証用サーバー", `
        <p class="muted">このサーバーで先に試し、問題なければ「本番へ反映」でほかのサーバーへ広げます。反映先(本番)を選んでください。</p>
        <div class="group">${others.map((x) => `<label class="toggle-row"><span class="main" translate="no">${esc(x.name)}</span><input type="checkbox" class="switch" data-stg="${x.id}"${(s.stage_targets || []).includes(x.id) ? " checked" : ""}></label>`).join("")}</div>`) : ""}
      <button class="btn danger block" type="button" data-unlink>${local ? "このサーバーを一覧から外す" : "連携を解除"}</button>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    const q = (n) => form.querySelector(`[name=${n}]`);
    const syncRows = () => {
      for (const p of ["sched", "world"]) {
        const m = q(`${p}_mode`).value, row = form.querySelector(`[data-${p}row]`);
        row.hidden = m === "off"; q(`${p}_dow`).hidden = m !== "weekly";
      }
      const ctl = q("control");
      if (ctl) form.querySelectorAll("[data-ctl]").forEach((el) => { el.hidden = el.dataset.ctl !== ctl.value; });
    };
    form.addEventListener("change", syncRows); syncRows();
    wireSrvFields(form, () => (local ? { kind: "local", root_dir: q("root_dir").value.trim() } : { server_id: s.id }), (r) => { if (r.mc && !q("mc_version").value) q("mc_version").value = r.mc; });
    form.querySelector("[data-rcontest]").onclick = (ev) => busy(ev.currentTarget, async () => {
      try {
        if (q("rcon_password").value || Number(q("rcon_port").value) !== (s.rcon_port || 0)) {
          await api(`/api/servers/${s.id}`, { method: "PATCH", json: { rcon_port: Number(q("rcon_port").value || 0), rcon_password: q("rcon_password").value, address: q("address").value.trim() } });
        }
        const r = await api(`/api/servers/${s.id}/rcon`, { method: "POST" });
        toast(`つながりました: ${r.message}`);
      } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-rconclear]")?.addEventListener("click", async () => {
      try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: { rcon_clear: true } }); toast("RCON の設定を消しました"); done("saved"); } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const d = { name: q("name").value, set_id: q("set_id").value, mc_version: q("mc_version").value.trim(), address: q("address").value.trim(),
        rcon_port: Number(q("rcon_port").value || 0), software: q("software").value, dirs: readDirs(form),
        sched_mode: q("sched_mode").value, sched_time: q("sched_time").value, sched_dow: Number(q("sched_dow").value || 0),
        auto_update: form.querySelector("[name=auto_update]").checked ? "auto" : "off", backup_config: form.querySelector("[name=backup_config]").checked,
        world_mode: q("world_mode").value, world_time: q("world_time").value, world_dow: Number(q("world_dow").value || 0), world_keep: Number(q("world_keep").value || 5) };
      if (q("rcon_password").value) d.rcon_password = q("rcon_password").value;
      if (form.querySelector("[name=sched_restart]")) d.sched_restart = form.querySelector("[name=sched_restart]").checked;
      if (others.length) d.stage_targets = [...form.querySelectorAll("[data-stg]:checked")].map((c) => Number(c.dataset.stg));
      if (local && sys_) {
        if (q("root_dir").value.trim() !== (s.root_dir || "")) d.root_dir = q("root_dir").value.trim();
        if (q("control")) { d.control = q("control").value; d.start_cmd = q("start_cmd").value; d.stop_cmd = q("stop_cmd").value; d.container = q("container").value; }
      }
      if (JSON.stringify(d.dirs) === JSON.stringify(Object.fromEntries(SRV_CATS.filter((c) => (s.dirs || {})[c]).map((c) => [c, s.dirs[c]])))) delete d.dirs;
      if (d.auto_update === "auto" && (s.staged_from || []).length && !cfm("このサーバーは検証用サーバーからの反映先です。自動更新をオンにすると、検証の前に更新されます。よろしいですか?")) return;
      try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: d }); done("saved"); } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-unlink]").onclick = async (ev) => {
      if (!cfm(`「${s.name}」を一覧から外しますか?(サーバーのファイルはそのままです)`)) return;
      await busy(ev.currentTarget, async () => { try { await api(`/api/servers/${s.id}`, { method: "DELETE" }); done("deleted"); } catch (ex) { toast(ex.message, true); } });
    };
  }, { wide: true });
  if (r) { toast(r === "deleted" ? "一覧から外しました" : "保存しました"); if (r === "deleted") state.srvOpen = null; loadServers(); }
}
async function snapshotsDialog(s, container = null) {
  await host(container, `「${s.name}」の履歴`, `<div class="db" id="snBody"><div class="empty"><span class="spinner lg"></span></div></div>`, async (form, done) => {
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
        <div class="cmp-sub">${d.error ? esc(d.error) : `${(d.files || []).length} 個 · ${esc(dirsLabel(s))}`}</div>
        ${d.files && d.files.some((f) => f.status === "outdated") ? `<span class="badge upd">更新あり ${d.files.filter((f) => f.status === "outdated").length}</span>` : d.error ? "" : '<span class="badge ok">最新</span>'}</div></th>`;
    }).join("")}</tr></thead>
    <tbody>${list.map((r) => `<tr class="${differs(r) ? "diff" : ""}"><th class="cmp-name">${r.item_id ? `<button class="linkish" type="button" data-open="${r.item_id}">${esc(r.name)}</button>` : esc(r.name)}</th>${sel.map((s) => cell(r.cells[s.id], r)).join("")}</tr>`).join("")
      || `<tr><td colspan="${sel.length + 1}"><div class="empty">${state.cmpDiff ? "違いはありません 🎉" : "プラグインがありません"}</div></td></tr>`}</tbody>
  </table></div>`;
  box.onclick = (e) => { const o = e.target.closest("[data-open]"); if (o) openPanel(Number(o.dataset.open)); };
}

const INV_STATUS = { latest: ["ok", "最新"], outdated: ["upd", "更新あり"], different: ["", "ライブラリと別のファイル"], unregistered: ["err", "未登録"] };
/* 処理(ジョブ)が終わるまで待つ */
async function waitJob(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    let j;
    try { j = await api(`/api/jobs/${id}`); } catch { return null; }
    if (j.status !== "running") { pollJobs(); return j; }
  }
}
/* サーバーの中身(種類ごとのタブ・1 件ずつの更新・見送り・無効化・対応バージョンの確認) */
async function inventoryDialog(s, startCat = "all", container = null) {
  let tab = startCat, filter = "all", d = null;
  const ro = s.access === "view";
  await host(container, `「${s.name}」の中身`, `<div class="db" id="invBody"><div style="text-align:center;padding:24px"><span class="spinner lg"></span><p style="margin-top:10px">サーバーのファイルを確認しています…(初回はファイルを読み込むため時間がかかります)</p></div></div>`, async (form, done) => {
    const body = $("#invBody", form);
    const load = async () => {
      try { d = await api(`/api/servers/${s.id}/inventory`); } catch (e) { body.innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
      draw();
    };
    const rowIcon = (f) => { const it = f.item_id && state.items.find((i) => i.id === f.item_id); return it ? itemIcon(it, true) : `<span class="cicon sm c-${f.category}">${catGlyph(f.category)}</span>`; };
    const STAT = { ...INV_STATUS, disabled: ["", "無効"] };
    const draw = () => {
      const cats = SRV_CATS.filter((c) => d.dirs[c]);
      const inTab = (f) => tab === "all" || f.category === tab;
      const order = { outdated: 0, different: 1, unregistered: 2, latest: 3, disabled: 4 };
      const all = d.files.filter(inTab);
      const files = all.filter((f) => filter === "all" || (filter === "upd" ? f.status === "outdated" : filter === "warn" ? f.compat === false || f.held || f.status === "disabled" : f.status === "unregistered"))
        .sort((a, b) => (order[a.status] - order[b.status]) || (a.item_name || a.plugin_name || a.name).localeCompare(b.item_name || b.plugin_name || b.name, "ja", { numeric: true }));
      const missing = d.missing.filter(inTab);
      const syncable = d.files.filter((f) => f.status === "outdated" && !f.held && f.compat !== false).length + d.missing.filter((m) => !m.no_dir && !m.held && m.compat !== false).length;
      const count = (c) => d.files.filter((f) => c === "all" || f.category === c).length;
      const upd = (c) => d.files.filter((f) => (c === "all" || f.category === c) && f.status === "outdated").length;
      const fchip = (k, label, n) => n || k === "all" ? `<button class="tagchip" type="button" data-flt="${k}" aria-pressed="${filter === k}">${label}${k === "all" ? "" : ` ${n}`}</button>` : "";
      const actBtn = (f) => {
        if (ro || f.status === "disabled" || !f.item_id || !["outdated", "different"].includes(f.status)) return `<span class="badge ${STAT[f.status][0]}">${STAT[f.status][1]}</span>`;
        if (f.held) return `<span class="badge">見送り中</span>`;
        if (f.compat === false) return `<button class="btn small plain" type="button" data-up="${f.item_id}" data-force="1" title="MC ${esc(d.mc_version)} に対応していない版です(対応: ${esc(f.compat_mc || "")})">${icon("download")}それでも入れる</button>`;
        return `<button class="btn small ${f.status === "outdated" ? "filled" : "tinted"}" type="button" data-up="${f.item_id}" title="ライブラリの最新(${esc(f.latest_version || "")})をこのサーバーに入れる">${icon("download")}${f.status === "outdated" ? "更新" : "最新に"}</button>`;
      };
      body.innerHTML = `
        <div class="segmented seg-wide inv-tabs" role="group" aria-label="種類">${["all", ...cats].map((c) => `<button class="seg" type="button" data-tab="${c}" aria-pressed="${c === tab}">${c === "all" ? "すべて" : CATS[c]}<span class="n">${count(c)}</span>${upd(c) ? `<i class="dot-upd" title="更新あり"></i>` : ""}</button>`).join("")}</div>
        <div class="tagrow inv-flt">${fchip("all", "すべて", 0)}${fchip("upd", "更新あり", all.filter((f) => f.status === "outdated").length)}${fchip("warn", "要確認", all.filter((f) => f.compat === false || f.held || f.status === "disabled").length)}${fchip("unreg", "未登録", all.filter((f) => f.status === "unregistered").length)}</div>
        ${d.mc_version ? "" : `<div class="result">${icon("clock")} 「設定」で MC のバージョンを入れると、対応していない版に印が付き、同期で入れないようにできます</div>`}
        ${d.absent.filter((c) => tab === "all" || c === tab).map((c) => `<div class="result warn">${esc(CATS[c])}のフォルダ(${esc(d.dirs[c])})が見つかりません。送ると作られます。場所が違う場合は「設定」で変えられます</div>`).join("")}
        <div class="group">${files.map((f) => `<div class="row${f.status === "disabled" ? " dim" : ""}">${rowIcon(f)}
          <span class="main"><span class="title" translate="no">${esc(f.item_name || f.plugin_name || f.name)}
            ${f.held ? `<span class="badge">見送り</span>` : ""}${f.compat === false ? `<span class="badge err" title="対応: ${esc(f.compat_mc || "")}">MC ${esc(d.mc_version)} 非対応</span>` : ""}</span>
            <span class="subtitle">${esc(f.version || "?")}${(f.status === "outdated" || f.status === "different") && f.latest_version ? ` → <b>${esc(f.latest_version)}</b>` : ""} · <span translate="no">${esc(f.path)}</span></span></span>
          <span class="trail">${f.status === "unregistered" && !ro ? `<input type="checkbox" class="switch" data-imp="${esc(f.path)}" title="ライブラリに取り込む" aria-label="ライブラリに取り込む">` : ""}
            ${actBtn(f)}${ro ? "" : `<button class="icon-btn sm" type="button" data-rowmenu="${esc(f.path)}" title="その他" aria-label="その他の操作">${icon("more")}</button>`}</span></div>`).join("") || `<div class="empty">${filter === "all" ? "ファイルがありません" : "あてはまるものはありません"}</div>`}</div>
        ${missing.length ? `<div class="group-title">セットにあってサーバーに無いもの</div><div class="group">${missing.map((m) => `<div class="row"><span class="cicon sm c-${m.category}">${catGlyph(m.category)}</span><span class="main"><span class="title" translate="no">${esc(m.item_name)}${m.compat === false ? ` <span class="badge err">MC ${esc(d.mc_version)} 非対応</span>` : ""}</span><span class="subtitle">${esc(m.version)}${m.no_dir ? ` · ${esc(CATS[m.category] || m.category)}のフォルダが未設定のため入れられません` : ""}</span></span>
          <span class="trail">${m.no_dir || ro ? '<span class="badge upd">未導入</span>' : `<button class="btn small tinted" type="button" data-up="${m.item_id}"${m.compat === false ? ' data-force="1"' : ""}>${icon("plus")}入れる</button>`}</span></div>`).join("")}</div>` : ""}
        ${ro ? "" : `<div class="df" style="padding:0">
          ${syncable ? `<button class="btn filled block" type="button" data-inv="sync">${icon("refresh")}更新があるもの ${syncable} 件をまとめて同期</button>` : `<div class="result ok">${icon("check")} 同期で入れ替えるものはありません</div>`}
          ${d.files.some((f) => f.status === "unregistered") ? `<button class="btn tinted block" type="button" data-inv="import">${icon("download")}選んだ未登録のファイルをライブラリに取り込む</button>` : ""}
        </div>`}`;
    };
    const push = async (btn, iid, force) => {
      await busy(btn, async () => {
        try {
          const j = await api(`/api/servers/${s.id}/push`, { json: { item_ids: [iid], force } });
          const r = await waitJob(j.id);
          if (r && r.status === "done" && (r.result || {}).sent) { toast("更新しました"); await load(); }
          else if (r) toast((r.log || []).filter((x) => !x.startsWith("完了")).slice(-1)[0] || "更新できませんでした", true);
        } catch (ex) { toast(ex.message, true); }
      }, "送信中…");
    };
    body.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; if (container) state.srvCat = tab; draw(); return; }
      const fl = e.target.closest("[data-flt]"); if (fl) { filter = fl.dataset.flt; draw(); return; }
      const up = e.target.closest("[data-up]");
      if (up) {
        if (up.dataset.force && !cfm("この版は、サーバーの MC のバージョンに対応していない可能性があります。それでも入れますか?")) return;
        push(up, Number(up.dataset.up), !!up.dataset.force); return;
      }
      const rm = e.target.closest("[data-rowmenu]");
      if (rm) {
        const f = d.files.find((x) => x.path === rm.dataset.rowmenu); if (!f) return;
        const it = f.item_id && state.items.find((i) => i.id === f.item_id);
        openMenu(rm, [
          ...(f.item_id ? [{ label: f.held ? "見送りをやめる" : "このサーバーでは更新を見送る", icon: "clock", run: async () => {
            try { await api(`/api/servers/${s.id}/hold`, { json: { item_id: f.item_id, hold: !f.held } }); toast(f.held ? "見送りをやめました" : "見送ります(同期・自動更新で入れ替えません)"); await load(); } catch (ex) { toast(ex.message, true); }
          } }] : []),
          { label: f.status === "disabled" ? "有効にする" : "無効にする(消さずに外す)", icon: f.status === "disabled" ? "check" : "eyeoff", run: async () => {
            try { await api(`/api/servers/${s.id}/toggle`, { json: { path: f.path, enable: f.status === "disabled" } }); toast(f.status === "disabled" ? "有効にしました。反映には再起動が必要です" : "無効にしました。反映には再起動が必要です"); await load(); } catch (ex) { toast(ex.message, true); }
          } },
          ...(it ? [{ label: "ライブラリで開く", icon: "box", run: () => { done(null); setView("library"); openPanel(it.id); } }] : []),
        ]);
        return;
      }
      const b = e.target.closest("[data-inv]"); if (!b) return;
      if (b.dataset.inv === "sync") {
        try { jobStarted(await api(`/api/servers/${s.id}/sync`, { json: {} })); done(null); } catch (ex) { toast(ex.message, true); }
      } else {
        const names = [...body.querySelectorAll("[data-imp]:checked")].map((c) => c.dataset.imp);
        if (!names.length) { toast("取り込むファイルのスイッチをオンにしてください", true); return; }
        try { jobStarted(await api(`/api/servers/${s.id}/import`, { json: { names } })); done(null); } catch (ex) { toast(ex.message, true); }
      }
    });
    await load();
  }, { wide: true });
  if (state.view === "servers") loadServers();
}
async function pushDialog({ server = null, set = null, item = null, itemIds = null } = {}) {
  if (!state.servers) { try { const d = await api("/api/servers"); state.servers = d.servers; state.pteroConfigured = d.configured; } catch { state.servers = []; } }
  if (!state.servers.length) { toast("先に「サーバー」タブでサーバーを連携してください", true); return; }
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  // アイテムを選んでから開いたときは、送る内容の確認だけにする(ほかのアイテムは選ばない)
  const fixedIds = item ? [item.id] : itemIds;
  const fixed = fixedIds ? fixedIds.map((id) => state.items.find((i) => i.id === id)).filter(Boolean) : null;
  const latestOf = (it) => it.versions.find((v) => v.id === it.latest_id) || it.versions[0];
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const srvChecked = (x) => (server ? x.id === server.id : state.servers.length === 1);
  const what = fixed
    ? `<div class="group-title">送るもの(${fixed.length} 件 · ${fmtSize(fixed.reduce((n, it) => n + (latestOf(it).size || 0), 0))})</div>
      <div class="group scroll">${fixed.map((it) => `<div class="row">${itemIcon(it, true)}
        <span class="main"><span class="title" translate="no">${esc(it.name)}</span><span class="subtitle">${esc(verLabel(latestOf(it).version))} · ${esc(latestOf(it).filename)}</span></span>
        <span class="trail">${fmtSize(latestOf(it).size)}</span></div>`).join("")}</div>`
    : `<div class="group-title">送るもの</div>
      <div class="segmented seg-wide" role="group" aria-label="送るもの">
        <button class="seg" type="button" data-mode="set" aria-pressed="${!!set || !!state.sets.length}">セット</button>
        <button class="seg" type="button" data-mode="items" aria-pressed="${!set && !state.sets.length}">アイテムを選ぶ</button></div>
      <div id="pSet">${state.sets.length ? `<div class="group scroll">${state.sets.map((x, n) => `<label class="toggle-row"><span class="cicon sm c-plugin">${icon("stack")}</span>
          <span class="main">${esc(x.name)}<small>${x.items.length} 件</small></span>
          <input type="radio" class="switch" name="set_id" value="${x.id}"${(set ? x.id === set.id : n === 0) ? " checked" : ""}></label>`).join("")}</div>`
        : `<div class="empty">セットがありません(「セット」タブで作れます)</div>`}</div>
      <div id="pItems"><div class="group scroll">${items.map((it) => `<label class="toggle-row">${itemIcon(it, true)}
        <span class="main">${esc(it.name)}<small>${esc(verLabel(latestOf(it).version))}(最新)</small></span>
        <input type="checkbox" class="switch" data-pi="${it.id}"></label>`).join("")}</div></div>`;
  const r = await sheet(`${sheetHead(fixed ? "サーバーへ転送" : "サーバーへ転送")}<div class="db">
      <div class="group-title">転送先のサーバー</div>
      <div class="group">${state.servers.map((x) => `<label class="toggle-row"><span class="cicon sm c-teal">${icon(x.kind === "local" ? "folder" : "server")}</span>
        <span class="main">${esc(x.name)}<small>${esc(dirsLabel(x))}</small></span>
        <input type="checkbox" class="switch" data-ps="${x.id}"${srvChecked(x) ? " checked" : ""}></label>`).join("")}</div>
      ${what}
      <div class="group">${toggle("restart", "完了後にサーバーを再起動", state.servers.some((x) => x.kind === "local") ? "フォルダのサーバーは再起動されません" : "", false)}</div>
      <p style="font-size:12.5px">サーバーに同じアドオンの別のバージョンがある場合は、送ったものに置き換えます(置き換えたファイルは退避され、「履歴と巻き戻し」で戻せます)。</p>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>転送する</button></div>`, (form, done) => {
    let mode = set || state.sets.length ? "set" : "items";
    const sync = () => {
      if (fixed) return;
      form.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
      $("#pSet", form).hidden = mode !== "set"; $("#pItems", form).hidden = mode !== "items";
    };
    form.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = () => { mode = b.dataset.mode; sync(); }; });
    sync();
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const srvs = [...form.querySelectorAll("[data-ps]:checked")].map((c) => Number(c.dataset.ps));
      if (!srvs.length) { toast("転送先のサーバーを選んでください", true); return; }
      const body = { restart: form.querySelector("[name=restart]").checked };
      if (fixed) body.item_ids = fixed.map((it) => it.id);
      else if (mode === "set") {
        body.set_id = Number(form.querySelector("[name=set_id]:checked")?.value) || null;
        if (!body.set_id) { toast("送るセットを選んでください", true); return; }
      } else {
        body.item_ids = [...form.querySelectorAll("[data-pi]:checked")].map((c) => Number(c.dataset.pi));
        if (!body.item_ids.length) { toast("送るアイテムを選んでください", true); return; }
      }
      try {
        for (const srv of srvs) jobStarted(await api(`/api/servers/${srv}/push`, { json: body }));
        done(true);
      } catch (ex) { toast(ex.message, true); }
    }, "開始しています…");
  }, { wide: true });
  return r;
}

/* ---------------- detail panel ---------------- */
function openPanel(id) {
  if (state.selected !== id) { state.panelSub = null; state.linkDraft = null; }
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

// シート・詳細を開いている間は後ろの画面をスクロールさせない(iOS は overflow だけでは止まらないので body を固定する)
(() => {
  let savedY = 0;
  const sync = () => {
    const on = $("#dlg").open || $("#panel").classList.contains("on"), b = document.body;
    if (on === b.classList.contains("scroll-locked")) return;
    if (on) { savedY = scrollY; b.style.top = `-${savedY}px`; b.classList.add("scroll-locked"); }
    else { b.classList.remove("scroll-locked"); b.style.top = ""; scrollTo({ top: savedY, behavior: "instant" }); }
  };
  const mo = new MutationObserver(sync);
  mo.observe($("#dlg"), { attributes: true, attributeFilter: ["open"] });
  mo.observe($("#panel"), { attributes: true, attributeFilter: ["class"] });
})();
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
  $("#panel").classList.toggle("ro", it.access === "view");
  if (state.panelSub === "link" && it.source) {
    $("#panel").innerHTML = linkPageHTML(it);
    return;
  }
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
      <h3><span translate="no">${esc(it.name)}</span>${favBtn(it)}</h3>
      ${it.access && it.access !== "owner" ? `<div class="sharednote">${icon("users")}<span translate="no">${esc(it.owner_name)}</span> さんが共有しています(${it.access === "edit" ? "編集もできます" : "閲覧・ダウンロードのみ"})</div>` : ""}
      <p class="desc">${esc(verLabel(latest.version))} · ${it.versions.length} バージョン · ${fmtSize(it.total_size)}${mcOf(it) ? ` · MC ${esc(mcOf(it))}` : ""}</p>
      ${latest.meta.description ? `<p class="desc">${esc(latest.meta.description)}</p>` : ""}
      ${(it.tags || []).length ? `<div class="chips">${it.tags.map((t) => `<button class="tagchip" type="button" data-act="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
    </div>
    <div class="side-body">
      <div class="group-title">配布元</div>
      <div class="group">${sourceBoxHTML(it)}</div>
      ${!it.access || it.access === "owner" ? `<div class="group-title">共有</div>
      <div class="group"><button class="row need-editor" type="button" data-act="acl">
        <span class="cicon sm c-teal">${icon("users")}</span>
        <span class="main"><span class="title">${(it.shared_with || []).length ? `${it.shared_with.length} 人と共有しています` : "自分だけ(共有していません)"}</span>
          <span class="subtitle" translate="no">${(it.shared_with || []).map((x) => `${esc(x.username)}(${x.level === "edit" ? "編集可" : "閲覧"})`).join("、") || "押すと、ほかのユーザーに共有できます"}</span></span>
        ${icon("chev", "i chev")}</button></div>` : ""}
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
  if (act === "panel-back") { state.panelSub = null; state.linkDraft = null; renderPanel(); $("#panel").scrollTop = 0; return; }
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
  else if (act === "acl") { aclDialog("item", it); return; }
  else if (act === "more") {
    const canEdit = isEditor() && it.access !== "view", owner = !it.access || it.access === "owner";
    openMenu(b, [
      ...(canEdit ? [{ label: "情報・タグを編集", icon: "edit", run: () => editItem(it) },
        { label: "サーバーへ転送", icon: "server", run: () => pushDialog({ item: it }) },
        { label: "セットに追加", icon: "stack", run: () => addToSet(it) },
        { label: "URLで共有(ダウンロード用のリンク)", icon: "share", run: () => shareDialog([it]) }] : []),
      { label: state.verOrder === "desc" ? "古い順に並べる" : "新しい順に並べる", icon: "arrows", run: () => { state.verOrder = state.verOrder === "desc" ? "asc" : "desc"; renderPanel(); } },
      ...(owner && isEditor() ? [{ label: "ほかのユーザーに共有", icon: "users", run: () => aclDialog("item", it) }] : []),
      ...(owner && isEditor() ? ["-", { label: "すべて削除", icon: "trash", danger: true, run: async () => {
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
/* だれに共有するか(しない / 閲覧・ダウンロード / 編集もできる) */
async function aclDialog(kind, obj) {
  let users;
  try { users = (await api("/api/users/directory")).users; } catch (e) { toast(e.message, true); return; }
  if (!users.length) { toast("共有できるほかのユーザーがいません(設定の「ユーザーと権限」で追加できます)", true); return; }
  const cur = Object.fromEntries((obj.shared_with || []).map((x) => [x.user_id, x.level]));
  const label = kind === "item" ? "アイテム" : "サーバー";
  const r = await sheet(`${sheetHead(`「${obj.name}」を共有`)}<div class="db">
      <p>共有した相手のライブラリ(またはサーバー一覧)の下の「共有されたもの」に表示されます。${kind === "server" ? "「編集もできる」にすると、相手もこのサーバーへの転送・同期ができます。" : "「編集もできる」にすると、相手も情報の編集・新しいバージョンの追加ができます(削除・共有の変更は持ち主だけ)。"}</p>
      <div class="group">${users.map((u) => `<div class="row acl-row" data-uid="${u.id}"><span class="cicon sm c-teal">${icon("person")}</span>
        <span class="main"><span class="title" translate="no">${esc(u.username)}</span>${u.can_edit ? "" : '<span class="subtitle">閲覧のみのユーザー</span>'}</span>
        <div class="segmented mini" role="group" aria-label="${esc(u.username)} への共有">
          ${[["", "しない"], ["view", "閲覧"], ["edit", "編集も"]].map(([lv, t]) => `<button class="seg" type="button" data-lv="${lv}" aria-pressed="${(cur[u.id] || "") === lv}"${lv === "edit" && !u.can_edit ? " disabled" : ""}>${t}</button>`).join("")}
        </div></div>`).join("")}</div>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lv]"); if (!b || b.disabled) return;
      b.closest(".segmented").querySelectorAll("[data-lv]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const shares = [...form.querySelectorAll(".acl-row")].map((row) => ({ user_id: Number(row.dataset.uid), level: row.querySelector('[aria-pressed="true"]')?.dataset.lv || "" }))
        .filter((x) => x.level);
      try {
        await api(`/api/${kind === "item" ? "items" : "servers"}/${obj.id}/acl`, { method: "PUT", json: { shares } });
        toast(shares.length ? `${shares.length} 人に共有しました` : `${label}の共有をやめました`);
        done(true);
      } catch (ex) { toast(ex.message, true); }
    });
  });
  if (r) { if (kind === "item") await refresh(); else { state.servers = null; loadServers(); } }
}
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
    ${field("サーバーソフト・ローダー", `<select name="platform"><option value="">自動で判定(${esc(platLabel(platformOf({ ...it, platform: "" })) || "不明")})</option>${platOptions(it.platform ? platformOf(it) : "")}</select>`)}
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
    ${field("ローダー・サーバーソフト(例: Paper / Fabric / NeoForge)", `<input type="text" name="loader" value="${esc(m.user_loader ? m.loader : "")}" placeholder="${esc(autoLoader || "空欄なら自動")}" list="loaderList"><datalist id="loaderList">${PLATFORM_DEFS.map((p) => `<option value="${esc(p.short)}">`).join("")}</datalist>`)}
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
/* 配布元の欄。状態をひとことで示し、次にやることをいちばん大きなボタンにする */
function srcRow(act, ic, color, title, sub, extra = "") {
  return `<button class="row" type="button" data-act="${act}"${extra}><span class="cicon sm ${color}">${icon(ic)}</span>
    <span class="main"><span class="title">${title}</span>${sub ? `<span class="subtitle">${sub}</span>` : ""}</span>${icon("chev", "i chev")}</button>`;
}
/* アイコン付きの大きめのボタン(配布元の操作) */
function qa(act, ic, label, primary = false, cls = "") {
  return `<button class="qa${primary ? " primary" : ""}${cls ? " " + cls : ""}" type="button" data-act="${act}"><span class="qi">${icon(ic)}</span><span class="ql">${label}</span></button>`;
}
/* 「紐づけ」を押した先のページ: 紐づけ先の変更・探す条件・解除 */
const LINK_LOADERS = {
  plugin: ["paper", "spigot", "bukkit", "purpur", "folia", "velocity", "bungeecord", "waterfall", "sponge"],
  mod: ["fabric", "quilt", "forge", "neoforge"], modpack: ["fabric", "quilt", "forge", "neoforge"],
  shader: ["iris", "optifine"], datapack: ["datapack"], resourcepack: ["minecraft"], other: [],
};
function linkPageHTML(it) {
  const s = it.source;
  const d = state.linkDraft && state.linkDraft.id === it.id ? state.linkDraft
    : (state.linkDraft = { id: it.id, loaders: [...s.loaders], mc: s.game_versions.join(", ") });
  const known = LINK_LOADERS[it.category] || [];
  const extra = d.loaders.filter((l) => !known.includes(l));
  const cands = state.candidates[it.id];
  return `<div class="side-head">
      <div class="nav"><button class="btn plain small backbtn" type="button" data-act="panel-back">${icon("chev", "i back")}戻る</button>
        <div class="navbtns"><button class="close-x" type="button" data-act="close" aria-label="閉じる">${icon("x")}</button></div></div>
      <h3>配布元のリンク</h3><p class="desc" translate="no">${esc(it.name)}</p></div>
    <div class="side-body">
      <div class="group-title">いまのリンク先</div>
      <div class="group"><div class="srcbox"><div class="sh">${s.icon_v ? `<span class="srcicon"><img src="/api/items/${it.id}/icon?v=${s.icon_v}" alt="" decoding="async">${providerBadge(s.provider)}</span>`
        : providerBadge(s.provider).replace('class="pbadge"', 'class="pbadge lg"')}
        <div class="main"><a href="${esc(safeUrl(s.page_url))}" target="_blank" rel="noopener noreferrer" style="font-weight:600">${esc(s.title)} ${icon("external", "i ext")}</a>
          <div class="muted brk" style="margin:0">${esc(s.provider_label)}${s.linked_by === "name" ? " · 名前から推定(違っていたら変えてください)" : s.linked_by === "hash" ? " · ファイルの中身で一致" : ""}</div></div></div></div></div>

      <div class="need-editor">
        <div class="group-title">リンク先を変える</div>
        <div class="group srcrows">
          ${srcRow("src-detect", "wand", "c-teal", "自動で探し直す", "ファイルの中身と名前から、配布元を探し直します")}
          ${srcRow("src-search", "search", "c-plugin", "配布サイトで検索して選ぶ", "Modrinth / SpigotMC / CurseForge を名前で検索")}
          ${srcRow("src-link", "link", "c-gray", "配布ページの URL を入力", "例: https://modrinth.com/plugin/…")}
        </div>
        ${cands ? (cands.length ? `<div class="group-title">候補</div><div class="group">${cands.map((c, i) => `
          <div class="cand"><div class="main">${esc(c.title)}${c.exact ? ' <span class="badge ok">名前が一致</span>' : ""}<small>${esc(PROVIDERS[c.provider])} · ${(c.downloads || 0).toLocaleString()} DL</small></div>
            <a class="icon-btn sm" href="${esc(safeUrl(c.page_url))}" target="_blank" rel="noopener noreferrer" title="配布ページを開く" aria-label="配布ページを開く">${icon("external")}</a>
            <button class="btn small tinted" type="button" data-act="src-pick" data-i="${i}">これにする</button></div>`).join("")}</div>` : `<div class="group-foot">候補が見つかりませんでした</div>`) : ""}

        <div class="group-title">新しいバージョンを探す条件</div>
        <div class="group"><div class="card-b" style="padding:12px 14px">
          <div class="flabel">サーバーソフト・ローダー(選んだものに対応する版だけを探します。何も選ばなければすべて)</div>
          <div class="chips">${[...known, ...extra].map((l) => `<button class="tagchip" type="button" data-act="src-loader" data-l="${esc(l)}" aria-pressed="${d.loaders.includes(l)}" translate="no">${esc(l)}</button>`).join("")}
            <button class="tagchip" type="button" data-act="src-loader-add">＋ ほかを追加</button></div>
          <label class="field" style="margin-top:12px"><span>Minecraft のバージョン(カンマ区切り。空欄ならすべて)</span>
            <input type="text" id="lkMc" value="${esc(d.mc)}" placeholder="例: 1.21.1, 1.21.4"></label>
          <button class="btn filled block" type="button" data-act="src-savefilter" style="margin-top:10px">保存して確認</button>
        </div></div>

        <div class="group srcrows" style="margin-top:18px">
          <button class="row danger" type="button" data-act="src-unlink"><span class="cicon sm c-red">${icon("x")}</span>
            <span class="main"><span class="title">リンクを解除</span><span class="subtitle">保存しているファイルはそのまま残ります</span></span></button>
        </div>
      </div>
    </div>`;
}
function sourceBoxHTML(it) {
  const s = it.source;
  const cands = state.candidates[it.id];
  if (!s) {
    return `<div class="srcbox">
      <div class="sh"><span class="cicon sm c-teal">${icon("link")}</span><div class="main"><div class="title" style="font-weight:600">配布元が未設定です</div>
        <div class="muted" style="margin:0">Modrinth / SpigotMC / CurseForge と紐付けると、新しいバージョンの確認とダウンロード、対応MCバージョンの表示ができます</div></div></div>
      <div class="need-editor">
        <div class="qacts">
          ${qa("src-detect", "wand", "自動で探す", true)}
          ${qa("src-search", "search", "検索して選ぶ")}
          ${qa("src-link", "link", "URL で紐づけ")}
        </div>
      </div>
      ${cands ? (cands.length ? `<div class="muted" style="margin-top:10px">候補から選んでください</div>${cands.map((c, i) => `
        <div class="cand"><div class="main">${esc(c.title)}${c.exact ? ' <span class="badge ok">名前が一致</span>' : ""}<small>${esc(PROVIDERS[c.provider])} · ${(c.downloads || 0).toLocaleString()} DL${c.summary ? " · " + esc(c.summary.slice(0, 70)) : ""}</small></div>
          <a class="icon-btn sm" href="${esc(safeUrl(c.page_url))}" target="_blank" rel="noopener noreferrer" title="配布ページを開く" aria-label="配布ページを開く">${icon("external")}</a>
          <button class="btn small tinted need-editor" type="button" data-act="src-pick" data-i="${i}">これにする</button></div>`).join("")}`
        : `<div class="muted" style="margin-top:10px">見つかりませんでした。「配布サイトで検索して選ぶ」か URL で紐付けてください。</div>`) : ""}
    </div>`;
  }
  const L = s.latest || {};
  const top = it.mc_latest_max;
  let state_, main = "";
  if (s.status === "update") {
    state_ = `<div class="srcstate upd">${icon("download")}<div><b>新しいバージョン ${esc(verLabel(L.version || ""))} が公開されています</b>
      <span>${L.date ? `${fmtDate(L.date)} 公開` : ""}${top ? `${L.date ? " · " : ""}MC ${esc(top)} まで対応` : ""}</span></div></div>`;
    main = L.downloadable
      ? `<button class="btn filled block need-editor" type="button" data-act="src-download">${icon("download")}${esc(verLabel(L.version || "最新版"))} をダウンロードして保存</button>`
      : `<a class="btn filled block" href="${esc(safeUrl(s.page_url))}" target="_blank" rel="noopener noreferrer">${icon("external")}配布ページを開いてダウンロード</a>
        <div class="group-foot" style="margin:6px 2px 0">${esc(s.message || "")} ダウンロードしたファイルをライブラリにドロップすると、このアイテムの新しいバージョンとして追加されます。</div>`;
  } else if (s.status === "up_to_date") {
    state_ = `<div class="srcstate ok">${icon("check")}<div><b>最新バージョンを保存しています</b>
      <span>${L.version ? `配布元の最新: ${esc(verLabel(L.version))}` : ""}${top ? ` · MC ${esc(top)} まで対応` : ""}</span></div></div>`;
  } else {
    state_ = `<div class="srcstate ${s.status === "error" ? "err" : ""}">${icon(s.status === "error" ? "x" : "refresh")}<div><b>${s.status === "error" ? "確認できませんでした" : "まだ確認していません"}</b>
      ${s.message ? `<span>${esc(s.message)}</span>` : ""}</div></div>`;
    main = `<button class="btn filled block need-editor" type="button" data-act="src-check">${icon("refresh")}今すぐ確認</button>`;
  }
  return `<div class="srcbox">
    <div class="sh">${s.icon_v ? `<span class="srcicon"><img src="/api/items/${it.id}/icon?v=${s.icon_v}" alt="" decoding="async">${providerBadge(s.provider)}</span>`
      : providerBadge(s.provider).replace('class="pbadge"', 'class="pbadge lg"')}
      <div class="main"><a href="${esc(safeUrl(s.page_url))}" target="_blank" rel="noopener noreferrer" style="font-weight:600">${esc(s.title)} ${icon("external", "i ext")}</a>
        <div class="muted" style="margin:0">${esc(s.provider_label)}${s.linked_by === "name" ? " · 名前から推定" : ""}</div></div></div>
    ${state_}
    ${main}
    <div class="srcbar">
      <button class="btn tinted small need-editor" type="button" data-act="src-check">${icon("refresh")}更新を確認</button>
      <span class="sp"></span>
      <button class="mini-act" type="button" data-act="src-linkpage" title="配布元の紐づけ(紐づけ先の変更・探す条件)">${icon("link")}<span>紐づけ</span></button>
      <button class="mini-act" type="button" data-act="src-changelog" title="配布元で公開されている更新の履歴">${icon("doc")}<span>履歴</span></button>
    </div>
    ${s.checked_at ? `<div class="qfoot">前回の確認: ${fmtDateTime(s.checked_at)}</div>` : ""}
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
    if (act === "src-linkpage") { state.panelSub = "link"; state.linkDraft = null; renderPanel(); $("#panel").scrollTop = 0; return; }
    if (act === "src-loader" || act === "src-loader-add") {
      const d = state.linkDraft;
      d.mc = $("#lkMc")?.value ?? d.mc;
      if (act === "src-loader") {
        const l = btn.dataset.l;
        d.loaders = d.loaders.includes(l) ? d.loaders.filter((x) => x !== l) : [...d.loaders, l];
      } else {
        const r = await formSheet("ローダーを追加", field("ローダーの名前(例: purpur, mohist)", `<input type="text" name="l" required>`), "追加");
        const l = r && String(r.l || "").trim().toLowerCase();
        if (l && !d.loaders.includes(l)) d.loaders.push(l);
      }
      renderPanel(); return;
    }
    if (act === "src-savefilter") {
      const d = state.linkDraft;
      const mc = $("#lkMc").value;
      const r = await busy(btn, () => api(`/api/items/${it.id}/source`, { method: "PATCH", json: { loaders: d.loaders.join(","), game_versions: mc } }), "保存しています…");
      state.linkDraft = null;
      toast(r.source.status === "error" ? (r.source.message || "保存しました(確認できませんでした)") : "保存して確認しました", r.source.status === "error");
      await refresh(); return;
    }
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
      state.panelSub = null; state.linkDraft = null;
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
$("#tbMoreIcon").innerHTML = icon("filter");
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
  toastHost().appendChild(el);
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
/* 処理の進み具合: ライブラリでは詳しく、ダッシュボードでは小さく1行で。サーバーの処理はサーバー画面にも出す */
function renderJobs() {
  const view = state.view || "library";
  const jobs = view === "library" ? state.jobs
    : view === "servers" ? state.jobs.filter((j) => String(j.kind).startsWith("server-"))
    : view === "dash" ? state.jobs : [];
  if (view === "dash") {
    $("#jobs").innerHTML = jobs.length ? `<div class="jobs-mini">${jobs.map((j) => {
      const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
      return `<button class="jm${j.status === "error" ? " error" : ""}" type="button" data-jgo="1" title="ライブラリで詳しく見る">
        ${j.status === "running" ? '<span class="spinner"></span>' : icon(j.status === "done" ? "check" : "x")}
        <span class="t">${esc(j.title)}</span><span class="n">${j.status === "running" ? `${j.done} / ${j.total || "?"}` : j.status === "done" ? "完了" : "エラー"}</span>
        ${j.status === "running" ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ""}</button>`;
    }).join("")}</div>` : "";
    return;
  }
  $("#jobs").innerHTML = jobs.map((j) => {
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
  if (e.target.closest("[data-jgo]")) { setView("library"); return; }
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
          ${rowBtn("appearance", "sparkle", "c-resourcepack", "テーマと背景", `<span class="val">${esc(themeName(state.prefs))}</span>`)}
          ${rowBtn("lang", "globe", "c-plugin", "言語 / Language", `<span class="val" translate="no">${I18N.lang === "en" ? "English" : "日本語"}</span>`)}
        </div>
        <div class="group-title">CraftShelf</div><div class="group">
          ${can("system") ? rowBtn("selfupdate", "sparkle", "c-mod", "パネルのアップデート", upd ? `<span class="badge upd">v${esc(state.selfUpd.latest)}</span>` : `<span class="val">v${esc(state.version || "")}${state.selfUpd && state.selfUpd.channel === "dev" ? "(開発ビルド)" : ""}</span>`)
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
        dupver: { label: "同じバージョンの重複(同じ版のファイルが複数ある)" },
        stale_src: { label: "配布元で長く更新されていない", param: ["期間", 12], unit: "か月以上" },
        stale_lib: { label: "ライブラリに長く新しい版が追加されていない", param: ["期間", 12], unit: "か月以上" },
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
        ${u && u.id !== state.user.id ? `<button class="btn danger block" type="button" id="uDel">このユーザーを削除</button>` : ""}`;
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
      const dev = d.channel === "dev";
      body.innerHTML = `<div class="big-version"><img class="logo" src="/static/icon.svg" alt="" aria-hidden="true">
          <div class="v">${d.update_available ? `v${esc(d.latest)}` : `v${esc(d.current)}`}${dev ? ' <span class="badge upd">開発ビルド</span>' : ""}</div>
          <p>${d.error ? esc(d.error) : d.update_available ? `現在 v${esc(d.current)} · 新しいバージョンがあります`
            : d.downgrade ? `いまは開発ビルド v${esc(d.current)} です。安定版の最新は v${esc(d.latest)} です` : "CraftShelf は最新です"}</p></div>
        <div class="group-title">受け取るアップデート</div>
        <div class="segmented seg-wide" role="group" aria-label="受け取るアップデート">
          <button class="seg" type="button" data-ch="stable" aria-pressed="${!dev}">安定版(おすすめ)</button>
          <button class="seg" type="button" data-ch="dev" aria-pressed="${dev}">開発ビルド</button></div>
        <div class="group-foot">${dev ? "開発ビルドは新しい機能をいち早く試せる代わりに、不具合が含まれることがあります。大切なデータはバックアップしてからお使いください。" : "動作を確認した正式なバージョンだけを受け取ります。"}</div>
        ${d.downgrade ? `<button class="btn tinted block" type="button" id="suDown">${icon("download")}安定版 v${esc(d.latest)} に戻す</button>` : ""}
        ${d.notes && d.notes.length ? `<div class="notes">${d.notes.map((n) => `<h4>v${esc(n.version)} ${esc(n.title)}</h4><div class="body">${esc(n.body)}</div>`).join("")}</div>` : ""}
        ${d.update_available && d.mode === "installer" && !d.can_apply ? `<a class="btn filled block" href="${esc(safeUrl(d.download_url))}" target="_blank" rel="noopener noreferrer">${icon("download")}新しいインストーラーをダウンロード</a>
          <div class="group-foot" style="text-align:center">ダウンロードしたインストーラーを実行すると、上書きでアップデートされます。保存したファイルや登録情報はそのまま残ります。</div>`
          : d.update_available ? `<button class="btn filled block" type="button" id="suGo">ダウンロードしてインストール</button>
          <div class="group-foot" style="text-align:center">インストール後に自動で再起動します(数秒〜数十秒)。保存したファイルや登録情報はそのまま残ります。</div>`
          : `<button class="btn tinted block" type="button" id="suRe">${icon("refresh")}もう一度確認</button>`}
        ${d.mode === "installer" && !d.can_apply ? "" : `<div class="group" style="margin-top:6px">${toggle("self_auto_update", "自動アップデート", "6時間ごとに確認し、新しいバージョンがあれば自動でインストールします", (await api("/api/settings")).self_auto_update)}</div>`}
        <div class="group-foot">取得元: <a href="https://github.com/${esc(d.repo)}" target="_blank" rel="noopener noreferrer">github.com/${esc(d.repo)}</a> (${esc(d.branch)}${d.mode === "installer" ? " · リリース" : ""})</div>`;
      $("#suRe", body)?.addEventListener("click", (e) => busy(e.currentTarget, () => renderSettings(), "確認中…"));
      $("#suGo", body)?.addEventListener("click", (e) => busy(e.currentTarget, () => startSelfUpdate(d), "開始しています…"));
      $("#suDown", body)?.addEventListener("click", async (e) => {
        if (!(await confirmSheet(`安定版 v${d.latest} に戻しますか?`, "開発ビルドで追加された機能は使えなくなります。登録したファイルや情報はそのまま残りますが、念のためバックアップをおすすめします。", "安定版に戻す"))) return;
        busy(e.currentTarget, () => startSelfUpdate(d), "開始しています…");
      });
      body.querySelectorAll("[data-ch]").forEach((b) => b.addEventListener("click", async () => {
        if (b.dataset.ch === d.channel) return;
        if (b.dataset.ch === "dev" && !(await confirmSheet("開発ビルドを受け取りますか?", "開発中の新しい機能をいち早く試せますが、不具合が含まれることがあります。あとで安定版に戻すこともできます。", "開発ビルドにする"))) return;
        try { await api("/api/settings", { method: "PATCH", json: { update_channel: b.dataset.ch } }); toast(b.dataset.ch === "dev" ? "開発ビルドを受け取ります" : "安定版を受け取ります"); renderSettings(); }
        catch (ex) { toast(ex.message, true); }
      }));
      body.onchange = async (e) => {
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
  <li>CraftShelf のバージョン・受け取っている版(安定版 / 開発ビルド)</li>
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

/* パネルの新しいバージョンのお知らせ(閉じたら、その版では出さない) */
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
  draw(0, d.mode === "installer" ? "GitHub から新しい版をダウンロードしています…(画面を閉じずにお待ちください)" : "GitHub から取得しています…(画面を閉じずにお待ちください)");
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
$("#openSearchBtn").addEventListener("click", () => openSearch({ q: state.q || "", kind: state.cat }));
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
/* サーバーソフト・ローダー。id は保存用、label は選択肢、short は一覧の小さな表示 */
const PLATFORM_DEFS = [
  { id: "bukkit", group: "サーバー(プラグイン)", label: "Bukkit 系(Spigot / Paper / Purpur など)", short: "Spigot / Paper" },
  { id: "paper", group: "サーバー(プラグイン)", label: "Paper 専用(paper-plugin.yml)", short: "Paper" },
  { id: "purpur", group: "サーバー(プラグイン)", label: "Purpur 専用", short: "Purpur" },
  { id: "folia", group: "サーバー(プラグイン)", label: "Folia", short: "Folia" },
  { id: "sponge", group: "サーバー(プラグイン)", label: "Sponge", short: "Sponge" },
  { id: "velocity", group: "プロキシ", label: "Velocity", short: "Velocity" },
  { id: "bungee", group: "プロキシ", label: "BungeeCord / Waterfall", short: "BungeeCord" },
  { id: "fabric", group: "Mod ローダー", label: "Fabric", short: "Fabric" },
  { id: "quilt", group: "Mod ローダー", label: "Quilt", short: "Quilt" },
  { id: "forge", group: "Mod ローダー", label: "Forge", short: "Forge" },
  { id: "neoforge", group: "Mod ローダー", label: "NeoForge", short: "NeoForge" },
  { id: "shader", group: "そのほか", label: "シェーダー(Iris / OptiFine)", short: "Iris / OptiFine" },
  { id: "datapack", group: "そのほか", label: "データパック(バニラ)", short: "データパック" },
  { id: "resourcepack", group: "そのほか", label: "リソースパック(バニラ)", short: "リソースパック" },
];
const PLATFORMS = PLATFORM_DEFS.map((p) => p.id);
const PLAT = Object.fromEntries(PLATFORM_DEFS.map((p) => [p.id, p]));
// 以前の版で保存した表示名 → id
const PLAT_LEGACY = { "paper": "paper", "spigot / paper": "bukkit", "folia": "folia", "velocity": "velocity", "bungeecord": "bungee",
  "fabric": "fabric", "quilt": "quilt", "forge": "forge", "neoforge": "neoforge", "iris / optifine": "shader", "datapack": "datapack", "minecraft": "resourcepack" };
const platLabel = (id) => (PLAT[id] ? PLAT[id].label : id || "");
const platShort = (id) => (PLAT[id] ? PLAT[id].short : id || "");
/* <select> の選択肢(グループ分け)。counts を渡すと件数を付け、0 件のものは出さない */
function platOptions(selected, counts = null) {
  const groups = [...new Set(PLATFORM_DEFS.map((p) => p.group))];
  return groups.map((g) => {
    const opts = PLATFORM_DEFS.filter((p) => p.group === g && (!counts || counts[p.id] || p.id === selected));
    return opts.length ? `<optgroup label="${esc(g)}">${opts.map((p) => `<option value="${p.id}"${p.id === selected ? " selected" : ""}>${esc(counts ? p.short : p.label)}${counts ? `(${counts[p.id] || 0})` : ""}</option>`).join("")}</optgroup>` : "";
  }).join("");
}
function platformOf(it) {
  if (it.platform) return PLAT[it.platform] ? it.platform : (PLAT_LEGACY[String(it.platform).toLowerCase()] || "");
  const latest = it.versions.find((v) => v.id === it.latest_id) || it.versions[0] || { meta: {} };
  const lab = String(latest.meta.loader || "").toLowerCase();
  const srcL = ((it.source && it.source.loaders) || []).join(" ");
  if (lab.includes("velocity") || (!lab && srcL === "velocity")) return "velocity";
  if (lab.includes("bungee") || lab.includes("waterfall")) return "bungee";
  if (lab.includes("sponge")) return "sponge";
  if (lab.includes("purpur") && !lab.includes("spigot")) return "purpur";
  if (lab === "paper" || lab.includes("paper 専用")) return "paper";
  if (lab.includes("folia") && !lab.includes("spigot")) return "folia";
  if (lab.includes("bukkit") || lab.includes("spigot")) return srcL.includes("folia") && !srcL.includes("spigot") && !srcL.includes("paper") ? "folia" : "bukkit";
  if (lab.includes("neoforge")) return "neoforge";
  if (lab.includes("forge")) return "forge";
  if (lab.includes("quilt")) return "quilt";
  if (lab.includes("fabric")) return "fabric";
  if (it.category === "shader") return "shader";
  if (it.category === "datapack") return "datapack";
  if (it.category === "resourcepack") return "resourcepack";
  if (it.category === "plugin") return "bukkit";
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
  const all = filtered().length;
  bar.innerHTML = `<div class="selhead"><span class="selcount">${n} 件選択</span><span class="sp"></span>
    <button class="btn plain small" type="button" data-sb="all"${n === all ? " disabled" : ""}>すべて選択</button>
    <button class="btn plain small" type="button" data-sb="none"${n ? "" : " disabled"}>すべて解除</button>
    <button class="btn small" type="button" data-sb="cancel">キャンセル</button></div>
    <div class="selacts"><button class="sbtn" type="button" data-sb="zip"${n ? "" : " disabled"}>${icon("download")}<span>ダウンロード</span></button>
    <button class="sbtn need-editor" type="button" data-sb="share"${n ? "" : " disabled"}>${icon("share")}<span>URLで共有</span></button>
    <button class="sbtn need-editor" type="button" data-sb="server"${n ? "" : " disabled"}>${icon("server")}<span>サーバーへ</span></button>
    <button class="sbtn need-editor" type="button" data-sb="more"${n ? "" : " disabled"}>${icon("more")}<span>その他</span></button></div>`;
}
$("#selBtn").addEventListener("click", () => setSelMode(!state.selMode));
$("#selBar").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sb]"); if (!b || b.disabled) return;
  const ids = [...state.sel];
  const items = state.items.filter((i) => state.sel.has(i.id));
  const a = b.dataset.sb;
  if (a === "all" || a === "none") {
    if (a === "all") filtered().forEach((i) => state.sel.add(i.id)); else state.sel.clear();
    render(); drawSelBar(); return;
  }
  if (a === "cancel") { setSelMode(false); return; }
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
      { label: "ほかのユーザーに共有", icon: "users", run: () => shareManyToUser(items) },
      { label: "種類を変更", icon: "box", run: () => changeMany(items, "category") },
      { label: "サーバーソフトを変更", icon: "server", run: () => changeMany(items, "platform") },
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
        const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;  // シェル用にシングルクォートで囲む
        const cmdWget = `wget -O ${sq(r.filename)} ${sq(r.url)}`, cmdCurl = `curl -fL -o ${sq(r.filename)} ${sq(r.url)}`;
        $("#shOut", form).innerHTML = `<div class="result ok">リンクを作りました(${esc(fmtDateTime(r.expires_at))} まで有効)</div>
          <div class="sharelink"><input type="text" readonly value="${esc(r.url)}" translate="no"><button class="btn small tinted" type="button" data-copy="url">コピー</button>
          ${navigator.share ? `<button class="btn small" type="button" data-nshare>${icon("share")}送る</button>` : ""}</div>
          <div class="group-title" style="margin-top:12px">Linux・サーバーでダウンロードするとき</div>
          <div class="sharelink"><input type="text" readonly value="${esc(cmdWget)}" translate="no"><button class="btn small tinted" type="button" data-copy="wget">コピー</button></div>
          <div class="sharelink"><input type="text" readonly value="${esc(cmdCurl)}" translate="no"><button class="btn small tinted" type="button" data-copy="curl">コピー</button></div>
          <div class="group-foot">サーバーのプラグインフォルダで実行すると、そのまま置けます(例: <code translate="no">cd plugins</code> してから貼り付け)。</div>`;
        form.querySelectorAll("[data-copy]").forEach((b) => { b.onclick = async () => {
          const text = { url: r.url, wget: cmdWget, curl: cmdCurl }[b.dataset.copy];
          try { await navigator.clipboard.writeText(text); toast("コピーしました"); } catch { b.previousElementSibling.select(); }
        }; });
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
/* まとめて共有(自分のものだけ) */
async function shareManyToUser(items) {
  const mine = items.filter((i) => !i.access || i.access === "owner");
  if (!mine.length) { toast("共有できるのは自分のアイテムだけです", true); return; }
  let users;
  try { users = (await api("/api/users/directory")).users; } catch (e) { toast(e.message, true); return; }
  if (!users.length) { toast("共有できるほかのユーザーがいません", true); return; }
  const r = await formSheet(`${mine.length} 件を共有`, `
    ${field("共有する相手", `<select name="user_id">${users.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join("")}</select>`)}
    ${field("できること", `<select name="level"><option value="view">閲覧・ダウンロード</option><option value="edit">編集もできる</option><option value="remove">共有をやめる</option></select>`)}
    ${items.length !== mine.length ? `<p style="font-size:12.5px">ほかの人から共有されたもの(${items.length - mine.length} 件)は対象外です。</p>` : ""}`, "保存");
  if (!r) return;
  try {
    const res = await api("/api/items/acl", { json: { item_ids: mine.map((i) => i.id), user_id: Number(r.user_id), level: r.level === "remove" ? "view" : r.level, remove: r.level === "remove" } });
    toast(r.level === "remove" ? `${res.count} 件の共有をやめました` : `${res.count} 件を共有しました`); await refresh();
  } catch (e) { toast(e.message, true); }
}
/* まとめて種類・サーバーソフトを変える(「その他」に入ってしまったものを直すときなど) */
async function changeMany(items, what) {
  const editable = items.filter((i) => i.access !== "view");
  const opts = what === "category"
    ? Object.entries(CATS).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")
    : `<option value="">自動で判定</option>${platOptions("")}`;
  const r = await formSheet(what === "category" ? `${editable.length} 件の種類を変更` : `${editable.length} 件のサーバーソフトを変更`,
    `${field(what === "category" ? "種類" : "サーバーソフト・ローダー", `<select name="v">${opts}</select>`)}
    ${what === "category" ? `<p style="font-size:12.5px">ファイルは新しい種類のフォルダへ移動します。同じ名前・種類のものがすでにあれば、そちらにまとめます。</p>` : ""}`, "変更");
  if (!r) return;
  const tp = toastProgress("変更しています…");
  let ok = 0;
  try {
    for (const it of editable) { await api(`/api/items/${it.id}`, { method: "PATCH", json: { [what]: r.v } }); ok++; }
    toast(`${ok} 件を変更しました`);
  } catch (e) { toast(`${ok} 件を変更しました。${e.message}`, true); }
  finally { tp.remove(); state.sel.clear(); await refresh(); drawSelBar(); }
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
