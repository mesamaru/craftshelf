"use strict";
/* ---------------- はじめの設定ガイド(管理者。ライブラリの上に出す) ---------------- */
const SETUP_INFO = {
  storage: { title: "保存先を決める", sub: "初めはこの PC(ローカル)に保存します。NAS などに置くなら追加します", act: "保存先を開く", skip: "ローカルのままにする", ic: "server", run: () => openSettings("storage") },
  addons: { title: "アドオンを追加する", sub: "ファイルをドロップするか、配布サイト(Modrinth・SpigotMC・CurseForge)から探します", act: "配布サイトで探す", ic: "box", run: () => openSearch({}) },
  server: { title: "サーバーをつなぐ", sub: "Pterodactyl か、この PC から見えるフォルダのサーバーを登録すると、まとめて更新できます", act: "サーバーを開く", skip: "サーバーは使わない", ic: "server", run: () => setView("servers") },
  backup: { title: "バックアップを設定する", sub: "登録情報と鍵を毎日 zip にまとめて保存します。もしものときに戻せます", act: "バックアップを開く", skip: "あとで", ic: "download", run: () => openSettings("backup") },
  notify: { title: "通知を受け取る", sub: "更新やエラーを Discord に知らせます(設定しなくても、ベルのお知らせで見られます)", act: "Discord 通知を開く", skip: "使わない", ic: "bell", run: () => openSettings("discord") },
};
async function loadGuide() {
  const card = $("#setupCard");
  if (!isAdmin()) { card.hidden = true; return; }
  try { state.guide = await api("/api/setup/guide"); } catch { card.hidden = true; return; }
  drawGuide();
}
function drawGuide() {
  const card = $("#setupCard"), g = state.guide;
  if (!g || g.hidden || g.all_done) { card.hidden = true; return; }
  const done = g.steps.filter((s) => s.done).length;
  const next = g.steps.find((s) => !s.done);
  card.hidden = false;
  card.innerHTML = `<div class="sg-head"><div><h3>はじめの設定</h3><small>${done} / ${g.steps.length} 済み</small></div>
      <button class="close-x" type="button" data-ghide aria-label="ガイドを閉じる" title="ガイドを閉じる(設定からまた出せます)">${icon("x")}</button></div>
    <div class="sg-bar" role="progressbar" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${g.steps.length}"><i style="width:${Math.round(done / g.steps.length * 100)}%"></i></div>
    <ol class="sg-steps">${g.steps.map((s) => { const i = SETUP_INFO[s.id]; return `<li class="${s.done ? "done" : ""}${s === next ? " next" : ""}">
      <span class="sg-dot">${s.done ? icon("check") : ""}</span>
      <div class="sg-main"><div class="t">${esc(i.title)}${s.skipped ? ' <span class="badge">不要にしました</span>' : ""}</div>${s === next ? `<div class="s">${esc(i.sub)}</div>` : ""}</div>
      ${s.done ? (s.skipped ? `<button class="btn plain small" type="button" data-gun="${s.id}">戻す</button>` : "")
        : `<div class="sg-acts">${i.skip ? `<button class="btn plain small" type="button" data-gskip="${s.id}">${esc(i.skip)}</button>` : ""}<button class="btn small${s === next ? " filled" : ""}" type="button" data-grun="${s.id}">${esc(i.act)}</button></div>`}
    </li>`; }).join("")}</ol>`;
}
async function guidePost(body) {
  try { state.guide = await api("/api/setup/guide", { json: body }); drawGuide(); } catch (e) { toast(e.message, true); }
}
$("#setupCard").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-grun]"); if (r) { SETUP_INFO[r.dataset.grun].run(); return; }
  const k = e.target.closest("[data-gskip]"); if (k) { guidePost({ mark: k.dataset.gskip }); return; }
  const u = e.target.closest("[data-gun]"); if (u) { guidePost({ unmark: u.dataset.gun }); return; }
  if (e.target.closest("[data-ghide]")) { await guidePost({ hide: true }); toast("ガイドを閉じました。設定の「はじめの設定ガイド」からまた出せます"); }
});
