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

