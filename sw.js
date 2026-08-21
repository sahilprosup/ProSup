// App-shell cache for offline loads. index.html registers this at
// navigator.serviceWorker.register("./sw.js") but the file never existed in
// the repo, so that registration always 404'd silently (.catch(() => {}))
// and offline page loads never actually worked — only in-tab state (via
// queueOfflineUpload/restoreOfflineSnapshot in index.html) survived a drop
// in connectivity, not a fresh/reloaded load with no signal at all.
//
// Bump this on every deploy that changes index.html, or returning visitors
// offline will keep getting served a stale cached copy.
const CACHE_NAME = "prosup-shell-v1";
const SHELL_URLS = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for navigations (so a normal load always gets the latest
// deploy when online), falling back to the cached shell when offline.
// Everything else (Supabase calls, the jsdelivr CDN script, etc.) is left
// alone — this only concerns itself with serving the app shell.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
        return response;
      })
      .catch(() => caches.match("./index.html"))
  );
});
