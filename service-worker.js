const cacheName = "splob-v15";
const assets = [
  "/",
  "/index.html",
  "/env.js",
  "/manifest.webmanifest",
  "/assets/icon.svg",
  "/assets/ui/title.png",
  "/assets/ui/singleplayer.png",
  "/assets/ui/multiplayer.png",
  "/assets/ui/host-game.png",
  "/assets/ui/join-game.png",
  "/assets/ui/play-again.png",
  "/assets/ui/main-menu.png",
  "/assets/ui/profile.png",
  "/assets/ui/settings.png",
  "/assets/splats/splat-1.png",
  "/assets/splats/splat-2.png",
  "/assets/splats/splat-3.png",
  "/assets/powerups/shield.png",
  "/assets/powerups/banana.png",
  "/assets/powerups/reverse.png",
  "/assets/powerups/messy.png",
  "/assets/powerups/spiky.png",
  "/assets/powerups/paintball.png",
  "/assets/powerups/splat.png",
  "/assets/powerups/boost.png",
  "/assets/powerups/shrink.png",
  "/assets/powerups/freeze.png",
  "/assets/powerups/grow.png",
  "/assets/powerups/slow.png",
  "/src/main.js",
  "/src/styles.css"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(cacheName).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match("/index.html")))
  );
});
