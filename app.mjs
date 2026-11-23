import { distance, makeRoute, prepareNetwork, stationNear } from './network.mjs?v=3';
import { MetroMap } from './map.mjs?v=3';
import { imminentAlert, nextEstimatedStop, positionOnJourney, stationTime, syncJourneyTime } from './journey.mjs?v=3';
import { setupOffline } from './offline.mjs?v=3';

const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fold = value => String(value).toLocaleLowerCase('ru').replace(/ё/g,'е').trim();
const storageKey = 'metro-signal-settings-v1';
const importKey = 'metro-signal-custom-v1';
const maxVia = 8;
const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};
const preferences = read(storageKey, {});
const sounds = { arrival: true, transfer: true, other: true, ...preferences.sounds };
let networks;
let custom = read(importKey, []);
if (!Array.isArray(custom)) custom = [];
let network, fields, route, ride, pendingMapMessage, audio;
const modal = $('modal');
const modalContent = $('modal-content');
const map = new MetroMap($('metro-map'), openMapStation);
const mapDialog = $('map-dialog');

function remember() {
  save(storageKey, { city: network.id, fields, sounds });
}

function selectCity(raw, saved) {
  stopRide();
  network = prepareNetwork(raw);
  const entry = value => network.stations.has(value) ? value : '';
  fields = saved && Array.isArray(saved.via) ? {
    from: entry(saved.from), to: entry(saved.to), via: saved.via.slice(0,maxVia).map(entry),
  } : { from: raw.defaults[0] ?? '', to: raw.defaults[1] ?? '', via: [] };
  $('city-label').textContent = network.name;
  const plural = new Intl.PluralRules('ru').select(network.lines.size);
  const lines = { one: 'линия', few: 'линии', many: 'линий', other: 'линий' }[plural];
  const kind = network.id === 'volgograd' ? 'Схема метротрама' : 'Схема метро';
  $('map-title').textContent = kind;
  $('swap-button').disabled = false;
  $('map-subtitle').textContent = `${network.name} · ${network.lines.size} ${lines}`;
  map.setNetwork(network, null);
  updateRoute();
}

function lineTag(line) {
  return `<span class="line-tag" style="--ink:${line.color}" title="${escape(line.name)}">${escape(line.number)}</span>`;
}

function fieldLabel(key) {
  if (key === 'from') return 'Откуда';
  if (key === 'to') return 'Куда';
  return fields.via.length > 1 ? `Через · ${Number(key)+1}` : 'Через';
}

function fieldValue(key) {
  return key === 'from' || key === 'to' ? fields[key] : fields.via[Number(key)];
}

function renderFields() {
  $('route-fields').innerHTML = ['from', ...fields.via.map((_,i) => String(i)), 'to'].map(key => {
    const station = network.stations.get(fieldValue(key));
    const hint = key === 'from' ? 'Выбрать станцию отправления' : key === 'to' ? 'Выбрать станцию назначения' : 'Выбрать промежуточную станцию';
    const via = !['from','to'].includes(key);
    return `<div class="station-field"><button class="pick-button" type="button" data-field="${key}" aria-haspopup="dialog" aria-label="${fieldLabel(key)}: ${station ? escape(station.name) : hint}">
      <i class="field-dot ${key === 'to' ? 'end' : via ? 'via' : ''}" aria-hidden="true"></i>
      <span><span class="pick-label">${fieldLabel(key)}</span><span class="pick-value ${station ? '' : 'empty'}">${station ? escape(station.name) : 'Выбрать станцию'}</span></span>
      ${station ? lineTag(station.line) : icon('chevron')}</button>
      ${via ? `<button class="remove-via" type="button" data-remove="${key}" aria-label="Убрать промежуточную станцию ${Number(key)+1}">${icon('close')}</button>` : ''}
    </div>`;
  }).join('');
  $('add-via').disabled = fields.via.length >= maxVia;
}

function updateRoute() {
  const ids = [fields.from, ...fields.via, fields.to];
  route = ids.every(Boolean) ? makeRoute(network, ids) : null;
  let error = '';
  if (ids.some((id,index) => id && id === ids[index-1])) {
    route = null;
    error = 'Выбери разные станции подряд.';
  } else if (!route && ids.every(Boolean)) {
    error = 'Между выбранными станциями нет маршрута. Проверь направление и промежуточные станции.';
  }
  $('route-error').textContent = error;
  $('route-error').hidden = !error;
  renderFields();
  renderSummary();
  map.setRoute(route);
  updateMapMode();
  remember();
}

function plural(number, forms) {
  return forms[new Intl.PluralRules('ru').select(number)] ?? forms.many;
}

function stopName(stop) {
  return [...new Set(stop.ids.map(id => network.stations.get(id).name))].join(' / ');
}

