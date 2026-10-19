"use strict";
/* ---------------- top bar actions ---------------- */
$("#addBtn").innerHTML = icon("plus") + '<span class="lbl">追加</span>';
$("#tiLib").innerHTML = icon("box");
$("#tiDash").innerHTML = icon("grid");
$("#tiSets").innerHTML = icon("stack");
$("#tiSrv").innerHTML = icon("server");
$("#updBtn").innerHTML = icon("refresh");
$("#settingsBtn").innerHTML = icon("gear");
$("#dropIcon").innerHTML = icon("tray");
$("#searchIcon").innerHTML = icon("search");
$("#tbMoreIcon").innerHTML = icon("filter");
const addMenuItems = () => [
  { label: "ファイルを選択", icon: "doc", run: () => $("#fileInput").click() },
  { label: "フォルダを選択", icon: "folder", run: () => $("#dirInput").click() },
  { label: "配布サイトから探して追加", icon: "search", run: () => openSearch({ kind: state.cat }) },
  { label: "URLから追加", icon: "link", run: importFromUrl },
  { label: "Modパックを読み込む(.mrpack / zip)", icon: "stack", run: () => $("#packInput").click() },
  "-",
  { label: "inbox を取り込む", icon: "tray", run: scanInbox },
];
$("#addBtn").addEventListener("click", (e) => openMenu(e.currentTarget, addMenuItems()));
$("#updBtn").addEventListener("click", (e) => openMenu(e.currentTarget, [
  { label: "更新を確認", icon: "refresh", run: () => runUpdates({ check: true }) },
  { label: "未連携の配布元を探して確認", icon: "wand", run: () => runUpdates({ detect: true, check: true }) },
  { label: "確認して更新をすべて保存", icon: "download", run: () => runUpdates({ check: true, download: true }) },
]));
$("#settingsBtn").addEventListener("click", () => openSettings());

async function importFromUrl() {
  const r = await formSheet("URLから追加", `<p>Modrinth / SpigotMC / CurseForge の配布ページのURLから最新バージョンをダウンロードして登録し、配布元も紐付けます。</p>
    ${field("URL", `<input type="url" name="url" placeholder="https://modrinth.com/mod/fabric-api" required>`)}
    ${field("ローダー(Mod は指定を推奨。例: fabric / neoforge / forge / paper)", `<input type="text" name="loaders">`)}
    ${field("Minecraft のバージョン(Mod は指定を推奨。例: 1.20.1)", `<input type="text" name="game_versions">`)}`, "取得して登録");
  if (!r) return;
  const t = toastProgress("取得しています…");
  try {
    const d = await api("/api/import", { json: r });
    toast(d.status === "added" ? `追加しました: ${d.name} ${d.version || ""}` : `登録済みです: ${d.name} ${d.version || ""}`);
    await refresh();
    if (d.item_id) openPanel(d.item_id);
  } catch (e) { toast(e.message, true); }
  finally { t.remove(); }
}
function toastProgress(msg) {
  const el = document.createElement("div");
  el.className = "toast glass";
  el.innerHTML = `<span class="spinner"></span><span></span>`;
  el.lastChild.textContent = msg;
  toastHost().appendChild(el);
  return el;
}
async function scanInbox() {
  const t = toastProgress("inbox を取り込んでいます…");
  try {
    const r = await api("/api/scan", { method: "POST" });
    const parts = [`${r.added} 件追加`];
    if (r.duplicates) parts.push(`${r.duplicates} 件は登録済み(inbox に残っています)`);
    if (r.missing) parts.push(`見つからないファイル ${r.missing} 件`);
    toast(r.scanned || r.missing ? "取り込み完了: " + parts.join("、") : "取り込むファイルはありませんでした", r.errors.length > 0);
    r.errors.slice(0, 3).forEach((m) => toast(m, true));
    await refresh();
  } catch (e) { toast(e.message, true); }
  finally { t.remove(); }
}

