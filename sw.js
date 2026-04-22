/* FDDB Dash — Service Worker
   Strategy:
   - App shell (HTML/CSS/JS/icons + CDN libs): cache-first, network-fallback.
     Lets the app launch instantly and work offline after first load.
   - Supabase API calls (anything under *.supabase.co): network-only.
     We never want stale food/adherence data.
   - GitHub API calls: network-only too.
   Bump CACHE_VERSION whenever shell assets change so old caches get purged. */

const CACHE_VERSION = 'v21';
const CACHE_NAME = `fddb-dash-${CACHE_VERSION}`;

// Pre-cache these at install so the first offline launch works fully.
const SHELL_ASSETS = [
  './',
  './index.html',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-1024.png',
  './icon-maskable-1024.png',
  './manifest.json',
  // CDN libs the app uses
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Use addAll but catch failures so one bad CDN URL doesn't break install
      Promise.allSettled(SHELL_ASSETS.map(url =>
        cache.add(new Request(url, { mode: 'no-cors' })).catch(() => null)
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache Supabase or API requests — always go to network
  if (url.hostname.endsWith('supabase.co') ||
      url.hostname.endsWith('supabase.in') ||
      url.hostname === 'api.github.com') {
    return; // let the browser handle it normally
  }

  // Only GET is cacheable
  if (req.method !== 'GET') return;

  // Cache-first for shell + CDN resources
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Only cache successful same-origin or opaque responses
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached); // offline fallback
    })
  );
});