function renderSummary() {
  $('summary-card').hidden = !route;
  if (!route) return;
  const { stops, minutes, transfers } = route;
  $('summary-title').textContent = `≈ ${minutes} мин`;
  $('start-hint').textContent = route.segments[0].transfer ? 'Нажми, когда начнёшь переход.' : 'Нажми, когда поезд тронется.';
  const stopLabel = plural(stops.length,{one:'станция',few:'станции',many:'станций'});
  const transferLabel = plural(transfers,{one:'пересадка',few:'пересадки',many:'пересадок'});
  $('summary-stats').textContent = `${stops.length} ${stopLabel} · ${transfers ? `${transfers} ${transferLabel}` : 'без пересадок'}`;
  const preview = stops.filter((stop,index) => !index || index === stops.length-1 || stop.transfer || stop.ids.some(id => route.via.has(id)));
  const render = (list, full) => list.map(stop => {
    let note = stop.transfer ? 'Пересадка' : '';
    if (stop.ids.includes(route.first) && stop === stops[0]) note = 'Старт';
    if (stop.ids.includes(route.last) && stop === stops.at(-1)) note = 'Финиш';
    if (!note && stop.ids.some(id => route.via.has(id))) note = 'Через';
    const line = network.stations.get(stop.ids.at(-1)).line;
    return `<li class="${stop.transfer ? 'transfer' : ''}"><i class="station-dot"></i><span class="route-list-label">${escape(stopName(stop))}</span>
      ${note ? `<span class="route-list-detail">${note}</span>` : ''}${full ? lineTag(line) : ''}</li>`;
  }).join('');
  $('route-preview').innerHTML = `<ol class="route-summary-list">${render(preview,false)}</ol>`;
  $('route-details').innerHTML = `<ol class="route-stop-list">${render(stops,true)}</ol>`;
}

function showModal(title, content) {
  $('modal-title').textContent = title;
  modalContent.innerHTML = content;
  if (!modal.open) modal.showModal();
}

function chooseField(key, id) {
  if (key === 'from' || key === 'to') fields[key] = id;
  else fields.via[Number(key)] = id;
  modal.close();
  updateRoute();
  document.querySelector(`[data-field="${key}"]`)?.focus({ preventScroll: true });
}

