"use strict";
/* CraftShelf のサービスワーカー(ホーム画面に追加したときの動き)。
   - 画面のファイル(/static/…?v=版)だけを保存し、2 回目からすぐ開けるようにする
   - API(/api/…)や共有リンクは保存しない(ログインの状態や登録情報を端末に残さない)
   - つながらないときは、最後に開いた画面を出す(画面は「サーバーに接続できません」と表示する) */
const CACHE = "craftshelf-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && url.pathname === "/") {  // 画面: まずサーバーから。つながらなければ保存した画面
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put("/", res.clone());
        return res;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/static/") && url.searchParams.has("v")) {  // 版つきのファイルは中身が変わらない
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
        // 古い版のファイルを片付ける(同じファイルで v が違うもの)
        for (const k of await c.keys()) {
          const u = new URL(k.url);
          if (u.pathname === url.pathname && u.search !== url.search) c.delete(k);
        }
      }
      return res;
    })());
  }
});
