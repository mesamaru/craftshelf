"use strict";
/* ---------------- ファイル比較(WinMerge のように、複数のサーバーの設定ファイルを並べて比べ、その場で編集する) ---------------- */

/* 行の差分(Myers の方法)。[{t:"eq",a,b} | {t:"del",a} | {t:"ins",b}] を返す */
function diffLines(A, B) {
  const n = A.length, m = B.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y;
    const prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; ops.push({ t: "eq", a: x, b: y }); }
    if (d > 0) { if (x === px) { y--; ops.push({ t: "ins", b: y }); } else { x--; ops.push({ t: "del", a: x }); } }
  }
  return ops.reverse();
}

/* 基準のサーバーにそろえて、全サーバーの行を横に並べる。cells[k] = {i: 行番号 | null, kind: same/chg/miss/extra/base} */
function alignAll(base, others) {
  const nb = base.length;
  const map = others.map(() => new Array(nb).fill(null));     // 基準の行 → その行に並ぶ行(と差分の種類)
  const before = others.map(() => Array.from({ length: nb + 1 }, () => []));  // 基準の行の前に入る、そのサーバーだけの行
  others.forEach((lines, k) => {
    const ops = diffLines(base, lines);
    let i = 0;
    while (i < ops.length) {
      if (ops[i].t === "eq") { map[k][ops[i].a] = { i: ops[i].b, kind: "same" }; i++; continue; }
      const dels = [], ins = [];
      while (i < ops.length && ops[i].t !== "eq") { (ops[i].t === "del" ? dels : ins).push(ops[i]); i++; }
      const pairs = Math.min(dels.length, ins.length);
      for (let p = 0; p < pairs; p++) map[k][dels[p].a] = { i: ins[p].b, kind: "chg" };
      for (let p = pairs; p < dels.length; p++) map[k][dels[p].a] = { i: null, kind: "miss" };
      const at = dels.length ? dels[dels.length - 1].a + 1 : (i < ops.length ? ops[i].a : nb);
      for (let p = pairs; p < ins.length; p++) before[k][at].push(ins[p].b);
    }
  });
  const rows = [];
  for (let g = 0; g <= nb; g++) {
    const extra = Math.max(...before.map((b) => b[g].length));
    for (let r = 0; r < extra; r++) rows.push({ base: null, cells: before.map((b) => (r < b[g].length ? { i: b[g][r], kind: "extra" } : { i: null, kind: "gap" })) });
    if (g < nb) rows.push({ base: g, cells: map.map((m) => m[g] || { i: null, kind: "miss" }) });
  }
  // 行を足すときの位置(そのサーバーで、この行より前にある行の数)
  const seen = others.map(() => 0);
  for (const row of rows) { row.at = seen.slice(); row.cells.forEach((c, k) => { if (c.i !== null) seen[k] = c.i + 1; }); }
  rows.forEach((row) => { row.diff = row.base === null || row.cells.some((c) => c.kind !== "same"); });
  return rows;
}

function splitText(text) {
  const crlf = /\r\n/.test(text);
  const t = text.replace(/\r\n/g, "\n");
  const eol = t.endsWith("\n");
  const lines = (eol ? t.slice(0, -1) : t).split("\n");
  return { lines: t === "" ? [] : lines, eol, crlf };
}
const joinText = (f) => { const t = f.lines.join("\n") + (f.eol && f.lines.length ? "\n" : ""); return f.crlf ? t.replace(/\n/g, "\r\n") : t; };

