export function setupOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let preparing = false;

  async function prepareCache() {
    if (preparing || !navigator.onLine) return;
    preparing = true;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      registration.active?.postMessage({ type: 'offline-download' });
    } catch { /* The next online visit can retry the cache. */ }
    finally { preparing = false; }
  }

  window.addEventListener('online', prepareCache);
  window.addEventListener('pageshow', prepareCache);
  prepareCache();
}
