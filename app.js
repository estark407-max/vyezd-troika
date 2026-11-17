/* Выезд Тройка — калькулятор стоимости доставки и выезда мастера */
function startApp() {
  'use strict';

  // ---------- хранилище (в памяти текущей сессии) ----------
  const mem = {};
  const store = {
    get(k, d) { return k in mem ? mem[k] : d; },
    set(k, v) { mem[k] = v; }
  };

  const DEFAULT_TARIFFS = {
    delivery: { supply: 500, perKm: 30 },
    master:   { supply: 1000, perKm: 35 }
  };
  const MODE_NAMES = { delivery: 'Доставка', master: 'Выезд мастера' };

  let settings = store.get('vk_settings', null) || { tariffs: structuredClone(DEFAULT_TARIFFS), currency: '₽' };
  let mode = store.get('vk_mode', 'delivery');
  let history = store.get('vk_history', []);

  // точки маршрута: {label, lng, lat}
  let points = [null, null];
  let activeIdx = 0;
  let lastRoute = null;   // {km, min}
  let lastCalc = null;
  const markers = [];

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU');
  const money = (n) => `${fmt(n)} ${settings.currency}`;

  // ---------- карта ----------
  const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const map = new ymaps.Map('map', {
    center: [55.7558, 37.6173], zoom: 9,
    controls: ['zoomControl', 'trafficControl']
  }, { suppressMapOpenBlock: false, yandexMapDisablePoiInteractivity: true });
  let multiRoute = null;

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const dark = t === 'dark';
    const b = $('#btnTheme');
    b.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
    b.title = dark ? 'Светлая тема' : 'Тёмная тема';
  }

  map.events.add('click', async (e) => {
    const [lat, lng] = e.get('coords');
    const idx = activeIdx;
    setPoint(idx, { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lng, lat });
    const label = await reverseGeocode(lng, lat);
    if (label && points[idx] && points[idx].lng === lng) { points[idx].label = label; renderPoints(); }
    const next = points.findIndex(p => !p);
    if (next >= 0) { activeIdx = next; renderPoints(); }
  });

  // ---------- геокодирование (Яндекс) ----------
  const GEO_KEY = (window.APP_CONFIG && window.APP_CONFIG.geocoderKey) || '';
  async function geocodeHttp(params) {
    const u = 'https://geocode-maps.yandex.ru/v1/?format=json&lang=ru_RU&apikey=' + encodeURIComponent(GEO_KEY) + '&' + params;
    const r = await fetch(u);
    if (!r.ok) throw new Error('geocoder ' + r.status);
    const j = await r.json();
    return (j.response.GeoObjectCollection.featureMember || []).map(m => {
      const g = m.GeoObject; const [lng, lat] = g.Point.pos.split(' ').map(Number);
      return { main: g.name, place: g.description || '', lng, lat };
    });
  }

  async function searchAddress(q) {
    if (GEO_KEY) {
      const b = map.getBounds();
      const ll = ((b[0][1] + b[1][1]) / 2) + ',' + ((b[0][0] + b[1][0]) / 2);
      const spn = Math.abs(b[1][1] - b[0][1]) + ',' + Math.abs(b[1][0] - b[0][0]);
      return geocodeHttp('results=6&ll=' + ll + '&spn=' + spn + '&geocode=' + encodeURIComponent(q));
    }
    const res = await ymaps.geocode(q, { results: 6, boundedBy: map.getBounds() });
    const out = [];
    res.geoObjects.each(o => {
      const [lat, lng] = o.geometry.getCoordinates();
      out.push({ main: o.properties.get('name'), place: o.properties.get('description') || '', lng, lat });
    });
    return out;
  }

  async function reverseGeocode(lng, lat) {
    try {
      if (GEO_KEY) {
        const r = await geocodeHttp('results=1&geocode=' + lng + ',' + lat);
        if (r[0]) return [r[0].main, (r[0].place || '').split(',')[0]].filter(Boolean).join(', ');
        return null;
      }
      const res = await ymaps.geocode([lat, lng], { results: 1 });
      const o = res.geoObjects.get(0);
      if (o) return [o.properties.get('name'), (o.properties.get('description') || '').split(',')[0]].filter(Boolean).join(', ');
    } catch { /* игнор */ }
    return null;
  }

  // ---------- точки ----------
  function setPoint(idx, p) { points[idx] = p; lastRoute = null; renderPoints(); renderMarkers(); }

  function renderPoints() {
    const box = $('#points');
    box.innerHTML = '';
    points.forEach((p, i) => {
      const isStart = i === 0, isEnd = i === points.length - 1;
      const row = document.createElement('div');
      row.className = 'point' + (isStart ? ' start' : isEnd ? ' end' : '') + (i === activeIdx ? ' active' : '');
      const letter = isStart ? 'A' : isEnd ? 'Б' : String(i);
      const ph = isStart ? 'Откуда (база, склад)' : isEnd ? 'Куда (адрес клиента)' : 'Промежуточная точка';
      row.innerHTML = `<span class="pin">${letter}</span>
        <input type="text" placeholder="${ph}" aria-label="${ph}" autocomplete="off" value="${p ? escapeHtml(p.label) : ''}">
        <button class="rm" type="button" aria-label="Удалить точку" ${points.length <= 2 && !p ? 'disabled' : ''}>✕</button>`;
      const input = row.querySelector('input');
      input.addEventListener('focus', () => { activeIdx = i; box.querySelectorAll('.point').forEach((el, k) => el.classList.toggle('active', k === i)); });
      attachSuggest(row, input, i);
      row.querySelector('.rm').addEventListener('click', () => {
        if (points.length > 2) points.splice(i, 1); else points[i] = null;
        activeIdx = Math.min(activeIdx, points.length - 1);
        lastRoute = null; renderPoints(); renderMarkers(); clearRoute();
      });
      box.appendChild(row);
    });
  }

  function attachSuggest(row, input, idx) {
    let timer, list, items = [], hl = -1;
    const close = () => { if (list) { list.remove(); list = null; } hl = -1; };
    const pick = (it) => { close(); setPoint(idx, { label: it.main + (it.place ? ', ' + it.place.split(',')[0] : ''), lng: it.lng, lat: it.lat }); map.setCenter([it.lat, it.lng], Math.max(map.getZoom(), 12), { duration: 400 }); };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { close(); return; }
      timer = setTimeout(async () => {
        try { items = await searchAddress(q); } catch { items = []; }
        close();
        if (!items.length || document.activeElement !== input) return;
        list = document.createElement('div');
        list.className = 'suggest';
        items.forEach((it, k) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.innerHTML = `${escapeHtml(it.main)}<small>${escapeHtml(it.place || '')}</small>`;
          b.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
          list.appendChild(b);
        });
        row.appendChild(list);
      }, 500);
    });
    input.addEventListener('keydown', (e) => {
      if (!list) return;
      const btns = list.querySelectorAll('button');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
        btns.forEach((b, k) => b.classList.toggle('hl', k === hl));
      } else if (e.key === 'Enter') { e.preventDefault(); pick(items[Math.max(hl, 0)]); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  function renderMarkers() {
    markers.forEach(m => map.geoObjects.remove(m)); markers.length = 0;
    points.forEach((p, i) => {
      if (!p) return;
      const isStart = i === 0, isEnd = i === points.length - 1;
      const m = new ymaps.Placemark([p.lat, p.lng],
        { iconContent: isStart ? 'А' : isEnd ? 'Б' : String(i), hintContent: p.label },
        { preset: isStart ? 'islands#darkGreenStretchyIcon' : isEnd ? 'islands#darkOrangeStretchyIcon' : 'islands#blackStretchyIcon', draggable: true, zIndex: 1000 });
      m.events.add('dragend', async () => {
        const [lat, lng] = m.geometry.getCoordinates();
        points[i] = { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lng, lat };
        renderPoints();
        const label = await reverseGeocode(lng, lat);
        if (label) { points[i].label = label; renderPoints(); }
        if (lastCalc) calculate();
      });
      map.geoObjects.add(m);
      markers.push(m);
    });
  }

  function clearRoute() {
    if (multiRoute) { map.geoObjects.remove(multiRoute); multiRoute = null; }
    $('#result').hidden = true; lastCalc = null;
  }

  // ---------- маршрут (Яндекс) ----------
  function fetchRoute(coords) {
    return new Promise((resolve, reject) => {
      if (multiRoute) map.geoObjects.remove(multiRoute);
      const dark = theme() === 'dark';
      const mr = new ymaps.multiRouter.MultiRoute({
        referencePoints: coords.map(c => [c.lat, c.lng]),
        params: { routingMode: 'auto', results: 1 }
      }, {
        boundsAutoApply: true,
        wayPointVisible: false, viaPointVisible: false, pinVisible: false,
        routeActiveStrokeWidth: 6,
        routeActiveStrokeColor: dark ? '#ff7a33' : '#e5590f',
        routeStrokeColor: '#9b998f'
      });
      multiRoute = mr;
      const done = () => {
        const r = mr.getActiveRoute();
        if (!r) { reject(new Error('Между точками не найдено дороги')); return; }
        resolve({ distance: r.properties.get('distance').value, duration: r.properties.get('duration').value });
      };
      mr.model.events.once('requestsuccess', done);
      mr.model.events.once('requestfail', () => reject(new Error('Сервис маршрутов Яндекса вернул ошибку')));
      map.geoObjects.add(mr);
    });
  }

  // ---------- расчёт ----------
  function computeCost(km, tariff, custom) {
    const kmCost = km * tariff.perKm;
    const calc = tariff.supply + kmCost;
    const rows = [
      ['Стоимость подачи', '', tariff.supply],
      ['Выезд по километражу', `${km} км × ${fmt(tariff.perKm)}`, kmCost]
    ];
    if (custom != null) {
      rows.push(['Расчётная стоимость', '', calc]);
      rows.push(['Своя стоимость', 'задана вручную', custom]);
      return { rows, total: custom, calcTotal: calc, custom: true };
    }
    return { rows, total: Math.round(calc), calcTotal: calc, custom: false };
  }

  function readTariff() {
    const t = settings.tariffs[mode];
    t.supply = Math.max(0, +$('#tSupply').value || 0);
    t.perKm = Math.max(0, +$('#tPerKm').value || 0);
    return t;
  }
  function customValue() {
    if (!$('#customOn').checked) return null;
    const v = $('#customPrice').value.trim();
    return v === '' ? null : Math.max(0, +v || 0);
  }
  // пересчёт без запроса маршрута
  function recompute() {
    if (!lastRoute || !lastCalc) return;
    const res = computeCost(lastRoute.km, readTariff(), customValue());
    lastCalc = { ...lastCalc, ...res, mode };
    renderResult(false);
  }

  function manualKm() {
    const v = Math.round(+$('#manualKm').value || 0);
    return v >= 1 ? v : null;
  }

  async function calculate() {
    const filled = points.filter(Boolean);
    const status = $('#status');
    status.classList.remove('err');
    const mk = manualKm();
    if (mk) {
      lastRoute = { km: mk, min: null };
      const res = computeCost(mk, readTariff(), customValue());
      lastCalc = { ...res, km: mk, min: null, round: false, manual: true, mode, points: filled.map(p => p.label), date: new Date().toISOString() };
      renderResult();
      status.textContent = 'Расчёт по километражу, указанному вручную.';
      return;
    }
    if (!points[0] || !points[points.length - 1]) {
      status.textContent = 'Укажите точки «Откуда» и «Куда».';
      status.classList.add('err'); return;
    }
    const coords = [...filled];
    const round = $('#roundTrip').checked;
    if (round) coords.push(filled[0]);
    const btn = $('#btnCalc');
    btn.disabled = true; status.textContent = 'Строю маршрут…';
    try {
      const route = await fetchRoute(coords);
      const km = Math.max(1, Math.round(route.distance / 1000)), min = route.duration / 60;
      lastRoute = { km, min };
      const res = computeCost(km, readTariff(), customValue());
      lastCalc = { ...res, km, min, round, mode, points: filled.map(p => p.label), date: new Date().toISOString() };
      renderResult();
      status.textContent = round ? 'Маршрут с возвратом на базу.' : '';
    } catch (e) {
      status.textContent = (e.message || 'Не удалось построить маршрут') + '. Можно указать километраж вручную в блоке тарифа.';
      status.classList.add('err');
    } finally { btn.disabled = false; }
  }

  function fmtDuration(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  }

  function renderResult(scroll = true) {
    const c = lastCalc;
    $('#result').hidden = false;
    $('#total').textContent = money(c.total);
    $('#rDist').textContent = String(c.km);
    $('#rTime').textContent = c.min == null ? '—' : fmtDuration(c.min);
    $('#breakdown').innerHTML = c.rows.map(r =>
      `<tr><td>${r[0]}${r[1] ? ` <small>${r[1]}</small>` : ''}</td><td>${money(r[2])}</td></tr>`).join('') +
      `<tr class="sum"><td>Итого${c.custom ? ' (своя)' : ''}</td><td>${money(c.total)}</td></tr>`;
    if (scroll && window.innerWidth <= 900) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function orderText(c, num) {
    const lines = [
      `Заявка${num ? ' №' + num : ''} — ${MODE_NAMES[c.mode]}`,
      `Дата: ${new Date(c.date).toLocaleString('ru-RU')}`,
      `Маршрут: ${c.points.join(' → ')}${c.round ? ' → обратно' : ''}`,
      c.min == null ? `Расстояние: ${c.km} км (указано вручную)` : `Расстояние: ${c.km} км, в пути ~${fmtDuration(c.min)}`,
    ];
    const name = $('#clientName').value.trim(), phone = $('#clientPhone').value.trim(), com = $('#comment').value.trim();
    if (c.client || name || phone) lines.push(`Клиент: ${(c.client ?? [name, phone].filter(Boolean).join(', '))}`);
    if (c.comment || com) lines.push(`Комментарий: ${c.comment ?? com}`);
    lines.push('', ...c.rows.map(r => `${r[0]}${r[1] ? ' (' + r[1] + ')' : ''}: ${money(r[2])}`), '', `ИТОГО: ${money(c.total)}`);
    return lines.join('\n');
  }

  // ---------- история ----------
  function saveOrder() {
    if (!lastCalc) return;
    const num = (history.reduce((m, h) => Math.max(m, h.num), 0) || 0) + 1;
    const client = [$('#clientName').value.trim(), $('#clientPhone').value.trim()].filter(Boolean).join(', ');
    history.unshift({ ...lastCalc, num, client, comment: $('#comment').value.trim(), currency: settings.currency });
    store.set('vk_history', history);
    toast(`Заявка №${num} сохранена`);
  }

  function renderHistory() {
    const box = $('#historyList');
    if (!history.length) { box.innerHTML = '<div class="empty">Сохранённых заявок пока нет</div>'; return; }
    box.innerHTML = '';
    history.forEach((h, i) => {
      const el = document.createElement('div');
      el.className = 'h-item';
      el.innerHTML = `<div><b>№${h.num} · ${MODE_NAMES[h.mode]}</b>
        <small>${new Date(h.date).toLocaleString('ru-RU')} · ${Math.round(h.km)} км${h.client ? ' · ' + escapeHtml(h.client) : ''}</small>
        <small>${escapeHtml(h.points.join(' → '))}</small></div>
        <span class="h-sum">${fmt(h.total)} ${h.currency || settings.currency}</span>
        <div><button class="btn small ghost" data-copy="${i}" type="button">Копировать</button>
        <button class="icon-btn" data-del="${i}" aria-label="Удалить">✕</button></div>`;
      box.appendChild(el);
    });
    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(orderText(history[+b.dataset.copy], history[+b.dataset.copy].num)));
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { history.splice(+b.dataset.del, 1); store.set('vk_history', history); renderHistory(); });
  }

  function exportCsv() {
    if (!history.length) { toast('История пуста'); return; }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Номер', 'Дата', 'Тип', 'Маршрут', 'Км', 'Минут в пути', 'Клиент', 'Комментарий', 'Итого', 'Валюта'];
    const rows = history.map(h => [h.num, new Date(h.date).toLocaleString('ru-RU'), MODE_NAMES[h.mode], h.points.join(' → '),
      Math.round(h.km), h.min == null ? '' : Math.round(h.min), h.client, h.comment, h.total, h.currency]);
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(esc).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'zayavki.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- тариф ----------
  function applyModeLabels() {
    const t = settings.tariffs[mode];
    $('#tariffName').textContent = MODE_NAMES[mode].toLowerCase();
    $('#tSupply').value = t.supply;
    $('#tPerKm').value = t.perKm;
    $('#tCur').value = settings.currency;
    document.querySelectorAll('.cur').forEach(el => el.textContent = settings.currency);
    document.querySelectorAll('.tab').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    $('#btnCalc').textContent = mode === 'master' ? 'Построить маршрут и рассчитать выезд' : 'Построить маршрут и рассчитать доставку';
  }

  // ---------- утилиты ----------
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2200); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Текст заявки скопирован'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Текст заявки скопирован'); } catch { toast('Не удалось скопировать'); }
      ta.remove();
    }
  }
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  // ---------- события ----------
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode; store.set('vk_mode', mode); applyModeLabels();
    recompute();
  }));
  $('#btnAddStop').onclick = () => { points.splice(points.length - 1, 0, null); activeIdx = points.length - 2; renderPoints(); renderMarkers(); $('#points').querySelectorAll('input')[activeIdx].focus(); };
  $('#btnCalc').onclick = calculate;
  $('#btnSave').onclick = saveOrder;
  $('#btnCopy').onclick = () => lastCalc && copy(orderText(lastCalc));
  $('#btnHistory').onclick = () => { renderHistory(); openModal('#historyModal'); };
  $('#btnExport').onclick = exportCsv;
  $('#btnClearHist').onclick = () => { history = []; store.set('vk_history', history); renderHistory(); };
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.hidden = true); });
  $('#roundTrip').addEventListener('change', () => { if (lastCalc) calculate(); });
  ['#tSupply', '#tPerKm', '#customPrice'].forEach(s => $(s).addEventListener('input', recompute));
  $('#manualKm').addEventListener('input', () => { if (lastCalc && (lastCalc.manual || manualKm())) calculate(); });
  $('#customOn').addEventListener('change', () => {
    const on = $('#customOn').checked; $('#customPrice').disabled = !on;
    if (on) { if (!$('#customPrice').value && lastCalc) $('#customPrice').value = Math.round(lastCalc.calcTotal); $('#customPrice').focus(); }
    recompute();
  });
  $('#tCur').addEventListener('change', () => { settings.currency = $('#tCur').value; applyModeLabels(); if (lastCalc) renderResult(false); });
  $('#btnLocate').onclick = () => {
    if (!navigator.geolocation) { toast('Геолокация недоступна'); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { longitude: lng, latitude: lat } = pos.coords;
      map.setCenter([lat, lng], 13, { duration: 400 });
      setPoint(0, { label: 'Моё местоположение', lng, lat });
      const l = await reverseGeocode(lng, lat); if (l) { points[0].label = l; renderPoints(); }
    }, () => toast('Не удалось определить местоположение'));
  };

  // ---------- старт ----------
  $('#btnTheme').onclick = () => applyTheme(theme() === 'dark' ? 'light' : 'dark');
  applyModeLabels();
  renderPoints();
  renderMarkers();
}

// ---------- загрузка API Яндекс Карт ----------
(function loadYandex() {
  const key = (window.APP_CONFIG && window.APP_CONFIG.yandexKey) || '';
  const fail = (msg) => {
    const el = document.getElementById('map');
    el.innerHTML = '<div class="map-error"><b>Карта не загрузилась</b><span>' + msg + '</span></div>';
    const st = document.getElementById('status'); if (st) { st.textContent = msg; st.classList.add('err'); }
  };
  if (!key) { fail('Не задан API-ключ Яндекс Карт (файл config.js).'); return; }
  const s = document.createElement('script');
  s.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU&apikey=' + encodeURIComponent(key);
  s.onload = () => ymaps.ready(startApp, () => fail('Яндекс Карты не ответили. Проверьте ключ и ограничения по адресу сайта.'));
  s.onerror = () => fail('Нет связи с Яндекс Картами.');
  document.head.appendChild(s);
})();