function showStationPicker(key, adding = false) {
  const title = adding ? 'Через станцию' : fieldLabel(key);
  showModal(title, `
    <label class="search-box">${icon('search')}<input id="station-search" type="search" autocomplete="off" placeholder="Название станции" aria-label="Поиск станции"></label>
    <div id="station-results" class="choice-list"></div>`);
  const selected = adding ? '' : fieldValue(key);
  const stations = [...network.stations.values()].sort((a,b) => a.name.localeCompare(b.name,'ru'));
  const input = $('station-search'), results = $('station-results');
  const render = () => {
    const query = fold(input.value);
    const matching = stations.filter(s => fold(s.name).includes(query) || fold(s.line.name).includes(query));
    results.innerHTML = matching.length ? matching.map(s => `<button class="choice ${selected === s.id ? 'current' : ''}" type="button" data-station="${escape(s.id)}">
      ${lineTag(s.line)}<span>${escape(s.name)}<small>${escape(s.line.name)}</small></span>${selected === s.id ? `<span class="tail">${icon('check')}</span>` : ''}</button>`).join('')
      : '<p class="inline-status">Станция не найдена. Попробуй другое название.</p>';
  };
  results.addEventListener('click',event => {
    const target = event.target.closest('[data-station]');
    if (target) chooseField(adding ? String(fields.via.length) : key, target.dataset.station);
  });
  input.addEventListener('input',render);
  input.addEventListener('keydown',event => {
    if (event.key === 'Enter') { event.preventDefault(); results.querySelector('button')?.click(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button')?.focus(); }
  });
  render();
  if (matchMedia('(pointer: fine)').matches) input.focus();
}

function openMapStation(id) {
  const station = network?.stations.get(id);
  if (!station) return;
  if (ride && !ride.finished) {
    const index = ride.route.stops.findIndex((stop,i) => i > ride.index && stop.ids.includes(id));
    if (index >= 0) {
      showModal(station.name, `<p class="modal-copy">${lineTag(station.line)} ${escape(station.line.name)}</p>
        <div class="modal-actions"><button type="button" class="primary" id="map-confirm-ride">Я на этой станции</button></div>`);
      $('map-confirm-ride').onclick = () => { modal.close(); unlockAudio(); advance(index); };
    } else {
      showModal(station.name, `<p class="modal-copy">${lineTag(station.line)} ${escape(station.line.name)}</p>
        <p class="inline-status">${station.transfer ? 'На станции есть пересадки.' : 'Станция на схеме метро.'}</p>`);
    }
    return;
  }
  const other = new Set(network.transfers.filter(group => group.includes(id)).flat().filter(key => key !== id));
  showModal(station.name, `<p class="modal-copy">${lineTag(station.line)} ${escape(station.line.name)}</p>
    ${other.size ? `<p class="inline-status">Пересадки: ${escape([...other].map(key => network.stations.get(key).name).join(', '))}</p>` : ''}
    <div class="modal-actions two">
      <button type="button" class="secondary" data-map-field="from">Отсюда</button><button type="button" class="secondary" data-map-field="to">Сюда</button>
      <button type="button" class="secondary" data-map-field="via" ${fields.via.length >= maxVia ? 'disabled' : ''}>Через станцию</button>
    </div>`);
  modalContent.onclick = event => {
    const key = event.target.closest('[data-map-field]')?.dataset.mapField;
    if (key) chooseField(key === 'via' ? String(fields.via.length) : key,id);
  };
}

function showLines() {
  if (!network) return;
  const items = [...network.lines.values()].map(line => {
    const count = new Set(line.paths.flat()).size;
    const label = plural(count,{one:'станция',few:'станции',many:'станций'});
    return `<li>${lineTag(line)}<span><strong>${escape(line.name)}</strong><small>${count} ${label}</small></span></li>`;
  });
  showModal(`Линии · ${network.name}`, `<ul class="choice-list lines-list">${items.join('')}</ul>`);
}

function showCities() {
  const choices = [...networks, ...custom];
  showModal('Выбрать город', `<div class="choice-list">${choices.map((city,index) => `
    <button type="button" class="choice ${city.id === network.id ? 'current' : ''}" data-city-index="${index}">
      ${icon('pin')}<span>${escape(city.name)}${city.id === 'volgograd' ? '<small>Метротрам</small>' : ''}</span>
      ${city.id === network.id ? `<span class="tail">${icon('check')}</span>` : ''}
    </button>`).join('')}</div>
    <div class="modal-actions"><button type="button" class="secondary" id="import-open">${icon('upload')}Загрузить свою схему</button></div>`);
  modalContent.onclick = event => {
    const choice = event.target.closest('[data-city-index]');
    if (choice) {
      const city = choices[Number(choice.dataset.cityIndex)];
      modal.close();
      if (city.id !== network.id) selectCity(city);
    }
  };
  $('import-open').onclick = showImport;
}

function normalizeImport(input) {
  const invalid = message => { throw new Error(message); };
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim()) invalid('Укажи название города в поле name.');
  if (!Array.isArray(input.stations) || input.stations.length < 2 || input.stations.length > 1200
    || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 40) invalid('Нужны от 2 до 1200 станций и от 1 до 40 линий.');
  const text = (value,limit) => typeof value === 'string' && value.trim() && value.length <= limit;
  const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(value);
  const lineIds = new Set();
  for (const line of input.lines) {
    if (!line || !safeId(line.id) || lineIds.has(line.id) || !text(line.name,70) || !text(line.number,8)
      || !/^#[0-9a-f]{6}$/i.test(line.color) || !Array.isArray(line.paths) || !line.paths.length
      || line.paths.length > 64) invalid('Проверь идентификаторы, подписи, цвета и пути линий.');
    lineIds.add(line.id);
  }
  const bounded = (value,limit) => Number.isFinite(value) && Math.abs(value) <= limit;
  const stations = new Map();
  for (const row of input.stations) {
    if (!Array.isArray(row) || row.length !== 5) invalid('Каждая станция должна содержать 5 значений.');
    const [id,name,lat,lng,line] = row;
    if (!safeId(id) || stations.has(id) || !text(name,96) || !bounded(lat,85) || !bounded(lng,180)
      || !lineIds.has(line)) invalid('Проверь названия, координаты и линии станций.');
    stations.set(id,line);
  }
  const used = new Set();
  for (const line of input.lines) {
    for (const path of line.paths) {
      if (!Array.isArray(path) || path.length < 2 || path.length > 1201 || path.some(id => stations.get(id) !== line.id)) {
        invalid('Путь линии должен содержать станции этой линии в порядке движения.');
      }
      path.forEach(id => used.add(id));
    }
  }
  if (used.size !== stations.size) invalid('Добавь каждую станцию хотя бы в один путь своей линии.');
  const transfers = input.transfers ?? [];
  if (!Array.isArray(transfers) || transfers.length > 250 || transfers.some(group => !Array.isArray(group)
    || group.length < 2 || group.length > 12 || new Set(group).size !== group.length
    || group.some(id => !stations.has(id)) || new Set(group.map(id => stations.get(id))).size !== group.length)) {
    invalid('Каждая пересадка должна соединять существующие станции разных линий.');
  }
  const center = [2,3].map(index => input.stations.reduce((sum,station) => sum+station[index],0)/stations.size);
  const slug = 'local-' + (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
  return {
    id:slug, name:input.name.trim().slice(0,45), center, defaults:['',''], transfers,
    stations:input.stations,
    lines:input.lines.map(({id,name,number,color,paths,directed}) => ({id,name,number,color,paths,directed:directed === true})),
  };
}

function showImport() {
  showModal('Загрузить схему', `<p class="modal-copy">Выбери файл JSON с линиями, станциями, их координатами и пересадками. Схема сохранится в этом браузере.</p>
    <input class="import-file" id="import-file" type="file" accept=".json,application/json" aria-label="Файл схемы JSON">
    <a class="modal-copy" href="./assets/map-template.json" download>Скачать пример JSON</a>
    <p class="inline-error" role="status" id="import-error" hidden></p>
    <div class="modal-actions"><button type="button" class="primary" id="import-submit">Загрузить</button></div>`);
  $('import-submit').onclick = async () => {
    const file = $('import-file').files[0], status = $('import-error');
    if (!file) { status.textContent = 'Выбери файл JSON.'; status.hidden = false; return; }
    try {
      if (file.size > 2_000_000) throw new Error('Максимальный размер файла — 2 МБ.');
      const data = normalizeImport(JSON.parse(await file.text()));
      const updated = [...custom, data];
      if (!save(importKey, updated)) throw new Error('В браузере закончилось место для сохранения схемы.');
      custom = updated;
      modal.close();
      selectCity(data);
    } catch (error) {
      status.textContent = error instanceof SyntaxError ? 'Не удалось прочитать JSON. Проверь формат файла.' : error.message;
      status.hidden = false;
    }
  };
}

function openHelp() {
  showModal('Как работает Метросигнал', `<div class="modal-copy">
    <p><strong>Поездка.</strong> Нажми «Начать поездку», когда поезд тронется. Сигнал звучит примерно за минуту до пересадки и конечной. Приложение уточняет время по геопозиции, а без неё считает по перегонам. После задержки можно выбрать текущую станцию и уточнить отсчёт.</p>
    <p><strong>В метро.</strong> Оставь приложение открытым. При блокировке экрана iPhone может приостановить отсчёт и звук.</p>
    <p><strong>Офлайн.</strong> При подключении к интернету нажми «Скачать для офлайна» и дождись подтверждения. Схемы сохраняются в кэше браузера.</p>
    <p><strong>Наушники.</strong> Подключи их к iPhone и проверь оба сигнала в настройках звука.</p>
    <p><strong>На экран «Домой».</strong> В Safari открой «Поделиться», нажми «На экран “Домой”» и выбери «Открывать как веб-приложение», если есть такой переключатель.</p>
    <p><strong>Данные.</strong> <a href="https://api.hh.ru/openapi/redoc#tag/Obshie-spravochniki/operation/get-metro-stations" target="_blank" rel="noreferrer">Справочник HH</a> и <a href="https://volgtrans.ru/index.php?id=ST2&amp;start=tram" target="_blank" rel="noreferrer">маршрут СТ2</a>. В Москве доступны метро и МЦК. В Петербурге из маршрутов исключены Фрунзенская и Парк Победы, <a href="https://metro.spb.ru/remeskltr.html" target="_blank" rel="noreferrer">закрытые на реконструкцию</a>. Время в пути примерное. Схемы не учитывают оперативные закрытия. Геопозиция обрабатывается на устройстве.</p>
  </div>`);
}

function updateSoundCaption() {
  const transfers = sounds.transfer || sounds.other;
  $('sound-caption').textContent = sounds.arrival && transfers ? 'Пересадки и прибытие'
    : sounds.arrival ? 'Только прибытие' : transfers ? 'Только пересадки' : 'Сигналы выключены';
}

function unlockAudio() {
  try {
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return;
    if (!audio || audio.state === 'closed') audio = new Context();
    if (audio.state !== 'running') audio.resume().catch(() => {});
  } catch { /* The audio test exposes unsupported playback. */ }
}

function playSignal(type) {
  if (!audio || audio.state !== 'running') return false;
  const frequencies = type === 'arrival' ? [659.25,830.61,987.77] : [880,698.46,880];
  const start = audio.currentTime + 0.015;
  frequencies.forEach((frequency,index) => {
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    const begin = start + index*(type === 'arrival' ? 0.19 : 0.24);
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    volume.gain.setValueAtTime(0,begin);
    volume.gain.linearRampToValueAtTime(0.21,begin+0.024);
    volume.gain.exponentialRampToValueAtTime(0.004,begin+0.17);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(begin);
    oscillator.stop(begin+0.19);
  });
  return true;
}

async function testSound(type, status) {
  unlockAudio();
  if (audio?.state !== 'running') await Promise.race([audio?.resume().catch(() => {}),new Promise(resolve => setTimeout(resolve,450))]);
  status.textContent = playSignal(type) ? 'Сигнал воспроизведён. Проверь громкость и подключение наушников.'
    : 'Звук не запустился. Попробуй открыть приложение в Safari и нажать кнопку ещё раз.';
}

function showSounds() {
  showModal('Звуковые сигналы', `<p class="modal-copy">Подключи наушники и послушай сигналы перед поездкой.</p>
    <label class="switch-row">Прибытие на конечную <input type="checkbox" data-sound="arrival" ${sounds.arrival ? 'checked' : ''}></label>
    <label class="switch-row">Пересадки по маршруту <input type="checkbox" data-sound="transfer" ${sounds.transfer ? 'checked' : ''}></label>
    <label class="switch-row">Другие пересадочные станции <input type="checkbox" data-sound="other" ${sounds.other ? 'checked' : ''}></label>
    <div class="modal-actions two">
      <button class="secondary" id="test-transfer" type="button">${icon('sound')}Пересадка</button>
      <button class="secondary" id="test-arrival" type="button">${icon('sound')}Прибытие</button>
    </div><p class="inline-status" id="sound-status" role="status"></p>`);
  for (const input of modalContent.querySelectorAll('[data-sound]')) {
    input.onchange = () => { sounds[input.dataset.sound] = input.checked; updateSoundCaption(); remember(); };
  }
  $('test-transfer').onclick = () => testSound('transfer',$('sound-status'));
  $('test-arrival').onclick = () => testSound('arrival',$('sound-status'));
}

function updateMapMode() {
  $('map-mode').disabled = !route;
  $('map-mode-label').textContent = map.view === 'all' ? 'Мой маршрут' : 'Вся схема';
}

function toggleMap() {
  if (mapDialog.open) {
    mapDialog.close();
    return;
  }
  const card = $('map-section');
  $('map-home').style.minHeight = `${card.offsetHeight}px`;
  mapDialog.append(card);
  document.body.classList.add('map-open');
  map.setInteractive(true);
  $('map-expand').innerHTML = `${icon('close')}<span>Закрыть</span>`;
  $('map-expand').setAttribute('aria-label', 'Закрыть схему');
  $('map-expand').removeAttribute('aria-haspopup');
  mapDialog.showModal();
  $('map-expand').focus({ preventScroll: true });
}

function restoreMap() {
  $('map-home').append($('map-section'));
  $('map-home').style.minHeight = '';
  document.body.classList.remove('map-open');
  map.setInteractive(false);
  $('map-expand').innerHTML = `${icon('fit')}<span>Развернуть</span>`;
  $('map-expand').setAttribute('aria-label', 'Развернуть схему');
  $('map-expand').setAttribute('aria-haspopup', 'dialog');
  $('map-expand').focus({ preventScroll: true });
}

function showMapMessage(message, duration = 4300) {
  clearTimeout(pendingMapMessage);
  const node = $('map-message');
  node.textContent = message;
  node.hidden = !message;
  if (message) pendingMapMessage = setTimeout(() => { node.hidden = true; },duration);
}

function locationError(error) {
  if (error.code === 1) return 'Доступ к геолокации закрыт. Разреши геопозицию для сайта или отмечай станции вручную.';
  return 'Нет свежей геопозиции. Станцию можно отметить вручную.';
}

function getLocation() {
  if (!navigator.geolocation || !window.isSecureContext) {
    showMapMessage('Для геолокации нужен Safari или другой браузер с защищённым подключением.');
    return;
  }
  const city = network.id;
  $('locate-map').disabled = true;
  showMapMessage('Определяем местоположение…',12000);
  const reset = () => { $('locate-map').disabled = false; };
  navigator.geolocation.getCurrentPosition(position => {
    reset();
    if (network.id !== city) { showMapMessage(''); return; }
    const coords = {lat:position.coords.latitude,lng:position.coords.longitude};
    const nearest = stationNear(network,coords,position.coords.accuracy);
    const center = {lat:network.center[0],lng:network.center[1]};
    const coverage = Math.max(...[...network.stations.values()].map(s => distance(center,s)));
    if (distance(coords,center) > coverage + 6500) {
      showMapMessage(`Текущее местоположение за пределами схемы. Город — ${network.name}.`);
      return;
    }
    map.locate(coords,true);
    updateMapMode();
    showMapMessage(nearest ? `Рядом станция «${nearest.station.name}»` : 'Текущее местоположение отмечено на схеме.');
  },error => { reset(); showMapMessage(locationError(error),6500); },{enableHighAccuracy:true,maximumAge:3000,timeout:10000});
}

async function keepScreenOn(activeRide) {
  if (!navigator.wakeLock || document.hidden || activeRide.wake || activeRide.wakePending) return;
  activeRide.wakePending = true;
  try {
    const wake = await navigator.wakeLock.request('screen');
    if (ride !== activeRide || activeRide.finished) { await wake.release(); return; }
    activeRide.wake = wake;
    wake.addEventListener('release',() => { if (activeRide.wake === wake) activeRide.wake = null; });
  } catch { /* Device power settings can reject the lock. */ }
  finally { activeRide.wakePending = false; }
}

function renderRide() {
  const node = $('ride-card');
  node.hidden = !ride;
  $('summary-card').hidden = Boolean(ride) || !route;
  document.body.classList.toggle('riding',Boolean(ride && !ride.finished));
  $('route-fields').querySelectorAll('button').forEach(button => { button.disabled = Boolean(ride); });
  $('swap-button').disabled = Boolean(ride);
  $('add-via').disabled = Boolean(ride) || (fields?.via.length ?? 0) >= maxVia;
  if (!ride) return;
  const finished = ride.finished;
  const title = finished ? 'Поездка завершена' : 'Поездка началась';
  node.innerHTML = `<div class="ride-title"><span>${icon(finished ? 'check' : 'headphones')}</span><h2>${title}</h2></div>
    ${finished ? '' : `<p class="ride-state" id="ride-state" role="status"></p>
      <p class="ride-next">Следующая станция <strong id="ride-next-name"></strong></p>
      <p class="ride-countdown" id="ride-countdown" role="timer"></p>`}
    <p class="ride-alert" id="ride-alert" role="status" ${ride.alert ? '' : 'hidden'}>${escape(ride.alert)}</p>
    <div class="ride-actions">
      ${finished ? '' : `<button type="button" class="primary" id="next-stop">${icon('check')}<span id="ride-confirm-label">Я на следующей станции</span></button>
      <button type="button" class="secondary" id="pick-current">Отметить другую станцию</button>`}
      <button type="button" class="secondary" id="stop-ride">${finished ? 'К маршруту' : 'Завершить поездку'}</button>
    </div>`;
  $('stop-ride').onclick = stopRide;
  if (!finished) {
    $('next-stop').onclick = event => {
      unlockAudio();
      advance(Number(event.currentTarget.dataset.index));
      ($('next-stop') ?? $('stop-ride'))?.focus();
    };
    $('pick-current').onclick = showCurrentPicker;
    updateRideDisplay(Date.now());
  }
}

function updateText(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}

function setRideAlert(text, index = null) {
  ride.alert = text;
  ride.alertIndex = index;
  $('ride-alert').hidden = !text;
  updateText('ride-alert', text);
}

function updateRideDisplay(now) {
  const index = nextEstimatedStop(ride, now);
  const remaining = stationTime(ride, index) - now;
  const usesGPS = ride.gpsAt !== null && now - ride.gpsAt <= 15_000;
  updateText('ride-state', usesGPS ? 'Геопозиция уточняет время' : ride.timeStatus);
  updateText('ride-next-name', stopName(ride.route.stops[index]));
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  updateText('ride-countdown', remaining > 0 ? `До станции ≈ ${clock}` : 'По расчёту пора выходить');
  updateText('ride-confirm-label', remaining > 0 ? 'Я на следующей станции' : 'Подтвердить прибытие');
  $('next-stop').dataset.index = index;
}

function alertType(index) {
  const stop = ride.route.stops[index];
  if (index === ride.route.stops.length - 1) return sounds.arrival ? 'arrival' : null;
  if (stop.transfer) return sounds.transfer ? 'transfer' : null;
  return sounds.other && stop.ids.some(id => network.stations.get(id).transfer) ? 'other' : null;
}

function tickRide(activeRide) {
  if (!activeRide || ride !== activeRide || ride.finished || document.hidden) return;
  const now = Date.now();
  updateRideDisplay(now);
  const warning = imminentAlert(ride, now, alertType);
  if (!warning || now - (ride.signalledAt ?? 0) < 900) return;
  const stop = ride.route.stops[warning.index];
  const station = network.stations.get(warning.type === 'arrival' ? ride.route.last : stop.ids[0]);
  let message;
  if (warning.type === 'arrival') message = `Скоро выход · «${station.name}».`;
  else if (warning.type === 'transfer') {
    const connection = network.stations.get(stop.transferTo ?? stop.ids.at(-1));
    message = `Скоро пересадка · «${station.name}», линия ${connection.line.number}.`;
  } else message = `Скоро пересадочная станция «${station.name}».`;
  ride.warned.add(warning.index);
  ride.signalledAt = now;
  setRideAlert(message + emit(warning.type), warning.index);
}

function clearWatch(activeRide) {
  if (activeRide.watch !== undefined) navigator.geolocation?.clearWatch(activeRide.watch);
  activeRide.watch = undefined;
  clearInterval(activeRide.timer);
  activeRide.wake?.release().catch(() => {});
}

function stopRide() {
  if (!ride) return;
  clearWatch(ride);
  ride = null;
  map.setCurrent(null);
  renderRide();
}

function emit(type) {
  if (!sounds[type]) return '';
  if (playSignal(type === 'arrival' ? 'arrival' : 'transfer')) return '';
  return ' Звук недоступен. Проверь воспроизведение в настройках.';
}

function advance(index, observedAt = Date.now(), gps = false) {
  const current = ride;
  if (!current || current.finished || index <= current.index || index >= current.route.stops.length) return;
  const type = alertType(index);
  const signal = type && !current.warned.has(index) ? emit(type) : '';
  current.warned.add(index);
  if (type) current.signalledAt = Date.now();
  current.index = index;
  current.candidate = null;
  const stop = current.route.stops[index];
  syncJourneyTime(current, observedAt, stop.arrivalMinutes);
  current.timeStatus = 'По расчётному времени · от последней станции';
  current.gpsAt = gps ? observedAt : null;
  current.gpsMinutes = stop.arrivalMinutes;
  map.setCurrent(stop.ids.at(-1));
  if (index === current.route.stops.length-1) {
    current.finished = true;
    current.alert = `Ты на станции «${network.stations.get(current.route.last).name}».${signal}`;
    clearWatch(current);
  } else if (stop.transfer) {
    const destination = network.stations.get(stop.transferTo ?? stop.ids.at(-1));
    current.alert = `Пересадка на линию ${destination.line.number} · «${destination.name}».${signal}`;
  } else if (type === 'other') {
    current.alert = `«${stopName(stop)}» · станция с пересадками.${signal}`;
  } else if (current.alertIndex == null || current.alertIndex <= index) {
    current.alert = `Текущая станция · ${stopName(stop)}`;
  }
  renderRide();
}

function showCurrentPicker() {
  if (!ride || ride.finished) return;
  const stops = ride.route.stops;
  showModal('На какой станции ты сейчас?', `<div class="choice-list">${stops.slice(ride.index+1).map((stop,i) => {
    const station = network.stations.get(stop.ids[0]);
    return `<button class="choice" type="button" data-stop="${i+ride.index+1}">${lineTag(station.line)}
      <span>${escape(stopName(stop))}${stop.transfer ? '<small>Пересадка</small>' : ''}</span></button>`;
  }).join('')}</div>`);
  modalContent.onclick = event => {
    const button = event.target.closest('[data-stop]');
    if (!button) return;
    unlockAudio();
    modal.close();
    advance(Number(button.dataset.stop));
    $('pick-current')?.focus();
  };
}

function onPosition(activeRide, position) {
  if (ride !== activeRide || ride.finished || document.hidden) return;
  const point = {lat:position.coords.latitude,lng:position.coords.longitude};
  const accuracy = position.coords.accuracy;
  const moment = Date.now();
  const sampleAt = Math.min(moment, position.timestamp);
  if (!Number.isFinite(sampleAt) || moment-sampleAt > 14_000 || sampleAt < (ride.lastSample ?? 0)) return;
  ride.lastSample = sampleAt;
  if (!Number.isFinite(accuracy) || accuracy > 108) {
    ride.candidate = null;
    ride.gpsAt = null;
    ride.timeStatus = 'По расчётному времени · слабый сигнал';
    tickRide(activeRide);
    return;
  }
  const nearest = stationNear(network,point,accuracy);
  const cityCenter = {lat:network.center[0],lng:network.center[1]};
  if (distance(point,cityCenter) < ride.coverage + 6500) map.locate(point);
  if (!nearest) {
    if (ride.lastOther && distance(point,ride.lastOther.station) > 270) ride.lastOther = null;
    ride.candidate = null;
    const progress = positionOnJourney(network, ride, point, accuracy, sampleAt);
    if (progress !== null && progress >= (ride.gpsMinutes ?? 0) - .2) {
      syncJourneyTime(ride, sampleAt, progress);
      ride.gpsAt = sampleAt;
      ride.gpsMinutes = Math.max(ride.gpsMinutes ?? 0, progress);
      ride.timeStatus = 'По расчётному времени · от последней геопозиции';
    } else if (ride.gpsAt === null) {
      ride.timeStatus = 'По расчётному времени · уточняем положение';
    }
    tickRide(activeRide);
    return;
  }
  const stops = ride.route.stops;
  const matches = index => {
    const stop = stops[index];
    if (!stop) return false;
    if (!stop.terminalWalk) return stop.ids.some(id => nearest.ids.includes(id));
    const end = network.stations.get(stop.ids[0]);
    const start = network.stations.get(stops[index-1].ids.at(-1));
    return end.id === nearest.station.id && distance(point,start)-nearest.meters > Math.max(36,accuracy);
  };
  const next = matches(ride.index+1);
  if (!next && matches(ride.index)) {
    ride.candidate = null;
    if (ride.index === 0 && (ride.gpsMinutes ?? 0) < .2 && accuracy <= 40 && nearest.meters <= 65) {
      syncJourneyTime(ride, sampleAt, 0);
      ride.gpsAt = sampleAt;
      ride.timeStatus = 'По расчётному времени · от станции отправления';
    }
    tickRide(activeRide);
    return;
  }
  const future = next ? ride.index+1 : stops.findIndex((_,i) => i > ride.index && matches(i));
  const key = future > ride.index ? `route:${future}` : `other:${nearest.ids[0]}`;
  if (ride.candidate?.key !== key) ride.candidate = { key, start: moment, timestamp: position.timestamp };
  const repeated = position.timestamp - ride.candidate.timestamp >= 700 && moment - ride.candidate.start >= 700;
  const precise = accuracy <= 32 && nearest.meters <= 48;
  if (!(repeated || precise)) return;
  if (future > ride.index) {
    advance(future, sampleAt, true);
  } else if (nearest.station.transfer && sounds.other && ride.lastOther?.key !== key && !stops.some((_,i) => i <= ride.index && matches(i))) {
    ride.lastOther = {key,station:nearest.station};
    ride.signalledAt = moment;
    setRideAlert(`Рядом пересадочная станция «${nearest.station.name}» вне маршрута.${emit('other')}`);
  }
}

function startRide() {
  if (!route) return;
  unlockAudio();
  const center = {lat:network.center[0],lng:network.center[1]};
  const coverage = Math.max(...[...network.stations.values()].map(s => distance(center,s)));
  const activeRide = {
    route, index:0, origin:Date.now(), gpsAt:null, warned:new Set(),
    timeStatus:'По расчётному времени · ждём геопозицию', alert:'', finished:false, coverage,
  };
  ride = activeRide;
  map.setCurrent(route.first);
  renderRide();
  activeRide.timer = setInterval(() => tickRide(activeRide),1_000);
  keepScreenOn(activeRide);
  if (!navigator.geolocation || !window.isSecureContext) {
    ride.timeStatus = 'По расчётному времени · геопозиция недоступна';
    updateRideDisplay(Date.now());
    return;
  }
  activeRide.watch = navigator.geolocation.watchPosition(
    position => onPosition(activeRide, position),
    error => {
      if (ride !== activeRide || activeRide.finished) return;
      activeRide.candidate = null;
      activeRide.gpsAt = null;
      activeRide.timeStatus = error.code === 1 ? 'По расчётному времени · доступ к геопозиции закрыт'
        : 'По расчётному времени · нет свежей геопозиции';
      tickRide(activeRide);
    },
    {enableHighAccuracy:true,maximumAge:3000,timeout:13000},
  );
}

$('modal-close').onclick = () => modal.close();
modal.addEventListener('click',event => { if (event.target === modal) modal.close(); });
modal.addEventListener('close',() => { if (!modal.open) modalContent.onclick = null; });
$('route-fields').onclick = event => {
  const field = event.target.closest('[data-field]');
  const remove = event.target.closest('[data-remove]');
  if (field && !ride) showStationPicker(field.dataset.field);
  if (remove && !ride) {
    fields.via.splice(Number(remove.dataset.remove),1);
    updateRoute();
    $('add-via').focus();
  }
};
$('add-via').onclick = () => showStationPicker('',true);
$('swap-button').onclick = () => {
  [fields.from,fields.to] = [fields.to,fields.from];
  fields.via.reverse();
  updateRoute();
};
$('details-button').onclick = () => {
  const expanded = $('details-button').getAttribute('aria-expanded') === 'true';
  $('details-button').setAttribute('aria-expanded',String(!expanded));
  $('route-preview').hidden = !expanded;
  $('route-details').hidden = expanded;
};
$('start-trip').onclick = startRide;
$('sound-button').onclick = () => { if (network) showSounds(); };
$('lines-button').onclick = showLines;
$('city-button').onclick = () => { if (network) showCities(); };
$('nav-route').onclick = () => $('planner').scrollIntoView({block:'nearest'});
document.querySelectorAll('[data-help]').forEach(button => { button.onclick = openHelp; });
$('map-expand').onclick = toggleMap;
mapDialog.addEventListener('close', restoreMap);
$('map-mode').onclick = () => {
  map.setView(map.view === 'all' ? 'route' : 'all');
  updateMapMode();
};
$('fit-map').onclick = () => { map.setView('all'); updateMapMode(); };
$('zoom-in').onclick = () => { map.zoom(1.28); updateMapMode(); };
$('zoom-out').onclick = () => { map.zoom(1/1.28); updateMapMode(); };
$('locate-map').onclick = () => { if (network) getLocation(); };
document.addEventListener('visibilitychange',() => {
  if (!ride || ride.finished) return;
  const activeRide = ride;
  activeRide.candidate = null;
  if (document.hidden) return;
  keepScreenOn(activeRide);
  if (audio?.state !== 'running' && (sounds.arrival || sounds.transfer || sounds.other)) {
    audio?.resume().then(() => tickRide(activeRide)).catch(() => {});
  } else {
    tickRide(activeRide);
  }
});

updateSoundCaption();
setupOffline($('offline-button'), $('offline-label'), $('offline-icon'), $('offline-status'));
$('add-via').disabled = true;
$('swap-button').disabled = true;
$('map-mode').disabled = true;
try {
  const response = await fetch('./assets/networks.json');
  if (!response.ok) throw new Error('Не удалось загрузить схемы');
  networks = await response.json();
  const selected = [...networks,...custom].find(city => city.id === preferences.city);
  selectCity(selected ?? networks[0],selected ? preferences.fields : null);
  $('swap-button').disabled = false;
} catch {
  $('route-error').textContent = 'Не удалось загрузить схемы. Проверь подключение и обнови страницу.';
  $('route-error').hidden = false;
}
