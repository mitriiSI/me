export function setupOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const worker = new URL('./sw.js', import.meta.url);
  worker.search = new URL(import.meta.url).search;
  let preparing = false;

  async function prepareCache() {
    if (preparing || !navigator.onLine) return;
    preparing = true;
    try {
      const registration = await navigator.serviceWorker.register(worker.href, { updateViaCache: 'none' });
      registration.active?.postMessage({ type: 'offline-download' });
    } catch { /* The next online visit can retry the cache. */ }
    finally { preparing = false; }
  }

  window.addEventListener('online', prepareCache);
  window.addEventListener('pageshow', prepareCache);
  prepareCache();
}
