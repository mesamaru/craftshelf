"use strict";
/* ---------------- お知らせセンター(ベルのボタン) ---------------- */
$("#bellBtn").innerHTML = icon("bell") + '<span class="bell-dot" hidden></span>';
$("#cmdBtn").innerHTML = icon("search");
const NOTICE_EVENTS = { updates: "更新", downloaded: "保存", servers: "サーバー", errors: "エラー", backup: "バックアップ", selfupdate: "パネル" };
let noticeTimer = null;
async function checkNotices() {
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(checkNotices, 60000);
  if (!state.user || document.hidden) return;
  try {
    const d = await api("/api/notifications?limit=1");
    setNoticeBadge(d.unread);
  } catch { /* 次の機会に */ }
}
function setNoticeBadge(n) {
  const dot = $("#bellBtn .bell-dot");
  dot.hidden = !n;
  dot.textContent = n > 99 ? "99+" : String(n || "");
  $("#bellBtn").setAttribute("aria-label", n ? `お知らせ(未読 ${n} 件)` : "お知らせ");
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkNotices(); });
$("#bellBtn").addEventListener("click", openNotices);

async function openNotices() {
  let d;
  try { d = await api("/api/notifications?limit=100"); } catch (e) { toast(e.message, true); return; }
  const rows = d.entries.map((n) => {
    const lines = String(n.body || "").split("\n").filter(Boolean);
    const color = n.level === "error" ? "c-red" : n.level === "warn" ? "c-datapack" : "c-mod";
    return `<div class="row notice${n.id > d.last_read ? " unread" : ""}">
      <span class="cicon sm ${color}">${icon(n.level === "error" ? "x" : n.level === "warn" ? "clock" : "bell")}</span>
      <span class="main"><span class="title">${esc(n.title)}</span>
        <span class="subtitle">${esc(NOTICE_EVENTS[n.event] || n.event)} · ${esc(fmtDateTime(n.at))}</span>
        ${lines.length ? `<span class="notice-body">${esc(lines.slice(0, 6).join("\n"))}${lines.length > 6 ? `\n…ほか ${lines.length - 6} 件` : ""}</span>` : ""}
      </span></div>`;
  }).join("");
  const top = d.entries.length ? d.entries[0].id : 0;
  if (top > d.last_read) api("/api/notifications/read", { json: { upto: top } }).then(() => setNoticeBadge(0)).catch(() => {});
  await sheet(`${sheetHead("お知らせ")}<div class="db">
    ${rows ? `<div class="group">${rows}</div>` : `<p class="muted" style="text-align:center;padding:24px 0">まだお知らせはありません。<br>更新の確認・サーバーの処理・バックアップなどの結果がここに届きます。</p>`}
    ${can("integrations") ? `<p class="muted small">同じ内容を Discord にも送れます(設定 → Discord 通知)。</p>` : ""}</div>`);
}

