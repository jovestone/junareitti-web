'use strict';

// Web port of JunaReitti (github.com/suunta/suunta): train timetables between two stations,
// using Fintraffic's open rail API at rata.digitraffic.fi.

const API = 'https://rata.digitraffic.fi/api/v1';
const API_HEADERS = { 'Digitraffic-User': 'JunaReitti-web' };
const TIME_ZONE = 'Europe/Helsinki';
const STATION_CACHE_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 60 * 1000;
const TRAIN_LIMIT = 30;
const START_OFFSET_MIN = -30; // look back a bit so late trains are included
const RING_LINES = ['I', 'P'];
const RING_MAX_FACTOR = 2.1; // drop ring-line trips that take the long way round
const LOCATE = { locate: true, name: 'Oma sijainti' };

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  },
};

const state = {
  stations: [],
  byCode: new Map(),
  from: null,
  to: null,
  trains: [],
  loading: false,
  message: '',
  updated: null,
  requestId: 0,
};

const els = {
  from: document.getElementById('from'),
  to: document.getElementById('to'),
  fromList: document.getElementById('from-list'),
  toList: document.getElementById('to-list'),
  swap: document.getElementById('swap'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  list: document.getElementById('list'),
};

const timeFormat = new Intl.DateTimeFormat('fi-FI', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
const formatTime = date => timeFormat.format(date);

// ---- Stations ----

function cleanStationName(name) {
  return name.replace(/ asema$/i, '');
}

async function loadStations() {
  const cached = store.get('stations', null);
  if (cached && Date.now() - cached.fetched < STATION_CACHE_MS) return cached.list;
  try {
    const res = await fetch(API + '/metadata/stations', { headers: API_HEADERS });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = data
      .filter(s => s.passengerTraffic && s.stationShortCode !== 'PAU')
      .map(s => ({ code: s.stationShortCode, name: cleanStationName(s.stationName), lat: s.latitude, lon: s.longitude }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fi'));
    store.set('stations', { fetched: Date.now(), list });
    return list;
  } catch (e) {
    if (cached) return cached.list;
    throw e;
  }
}

function bumpUsage(code) {
  const usage = store.get('usage', {});
  usage[code] = (usage[code] || 0) + 1;
  store.set('usage', usage);
}

function nearestStation(lat, lon) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  let best = null;
  let bestDist = Infinity;
  for (const s of state.stations) {
    const dx = (s.lon - lon) * cosLat;
    const dy = s.lat - lat;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

// ---- Suggestions ----

const fold = s => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function suggestionsFor(which, query) {
  const q = fold(query);
  if (!q) {
    const other = which === 'from' ? state.to : state.from;
    const usage = store.get('usage', {});
    const mostUsed = Object.keys(usage)
      .filter(code => state.byCode.has(code) && !(other && other.code === code))
      .sort((a, b) => usage[b] - usage[a])
      .slice(0, 5)
      .map(code => state.byCode.get(code));
    return which === 'from' && 'geolocation' in navigator ? [LOCATE].concat(mostUsed) : mostUsed;
  }
  const starts = [];
  const contains = [];
  for (const s of state.stations) {
    const name = fold(s.name);
    if (name.startsWith(q) || s.code.toLowerCase() === q) starts.push(s);
    else if (name.includes(q)) contains.push(s);
  }
  return starts.concat(contains).slice(0, 40);
}

const combo = {
  from: { input: els.from, list: els.fromList, items: [], active: -1 },
  to: { input: els.to, list: els.toList, items: [], active: -1 },
};

function showSuggestions(which, query) {
  const c = combo[which];
  c.items = suggestionsFor(which, query);
  c.active = query.trim() && c.items.length ? 0 : -1;
  c.list.textContent = '';
  c.items.forEach((item, i) => {
    const li = document.createElement('li');
    li.id = which + '-opt-' + i;
    li.setAttribute('role', 'option');
    if (item.locate) {
      li.className = 'locate';
      li.textContent = '⌖ ' + item.name;
    } else {
      li.textContent = item.name;
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = item.code;
      li.appendChild(code);
    }
    li.addEventListener('click', () => pick(which, item));
    c.list.appendChild(li);
  });
  c.list.hidden = c.items.length === 0;
  c.input.setAttribute('aria-expanded', String(!c.list.hidden));
  highlight(which);
}

function highlight(which) {
  const c = combo[which];
  Array.from(c.list.children).forEach((li, i) => li.setAttribute('aria-selected', String(i === c.active)));
  const active = c.list.children[c.active];
  if (active) {
    c.input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    c.input.removeAttribute('aria-activedescendant');
  }
}

function hideSuggestions(which) {
  const c = combo[which];
  c.list.hidden = true;
  c.input.setAttribute('aria-expanded', 'false');
  c.input.removeAttribute('aria-activedescendant');
}

function pick(which, item) {
  hideSuggestions(which);
  if (item.locate) {
    locate();
    return;
  }
  setStation(which, item);
}

function setStation(which, station) {
  state[which] = station;
  combo[which].input.value = station.name;
  bumpUsage(station.code);
  store.set('route', { from: state.from && state.from.code, to: state.to && state.to.code });
  if (which === 'from' && !state.to) {
    els.to.focus();
  } else {
    combo[which].input.blur();
  }
  fetchTrains();
}

function exactMatch(value) {
  const q = fold(value);
  return state.stations.find(s => fold(s.name) === q || s.code.toLowerCase() === q);
}

function setupCombo(which) {
  const c = combo[which];
  const input = c.input;

  input.addEventListener('focus', () => {
    input.select();
    // A committed station's name means "nothing typed yet": offer recent stations instead.
    const current = state[which];
    showSuggestions(which, current && input.value === current.name ? '' : input.value);
  });

  input.addEventListener('input', () => showSuggestions(which, input.value));

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!c.items.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      c.active = (c.active + step + c.items.length) % c.items.length;
      highlight(which);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = c.items[c.active] || exactMatch(input.value) || (input.value.trim() && c.items[0]);
      if (item) pick(which, item);
    } else if (e.key === 'Escape') {
      hideSuggestions(which);
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    hideSuggestions(which);
    const current = state[which];
    if (current && input.value === current.name) return;
    const match = exactMatch(input.value);
    if (match) setStation(which, match);
    else input.value = current ? current.name : '';
  });

  // Keep focus in the input while tapping a suggestion, so blur doesn't hide the list first.
  c.list.addEventListener('mousedown', e => e.preventDefault());
}

function locate() {
  if (!('geolocation' in navigator)) return;
  state.message = 'Haetaan sijaintia…';
  els.from.blur();
  render();
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.message = '';
      const station = nearestStation(pos.coords.latitude, pos.coords.longitude);
      if (station) setStation('from', station);
      else render();
    },
    err => {
      state.message = err.code === err.PERMISSION_DENIED
        ? 'Sijainnin käyttö on estetty. Salli se selaimen asetuksista.'
        : 'Sijaintia ei saatu.';
      render();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}

// ---- Trains ----

function hasDeparted(row, now) {
  if (row.actualTime) return true;
  const expected = new Date(row.liveEstimateTime || row.scheduledTime);
  return expected < now - 60 * 1000;
}

// Finds the leg fromCode -> toCode: the last departure from fromCode before arriving at toCode.
// Ring lines (I/P) pass some stations twice, so taking the first departure would be wrong.
function findLeg(rows, fromCode, toCode, now) {
  let dep = null;
  for (const row of rows) {
    if (!row.trainStopping || !row.commercialStop) continue;
    if (row.type === 'DEPARTURE' && row.stationShortCode === fromCode) {
      dep = row;
    } else if (dep && row.type === 'ARRIVAL' && row.stationShortCode === toCode) {
      if (!hasDeparted(dep, now)) return { dep, arr: row };
      dep = null;
    }
  }
  return null;
}

function timeInfo(row) {
  const scheduled = new Date(row.scheduledTime);
  const live = row.actualTime || row.liveEstimateTime;
  const estimate = live ? new Date(live) : null;
  const changed = !!estimate && Math.abs(estimate - scheduled) >= 60 * 1000;
  return { scheduled, time: changed ? estimate : scheduled, changed };
}

function buildTrains(trains, fromCode, toCode, now) {
  const result = [];
  for (const train of trains) {
    const leg = findLeg(train.timeTableRows, fromCode, toCode, now);
    if (!leg) continue;
    const dep = timeInfo(leg.dep);
    const arr = timeInfo(leg.arr);
    result.push({
      key: train.departureDate + '/' + train.trainNumber,
      line: train.commuterLineID || '',
      label: train.commuterLineID || train.trainType + ' ' + train.trainNumber,
      dep,
      arr,
      track: leg.dep.commercialTrack || '–',
      cancelled: !!(train.cancelled || leg.dep.cancelled || leg.arr.cancelled),
      duration: arr.scheduled - dep.scheduled,
    });
  }
  const minDuration = Math.min(...result.map(t => t.duration));
  return result
    .filter(t => !RING_LINES.includes(t.line) || t.duration <= minDuration * RING_MAX_FACTOR)
    .sort((a, b) => a.dep.time - b.dep.time);
}

async function fetchTrains() {
  if (!state.from || !state.to) {
    render();
    return;
  }
  const id = ++state.requestId;
  if (state.from.code === state.to.code) {
    state.trains = [];
    state.updated = null;
    state.message = 'Valitse kaksi eri asemaa.';
    render();
    return;
  }
  state.loading = true;
  state.message = '';
  render();

  const start = new Date(Date.now() + START_OFFSET_MIN * 60 * 1000).toISOString();
  const url = API + '/live-trains/station/' + state.from.code + '/' + state.to.code +
    '?limit=' + TRAIN_LIMIT + '&startDate=' + encodeURIComponent(start);
  try {
    const res = await fetch(url, { headers: API_HEADERS, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (id !== state.requestId) return;
    // No direct trains comes back as 200 with { code: 'TRAIN_NOT_FOUND' }.
    state.trains = Array.isArray(data) ? buildTrains(data, state.from.code, state.to.code, new Date()) : [];
    state.updated = new Date();
  } catch (e) {
    if (id !== state.requestId) return;
    state.message = navigator.onLine === false ? 'Ei verkkoyhteyttä.' : 'Aikataulujen haku epäonnistui.';
  } finally {
    if (id === state.requestId) {
      state.loading = false;
      render();
    }
  }
}

// ---- Rendering ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeCell(info, extra) {
  const cell = el('span', 'cell', '');
  cell.setAttribute('role', 'cell');
  cell.appendChild(el('span', 'time' + (info.changed ? ' changed' : ''), formatTime(info.time)));
  if (info.changed) cell.appendChild(el('span', 'sub scheduled', formatTime(info.scheduled)));
  else if (extra) cell.appendChild(el('span', 'sub', extra));
  return cell;
}

function minutesUntil(date, now) {
  const min = Math.round((date - now) / 60000);
  if (min <= 0) return 'nyt';
  if (min < 60) return min + ' min';
  return '';
}

function renderRow(train, now) {
  const row = el('div', 'row' + (train.cancelled ? ' cancelled' : ''));
  row.setAttribute('role', 'row');

  const lineCell = el('span', 'cell');
  lineCell.setAttribute('role', 'cell');
  lineCell.appendChild(el('span', train.line ? 'line line-' + train.line : 'long', train.label));
  row.appendChild(lineCell);

  row.appendChild(timeCell(train.dep, train.cancelled ? '' : minutesUntil(train.dep.time, now)));

  const track = el('span', 'cell track', train.cancelled ? '–' : train.track);
  track.setAttribute('role', 'cell');
  row.appendChild(track);

  if (train.cancelled) {
    const cell = el('span', 'cell');
    cell.setAttribute('role', 'cell');
    cell.appendChild(el('span', 'time cancel-note', 'Peruttu'));
    row.appendChild(cell);
  } else {
    row.appendChild(timeCell(train.arr));
  }
  return row;
}

function render() {
  const now = new Date();
  const hasRoute = state.from && state.to;

  let status = '';
  if (state.message) status = state.message;
  else if (state.loading) status = 'Haetaan junia…';
  else if (hasRoute && state.updated) status = state.from.name + ' → ' + state.to.name + ' · päivitetty ' + formatTime(state.updated);
  els.status.textContent = status;

  els.refresh.hidden = !hasRoute;
  els.refresh.disabled = state.loading;

  els.list.textContent = '';
  if (!hasRoute) {
    els.list.appendChild(el('p', 'empty', 'Valitse lähtö- ja tuloasema.'));
    return;
  }
  if (!state.trains.length) {
    if (state.updated && !state.loading) els.list.appendChild(el('p', 'empty', 'Ei suoria junia lähiaikoina.'));
    return;
  }
  const head = el('div', 'row head');
  head.setAttribute('role', 'row');
  for (const title of ['Juna', 'Lähtee', 'Raide', 'Perillä']) {
    const th = el('span', title === 'Raide' ? 'track' : '', title);
    th.setAttribute('role', 'columnheader');
    head.appendChild(th);
  }
  els.list.appendChild(head);
  for (const train of state.trains) els.list.appendChild(renderRow(train, now));
}

// ---- Startup ----

els.swap.addEventListener('click', () => {
  const from = state.from;
  state.from = state.to;
  state.to = from;
  els.from.value = state.from ? state.from.name : '';
  els.to.value = state.to ? state.to.name : '';
  store.set('route', { from: state.from && state.from.code, to: state.to && state.to.code });
  fetchTrains();
});

els.refresh.addEventListener('click', fetchTrains);

setInterval(() => {
  if (document.visibilityState === 'visible' && !state.loading) fetchTrains();
}, REFRESH_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.updated && Date.now() - state.updated > 30 * 1000) fetchTrains();
});

setupCombo('from');
setupCombo('to');

async function init() {
  render();
  els.status.textContent = 'Ladataan asemia…';
  try {
    state.stations = await loadStations();
  } catch (e) {
    els.status.textContent = 'Asemien haku epäonnistui. Tarkista verkkoyhteys ja lataa sivu uudelleen.';
    return;
  }
  state.byCode = new Map(state.stations.map(s => [s.code, s]));

  // A link like ?from=PSL&to=HKI opens that route; otherwise restore the last one used.
  const params = new URLSearchParams(location.search);
  const route = params.has('from') || params.has('to')
    ? { from: (params.get('from') || '').toUpperCase(), to: (params.get('to') || '').toUpperCase() }
    : store.get('route', {});
  state.from = state.byCode.get(route.from) || null;
  state.to = state.byCode.get(route.to) || null;
  if (state.from) els.from.value = state.from.name;
  if (state.to) els.to.value = state.to.name;

  if (state.from && state.to) fetchTrains();
  else render();
}

init();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // When an updated service worker takes over a page loaded by the old one, reload once
  // so the new files show up now rather than on the next launch.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(reg => reg.update())
    .catch(() => {});
}