/* ---- 画面: サーバーを選ぶ → ファイルの一覧 → 並べて比べる ---- */
async function renderCfgDiff() {
  const body = $("#srvBody");
  if (!body) return;
  const cd = state.cd = state.cd || { ids: [], sync: true, onlyDiff: false, widths: {}, filter: "diff" };
  const servers = (state.servers || []).filter((s) => s.access !== "view");
  if (cd.path) return renderCdCompare(body);
  document.body.classList.remove("cd-on");
  const pick = `<div class="cd-pick">${servers.map((s) => `<button class="seg" type="button" data-cdsrv="${s.id}" aria-pressed="${cd.ids.includes(s.id)}" translate="no">${cd.ids.includes(s.id) ? icon("check") : ""}${esc(s.name)}</button>`).join("")}</div>`;
  if (cd.ids.length < 2) {
    body.innerHTML = `<div class="sw-head"><h3>ファイル比較</h3></div><p class="muted">比べるサーバーを 2 台以上選んでください(いくつでも選べます)。</p>${pick}`;
  } else {
    body.innerHTML = `<div class="sw-head"><h3>ファイル比較</h3><span class="sp"></span></div>${pick}<div class="card"><div class="empty"><span class="spinner lg"></span><p>設定ファイルを集めています…</p></div></div>`;
    let d;
    try { d = await api(`/api/servers/configs?ids=${cd.ids.join(",")}`); } catch (ex) { body.querySelector(".card").innerHTML = `<div class="result err">${esc(ex.message)}</div>`; return; }
    cd.list = d;
    if (cd.wantPath) { const p = cd.wantPath; cd.wantPath = null; cd.path = p; cd.files = null; return renderCfgDiff(); }
    drawCdList(body);
  }
  body.onclick = (e) => {
    const b = e.target.closest("[data-cdsrv]");
    if (b) { const id = Number(b.dataset.cdsrv); cd.ids = cd.ids.includes(id) ? cd.ids.filter((x) => x !== id) : [...cd.ids, id]; cd.list = null; renderCfgDiff(); return; }
    const f = e.target.closest("[data-cdf]"); if (f) { cd.filter = f.dataset.cdf; drawCdList(body); return; }
    const o = e.target.closest("[data-cdopen]"); if (o) { cd.path = o.dataset.cdopen; cd.files = null; renderCfgDiff(); }
  };
}
// 選んだサーバーだけで比べた結果: 同じ / 差分あり / ○ 台にない(ある分どうしが違えば「差分あり」も)
function cdBadges(f, total) {
  if (f.status === "same") return `<span class="badge ok">同じ</span>`;
  const miss = total - f.on.length;
  return (f.status === "diff" || f.differ ? `<span class="badge upd">差分あり</span>` : "") + (miss ? `<span class="badge">${miss} 台にない</span>` : "");
}
// パスの一覧を、ディレクトリの木にする
function cdTree(files) {
  const top = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = top;
    for (const p of parts.slice(0, -1)) { if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] }); node = node.dirs.get(p); }
    node.files.push(f);
  }
  return top;
}
function cdTreeHTML(node, prefix, total, open) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()));
  const files = node.files.slice().sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  const count = (n) => n.files.length + [...n.dirs.values()].reduce((a, c) => a + count(c), 0);
  return dirs.map(([name, sub]) => {
    const p = prefix + name + "/";
    return `<details class="cd-dir" data-cddir="${esc(p)}"${open(p) ? " open" : ""}><summary><span class="cicon sm c-datapack">${icon("folder")}</span><span class="title mono" translate="no">${esc(name)}</span><span class="muted small">${count(sub)}</span>${icon("chev", "i chev")}</summary>
      <div class="cd-sub">${cdTreeHTML(sub, p, total, open)}</div></details>`;
  }).join("") + files.map((f) => `<button class="row cd-file" type="button" data-cdopen="${esc(f.path)}"><span class="cicon sm c-teal">${icon("doc")}</span>
      <span class="main"><span class="title mono" translate="no">${esc(f.path.split("/").pop())}</span></span>
      <span class="trail">${cdBadges(f, total)}${icon("chev", "i chev")}</span></button>`).join("");
}
function drawCdList(body) {
  const cd = state.cd, d = cd.list;
  const rows = d.files.filter((f) => cd.filter === "all" || (cd.filter === "diff" ? f.status !== "same" : f.status === cd.filter));
  cd.dirs = cd.dirs || {};
  const open = (p) => p in cd.dirs ? cd.dirs[p] : cd.filter === "diff";
  const n = (st) => d.files.filter((f) => f.status === st).length;
  const listHTML = `<div class="sw-filter">${[["diff", `差分のあるもの ${n("diff") + n("partial")}`], ["same", `同じ ${n("same")}`], ["all", `すべて ${d.files.length}`]].map(([k, l]) =>
      `<button class="seg" type="button" data-cdf="${k}" aria-pressed="${cd.filter === k}">${l}</button>`).join("")}</div>
    ${d.servers.some((s) => s.error) ? `<div class="result warn">${d.servers.filter((s) => s.error).map((s) => `${esc(s.name)}: ${esc(s.error)}`).join("<br>")}</div>` : ""}
    ${d.servers.some((s) => s.kind === "ptero") ? `<p class="muted small">Pterodactyl のサーバーは、ファイルの大きさで同じかどうかを見ています(開くと中身で比べます)。</p>` : ""}
    <div class="group cd-tree">${rows.length ? cdTreeHTML(cdTree(rows), "", d.servers.length, open) : `<div class="empty">あてはまるファイルはありません</div>`}</div>`;
  body.querySelector(".card")?.remove();
  body.querySelector(".cd-listwrap")?.remove();
  body.insertAdjacentHTML("beforeend", `<div class="cd-listwrap">${listHTML}</div>`);
  body.querySelectorAll("details.cd-dir").forEach((el) => el.addEventListener("toggle", () => { cd.dirs[el.dataset.cddir] = el.open; }));
}

