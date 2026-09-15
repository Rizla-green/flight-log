// Minimal service worker: caches the app shell so it installs as a PWA
// and reloads instantly on repeat opens. It does NOT cache Firebase/API
// calls, so your data is always fetched live — only the app's own files
// are cached.
const CACHE_NAME = "flight-log-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  // The Firebase SDK itself, so login + the database still load with no
  // signal at all (not just Firestore's own offline data cache).
  "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // The Firebase SDK files are cached so login/database code still loads
  // with no connection at all — cache first, network as a fallback/update.
  if (url.origin === "https://www.gstatic.com") {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  // Everything else cross-origin (Firestore's own traffic, what3words,
  // Open-Meteo) goes straight to the network — never cached — so your
  // data stays live and Firestore's own offline queueing can do its job.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
