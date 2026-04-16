import { STRAVA_API_BASE, STORAGE_KEYS, SEGMENT_DEFAULTS, RATE_LIMIT, CACHE_TTL_MS, DETAIL_FRESH_MS } from '../lib/config.js';
import { centerRadiusToBounds, subdivideBox, boundsToString, haversineKm, decodePolyline, parseTimeToSeconds, formatSeconds, formatPace } from '../lib/geo.js';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  map: null,
  circle: null,
  centerMarker: null,
  center: null,
  radius: SEGMENT_DEFAULTS.RADIUS_KM,
  searching: false,
  aborted: false,
  segments: [],          // current filtered results
  exploreSegments: [],   // raw explore data for current search
  allDetails: {},        // id → detail data (in-memory)
  polylines: {},         // id → Leaflet polyline
  activeSegmentId: null,
  requestTimestamps: [],
  totalRequests: 0,
  lastExploreZone: null,  // { lat, lng, radius, type } of last explore
  currentSearchId: null,
  savedSearches: []
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const centerLatInput = $('#centerLat');
const centerLngInput = $('#centerLng');
const radiusSlider = $('#radiusSlider');
const radiusValue = $('#radiusValue');
const activityType = $('#activityType');
const distMin = $('#distMin');
const distMax = $('#distMax');
const paceMin = $('#paceMin');
const paceMax = $('#paceMax');
const elevMin = $('#elevMin');
const elevMax = $('#elevMax');
const gradeMin = $('#gradeMin');
const gradeMax = $('#gradeMax');
const searchBtn = $('#searchBtn');
const stopBtn = $('#stopBtn');
const progressDiv = $('#progress');
const progressFill = $('#progressFill');
const progressText = $('#progressText');
const rateInfo = $('#rateInfo');
const resultsList = $('#resultsList');
const resultCount = $('#resultCount');
const sortBy = $('#sortBy');
const mapHint = $('#mapHint');
const geocodeInput = $('#geocodeInput');
const geocodeResults = $('#geocodeResults');
const savedList = $('#savedList');
const savedCount = $('#savedCount');
const savedArrow = $('#savedArrow');

// ── Init ─────────────────────────────────────────────────────────────────────
initMap();
initEvents();
initGeocode();
loadStatus();
loadSavedSearches().then(() => {
  loadLastSearch();
});

// ── Map ──────────────────────────────────────────────────────────────────────
function initMap() {
  L.Icon.Default.imagePath = '../vendor/images/';

  state.map = L.map('map', { zoomControl: true }).setView(
    [SEGMENT_DEFAULTS.CENTER.lat, SEGMENT_DEFAULTS.CENTER.lng], 13
  );

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(state.map);

  state.map.on('click', (e) => {
    setCenter(e.latlng.lat, e.latlng.lng);
    mapHint.classList.add('hidden');
  });
}

function setCenter(lat, lng) {
  state.center = { lat, lng };
  centerLatInput.value = lat.toFixed(4);
  centerLngInput.value = lng.toFixed(4);

  if (state.centerMarker) state.centerMarker.setLatLng([lat, lng]);
  else state.centerMarker = L.circleMarker([lat, lng], {
    radius: 6, color: '#1a1a2e', fillColor: '#1a1a2e', fillOpacity: 1, weight: 2
  }).addTo(state.map);

  updateCircle();
}

function updateCircle() {
  if (!state.center) return;
  const radiusM = state.radius * 1000;
  if (state.circle) {
    state.circle.setLatLng([state.center.lat, state.center.lng]);
    state.circle.setRadius(radiusM);
  } else {
    state.circle = L.circle([state.center.lat, state.center.lng], {
      radius: radiusM,
      color: '#FC4C02',
      fillColor: '#FC4C02',
      fillOpacity: 0.08,
      weight: 2,
      dashArray: '6,4'
    }).addTo(state.map);
  }
}

function clearSegmentsFromMap() {
  Object.values(state.polylines).forEach(pl => state.map.removeLayer(pl));
  state.polylines = {};
}

function addSegmentToMap(seg) {
  const points = seg.points ? decodePolyline(seg.points) : null;
  if (!points || points.length < 2) return;

  const pl = L.polyline(points, {
    color: '#FC4C02',
    weight: 3,
    opacity: 0.7
  }).addTo(state.map);

  pl.on('click', () => highlightSegment(seg.id));
  pl.on('mouseover', () => {
    if (state.activeSegmentId !== seg.id) {
      pl.setStyle({ color: '#e02000', weight: 5, opacity: 1 });
      pl.bringToFront();
    }
    const card = document.querySelector(`.segment-card[data-id="${seg.id}"]`);
    if (card) card.classList.add('hover');
  });
  pl.on('mouseout', () => {
    if (state.activeSegmentId !== seg.id) {
      pl.setStyle({ color: '#FC4C02', weight: 3, opacity: 0.7 });
    }
    const card = document.querySelector(`.segment-card[data-id="${seg.id}"]`);
    if (card) card.classList.remove('hover');
  });
  pl.bindTooltip(seg.name, { sticky: true });

  state.polylines[seg.id] = pl;
}

