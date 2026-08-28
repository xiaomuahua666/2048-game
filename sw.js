// Service worker template. scripts/build.mjs injects the asset list and a
// content-hash version, then writes sw.js at the repo root. Do not edit the
// generated sw.js directly.
"use strict";

const CACHE_NAME = "2048-cache-6c5cfd873a90";
const PRECACHE_ASSETS = ["./index.html","./src/styles.css","./src/game-core.js","./src/ai.js","./src/app.js","./src/ai-worker.js","./src/ziap/main.wasm","./src/favicon.svg","./src/favicon.png","./src/apple-touch-icon.png","./src/icon-192.png","./src/icon-512.png","./manifest.json"];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_ASSETS))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
            ))
            .then(() => self.clients.claim()),
    );
});

// The WASM AI engine uses shared memory, which requires cross-origin
// isolation. Vercel sends these headers itself (vercel.json); injecting
// them here as well makes any plain static host isolated from the second
// load onward, and keeps offline-served pages isolated too.
function withIsolationHeaders(response) {
    if (response.status === 0) return response; // opaque
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || event.request.method !== "GET") return;
    // Page navigations map to the cached shell; everything else is served
    // cache-first so the game keeps working fully offline.
    const target = event.request.mode === "navigate" ? "index.html" : event.request;
    event.respondWith(
        caches.match(target)
            .then((cached) => cached || fetch(event.request).then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            }))
            .then(withIsolationHeaders),
    );
});
