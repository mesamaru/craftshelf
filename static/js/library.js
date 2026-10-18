"use strict";
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
  const lbl = { latest: '<span class="badge ok">最新</span>', outdated: '<span class="badge upd">未同期</span>', missing: '<span class="badge upd">未導入</span>', newer: '<span class="badge acc">サーバーの方が新しい</span>' };
  return `<details class="sect" data-sect="servers"${sectOpen("servers", true) ? " open" : ""}>
    <summary><span>サーバー</span><span class="sum-r">${p.some((x) => x.status === "outdated" || x.status === "missing") ? '<span class="badge upd">未同期あり</span>' : '<span class="badge ok">同期済み</span>'}${icon("chev", "i chev")}</span></summary>
    <div class="group">${p.map((x) => `<div class="row"><span class="cicon sm c-teal">${icon("server")}</span>
      <span class="main"><span class="title">${esc(x.server)}</span><span class="subtitle">${x.version ? esc(x.version) : "入っていません"}</span></span>
      <span class="trail">${lbl[x.status] || ""}${x.status === "outdated" || x.status === "missing" ? `<button class="btn small tinted need-editor" type="button" data-act="srv-sync" data-srv="${x.server_id}">同期</button>` : ""}</span></div>`).join("")}</div></details>`;
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

