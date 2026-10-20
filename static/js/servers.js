"use strict";
/* ---------------- セット ---------------- */
function missingInSet(set) {
  const inSet = state.items.filter((i) => set.items.some((x) => x.item_id === i.id));
  const have = new Set(inSet.flatMap((i) => i.dep_key || []));
  const out = [];
  for (const it of inSet) for (const d of it.depends || []) if (!have.has(d.toLowerCase().replace(/[\W_]+/g, ""))) out.push(`${it.name} → ${d}`);
  return out;
}
async function loadSets() {
  try { state.sets = (await api("/api/sets")).sets; } catch (e) { $("#setsView").innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
  renderSets();
}
function renderSets() {
  const sets = state.sets || [];
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i]));
  $("#setsView").innerHTML = `
    <div class="view-head"><p>よく使う組み合わせを「セット」として保存し、zip でまとめてダウンロードしたり、サーバーへまとめて転送したりできます。</p>
      <button class="btn filled need-editor" type="button" data-sa="new">${icon("plus")}セットを作成</button></div>
    ${sets.length ? `<div class="dash-grid">${sets.map((s) => {
      const miss = missingInSet(s);
      const size = s.items.reduce((n, x) => n + ((byId[x.item_id] || {}).total_size ? ((byId[x.item_id].versions.find((v) => v.id === (x.version_id || byId[x.item_id].latest_id)) || {}).size || 0) : 0), 0);
      return `<div class="card" data-set="${s.id}">
        <div class="card-h"><h4>${esc(s.name)}</h4><span class="badge">${s.items.length} 件 · ${esc(fmtSize(size))}</span></div>
        <div class="card-b">
          ${s.description ? `<p class="muted" style="margin:0 0 8px">${esc(s.description)}</p>` : ""}
          ${miss.length ? `<div class="result err" style="margin-bottom:8px">前提が足りません: ${esc(miss.join(" / "))}</div>` : ""}
          ${s.items.map((x) => { const it = byId[x.item_id]; if (!it) return ""; const v = it.versions.find((vv) => vv.id === (x.version_id || it.latest_id)) || {};
            return `<div class="row" role="button" tabindex="0" data-open="${it.id}">${itemIcon(it, true)}
              <span class="main"><span class="title">${esc(it.name)}</span><span class="subtitle">${esc(verLabel(v.version))}${x.version_id ? "(固定)" : "(常に最新)"}</span></span>${icon("chev", "i chev")}</div>`; }).join("")}
          <div class="chips" style="margin-top:10px">
            <a class="btn small tinted" href="/api/sets/${s.id}/download">${icon("download")}zip でダウンロード</a>
            <button class="btn small need-editor" type="button" data-sa="push">${icon("server")}サーバーへ転送</button>
            <button class="btn small need-editor" type="button" data-sa="edit">${icon("edit")}編集</button>
            <button class="btn small danger need-editor" type="button" data-sa="del">${icon("trash")}削除</button>
          </div>
        </div></div>`; }).join("")}</div>`
    : `<div class="card"><div class="empty"><div class="big">🧺</div>まだセットがありません</div></div>`}`;
}
$("#setsView").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) { openPanel(Number(open.dataset.open)); return; }
  const b = e.target.closest("[data-sa]"); if (!b) return;
  const sid = Number(b.closest("[data-set]")?.dataset.set);
  const set = (state.sets || []).find((s) => s.id === sid);
  if (b.dataset.sa === "new") editSet(null);
  if (b.dataset.sa === "edit") editSet(set);
  if (b.dataset.sa === "push") pushDialog({ set });
  if (b.dataset.sa === "del" && await confirmSheet(`「${set.name}」を削除しますか?`, "セットの組み合わせだけが削除されます。ライブラリのファイルは残ります。", "削除")) {
    try { await api(`/api/sets/${sid}`, { method: "DELETE" }); toast("削除しました"); loadSets(); } catch (ex) { toast(ex.message, true); }
  }
});
async function editSet(set, draft = null) {
  const chosen = draft ? draft.chosen : new Map((set ? set.items : []).map((x) => [x.item_id, x.version_id || ""]));
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const r = await sheet(`${sheetHead(set ? "セットを編集" : "セットを作成")}
    <div class="db">
      ${field("名前", `<input type="text" name="name" value="${esc(draft ? draft.name : set?.name || "")}" placeholder="例: サバイバル鯖一式">`)}
      ${field("メモ(任意)", `<input type="text" name="description" value="${esc(draft ? draft.description : set?.description || "")}">`)}
      <label class="search"><span>${icon("search")}</span><input type="search" id="setQ" placeholder="絞り込み"></label>
      <p style="font-size:12.5px;margin:4px 2px 8px">セットには、それぞれの<b>最新のバージョン</b>が入ります。</p>
      <div class="group scroll" id="setItems">${items.map((it) => {
        const pinned = chosen.get(it.id) ? it.versions.find((v) => String(v.id) === String(chosen.get(it.id))) : null;
        const page = it.source && safeUrl(it.source.page_url) !== "#" ? safeUrl(it.source.page_url) : "";
        return `<div class="setpick" data-name="${esc(it.name.toLowerCase())}" data-row="${it.id}">
          <input type="checkbox" class="cbox" id="si-${it.id}" data-item="${it.id}"${chosen.has(it.id) ? " checked" : ""}>
          ${itemIcon(it, true)}
          <div class="main"><label for="si-${it.id}" translate="no">${esc(it.name)}</label>
            <span class="sub">${esc(verLabel((it.versions.find((v) => v.id === it.latest_id) || it.versions[0]).version))}${platformOf(it) ? ` · ${esc(platShort(platformOf(it)))}` : ""}
              ${pinned ? `<span class="pinb" data-pin="${it.id}" title="押すと固定を外して最新にします">${esc(verLabel(pinned.version))} に固定中 ✕</span>` : ""}</span></div>
          ${page ? `<a class="icon-btn sm" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="配布ページで情報を見る" aria-label="配布ページで情報を見る">${icon("external")}</a>`
            : it.access !== "view" ? `<button class="btn plain small" type="button" data-assign="${it.id}" title="配布元(Modrinth / SpigotMC / CurseForge)を割り当てる">${icon("link")}割り当て</button>` : ""}
        </div>`;
      }).join("")}</div>
      <div class="result err" id="setWarn" hidden></div>
    </div>
    <div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    const warn = () => {
      const tmp = { items: [...form.querySelectorAll("[data-item]:checked")].map((c) => ({ item_id: Number(c.dataset.item) })) };
      const miss = missingInSet(tmp);
      $("#setWarn", form).hidden = !miss.length;
      $("#setWarn", form).textContent = miss.length ? `前提が足りません: ${miss.join(" / ")}` : "";
    };
    form.addEventListener("change", warn); warn();
    $("#setQ", form).oninput = (ev) => { const q = ev.target.value.toLowerCase(); form.querySelectorAll(".setpick").forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); }); };
    form.addEventListener("click", (ev) => {
      const pin = ev.target.closest("[data-pin]");
      if (pin) { ev.preventDefault(); chosen.set(Number(pin.dataset.pin), ""); pin.remove(); return; }
      const as = ev.target.closest("[data-assign]");
      if (as) {  // 配布元の割り当て: 入力中の内容を覚えておき、検索で紐付けたあとセットの画面に戻る
        ev.preventDefault();
        const checked = new Set([...form.querySelectorAll("[data-item]:checked")].map((c) => Number(c.dataset.item)));
        for (const id of [...chosen.keys()]) if (!checked.has(id)) chosen.delete(id);
        for (const id of checked) if (!chosen.has(id)) chosen.set(id, "");
        done({ assign: Number(as.dataset.assign), draft: { chosen, name: form.querySelector("[name=name]").value, description: form.querySelector("[name=description]").value } });
      }
    });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const body = {
        name: form.querySelector("[name=name]").value, description: form.querySelector("[name=description]").value,
        items: [...form.querySelectorAll("[data-item]:checked")].map((c) => ({ item_id: Number(c.dataset.item), version_id: Number(chosen.get(Number(c.dataset.item))) || null })),
      };
      try {
        if (set) await api(`/api/sets/${set.id}`, { method: "PATCH", json: body }); else await api("/api/sets", { json: body });
        done(true);
      } catch (ex) { toast(ex.message, true); }
    });
  }, { wide: true });
  if (r && r.assign) {
    const it = state.items.find((i) => i.id === r.assign);
    if (it) { await openSearch({ q: it.name, kind: it.category, linkTo: it }); await refresh(); }
    return editSet(set, r.draft);
  }
  if (r) { toast("保存しました"); loadSets(); }
}

/* ---------------- サーバー(Pterodactyl) ---------------- */
async function loadServers() {
  try {
    const d = await api("/api/servers");
    state.servers = d.servers; state.pteroConfigured = d.configured; state.localOk = d.local_ok; state.dockerOk = d.docker;
  } catch (e) { $("#serversView").innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
  state.srvLive = state.srvLive || {};
  if (state.srvOpen && !state.servers.some((s) => s.id === state.srvOpen)) state.srvOpen = null;
  renderServers();
  for (const s of state.servers) loadLive(s.id);
}
/* 稼働状況・人数(一覧ではカードの右上、詳細では状態のパネルに出す) */
async function loadLive(id) {
  try { state.srvLive[id] = await api(`/api/servers/${id}/status`); } catch { state.srvLive[id] = { state: "unknown" }; }
  if (typeof renderSideServers === "function") renderSideServers();
  const srv = (state.servers || []).find((x) => x.id === id);
  if (!srv) return;
  document.querySelectorAll(`[data-sdot="${id}"]`).forEach((el) => { el.outerHTML = srvDot(id); });
  document.querySelectorAll(`[data-ssub="${id}"]`).forEach((el) => { el.textContent = srvSub(srv).replace(/&amp;/g, "&"); });
  if (state.srvOpen === id) {
    if ($("[data-livechip]")) $("[data-livechip]").innerHTML = liveStateChip(srv);
    if ($("#srvLivePanel")) $("#srvLivePanel").innerHTML = livePanel(srv);
  }
  const st = $(".sstats");
  if (st && state.view === "servers") {  // 上の集計(稼働・人数)も更新する
    const tmp = document.createElement("div"); tmp.innerHTML = srvListHTML(state.servers);
    st.replaceWith(tmp.querySelector(".sstats"));
  }
}
const STATE_LABEL = { running: ["ok", "稼働中"], offline: ["", "停止中"], starting: ["upd", "起動中"], stopping: ["upd", "停止処理中"], local: ["", "状態不明"], unknown: ["", "状態不明"] };
const stateBadge = (s) => { const [cl, l] = STATE_LABEL[s] || STATE_LABEL.unknown; return `<span class="badge ${cl}">${l}</span>`; };

/* ---------------- サーバーソフトと、種類ごとのフォルダ ---------------- */
const SRV_CATS = ["plugin", "mod", "datapack"];
const SRV_SOFT = { paper: "Paper", purpur: "Purpur", folia: "Folia", leaf: "Leaf", pufferfish: "Pufferfish", spigot: "Spigot", bukkit: "CraftBukkit",
  sponge: "Sponge", vanilla: "Vanilla", velocity: "Velocity", bungeecord: "BungeeCord", waterfall: "Waterfall", fabric: "Fabric", quilt: "Quilt",
  forge: "Forge", neoforge: "NeoForge", mohist: "Mohist", arclight: "Arclight" };
const SRV_SOFT_GROUPS = [["サーバー(プラグイン)", ["paper", "purpur", "folia", "leaf", "pufferfish", "spigot", "bukkit", "sponge"]],
  ["プロキシ", ["velocity", "bungeecord", "waterfall"]], ["Mod ローダー", ["fabric", "quilt", "forge", "neoforge"]],
  ["Mod とプラグインの両方", ["mohist", "arclight"]], ["そのほか", ["vanilla"]]];
const SRV_DIR_HINT = { plugin: "plugins", mod: "mods", datapack: "world/datapacks" };
function defaultSrvDirs(soft, world = "world") {
  if (["velocity", "bungeecord", "waterfall"].includes(soft)) return { plugin: "plugins" };
  if (["fabric", "quilt", "forge", "neoforge"].includes(soft)) return { mod: "mods", datapack: `${world}/datapacks` };
  if (["sponge", "mohist", "arclight"].includes(soft)) return { plugin: "plugins", mod: "mods", datapack: `${world}/datapacks` };
  if (soft === "vanilla") return { datapack: `${world}/datapacks` };
  return { plugin: "plugins", datapack: `${world}/datapacks` };
}
const softOptions = (sel) => `<option value="">わからない・指定しない</option>${SRV_SOFT_GROUPS.map(([g, ids]) =>
  `<optgroup label="${esc(g)}">${ids.map((id) => `<option value="${id}"${id === sel ? " selected" : ""}>${SRV_SOFT[id]}</option>`).join("")}</optgroup>`).join("")}`;
const dirsLabel = (s) => SRV_CATS.filter((c) => (s.dirs || {})[c]).map((c) => `${CATS[c]}: ${s.dirs[c]}`).join(" · ");

/* 追加・設定で共通の入力欄(サーバーソフト・フォルダ)。world はワールドのフォルダ名 */
const srvFields = (s = {}) => `
  ${field("サーバーソフト", `<select name="software">${softOptions(s.software || "")}</select>`)}
  <div class="group-title" style="margin:6px 4px 0">管理するフォルダ<small>(サーバーのフォルダから見た場所。空にすると管理しません)</small></div>
  <div class="group srv-dirs">${SRV_CATS.map((c) => `<label class="dir-row"><span class="cicon sm c-${c}">${catGlyph(c)}</span><span class="l">${CATS[c]}</span>
    <input type="text" name="dir_${c}" value="${esc((s.dirs || {})[c] || "")}" placeholder="${SRV_DIR_HINT[c]}" autocomplete="off" spellcheck="false"></label>`).join("")}</div>`;
function wireSrvFields(form, detectBody, onDetect = null) {
  let touched = false, world = "world";
  form.querySelectorAll(".srv-dirs input").forEach((i) => { i.oninput = () => { touched = true; }; });
  const setDirs = (dirs) => SRV_CATS.forEach((c) => { form.querySelector(`[name=dir_${c}]`).value = dirs[c] || ""; });
  form.querySelector("[name=software]").onchange = (e) => { if (!touched) setDirs(defaultSrvDirs(e.target.value, world)); };
  const out = form.querySelector("[data-dtout]");
  const detect = async (btn) => {
    const body = detectBody();
    if (!body) return;
    if (out) out.innerHTML = `<span class="spinner"></span> フォルダの中身を確認しています…`;
    try {
      const r = await api("/api/servers/detect", { json: body });
      world = r.world || "world";
      if (r.software) form.querySelector("[name=software]").value = r.software;
      setDirs(r.dirs); touched = false;
      if (onDetect) onDetect(r);
      if (out) out.innerHTML = r.software ? `${icon("check")}${esc(SRV_SOFT[r.software] || r.software)} と判定しました(ワールド: ${esc(world)})`
        : r.is_server ? `${icon("check")}サーバーソフトは判定できませんでした。フォルダは見つかったものを入れています`
          : `<span class="warn-t">サーバーのフォルダではないかもしれません(server.properties がありません)</span>`;
    } catch (ex) { if (out) out.innerHTML = `<span class="warn-t">${esc(ex.message)}</span>`; }
    return btn;
  };
  form.querySelector("[data-detect]")?.addEventListener("click", (ev) => busy(ev.currentTarget, () => detect(), "確認中…"));
  return { detect };
}
const readDirs = (form) => Object.fromEntries(SRV_CATS.map((c) => [c, form.querySelector(`[name=dir_${c}]`).value.trim()]).filter(([, v]) => v));

async function addServerMenu(btn) {
  const items = [
    state.pteroConfigured ? { label: "Pterodactyl のサーバーを連携", icon: "server", run: () => linkServerDialog() }
      : { label: "Pterodactyl を設定して連携", icon: "gear", run: () => (can("integrations") ? openSettings("ptero") : toast("Pterodactyl の設定は管理者に依頼してください", true)) },
    { label: "フォルダのサーバーを追加(このPC・NAS)", icon: "folder", run: () => (state.localOk ? localServerDialog() : toast("フォルダのサーバーは「パネル全体の設定」の権限がある人だけが追加できます", true)) },
  ];
  openMenu(btn, items);
}
async function linkServerDialog() {
  let ps;
  const tp = toastProgress("Pterodactyl からサーバーの一覧を取得しています…");
  try { ps = (await api("/api/ptero/servers")).servers; } catch (e) { toast(e.message, true); return; } finally { tp.remove(); }
  const avail = ps.filter((p) => !p.linked_id);
  if (!ps.length) { toast("Pterodactyl からサーバーが 1 台も返りませんでした。APIキー(ptlc_…)を作ったユーザーに、サーバーの所有者・サブユーザー・管理者のいずれかの権限があるか確認してください", true); return; }
  if (!avail.length) { toast(`すべてのサーバー(${ps.length} 台)を連携済みです`); return; }
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}`;
  const r = await sheet(`${sheetHead("Pterodactyl のサーバーを連携")}<div class="db">
      ${field("サーバー", `<select name="identifier">${avail.map((p) => `<option value="${esc(p.identifier)}">${esc(p.name)}(${esc(p.node)})</option>`).join("")}</select>`)}
      <div class="detect-out" data-dtout></div>
      ${srvFields({ dirs: defaultSrvDirs("") })}
      ${field("セット(任意。同期のときにセットの中身も入れる)", `<select name="set_id">${setOpts}</select>`)}
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>連携する</button></div>`, (form, done) => {
    const sel = form.querySelector("[name=identifier]");
    let mc = "";
    const { detect } = wireSrvFields(form, () => ({ identifier: sel.value }), (r) => { mc = r.mc || ""; });
    sel.onchange = () => detect(); detect();
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const dirs = readDirs(form);
      if (!Object.keys(dirs).length) { toast("管理するフォルダを 1 つ以上入力してください", true); return; }
      const body = { identifier: sel.value, name: (avail.find((p) => p.identifier === sel.value) || {}).name || sel.value,
        software: form.querySelector("[name=software]").value, dirs, set_id: form.querySelector("[name=set_id]").value, mc_version: mc };
      try { await api("/api/servers", { json: body }); done(true); } catch (ex) { toast(ex.message, true); }
    });
  });
  if (r) { toast("連携しました"); loadServers(); }
}
async function localServerDialog() {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}`;
  const r = await sheet(`${sheetHead("フォルダのサーバーを追加")}<div class="db">
      <div id="lsPick">
        <p>サーバーの <b>jar ファイル</b>(例: paper-1.21.4.jar)を選ぶと、そのフォルダをサーバーとして、サーバーソフト・バージョン・プラグインなどのフォルダを自動で設定します。jar が無い場合は「このフォルダを使う」を押してください。</p>
        <div class="fb-path"><button class="btn plain small" type="button" data-fbup>${icon("up")}上へ</button><span class="mono" id="fbPath"></span></div>
        <div class="group fb-list" id="fbList"><div class="empty"><span class="spinner lg"></span></div></div>
        <div class="chips" style="margin-top:10px"><button class="btn tinted small" type="button" data-fbuse hidden>${icon("folder")}このフォルダを使う</button>
          <button class="btn plain small" type="button" data-fbtype>${icon("edit")}場所を入力する</button></div>
        <div class="inline-input" id="fbTyped" hidden style="margin-top:8px"><input type="text" id="fbInput" placeholder="例: /srv/minecraft/survival" spellcheck="false" autocomplete="off"><button class="btn small" type="button" data-fbgo>開く</button></div>
        <div class="group-foot">Docker で動かしている場合は、サーバーのフォルダをコンテナにマウントしてください(例: /servers/survival)。</div>
      </div>
      <div id="lsForm" hidden>
        <div class="ls-chosen"><span class="cicon sm c-teal">${icon("folder")}</span><span class="m"><b id="lsRoot" class="mono"></b><small id="lsJar"></small></span><button class="btn plain small" type="button" data-fbback>選び直す</button></div>
        <input type="hidden" name="root_dir">
        <div class="detect-out" data-dtout></div>
        ${field("表示名", `<input type="text" name="name" placeholder="空ならフォルダの名前">`)}
        ${srvFields({ dirs: defaultSrvDirs("") })}
        ${field("セット(任意。同期のときにセットの中身も入れる)", `<select name="set_id">${setOpts}</select>`)}
      </div>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok disabled>追加する</button></div>`, (form, done) => {
    const root = form.querySelector("[name=root_dir]");
    let mc = "", jar = "", cur = { path: "", parent: "" };
    const { detect } = wireSrvFields(form, () => ({ kind: "local", root_dir: root.value.trim(), jar }), (r) => { mc = r.mc || ""; });
    const browse = async (path) => {
      const list = $("#fbList", form);
      list.innerHTML = `<div class="empty"><span class="spinner lg"></span></div>`;
      try { cur = await api(`/api/fs/browse?path=${encodeURIComponent(path || "")}`); }
      catch (ex) { list.innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
      $("#fbPath", form).textContent = cur.path || "はじめの場所";
      form.querySelector("[data-fbup]").disabled = !cur.path;
      form.querySelector("[data-fbuse]").hidden = !cur.path;
      form.querySelector("[data-fbuse]").classList.toggle("filled", !!cur.is_server);
      const row = (attr, ic, cls, title, sub, trail = "") => `<button class="row fb-row" type="button" ${attr}><span class="cicon sm ${cls}">${icon(ic)}</span><span class="main"><span class="title" translate="no">${esc(title)}</span>${sub ? `<span class="subtitle">${sub}</span>` : ""}</span>${trail}</button>`;
      list.innerHTML = cur.path
        ? (cur.jars.map((j) => row(`data-fbjar="${esc(j.name)}"`, "cube", j.soft ? "c-mod" : "c-gray", j.name, `${j.soft ? `${esc(SRV_SOFT[j.soft] || j.soft)} · ` : ""}${fmtSize(j.size)}`, `<span class="btn small filled">選ぶ</span>`)).join("")
          + cur.dirs.map((d) => row(`data-fbdir="${esc(d.name)}"`, "folder", d.server ? "c-teal" : "c-gray", d.name, d.server ? "Minecraft サーバー" : "", icon("chev"))).join(""))
          || `<div class="empty">フォルダも jar もありません</div>`
        : cur.starts.map((p) => row(`data-fbabs="${esc(p)}"`, "folder", "c-gray", p, "", icon("chev"))).join("");
    };
    const choose = (dir, jarName) => {
      root.value = dir; jar = jarName || "";
      $("#lsRoot", form).textContent = dir;
      $("#lsJar", form).textContent = jar ? `サーバーソフト: ${jar}` : "jar を選ばずに追加(フォルダの中身から判定します)";
      $("#lsPick", form).hidden = true; $("#lsForm", form).hidden = false;
      form.querySelector("[data-ok]").disabled = false;
      detect();
    };
    const join = (a, b) => (/[\/]$/.test(a) ? a + b : `${a}${a.includes("\\") && !a.includes("/") ? "\\" : "/"}${b}`);
    form.addEventListener("click", (e) => {
      const d = e.target.closest("[data-fbdir]"); if (d) { browse(join(cur.path, d.dataset.fbdir)); return; }
      const a = e.target.closest("[data-fbabs]"); if (a) { browse(a.dataset.fbabs); return; }
      const j = e.target.closest("[data-fbjar]"); if (j) { choose(cur.path, j.dataset.fbjar); return; }
      if (e.target.closest("[data-fbup]")) { browse(cur.parent); return; }
      if (e.target.closest("[data-fbuse]")) { choose(cur.path, ""); return; }
      if (e.target.closest("[data-fbtype]")) { const t = $("#fbTyped", form); t.hidden = !t.hidden; if (!t.hidden) $("#fbInput", form).focus(); return; }
      if (e.target.closest("[data-fbgo]")) { const v = $("#fbInput", form).value.trim(); if (v) browse(v); return; }
      if (e.target.closest("[data-fbback]")) { $("#lsPick", form).hidden = false; $("#lsForm", form).hidden = true; form.querySelector("[data-ok]").disabled = true; }
    });
    $("#fbInput", form).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const v = e.target.value.trim(); if (v) browse(v); } });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const dirs = readDirs(form);
      if (!root.value.trim()) { toast("サーバーを選んでください", true); return; }
      if (!Object.keys(dirs).length) { toast("管理するフォルダを 1 つ以上入力してください", true); return; }
      const body = { kind: "local", root_dir: root.value.trim(), jar, name: form.querySelector("[name=name]").value.trim(),
        software: form.querySelector("[name=software]").value, dirs, set_id: form.querySelector("[name=set_id]").value, mc_version: mc };
      try { await api("/api/servers", { json: body }); done(true); } catch (ex) { toast(ex.message, true); }
    });
    browse("");
  }, { wide: true });
  if (r) { toast("追加しました"); loadServers(); }
}
const DOW = ["月", "火", "水", "木", "金", "土", "日"];
const schedLabel = (s) => s.sched_mode === "daily" ? `毎日 ${s.sched_time}` : s.sched_mode === "weekly" ? `毎週${DOW[s.sched_dow] || ""}曜 ${s.sched_time}` : "なし";
const canPower = (s) => s.kind === "ptero" || (s.kind === "local" && ["command", "docker"].includes(s.control));
const srvSoftLabel = (s) => `${s.software ? esc(SRV_SOFT[s.software] || s.software) : ""}${s.mc_version || s.soft_info?.mc ? ` ${esc(s.mc_version || s.soft_info.mc)}` : ""}`.trim();
const srvUpdates = (s) => Object.values(s.summary || {}).reduce((n, c) => n + (c.outdated || 0), 0);
const srvFiles = (s) => Object.values(s.summary || {}).reduce((n, c) => n + (c.files || 0), 0);
/* 対応が必要か(一覧で上にまとめる) */
const srvNeeds = (s) => srvUpdates(s) > 0 || !!(s.soft_info || {}).update;
const wideSrv = () => matchMedia("(min-width: 900px)").matches;
/* タブの中身を出す場所: 指定があればそこへ、無ければシートで開く */
function host(container, title, html, setup, opts) {
  if (!container) return sheet(`${sheetHead(title)}${html}`, setup, opts);
  container.innerHTML = html;
  return new Promise((res) => setup(container, res));
}
function srvDot(id) {
  const l = (state.srvLive || {})[id];
  const cl = !l ? "wait" : l.state === "running" ? "ok" : ["starting", "stopping"].includes(l.state) ? "upd" : "";
  return `<span class="sdot ${cl}" data-sdot="${id}"></span>`;
}
function srvSub(s) {
  const l = (state.srvLive || {})[s.id];
  const st = !l ? "" : l.ping ? `${l.ping.players}/${l.ping.max}人` : l.state === "offline" ? "停止中" : l.state === "running" ? "稼働中" : "";
  return [srvSoftLabel(s) || (s.kind === "local" ? "フォルダ" : "Pterodactyl"), st].filter(Boolean).join(" · ");
}
function srvBadge(s) {
  const u = srvUpdates(s);
  if (u) return `<span class="spill warn">更新 ${u}</span>`;
  if ((s.soft_info || {}).update) return `<span class="spill acc">本体 新ビルド</span>`;
  if (s.checked) return `<span class="spill ok">最新</span>`;
  return "";
}
const srvRow = (s, sel = false) => `<button class="srow${sel ? " sel" : ""}" type="button" data-srvopen="${s.id}">
  ${srvDot(s.id)}<span class="m"><b translate="no">${esc(s.name)}</b><small data-ssub="${s.id}">${srvSub(s)}</small></span>${srvBadge(s)}${icon("chev")}</button>`;
/* 一覧(スマホ)・左の列(PC) */
function srvListHTML(list, selId = null) {
  const mine = list.filter((s) => !s.access || s.access === "owner"), shared = list.filter((s) => s.access && s.access !== "owner");
  const need = mine.filter(srvNeeds), ok = mine.filter((s) => !srvNeeds(s));
  const live = Object.values(state.srvLive || {});
  const running = list.filter((s) => ((state.srvLive || {})[s.id] || {}).state === "running").length;
  const players = live.reduce((n, l) => n + ((l && l.ping && l.ping.players) || 0), 0);
  const upd = list.reduce((n, s) => n + srvUpdates(s), 0);
  const group = (title, arr) => arr.length ? `<div class="sgrp">${title}</div><div class="slist">${arr.map((s) => srvRow(s, s.id === selId)).join("")}</div>` : "";
  const toSync = list.filter((s) => s.access !== "view" && srvUpdates(s) > 0);
  return `<div class="sstats"><div><small>稼働</small><b>${running}<i>/${list.length}</i></b></div><div><small>更新</small><b class="${upd ? "warn-t" : ""}">${upd}</b></div><div><small>人数</small><b>${players}</b></div></div>
    ${group(need.length ? "対応が必要" : "", need)}${group(need.length ? "問題なし" : "", ok)}${group(shared.length ? "共有されたサーバー" : "", shared)}
    ${toSync.length ? `<button class="sall" type="button" data-va="syncall">${icon("refresh")}<span class="m"><b>すべて最新にする</b><small>${toSync.length} 台・${toSync.reduce((n, s) => n + srvUpdates(s), 0)} 件</small></span><span class="btn small tinted">同期</span></button>` : ""}`;
}
function renderServers() {
  const list = state.servers || [];
  const view = $("#serversView");
  if (!list.length && !state.pteroConfigured && !state.localOk) {
    view.innerHTML = `<div class="card"><div class="empty"><div class="big">🦖</div>
      Pterodactyl と連携するか、このパネルから見えるフォルダのサーバーを追加すると、保管しているプラグイン・Mod・データパックをサーバーへ転送・同期できます。<br>
      ${can("integrations") ? `<button class="btn filled" type="button" data-va="setup" style="margin-top:12px">${icon("gear")}Pterodactyl を設定</button>` : "管理者に設定を依頼してください"}</div></div>`;
    return;
  }
  const head = `<div class="view-head srv-vh"><div class="chips">
      ${state.srvMode && state.srvMode !== "list" ? `<button class="btn small tinted" type="button" data-mode="list">${icon("back")}一覧に戻る</button>`
        : `<button class="btn small" type="button" data-mode="compare">${icon("arrows")}比較</button><button class="btn small" type="button" data-mode="software">${icon("server")}サーバー本体</button><button class="btn small" type="button" data-mode="cfgdiff">${icon("doc")}設定を比べる</button>`}</div>
      <button class="btn filled need-editor" type="button" data-va="add">${icon("plus")}追加</button></div>`;
  if (state.srvMode === "compare") { view.innerHTML = `${head}<div id="srvBody"></div>`; renderCompare(); return; }
  if (state.srvMode === "software") { view.innerHTML = `${head}<div id="srvBody"></div>`; renderSoftware(); return; }
  if (state.srvMode === "cfgdiff") { view.innerHTML = `${head}<div id="srvBody" class="cd-wrap"></div>`; renderCfgDiff(); return; }
  if (!list.length) {
    view.innerHTML = `${head}<div class="card"><div class="empty"><div class="big">🖥️</div>まだサーバーがありません。「追加」から、Pterodactyl のサーバーか、このパネルから見えるフォルダのサーバーを追加できます</div></div>`;
    return;
  }
  let open = state.srvOpen && list.find((s) => s.id === state.srvOpen);
  document.body.classList.toggle("srv-detail", !!open && !wideSrv());  // スマホで詳細を開いている間は大きな見出しを隠す
  if (wideSrv()) {  // PC: 左に一覧、右に詳細
    open = open || list.find(srvNeeds) || list[0];
    state.srvOpen = open.id;
    view.innerHTML = `${head}<div class="srv-split"><aside class="srv-side">${srvListHTML(list, open.id)}</aside><div class="srv-main" id="srvMain"></div></div>`;
    renderServerPage(open, $("#srvMain"));
    return;
  }
  if (open) { view.innerHTML = `<div id="srvMain"></div>`; renderServerPage(open, $("#srvMain")); return; }
  view.innerHTML = `${head}${srvListHTML(list)}`;
}

/* ---------------- サーバーの詳細(概要・アドオン・保存・設定) ---------------- */
function livePanel(s) {
  const l = (state.srvLive || {})[s.id];
  if (!l) return `<div class="live-wait"><span class="spinner"></span> 状態を確認しています…</div>`;
  const p = l.ping;
  const kv = (k, v) => `<div class="lv"><span>${k}</span><b>${v}</b></div>`;
  const mem = l.memory ? `${(l.memory / 1024 ** 3).toFixed(1)} GB` : "";
  return `${p ? `<div class="live-grid">
        ${kv("人数", `${p.players}<small>/${p.max}</small>`)}
        ${kv("応答", `${p.latency}<small>ms</small>`)}
        ${kv("MC", `<span translate="no">${esc(s.mc_version || mcFromName(p.version) || "-")}</span>`)}
        ${l.cpu != null ? kv("CPU", `${Math.round(l.cpu)}<small>%</small>`) : ""}${mem ? kv("メモリ", mem) : ""}
      </div>
      ${p.sample && p.sample.length ? `<div class="live-players">${icon("users")}<span translate="no">${p.sample.map(esc).join("、")}</span></div>` : ""}`
    : `<div class="muted live-note">${l.address ? `人数を確認できませんでした(${esc(l.ping_error || "応答なし")})` : "「設定」でサーバーのアドレスを入れると、人数やバージョンを表示します"}</div>`}
    ${l.mc_detected && !s.mc_version ? `<button class="btn plain small" type="button" data-va="setmc" data-mc="${esc(l.mc_detected)}">${icon("check")}MC ${esc(l.mc_detected)} をこのサーバーのバージョンにする</button>` : ""}`;
}
const mcFromName = (n) => (String(n || "").match(/(?:^|\s)(1\.\d{1,2}(?:\.\d{1,2})?|2\d\.\d{1,2}(?:\.\d{1,2})?)(?![\d.])/) || [])[1] || "";
function liveStateChip(s) {
  const l = (state.srvLive || {})[s.id];
  if (!l) return `<span class="spill"><span class="spinner"></span></span>`;
  const [cl, label] = STATE_LABEL[l.state] || STATE_LABEL.unknown;
  return `<span class="spill ${cl === "ok" ? "ok" : cl === "upd" ? "warn" : ""}">● ${label}</span>`;
}
/* 今やること(無ければ「すべて最新」) */
function todoList(s) {
  const ro = s.access === "view", si = s.soft_info || {}, out = [];
  const row = (ic, cls, title, sub, btn) => `<div class="stodo"><span class="ti-ic ${cls}">${icon(ic)}</span><span class="m">${title}${sub ? `<small>${sub}</small>` : ""}</span>${btn || ""}</div>`;
  const u = srvUpdates(s);
  if (!s.checked) out.push(row("search", "", "中身をまだ確認していません", "アドオンのタブで確認します", `<button class="btn small" type="button" data-tab2="addons">確認</button>`));
  if (u) out.push(row("download", "warn", `${u} 件の更新があります`, s.mc_version ? `MC ${esc(s.mc_version)} に対応していないバージョンは入れません` : "", ro ? "" : `<button class="btn small filled" type="button" data-va="sync">同期</button>`));
  if (si.update) out.push(row("server", "acc", `本体 #${esc(si.latest.build)} が出ています`, si.build ? `今は #${esc(si.build)}` : "", si.latest.url ? `<a class="btn small" href="${esc(si.latest.url)}" target="_blank" rel="noopener">取得</a>` : ""));
  const targets = (s.stage_targets || []).map((id) => (state.servers.find((x) => x.id === id) || {}).name).filter(Boolean);
  if (targets.length && !ro) out.push(row("arrows", "", "検証した構成を本番へ広げる", `${targets.map(esc).join("、")} へ`, `<button class="btn small" type="button" data-va="copy">反映</button>`));
  const old = !s.last_world || (Date.now() - Date.parse(s.last_world)) > 7 * 864e5;
  if (old && !ro) out.push(row("folder", "", s.last_world ? `ワールドの保存が ${Math.floor((Date.now() - Date.parse(s.last_world)) / 864e5)} 日前です` : "ワールドをまだ保存していません", s.world_mode === "off" ? "予約なし" : "", `<button class="btn small" type="button" data-tab2="backup">保存</button>`));
  return out.length ? out.join("") : `<div class="stodo"><span class="ti-ic ok">${icon("check")}</span><span class="m">すべて最新です<small>やることはありません</small></span></div>`;
}
function renderServerPage(s, el) {
  const ro = s.access === "view", owner = !s.access || s.access === "owner";
  const tab = state.srvTab || "overview";
  const tabs = [["overview", "概要"], ...(ro ? [] : [["console", "コンソール"]]), ["addons", `アドオン${srvFiles(s) ? ` ${srvFiles(s)}` : ""}`],
    ...(ro ? [] : [["files", "ファイル"]]), ["backup", "保存"], ...(ro ? [] : [["settings", "設定"]])];
  el.innerHTML = `<div class="srv-page" data-srv="${s.id}">
    ${wideSrv() ? "" : `<button class="btn plain small srv-back" type="button" data-va="back">${icon("back")}サーバー</button>`}
    <div class="srv-hero"><div class="m"><h3 translate="no">${esc(s.name)}</h3><small>${[srvSoftLabel(s), s.kind === "local" ? "フォルダ" : "Pterodactyl", !owner ? `${esc(s.owner_name)} さんが共有` : ""].filter(Boolean).join(" · ")}</small></div>
      <span data-livechip>${liveStateChip(s)}</span></div>
    <div class="segmented seg-wide srv-tabs" role="tablist">${tabs.map(([k, n]) => `<button class="seg" type="button" role="tab" data-tab2="${k}" aria-pressed="${k === tab}">${n}</button>`).join("")}</div>
    <div class="srv-pane" id="srvPane"></div></div>`;
  const pane = $("#srvPane", el);
  if (tab === "overview") {
    pane.innerHTML = `${!ro ? `<div class="srv-qacts">
        <button type="button" data-va="push">${icon("send")}<span>同期</span></button>
        <button type="button" data-tab2="console">${icon("chat")}<span>コマンド</span></button>
        <button type="button" data-tab2="backup">${icon("download")}<span>保存</span></button>
        ${canPower(s) ? `<button type="button" data-pw="restart">${icon("refresh")}<span>再起動</span></button>` : `<button type="button" data-tab2="files">${icon("doc")}<span>ファイル</span></button>`}
      </div>` : ""}<div id="srvLivePanel">${livePanel(s)}</div>
      <div class="sgrp">やること</div><div class="slist stodo-list">${todoList(s)}</div>
      ${!ro ? `<div class="srv-quick">
        <button class="btn small" type="button" data-va="copy">${icon("arrows")}${(s.stage_targets || []).length ? "本番へ反映" : "構成をコピー"}</button>
        ${owner ? `<button class="btn small" type="button" data-va="share">${icon("users")}共有${(s.shared_with || []).length ? ` ${s.shared_with.length}` : ""}</button>` : ""}</div>` : ""}
      ${s.software ? `<div class="sgrp">サーバー本体</div><div class="slist pad" id="srvSoft">${softPanel(s, s.soft_info || {})}</div>` : ""}
      <div class="sgrp">情報</div><div class="slist pad">
        <div class="kv"><span>セット</span><span>${s.set_name ? esc(s.set_name) : "なし"}</span></div>
        <div class="kv"><span>自動更新</span><span>${s.auto_update === "auto" ? "オン" : "オフ"}</span></div>
        <div class="kv"><span>予約同期</span><span>${esc(schedLabel(s))}</span></div>
        <div class="kv"><span>最後の同期</span><span>${s.last_sync ? esc(fmtDateTime(s.last_sync)) : "-"}</span></div>
        <div class="kv"><span>フォルダ</span><span>${esc(dirsLabel(s))}</span></div>
        ${s.kind === "local" ? `<div class="kv"><span>場所</span><span translate="no" class="mono">${esc(s.root_dir || "")}</span></div>` : ""}</div>
      ${!ro && canPower(s) ? `<div class="pw-bar">
        <button class="btn" type="button" data-pw="start">${icon("play")}起動</button>
        <button class="btn" type="button" data-pw="stop">${icon("stop")}停止</button>
        <button class="btn" type="button" data-pw="restart">${icon("refresh")}再起動</button></div>` : ""}`;
    if (!(s.soft_info || {}).checked_at && s.software) refreshSoft(s, false);
  } else if (tab === "addons") {
    inventoryDialog(s, state.srvCat || "all", pane);
  } else if (tab === "backup") {
    pane.innerHTML = `<div class="sgrp">ワールドのバックアップ</div><div id="paneWorlds"></div><div class="sgrp">履歴と巻き戻し</div><div id="paneHist"></div>`;
    worldsDialog(s, $("#paneWorlds", pane)); snapshotsDialog(s, $("#paneHist", pane));
  } else if (tab === "console") {
    consolePane(s, pane);
  } else if (tab === "files") {
    filesPane(s, pane);
  } else if (tab === "settings") {
    serverSettingsDialog(s, pane);
  }
  clearInterval(state.srvLiveTimer);
  state.srvLiveTimer = setInterval(() => { if (state.view === "servers" && state.srvOpen === s.id && !document.hidden) loadLive(s.id); else clearInterval(state.srvLiveTimer); }, 20000);
}
function softPanel(s, si) {
  if (!si.checked_at) return `<div class="live-wait"><span class="spinner"></span> 確認しています…</div>`;
  const name = SRV_SOFT[s.software] || s.software;
  return `<div class="kv"><span>今のビルド</span><span translate="no">${esc(name)} ${esc(si.mc || "")}${si.build ? ` #${esc(si.build)}` : "(わかりません)"}</span></div>
    ${si.latest ? `<div class="kv"><span>最新のビルド</span><span translate="no">#${esc(si.latest.build)}${si.update ? ' <span class="spill acc">新しいビルド</span>' : si.build ? ' <span class="spill ok">最新</span>' : ""}</span></div>` : ""}
    ${si.newer_mc ? `<div class="kv"><span>新しい MC</span><span translate="no">${esc(name)} は ${esc(si.newer_mc)} まで出ています</span></div>` : ""}
    ${si.error ? `<div class="result warn">${esc(si.error)}</div>` : ""}
    <div class="chips" style="margin-top:6px">${si.latest && si.latest.url ? `<a class="btn small tinted" href="${esc(si.latest.url)}" target="_blank" rel="noopener">${icon("download")}${si.latest.file ? "最新のビルドをダウンロード" : "配布ページを開く"}</a>` : ""}
      <button class="btn small plain" type="button" data-va="softcheck">${icon("refresh")}今すぐ確認</button></div>
    <div class="qfoot">入れ替えは、サーバーを止めてから jar を置き換えてください。確認: ${esc(fmtDateTime(si.checked_at))}</div>`;
}
async function refreshSoft(s, force) {
  try {
    s.soft_info = await api(`/api/servers/${s.id}/software${force ? "?refresh=1" : ""}`);
    if ($("#srvSoft") && state.srvOpen === s.id) $("#srvSoft").innerHTML = softPanel(s, s.soft_info);
  } catch (ex) { if (force) toast(ex.message, true); }
}
async function powerAction(s, signal) {
  const label = { start: "起動", stop: "停止", restart: "再起動" }[signal];
  if (signal !== "start" && !await confirmSheet(`「${s.name}」を${label}しますか?`, "プレイ中のプレイヤーは切断されます。", label)) return;
  try {
    const r = await api(`/api/servers/${s.id}/power`, { json: { signal } });
    if (r.job) jobStarted(r.job); else toast(`${label}しました`);
    setTimeout(() => loadLive(s.id), 4000);
  } catch (ex) { toast(ex.message, true); }
}
async function syncDialog(s) {
  const r = await formSheet(`「${s.name}」を同期`, `<p>ライブラリに新しいバージョンがあるものを、サーバーの ${esc(dirsLabel(s))} で入れ替えます${s.set_name ? `。セット「${esc(s.set_name)}」にあってサーバーに無いものも入れます` : ""}。</p>
    <ul class="plain-list">
      <li>${icon("check")}置き換えるファイル${s.backup_config ? "とプラグインの設定フォルダ" : ""}は退避され、「保存」タブの履歴から戻せます</li>
      ${s.mc_version ? `<li>${icon("check")}MC ${esc(s.mc_version)} に対応していないバージョンは入れません</li>` : `<li>${icon("clock")}「設定」で MC のバージョンを入れると、対応していないバージョンを入れないようにできます</li>`}
      ${s.holds ? `<li>${icon("clock")}見送り中の ${s.holds} 件は入れ替えません</li>` : ""}
    </ul>
    ${canPower(s) ? `<div class="group">${toggle("restart", "完了後にサーバーを再起動", "入れ替えを反映させるには再起動が必要です", false)}</div>` : `<p class="muted">このサーバーはパネルから再起動できません。反映するにはサーバーを再起動してください。</p>`}`, "同期する");
  if (!r) return;
  try { jobStarted(await api(`/api/servers/${s.id}/sync`, { json: { restart: !!r.restart } })); } catch (ex) { toast(ex.message, true); }
}

matchMedia("(min-width: 900px)").addEventListener("change", () => { if (state.view === "servers" && state.servers) renderServers(); });
$("#serversView").addEventListener("click", async (e) => {
  const md = e.target.closest("[data-mode]");
  if (md) {
    if (state.srvMode === "cfgdiff" && state.cd && state.cd.files && Object.values(state.cd.files).some((f) => f.dirty) && !cfm("保存していない変更があります。破棄して移動しますか?")) return;
    state.srvMode = md.dataset.mode; document.body.classList.remove("cd-on"); renderServers(); if (state.srvMode === "list") loadServers(); return;
  }
  const op = e.target.closest("[data-srvopen]");
  if (op) { state.srvOpen = Number(op.dataset.srvopen); state.srvTab = "overview"; renderServers(); if (!wideSrv()) window.scrollTo({ top: 0 }); loadLive(state.srvOpen); return; }
  const sid = Number(e.target.closest("[data-srv]")?.dataset.srv);
  const s = (state.servers || []).find((x) => x.id === sid);
  const tb = e.target.closest("[data-tab2]");
  if (tb && s) { if (state.feDirty && state.feDirty() && !cfm("保存していない変更があります。破棄して移動しますか?")) return; state.feDirty = null; state.srvTab = tb.dataset.tab2; renderServerPage(s, $("#srvMain")); return; }
  const pw = e.target.closest("[data-pw]");
  if (pw && s) { powerAction(s, pw.dataset.pw); return; }
  const b = e.target.closest("[data-va]"); if (!b) return;
  const a = b.dataset.va;
  if (a === "setup") openSettings("ptero");
  if (a === "add") addServerMenu(b);
  if (a === "syncall") {
    const targets = (state.servers || []).filter((x) => x.access !== "view" && srvUpdates(x) > 0);
    if (!await confirmSheet("すべて最新にしますか?", `${targets.map((x) => x.name).join("、")} を同期します。対応していないバージョン・見送り中のものは入れません。再起動はしません。`, "同期する", false)) return;
    for (const x of targets) { try { jobStarted(await api(`/api/servers/${x.id}/sync`, { json: {} })); } catch (ex) { toast(`${x.name}: ${ex.message}`, true); } }
    return;
  }
  if (!s) return;
  if (a === "back") { state.srvOpen = null; clearInterval(state.srvLiveTimer); renderServers(); }
  if (a === "softcheck") { if ($("#srvSoft")) $("#srvSoft").innerHTML = `<div class="live-wait"><span class="spinner"></span> 確認しています…</div>`; refreshSoft(s, true); }
  if (a === "setmc") { try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: { mc_version: b.dataset.mc } }); toast("保存しました"); loadServers(); } catch (ex) { toast(ex.message, true); } }
  if (a === "push") pushDialog({ server: s });
  if (a === "copy") copyDialog(s);
  if (a === "share") aclDialog("server", s);
  if (a === "sync") syncDialog(s);
});

/* 構成をコピー・本番へ反映 */
async function copyDialog(s) {
  const others = (state.servers || []).filter((x) => x.id !== s.id && x.access !== "view");
  if (!others.length) { toast("コピー先にできるサーバーがありません", true); return; }
  const staged = new Set(s.stage_targets || []);
  const modes = [["update", "更新だけ", "コピー先にあるアドオンだけ、このサーバーと同じバージョンにします(おすすめ)"],
    ["add", "足りないものも入れる", "このサーバーにあって、コピー先に無いものも入れます"],
    ["mirror", "まったく同じにする", "さらに、このサーバーに無い登録済みのアドオンをコピー先から取り除きます(退避されるので巻き戻せます)"]];
  const r = await sheet(`${sheetHead(staged.size ? "本番へ反映" : "構成をコピー")}<div class="db">
      <p>「${esc(s.name)}」に入っているアドオン(ライブラリにあるもの)を、ほかのサーバーへそろえます。${staged.size ? "検証用サーバーで試した構成を、本番のサーバーへ広げるのに使います。" : ""}</p>
      <div class="group-title">コピー先</div>
      <div class="group">${others.map((x) => `<label class="toggle-row"><span class="cicon sm c-teal">${icon(x.kind === "local" ? "folder" : "server")}</span>
        <span class="main" translate="no">${esc(x.name)}<small>${esc(dirsLabel(x))}</small></span>
        <input type="checkbox" class="switch" data-tg="${x.id}"${staged.size ? (staged.has(x.id) ? " checked" : "") : others.length === 1 ? " checked" : ""}></label>`).join("")}</div>
      <div class="group-title">そろえ方</div>
      <div class="group">${modes.map(([k, t, d], i) => `<label class="toggle-row"><span class="main">${t}<small>${d}</small></span><input type="radio" class="switch" name="mode" value="${k}"${i === 0 ? " checked" : ""}></label>`).join("")}</div>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>そろえる</button></div>`, (form, done) => {
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const targets = [...form.querySelectorAll("[data-tg]:checked")].map((c) => Number(c.dataset.tg));
      if (!targets.length) { toast("コピー先を選んでください", true); return; }
      const mode = form.querySelector("[name=mode]:checked").value;
      if (mode === "mirror" && !cfm("コピー先から、このサーバーに無いアドオンを取り除きます。よろしいですか?")) return;
      try { jobStarted(await api(`/api/servers/${s.id}/copy`, { json: { targets, mode } })); done(true); } catch (ex) { toast(ex.message, true); }
    });
  });
  if (r) loadServers();
}

/* ワールドのバックアップ */
async function worldsDialog(s, container = null) {
  const ro = s.access === "view";
  await host(container, `「${s.name}」のワールド`, `<div class="db" id="wbBody"><div class="empty"><span class="spinner lg"></span></div></div>`, async (form) => {
    const body = $("#wbBody", form);
    const load = async () => {
      let d;
      try { d = await api(`/api/servers/${s.id}/worlds`); } catch (ex) { body.innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
      body.innerHTML = `<p>ワールド(ネザー・エンドを含む)をまとめて、保存先「${esc(d.storage)}」に保存します。新しいものから ${d.keep} 個を残します。${s.has_rcon ? "RCON で書き込みを止めてから保存します。" : "RCON を設定すると、書き込みを止めてから保存するので安全です。"}</p>
        ${ro ? "" : `<button class="btn filled block" type="button" data-wb="now">${icon("download")}今すぐバックアップ</button>`}
        <div class="group-title">保存したもの</div>
        <div class="group">${d.backups.map((x) => `<div class="row noicon"><span class="main"><span class="title" translate="no">${esc(x.name)}</span></span>
          <span class="trail"><a class="icon-btn sm" href="/api/servers/${s.id}/worlds/${encodeURIComponent(x.name)}" download title="ダウンロード" aria-label="ダウンロード">${icon("download")}</a>
          ${ro ? "" : `<button class="icon-btn sm danger" type="button" data-wdel="${esc(x.name)}" title="削除" aria-label="削除">${icon("trash")}</button>`}</span></div>`).join("") || `<div class="empty">まだありません</div>`}</div>
        <div class="group-foot">定期的なバックアップは「設定」→「ワールドのバックアップ」で設定できます。</div>`;
    };
    body.addEventListener("click", async (e) => {
      const now = e.target.closest("[data-wb]");
      if (now) {
        await busy(now, async () => {
          try { const j = await api(`/api/servers/${s.id}/worlds`, { method: "POST" }); jobStarted(j); const r = await waitJob(j.id); if (r && r.status === "done") toast("ワールドを保存しました"); else if (r) toast((r.log || []).slice(-1)[0] || "保存できませんでした", true); await load(); }
          catch (ex) { toast(ex.message, true); }
        }, "保存中…");
      }
      const del = e.target.closest("[data-wdel]");
      if (del && cfm(`${del.dataset.wdel} を削除しますか?`)) {
        try { await api(`/api/servers/${s.id}/worlds/${encodeURIComponent(del.dataset.wdel)}`, { method: "DELETE" }); toast("削除しました"); await load(); } catch (ex) { toast(ex.message, true); }
      }
    });
    await load();
  }, { wide: true });
}

/* 設定(グループごと) */
async function serverSettingsDialog(s, container = null) {
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  const local = s.kind === "local", sys_ = can("system");
  const setOpts = `<option value="">なし</option>${state.sets.map((x) => `<option value="${x.id}"${x.id === s.set_id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}`;
  const others = (state.servers || []).filter((x) => x.id !== s.id && x.access !== "view");
  const timeRow = (prefix, mode, dow, time) => `<div class="chips" data-${prefix}row>
      <select name="${prefix}_dow" class="compact">${DOW.map((d, i) => `<option value="${i}"${Number(dow) === i ? " selected" : ""}>${d}曜日</option>`).join("")}</select>
      <input type="time" name="${prefix}_time" value="${esc(time || "04:00")}" class="compact-time"></div>`;
  const sec = (id, title, html, open = false) => `<details class="set-sec"${open ? " open" : ""} data-sec="${id}"><summary>${title}${icon("chev")}</summary><div class="set-sec-b">${html}</div></details>`;
  const r = await host(container, `「${s.name}」の設定`, `<div class="db srv-settings">
      ${sec("basic", "基本", `
        ${field("表示名", `<input type="text" name="name" value="${esc(s.name)}">`)}
        ${local ? field("サーバーのフォルダ", `<div class="inline-input"><input type="text" name="root_dir" value="${esc(s.root_dir || "")}"${sys_ ? "" : " readonly"} spellcheck="false"><button class="btn tinted small" type="button" data-detect>${icon("search")}判定</button></div>`)
          : `<div class="inline-input" style="margin-bottom:10px"><span class="muted" style="flex:1">サーバーのフォルダの中身から、サーバーソフト・バージョン・フォルダを判定できます</span><button class="btn tinted small" type="button" data-detect>${icon("search")}判定</button></div>`}
        <div class="detect-out" data-dtout></div>
        ${field("MC のバージョン(対応していないバージョンを入れないために使います)", `<input type="text" name="mc_version" value="${esc(s.mc_version || "")}" placeholder="例: 1.21.4" inputmode="decimal">`)}
        ${srvFields(s)}
        ${field("セット(同期のときに、セットの中身もサーバーに入れる)", `<select name="set_id">${setOpts}</select>`)}`, true)}
      ${sec("update", "更新の受け取り方", `
        <div class="group">
          ${toggle("auto_update", "自動で最新にする", "ライブラリに新しいバージョンが入ったら、このサーバーへ自動で同期します(6 時間ごとに確認。見送り中・対応していないバージョンは入れません)", s.auto_update === "auto")}
          ${toggle("backup_config", "プラグインの設定フォルダも退避する", "入れ替えるときに plugins/<名前>/ も保存し、巻き戻しで設定まで戻せるようにします", !!s.backup_config)}
          ${canPower(s) ? toggle("sched_restart", "自動・予約の同期のあとに再起動", "更新があったときだけ再起動します", !!s.sched_restart) : ""}
        </div>
        ${field("予約同期(決まった時刻に同期)", `<select name="sched_mode"><option value="off"${s.sched_mode === "off" ? " selected" : ""}>しない</option><option value="daily"${s.sched_mode === "daily" ? " selected" : ""}>毎日</option><option value="weekly"${s.sched_mode === "weekly" ? " selected" : ""}>毎週</option></select>`)}
        ${timeRow("sched", s.sched_mode, s.sched_dow, s.sched_time)}`)}
      ${sec("status", "状態・RCON", `
        <p class="muted">アドレスを入れると、稼働状況・人数・バージョンを表示します${s.kind === "ptero" ? "(空なら Pterodactyl の割り当てを使います)" : "(空ならこの PC の server-port に問い合わせます)"}。RCON を設定すると、ワールドの保存の前に書き込みを止めたり、停止に使ったりできます。</p>
        ${field("サーバーのアドレス", `<input type="text" name="address" value="${esc(s.address || "")}" placeholder="例: play.example.com:25565" autocomplete="off" spellcheck="false">`)}
        <div class="two-col">${field("RCON のポート", `<input type="number" name="rcon_port" value="${s.rcon_port || ""}" placeholder="25575" min="1" max="65535">`)}
        ${field(`RCON のパスワード${s.has_rcon ? "(設定済み)" : ""}`, `<input type="password" name="rcon_password" placeholder="${s.has_rcon ? "変えるときだけ入力" : "server.properties の rcon.password"}" autocomplete="new-password">`)}</div>
        <div class="chips"><button class="btn small tinted" type="button" data-rcontest>${icon("check")}RCON を試す</button>${s.has_rcon ? `<button class="btn small plain" type="button" data-rconclear>RCON の設定を消す</button>` : ""}</div>`)}
      ${local ? sec("power", "起動・停止", sys_ ? `
        <p class="muted">このパネルからサーバーを起動・停止する方法を選びます(設定できるのは「パネル全体の設定」の権限がある人だけです)。</p>
        ${field("方法", `<select name="control"><option value="none"${s.control === "none" ? " selected" : ""}>しない</option><option value="command"${s.control === "command" ? " selected" : ""}>コマンドを実行する</option><option value="docker"${s.control === "docker" ? " selected" : ""}>Docker のコンテナを操作する</option></select>`)}
        <div data-ctl="command">
          ${field("起動のコマンド(サーバーのフォルダで実行)", `<input type="text" name="start_cmd" value="${esc(s.start_cmd || "")}" placeholder="${s.server_jar ? esc(`java -Xms1G -Xmx4G -jar ${s.server_jar} nogui`) : "例: systemctl start minecraft / ./start.sh"}" spellcheck="false">`)}
          ${field("停止のコマンド(空なら RCON の stop)", `<input type="text" name="stop_cmd" value="${esc(s.stop_cmd || "")}" placeholder="例: systemctl stop minecraft" spellcheck="false">`)}
        </div>
        <div data-ctl="docker">
          ${field("コンテナ名", `<input type="text" name="container" value="${esc(s.container || "")}" placeholder="例: minecraft" spellcheck="false">`)}
          ${state.dockerOk ? "" : `<div class="result warn">Docker を操作するには、CraftShelf のコンテナに /var/run/docker.sock をマウントしてください</div>`}
        </div>` : `<p class="muted">起動・停止の方法は、「パネル全体の設定」の権限がある人が設定できます。</p>`) : ""}
      ${sec("world", "ワールドのバックアップ", `
        ${field("定期的に保存", `<select name="world_mode"><option value="off"${s.world_mode === "off" ? " selected" : ""}>しない</option><option value="daily"${s.world_mode === "daily" ? " selected" : ""}>毎日</option><option value="weekly"${s.world_mode === "weekly" ? " selected" : ""}>毎週</option></select>`)}
        ${timeRow("world", s.world_mode, s.world_dow, s.world_time || "05:00")}
        ${field("残す数", `<input type="number" name="world_keep" value="${s.world_keep || 5}" min="1" max="50">`)}`)}
      ${others.length ? sec("stage", "検証用サーバー", `
        <p class="muted">このサーバーで先に試し、問題なければ「本番へ反映」でほかのサーバーへ広げます。反映先(本番)を選んでください。</p>
        <div class="group">${others.map((x) => `<label class="toggle-row"><span class="main" translate="no">${esc(x.name)}</span><input type="checkbox" class="switch" data-stg="${x.id}"${(s.stage_targets || []).includes(x.id) ? " checked" : ""}></label>`).join("")}</div>`) : ""}
      <button class="btn danger block" type="button" data-unlink>${local ? "このサーバーを一覧から外す" : "連携を解除"}</button>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>保存</button></div>`, (form, done) => {
    const q = (n) => form.querySelector(`[name=${n}]`);
    const syncRows = () => {
      for (const p of ["sched", "world"]) {
        const m = q(`${p}_mode`).value, row = form.querySelector(`[data-${p}row]`);
        row.hidden = m === "off"; q(`${p}_dow`).hidden = m !== "weekly";
      }
      const ctl = q("control");
      if (ctl) form.querySelectorAll("[data-ctl]").forEach((el) => { el.hidden = el.dataset.ctl !== ctl.value; });
      // 追加のときに選んだ jar から、起動のコマンドを入れておく
      if (ctl && ctl.value === "command" && s.server_jar && !q("start_cmd").value) q("start_cmd").value = `java -Xms1G -Xmx4G -jar ${s.server_jar} nogui`;
    };
    form.addEventListener("change", syncRows); syncRows();
    wireSrvFields(form, () => (local ? { kind: "local", root_dir: q("root_dir").value.trim() } : { server_id: s.id }), (r) => { if (r.mc && !q("mc_version").value) q("mc_version").value = r.mc; });
    form.querySelector("[data-rcontest]").onclick = (ev) => busy(ev.currentTarget, async () => {
      try {
        if (q("rcon_password").value || Number(q("rcon_port").value) !== (s.rcon_port || 0)) {
          await api(`/api/servers/${s.id}`, { method: "PATCH", json: { rcon_port: Number(q("rcon_port").value || 0), rcon_password: q("rcon_password").value, address: q("address").value.trim() } });
        }
        const r = await api(`/api/servers/${s.id}/rcon`, { method: "POST" });
        toast(`つながりました: ${r.message}`);
      } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-rconclear]")?.addEventListener("click", async () => {
      try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: { rcon_clear: true } }); toast("RCON の設定を消しました"); done("saved"); } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const d = { name: q("name").value, set_id: q("set_id").value, mc_version: q("mc_version").value.trim(), address: q("address").value.trim(),
        rcon_port: Number(q("rcon_port").value || 0), software: q("software").value, dirs: readDirs(form),
        sched_mode: q("sched_mode").value, sched_time: q("sched_time").value, sched_dow: Number(q("sched_dow").value || 0),
        auto_update: form.querySelector("[name=auto_update]").checked ? "auto" : "off", backup_config: form.querySelector("[name=backup_config]").checked,
        world_mode: q("world_mode").value, world_time: q("world_time").value, world_dow: Number(q("world_dow").value || 0), world_keep: Number(q("world_keep").value || 5) };
      if (q("rcon_password").value) d.rcon_password = q("rcon_password").value;
      if (form.querySelector("[name=sched_restart]")) d.sched_restart = form.querySelector("[name=sched_restart]").checked;
      if (others.length) d.stage_targets = [...form.querySelectorAll("[data-stg]:checked")].map((c) => Number(c.dataset.stg));
      if (local && sys_) {
        if (q("root_dir").value.trim() !== (s.root_dir || "")) d.root_dir = q("root_dir").value.trim();
        if (q("control")) { d.control = q("control").value; d.start_cmd = q("start_cmd").value; d.stop_cmd = q("stop_cmd").value; d.container = q("container").value; }
      }
      if (JSON.stringify(d.dirs) === JSON.stringify(Object.fromEntries(SRV_CATS.filter((c) => (s.dirs || {})[c]).map((c) => [c, s.dirs[c]])))) delete d.dirs;
      if (d.auto_update === "auto" && (s.staged_from || []).length && !cfm("このサーバーは検証用サーバーからの反映先です。自動更新をオンにすると、検証の前に更新されます。よろしいですか?")) return;
      try { await api(`/api/servers/${s.id}`, { method: "PATCH", json: d }); done("saved"); } catch (ex) { toast(ex.message, true); }
    });
    form.querySelector("[data-unlink]").onclick = async (ev) => {
      if (!cfm(`「${s.name}」を一覧から外しますか?(サーバーのファイルはそのままです)`)) return;
      await busy(ev.currentTarget, async () => { try { await api(`/api/servers/${s.id}`, { method: "DELETE" }); done("deleted"); } catch (ex) { toast(ex.message, true); } });
    };
  }, { wide: true });
  if (r) { toast(r === "deleted" ? "一覧から外しました" : "保存しました"); if (r === "deleted") state.srvOpen = null; loadServers(); }
}
/* 履歴の 1 回分: ファイル名からアドオンの名前とバージョンを読み、入れ替え(更新)・追加・外したを 1 行ずつ */
function splitJar(path) {
  const file = String(path).split("/").pop();
  const dir = String(path).includes("/") ? String(path).slice(0, String(path).lastIndexOf("/")) : "";
  const m = file.replace(/\.disabled$/i, "").match(/^(.*?)[-_ ]v?(\d[\w.+\-]*?)(?:[-_](?:bukkit|paper|spigot|fabric|forge|neoforge|velocity))?\.(jar|zip)$/i);
  const name = m ? m[1] : file.replace(/\.(jar|zip)(\.disabled)?$/i, "");
  return { file, dir, name, ver: m ? m[2] : "", key: name.toLowerCase().replace(/[-_ ](bukkit|paper|spigot|fabric|forge|neoforge|velocity)$/i, "").replace(/[^a-z0-9]/g, "") };
}
function snapChanges(x) {
  const added = x.added.map(splitJar), removed = x.removed.map((r) => splitJar(r.name));
  const out = [];
  for (const a of added) {
    const i = removed.findIndex((r) => r.key && r.key === a.key);
    if (i >= 0) { out.push({ kind: "upd", name: a.name, from: removed[i].ver, to: a.ver, dir: a.dir }); removed.splice(i, 1); }
    else out.push({ kind: "add", name: a.name, to: a.ver, dir: a.dir });
  }
  for (const r of removed) out.push({ kind: "del", name: r.name, from: r.ver, dir: r.dir });
  return out;
}
const SNAP_KIND = { upd: ["更新", "refresh"], add: ["追加", "plus"], del: ["外した", "minus"] };
function snapCardHTML(x) {
  const ch = snapChanges(x);
  const n = (k) => ch.filter((c) => c.kind === k).length;
  const sum = ["upd", "add", "del"].filter((k) => n(k)).map((k) => `<span class="snap-n ${k}">${SNAP_KIND[k][0]} ${n(k)}</span>`).join("");
  const row = (c) => `<div class="snap-row ${c.kind}"><span class="snap-k">${icon(SNAP_KIND[c.kind][1])}</span>
    <span class="snap-name" translate="no">${esc(c.name)}</span>
    <span class="snap-ver mono" translate="no">${c.kind === "upd" ? `${esc(c.from || "?")} → <b>${esc(c.to || "?")}</b>` : c.kind === "add" ? esc(c.to || "") : `<s>${esc(c.from || "")}</s>`}</span>
    ${c.dir ? `<span class="snap-dir" translate="no">${esc(c.dir)}</span>` : ""}</div>`;
  const head = ch.slice(0, 8), rest = ch.slice(8);
  return `<div class="card snap-card"><div class="snap-h">
      <div class="snap-t"><h4>${esc(x.title || "同期")}</h4><span class="muted small">${esc(fmtDateTime(x.created_at))}</span></div>
      ${x.rolled_back ? `<span class="badge">${esc(fmtDateTime(x.rolled_back))} に巻き戻し済み</span>`
        : `<button class="btn small tinted need-editor" type="button" data-rb="${x.id}">${icon("back")}この前の状態に戻す</button>`}</div>
    ${sum ? `<div class="snap-sum">${sum}</div>` : ""}
    <div class="snap-list">${head.map(row).join("")}${rest.length ? `<details class="snap-more"><summary>ほか ${rest.length} 件</summary>${rest.map(row).join("")}</details>` : ""}
      ${ch.length ? "" : `<div class="muted small" style="padding:6px 2px">入れ替えたファイルはありません</div>`}</div></div>`;
}
async function snapshotsDialog(s, container = null) {
  await host(container, `「${s.name}」の履歴`, `<div class="db" id="snBody"><div class="empty"><span class="spinner lg"></span></div></div>`, async (form, done) => {
    let d;
    try { d = await api(`/api/servers/${s.id}/snapshots`); } catch (ex) { $("#snBody", form).innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
    $("#snBody", form).innerHTML = `<p>同期・転送のたびに、置き換えたファイルを退避しています(直近 10 回分)。「この前の状態に戻す」で、その同期の前に戻せます。</p>
      ${d.snapshots.length ? d.snapshots.map(snapCardHTML).join("") : `<div class="empty">まだ履歴がありません</div>`}`;
    form.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-rb]"); if (!b) return;
      const restart = cfm("巻き戻したあとにサーバーを再起動しますか?(キャンセルで再起動しない)");
      try { jobStarted(await api(`/api/servers/${s.id}/snapshots/${b.dataset.rb}/rollback`, { json: { restart } })); done(null); }
      catch (ex) { toast(ex.message, true); }
    });
  }, { wide: true });
}

