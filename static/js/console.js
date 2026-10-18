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