function highlightSegment(id) {
  if (state.activeSegmentId && state.polylines[state.activeSegmentId]) {
    state.polylines[state.activeSegmentId].setStyle({ color: '#FC4C02', weight: 3, opacity: 0.7 });
  }
  document.querySelectorAll('.segment-card.active').forEach(el => el.classList.remove('active'));

  state.activeSegmentId = id;

  if (state.polylines[id]) {
    state.polylines[id].setStyle({ color: '#e02000', weight: 5, opacity: 1 });
    state.polylines[id].bringToFront();
  }

  const card = document.querySelector(`.segment-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function fitMapToSegments(segments) {
  const allPoints = segments.flatMap(s => {
    if (s.points) return decodePolyline(s.points);
    if (s.start_latlng) return [s.start_latlng];
    return [];
  });
  if (allPoints.length > 0) {
    state.map.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
  }
}

// ── Geocode (Nominatim) ──────────────────────────────────────────────────────
let geocodeTimer = null;

function initGeocode() {
  geocodeInput.addEventListener('input', () => {
    clearTimeout(geocodeTimer);
    const q = geocodeInput.value.trim();
    if (q.length < 3) { geocodeResults.classList.remove('visible'); return; }
    geocodeTimer = setTimeout(() => geocodeSearch(q), 350);
  });

  geocodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      geocodeResults.classList.remove('visible');
      geocodeInput.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.geocode-bar')) geocodeResults.classList.remove('visible');
  });
}

async function geocodeSearch(query) {
  try {
    const params = new URLSearchParams({
      q: query, format: 'json', addressdetails: '1', limit: '5'
    });
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'Accept-Language': 'fr' }
    });
    if (!resp.ok) return;
    const results = await resp.json();
    renderGeocodeResults(results);
  } catch (err) {
    console.warn('Geocode error:', err);
  }
}

function renderGeocodeResults(results) {
  geocodeResults.innerHTML = '';
  if (results.length === 0) { geocodeResults.classList.remove('visible'); return; }

  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'geocode-item';
    const name = r.display_name.split(',')[0];
    const rest = r.display_name.split(',').slice(1, 3).join(',').trim();
    item.innerHTML = `<div>${esc(name)}</div><div class="geocode-secondary">${esc(rest)}</div>`;
    item.addEventListener('click', () => {
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lon);
      setCenter(lat, lng);
      state.map.setView([lat, lng], 14);
      geocodeInput.value = r.display_name.split(',').slice(0, 2).join(',');
      geocodeResults.classList.remove('visible');
      mapHint.classList.add('hidden');
    });
    geocodeResults.appendChild(item);
  }
  geocodeResults.classList.add('visible');
}

// ── Events ───────────────────────────────────────────────────────────────────
function initEvents() {
  radiusSlider.addEventListener('input', () => {
    state.radius = parseFloat(radiusSlider.value);
    radiusValue.textContent = `${state.radius} km`;
    updateCircle();
  });

  centerLatInput.addEventListener('change', applyCenterFromInputs);
  centerLngInput.addEventListener('change', applyCenterFromInputs);

  searchBtn.addEventListener('click', startSearch);
  stopBtn.addEventListener('click', () => { state.aborted = true; });
  sortBy.addEventListener('change', () => renderResults(state.segments));

  // Saved searches toggle
  $('#savedToggle').addEventListener('click', () => {
    const list = savedList;
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : '';
    savedArrow.classList.toggle('open', !open);
  });

  // Filters toggle
  $('#filtersToggle').addEventListener('click', () => {
    const body = $('#filtersBody');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    $('#filtersArrow').classList.toggle('open', !open);
  });

  $('#settingsBtn').addEventListener('click', () => $('#settingsModal').style.display = '');
  $('#modalClose').addEventListener('click', () => $('#settingsModal').style.display = 'none');
  $('#modalClearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearSegmentsCache' });
    state.allDetails = {};
    rateInfo.textContent = 'Cache vide.';
  });
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) $('#settingsModal').style.display = 'none';
  });
}

function applyCenterFromInputs() {
  const lat = parseFloat(centerLatInput.value);
  const lng = parseFloat(centerLngInput.value);
  if (!isNaN(lat) && !isNaN(lng)) setCenter(lat, lng);
}

// ── Status ───────────────────────────────────────────────────────────────────
async function loadStatus() {
  const resp = await chrome.runtime.sendMessage({ action: 'getStatus' });
  if (resp.stravaConnected) {
    statusDot.className = 'dot connected';
    const name = resp.athlete ? `${resp.athlete.firstname} ${resp.athlete.lastname}` : 'Connecte';
    statusText.textContent = name;
  } else {
    statusDot.className = 'dot disconnected';
    statusText.textContent = resp.stravaConfigured ? 'Non connecte' : 'Non configure — ouvrir les parametres du Dashboard';
  }
}

// ── Saved searches persistence ───────────────────────────────────────────────
async function loadSavedSearches() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SAVED_SEARCHES);
  state.savedSearches = data[STORAGE_KEYS.SAVED_SEARCHES] || [];
  renderSavedSearches();
}

async function persistSavedSearches() {
  await chrome.storage.local.set({ [STORAGE_KEYS.SAVED_SEARCHES]: state.savedSearches });
}

function generateSearchName(params) {
  const lat = params.center.lat.toFixed(2);
  const lng = params.center.lng.toFixed(2);
  const date = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  return `${date} — ${lat}, ${lng} (${params.radius}km)`;
}

async function saveCurrentSearch(exploreSegs, filteredSegs) {
  const params = getCurrentParams();
  const search = {
    id: crypto.randomUUID(),
    name: generateSearchName(params),
    createdAt: Date.now(),
    params,
    exploreSegments: exploreSegs,
    filteredIds: filteredSegs.map(s => s.id)
  };

  state.savedSearches.unshift(search);
  state.currentSearchId = search.id;
  await persistSavedSearches();
  renderSavedSearches();
  return search;
}

async function updateSavedSearch(searchId, updates) {
  const idx = state.savedSearches.findIndex(s => s.id === searchId);
  if (idx === -1) return;
  Object.assign(state.savedSearches[idx], updates);
  await persistSavedSearches();
  renderSavedSearches();
}

async function deleteSavedSearch(searchId) {
  state.savedSearches = state.savedSearches.filter(s => s.id !== searchId);
  if (state.currentSearchId === searchId) {
    state.currentSearchId = null;
    clearSegmentsFromMap();
    resultsList.innerHTML = '';
    resultCount.textContent = '';
    state.segments = [];
    state.exploreSegments = [];
  }
  await persistSavedSearches();
  renderSavedSearches();
}

function getCurrentParams() {
  return {
    center: state.center ? { ...state.center } : null,
    radius: state.radius,
    activityType: activityType.value,
    distMin: distMin.value,
    distMax: distMax.value,
    paceMin: paceMin.value,
    paceMax: paceMax.value,
    elevMin: elevMin.value,
    elevMax: elevMax.value,
    gradeMin: gradeMin.value,
    gradeMax: gradeMax.value
  };
}

function applyParams(params) {
  if (params.center) {
    setCenter(params.center.lat, params.center.lng);
    state.map.setView([params.center.lat, params.center.lng], 13);
    mapHint.classList.add('hidden');
  }
  if (params.radius) {
    state.radius = params.radius;
    radiusSlider.value = params.radius;
    radiusValue.textContent = `${params.radius} km`;
    updateCircle();
  }
  if (params.activityType) activityType.value = params.activityType;
  if (params.distMin) distMin.value = params.distMin;
  if (params.distMax) distMax.value = params.distMax;
  paceMin.value = params.paceMin || '';
  paceMax.value = params.paceMax || '';
  elevMin.value = params.elevMin || '';
  elevMax.value = params.elevMax || '';
  gradeMin.value = params.gradeMin || '';
  gradeMax.value = params.gradeMax || '';
}

// ── Render saved searches list ───────────────────────────────────────────────
function renderSavedSearches() {
  savedCount.textContent = state.savedSearches.length > 0 ? `(${state.savedSearches.length})` : '';
  savedList.innerHTML = '';

  if (state.savedSearches.length === 0) {
    savedList.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-light);">Aucune recherche sauvegardee.</div>';
    return;
  }

  for (const search of state.savedSearches) {
    const item = document.createElement('div');
    item.className = 'saved-item' + (search.id === state.currentSearchId ? ' active' : '');
    item.dataset.id = search.id;

    const segCount = search.filteredIds ? search.filteredIds.length : 0;
    const date = new Date(search.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });

    item.innerHTML = `
      <span class="saved-name" title="${esc(search.name)}">${esc(search.name)}</span>
      <span class="saved-meta">${segCount} seg</span>
      <div class="saved-actions">
        <button class="rename" title="Renommer">&#9998;</button>
        <button class="refresh" title="Rafraichir toute la recherche">&#8635;</button>
        <button class="del" title="Supprimer">&#10005;</button>
      </div>
    `;

    // Click to load
    item.addEventListener('click', (e) => {
      if (e.target.closest('.saved-actions')) return;
      restoreSavedSearch(search.id);
    });

    // Rename
    item.querySelector('.rename').addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = prompt('Nom de la recherche:', search.name);
      if (newName && newName.trim()) {
        updateSavedSearch(search.id, { name: newName.trim() });
      }
    });

    // Refresh entire search
    item.querySelector('.refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      refreshEntireSearch(search.id);
    });

    // Delete
    item.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer "${search.name}" ?`)) {
        deleteSavedSearch(search.id);
      }
    });

    savedList.appendChild(item);
  }
}

