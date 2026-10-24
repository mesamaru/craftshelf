"use strict";
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
  const stray = new Set(strayVersions(it).map((v) => v.id));
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
                ${stray.has(v.id) ? `<div class="stray"><span>このファイルは ${esc(CATS[kindOfVersion(v)])} です(${esc(CATS[it.category])}に混ざっています)</span>
                  <button class="btn small tinted need-editor" type="button" data-act="split-ver">${esc(CATS[kindOfVersion(v)])} として分ける</button></div>` : ""}
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
  else if (act === "split-ver") {
    const cat = kindOfVersion(v);
    if (await confirmSheet(`${verLabel(v.version)} を${CATS[cat]}として分けますか?`, `${v.filename}
同じ名前の${CATS[cat]}のアイテムへ移します(無ければ作ります)。ファイルは消えません。`, "分ける")) {
      await run(() => api(`/api/versions/${v.id}/move`, { json: { category: cat } }), `${CATS[cat]}として分けました`);
    }
  }
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
    : (state.linkDraft = { id: it.id, loaders: [...s.loaders], mc: s.game_versions.join(", "), channel: s.channel || "" });
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
          <div class="flabel">サーバーソフト・ローダー(選んだものに対応するバージョンだけを探します。何も選ばなければすべて)</div>
          <div class="chips">${[...known, ...extra].map((l) => `<button class="tagchip" type="button" data-act="src-loader" data-l="${esc(l)}" aria-pressed="${d.loaders.includes(l)}" translate="no">${esc(l)}</button>`).join("")}
            <button class="tagchip" type="button" data-act="src-loader-add">＋ ほかを追加</button></div>
          <label class="field" style="margin-top:12px"><span>Minecraft のバージョン(カンマ区切り。空欄ならすべて)</span>
            <input type="text" id="lkMc" value="${esc(d.mc)}" placeholder="例: 1.21.1, 1.21.4"></label>
          <div class="flabel" style="margin-top:12px">受け取るバージョン</div>
          <div class="segmented seg-wide" role="group" aria-label="受け取るバージョン">${[["", "自動"], ["release", "正式版だけ"], ["all", "ベータ版も"]].map(([k, n]) => `<button class="seg" type="button" data-act="src-channel" data-ch="${k}" aria-pressed="${(d.channel || "") === k}">${n}</button>`).join("")}</div>
          <div class="group-foot" style="margin:6px 2px 0">「自動」は、保存しているバージョンやサーバーのバージョンがスナップショット・ベータなら、ベータ版も含めて最新を探します</div>
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
      ? `<button class="btn filled block need-editor" type="button" data-act="src-download">${icon("download")}${esc(verLabel(L.version || "最新バージョン"))} をダウンロードして保存</button>`
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
      <button class="mini-act need-editor" type="button" data-act="src-pickver" title="配布元のバージョンを選んでダウンロード">${icon("download")}<span>バージョンを選ぶ</span></button>
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
    if (act === "src-pickver") {
      const so = it.source;
      await pickVersion({ provider: so.provider, project_id: so.project_id, title: it.name, kind: it.category },
        { loader: SEARCH_LOADERS[(so.loaders || [])[0]] ? so.loaders[0] : "", mc: (so.game_versions || [])[0] || "", kind: it.category });
      return;
    }
    if (act === "src-channel") { state.linkDraft.mc = $("#lkMc")?.value ?? state.linkDraft.mc; state.linkDraft.channel = btn.dataset.ch; renderPanel(); return; }
    if (act === "src-savefilter") {
      const d = state.linkDraft;
      const mc = $("#lkMc").value;
      const r = await busy(btn, () => api(`/api/items/${it.id}/source`, { method: "PATCH", json: { loaders: d.loaders.join(","), game_versions: mc, channel: d.channel || "" } }), "保存しています…");
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
async function openSearch({ q = "", kind = "", linkTo = null, toServer = null, loader = null, mc = null } = {}) {
  const st = { provider: "modrinth", q, kind: kind === "other" || kind === "all" || (kind || "").startsWith("__") ? "" : kind,
    loader: loader ?? (toServer && SEARCH_LOADERS[toServer.software] ? toServer.software : ""),
    mc: mc ?? (toServer && toServer.mc_version ? toServer.mc_version : state.mc && MC_VERSIONS.includes(state.mc) ? state.mc : "") };
  if (st.mc && !MC_VERSIONS.includes(st.mc)) MC_VERSIONS.unshift(st.mc);
  await sheet(`${sheetHead(linkTo ? `「${linkTo.name}」の配布元を探す` : toServer ? `「${toServer.name}」に追加` : "配布サイトから探す")}
    <div class="db">
      <div class="segmented" id="srProv">${Object.entries(PROVIDERS).map(([k, n]) => `<button class="seg" type="button" data-prov="${k}" aria-pressed="${k === st.provider}">${n}</button>`).join("")}</div>
      <label class="search"><span>${icon("search")}</span><input type="search" id="srQ" value="${esc(q)}" placeholder="名前で検索"></label>
      <div class="chips">
        <select id="srKind" class="compact"><option value="">すべての種類</option>${Object.entries(CATS).filter(([k]) => k !== "other").map(([k, n]) => `<option value="${k}"${k === st.kind ? " selected" : ""}>${n}</option>`).join("")}</select>
        <select id="srLoader" class="compact">${Object.entries(SEARCH_LOADERS).map(([k, n]) => `<option value="${k}"${k === st.loader ? " selected" : ""}>${n}</option>`).join("")}</select>
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
              : toServer ? `<button class="btn small filled" type="button" data-add="${i}">${r.item_id ? "バージョンを選んで入れる" : "追加"}</button>`
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
        await pickVersion(r, st, { toServer });
        setTimeout(() => openSearch({ q: st.q, kind: st.kind, toServer, loader: st.loader, mc: st.mc }), 0);  // 検索に戻る
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

/* ---------------- バージョンを選んでダウンロード(前提もまとめて) ---------------- */
async function pickVersion(r, st, { toServer = null } = {}) {
  if (st.mc && !MC_VERSIONS.includes(st.mc)) MC_VERSIONS.unshift(st.mc);
  const done = await sheet(`${sheetHead(toServer ? `「${r.title}」を「${toServer.name}」へ` : `「${r.title}」のバージョンを選ぶ`)}
    <div class="db">
      <div class="chips">
        <select id="pvLoader" class="compact">${Object.entries(SEARCH_LOADERS).map(([k, n]) => `<option value="${k}"${k === st.loader ? " selected" : ""}>${n}</option>`).join("")}</select>
        <select id="pvMc" class="compact"><option value="">すべてのMC</option>${MC_VERSIONS.map((v) => `<option value="${v}"${v === st.mc ? " selected" : ""}>MC ${v}</option>`).join("")}</select>
      </div>
      <div id="pvList" class="group"></div>
      <div id="pvDeps"></div>
      <div class="group">${toServer ? toggle("pv_deps_srv", "前提もサーバーに入れる", "オンにした前提プラグイン・Mod も、ライブラリに追加したあとサーバーへ送ります", true)
        : toggle("pv_save", "このパソコンにも保存する", "ライブラリに追加したあと、選んだバージョンのファイルをダウンロードします", false)}</div>
    </div>
    <div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok disabled>${toServer ? "ダウンロードしてサーバーに入れる" : "このバージョンをライブラリに追加"}</button></div>`, (form, finish) => {
    let vers = [], sel = 0;
    const drawDeps = () => {
      const v = vers[sel];
      const deps = (v && v.deps) || [];
      $("#pvDeps", form).innerHTML = deps.length ? `<div class="group-title">前提プラグイン・Mod</div><div class="group">${deps.map((d, i) => `<label class="toggle-row">
          <span class="main">${esc(d.title)}<small>${d.required ? "必須" : "任意"}${d.item_id ? " · ライブラリにあります" : ""}</small></span>
          ${d.item_id ? '<span class="badge ok">✓</span>' : `<input type="checkbox" class="switch" data-dep="${i}"${d.required ? " checked" : ""}>`}</label>`).join("")}</div>
        <div class="group-foot">オンにした前提も、同じ条件(サーバーソフト・MCバージョン)の最新バージョンをまとめて追加します</div>` : "";
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
        await refresh();
        if (form.querySelector("[name=pv_save]")?.checked && d.version_id) {  // 選んだバージョンをこのパソコンにも保存
          const a = document.createElement("a"); a.href = `/api/versions/${d.version_id}/download`; a.download = ""; document.body.appendChild(a); a.click(); a.remove();
        }
        if (toServer) {  // サーバーへ送る(選んだバージョンをそのまま。前提はライブラリの最新)
          const ids = [d.item_id], vmap = { [d.item_id]: d.version_id };
          if (form.querySelector("[name=pv_deps_srv]")?.checked) {
            for (const x of (d.deps || []).filter((y) => ["added", "duplicate", "exists"].includes(y.status))) {
              const it = state.items.find((i) => i.name === x.title || (i.source && i.source.title === x.title));
              if (it && !ids.includes(it.id)) ids.push(it.id);
            }
          }
          const j = await api(`/api/servers/${toServer.id}/push`, { json: { item_ids: ids, version_ids: vmap, force: true } });
          const res = await waitJob(j.id);
          if (res && res.status === "done") toast(`「${toServer.name}」に入れました`); else if (res) toast((res.log || []).slice(-1)[0] || "サーバーに入れられませんでした", true);
          if (state.view === "servers") loadServers();
        }
        finish(true);
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