async function renderCdCompare(body) {
  const cd = state.cd;
  if (!cd.files) {
    body.innerHTML = `<div class="card"><div class="empty"><span class="spinner lg"></span></div></div>`;
    cd.files = {};
    await Promise.all(cd.ids.map(async (id) => {
      try {
        const f = await api(`/api/servers/${id}/file?path=${encodeURIComponent(cd.path)}`);
        cd.files[id] = { ...splitText(f.text), hash: f.hash, saved: f.text, exists: true, dirty: false };
      } catch { cd.files[id] = { lines: [], eol: true, crlf: false, hash: "", saved: "", exists: false, dirty: false }; }
    }));
    if (!cd.base || !cd.ids.includes(cd.base) || !cd.files[cd.base].exists) cd.base = cd.ids.find((id) => cd.files[id].exists) || cd.ids[0];
  }
  drawCdCompare(body);
}
function cdModel() {
  const cd = state.cd;
  const others = cd.ids.filter((id) => id !== cd.base);
  const rows = alignAll(cd.files[cd.base].lines, others.map((id) => cd.files[id].lines));
  return { others, rows };
}
function drawCdCompare(body, keepFocus = null) {
  const cd = state.cd;
  document.body.classList.add("cd-on");  // 比べている間(横向きのスマホでは、見出しなどを隠して広く使う)
  const { others, rows } = cdModel();
  cd.rows = rows; cd.others = others;
  let blocks = 0;
  rows.forEach((r, i) => { if (r.diff && !(i > 0 && rows[i - 1].diff)) blocks++; });
  const sname = (id) => ((state.servers || []).find((s) => s.id === id) || {}).name || `#${id}`;
  const order = [cd.base, ...others];
  const visible = rows.map((r, i) => i).filter((i) => !cd.onlyDiff || rows[i].diff || (i > 0 && rows[i - 1].diff) || (i + 1 < rows.length && rows[i + 1].diff));
  const cellOf = (id, r) => (id === cd.base ? (r.base === null ? { i: null, kind: "gap" } : { i: r.base, kind: "base" }) : r.cells[others.indexOf(id)]);
  const col = (id) => {
    const f = cd.files[id];
    const lines = visible.map((ri) => {
      const r = rows[ri], c = cellOf(id, r);
      const txt = c.i !== null ? f.lines[c.i] : "";
      const cls = id === cd.base ? (r.diff ? "d-base" : "") : `d-${c.kind}`;
      return `<div class="cd-ln ${cls}" data-r="${ri}"><span class="cd-no">${c.i !== null ? c.i + 1 : ""}</span>${c.i !== null
        ? `<span class="cd-tx" contenteditable="plaintext-only" spellcheck="false" data-id="${id}" data-li="${c.i}">${esc(txt)}</span>`
        : `<span class="cd-tx cd-void"></span>`}${r.diff ? `<button class="cd-act" type="button" data-cdact="${id}:${ri}" aria-label="この行の操作">${icon("more")}</button>` : ""}</div>`;
    }).join("");
    return `<section class="cd-col" data-col="${id}" style="${cd.widths[id] ? `flex-basis:${cd.widths[id]}px` : ""}">
      <div class="cd-h"><b translate="no">${esc(sname(id))}</b>${id === cd.base ? `<span class="badge ok">基準</span>` : `<button class="btn plain small" type="button" data-cdbase="${id}">基準にする</button>`}
        <span class="sp"></span>${f.exists ? "" : `<span class="badge">ファイルがありません</span>`}
        ${f.dirty ? `<span class="muted small">未保存</span><button class="btn small filled" type="button" data-cdsave="${id}">保存</button>` : ""}</div>
      <div class="cd-body" data-body="${id}">${!f.exists && !f.lines.length ? `<div class="cd-none">このサーバーには、このファイルがありません。<button class="btn small" type="button" data-cdcreate="${id}">基準からコピーして作る</button></div>` : ""}${lines}</div></section>`;
  };
  const prevScroll = [...body.querySelectorAll(".cd-body")].map((b) => b.scrollTop)[0] || 0;
  body.innerHTML = `<div class="cd-top">
      <button class="btn plain small" type="button" data-cdback>${icon("back")}ファイルの一覧</button>
      <b class="mono" translate="no">${esc(cd.path)}</b>
      <span class="badge ${blocks ? "upd" : "ok"}">${blocks ? `差分 ${blocks} か所` : "差分はありません"}</span>
      <span class="sp"></span>
      <button class="btn small" type="button" data-cdnav="-1"${blocks ? "" : " disabled"}>${icon("up")}前の差分</button>
      <button class="btn small" type="button" data-cdnav="1"${blocks ? "" : " disabled"}>${icon("down")}次の差分</button>
      <label class="sw-opt"><input type="checkbox" class="switch" data-cdopt="onlyDiff"${cd.onlyDiff ? " checked" : ""}> 差分のある行だけ</label>
      <label class="sw-opt"><input type="checkbox" class="switch" data-cdopt="sync"${cd.sync ? " checked" : ""}> スクロールを合わせる</label></div>
    <div class="cd-cols">${order.map((id, i) => col(id) + (i < order.length - 1 ? `<div class="cd-grip" data-grip="${id}" title="ドラッグで幅を変える"></div>` : "")).join("")}</div>
    <p class="muted small">左右(縦向きのスマホは上下)の行はそのまま書き換えられ、打つと差分を計算し直します。行の ${icon("more")} から「基準に合わせる」「この行をほかのサーバーへ」を選べます。保存の前の内容は「ファイル」の履歴に残ります。</p>`;
  body.querySelectorAll(".cd-body").forEach((b) => { b.scrollTop = prevScroll; });
  if (keepFocus) {
    const el = body.querySelector(`.cd-tx[data-id="${keepFocus.id}"][data-li="${keepFocus.li}"]`);
    if (el) {
      el.focus();
      const node = el.firstChild || el, len = (el.textContent || "").length;
      const r = document.createRange(); r.setStart(node, Math.min(keepFocus.off, node.nodeType === 3 ? len : 0)); r.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }
  }
  bindCdCompare(body);
}
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().length;
}
function bindCdCompare(body) {
  const cd = state.cd;
  let timer = null, syncing = false;
  const redraw = (focus) => drawCdCompare(body, focus);
  const touch = (id) => { const f = cd.files[id]; f.dirty = joinText(f) !== f.saved || !f.exists; };
  body.oninput = (e) => {
    const el = e.target.closest(".cd-tx[data-id]"); if (!el) return;
    const id = Number(el.dataset.id), li = Number(el.dataset.li);
    cd.files[id].lines[li] = el.textContent.replace(/\n/g, "");
    touch(id);
    clearTimeout(timer);
    timer = setTimeout(() => redraw({ id, li, off: caretOffset(el) }), 450);  // 打ち終わったら差分を計算し直す
  };
  body.onkeydown = (e) => {
    const el = e.target.closest(".cd-tx[data-id]"); if (!el) return;
    const id = Number(el.dataset.id), li = Number(el.dataset.li), f = cd.files[id], off = caretOffset(el), t = el.textContent;
    if (e.key === "Enter") {
      e.preventDefault(); clearTimeout(timer);
      f.lines[li] = t.slice(0, off); f.lines.splice(li + 1, 0, t.slice(off)); touch(id); redraw({ id, li: li + 1, off: 0 });
    } else if (e.key === "Backspace" && off === 0 && li > 0 && !getSelection().toString()) {
      e.preventDefault(); clearTimeout(timer);
      const prevLen = f.lines[li - 1].length; f.lines[li - 1] += t; f.lines.splice(li, 1); touch(id); redraw({ id, li: li - 1, off: prevLen });
    } else if (e.key === "Delete" && off === t.length && li + 1 < f.lines.length && !getSelection().toString()) {
      e.preventDefault(); clearTimeout(timer);
      f.lines[li] = t + f.lines[li + 1]; f.lines.splice(li + 1, 1); touch(id); redraw({ id, li, off });
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); saveCd(body, id);
    }
  };
  body.onpaste = (e) => {
    const el = e.target.closest(".cd-tx[data-id]"); if (!el) return;
    e.preventDefault();
    const id = Number(el.dataset.id), li = Number(el.dataset.li), f = cd.files[id], off = caretOffset(el), t = el.textContent;
    const parts = (e.clipboardData.getData("text/plain") || "").replace(/\r\n/g, "\n").split("\n");
    const head = t.slice(0, off), tail = t.slice(off);
    parts[0] = head + parts[0];
    const lastOff = parts[parts.length - 1].length;
    parts[parts.length - 1] += tail;
    f.lines.splice(li, 1, ...parts); touch(id); redraw({ id, li: li + parts.length - 1, off: lastOff });
  };
  body.querySelectorAll(".cd-body").forEach((b) => b.addEventListener("scroll", () => {
    if (!cd.sync || syncing) return;
    syncing = true;
    body.querySelectorAll(".cd-body").forEach((o) => { if (o !== b) { o.scrollTop = b.scrollTop; } });
    requestAnimationFrame(() => { syncing = false; });
  }, { passive: true }));
  body.querySelectorAll("[data-grip]").forEach((g) => g.addEventListener("pointerdown", (e) => {
    const colEl = g.previousElementSibling, id = Number(g.dataset.grip), x0 = e.clientX, w0 = colEl.getBoundingClientRect().width;
    g.setPointerCapture(e.pointerId);
    const move = (ev) => { const w = Math.max(220, w0 + ev.clientX - x0); colEl.style.flexBasis = `${w}px`; cd.widths[id] = w; };
    const up = () => { g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); };
    g.addEventListener("pointermove", move); g.addEventListener("pointerup", up);
  }));
  body.onchange = (e) => { const o = e.target.closest("[data-cdopt]"); if (o) { cd[o.dataset.cdopt] = o.checked; redraw(); } };
  body.onclick = async (e) => {
    if (e.target.closest("[data-cdback]")) {
      if (Object.values(cd.files).some((f) => f.dirty) && !cfm("保存していない変更があります。破棄して一覧に戻りますか?")) return;
      cd.path = null; cd.files = null; renderCfgDiff(); return;
    }
    const bs = e.target.closest("[data-cdbase]"); if (bs) { cd.base = Number(bs.dataset.cdbase); redraw(); return; }
    const sv = e.target.closest("[data-cdsave]"); if (sv) { saveCd(body, Number(sv.dataset.cdsave)); return; }
    const cr = e.target.closest("[data-cdcreate]");
    if (cr) { const f = cd.files[Number(cr.dataset.cdcreate)]; f.lines = cd.files[cd.base].lines.slice(); f.eol = cd.files[cd.base].eol; f.dirty = true; redraw(); return; }
    const nv = e.target.closest("[data-cdnav]");
    if (nv) {
      const dir = Number(nv.dataset.cdnav), b = body.querySelector(".cd-body");
      const starts = [...b.querySelectorAll(".cd-ln")].filter((el, i, all) => el.matches(".d-base, .d-chg, .d-miss, .d-extra, .d-gap") && !(i > 0 && all[i - 1].matches(".d-base, .d-chg, .d-miss, .d-extra, .d-gap")));
      const top = b.scrollTop + 4;
      const target = dir > 0 ? starts.find((el) => el.offsetTop > top + 2) : [...starts].reverse().find((el) => el.offsetTop < top - 2);
      if (target) { b.scrollTop = target.offsetTop - 24; body.querySelectorAll(".cd-body").forEach((o) => { if (o !== b) o.scrollTop = b.scrollTop; }); }
      return;
    }
    const act = e.target.closest("[data-cdact]");
    if (act) {
      const [id, ri] = act.dataset.cdact.split(":").map(Number);
      const row = cd.rows[ri], base = cd.files[cd.base];
      const setLike = (oid) => {  // この行を、基準と同じにする
        const k = cd.others.indexOf(oid), c = row.cells[k], f = cd.files[oid];
        if (row.base === null) { if (c.i !== null) f.lines.splice(c.i, 1); }
        else if (c.i !== null) f.lines[c.i] = base.lines[row.base];
        else f.lines.splice(row.at[k], 0, base.lines[row.base]);
        touch(oid);
      };
      const items = id === cd.base
        ? [{ label: "この行をほかのサーバーすべてへ", icon: "send", run: () => { cd.others.forEach(setLike); redraw(); } }]
        : [{ label: "この行を基準に合わせる", icon: "arrows", run: () => { setLike(id); redraw(); } },
          ...(row.cells[cd.others.indexOf(id)].i !== null ? [{ label: "この行を基準へ写す", icon: "back", run: () => {
            const f = cd.files[id], li = row.cells[cd.others.indexOf(id)].i;
            if (row.base !== null) base.lines[row.base] = f.lines[li];
            else { const at = cd.rows.slice(0, ri).reduce((n, r) => (r.base !== null ? r.base + 1 : n), 0); base.lines.splice(at, 0, f.lines[li]); }
            touch(cd.base); redraw();
          } }] : [])];
      openMenu(act, items);
    }
  };
}
async function saveCd(body, id) {
  const cd = state.cd, f = cd.files[id];
  const text = joinText(f);
  const put = (force) => api(`/api/servers/${id}/file`, { method: "PUT", json: { path: cd.path, text, hash: f.exists ? f.hash : "", force } });
  try {
    let r;
    try { r = await put(false); } catch (ex) {
      if (/字下げ|書き方/.test(ex.message) && cfm(`${ex.message}\n\nそれでも保存しますか?`)) r = await put(true); else throw ex;
    }
    f.hash = r.hash; f.saved = text; f.exists = true; f.dirty = false;
    toast(`${((state.servers || []).find((s) => s.id === id) || {}).name || ""} の ${cd.path} を保存しました`);
    drawCdCompare(body);
  } catch (ex) { toast(ex.message, true); }
}
window.addEventListener("beforeunload", (e) => { if (state.cd && state.cd.files && Object.values(state.cd.files).some((f) => f.dirty)) { e.preventDefault(); e.returnValue = ""; } });
