// CraftShelf の利用状況・お問い合わせの受け口(Cloudflare Workers + D1)
//
//   POST /v1/ping       … パネルからの匿名の利用状況(1 日 1 回。利用者が同意したパネルだけが送る)
//   POST /v1/feedback   … お問い合わせ・要望(Discord にも通知できる)
//   GET  /admin         … 開発者用の集計ページ(ADMIN_PASSWORD の Basic 認証)
//
// 個人情報は受け取らない・残さない方針: IP アドレスは保存せず、送りすぎの制限にだけ
// 「その日だけ有効な塩」で一方向にハッシュした値を使う。受け取る項目は下の一覧のものだけ。

const BUCKETS = ["0", "1-9", "10-49", "50-199", "200+"];
const ENUMS = {
  channel: ["stable", "dev"],
  os: ["linux", "windows", "macos", "other"],
  mode: ["docker", "installer", "script", "source"],
  lang: ["ja", "en"],
};
const LIST_FIELDS = {
  storage: ["local", "smb", "webdav"],
  features: ["ptero", "discord", "curseforge", "backup", "auto_update", "share_links", "sharing", "totp", "api_tokens"],
  categories: ["plugin", "mod", "datapack", "resourcepack", "shader", "modpack", "other"],
};
const BUCKET_FIELDS = ["items", "users", "servers", "sets"];
const FEEDBACK_KINDS = { request: "要望", bug: "不具合", question: "質問", other: "その他" };
const LABELS = {
  os: { linux: "Linux", windows: "Windows", macos: "macOS", other: "その他" },
  mode: { docker: "Docker", installer: "インストーラー版", script: "install.sh", source: "ソースから" },
  channel: { stable: "安定版", dev: "開発ビルド" },
  lang: { ja: "日本語", en: "English" },
  storage: { local: "ローカル", smb: "SMB(NAS)", webdav: "WebDAV" },
  features: {
    ptero: "Pterodactyl 連携", discord: "Discord 通知", curseforge: "CurseForge", backup: "自動バックアップ",
    auto_update: "自動アップデート", share_links: "共有リンク", sharing: "ユーザー間の共有", totp: "二段階認証", api_tokens: "API トークン",
  },
  categories: { plugin: "プラグイン", mod: "Mod", datapack: "データパック", resourcepack: "リソースパック", shader: "シェーダー", modpack: "Modパック", other: "その他" },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const today = () => new Date().toISOString().slice(0, 10);
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const VERSION_RE = /^\d{2}\.\d{2}\.\d{2}$/;

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* 送りすぎの制限。key ごと・時間枠ごとに数え、上限を超えたら false */
async function allow(env, key, limit, windowLabel) {
  const row = await env.DB.prepare("SELECT window, count FROM ratelimit WHERE key=?").bind(key).first();
  if (row && row.window === windowLabel) {
    if (row.count >= limit) return false;
    await env.DB.prepare("UPDATE ratelimit SET count=count+1 WHERE key=?").bind(key).run();
    return true;
  }
  await env.DB.prepare("INSERT INTO ratelimit (key, window, count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window, count=1")
    .bind(key, windowLabel).run();
  return true;
}
async function ipKey(req, env, scope) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  return `${scope}:${(await sha256(`${env.HASH_SALT || "craftshelf"}|${today()}|${ip}`)).slice(0, 32)}`;
}