// ── Restore a saved search ───────────────────────────────────────────────────
async function restoreSavedSearch(searchId) {
  const search = state.savedSearches.find(s => s.id === searchId);
  if (!search) return;

  state.currentSearchId = searchId;
  applyParams(search.params);

  // Load detail cache into memory
  const cache = await loadCache();
  for (const [id, entry] of Object.entries(cache)) {
    state.allDetails[id] = entry.data;
  }

  // Restore explore segments + zone info for reuse
  state.exploreSegments = search.exploreSegments || [];
  if (search.params.center) {
    state.lastExploreZone = {
      lat: search.params.center.lat,
      lng: search.params.center.lng,
      radius: search.params.radius,
      type: search.params.activityType
    };
  }

  // Re-apply filters (using stored explore data + current detail cache)
  const filtered = applyFilters(state.exploreSegments);
  state.segments = filtered;

  // Update filtered IDs in saved search (in case cache updated details)
  search.filteredIds = filtered.map(s => s.id);
  await persistSavedSearches();

  // Display
  clearSegmentsFromMap();
  filtered.forEach(seg => addSegmentToMap(seg));
  renderResults(filtered);
  renderSavedSearches();

  if (filtered.length > 0) fitMapToSegments(filtered);

  progressDiv.style.display = '';
  setProgress(100, `${filtered.length} segment(s) — recherche restauree`);
}

