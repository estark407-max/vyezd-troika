/* ВыездКалк — калькулятор стоимости доставки и выезда мастера */
(() => {
  'use strict';

  // ---------- хранилище (в памяти текущей сессии) ----------
  const mem = {};
  const store = {
    get(k, d) { return k in mem ? mem[k] : d; },
    set(k, v) { mem[k] = v; }
  };

  const DEFAULT_TARIFFS = {
    delivery: { base: 500, perKm: 30, freeKm: 5, min: 500, urgent: 50, night: 30, perMin: 5, round: 10 },
    master:   { base: 1000, perKm: 35, freeKm: 10, min: 1000, urgent: 50, night: 50, perMin: 15, round: 50 }
  };
  const MODE_NAMES = { delivery: 'Доставка', master: 'Выезд мастера' };

  let settings = store.get('vk_settings', null) || {
    tariffs: structuredClone(DEFAULT_TARIFFS), currency: '₽', base: null
  };
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
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [37.6173, 55.7558],
    zoom: 9,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#7a2c03', 'line-width': 8, 'line-opacity': .35 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#e5590f', 'line-width': 5 } });
  });

  map.on('click', async (e) => {
    const { lng, lat } = e.lngLat;
    const idx = activeIdx;
    setPoint(idx, { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lng, lat });
    const label = await reverseGeocode(lng, lat);
    if (label && points[idx] && points[idx].lng === lng) { points[idx].label = label; renderPoints(); }
    // перейти к следующему пустому полю
    const next = points.findIndex(p => !p);
    if (next >= 0) { activeIdx = next; renderPoints(); }
  });

  // ---------- геокодирование ----------
  function photonLabel(p) {
    const pr = p.properties;
    const street = [pr.street, pr.housenumber].filter(Boolean).join(', ');
    const main = pr.name && pr.name !== pr.street ? (street ? `${pr.name}, ${street}` : pr.name) : (street || pr.name || '');
    const place = [pr.city || pr.town || pr.village, pr.state, pr.country].filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return { main: main || place, place };
  }

  async function searchAddress(q) {
    const c = map.getCenter();
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat}&lon=${c.lng}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw 0;
      const j = await r.json();
      return j.features.map(f => {
        const l = photonLabel(f);
        return { main: l.main, place: l.place, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      });
    } catch {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=ru&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      return j.map(x => ({ main: x.display_name.split(',').slice(0, 2).join(','), place: x.display_name, lng: +x.lon, lat: +x.lat }));
    }
  }

  async function reverseGeocode(lng, lat) {
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&limit=1`);
      const j = await r.json();
      if (j.features && j.features[0]) {
        const l = photonLabel(j.features[0]);
        return [l.main, (l.place || '').split(',')[0]].filter(Boolean).join(', ');
      }
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
    const pick = (it) => { close(); setPoint(idx, { label: it.main + (it.place ? ', ' + it.place.split(',')[0] : ''), lng: it.lng, lat: it.lat }); map.flyTo({ center: [it.lng, it.lat], zoom: Math.max(map.getZoom(), 12) }); };
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
      }, 300);
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
    markers.forEach(m => m.remove()); markers.length = 0;
    points.forEach((p, i) => {
      if (!p) return;
      const isStart = i === 0, isEnd = i === points.length - 1;
      const el = document.createElement('div');
      el.className = 'marker';
      el.style.background = isStart ? '#2f7d4f' : isEnd ? '#e5590f' : '#1d1f21';
      el.innerHTML = `<span>${isStart ? 'A' : isEnd ? 'Б' : i}</span>`;
      const m = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
      m.on('dragend', async () => {
        const { lng, lat } = m.getLngLat();
        points[i] = { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lng, lat };
        renderPoints();
        const label = await reverseGeocode(lng, lat);
        if (label) { points[i].label = label; renderPoints(); }
        if (lastCalc) calculate();
      });
      markers.push(m);
    });
  }

  function clearRoute() {
    const src = map.getSource('route');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
    $('#result').hidden = true; lastCalc = null;
  }

  // ---------- маршрут ----------
  async function fetchRoute(coords) {
    const path = coords.map(c => `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`).join(';');
    const servers = [
      `https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson`,
      `https://routing.openstreetmap.de/routed-car/route/v1/driving/${path}?overview=full&geometries=geojson`
    ];
    let lastErr;
    for (const url of servers) {
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (j.code === 'Ok' && j.routes && j.routes[0]) return j.routes[0];
        lastErr = new Error(j.code === 'NoRoute' ? 'Между точками не найдено дороги' : 'Сервис маршрутов вернул ошибку');
      } catch (e) { lastErr = new Error('Нет связи с сервисом маршрутов'); }
    }
    throw lastErr;
  }

  // ---------- расчёт ----------
  function computeCost(km, tariff, opts) {
    const rows = [];
    rows.push(['Базовая стоимость выезда', `включено ${tariff.freeKm} км`, tariff.base]);
    const billKm = Math.max(0, km - tariff.freeKm);
    const kmCost = billKm * tariff.perKm;
    rows.push(['Пробег сверх базы', `${billKm.toFixed(1).replace('.', ',')} км × ${fmt(tariff.perKm)}`, kmCost]);
    if (opts.waitMin > 0) rows.push(['Ожидание / работа', `${opts.waitMin} мин × ${fmt(tariff.perMin)}`, opts.waitMin * tariff.perMin]);
    let subtotal = rows.reduce((s, r) => s + r[2], 0);
    const pct = (opts.urgent ? tariff.urgent : 0) + (opts.night ? tariff.night : 0);
    if (opts.urgent) rows.push(['Наценка «Срочно»', `+${tariff.urgent}%`, subtotal * tariff.urgent / 100]);
    if (opts.night) rows.push(['Наценка «Ночь / выходной»', `+${tariff.night}%`, subtotal * tariff.night / 100]);
    subtotal = subtotal * (1 + pct / 100);
    if (opts.extra > 0) { rows.push(['Доп. услуги', '', opts.extra]); subtotal += opts.extra; }
    let total = subtotal;
    if (total < tariff.min) { rows.push(['Доплата до минимального заказа', `мин. ${fmt(tariff.min)}`, tariff.min - total]); total = tariff.min; }
    const step = +tariff.round || 1;
    const rounded = Math.ceil(total / step) * step;
    if (rounded - total >= 0.5) rows.push(['Округление', `до ${step}`, rounded - total]);
    return { rows, total: rounded };
  }

  async function calculate() {
    const filled = points.filter(Boolean);
    const status = $('#status');
    status.classList.remove('err');
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
      const km = route.distance / 1000, min = route.duration / 60;
      lastRoute = { km, min };
      map.getSource('route').setData({ type: 'Feature', geometry: route.geometry, properties: {} });
      const b = new maplibregl.LngLatBounds();
      route.geometry.coordinates.forEach(c => b.extend(c));
      const wide = window.innerWidth > 900;
      map.fitBounds(b, { padding: wide ? 70 : 36, maxZoom: 15, duration: 700 });

      const tariff = settings.tariffs[mode];
      const opts = {
        urgent: $('#urgent').checked, night: $('#night').checked,
        extra: Math.max(0, +$('#extra').value || 0), waitMin: Math.max(0, +$('#waitMin').value || 0)
      };
      const res = computeCost(km, tariff, opts);
      lastCalc = { ...res, km, min, round, opts, mode, points: filled.map(p => p.label), date: new Date().toISOString() };
      renderResult();
      status.textContent = round ? 'Маршрут с возвратом на базу.' : '';
    } catch (e) {
      status.textContent = e.message || 'Не удалось построить маршрут';
      status.classList.add('err');
    } finally { btn.disabled = false; }
  }

  function fmtDuration(min) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  }

  function renderResult() {
    const c = lastCalc;
    $('#result').hidden = false;
    $('#total').textContent = money(c.total);
    $('#rDist').textContent = c.km.toFixed(1).replace('.', ',');
    $('#rTime').textContent = fmtDuration(c.min);
    $('#breakdown').innerHTML = c.rows.map(r =>
      `<tr><td>${r[0]}${r[1] ? ` <small>${r[1]}</small>` : ''}</td><td>${money(r[2])}</td></tr>`).join('') +
      `<tr class="sum"><td>Итого</td><td>${money(c.total)}</td></tr>`;
    if (window.innerWidth <= 900) $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function orderText(c, num) {
    const lines = [
      `Заявка${num ? ' №' + num : ''} — ${MODE_NAMES[c.mode]}`,
      `Дата: ${new Date(c.date).toLocaleString('ru-RU')}`,
      `Маршрут: ${c.points.join(' → ')}${c.round ? ' → обратно' : ''}`,
      `Расстояние: ${c.km.toFixed(1)} км, в пути ~${fmtDuration(c.min)}`,
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
        <small>${new Date(h.date).toLocaleString('ru-RU')} · ${h.km.toFixed(1)} км${h.client ? ' · ' + escapeHtml(h.client) : ''}</small>
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
      h.km.toFixed(1).replace('.', ','), Math.round(h.min), h.client, h.comment, h.total, h.currency]);
    const csv = '\ufeff' + [head, ...rows].map(r => r.map(esc).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'zayavki.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- тарифы ----------
  const S_FIELDS = { sBase: 'base', sPerKm: 'perKm', sFreeKm: 'freeKm', sMin: 'min', sUrgent: 'urgent', sNight: 'night', sPerMin: 'perMin', sRound: 'round' };
  function fillSettings() {
    const t = settings.tariffs[mode];
    $('#setModeName').textContent = MODE_NAMES[mode];
    for (const [id, k] of Object.entries(S_FIELDS)) $('#' + id).value = t[k];
    $('#sCur').value = settings.currency;
    $('#sBaseAddr').value = settings.base ? settings.base.label : '';
  }
  function saveSettings() {
    const t = settings.tariffs[mode];
    for (const [id, k] of Object.entries(S_FIELDS)) t[k] = Math.max(0, +$('#' + id).value || 0);
    if (!t.round) t.round = 1;
    settings.currency = $('#sCur').value;
    const addr = $('#sBaseAddr').value.trim();
    if (!addr) settings.base = null; else if (settings.base) settings.base.label = addr;
    store.set('vk_settings', settings);
    applyModeLabels();
    closeModal('#settingsModal');
    toast('Тариф сохранён');
    if (lastCalc) calculate();
  }

  function applyModeLabels() {
    const t = settings.tariffs[mode];
    $('#urgentLbl').textContent = `+${t.urgent}%`;
    $('#nightLbl').textContent = `+${t.night}%`;
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
    if (lastRoute && lastCalc) calculate();
  }));
  $('#btnAddStop').onclick = () => { points.splice(points.length - 1, 0, null); activeIdx = points.length - 2; renderPoints(); renderMarkers(); $('#points').querySelectorAll('input')[activeIdx].focus(); };
  $('#btnCalc').onclick = calculate;
  $('#btnSave').onclick = saveOrder;
  $('#btnCopy').onclick = () => lastCalc && copy(orderText(lastCalc));
  $('#btnSettings').onclick = () => { fillSettings(); openModal('#settingsModal'); };
  $('#btnHistory').onclick = () => { renderHistory(); openModal('#historyModal'); };
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnReset').onclick = () => { settings.tariffs[mode] = structuredClone(DEFAULT_TARIFFS[mode]); fillSettings(); };
  $('#btnSetBase').onclick = () => {
    if (!points[0]) { toast('Сначала укажите точку «Откуда»'); return; }
    settings.base = { ...points[0] }; $('#sBaseAddr').value = settings.base.label; toast('База задана — не забудьте сохранить');
  };
  $('#btnExport').onclick = exportCsv;
  $('#btnClearHist').onclick = () => { history = []; store.set('vk_history', history); renderHistory(); };
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.hidden = true); });
  ['#urgent', '#night', '#roundTrip'].forEach(s => $(s).addEventListener('change', () => { if (lastCalc) calculate(); }));
  ['#extra', '#waitMin'].forEach(s => $(s).addEventListener('change', () => { if (lastCalc) calculate(); }));
  $('#btnLocate').onclick = () => {
    if (!navigator.geolocation) { toast('Геолокация недоступна'); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { longitude: lng, latitude: lat } = pos.coords;
      map.flyTo({ center: [lng, lat], zoom: 13 });
      setPoint(0, { label: 'Моё местоположение', lng, lat });
      const l = await reverseGeocode(lng, lat); if (l) { points[0].label = l; renderPoints(); }
    }, () => toast('Не удалось определить местоположение'));
  };

  // ---------- старт ----------
  if (settings.base) { points[0] = { ...settings.base }; activeIdx = 1; map.setCenter([settings.base.lng, settings.base.lat]); map.setZoom(11); }
  applyModeLabels();
  renderPoints();
  renderMarkers();
})();
