/* Service worker: lets the app be installed, and makes it open quickly.
   - The app's own files: always try the internet first (so updates show up straight away),
     and fall back to the saved copy if you're offline.
   - The libraries (Supabase, Chart.js) and fonts: use the saved copy, since their versions never change.
   - Your budget data (Supabase) is never saved here; it always comes fresh from the database. */

const CACHE = "budget-v4";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
const LIBRARY_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove saved copies from older versions of this file.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // App files: internet first, saved copy if offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((saved) => saved || caches.match("./index.html")))
    );
    return;
  }

  if (LIBRARY_HOSTS.includes(url.hostname)) {
    // Libraries and fonts: saved copy first, internet if not saved yet.
    event.respondWith(
      caches.match(request).then((saved) => saved || fetch(request).then((response) => {
        if (response.ok || response.type === "opaque") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
  }
  // Anything else (your Supabase data, gold prices) goes straight to the internet.
});