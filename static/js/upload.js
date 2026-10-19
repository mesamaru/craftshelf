"use strict";
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
        if (d.status === "added") { t.status = "added"; batchAdded++; t.msg = `追加: ${d.name} ${d.version || "(バージョン不明)"} [${CATS[d.category]}]`; scheduleRefresh(); }
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
// 以前のバージョンで保存した表示名 → id
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

