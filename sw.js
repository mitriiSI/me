const cacheName = 'metro-signal-2026-11-23-6';
const base = self.registration.scope;
const index = new URL('./index.html', base).href;
const shell = [
  './index.html', './style.css?v=6', './app.mjs?v=6', './map.mjs?v=6',
  './network.mjs?v=6', './journey.mjs?v=6', './offline.mjs?v=6', './manifest.webmanifest',
  './assets/networks.json', './assets/map-template.json', './assets/manrope-lat.woff2',
  './assets/manrope-cyr.woff2', './assets/icon-192.png', './assets/icon-512.png',
].map(path => new URL(path, base).href);
const assetUrls = new Set(shell);
let downloading;

async function missingAssets(cache) {
  const stored = await Promise.all(shell.map(url => cache.match(url)));
  return shell.filter((_, i) => !stored[i]?.ok);
}

function downloadAssets() {
  if (!downloading) {
    downloading = (async () => {
      const cache = await caches.open(cacheName);
      const missing = await missingAssets(cache);
      if (missing.length) await cache.addAll(missing.map(url => new Request(url, { cache: 'reload' })));
      return (await missingAssets(cache)).length === 0;
    })().finally(() => { downloading = null; });
  }
  return downloading;
}

self.addEventListener('install', event => {
  event.waitUntil(downloadAssets().then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', event => {
  const type = event.data?.type;
  const port = event.ports[0];
  if (type !== 'offline-download' && !(type === 'offline-status' && port)) return;
  event.waitUntil((async () => {
    try {
      const ready = type === 'offline-download' ? await downloadAssets()
        : (await missingAssets(await caches.open(cacheName))).length === 0;
      port?.postMessage({ ready });
    } catch {
      port?.postMessage({ ready: false });
    }
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === new URL(base).pathname || url.pathname === new URL(index).pathname)) {
    event.respondWith((async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetch(request, { signal: controller.signal });
        if (response.status < 500) return response;
      } catch { /* The cached page supports navigation without a connection. */ }
      finally { clearTimeout(timer); }
      return (await caches.open(cacheName)).match(index).then(response => response ?? Response.error());
    })());
  } else if (assetUrls.has(url.href)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(request)) ?? fetch(request))());
  } else if (url.pathname.startsWith(new URL(base).pathname) && url.searchParams.has('v')) {
    // An open tab can still ask for modules from the immediately preceding release.
    event.respondWith(fetch(request).catch(async () => (await caches.match(request)) ?? Response.error()));
  }
});