/* ---- パネルからの利用状況 ---- */
async function ping(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const id = str(b.install_id, 32);
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "bad install_id" }, 400);
  const version = VERSION_RE.test(str(b.version, 8)) ? str(b.version, 8) : "";
  if (!(await allow(env, await ipKey(req, env, "ping"), 60, new Date().toISOString().slice(0, 13)))) return json({ error: "too many" }, 429);
  const pick = (k) => (ENUMS[k].includes(b[k]) ? b[k] : "");
  const data = {};
  for (const k of BUCKET_FIELDS) if (BUCKETS.includes(b[k])) data[k] = b[k];
  for (const [k, allowed] of Object.entries(LIST_FIELDS)) {
    if (Array.isArray(b[k])) data[k] = [...new Set(b[k].filter((x) => allowed.includes(x)))];
  }
  const arch = /^[a-z0-9_]{1,16}$/.test(str(b.arch, 16).toLowerCase()) ? str(b.arch, 16).toLowerCase() : "";
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installs (id, first_seen, last_seen, version, channel, os, arch, mode, lang, data) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version, channel=excluded.channel, os=excluded.os,
      arch=excluded.arch, mode=excluded.mode, lang=excluded.lang, data=excluded.data`)
      .bind(id, t, t, version, pick("channel"), pick("os"), arch, pick("mode"), pick("lang"), JSON.stringify(data)),
    env.DB.prepare("INSERT OR REPLACE INTO daily (day, install_id, version) VALUES (?,?,?)").bind(today(), id, version),
  ]);
  return json({ ok: true });
}

/* ---- お問い合わせ ---- */
async function feedback(req, env, ctx) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const kind = FEEDBACK_KINDS[b.kind] ? b.kind : "other";
  const message = str(b.message, 4000);
  if (message.length < 2) return json({ error: "内容を入力してください" }, 400);
  if (!(await allow(env, await ipKey(req, env, "fb"), 5, new Date().toISOString().slice(0, 13)))) {
    return json({ error: "短い時間に送れる回数を超えました。しばらくしてからもう一度お試しください" }, 429);
  }
  const row = {
    kind, message, contact: str(b.contact, 200),
    version: VERSION_RE.test(str(b.version, 8)) ? str(b.version, 8) : "",
    os: ENUMS.os.includes(b.os) ? b.os : "", mode: ENUMS.mode.includes(b.mode) ? b.mode : "",
  };
  await env.DB.prepare("INSERT INTO feedback (created_at, kind, message, contact, version, os, mode) VALUES (?,?,?,?,?,?,?)")
    .bind(now(), row.kind, row.message, row.contact, row.version, row.os, row.mode).run();
  if (env.DISCORD_WEBHOOK) ctx.waitUntil(notifyDiscord(env.DISCORD_WEBHOOK, row).catch(() => {}));
  return json({ ok: true });
}
async function notifyDiscord(url, r) {
  const env = [r.version && `v${r.version}`, LABELS.os[r.os], LABELS.mode[r.mode]].filter(Boolean).join(" · ");
  await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "CraftShelf お問い合わせ",
      allowed_mentions: { parse: [] },  // @everyone などで通知が飛ばないように
      embeds: [{
        title: `【${FEEDBACK_KINDS[r.kind]}】新しいお問い合わせ`, description: r.message.slice(0, 3900), color: 0x2a78d6,
        fields: [...(r.contact ? [{ name: "返信先", value: r.contact.slice(0, 200) }] : []), ...(env ? [{ name: "環境", value: env }] : [])],
      }],
    }),
  });
}

/* ---- 開発者用の集計 ---- */
async function authorized(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let pass = "";
  try { pass = atob(h.slice(6)).split(":").slice(1).join(":"); } catch { return false; }
  const [a, b] = await Promise.all([sha256(pass), sha256(env.ADMIN_PASSWORD)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function stats(env) {
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const [a1, a7, a30, total, new30, daily, rows, fb, fbNew] = await env.DB.batch([
    q("SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?", ago(1)),
    q("SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?", ago(7)),
    q("SELECT COUNT(*) AS n FROM installs WHERE last_seen >= ?", ago(30)),
    q("SELECT COUNT(*) AS n FROM installs"),
    q("SELECT COUNT(*) AS n FROM installs WHERE first_seen >= ?", ago(30)),
    q("SELECT day, COUNT(*) AS n FROM daily WHERE day >= ? GROUP BY day ORDER BY day", ago(60).slice(0, 10)),
    q("SELECT version, channel, os, arch, mode, lang, data FROM installs WHERE last_seen >= ?", ago(30)),
    q("SELECT * FROM feedback ORDER BY id DESC LIMIT 200"),
    q("SELECT COUNT(*) AS n FROM feedback WHERE status='new'"),
  ]);
  const active = rows.results;
  const dist = (getter) => {
    const m = {};
    for (const r of active) for (const v of [].concat(getter(r))) if (v) m[v] = (m[v] || 0) + 1;
    return Object.entries(m).sort((x, y) => y[1] - x[1]);
  };
  const data = (r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } };
  // 0 件の日も並べる(日ごとの稼働数)
  const byDay = Object.fromEntries(daily.results.map((r) => [r.day, r.n]));
  const days = [];
  for (let i = 59; i >= 0; i--) { const d = ago(i).slice(0, 10); days.push([d, byDay[d] || 0]); }
  return {
    generated_at: now(),
    active_1d: a1.results[0].n, active_7d: a7.results[0].n, active_30d: a30.results[0].n,
    installs_total: total.results[0].n, installs_new_30d: new30.results[0].n,
    daily: days, base: active.length,
    dist: {
      version: dist((r) => r.version || "不明"), channel: dist((r) => LABELS.channel[r.channel] || "不明"),
      os: dist((r) => LABELS.os[r.os] || "不明"), mode: dist((r) => LABELS.mode[r.mode] || "不明"),
      arch: dist((r) => r.arch || "不明"), lang: dist((r) => LABELS.lang[r.lang] || "不明"),
      items: dist((r) => data(r).items || "不明").sort((x, y) => BUCKETS.indexOf(x[0]) - BUCKETS.indexOf(y[0])),
      users: dist((r) => data(r).users || "不明").sort((x, y) => BUCKETS.indexOf(x[0]) - BUCKETS.indexOf(y[0])),
      storage: dist((r) => (data(r).storage || []).map((x) => LABELS.storage[x])),
      features: dist((r) => (data(r).features || []).map((x) => LABELS.features[x])),
      categories: dist((r) => (data(r).categories || []).map((x) => LABELS.categories[x])),
    },
    feedback: fb.results.map((r) => ({ ...r, kind_label: FEEDBACK_KINDS[r.kind] || r.kind })),
    feedback_new: fbNew.results[0].n,
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "POST" && p === "/v1/ping") return await ping(req, env);
      if (req.method === "POST" && p === "/v1/feedback") return await feedback(req, env, ctx);
      if (p === "/" || p === "/v1/health") return json({ ok: true, service: "craftshelf-telemetry" });
      if (p.startsWith("/admin")) {
        if (!(await authorized(req, env))) {
          return new Response("認証が必要です", { status: 401, headers: { "www-authenticate": 'Basic realm="CraftShelf stats", charset="UTF-8"' } });
        }
        const sec = { "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };
        if (p === "/admin" || p === "/admin/") return new Response(ADMIN_HTML, { headers: { ...sec, "content-type": "text/html; charset=utf-8" } });
        if (p === "/admin/app.js") return new Response(ADMIN_JS, { headers: { ...sec, "content-type": "text/javascript; charset=utf-8" } });
        if (p === "/admin/api/stats") return json(await stats(env));
        const m = p.match(/^\/admin\/api\/feedback\/(\d+)$/);
        if (m && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const st = b.status === "done" ? "done" : "new";
          await env.DB.prepare("UPDATE feedback SET status=? WHERE id=?").bind(st, Number(m[1])).run();
          return json({ ok: true });
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "internal error" }, 500);
    }
  },
  // 古いデータを片付ける(稼働の記録は 400 日、送りすぎの制限は前日まで)
  async scheduled(_ev, env) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily WHERE day < ?").bind(ago(400).slice(0, 10)),
      env.DB.prepare("DELETE FROM installs WHERE last_seen < ?").bind(ago(400)),
      env.DB.prepare("DELETE FROM ratelimit WHERE window < ?").bind(new Date(Date.now() - 86400000).toISOString().slice(0, 13)),
    ]);
  },
};

/* ================= 集計ページ ================= */
const ADMIN_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>CraftShelf 利用状況</title>
<style>
:root { --surface: #fcfcfb; --card: #ffffff; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e7e6e2; --series: #2a78d6; --good: #1a7f37; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --surface: #1a1a19; --card: #242423; --ink: #ffffff; --ink-2: #c3c2b7; --grid: #3a3a37; --series: #3987e5; --good: #4ac26b; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; } .sub { color: var(--ink-2); font-size: 13px; margin: 0 0 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile, .card { background: var(--card); border-radius: 16px; padding: 14px 16px; border: 1px solid var(--grid); }
.tile .k { font-size: 12.5px; color: var(--ink-2); } .tile .v { font-size: 30px; font-weight: 750; font-variant-numeric: tabular-nums; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.card h2 { font-size: 15px; margin: 0 0 10px; } .card .note { font-size: 12px; color: var(--ink-2); margin: -6px 0 10px; }
.bars { display: grid; gap: 8px; }
.bar { display: grid; grid-template-columns: minmax(90px, 34%) 1fr auto; gap: 10px; align-items: center; font-size: 13.5px; }
.bar .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar .track { display: block; height: 10px; border-radius: 4px; background: var(--grid); overflow: hidden; }
.bar .fill { display: block; height: 100%; border-radius: 0 4px 4px 0; background: var(--series); min-width: 2px; }
.bar .val { font-variant-numeric: tabular-nums; color: var(--ink-2); font-size: 12.5px; white-space: nowrap; }
.empty { color: var(--ink-2); font-size: 13px; }
#chart { position: relative; } #chart svg { display: block; width: 100%; height: 220px; }
.tip { position: absolute; pointer-events: none; background: var(--ink); color: var(--surface); font-size: 12px; padding: 4px 8px; border-radius: 6px; white-space: nowrap; transform: translate(-50%, -110%); }
details { margin-top: 8px; font-size: 13px; } summary { cursor: pointer; color: var(--ink-2); }
table { border-collapse: collapse; width: 100%; font-size: 13px; } td, th { padding: 4px 6px; border-bottom: 1px solid var(--grid); text-align: left; } td.n { text-align: right; font-variant-numeric: tabular-nums; }
.fb { border-top: 1px solid var(--grid); padding: 12px 0; } .fb:first-child { border-top: 0; }
.fb .h { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
.fb .kind { font-weight: 700; color: var(--ink); } .fb .msg { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; }
.fb.done { opacity: .55; } .fb button { margin-left: auto; font: inherit; font-size: 12.5px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--grid); background: transparent; color: var(--ink); cursor: pointer; }
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 700; color: var(--good); }
.filters { display: flex; gap: 8px; margin: 0 0 10px; } .filters button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--grid); background: transparent; color: var(--ink); cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--ink); color: var(--surface); }
</style></head><body><main>
<h1>CraftShelf 利用状況</h1><p class="sub" id="sub">読み込み中…</p>
<div class="tiles" id="tiles"></div>
<div class="card" style="margin-bottom:12px"><h2>日ごとの稼働数(直近 60 日)</h2><div id="chart"></div>
  <details><summary>表で見る</summary><div id="dailyTable"></div></details></div>
<div class="grid" id="dists"></div>
<div class="card" style="margin-top:12px"><h2>お問い合わせ</h2>
  <div class="filters" id="fbf"><button type="button" data-f="new" aria-pressed="true">未対応</button><button type="button" data-f="all" aria-pressed="false">すべて</button></div>
  <div id="fb"></div></div>
</main><script src="/admin/app.js"></script></body></html>`;