/* ---------------- サーバーの比較(Apple の製品比較のように横並び) ---------------- */
async function renderCompare() {
  const list = state.servers || [];
  const body = $("#srvBody");
  if (list.length < 2) { body.innerHTML = `<div class="card"><div class="empty"><div class="big">⚖️</div>比較するには 2 台以上のサーバーを連携してください</div></div>`; return; }
  state.cmpSel = state.cmpSel || list.slice(0, 4).map((s) => s.id);
  body.innerHTML = `<div class="cmp-pick">${list.map((s) => `<button class="seg" type="button" data-cmp="${s.id}" aria-pressed="${state.cmpSel.includes(s.id)}">${esc(s.name)}</button>`).join("")}
      <label class="cmp-diff"><input type="checkbox" class="switch" id="cmpDiff"${state.cmpDiff ? " checked" : ""}> 違いだけ表示</label></div>
    <div id="cmpTable"><div class="empty"><span class="spinner lg"></span><p>各サーバーの中身を確認しています…</p></div></div>`;
  body.querySelectorAll("[data-cmp]").forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.cmp);
    state.cmpSel = state.cmpSel.includes(id) ? state.cmpSel.filter((x) => x !== id) : [...state.cmpSel, id];
    renderCompare();
  });
  $("#cmpDiff").onchange = (e) => { state.cmpDiff = e.target.checked; drawCompare(); };
  const sel = list.filter((s) => state.cmpSel.includes(s.id));
  state.cmpData = {};
  await Promise.all(sel.map(async (s) => {
    try { state.cmpData[s.id] = await api(`/api/servers/${s.id}/inventory`); }
    catch (ex) { state.cmpData[s.id] = { error: ex.message, files: [], missing: [] }; }
  }));
  drawCompare();
}
function drawCompare() {
  const sel = (state.servers || []).filter((s) => (state.cmpSel || []).includes(s.id));
  const box = $("#cmpTable"); if (!box) return;
  if (!sel.length) { box.innerHTML = `<div class="empty">比較するサーバーを選んでください</div>`; return; }
  state.cmpPick = state.cmpPick || new Map();   // "サーバーID:アイテムID" → 導入する
  state.cmpBusy = state.cmpBusy || new Map();   // "サーバーID:行のキー" → 順番待ち / 処理中
  const rows = new Map();
  for (const s of sel) {
    for (const f of (state.cmpData[s.id] || {}).files || []) {
      const key = f.item_id ? `i${f.item_id}` : `n${(f.plugin_name || f.name).toLowerCase().replace(/[\W_]+/g, "")}`;
      if (!rows.has(key)) rows.set(key, { key, name: f.item_name || f.plugin_name || f.name, item_id: f.item_id, latest: f.latest_version, category: f.category, cells: {} });
      rows.get(key).cells[s.id] = f;
    }
  }
  let list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const differs = (r) => { const vals = sel.map((s) => (r.cells[s.id] ? r.cells[s.id].version || "?" : "-")); return new Set(vals).size > 1; };
  if (state.cmpDiff) list = list.filter(differs);
  const canEdit = (s) => s.access !== "view";
  const cell = (s, r) => {
    const f = r.cells[s.id];
    const busyK = `${s.id}:${r.key}`;
    if (state.cmpBusy.has(busyK)) return `<td class="cmp-cell"><span class="badge pend">${state.cmpBusy.get(busyK) === "running" ? '<span class="spinner"></span>処理中' : `${icon("clock")}順番待ち`}</span></td>`;
    if (!f) {
      const can = r.item_id && canEdit(s) && (s.dirs || {})[r.category];
      if (!can) return `<td class="cmp-cell none"><span class="cmp-dash">—</span></td>`;
      const on = state.cmpPick.has(`${s.id}:${r.item_id}`);
      return `<td class="cmp-cell none pickable${on ? " on" : ""}"><button type="button" class="cmp-add" data-cpick="${s.id}:${r.item_id}" aria-pressed="${on}" title="このサーバーに導入する">${icon(on ? "check" : "plus")}<span>${on ? "導入する" : "導入"}</span></button></td>`;
    }
    const cls = f.status === "latest" ? "ok" : f.status === "outdated" ? "upd" : f.status === "unregistered" ? "unk" : f.status === "newer" ? "acc" : "";
    const sub = { outdated: `→ ${esc(r.latest || "")}`, unregistered: "未登録", different: "別のファイル", newer: "サーバーの方が新しい", disabled: "無効" }[f.status] || "最新";
    return `<td class="cmp-cell${canEdit(s) ? " act" : ""}${f.status === "disabled" ? " dim" : ""}"${canEdit(s) ? ` data-ccell="${s.id}" data-path="${esc(f.path)}" role="button" tabindex="0" title="操作を選ぶ"` : ""}>
      <span class="cmp-mark ${cls}">${icon(f.status === "outdated" ? "refresh" : "check")}</span><div class="cmp-ver">${esc(f.version || "?")}</div><div class="cmp-sub">${sub}</div></td>`;
  };
  const picks = [...state.cmpPick.keys()];
  box.innerHTML = `<div class="cmp-wrap"><table class="cmp">
    <thead><tr><th class="cmp-name"></th>${sel.map((s) => {
      const d = state.cmpData[s.id] || {};
      return `<th><div class="cmp-head"><span class="cicon c-teal">${icon(s.kind === "local" ? "folder" : "server")}</span><div class="cmp-title">${esc(s.name)}</div>
        <div class="cmp-sub">${d.error ? esc(d.error) : `${(d.files || []).length} 個 · ${esc(dirsLabel(s))}`}</div>
        ${d.files && d.files.some((f) => f.status === "outdated") ? `<span class="badge upd">更新あり ${d.files.filter((f) => f.status === "outdated").length}</span>` : d.error ? "" : '<span class="badge ok">最新</span>'}</div></th>`;
    }).join("")}</tr></thead>
    <tbody>${list.map((r) => `<tr class="${differs(r) ? "diff" : ""}"><th class="cmp-name">${r.item_id ? `<button class="linkish" type="button" data-open="${r.item_id}">${esc(r.name)}</button>` : esc(r.name)}</th>${sel.map((s) => cell(s, r)).join("")}</tr>`).join("")
      || `<tr><td colspan="${sel.length + 1}"><div class="empty">${state.cmpDiff ? "違いはありません 🎉" : "プラグインがありません"}</div></td></tr>`}</tbody>
  </table></div>
  <p class="group-foot">「導入」を押すと、そのサーバーに入れるものとして選べます。入っているものを押すと、更新・バージョンの変更・削除などができます。</p>
  ${picks.length ? `<div class="cmp-bar"><span><b>${picks.length} 件</b>を導入します</span><span class="sp"></span>
    <button class="btn small plain" type="button" data-cclear>選択を解除</button><button class="btn small filled" type="button" data-cinstall>${icon("download")}導入する</button></div>` : ""}`;
  box.onclick = cmpClick;
}
/* 比較の表から操作したとき: 順番待ちで実行して、終わったらそのサーバーの列だけ読み直す */
async function cmpRun(sid, keys, call, label) {
  keys.forEach((k) => state.cmpBusy.set(`${sid}:${k}`, "queued")); drawCompare();
  try {
    const j = await call();
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      let x; try { x = await api(`/api/jobs/${j.id}`); } catch { break; }
      if (x.status === "running" && keys.some((k) => state.cmpBusy.get(`${sid}:${k}`) !== "running")) { keys.forEach((k) => state.cmpBusy.set(`${sid}:${k}`, "running")); drawCompare(); }
      if (!["running", "queued"].includes(x.status)) {
        if (x.status === "done") toast(label); else toast((x.log || []).filter((y) => !y.startsWith("完了")).slice(-1)[0] || "できませんでした", true);
        break;
      }
    }
  } catch (ex) { toast(ex.message, true); }
  keys.forEach((k) => state.cmpBusy.delete(`${sid}:${k}`));
  try { state.cmpData[sid] = await api(`/api/servers/${sid}/inventory`); } catch { /* 前の内容のまま */ }
  pollJobs(); drawCompare();
}
/* サーバーに入っているアドオンのバージョンを変える(ライブラリにあるバージョン → 無ければ配布元から取得して入れる) */
const normVer = (v) => String(v || "").trim().replace(/^v/i, "").toLowerCase();
const isCurVer = (v, f) => (f.version_id ? v.id === f.version_id : normVer(v.version) === normVer(f.version));
function prevVersionOf(it, f) {
  const i = it.versions.findIndex((v) => isCurVer(v, f));
  return i >= 0 ? it.versions[i + 1] || null : null;
}
async function changeVersionSheet(s, f, run) {
  const it = state.items.find((i) => i.id === f.item_id);
  if (!it) return;
  const so = it.source;
  const local = it.versions;
  const haveVer = new Set(local.map((v) => normVer(v.version)));
  const cur = local.findIndex((v) => isCurVer(v, f));
  let remote = null, picked = null;  // picked = { local: version_id } か { remote: index }
  const choice = await sheet(`${sheetHead(`「${it.name}」のバージョンを変える`)}<div class="db">
      <p class="muted small" style="margin-top:0" translate="no">${esc(s.name)}${s.mc_version ? ` · MC ${esc(s.mc_version)}` : ""} · 今は ${esc(f.version || "?")}</p>
      <div class="group-title">ライブラリに保存しているバージョン</div>
      <div class="group">${local.map((v, i) => `<label class="toggle-row"><span class="main"><b translate="no">${esc(verLabel(v.version))}</b>
          ${i === 0 ? ' <span class="badge ok">最新</span>' : ""}${isCurVer(v, f) ? ' <span class="badge">今のバージョン</span>' : ""}${cur >= 0 && i === cur + 1 ? ' <span class="badge">ひとつ前</span>' : ""}
          <small translate="no">${esc(fmtDate(v.added_at || v.created_at || ""))}${v.filename ? ` · ${esc(v.filename)}` : ""}</small></span>
          <input type="radio" class="switch" name="cv" value="l${v.id}"${isCurVer(v, f) ? " disabled" : ""}></label>`).join("")}</div>
      ${so ? `<div class="group-title">配布元(${esc(PROVIDERS[so.provider] || so.provider)})のバージョン <small>ライブラリに無いもの</small></div>
        <div class="group" id="cvRemote"><div class="empty"><span class="spinner"></span></div></div>` : ""}
      <p class="muted small">${icon("shield")} 今のバージョンは退避され、「保存」→「履歴と巻き戻し」からいつでも戻せます。反映には再起動が要ります。</p>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>このバージョンにする</button></div>`, (form, done) => {
    const ok = form.querySelector("[data-ok]");
    const label = () => {
      const c = form.querySelector("[name=cv]:checked");
      if (!c) { ok.textContent = "このバージョンにする"; return; }
      const v = c.value.startsWith("l") ? local.find((x) => x.id === Number(c.value.slice(1))).version : remote[Number(c.value.slice(1))].version;
      ok.textContent = c.value.startsWith("r") ? `${v} を取得して入れる` : `${v} にする`;
    };
    const prev = cur >= 0 ? local[cur + 1] : null;
    const first = form.querySelector(prev ? `[value="l${prev.id}"]` : "[name=cv]:not([disabled])");
    if (first) first.checked = true;
    label();
    form.addEventListener("change", (e) => { if (e.target.name === "cv") label(); });
    ok.onclick = () => {
      const c = form.querySelector("[name=cv]:checked");
      if (!c) { toast("バージョンを選んでください", true); return; }
      done(c.value.startsWith("l") ? { local: Number(c.value.slice(1)) } : { remote: Number(c.value.slice(1)) });
    };
    if (so) {
      const p = new URLSearchParams({ provider: so.provider, project_id: so.project_id, loader: SEARCH_LOADERS[s.software] ? s.software : "", mc: s.mc_version || "" });
      api(`/api/search/versions?${p}`).then((d) => {
        remote = d.versions.filter((v) => !haveVer.has(normVer(v.version)));
        const box = $("#cvRemote", form);
        if (!box) return;
        box.innerHTML = remote.length ? remote.slice(0, 30).map((v, i) => `<label class="toggle-row"><span class="main"><b translate="no">${esc(v.version)}</b>
            ${v.type && v.type !== "release" ? ` <span class="badge upd">${esc(v.type === "beta" ? "ベータ" : v.type === "alpha" ? "アルファ" : v.type)}</span>` : ""}
            <small>${v.date ? esc(fmtDate(v.date)) : ""}${(v.game_versions || []).length ? ` · MC ${esc(summarizeMc(v.game_versions))}` : ""}${v.downloadable ? "" : " · 自動では取得できません"}</small></span>
            <input type="radio" class="switch" name="cv" value="r${i}"${v.downloadable ? "" : " disabled"}></label>`).join("")
          : `<div class="empty">ライブラリに無いバージョンは見つかりませんでした${s.mc_version ? `(MC ${esc(s.mc_version)} に対応するもの)` : ""}</div>`;
      }).catch((ex) => { const box = $("#cvRemote", form); if (box) box.innerHTML = `<div class="empty">${esc(ex.message)}</div>`; });
    }
  });
  if (!choice) return;
  if (choice.local) {
    await run(() => api(`/api/servers/${s.id}/push`, { json: { item_ids: [it.id], version_ids: { [it.id]: choice.local }, force: true } }), "バージョンを変えました");
    return;
  }
  const v = remote[choice.remote];
  const t = toastProgress(`${v.version} を取得しています…`);
  try {
    const d = await api("/api/import", { json: { provider: so.provider, project_id: so.project_id, version_id: v.version_id, category: it.category } });
    await refresh();
    await run(() => api(`/api/servers/${s.id}/push`, { json: { item_ids: [d.item_id], version_ids: { [d.item_id]: d.version_id }, force: true } }), `${v.version} に変えました`);
  } catch (ex) { toast(ex.message, true); }
  finally { t.remove(); }
}
async function cmpChooseVersion(s, f) {
  await changeVersionSheet(s, f, (p, label) => cmpRun(s.id, [`i${f.item_id}`], p, label));
}
async function cmpClick(e) {
  const o = e.target.closest("[data-open]"); if (o) { openPanel(Number(o.dataset.open)); return; }
  const pk = e.target.closest("[data-cpick]");
  if (pk) { const k = pk.dataset.cpick; if (state.cmpPick.has(k)) state.cmpPick.delete(k); else state.cmpPick.set(k, true); drawCompare(); return; }
  if (e.target.closest("[data-cclear]")) { state.cmpPick.clear(); drawCompare(); return; }
  if (e.target.closest("[data-cinstall]")) {
    const by = new Map();
    for (const k of state.cmpPick.keys()) { const [sid, iid] = k.split(":").map(Number); if (!by.has(sid)) by.set(sid, []); by.get(sid).push(iid); }
    state.cmpPick.clear();
    for (const [sid, ids] of by) cmpRun(sid, ids.map((i) => `i${i}`), () => api(`/api/servers/${sid}/push`, { json: { item_ids: ids } }), `${(state.servers.find((x) => x.id === sid) || {}).name} に導入しました`);
    return;
  }
  const c = e.target.closest("[data-ccell]"); if (!c) return;
  const s = state.servers.find((x) => x.id === Number(c.dataset.ccell));
  const f = ((state.cmpData[s.id] || {}).files || []).find((x) => x.path === c.dataset.path); if (!f) return;
  const key = f.item_id ? `i${f.item_id}` : `n${(f.plugin_name || f.name).toLowerCase().replace(/[\W_]+/g, "")}`;
  const it = f.item_id && state.items.find((i) => i.id === f.item_id);
  openMenu(c, [
    ...(f.item_id && ["outdated", "different"].includes(f.status) ? [{ label: `最新(${f.latest_version || ""})に更新`, icon: "refresh", run: () => cmpRun(s.id, [key], () => api(`/api/servers/${s.id}/push`, { json: { item_ids: [f.item_id], force: f.compat === false } }), "更新しました") }] : []),
    ...(it ? [{ label: "バージョンを変える…", icon: "arrows", run: () => cmpChooseVersion(s, f) }] : []),
    ...(["unregistered", "newer"].includes(f.status) ? [{ label: "ライブラリに取り込む", icon: "download", run: () => cmpRun(s.id, [key], () => api(`/api/servers/${s.id}/import`, { json: { names: [f.path] } }), "取り込みました").then(() => refresh()) }] : []),
    { label: f.status === "disabled" ? "有効にする" : "無効にする(消さずに外す)", icon: f.status === "disabled" ? "check" : "eyeoff", run: async () => {
      try { await api(`/api/servers/${s.id}/toggle`, { json: { path: f.path, enable: f.status === "disabled" } }); toast("切り替えました。反映には再起動が必要です"); state.cmpData[s.id] = await api(`/api/servers/${s.id}/inventory`); drawCompare(); } catch (ex) { toast(ex.message, true); }
    } },
    ...(it ? [{ label: "ライブラリで開く", icon: "box", run: () => openPanel(it.id) }] : []),
    "-",
    { label: "このサーバーから削除", icon: "trash", danger: true, run: async () => {
      if (!await confirmSheet(`「${s.name}」から ${f.item_name || f.name} を削除しますか?`, "ファイルは退避されるので、「履歴」から元に戻せます。反映には再起動が必要です。", "削除")) return;
      cmpRun(s.id, [key], () => api(`/api/servers/${s.id}/remove`, { json: { paths: [f.path] } }), "削除しました");
    } },
  ]);
}