// ── Refresh entire search ────────────────────────────────────────────────────
async function refreshEntireSearch(searchId) {
  const search = state.savedSearches.find(s => s.id === searchId);
  if (!search || !search.params.center) return;
  if (state.searching) return;

  // Apply params so UI is synced
  state.currentSearchId = searchId;
  applyParams(search.params);

  state.searching = true;
  state.aborted = false;
  state.totalRequests = 0;
  searchBtn.style.display = 'none';
  stopBtn.style.display = '';
  progressDiv.style.display = '';
  resultsList.innerHTML = '';
  resultCount.textContent = '';
  clearSegmentsFromMap();

  try {
    const token = await getToken();
    const bounds = centerRadiusToBounds(search.params.center.lat, search.params.center.lng, search.params.radius || 3);
    const type = search.params.activityType || 'running';

    setProgress(0, 'Re-exploration de la zone...');
    const rawSegments = await recursiveExplore(bounds, type, token);
    if (state.aborted) { finishSearch('Annulee.'); return; }

    // Pre-filter
    const dmn = parseFloat(search.params.distMin);
    const dmx = parseFloat(search.params.distMax);
    const gMin = parseFloat(search.params.gradeMin);
    const gMax = parseFloat(search.params.gradeMax);
    const preFiltered = rawSegments.filter(s => {
      if (!isNaN(dmn) && s.distance < dmn) return false;
      if (!isNaN(dmx) && s.distance > dmx) return false;
      if (!isNaN(gMin) && s.avg_grade < gMin) return false;
      if (!isNaN(gMax) && s.avg_grade > gMax) return false;
      return true;
    });

    setProgress(30, `${preFiltered.length} segments apres pre-filtre (${rawSegments.length} total)`);

    // Fetch details — force re-fetch all
    for (let i = 0; i < preFiltered.length; i++) {
      if (state.aborted) { finishSearch('Annulee.'); return; }
      const seg = preFiltered[i];
      const pct = 35 + Math.round(60 * (i + 1) / preFiltered.length);
      setProgress(pct, `Details ${i + 1}/${preFiltered.length} — ${seg.name}`);

      try {
        const detail = await getSegmentDetail(seg.id, token);
        state.allDetails[seg.id] = detail;
        await saveCacheEntry(seg.id, detail);
      } catch (err) {
        console.warn(`Erreur segment ${seg.id}:`, err.message);
      }
      cleanTimestamps();
      updateRateInfo(`${state.totalRequests} requetes | ${state.requestTimestamps.length}/${RATE_LIMIT.MAX_REQUESTS} dans la fenetre 15min`);
    }

    const results = applyFilters(preFiltered);
    state.segments = results;
    state.exploreSegments = preFiltered;

    // Update saved search
    await updateSavedSearch(searchId, {
      exploreSegments: preFiltered,
      filteredIds: results.map(s => s.id),
      createdAt: Date.now()
    });

    results.forEach(seg => addSegmentToMap(seg));
    renderResults(results);
    if (results.length > 0) fitMapToSegments(results);

    finishSearch(`${results.length} segment(s) — recherche rafraichie`);

  } catch (err) {
    finishSearch(`Erreur: ${err.message}`);
    console.error(err);
  }
}

