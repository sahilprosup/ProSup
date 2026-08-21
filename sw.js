// App-shell cache for ProSup. index.html registers this at "./sw.js" so the
// page itself (and its embedded CSS/JS/data — everything ships inline in one
// file) can still be opened with no signal. Cross-origin requests (Supabase
// API/storage calls) are left alone; the app's own IndexedDB layer handles
// offline data, this worker only needs to get the shell to load at all.
const CACHE_NAME = "prosup-shell-v1";
const SHELL_URL = self.registration.scope;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Supabase, CDN scripts, etc. — go straight to network

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match(SHELL_URL)))
  );
});
