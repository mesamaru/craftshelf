"use strict";
/* ---------------- サーバーのコンソール(コマンドと最近のログ) ---------------- */
const consoleHist = new Map(); // サーバーごとの、送ったコマンドの履歴(新しい順)
function consolePane(s, pane) {
  const canSend = s.has_rcon || s.kind === "ptero";
  pane.innerHTML = `<div class="sgrp">最近のログ <span class="muted small" translate="no">logs/latest.log</span></div>
    <div class="slist con-wrap">
      <div class="con-tools"><label class="con-follow"><input type="checkbox" id="conFollow" checked> 自動で読み込む</label>
        <input type="search" id="conFilter" placeholder="ログを絞り込む" aria-label="ログを絞り込む">
        <button class="btn small" type="button" id="conReload">${icon("refresh")}読み込む</button></div>
      <pre class="con-log" id="conLog" translate="no" tabindex="0" aria-live="off"><span class="muted">読み込んでいます…</span></pre>
    </div>
    <div class="sgrp">コマンド</div>
    <div class="slist pad">
      ${canSend ? `<form class="con-in" id="conForm" autocomplete="off">
          <span class="con-prompt" aria-hidden="true">/</span>
          <input type="text" id="conCmd" placeholder="list・say こんにちは・whitelist add …" aria-label="コマンド" maxlength="1000" translate="no" spellcheck="false">
          <button class="btn filled small" type="submit">送る</button></form>
        <div class="con-out" id="conOut" translate="no"></div>
        <p class="muted small">${s.has_rcon ? "RCON で送り、結果をここに表示します。" : "Pterodactyl のコンソールに送ります。結果は上のログで確かめてください(RCON を設定すると、結果もここに出ます)。"}
          送ったコマンドは操作の記録に残ります。</p>`
      : `<p class="muted">コマンドを送るには、「設定」タブで RCON(ポートとパスワード)を設定してください。server.properties の <span class="mono">enable-rcon=true</span>・<span class="mono">rcon.port</span>・<span class="mono">rcon.password</span> と同じ値にします。</p>`}
    </div>`;
  const log = $("#conLog", pane), filter = $("#conFilter", pane), follow = $("#conFollow", pane);
  let lines = [], timer = null, loading = false;
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = shown.length ? shown.map((l) => {
      const cls = /\b(ERROR|SEVERE|FATAL)\b|Exception/.test(l) ? "e" : /\bWARN(ING)?\b/.test(l) ? "w" : "";
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    }).join("\n") : `<span class="muted">${q ? "一致する行はありません" : "ログはまだありません(サーバーを一度起動すると作られます)"}</span>`;
    if (atBottom || !log.dataset.drawn) log.scrollTop = log.scrollHeight;
    log.dataset.drawn = "1";
  };
  const load = async () => {
    if (loading || !pane.isConnected) return;
    loading = true;
    try {
      const d = await api(`/api/servers/${s.id}/logs?lines=400`);
      lines = d.found ? d.lines : [];
      if (!d.found) { log.innerHTML = `<span class="muted">ログのファイルが見つかりません(${esc(d.file)})。サーバーを一度起動すると作られます。</span>`; return; }
      draw();
    } catch (e) { log.innerHTML = `<span class="e">${esc(e.message)}</span>`; }
    finally { loading = false; }
  };
  const tick = () => {
    clearTimeout(timer);
    if (!pane.isConnected || state.srvTab !== "console" || state.srvOpen !== s.id) return;
    if (follow.checked && !document.hidden) load();
    timer = setTimeout(tick, 4000);
  };
  filter.addEventListener("input", draw);
  $("#conReload", pane).addEventListener("click", load);
  load().then(() => { timer = setTimeout(tick, 4000); });

  const form = $("#conForm", pane);
  if (!form) return;
  const input = $("#conCmd", form), out = $("#conOut", pane);
  const hist = consoleHist.get(s.id) || [];
  consoleHist.set(s.id, hist);
  let hi = -1;
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && hist.length) { e.preventDefault(); hi = Math.min(hist.length - 1, hi + 1); input.value = hist[hi]; }
    else if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.max(-1, hi - 1); input.value = hi < 0 ? "" : hist[hi]; }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cmd = input.value.trim().replace(/^\//, "");
    if (!cmd) return;
    const btn = form.querySelector("button[type=submit]");
    await busy(btn, async () => {
      const entry = document.createElement("div");
      entry.className = "con-entry";
      entry.innerHTML = `<div class="c">/${esc(cmd)}</div><div class="r"><span class="spinner"></span></div>`;
      out.prepend(entry);
      while (out.children.length > 20) out.lastChild.remove();
      try {
        const d = await api(`/api/servers/${s.id}/console`, { json: { command: cmd } });
        entry.lastChild.innerHTML = d.via === "rcon" ? (d.output ? esc(d.output) : '<span class="muted">(結果は空です)</span>') : '<span class="muted">送りました。ログで結果を確かめてください</span>';
        if (hist[0] !== cmd) hist.unshift(cmd);
        hist.length = Math.min(hist.length, 50);
        hi = -1; input.value = "";
        setTimeout(load, 800);
      } catch (err) { entry.lastChild.innerHTML = `<span class="e">${esc(err.message)}</span>`; }
    }, "");
    input.focus();
  });
}