// ── Last search (just params, for fresh page) ────────────────────────────────
function loadLastSearch() {
  chrome.storage.local.get(STORAGE_KEYS.LAST_SEARCH, (data) => {
    const last = data[STORAGE_KEYS.LAST_SEARCH];
    if (!last) return;

    // If we have a currentSearchId from a saved search, restore it
    if (last.currentSearchId) {
      const exists = state.savedSearches.find(s => s.id === last.currentSearchId);
      if (exists) {
        restoreSavedSearch(last.currentSearchId);
        return;
      }
    }

    // Otherwise just restore params
    if (last.center) {
      setCenter(last.center.lat, last.center.lng);
      state.map.setView([last.center.lat, last.center.lng], 13);
      mapHint.classList.add('hidden');
    }
    if (last.radius) {
      state.radius = last.radius;
      radiusSlider.value = last.radius;
      radiusValue.textContent = `${last.radius} km`;
      updateCircle();
    }
    if (last.filters) {
      if (last.filters.distMin) distMin.value = last.filters.distMin;
      if (last.filters.distMax) distMax.value = last.filters.distMax;
      if (last.filters.paceMin) paceMin.value = last.filters.paceMin;
      if (last.filters.paceMax) paceMax.value = last.filters.paceMax;
      if (last.filters.elevMin) elevMin.value = last.filters.elevMin;
      if (last.filters.elevMax) elevMax.value = last.filters.elevMax;
      if (last.filters.gradeMin) gradeMin.value = last.filters.gradeMin;
      if (last.filters.gradeMax) gradeMax.value = last.filters.gradeMax;
      if (last.filters.activityType) activityType.value = last.filters.activityType;
    }
  });
}

function saveLastSearch() {
  chrome.storage.local.set({
    [STORAGE_KEYS.LAST_SEARCH]: {
      center: state.center,
      radius: state.radius,
      currentSearchId: state.currentSearchId,
      filters: {
        distMin: distMin.value, distMax: distMax.value,
        paceMin: paceMin.value, paceMax: paceMax.value,
        elevMin: elevMin.value, elevMax: elevMax.value,
        gradeMin: gradeMin.value, gradeMax: gradeMax.value,
        activityType: activityType.value
      }
    }
  });
}

// ── Rate limiter ─────────────────────────────────────────────────────────────
function cleanTimestamps() {
  const cutoff = Date.now() - RATE_LIMIT.WINDOW_MS;
  state.requestTimestamps = state.requestTimestamps.filter(t => t > cutoff);
}

async function waitForSlot() {
  while (true) {
    if (state.aborted) return;
    cleanTimestamps();
    if (state.requestTimestamps.length < RATE_LIMIT.MAX_REQUESTS) {
      state.requestTimestamps.push(Date.now());
      state.totalRequests++;
      return;
    }
    const oldest = state.requestTimestamps[0];
    const waitMs = oldest + RATE_LIMIT.WINDOW_MS - Date.now() + 200;
    const waitSec = Math.ceil(waitMs / 1000);
    const min = Math.floor(waitSec / 60);
    const sec = waitSec % 60;
    const timeStr = min > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
    updateRateInfo(`Pause rate limit — reprise dans ${timeStr} (${state.totalRequests} requetes faites)`);
    await sleep(Math.min(waitMs, 3000));
  }
}

