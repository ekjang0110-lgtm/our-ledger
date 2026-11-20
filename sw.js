// 화면 파일만 보관(네트워크 우선). 가계부 데이터는 보관하지 않습니다.
const CACHE = 'our-ledger-v21';
const SHELL = ['./', './index.html', './style.css', './js/app.js', './js/calc.js', './js/store.js', './js/parse.js', './js/ui.js', './js/decrypt.js', './js/biolock.js', './vendor/supabase.js', './vendor/xlsx.full.min.js', './icon.svg', './icon-192.png', './manifest.webmanifest'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => { })); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => { }); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
