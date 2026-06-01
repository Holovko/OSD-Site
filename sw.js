/*
 * Service Worker — caches the app shell so the page loads even when the
 * dev server / network is unreachable. Order data itself lives in IndexedDB
 * and is rendered by app.js from cache via renderFromCache().
 *
 * Strategy:
 *   - app shell (HTML/CSS/JS): network-first, fall back to cache
 *   - API & SignalR calls: never cached, never intercepted — let the page
 *     handle errors and show stale IndexedDB data
 */

const CACHE = "osd-shell-v1";
const SHELL = [
    "/",
    "/index.html",
    "/styles.css",
    "/app.js",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(SHELL))
    );
    // Activate this version immediately, replacing any prior SW.
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const names = await caches.keys();
            await Promise.all(
                names.filter((n) => n !== CACHE).map((n) => caches.delete(n))
            );
            await self.clients.claim();
        })()
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // Never intercept API / SignalR — let them fail naturally so the page can
    // fall back to the IndexedDB-cached orders rendered by renderFromCache().
    if (url.pathname.startsWith("/tacitlinkx") || url.pathname.startsWith("/webservices")) {
        return;
    }

    event.respondWith(
        (async () => {
            try {
                const fresh = await fetch(req);
                // Keep the shell cache up to date opportunistically.
                if (fresh && fresh.ok) {
                    const copy = fresh.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
                }
                return fresh;
            } catch (e) {
                const cached = await caches.match(req);
                if (cached) return cached;
                // Last resort: serve the cached index for navigation requests.
                if (req.mode === "navigate") {
                    const idx = await caches.match("/index.html");
                    if (idx) return idx;
                }
                throw e;
            }
        })()
    );
});