/* ---------------- jobs ---------------- */
let jobTimer = null;
const seenDone = new Set();
async function pollJobs() {
  clearTimeout(jobTimer);
  if (!state.user) return;
  try {
    const { jobs } = await api("/api/jobs");
    const first = !state.jobsLoaded; state.jobsLoaded = true;
    for (const j of jobs) {
      if (!["running", "queued"].includes(j.status) && !seenDone.has(j.id)) {
        seenDone.add(j.id);
        if (!first && j.kind !== "selfupdate") { toast(`${j.title}: ${j.status === "done" ? "完了しました" : "エラーで終了しました"}`, j.status !== "done"); refresh(); }
      }
    }
    state.jobs = jobs.filter((j) => j.kind !== "selfupdate" && (["running", "queued"].includes(j.status) || Date.now() - new Date(j.finished).getTime() < 5 * 60 * 1000) && !state.hiddenJobs?.has(j.id));
    renderJobs();
    jobTimer = setTimeout(pollJobs, jobs.some((j) => ["running", "queued"].includes(j.status)) ? 1500 : 15000);
  } catch { jobTimer = setTimeout(pollJobs, 15000); }
}
/* 処理の進み具合: ライブラリでは詳しく、ダッシュボードでは小さく1行で。サーバーの処理はサーバー画面にも出す */
function renderJobs() {
  const view = state.view || "library";
  const jobs = view === "library" ? state.jobs
    : view === "servers" ? state.jobs.filter((j) => String(j.kind).startsWith("server-"))
    : view === "dash" ? state.jobs : [];
  if (view === "dash") {
    $("#jobs").innerHTML = jobs.length ? `<div class="jobs-mini">${jobs.map((j) => {
      const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
      return `<button class="jm${j.status === "error" ? " error" : ""}" type="button" data-jgo="1" title="ライブラリで詳しく見る">
        ${j.status === "running" ? '<span class="spinner"></span>' : icon(j.status === "queued" ? "clock" : j.status === "done" ? "check" : "x")}
        <span class="t">${esc(j.title)}</span><span class="n">${j.status === "running" ? `${j.done} / ${j.total || "?"}` : j.status === "queued" ? "順番待ち" : j.status === "done" ? "完了" : "エラー"}</span>
        ${j.status === "running" ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ""}</button>`;
    }).join("")}</div>` : "";
    return;
  }
  $("#jobs").innerHTML = jobs.map((j) => {
    const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    return `<div class="job${j.status === "error" ? " error" : ""}">
      <div class="jl"><div class="l">${j.status === "running" ? '<span class="spinner"></span>' : `<span class="cicon sm ${j.status === "queued" ? "c-gray" : j.status === "done" ? "c-mod" : "c-red"}">${icon(j.status === "queued" ? "clock" : j.status === "done" ? "check" : "x")}</span>`}
        <div><div style="font-weight:600">${esc(j.title)}</div><div class="muted">${j.status === "running" ? `実行中 ${j.done} / ${j.total || "?"}` : j.status === "queued" ? "順番待ち(前の処理が終わると始まります)" : j.status === "done" ? "完了" : "エラーで終了"}${j.user ? ` · ${esc(j.user)}` : ""}</div></div></div>
        ${!["running", "queued"].includes(j.status) ? `<button class="close-x" type="button" data-jclose="${j.id}" aria-label="閉じる">${icon("x")}</button>` : ""}</div>
      ${j.status === "running" ? `<div class="progress${j.total ? "" : " indet"}"><i style="width:${pct}%"></i></div>` : ""}
      ${j.log.length ? `<details${j.status !== "running" ? " open" : ""}><summary>記録 (${j.log.length})</summary><div class="log">${esc(j.log.slice(-40).join("\n"))}</div></details>` : ""}
    </div>`;
  }).join("");
}
$("#jobs").addEventListener("click", (e) => {
  if (e.target.closest("[data-jgo]")) { setView("library"); return; }
  const b = e.target.closest("[data-jclose]"); if (!b) return;
  (state.hiddenJobs ||= new Set()).add(b.dataset.jclose);
  state.jobs = state.jobs.filter((j) => j.id !== b.dataset.jclose); renderJobs();
});
function jobStarted(j) { toast(`${j.title}を開始しました`); seenDone.delete(j.id); pollJobs(); }

