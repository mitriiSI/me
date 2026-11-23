function workerReady(registration) {
  if (registration.active && !registration.installing && !registration.waiting) {
    return Promise.resolve(registration.active);
  }
  const updating = registration.installing ?? registration.waiting;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null), 20_000);
    function finish(worker) {
      clearTimeout(timer);
      updating?.removeEventListener('statechange', changed);
      if (worker) resolve(worker);
      else reject(new Error('Offline worker unavailable'));
    }
    function changed() {
      if (updating.state === 'activated') finish(updating);
      if (updating.state === 'redundant') finish(null);
    }
    updating?.addEventListener('statechange', changed);
    if (updating) changed();
    else navigator.serviceWorker.ready.then(value => finish(value.active));
  });
}

function send(worker, type) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Offline download timed out'));
    }, type === 'offline-status' ? 5_000 : 20_000);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data?.ready === true);
    };
    worker.postMessage({ type }, [channel.port2]);
  });
}

export function setupOffline(button, label, mark, status) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    status.textContent = 'Офлайн-загрузка доступна при защищённом подключении.';
    button.disabled = true;
    return;
  }
  const registration = navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => null);
  let nextCheck = 0;
  let downloading = false;
  function display(ready, message = '') {
    button.dataset.ready = ready;
    label.textContent = ready ? 'Готово к офлайн-поездке' : 'Скачать для офлайна';
    mark.querySelector('use').setAttribute('href', ready ? '#i-check' : '#i-download');
    status.textContent = message;
  }
  async function request(type) {
    const value = await registration;
    if (!value) throw new Error('Offline worker registration failed');
    return send(await workerReady(value), type);
  }
  async function check() {
    if (downloading) return;
    const checkId = ++nextCheck;
    try {
      const ready = await request('offline-status');
      if (!downloading && checkId === nextCheck) display(ready);
    } catch { /* The download button can retry and show its result. */ }
  }
  button.onclick = async () => {
    downloading = true;
    button.disabled = true;
    label.textContent = 'Проверяем кэш…';
    status.textContent = '';
    navigator.storage?.persist?.().catch(() => {});
    try {
      const ready = await request('offline-download');
      display(ready, ready ? 'Все схемы сохранены в этом браузере.' : 'Для загрузки всех схем подключись к интернету.');
    } catch {
      display(false, 'Проверь подключение и разрешение браузера на хранение данных.');
    } finally {
      button.disabled = false;
      downloading = false;
    }
  };
  navigator.serviceWorker.addEventListener('controllerchange', check);
  window.addEventListener('pageshow', check);
  check();
}
