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
  const every = s.kind === "ptero" ? 15000 : 4000;  // Pterodactyl はログ全体を取り寄せるので、間を空ける
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
    timer = setTimeout(tick, every);
  };
  filter.addEventListener("input", draw);
  $("#conReload", pane).addEventListener("click", load);
  load().then(() => { timer = setTimeout(tick, every); });

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
  pane.innerHTML = `<div class="sgrp fe-sgrp"><span>ファイル</span><button class="btn small" type="button" data-fcmp>${icon("doc")}ファイル比較</button></div>
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
    if (e.target.closest("[data-fcmp]")) { state.cd = { ids: [s.id], sync: true, onlyDiff: false, widths: {}, filter: "diff" }; state.srvMode = "cfgdiff"; renderServers(); return; }
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
      <span class="fe-sp"></span>
      <span class="fe-state muted small" id="feState"></span>
      <button class="btn small" type="button" data-fcmpfile>${icon("doc")}ファイル比較</button>
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
  $("[data-fcmpfile]", pane).addEventListener("click", () => {
    if (dirty() && !cfm("保存していない変更があります。破棄して比べますか?")) return;
    state.feDirty = null;
    state.cd = { ids: [s.id], sync: true, onlyDiff: false, widths: {}, filter: "diff", wantPath: path };
    state.srvMode = "cfgdiff"; renderServers();
  });
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

/* ---------------- サーバー本体(サーバーソフト)のまとめて管理 ---------------- */
const SOFT_COLORS = { paper: "#e2e8f0", folia: "#bbf7d0", purpur: "#c084fc", leaf: "#86efac", pufferfish: "#fcd34d", velocity: "#60a5fa", waterfall: "#93c5fd",
  bungeecord: "#fde68a", fabric: "#dbb27a", quilt: "#c4b5fd", forge: "#fdba74", neoforge: "#f97316", vanilla: "#a3e635", mohist: "#f472b6", sponge: "#fde047", arclight: "#fca5a5" };
async function renderSoftware(refresh = false) {
  const body = $("#srvBody");
  if (!body) return;
  if (!state.swData || refresh) {
    body.innerHTML = `<div class="card"><div class="empty"><span class="spinner lg"></span><p>サーバー本体の新しいビルドを確かめています…</p></div></div>`;
    try { state.swData = await api(`/api/servers/software${refresh ? "?refresh=1" : ""}`); }
    catch (ex) { body.innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
  }
  const d = state.swData;
  state.swSel = state.swSel || new Set();
  state.swFilter = state.swFilter || "";
  const list = d.servers.filter((s) => !state.swFilter || s.software === state.swFilter);
  const softs = [...new Set(d.servers.map((s) => s.software).filter(Boolean))];
  const upd = (s) => s.info && s.info.update && s.auto;
  const nUpd = d.servers.filter(upd).length;
  const status = (s) => {
    const i = s.info || {};
    if (!s.software) return `<span class="badge">ソフト未設定</span>`;
    if (i.error) return `<span class="badge err" title="${esc(i.error)}">確認できません</span>`;
    if (!i.latest) return `<span class="badge">対応していません</span>`;
    if (!s.auto) return i.update ? `<span class="badge upd">新しいバージョンあり(配布元で)</span>` : `<span class="badge">確認だけ</span>`;
    return i.update ? `<span class="badge upd">更新できます</span>` : `<span class="badge ok">最新</span>`;
  };
  const row = (s) => {
    const i = s.info || {}, l = i.latest || {};
    const can = upd(s);
    return `<div class="row sw-row">
      <input type="checkbox" class="cbox" data-swpick="${s.id}"${state.swSel.has(s.id) ? " checked" : ""}${can ? "" : " disabled"} aria-label="選ぶ">
      <span class="sw-ic" style="background:${SOFT_COLORS[s.software] || "var(--fill-2)"}">${esc((s.software_name || "?").slice(0, 2))}</span>
      <span class="main"><span class="title" translate="no">${esc(s.name)}</span>
        <span class="subtitle" translate="no">${esc(s.software_name || "ソフト未設定")}${i.mc ? ` ${esc(i.mc)}` : ""}${i.jar ? ` · ${esc(i.jar)}` : ""}</span></span>
      <span class="sw-ver mono" translate="no">${esc(i.build || "?")}${l.build && l.build !== i.build ? ` → <b>${esc(l.build)}</b>` : ""}</span>
      <span class="trail">${status(s)}${s.backups ? `<button class="icon-btn sm" type="button" data-swback="${s.id}" title="前の jar に戻す" aria-label="前の jar に戻す">${icon("back")}</button>` : ""}</span></div>`;
  };
  const sup = Object.values(d.supported);
  body.innerHTML = `<div class="sw-head"><h3>サーバー本体</h3>${nUpd ? `<span class="badge upd">新しいビルド ${nUpd}</span>` : `<span class="badge ok">すべて最新</span>`}
      <span class="sp"></span><button class="btn small" type="button" data-swrefresh>${icon("refresh")}確認し直す</button></div>
    <div class="sw-filter">${["", ...softs].map((k) => `<button class="seg" type="button" data-swf="${k}" aria-pressed="${state.swFilter === k}">${k ? esc((d.supported[k] || {}).name || k) : "すべて"}<span class="n">${k ? d.servers.filter((s) => s.software === k).length : d.servers.length}</span></button>`).join("")}</div>
    <div class="group sw-list">${list.map(row).join("") || `<div class="empty">サーバーがありません</div>`}</div>
    <div class="sw-bar glass">
      <span class="cnt">${state.swSel.size ? `${state.swSel.size} 台を選択中` : "更新するサーバーを選んでください"}</span>
      <label class="sw-opt"><input type="checkbox" class="switch" id="swRestart"${state.swRestart !== false ? " checked" : ""}> 止める → 入れ替え → 起動</label>
      <span class="sp"></span>
      ${nUpd ? `<button class="btn small" type="button" data-swall>更新できるものをすべて選ぶ</button>` : ""}
      <button class="btn filled" type="button" data-swgo${state.swSel.size ? "" : " disabled"}>${icon("download")}まとめて更新</button></div>
    <p class="muted small">Minecraft のバージョンは変えず、同じバージョンの中で最新のビルドにします。入れ替える前の jar はパネルに退避し(サーバーごとに 3 つまで)、戻すボタンで戻せます。
      止めて起動するには、サーバーの「設定」で起動・停止の方法(Pterodactyl・コマンド・Docker)を使えるようにしておいてください。</p>
    <details class="sw-support"><summary>対応しているサーバーソフト</summary><p>${sup.filter((x) => x.auto).map((x) => esc(x.name)).join("・")}(入れ替えまで)<br>
      ${sup.filter((x) => !x.auto).map((x) => esc(x.name)).join("・")}(新しいバージョンの確認だけ。インストーラーが要るため)</p></details>`;
  body.onclick = async (e) => {
    if (e.target.closest("[data-swrefresh]")) { renderSoftware(true); return; }
    const f = e.target.closest("[data-swf]"); if (f) { state.swFilter = f.dataset.swf; renderSoftware(); return; }
    if (e.target.closest("[data-swall]")) { d.servers.filter(upd).forEach((s) => state.swSel.add(s.id)); renderSoftware(); return; }
    const bk = e.target.closest("[data-swback]");
    if (bk) {
      const s = d.servers.find((x) => x.id === Number(bk.dataset.swback));
      if (!cfm(`「${s.name}」のサーバー本体を、入れ替える前の jar に戻しますか?(サーバーが動いているときは、再起動で反映されます)`)) return;
      try { const r = await api(`/api/servers/${s.id}/software/restore`, { method: "POST" }); toast(`${r.jar} を戻しました`); renderSoftware(true); } catch (ex) { toast(ex.message, true); }
      return;
    }
    const go = e.target.closest("[data-swgo]");
    if (go && state.swSel.size) {
      const restart = $("#swRestart").checked; state.swRestart = restart;
      if (!cfm(`${state.swSel.size} 台のサーバー本体を最新のビルドにしますか?` + (restart ? "\n\n動いているサーバーは止めて入れ替え、起動し直します。" : "\n\n入れ替えたあと、サーバーを再起動すると反映されます。"))) return;
      await busy(go, async () => {
        try {
          const r = await api("/api/servers/software/update", { json: { server_ids: [...state.swSel], restart } });
          r.jobs.forEach((j) => jobStarted(j));
          state.swSel.clear();
          const done = await Promise.all(r.jobs.map((j) => waitJob(j.id)));
          const ok = done.filter((x) => x && x.status === "done").length;
          toast(ok === done.length ? `${ok} 台を更新しました` : `${ok} 台を更新しました(${done.length - ok} 台はできませんでした)`, ok !== done.length);
        } catch (ex) { toast(ex.message, true); }
        renderSoftware(true);
      }, "更新中…");
    }
  };
  body.onchange = (e) => {
    const c = e.target.closest("[data-swpick]");
    if (c) { const id = Number(c.dataset.swpick); if (c.checked) state.swSel.add(id); else state.swSel.delete(id); renderSoftware(); }
  };
}