/* ---------------- 設定ファイルの編集(保存の前の内容を残す) ---------------- */
const QUICK_FILES = [["server.properties", "server.properties"], ["plugins", "plugins"], ["config", "config"], ["ops.json", "ops.json"], ["whitelist.json", "whitelist.json"]];
function filesPane(s, pane, dir) {
  if (dir === undefined) dir = (state.srvFilesDir || {})[s.id] || "";
  (state.srvFilesDir ||= {})[s.id] = dir;
  const parts = dir ? dir.split("/") : [];
  pane.innerHTML = `<div class="sgrp">ファイル</div>
    <div class="slist pad fe-top">
      <nav class="fe-crumbs" translate="no"><button class="btn plain small" type="button" data-fdir="">${icon("server")}${esc(s.name)}</button>${parts.map((p, i) =>
        `<span class="sep">/</span><button class="btn plain small" type="button" data-fdir="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`).join("")}</nav>
      ${dir ? "" : `<div class="fe-quick">${QUICK_FILES.map(([p, n]) => `<button class="btn small" type="button" data-fquick="${esc(p)}" translate="no">${esc(n)}</button>`).join("")}</div>`}
    </div>
    <div class="slist fe-list" id="feList"><div class="live-wait"><span class="spinner"></span> 読み込んでいます…</div></div>
    <p class="muted small">編集できるのは、設定ファイル(.properties・.yml・.json・.toml など、512 KB まで)です。保存の前の内容はファイルごとに 20 回分残り、いつでも戻せます。</p>`;
  const list = $("#feList", pane);
  api(`/api/servers/${s.id}/files?dir=${encodeURIComponent(dir)}`).then((d) => {
    list.innerHTML = d.entries.length ? d.entries.map((e) => {
      const path = (dir ? dir + "/" : "") + e.name;
      if (!e.is_file) return `<button class="row" type="button" data-fdir="${esc(path)}"><span class="cicon sm c-plugin">${icon("folder")}</span><span class="main"><span class="title" translate="no">${esc(e.name)}</span></span><span class="trail">${icon("chev", "i chev")}</span></button>`;
      return e.editable
        ? `<button class="row" type="button" data-fopen="${esc(path)}"><span class="cicon sm c-teal">${icon("doc")}</span><span class="main"><span class="title" translate="no">${esc(e.name)}</span><span class="subtitle">${esc(fmtSize(e.size))}${e.modified ? ` · ${esc(fmtDateTime(e.modified))}` : ""}</span></span><span class="trail">${icon("edit")}</span></button>`
        : `<div class="row fe-off"><span class="cicon sm c-gray">${icon("doc")}</span><span class="main"><span class="title" translate="no">${esc(e.name)}</span><span class="subtitle">${esc(fmtSize(e.size))}</span></span></div>`;
    }).join("") : `<p class="muted" style="padding:16px">空のフォルダです</p>`;
  }).catch((e) => { list.innerHTML = `<p class="err" style="padding:16px">${esc(e.message)}</p>`; });
  pane.onclick = (e) => {
    const d = e.target.closest("[data-fdir]"); if (d) { filesPane(s, pane, d.dataset.fdir); return; }
    const o = e.target.closest("[data-fopen]"); if (o) { fileEditor(s, pane, o.dataset.fopen); return; }
    const q = e.target.closest("[data-fquick]");
    if (q) { const p = q.dataset.fquick; if (/\.\w+$/.test(p)) fileEditor(s, pane, p); else filesPane(s, pane, p); }
  };
}

async function fileEditor(s, pane, path) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  pane.onclick = null;
  pane.innerHTML = `<div class="live-wait"><span class="spinner"></span> 読み込んでいます…</div>`;
  let f;
  try { f = await api(`/api/servers/${s.id}/file?path=${encodeURIComponent(path)}`); }
  catch (e) { toast(e.message, true); filesPane(s, pane, dir); return; }
  let base = f.text, hash = f.hash;
  pane.innerHTML = `<div class="fe-head">
      <button class="btn plain small" type="button" data-fback>${icon("back")}ファイル</button>
      <span class="fe-path mono" translate="no" title="${esc(path)}">${esc(path)}</span>
      <span class="fe-state muted small" id="feState"></span>
      <button class="btn small" type="button" data-fhist${f.history ? "" : " disabled"}>${icon("clock")}履歴${f.history ? ` ${f.history}` : ""}</button>
      <button class="btn filled small" type="button" data-fsave disabled>保存</button></div>
    <textarea class="fe-text" id="feText" spellcheck="false" autocapitalize="off" autocomplete="off" translate="no" wrap="off" aria-label="${esc(path)}"></textarea>
    <p class="muted small">Ctrl+S(⌘S)で保存。保存の前の内容は「履歴」から戻せます。サーバーが動いている間に変えた設定は、多くの場合、再起動か再読み込みのあとに効きます。</p>`;
  const ta = $("#feText", pane), saveBtn = $("[data-fsave]", pane), st = $("#feState", pane);
  ta.value = base;
  const dirty = () => ta.isConnected && ta.value !== base;
  state.feDirty = dirty;
  const mark = () => { saveBtn.disabled = !dirty(); st.textContent = dirty() ? "未保存の変更があります" : ""; };
  ta.addEventListener("input", mark);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { // 設定ファイルはタブで字下げしない(YAML ではタブが使えない)
      e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); mark();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty()) save(false); }
  });
  const leave = () => { if (dirty() && !cfm("保存していない変更があります。破棄して戻りますか?")) return; state.feDirty = null; filesPane(s, pane, dir); };
  async function save(force) {
    await busy(saveBtn, async () => {
      try {
        const r = await api(`/api/servers/${s.id}/file`, { method: "PUT", json: { path, text: ta.value, hash, force } });
        base = ta.value; hash = r.hash; mark();
        toast(r.changed ? `${path} を保存しました` : "変更はありませんでした");
        if (r.changed) { const hb = $("[data-fhist]", pane); hb.disabled = false; }
      } catch (e) {
        if (/字下げ|書き方/.test(e.message) && !force) {
          if (cfm(`${e.message}\n\nそれでも保存しますか?`)) await save(true);
        } else toast(e.message, true);
      }
    }, "");
  }
  saveBtn.addEventListener("click", () => save(false));
  $("[data-fback]", pane).addEventListener("click", leave);
  $("[data-fhist]", pane).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    let h;
    try { h = await api(`/api/servers/${s.id}/file/history?path=${encodeURIComponent(path)}`); } catch (err) { toast(err.message, true); return; }
    if (!h.entries.length) { toast("履歴はまだありません"); return; }
    openMenu(btn, h.entries.map((x) => ({ label: `${fmtDateTime(x.saved_at)} より前(${x.username}・${fmtSize(x.size)})`, icon: "clock", run: async () => {
      if (dirty() && !cfm("保存していない変更があります。破棄して、この時点の内容を読み込みますか?")) return;
      try {
        const old = await api(`/api/servers/${s.id}/file/history/${x.id}`);
        ta.value = old.text; mark();
        toast("この時点の内容を読み込みました。「保存」で元に戻ります");
      } catch (err) { toast(err.message, true); }
    } })));
  });
  ta.focus();
}

window.addEventListener("beforeunload", (e) => { if (state.feDirty && state.feDirty()) { e.preventDefault(); e.returnValue = ""; } });