const ADMIN_JS = `"use strict";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (s) => document.querySelector(s);
let S = null, fbFilter = "new";
const TITLES = { version: "バージョン", channel: "受け取る版", os: "OS", mode: "導入方法", arch: "CPU", lang: "言語",
  items: "登録しているアドオンの数", users: "ユーザー数", storage: "保存先の種類", features: "使っている機能", categories: "扱っている種類" };
const MULTI = new Set(["storage", "features", "categories"]);
function tile(k, v) { return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }
function bars(key, rows) {
  if (!rows.length) return '<div class="empty">まだデータがありません</div>';
  const base = S.base || 1, max = Math.max(...rows.map((r) => r[1]));
  return '<div class="bars">' + rows.slice(0, 12).map(([lab, n]) => '<div class="bar" title="' + esc(lab) + ': ' + n + ' 台">'
    + '<span class="lab">' + esc(lab) + '</span><span class="track"><span class="fill" style="width:' + (n / max * 100).toFixed(1) + '%"></span></span>'
    + '<span class="val">' + n + ' 台 · ' + Math.round(n / base * 100) + '%</span></div>').join("") + '</div>';
}
function chart() {
  const d = S.daily, W = 1000, H = 220, pl = 36, pr = 8, pt = 10, pb = 26;
  const max = Math.max(1, ...d.map((x) => x[1]));
  const step = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / step) * step;
  const bw = (W - pl - pr) / d.length, y = (v) => pt + (H - pt - pb) * (1 - v / top);
  let g = "";
  for (let i = 0; i <= 4; i++) { const v = top / 4 * i, yy = y(v); g += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--grid)" stroke-width="1"/><text x="' + (pl - 6) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="11" fill="var(--ink-2)">' + Math.round(v) + '</text>'; }
  const bars = d.map(([day, n], i) => { const x = pl + i * bw + 1, h = Math.max(0, H - pb - y(n)), w = Math.max(1, bw - 2);
    return '<rect x="' + x + '" y="' + (H - pb - h) + '" width="' + w + '" height="' + h + '" rx="' + Math.min(4, w / 2) + '" fill="var(--series)"/>'
      + '<rect class="hit" data-i="' + i + '" x="' + (pl + i * bw) + '" y="' + pt + '" width="' + bw + '" height="' + (H - pt - pb) + '" fill="transparent"/>'; }).join("");
  const labs = d.map(([day], i) => (i % 10 === 0 || i === d.length - 1) ? '<text x="' + (pl + i * bw + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="var(--ink-2)">' + day.slice(5).replace("-", "/") + '</text>' : "").join("");
  $("#chart").innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="日ごとの稼働数">' + g + bars + labs + '</svg><div class="tip" hidden></div>';
  const tip = $("#chart .tip");
  $("#chart svg").addEventListener("mousemove", (e) => { const r = e.target.closest(".hit"); if (!r) { tip.hidden = true; return; }
    const [day, n] = d[Number(r.dataset.i)], box = $("#chart").getBoundingClientRect();
    tip.hidden = false; tip.textContent = day + ": " + n + " 台"; tip.style.left = (e.clientX - box.left) + "px"; tip.style.top = (e.clientY - box.top) + "px"; });
  $("#chart svg").addEventListener("mouseleave", () => { tip.hidden = true; });
  $("#dailyTable").innerHTML = '<table><tr><th>日付</th><th>台数</th></tr>' + d.slice().reverse().map(([day, n]) => '<tr><td>' + day + '</td><td class="n">' + n + '</td></tr>').join("") + '</table>';
}
function drawFeedback() {
  const list = S.feedback.filter((f) => fbFilter === "all" || f.status === "new");
  $("#fb").innerHTML = list.length ? list.map((f) => '<div class="fb' + (f.status === "done" ? " done" : "") + '"><div class="h"><span class="kind">' + esc(f.kind_label) + '</span>'
    + '<span>' + esc(f.created_at.replace("T", " ").replace("Z", " UTC")) + '</span>' + (f.version ? '<span>v' + esc(f.version) + '</span>' : "") + (f.os ? '<span>' + esc(f.os) + '</span>' : "")
    + (f.contact ? '<span>返信先: ' + esc(f.contact) + '</span>' : "") + (f.status === "done" ? '<span class="badge">✓ 対応済み</span>' : "")
    + '<button type="button" data-fid="' + f.id + '" data-st="' + (f.status === "done" ? "new" : "done") + '">' + (f.status === "done" ? "未対応に戻す" : "対応済みにする") + '</button></div>'
    + '<p class="msg">' + esc(f.message) + '</p></div>').join("") : '<div class="empty">' + (fbFilter === "new" ? "未対応のお問い合わせはありません" : "まだお問い合わせはありません") + '</div>';
}
const API = location.origin + "/admin/api";  // URL に認証情報が付いていても動くように、origin から組み立てる
async function load() {
  try {
    const r = await fetch(API + "/stats", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    S = await r.json();
  } catch (e) { $("#sub").textContent = "読み込めませんでした(" + e.message + ")。ページを再読み込みしてください"; return; }
  $("#sub").textContent = "直近 30 日に動いていたパネル " + S.base + " 台をもとに集計 · " + S.generated_at.replace("T", " ").replace("Z", " UTC") + " 時点";
  $("#tiles").innerHTML = tile("24 時間以内に稼働", S.active_1d) + tile("7 日以内に稼働", S.active_7d) + tile("30 日以内に稼働", S.active_30d)
    + tile("これまでの設置数", S.installs_total) + tile("30 日の新規設置", S.installs_new_30d) + tile("未対応のお問い合わせ", S.feedback_new);
  chart();
  $("#dists").innerHTML = Object.keys(TITLES).map((k) => '<div class="card"><h2>' + esc(TITLES[k]) + '</h2>' + (MULTI.has(k) ? '<p class="note">複数あてはまるため、合計は 100% になりません</p>' : "") + bars(k, S.dist[k] || []) + '</div>').join("");
  drawFeedback();
}
$("#fbf").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; fbFilter = b.dataset.f;
  document.querySelectorAll("#fbf button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawFeedback(); });
$("#fb").addEventListener("click", async (e) => { const b = e.target.closest("[data-fid]"); if (!b) return;
  await fetch(API + "/feedback/" + b.dataset.fid, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: b.dataset.st }) });
  const f = S.feedback.find((x) => String(x.id) === b.dataset.fid); if (f) f.status = b.dataset.st; S.feedback_new = S.feedback.filter((x) => x.status === "new").length; drawFeedback(); });
load();
`;