function updateRateInfo(text) { rateInfo.textContent = text; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API calls ────────────────────────────────────────────────────────────────
async function getToken() {
  const resp = await chrome.runtime.sendMessage({ action: 'getToken' });
  if (resp.error) throw new Error(resp.error);
  return resp.token;
}

async function apiFetch(path, token) {
  await waitForSlot();
  const resp = await fetch(`${STRAVA_API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (resp.status === 429) {
    updateRateInfo('Rate limit Strava (429). Pause 60s...');
    await sleep(60000);
    state.requestTimestamps = [];
    return apiFetch(path, token);
  }
  if (!resp.ok) throw new Error(`API ${resp.status}: ${path}`);
  return resp.json();
}

async function exploreSegments(bounds, type, token) {
  const bStr = boundsToString(bounds.sw, bounds.ne);
  return apiFetch(`/segments/explore?bounds=${bStr}&activity_type=${type}`, token);
}

async function getSegmentDetail(id, token) {
  return apiFetch(`/segments/${id}`, token);
}

// ── Cache ────────────────────────────────────────────────────────────────────
async function loadCache() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SEGMENTS_CACHE);
  const cache = data[STORAGE_KEYS.SEGMENTS_CACHE] || {};
  const now = Date.now();
  let pruned = false;
  for (const id of Object.keys(cache)) {
    if (now - cache[id].fetchedAt > CACHE_TTL_MS) {
      delete cache[id];
      pruned = true;
    }
  }
  if (pruned) await chrome.storage.local.set({ [STORAGE_KEYS.SEGMENTS_CACHE]: cache });
  return cache;
}

async function saveCacheEntry(id, detail) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SEGMENTS_CACHE);
  const cache = data[STORAGE_KEYS.SEGMENTS_CACHE] || {};
  cache[id] = { data: detail, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.SEGMENTS_CACHE]: cache });
}

// ── Search flow ──────────────────────────────────────────────────────────────
function zoneMatchesCurrent() {
  // Check if we already have explore data for the exact same zone
  if (!state.lastExploreZone || state.exploreSegments.length === 0) return false;
  const z = state.lastExploreZone;
  return z.lat === state.center.lat
    && z.lng === state.center.lng
    && z.radius === state.radius
    && z.type === activityType.value;
}

async function startSearch() {
  if (!state.center) {
    alert('Cliquez sur la carte pour definir le centre de recherche.');
    return;
  }

  const dmn = parseFloat(distMin.value);
  const dmx = parseFloat(distMax.value);
  if (isNaN(dmn) || isNaN(dmx) || dmn >= dmx) {
    alert('Renseignez un range de distance valide (min < max).');
    return;
  }

  state.searching = true;
  state.aborted = false;
  state.totalRequests = 0;
  searchBtn.style.display = 'none';
  stopBtn.style.display = '';
  progressDiv.style.display = '';
  resultsList.innerHTML = '';
  resultCount.textContent = '';
  clearSegmentsFromMap();

  try {
    const token = await getToken();
    const type = activityType.value;
    let rawSegments;

    // Phase 1: Explore — skip if same zone
    if (zoneMatchesCurrent()) {
      rawSegments = state.exploreSegments;
      setProgress(30, `Zone inchangee — ${rawSegments.length} segments en memoire, re-filtrage direct`);
    } else {
      setProgress(0, 'Exploration de la zone...');
      const bounds = centerRadiusToBounds(state.center.lat, state.center.lng, state.radius);
      rawSegments = await recursiveExplore(bounds, type, token);

      if (state.aborted) { finishSearch('Recherche annulee.'); return; }

      // Store the raw explore data (unfiltered) for reuse
      state.exploreSegments = rawSegments;
      state.lastExploreZone = {
        lat: state.center.lat,
        lng: state.center.lng,
        radius: state.radius,
        type
      };
    }

    // Pre-filter on distance + grade (data available from explore)
    const gMin = parseFloat(gradeMin.value);
    const gMax = parseFloat(gradeMax.value);
    const preFiltered = rawSegments.filter(s => {
      if (s.distance < dmn || s.distance > dmx) return false;
      if (!isNaN(gMin) && s.avg_grade < gMin) return false;
      if (!isNaN(gMax) && s.avg_grade > gMax) return false;
      return true;
    });

    const skipped = rawSegments.length - preFiltered.length;
    setProgress(30, `${preFiltered.length} segments a detailler (${skipped} exclus par filtres, ${rawSegments.length} dans la zone)`);

    if (preFiltered.length === 0) {
      finishSearch(`Aucun segment dans les filtres (${rawSegments.length} dans la zone, 0 apres filtres distance/pente).`);
      return;
    }

    // Phase 2: Fetch details — re-fetch if stale (> 2h)
    const cache = await loadCache();
    const now = Date.now();
    for (const [id, entry] of Object.entries(cache)) {
      state.allDetails[id] = entry.data;
    }

    const needFetch = preFiltered.filter(s => {
      const entry = cache[s.id];
      if (!entry) return true;                          // pas en cache
      if (now - entry.fetchedAt > DETAIL_FRESH_MS) return true;  // perime
      return false;
    });
    const fresh = preFiltered.length - needFetch.length;
    const stale = needFetch.filter(s => cache[s.id]).length;
    const missing = needFetch.length - stale;

    if (needFetch.length === 0) {
      setProgress(95, `${fresh} segments, tous frais — aucun appel`);
    } else {
      const parts = [];
      if (fresh > 0) parts.push(`${fresh} frais`);
      if (stale > 0) parts.push(`${stale} a rafraichir`);
      if (missing > 0) parts.push(`${missing} nouveaux`);
      setProgress(35, `Details: ${parts.join(', ')} — ${needFetch.length} appels`);
    }

    for (let i = 0; i < needFetch.length; i++) {
      if (state.aborted) { finishSearch('Recherche annulee.'); return; }

      const seg = needFetch[i];
      const pct = 35 + Math.round(60 * (i + 1) / needFetch.length);
      setProgress(pct, `Details ${i + 1}/${needFetch.length} — ${seg.name}`);

      try {
        const detail = await getSegmentDetail(seg.id, token);
        state.allDetails[seg.id] = detail;
        await saveCacheEntry(seg.id, detail);
      } catch (err) {
        console.warn(`Erreur segment ${seg.id}:`, err.message);
      }

      cleanTimestamps();
      updateRateInfo(`${state.totalRequests} requetes | ${state.requestTimestamps.length}/${RATE_LIMIT.MAX_REQUESTS} dans la fenetre 15min`);
    }

    // Phase 3: Apply all filters (including KOM pace, D+ from details) & save
    const results = applyFilters(preFiltered);
    state.segments = results;

    await saveCurrentSearch(rawSegments, results);
    saveLastSearch();

    results.forEach(seg => addSegmentToMap(seg));
    renderResults(results);

    if (results.length > 0) fitMapToSegments(results);

    savedList.style.display = '';
    savedArrow.classList.add('open');

    const msg = state.totalRequests === 0
      ? `${results.length} segment(s) — 0 requete (tout en cache)`
      : `${results.length} segment(s) trouve(s) — ${state.totalRequests} requetes`;
    finishSearch(msg);

  } catch (err) {
    finishSearch(`Erreur: ${err.message}`);
    console.error(err);
  }
}

async function recursiveExplore(bounds, type, token) {
  const allSegments = new Map();
  const queue = [bounds];
  let calls = 0;

  while (queue.length > 0 && !state.aborted && calls < RATE_LIMIT.MAX_EXPLORE_CALLS) {
    const box = queue.shift();
    calls++;

    setProgress(
      Math.min(25, Math.round(25 * calls / 40)),
      `Exploration cellule ${calls} (${allSegments.size} segments, ${queue.length} en attente)`
    );

    try {
      const result = await exploreSegments(box, type, token);
      const segments = result.segments || [];

      for (const seg of segments) {
        if (seg.start_latlng) {
          const dist = haversineKm(state.center.lat, state.center.lng, seg.start_latlng[0], seg.start_latlng[1]);
          if (dist <= state.radius) {
            allSegments.set(seg.id, seg);
          }
        }
      }

      if (segments.length >= 10) {
        const boxW = box.ne.lng - box.sw.lng;
        const boxH = box.ne.lat - box.sw.lat;
        if (boxW > 0.005 && boxH > 0.005) {
          queue.push(...subdivideBox(box.sw, box.ne));
        }
      }
    } catch (err) {
      console.warn('Explore error:', err.message);
    }

    cleanTimestamps();
    updateRateInfo(`${state.totalRequests} requetes | ${state.requestTimestamps.length}/${RATE_LIMIT.MAX_REQUESTS} dans la fenetre 15min`);
  }

  if (calls >= RATE_LIMIT.MAX_EXPLORE_CALLS) {
    updateRateInfo(`Exploration coupee a ${RATE_LIMIT.MAX_EXPLORE_CALLS} appels (zone dense).`);
  }

  return Array.from(allSegments.values());
}

function applyFilters(exploreSegs) {
  const pMin = parsePaceInput(paceMin.value);
  const pMax = parsePaceInput(paceMax.value);
  const eMin = parseFloat(elevMin.value);
  const eMax = parseFloat(elevMax.value);

  return exploreSegs.filter(seg => {
    const detail = state.allDetails[seg.id];
    if (!detail) return true;

    const elev = detail.total_elevation_gain;
    if (elev != null) {
      if (!isNaN(eMin) && elev < eMin) return false;
      if (!isNaN(eMax) && elev > eMax) return false;
    }

    const komTime = getKomSeconds(detail);
    if (komTime != null && seg.distance > 0) {
      const paceSecPerKm = komTime / (seg.distance / 1000);
      if (pMin != null && paceSecPerKm < pMin) return false;
      if (pMax != null && paceSecPerKm > pMax) return false;
    }

    return true;
  });
}

function parsePaceInput(val) {
  if (!val || !val.trim()) return null;
  const parts = val.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0] * 60;
  return null;
}

function getKomSeconds(detail) {
  if (!detail) return null;
  if (detail.xoms) {
    const komStr = detail.xoms.kom || detail.xoms.overall;
    const sec = parseTimeToSeconds(komStr);
    if (sec != null) return sec;
  }
  if (detail.athlete_segment_stats && detail.athlete_segment_stats.pr_elapsed_time) {
    return detail.athlete_segment_stats.pr_elapsed_time;
  }
  return null;
}

// ── Refresh single segment ───────────────────────────────────────────────────
async function refreshSingleSegment(segId) {
  const btn = document.querySelector(`.segment-card[data-id="${segId}"] .seg-refresh`);
  if (btn) btn.classList.add('spinning');

  try {
    const token = await getToken();
    const detail = await getSegmentDetail(segId, token);
    state.allDetails[segId] = detail;
    await saveCacheEntry(segId, detail);

    // Re-render just this card
    const card = document.querySelector(`.segment-card[data-id="${segId}"]`);
    const seg = state.segments.find(s => s.id === segId) || state.exploreSegments.find(s => s.id === segId);
    if (card && seg) {
      const newCard = buildSegmentCard(seg, detail);
      card.replaceWith(newCard);
    }
  } catch (err) {
    console.warn(`Refresh segment ${segId}:`, err.message);
  }

  if (btn) btn.classList.remove('spinning');
}

// ── Render results ───────────────────────────────────────────────────────────
function renderResults(segments) {
  const sorted = sortSegments([...segments]);
  resultCount.textContent = `(${sorted.length})`;
  resultsList.innerHTML = '';

  if (sorted.length === 0) {
    resultsList.innerHTML = '<div class="no-results">Aucun segment ne correspond aux filtres.</div>';
    return;
  }

  for (const seg of sorted) {
    const detail = state.allDetails[seg.id] || {};
    const card = buildSegmentCard(seg, detail);
    resultsList.appendChild(card);
  }
}

function buildSegmentCard(seg, detail) {
  const card = document.createElement('div');
  card.className = 'segment-card';
  card.dataset.id = seg.id;

  const dist = seg.distance >= 1000
    ? `${(seg.distance / 1000).toFixed(2)} km`
    : `${Math.round(seg.distance)} m`;

  const elev = detail.total_elevation_gain != null
    ? `${Math.round(detail.total_elevation_gain)} m`
    : `~${Math.round(seg.elev_difference || 0)} m`;

  const grade = seg.avg_grade != null ? `${seg.avg_grade.toFixed(1)}%` : '—';
  const efforts = detail.effort_count != null ? detail.effort_count.toLocaleString() : '—';
  const athletes = detail.athlete_count != null ? detail.athlete_count.toLocaleString() : '';

  const komSec = getKomSeconds(detail);
  const komTimeStr = komSec != null ? formatSeconds(komSec) : '—';
  const komPace = (komSec != null && seg.distance > 0)
    ? formatPace(komSec / (seg.distance / 1000))
    : '—';

  card.innerHTML = `
    <div class="seg-name">
      <span>${esc(seg.name)}</span>
      <span>
        <button class="seg-refresh" title="Rafraichir ce segment">&#8635;</button>
        <a href="https://www.strava.com/segments/${seg.id}" target="_blank" rel="noopener">Strava &rarr;</a>
      </span>
    </div>
    <div class="seg-stats">
      <div class="stat">Dist: <span class="stat-value">${dist}</span></div>
      <div class="stat">D+: <span class="stat-value">${elev}</span></div>
      <div class="stat">Pente: <span class="stat-value">${grade}</span></div>
      <div class="stat">Efforts: <span class="stat-value">${efforts}</span></div>
      ${athletes ? `<div class="stat">Athletes: <span class="stat-value">${athletes}</span></div>` : ''}
    </div>
    <div class="seg-kom">
      <span><span class="kom-label">KOM</span> <span class="kom-value">${komTimeStr}</span></span>
      <span><span class="kom-label">Allure</span> <span class="kom-value">${komPace}</span></span>
    </div>
  `;

  // Refresh single segment
  card.querySelector('.seg-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    refreshSingleSegment(seg.id);
  });

  // Click to highlight + zoom
  card.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' || e.target.closest('.seg-refresh')) return;
    highlightSegment(seg.id);
    if (state.polylines[seg.id]) {
      state.map.fitBounds(state.polylines[seg.id].getBounds(), { padding: [60, 60], maxZoom: 16 });
    }
  });

  // Hover highlight
  card.addEventListener('mouseenter', () => {
    if (state.activeSegmentId !== seg.id && state.polylines[seg.id]) {
      state.polylines[seg.id].setStyle({ color: '#e02000', weight: 5, opacity: 1 });
      state.polylines[seg.id].bringToFront();
    }
  });
  card.addEventListener('mouseleave', () => {
    if (state.activeSegmentId !== seg.id && state.polylines[seg.id]) {
      state.polylines[seg.id].setStyle({ color: '#FC4C02', weight: 3, opacity: 0.7 });
    }
  });

  return card;
}

function sortSegments(segments) {
  const field = sortBy.value;
  return segments.sort((a, b) => {
    const da = state.allDetails[a.id] || {};
    const db = state.allDetails[b.id] || {};
    switch (field) {
      case 'distance': return a.distance - b.distance;
      case 'elevation': return (da.total_elevation_gain || 0) - (db.total_elevation_gain || 0);
      case 'grade': return (a.avg_grade || 0) - (b.avg_grade || 0);
      case 'efforts': return (db.effort_count || 0) - (da.effort_count || 0);
      case 'name': return (a.name || '').localeCompare(b.name || '');
      case 'kom_pace': {
        const ka = getKomSeconds(da);
        const kb = getKomSeconds(db);
        const pa = (ka && a.distance > 0) ? ka / a.distance : Infinity;
        const pb = (kb && b.distance > 0) ? kb / b.distance : Infinity;
        return pa - pb;
      }
      default: return 0;
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function setProgress(pct, text) {
  progressFill.style.width = `${pct}%`;
  progressText.textContent = text;
}

function finishSearch(msg) {
  state.searching = false;
  searchBtn.style.display = '';
  stopBtn.style.display = 'none';
  setProgress(100, msg);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
