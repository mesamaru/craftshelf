"use strict";
/* CraftShelf のサービスワーカー(ホーム画面に追加したときの動き)。
   - 画面はいつもサーバーから読む(ログインの状態や登録した内容を端末に残さない)
   - つながらないときだけ、入れたときに保存した「つながっていません」の画面を出す */
const CACHE = "craftshelf-offline-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
});