/* ---------------- 全体の検索(Ctrl+K / ⌘K) ---------------- */
function paletteEntries() {
  const out = [];
  const go = (view) => () => setView(view);
  for (const it of state.items || []) {
    out.push({ kind: "アドオン", title: it.name, sub: [CATS[it.category] || it.category, ((it.versions || []).find((v) => v.id === it.latest_id) || (it.versions || [])[0] || {}).version || ""].filter(Boolean).join(" · "),
      ic: "box", run: () => { setView("library"); openPanel(it.id); } });
  }
  for (const s of state.servers || []) {
    out.push({ kind: "サーバー", title: s.name, sub: s.kind === "local" ? "フォルダ" : "Pterodactyl", ic: "server",
      run: () => { state.srvOpen = s.id; setView("servers"); } });
  }
  for (const s of state.sets || []) out.push({ kind: "セット", title: s.name, sub: `${s.count ?? (s.items || []).length ?? ""} 件`, ic: "stack", run: go("sets") });
  out.push(
    { kind: "画面", title: "ライブラリ", ic: "box", run: go("library") },
    { kind: "画面", title: "ダッシュボード", ic: "grid", run: go("dash") },
    { kind: "画面", title: "セット", ic: "stack", run: go("sets") },
    { kind: "画面", title: "サーバー", ic: "server", run: go("servers") },
    { kind: "画面", title: "お知らせ", ic: "bell", run: openNotices },
    { kind: "設定", title: "設定", ic: "gear", run: () => openSettings() },
    { kind: "設定", title: "テーマと背景", ic: "sparkle", run: () => openSettings("appearance") },
    { kind: "設定", title: "アカウント・パスワード・二段階認証", ic: "person", run: () => openSettings("account") },
    { kind: "設定", title: "共有リンク", ic: "share", run: () => openSettings("shares") },
  );
  if (can("storage")) out.push({ kind: "設定", title: "ストレージ", ic: "server", run: () => openSettings("storage") },
    { kind: "設定", title: "バックアップ", ic: "download", run: () => openSettings("backup") });
  if (can("users")) out.push({ kind: "設定", title: "ユーザーと権限", ic: "users", run: () => openSettings("users") });
  if (can("integrations")) out.push({ kind: "設定", title: "Pterodactyl", ic: "server", run: () => openSettings("ptero") },
    { kind: "設定", title: "Discord 通知", ic: "bell", run: () => openSettings("discord") });
  if (can("audit")) out.push({ kind: "設定", title: "操作の記録", ic: "doc", run: () => openSettings("audit") });
  if (can("system")) out.push({ kind: "設定", title: "パネルのアップデート", ic: "sparkle", run: () => openSettings("selfupdate") });
  if (isEditor()) out.push(
    { kind: "操作", title: "ファイルを追加", ic: "plus", run: () => $("#fileInput").click() },
    { kind: "操作", title: "配布サイトから探して追加", ic: "search", run: () => openSearch({}) },
    { kind: "操作", title: "URLから追加", ic: "link", run: importFromUrl },
    { kind: "操作", title: "更新を確認", ic: "refresh", run: () => runUpdates({ check: true }) },
  );
  return out;
}
/* 部分一致・頭文字の一致で並べる(大文字小文字・全角半角は区別しない) */
const normQ = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
function paletteScore(e, q) {
  if (!q) return e.kind === "画面" || e.kind === "操作" ? 1 : 0;
  const t = normQ(e.title), s = normQ(e.sub);
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s\-_.・]+/).some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  if (s.includes(q) || normQ(e.kind).includes(q)) return 10;
  return 0;
}
async function openPalette() {
  if ($("#dlg").open) return;
  if (!state.user) return;
  const all = paletteEntries();
  let shown = [], cur = 0;
  await sheet(`<div class="palette">
      <div class="palette-in">${icon("search")}<input type="search" id="palQ" placeholder="アドオン・サーバー・設定・操作を検索" autocomplete="off" aria-label="検索"></div>
      <div class="palette-list" id="palList" role="listbox"></div>
      <div class="palette-foot muted small"><span><kbd>↑</kbd><kbd>↓</kbd> 選ぶ</span><span><kbd>Enter</kbd> 開く</span><span><kbd>Esc</kbd> 閉じる</span></div>
    </div>`, (form, done) => {
    const input = $("#palQ", form), list = $("#palList", form);
    const draw = () => {
      const q = normQ(input.value.trim());
      shown = all.map((e) => [paletteScore(e, q), e]).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, 40).map(([, e]) => e);
      cur = Math.min(cur, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length ? shown.map((e, i) => `<button type="button" class="pal-row${i === cur ? " on" : ""}" role="option" aria-selected="${i === cur}" data-pi="${i}">
          <span class="cicon sm c-gray">${icon(e.ic)}</span><span class="main"><span class="title" translate="${e.kind === "アドオン" || e.kind === "サーバー" || e.kind === "セット" ? "no" : "yes"}">${esc(e.title)}</span>${e.sub ? `<span class="subtitle">${esc(e.sub)}</span>` : ""}</span>
          <span class="pal-kind">${esc(e.kind)}</span></button>`).join("")
        : `<p class="muted" style="text-align:center;padding:18px 0">見つかりません</p>`;
      list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    };
    const pick = (i) => { const e = shown[i]; if (!e) return; done(null); setTimeout(() => e.run(), 0); };
    input.addEventListener("input", () => { cur = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(shown.length - 1, cur + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); pick(cur); }
    });
    list.addEventListener("click", (e) => { const b = e.target.closest("[data-pi]"); if (b) pick(Number(b.dataset.pi)); });
    draw();
  }, { wide: true });
}
$("#cmdBtn").addEventListener("click", openPalette);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
});
