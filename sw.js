/* ================================================================
  CicloAnts — Service Worker v3.4
   Strategia:
   - Cache-first per risorse statiche locali
   - Network-only per tile mappa, API esterne, Supabase
   ================================================================ */

const CACHE_STATIC = 'cicloants-static-v3.4';

/* Risorse da precacheare all'installazione */
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css?v=3.4',
  './app.js?v=3.4',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap',
];

/* Pattern di URL da NON cacheare (sempre network) */
const NETWORK_ONLY_PATTERNS = [
  /basemaps\.cartocdn\.com/,         // tile mappa
  /router\.project-osrm\.org/,       // routing OSRM
  /nominatim\.openstreetmap\.org/,   // geocodifica
  /supabase\.co/,                    // backend real-time
  /unpkg\.com/,                      // CDN Leaflet
  /cdn\.jsdelivr\.net/,              // CDN Supabase
  /fonts\.gstatic\.com/,            // Google Fonts files
];

/* ── Install ──────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate ─────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch ────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Escludi richieste non-GET
  if (event.request.method !== 'GET') return;

  // Escludi URL esterni sempre-network
  const isNetworkOnly = NETWORK_ONLY_PATTERNS.some(rx => rx.test(url));
  if (isNetworkOnly) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first per risorse statiche locali
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Cache solo risposte valide
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_STATIC).then(cache => cache.put(event.request, clone));
        return response;
      });
    }).catch(() => {
      // Fallback offline: ritorna index.html per navigazione
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
