// ─── Tactical Mesh Terminal — offline tile Service Worker ─────────────────
// Cache-first strategy for map tiles only. Everything else passes through
// to the network untouched. Must stay in sync with TILE_CACHE_NAME in app.js.

const TILE_CACHE_NAME = 'mesh-tile-cache-v1';
const TILE_HOST_PATTERN = /tile\.opentopomap\.org/;

// 1x1 transparent PNG, shown if a tile is requested offline and was never cached.
const BLANK_TILE_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function blankTileResponse() {
    const binary = atob(BLANK_TILE_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = event.request.url;
    if (!TILE_HOST_PATTERN.test(url)) return; // let app files / everything else pass through normally

    event.respondWith(
        (async () => {
            const cache = await caches.open(TILE_CACHE_NAME);
            const cached = await cache.match(event.request);
            if (cached) return cached;

            try {
                const response = await fetch(event.request);
                cache.put(event.request, response.clone());
                return response;
            } catch (err) {
                return blankTileResponse();
            }
        })()
    );
});
