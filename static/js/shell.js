"use strict";
/* ---------------- v02 の画面の枠: 左のサイドバー(PC)・検索欄・下のタブ(スマホ)・ライブラリの要約 ---------------- */
const SIDE_VIEWS = [["library", "box", "ライブラリ"], ["dash", "grid", "ダッシュボード"], ["sets", "stack", "セット"], ["servers", "server", "サーバー"]];
const SIDE_MAX_SERVERS = 8;

$("#gsIcon").innerHTML = icon("search");
$("#gsIconM").innerHTML = icon("search");
$("#tiAdd").innerHTML = icon("plus");
$("#gsearch").addEventListener("click", openPalette);
$("#gsearchM").addEventListener("click", openPalette);
$("#tabAdd").addEventListener("click", (e) => openMenu(e.currentTarget, addMenuItems()));
if (!/Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)) $("#gsearch kbd").textContent = "Ctrl K";

function renderSide() {
  const side = $("#sidenav");
  if (!state.user) { side.innerHTML = ""; return; }
  const u = state.user;
  const nUpd = (state.items || []).filter((i) => i.source && i.source.status === "update").length;
  side.innerHTML = `<div class="sn-brand"><img class="logo" src="/static/icon.svg" alt="" aria-hidden="true"><b>CraftShelf</b><span class="v02" title="CraftShelf 02">02</span></div>
    <nav class="sn-nav" aria-label="画面">${SIDE_VIEWS.map(([v, ic, n]) => `<button type="button" class="sn-item" data-view="${v}" aria-current="${state.view === v ? "page" : "false"}">
      ${icon(ic)}<span class="t">${n}</span>${v === "library" && nUpd ? `<span class="spill warn" title="更新あり">${nUpd}</span>` : v === "library" && state.items ? `<span class="n">${state.items.length}</span>` : ""}</button>`).join("")}</nav>
    <div class="sn-srv" id="snSrv"></div>
    <div class="sn-foot">
      <button type="button" class="sn-item" data-sn="bell">${icon("bell")}<span class="t">お知らせ</span><span class="sn-badge" id="snBell" hidden></span></button>
      <button type="button" class="sn-item" data-sn="settings">${icon("gear")}<span class="t">設定</span></button>
      <button type="button" class="sn-item sn-user" data-sn="account"><span class="avatar sm">${esc((u.username || "?").slice(0, 1).toUpperCase())}</span>
        <span class="t"><span translate="no">${esc(u.username)}</span><small>${esc(u.role_label || "")}</small></span></button>
    </div>`;
  renderSideServers();
  syncSideBadges();
}
function renderSideServers() {
  const box = $("#snSrv");
  if (!box) return;
  const list = state.servers || [];
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = list.slice(0, SIDE_MAX_SERVERS).map((s) => {
    const l = (state.srvLive || {})[s.id];
    const ppl = l && l.ping ? `${l.ping.players}人` : "";
    return `<button type="button" class="sn-sub${state.view === "servers" && state.srvOpen === s.id ? " on" : ""}" data-srvgo="${s.id}">${srvDot(s.id)}<span class="t" translate="no">${esc(s.name)}</span>${ppl ? `<small>${esc(ppl)}</small>` : ""}</button>`;
  }).join("") + (list.length > SIDE_MAX_SERVERS ? `<button type="button" class="sn-sub more" data-view="servers"><span class="t">ほか ${list.length - SIDE_MAX_SERVERS} 台</span></button>` : "");
}
function syncSideBadges() {
  const b = $("#snBell");
  if (!b) return;
  b.hidden = !state.unread;
  b.textContent = state.unread > 99 ? "99+" : String(state.unread || "");
}
/* サイドバーのサーバー一覧のために、ログインしたら一度だけ読む(状態の点は少しずつ問い合わせる) */
async function loadSideServers() {
  renderSide();
  if (!state.servers) {
    try { state.servers = (await api("/api/servers")).servers; } catch { return; }
  }
  renderSideServers();
  for (const s of state.servers.slice(0, SIDE_MAX_SERVERS)) if (!(state.srvLive || {})[s.id]) { state.srvLive = state.srvLive || {}; loadLive(s.id); }
}
$("#sidenav").addEventListener("click", (e) => {
  const v = e.target.closest("[data-view]");
  if (v) { setView(v.dataset.view); return; }
  const g = e.target.closest("[data-srvgo]");
  if (g) { state.srvOpen = Number(g.dataset.srvgo); state.srvTab = "overview"; setView("servers"); renderSideServers(); return; }
  const a = e.target.closest("[data-sn]");
  if (!a) return;
  if (a.dataset.sn === "bell") openNotices();
  else if (a.dataset.sn === "settings") openSettings();
  else if (a.dataset.sn === "account") openSettings("account");
});

/* ライブラリの上の要約(押すとその条件で絞り込む) */
function renderLibSummary(nUpd, nDeps) {
  const box = $("#libSum");
  if (!state.items.length) { box.innerHTML = ""; return; }
  const nSrv = state.items.filter((i) => presenceOf(i).length).length;
  const tile = (cat, cls, label, n, ic) => `<button type="button" class="ls-tile ${cls}${state.cat === cat ? " on" : ""}" data-cat="${cat}" aria-pressed="${state.cat === cat}">
    <span class="l">${icon(ic)}${label}</span><span class="v">${n}</span></button>`;
  box.innerHTML = tile("__upd", "upd", "更新あり", nUpd, "refresh") + tile("__deps", "deps", "前提が不足", nDeps, "puzzle")
    + tile("__onsrv", "srv", "サーバーで使用中", nSrv, "server");
}
$("#libSum").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]"); if (!b) return;
  state.cat = state.cat === b.dataset.cat ? "all" : b.dataset.cat;
  render();
  $("#list").scrollIntoView({ behavior: "smooth", block: "start" });
});
