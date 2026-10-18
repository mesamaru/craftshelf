"use strict";
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