const INV_STATUS = { latest: ["ok", "最新"], outdated: ["upd", "更新あり"], different: ["", "ライブラリと別のファイル"], unregistered: ["err", "未登録"] };
/* ライブラリから選んでサーバーへ入れる(バージョンも選べる) */
async function libraryToServer(s, cats, onServer, kind = "") {
  const have = new Map(onServer.filter((f) => f.item_id).map((f) => [f.item_id, f.version]));
  const pool = state.items.filter((it) => cats.includes(it.category) && it.access !== undefined).sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  let cat = kind, q = "";
  return sheet(`${sheetHead(`「${s.name}」に入れる`)}<div class="db">
      <label class="search"><span>${icon("search")}</span><input type="search" id="ltQ" placeholder="名前・タグで絞り込み"></label>
      ${cats.length > 1 ? `<div class="segmented seg-wide" id="ltCat">${["", ...cats].map((c) => `<button class="seg" type="button" data-c="${c}" aria-pressed="${c === cat}">${c ? CATS[c] : "すべて"}</button>`).join("")}</div>` : ""}
      <div class="group scroll" id="ltList"></div>
      <div class="lt-deps" id="ltDeps" hidden></div>
      <p class="group-foot">バージョンを選ばなければ、ライブラリの最新を入れます。同じアドオンの別のバージョンがサーバーにあれば置き換えます(退避されるので巻き戻せます)。</p>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>サーバーに入れる</button></div>`, (form, done) => {
    const picked = new Map();  // item_id → version_id(0 = 最新)
    let plan = null, withDeps = true, planSeq = 0, planTimer = null;
    /* 選んだアドオンの前提(前提の前提も)を調べて、一緒に入れるもの・足りないものを出す */
    const drawPlan = () => {
      const box = $("#ltDeps", form);
      if (!plan || (!plan.add.length && !plan.missing.length)) { box.hidden = true; box.innerHTML = ""; return; }
      box.hidden = false;
      box.innerHTML = `${plan.add.length ? `${toggle("lt_withdeps", `前提も一緒に入れる(${plan.add.length} 件)`, plan.add.map((a) => `${a.name}(${a.for} の前提)`).join("、"), withDeps)}` : ""}
        ${plan.missing.length ? `<div class="result warn">${icon("puzzle")} ライブラリに無い前提: ${plan.missing.map((m) => `<b translate="no">${esc(m.name)}</b>(${esc(m.for)})`).join("、")}。サーバーに無ければ、配布サイトから探して入れてください。</div>` : ""}`;
      const t = box.querySelector("[name=lt_withdeps]");
      if (t) t.onchange = () => { withDeps = t.checked; };
    };
    const refreshPlan = () => {
      clearTimeout(planTimer);
      planTimer = setTimeout(async () => {
        const seq = ++planSeq;
        if (!picked.size) { plan = null; drawPlan(); return; }
        try { const p = await api(`/api/servers/${s.id}/deps-plan`, { json: { item_ids: [...picked.keys()] } }); if (seq === planSeq) { plan = p; drawPlan(); } }
        catch { /* 前提の確認ができなくても入れられる */ }
      }, 250);
    };
    const draw = () => {
      const ql = q.toLowerCase();
      const list = pool.filter((it) => (!cat || it.category === cat) && (!ql || it.name.toLowerCase().includes(ql) || (it.tags || []).some((t) => t.toLowerCase().includes(ql))));
      $("#ltList", form).innerHTML = list.map((it) => `<div class="row lt-row${picked.has(it.id) ? " picked" : ""}">
        <input type="checkbox" class="cbox" data-lt="${it.id}"${picked.has(it.id) ? " checked" : ""} aria-label="選ぶ">${itemIcon(it, true)}
        <span class="main"><span class="title" translate="no">${esc(it.name)}${have.has(it.id) ? ` <span class="badge">サーバーに ${esc(have.get(it.id) || "")}</span>` : ""}</span>
          <span class="subtitle">${esc(CATS[it.category] || "")}${(it.tags || []).length ? ` · ${it.tags.map((t) => `#${esc(t)}`).join(" ")}` : ""}</span></span>
        <select class="compact" data-ltv="${it.id}" aria-label="入れるバージョン">${it.versions.map((v, i) => `<option value="${i ? v.id : 0}"${(picked.get(it.id) || 0) === (i ? v.id : 0) ? " selected" : ""}>${esc(verLabel(v.version))}${i ? "" : "(最新)"}</option>`).join("")}</select></div>`).join("")
        || `<div class="empty">あてはまるアドオンがありません</div>`;
      form.querySelector("[data-ok]").textContent = picked.size ? `${picked.size} 件をサーバーに入れる` : "サーバーに入れる";
    };
    $("#ltQ", form).addEventListener("input", (e) => { q = e.target.value.trim(); draw(); });
    form.addEventListener("click", (e) => {
      const c = e.target.closest("[data-c]");
      if (c) { cat = c.dataset.c; form.querySelectorAll("[data-c]").forEach((b) => b.setAttribute("aria-pressed", String(b === c))); draw(); return; }
      const row = e.target.closest(".lt-row");
      if (row && !e.target.closest("select") && !e.target.closest("[data-lt]")) { const cb = row.querySelector("[data-lt]"); cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    form.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-lt]");
      if (cb) { const id = Number(cb.dataset.lt); if (cb.checked) picked.set(id, Number(form.querySelector(`[data-ltv="${id}"]`).value)); else picked.delete(id); draw(); refreshPlan(); }
      const vs = e.target.closest("[data-ltv]");
      if (vs) { picked.set(Number(vs.dataset.ltv), Number(vs.value)); draw(); }
    });
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      if (!picked.size) { toast("入れるアドオンを選んでください", true); return; }
      const vmap = Object.fromEntries([...picked].filter(([, v]) => v));
      const ids = [...picked.keys(), ...(withDeps && plan ? plan.add.map((a) => a.id).filter((id) => !picked.has(id)) : [])];
      try {
        const j = await api(`/api/servers/${s.id}/push`, { json: { item_ids: ids, version_ids: vmap, force: true } });
        const r = await waitJob(j.id);
        if (r && r.status === "done") { toast(`${(r.result || {}).sent || 0} 件を「${s.name}」に入れました`); done(true); }
        else if (r) toast((r.log || []).slice(-1)[0] || "入れられませんでした", true);
      } catch (ex) { toast(ex.message, true); }
    }, "送信中…");
    draw();
  }, { wide: true });
}
/* 処理(ジョブ)が終わるまで待つ */
async function waitJob(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    let j;
    try { j = await api(`/api/jobs/${id}`); } catch { return null; }
    if (!["running", "queued"].includes(j.status)) { pollJobs(); return j; }
  }
}
/* サーバーの中身(種類ごとのタブ・1 件ずつの更新・見送り・無効化・対応バージョンの確認) */
async function inventoryDialog(s, startCat = "all", container = null) {
  let tab = startCat, filter = "all", tagF = "", sort = state.invSort || "status", d = null, selecting = false;
  const sel = new Set();
  const pending = new Map();  // "up:<item_id>" / "imp:<path>" → "queued" | "running"(押したものは順番に処理される)
  const ro = s.access === "view";
  await host(container, `「${s.name}」の中身`, `<div class="db" id="invBody"><div style="text-align:center;padding:24px"><span class="spinner lg"></span><p style="margin-top:10px">サーバーのファイルを確認しています…(初回はファイルを読み込むため時間がかかります)</p></div></div>`, async (form, done) => {
    const body = $("#invBody", form);
    const load = async () => {
      try { d = await api(`/api/servers/${s.id}/inventory`); } catch (e) { body.innerHTML = `<div class="result err">${esc(e.message)}</div>`; return; }
      sel.clear(); draw();
    };
    const itemOf = (f) => f.item_id && state.items.find((i) => i.id === f.item_id);
    const rowIcon = (f) => { const it = itemOf(f); return it ? itemIcon(it, true) : `<span class="cicon sm c-${f.category}">${catGlyph(f.category)}</span>`; };
    const STAT = { ...INV_STATUS, disabled: ["", "無効"], newer: ["acc", "サーバーの方が新しい"] };
    const tagsOf = (f) => (itemOf(f) || {}).tags || [];
    const nameOf = (f) => f.item_name || f.plugin_name || f.name;
    const warnOf = (f) => f.compat === false || f.held || f.status === "disabled";
    const draw = () => {
      const cats = SRV_CATS.filter((c) => d.dirs[c]);
      const inTab = (f) => tab === "all" || f.category === tab;
      const order = { outdated: 0, newer: 1, different: 2, unregistered: 3, latest: 4, disabled: 5 };
      const all = d.files.filter(inTab);
      const tags = [...new Set(all.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, "ja"));
      if (tagF && !tags.includes(tagF)) tagF = "";
      const pick = (f) => (filter === "all" || (filter === "upd" ? f.status === "outdated" : filter === "warn" ? warnOf(f) : filter === "newer" ? f.status === "newer" : f.status === "unregistered"))
        && (!tagF || tagsOf(f).includes(tagF));
      const cmp = {
        status: (a, b) => (order[a.status] - order[b.status]) || nameOf(a).localeCompare(nameOf(b), "ja", { numeric: true }),
        name: (a, b) => nameOf(a).localeCompare(nameOf(b), "ja", { numeric: true }),
        cat: (a, b) => SRV_CATS.indexOf(a.category) - SRV_CATS.indexOf(b.category) || nameOf(a).localeCompare(nameOf(b), "ja", { numeric: true }),
        tag: (a, b) => (tagsOf(a)[0] || "￿").localeCompare(tagsOf(b)[0] || "￿", "ja") || nameOf(a).localeCompare(nameOf(b), "ja", { numeric: true }),
        size: (a, b) => (b.size || 0) - (a.size || 0),
      }[sort];
      const files = all.filter(pick).sort(cmp);
      const missing = d.missing.filter(inTab);
      const syncable = d.files.filter((f) => f.status === "outdated" && !f.held && f.compat !== false).length + d.missing.filter((m) => !m.no_dir && !m.held && m.compat !== false).length;
      const count = (c) => d.files.filter((f) => c === "all" || f.category === c).length;
      const upd = (c) => d.files.filter((f) => (c === "all" || f.category === c) && f.status === "outdated").length;
      const fchip = (k, label, n) => n || k === "all" ? `<button class="tagchip" type="button" data-flt="${k}" aria-pressed="${filter === k}">${label}${k === "all" ? "" : ` ${n}`}</button>` : "";
      const wait = (k) => pending.has(k) ? `<span class="badge pend">${pending.get(k) === "running" ? '<span class="spinner"></span>処理中' : `${icon("clock")}順番待ち`}</span>` : "";
      const actBtn = (f) => {
        const pw = wait(`up:${f.item_id}`) || wait(`imp:${f.path}`);
        if (pw) return pw;
        if (ro) return `<span class="badge ${STAT[f.status][0]}">${STAT[f.status][1]}</span>`;
        if (f.status === "unregistered" || f.status === "newer") return `<button class="btn small tinted" type="button" data-imp1="${esc(f.path)}" title="このファイルをライブラリに取り込む">${icon("download")}取り込む</button>`;
        if (f.status === "disabled" || !f.item_id || !["outdated", "different"].includes(f.status)) return `<span class="badge ${STAT[f.status][0]}">${STAT[f.status][1]}</span>`;
        if (f.held) return `<span class="badge">見送り中</span>`;
        if (f.compat === false) return `<button class="btn small plain" type="button" data-up="${f.item_id}" data-force="1" title="MC ${esc(d.mc_version)} に対応していないバージョンです(対応: ${esc(f.compat_mc || "")})">${icon("download")}それでも入れる</button>`;
        return `<button class="btn small ${f.status === "outdated" ? "filled" : "tinted"}" type="button" data-up="${f.item_id}" title="ライブラリの最新(${esc(f.latest_version || "")})をこのサーバーに入れる">${icon("download")}${f.status === "outdated" ? "更新" : "最新に"}</button>`;
      };
      const picked = d.files.filter((f) => sel.has(f.path));
      const n = (fn) => picked.filter(fn).length;
      body.innerHTML = `
        <div class="segmented seg-wide inv-tabs" role="group" aria-label="種類">${["all", ...cats].map((c) => `<button class="seg" type="button" data-tab="${c}" aria-pressed="${c === tab}">${c === "all" ? "すべて" : CATS[c]}<span class="n">${count(c)}</span>${upd(c) ? `<i class="dot-upd" title="更新あり"></i>` : ""}</button>`).join("")}</div>
        <div class="inv-tools">
          <div class="tagrow inv-flt">${fchip("all", "すべて", 0)}${fchip("upd", "更新あり", all.filter((f) => f.status === "outdated").length)}${fchip("newer", "サーバーの方が新しい", all.filter((f) => f.status === "newer").length)}${fchip("warn", "要確認", all.filter(warnOf).length)}${fchip("unreg", "未登録", all.filter((f) => f.status === "unregistered").length)}</div>
          <div class="inv-tools-r">
            <select class="compact" data-sort aria-label="並び順">${[["status", "状態順"], ["name", "名前順"], ["cat", "種類順"], ["tag", "タグ順"], ["size", "サイズ順"]].map(([k, l]) => `<option value="${k}"${sort === k ? " selected" : ""}>${l}</option>`).join("")}</select>
            ${ro ? "" : `<button class="btn small${selecting ? " tinted" : ""}" type="button" data-selmode>${selecting ? "完了" : "選択"}</button>
              <button class="btn small filled" type="button" data-addto>${icon("plus")}追加</button>`}
          </div>
        </div>
        ${tags.length ? `<div class="tagrow inv-tags"><span class="tag-lab">${icon("tag")}</span>${tags.map((t) => `<button class="tagchip" type="button" data-tagf="${esc(t)}" aria-pressed="${tagF === t}" translate="no">#${esc(t)}</button>`).join("")}</div>` : ""}
        ${d.mc_version ? "" : `<div class="result">${icon("clock")} 「設定」で MC のバージョンを入れると、対応していないバージョンに印が付き、同期で入れないようにできます</div>`}
        ${d.absent.filter((c) => tab === "all" || c === tab).map((c) => `<div class="result warn">${esc(CATS[c])}のフォルダ(${esc(d.dirs[c])})が見つかりません。送ると作られます。場所が違う場合は「設定」で変えられます</div>`).join("")}
        ${selecting ? `<div class="inv-selhead glass"><span class="cnt">${picked.length} 件選択</span><div class="acts"><button class="sbtn" type="button" data-bulk="import"${n((f) => ["unregistered", "newer"].includes(f.status)) ? "" : " disabled"}>${icon("download")}<span>取り込む ${n((f) => ["unregistered", "newer"].includes(f.status)) || ""}</span></button>
            <button class="sbtn" type="button" data-bulk="update"${n((f) => f.item_id && ["outdated", "different"].includes(f.status)) ? "" : " disabled"}>${icon("refresh")}<span>更新 ${n((f) => f.item_id && ["outdated", "different"].includes(f.status)) || ""}</span></button>
            <button class="sbtn" type="button" data-bulk="hold"${n((f) => f.item_id) ? "" : " disabled"}>${icon("clock")}<span>見送り</span></button>
            <button class="sbtn" type="button" data-bulk="disable"${picked.length ? "" : " disabled"}>${icon("eyeoff")}<span>無効・有効</span></button></div><span class="sp"></span><button class="btn plain small" type="button" data-selall>すべて</button><button class="btn plain small" type="button" data-selnone${picked.length ? "" : " disabled"}>解除</button></div>` : ""}
        <div class="group">${files.map((f) => `<div class="row inv-row${f.status === "disabled" ? " dim" : ""}${sel.has(f.path) ? " picked" : ""}" data-path="${esc(f.path)}">
          ${selecting ? `<input type="checkbox" class="cbox" data-pick="${esc(f.path)}"${sel.has(f.path) ? " checked" : ""} aria-label="選ぶ">` : ""}${rowIcon(f)}
          <span class="main"${f.item_id && !selecting ? ` data-openit="${f.item_id}" role="button" tabindex="0" title="アドオンのページを開く"` : ""}><span class="title" translate="no">${esc(nameOf(f))}
            ${f.held ? `<span class="badge">見送り</span>` : ""}${f.compat === false ? `<span class="badge err" title="対応: ${esc(f.compat_mc || "")}">MC ${esc(d.mc_version)} 非対応</span>` : ""}${f.status === "newer" ? `<span class="badge acc">サーバーの方が新しい</span>` : ""}</span>
            <span class="subtitle">${esc(f.version || "?")}${(f.status === "outdated" || f.status === "different") && f.latest_version ? ` → <b>${esc(f.latest_version)}</b>` : f.status === "newer" && f.latest_version ? ` · ライブラリは ${esc(f.latest_version)}` : ""} · <span translate="no">${esc(f.path)}</span>${tagsOf(f).length ? ` · ${tagsOf(f).map((t) => `#${esc(t)}`).join(" ")}` : ""}</span></span>
          <span class="trail">${selecting ? "" : `${actBtn(f)}${ro ? "" : `<button class="icon-btn sm" type="button" data-rowmenu="${esc(f.path)}" title="その他" aria-label="その他の操作">${icon("more")}</button>`}`}</span></div>`).join("") || `<div class="empty">${filter === "all" && !tagF ? "ファイルがありません" : "あてはまるものはありません"}</div>`}</div>
        ${missing.length && !selecting ? `<div class="group-title">セットにあってサーバーに無いもの</div><div class="group">${missing.map((m) => `<div class="row"><span class="cicon sm c-${m.category}">${catGlyph(m.category)}</span><span class="main" data-openit="${m.item_id}" role="button" tabindex="0"><span class="title" translate="no">${esc(m.item_name)}${m.compat === false ? ` <span class="badge err">MC ${esc(d.mc_version)} 非対応</span>` : ""}</span><span class="subtitle">${esc(m.version)}${m.no_dir ? ` · ${esc(CATS[m.category] || m.category)}のフォルダが未設定のため入れられません` : ""}</span></span>
          <span class="trail">${wait(`up:${m.item_id}`) || (m.no_dir || ro ? '<span class="badge upd">未導入</span>' : `<button class="btn small tinted" type="button" data-up="${m.item_id}"${m.compat === false ? ' data-force="1"' : ""}>${icon("plus")}入れる</button>`)}</span></div>`).join("")}</div>` : ""}
        ${ro || selecting ? "" : `<div class="df inv-syncbar">
          ${syncable ? `<button class="btn filled block" type="button" data-inv="sync">${icon("refresh")}更新があるもの ${syncable} 件をまとめて同期</button>` : `<div class="result ok">${icon("check")} 同期で入れ替えるものはありません</div>`}
        </div>`}`;
    };
    // 押したらすぐに受け付け(順番待ち)、ボタンは「順番待ち/処理中」にして、ほかのボタンは続けて押せる
    const runJob = async (keys, p, label) => {
      keys.forEach((k) => pending.set(k, "queued")); draw();
      try {
        const j = await p();
        for (;;) {
          await new Promise((r) => setTimeout(r, 800));
          let x; try { x = await api(`/api/jobs/${j.id}`); } catch { break; }
          if (x.status === "running" && keys.some((k) => pending.get(k) !== "running")) { keys.forEach((k) => pending.set(k, "running")); draw(); }
          if (!["running", "queued"].includes(x.status)) {
            if (x.status === "done") toast(label); else toast((x.log || []).filter((y) => !y.startsWith("完了")).slice(-1)[0] || "できませんでした", true);
            break;
          }
        }
      } catch (ex) { toast(ex.message, true); }
      keys.forEach((k) => pending.delete(k));
      pollJobs();
      if (![...pending.values()].length) await load(); else draw();  // まとめて終わってから読み直す(途中の表示はそのまま)
    };
    const push = (btn, ids, force) => runJob(ids.map((i) => `up:${i}`), () => api(`/api/servers/${s.id}/push`, { json: { item_ids: ids, force } }), "更新しました");
    const importPaths = (btn, names) => runJob(names.map((n) => `imp:${n}`), () => api(`/api/servers/${s.id}/import`, { json: { names } }), "ライブラリに取り込みました").then(() => refresh());
    const openItem = (iid) => {
      const it = state.items.find((i) => i.id === iid);
      if (!it) { toast("このアドオンはライブラリにありません", true); return; }
      if (!container) done(null);
      openPanel(it.id);
    };
    body.addEventListener("change", (e) => {
      if (e.target.matches("[data-sort]")) { sort = state.invSort = e.target.value; draw(); return; }
      const pk = e.target.closest("[data-pick]");
      if (pk) { if (pk.checked) sel.add(pk.dataset.pick); else sel.delete(pk.dataset.pick); draw(); }
    });
    body.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; if (container) state.srvCat = tab; draw(); return; }
      const fl = e.target.closest("[data-flt]"); if (fl) { filter = fl.dataset.flt; draw(); return; }
      const tg = e.target.closest("[data-tagf]"); if (tg) { tagF = tagF === tg.dataset.tagf ? "" : tg.dataset.tagf; draw(); return; }
      if (e.target.closest("[data-selmode]")) { selecting = !selecting; sel.clear(); draw(); return; }
      const at = e.target.closest("[data-addto]");
      if (at) {
        const cats = SRV_CATS.filter((c) => d.dirs[c]);
        const kind = tab !== "all" ? tab : cats.length === 1 ? cats[0] : "";
        openMenu(at, [
          { label: "ライブラリから選ぶ", icon: "box", run: async () => { if (await libraryToServer(s, cats, d.files, kind)) await load(); } },
          { label: "配布サイトから探す", icon: "search", run: () => openSearch({ kind, toServer: s }) },
        ]);
        return;
      }
      if (e.target.closest("[data-selall]")) { body.querySelectorAll("[data-pick]").forEach((c) => sel.add(c.dataset.pick)); draw(); return; }
      if (e.target.closest("[data-selnone]")) { sel.clear(); draw(); return; }
      if (selecting && e.target.closest(".inv-row") && !e.target.closest("[data-pick]")) {  // 選択中は行を押しても選べる
        const p = e.target.closest(".inv-row").dataset.path;
        if (sel.has(p)) sel.delete(p); else sel.add(p);
        draw(); return;
      }
      const oi = e.target.closest("[data-openit]"); if (oi) { openItem(Number(oi.dataset.openit)); return; }
      const im = e.target.closest("[data-imp1]"); if (im) { importPaths(im, [im.dataset.imp1]); return; }
      const up = e.target.closest("[data-up]");
      if (up) {
        if (up.dataset.force && !cfm("このバージョンは、サーバーの MC のバージョンに対応していない可能性があります。それでも入れますか?")) return;
        push(up, [Number(up.dataset.up)], !!up.dataset.force); return;
      }
      const bk = e.target.closest("[data-bulk]");
      if (bk && !bk.disabled) {
        const picked = d.files.filter((f) => sel.has(f.path));
        const k = bk.dataset.bulk;
        if (k === "import") importPaths(bk, picked.filter((f) => ["unregistered", "newer"].includes(f.status)).map((f) => f.path));
        if (k === "update") push(bk, [...new Set(picked.filter((f) => f.item_id && ["outdated", "different"].includes(f.status)).map((f) => f.item_id))], false);
        if (k === "hold") {
          const ids = [...new Set(picked.filter((f) => f.item_id).map((f) => f.item_id))];
          const hold = !picked.filter((f) => f.item_id).every((f) => f.held);
          await busy(bk, async () => { for (const id of ids) { try { await api(`/api/servers/${s.id}/hold`, { json: { item_id: id, hold } }); } catch (ex) { toast(ex.message, true); } } });
          toast(hold ? `${ids.length} 件を見送ります` : `${ids.length} 件の見送りをやめました`); await load();
        }
        if (k === "disable") {
          await busy(bk, async () => { for (const f of picked) { try { await api(`/api/servers/${s.id}/toggle`, { json: { path: f.path, enable: f.status === "disabled" } }); } catch (ex) { toast(`${f.name}: ${ex.message}`, true); } } });
          toast("切り替えました。反映には再起動が必要です"); await load();
        }
        return;
      }
      const rm = e.target.closest("[data-rowmenu]");
      if (rm) {
        const f = d.files.find((x) => x.path === rm.dataset.rowmenu); if (!f) return;
        const it = itemOf(f);
        const page = it && it.source && it.source.page_url;
        const prev = it ? prevVersionOf(it, f) : null;
        const verRun = (p, label) => runJob([`up:${f.item_id}`], p, label);
        openMenu(rm, [
          ...(it ? [{ label: "バージョンを変える…", icon: "arrows", run: () => changeVersionSheet({ ...s, ...d, id: s.id }, f, verRun) }] : []),
          ...(prev ? [{ label: `ひとつ前のバージョン(${prev.version || "?"})に戻す`, icon: "back", run: () => {
            if (!cfm(`${it.name} を ${prev.version || "?"} に戻しますか?

今のバージョンは退避され、「保存」→「履歴と巻き戻し」から戻せます。`)) return;
            verRun(() => api(`/api/servers/${s.id}/push`, { json: { item_ids: [it.id], version_ids: { [it.id]: prev.id }, force: true } }), `${prev.version || ""} に戻しました`);
          } }] : []),
          ...(it ? ["-"] : []),
          ...(it ? [{ label: "アドオンのページを開く", icon: "box", run: () => openItem(it.id) }] : []),
          ...(page ? [{ label: "配布ページを開く", icon: "external", run: () => window.open(safeUrl(page), "_blank", "noopener") }] : []),
          ...(["unregistered", "newer"].includes(f.status) ? [{ label: "ライブラリに取り込む", icon: "download", run: () => importPaths(null, [f.path]) }] : []),
          ...(f.item_id ? [{ label: f.held ? "見送りをやめる" : "このサーバーでは更新を見送る", icon: "clock", run: async () => {
            try { await api(`/api/servers/${s.id}/hold`, { json: { item_id: f.item_id, hold: !f.held } }); toast(f.held ? "見送りをやめました" : "見送ります(同期・自動更新で入れ替えません)"); await load(); } catch (ex) { toast(ex.message, true); }
          } }] : []),
          { label: f.status === "disabled" ? "有効にする" : "無効にする(消さずに外す)", icon: f.status === "disabled" ? "check" : "eyeoff", run: async () => {
            try { await api(`/api/servers/${s.id}/toggle`, { json: { path: f.path, enable: f.status === "disabled" } }); toast(f.status === "disabled" ? "有効にしました。反映には再起動が必要です" : "無効にしました。反映には再起動が必要です"); await load(); } catch (ex) { toast(ex.message, true); }
          } },
        ]);
        return;
      }
      const b = e.target.closest("[data-inv]"); if (!b) return;
      if (b.dataset.inv === "sync") {
        try { jobStarted(await api(`/api/servers/${s.id}/sync`, { json: {} })); done(null); } catch (ex) { toast(ex.message, true); }
      }
    });
    await load();
  }, { wide: true });
  if (state.view === "servers") loadServers();
}
async function pushDialog({ server = null, set = null, item = null, itemIds = null } = {}) {
  if (!state.servers) { try { const d = await api("/api/servers"); state.servers = d.servers; state.pteroConfigured = d.configured; } catch { state.servers = []; } }
  if (!state.servers.length) { toast("先に「サーバー」タブでサーバーを連携してください", true); return; }
  if (!state.sets) { try { state.sets = (await api("/api/sets")).sets; } catch { state.sets = []; } }
  // アイテムを選んでから開いたときは、送る内容の確認だけにする(ほかのアイテムは選ばない)
  const fixedIds = item ? [item.id] : itemIds;
  const fixed = fixedIds ? fixedIds.map((id) => state.items.find((i) => i.id === id)).filter(Boolean) : null;
  const latestOf = (it) => it.versions.find((v) => v.id === it.latest_id) || it.versions[0];
  const items = [...state.items].sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  const srvChecked = (x) => (server ? x.id === server.id : state.servers.length === 1);
  const what = fixed
    ? `<div class="group-title">送るもの(${fixed.length} 件 · ${fmtSize(fixed.reduce((n, it) => n + (latestOf(it).size || 0), 0))})</div>
      <div class="group scroll">${fixed.map((it) => `<div class="row">${itemIcon(it, true)}
        <span class="main"><span class="title" translate="no">${esc(it.name)}</span><span class="subtitle">${esc(verLabel(latestOf(it).version))} · ${esc(latestOf(it).filename)}</span></span>
        <span class="trail">${fmtSize(latestOf(it).size)}</span></div>`).join("")}</div>`
    : `<div class="group-title">送るもの</div>
      <div class="segmented seg-wide" role="group" aria-label="送るもの">
        <button class="seg" type="button" data-mode="set" aria-pressed="${!!set || !!state.sets.length}">セット</button>
        <button class="seg" type="button" data-mode="items" aria-pressed="${!set && !state.sets.length}">アイテムを選ぶ</button></div>
      <div id="pSet">${state.sets.length ? `<div class="group scroll">${state.sets.map((x, n) => `<label class="toggle-row"><span class="cicon sm c-plugin">${icon("stack")}</span>
          <span class="main">${esc(x.name)}<small>${x.items.length} 件</small></span>
          <input type="radio" class="switch" name="set_id" value="${x.id}"${(set ? x.id === set.id : n === 0) ? " checked" : ""}></label>`).join("")}</div>`
        : `<div class="empty">セットがありません(「セット」タブで作れます)</div>`}</div>
      <div id="pItems"><div class="group scroll">${items.map((it) => `<label class="toggle-row">${itemIcon(it, true)}
        <span class="main">${esc(it.name)}<small>${esc(verLabel(latestOf(it).version))}(最新)</small></span>
        <input type="checkbox" class="switch" data-pi="${it.id}"></label>`).join("")}</div></div>`;
  const r = await sheet(`${sheetHead(fixed ? "サーバーへ転送" : "サーバーへ転送")}<div class="db">
      <div class="group-title">転送先のサーバー</div>
      <div class="group">${state.servers.map((x) => `<label class="toggle-row"><span class="cicon sm c-teal">${icon(x.kind === "local" ? "folder" : "server")}</span>
        <span class="main">${esc(x.name)}<small>${esc(dirsLabel(x))}</small></span>
        <input type="checkbox" class="switch" data-ps="${x.id}"${srvChecked(x) ? " checked" : ""}></label>`).join("")}</div>
      ${what}
      <div class="group">${toggle("restart", "完了後にサーバーを再起動", state.servers.some((x) => x.kind === "local") ? "フォルダのサーバーは再起動されません" : "", false)}</div>
      <p style="font-size:12.5px">サーバーに同じアドオンの別のバージョンがある場合は、送ったものに置き換えます(置き換えたファイルは退避され、「履歴と巻き戻し」で戻せます)。</p>
    </div><div class="df row2"><button class="btn" type="button" data-close>キャンセル</button><button class="btn filled" type="button" data-ok>転送する</button></div>`, (form, done) => {
    let mode = set || state.sets.length ? "set" : "items";
    const sync = () => {
      if (fixed) return;
      form.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
      $("#pSet", form).hidden = mode !== "set"; $("#pItems", form).hidden = mode !== "items";
    };
    form.querySelectorAll("[data-mode]").forEach((b) => { b.onclick = () => { mode = b.dataset.mode; sync(); }; });
    sync();
    form.querySelector("[data-ok]").onclick = (ev) => busy(ev.currentTarget, async () => {
      const srvs = [...form.querySelectorAll("[data-ps]:checked")].map((c) => Number(c.dataset.ps));
      if (!srvs.length) { toast("転送先のサーバーを選んでください", true); return; }
      const body = { restart: form.querySelector("[name=restart]").checked };
      if (fixed) body.item_ids = fixed.map((it) => it.id);
      else if (mode === "set") {
        body.set_id = Number(form.querySelector("[name=set_id]:checked")?.value) || null;
        if (!body.set_id) { toast("送るセットを選んでください", true); return; }
      } else {
        body.item_ids = [...form.querySelectorAll("[data-pi]:checked")].map((c) => Number(c.dataset.pi));
        if (!body.item_ids.length) { toast("送るアイテムを選んでください", true); return; }
      }
      try {
        for (const srv of srvs) jobStarted(await api(`/api/servers/${srv}/push`, { json: body }));
        done(true);
      } catch (ex) { toast(ex.message, true); }
    }, "開始しています…");
  }, { wide: true });
  return r;
}

