import { STRAVA_API_BASE, STORAGE_KEYS, SEGMENT_DEFAULTS, RATE_LIMIT } from '../lib/config.js';
import { centerRadiusToBounds, filterSegmentsByRadius, decodePolyline, parseTimeToSeconds, formatSeconds, formatPace, formatSpeed } from '../lib/geo.js';
import { computeAthleteProfile, feasibilityRatio, SPORT_CONFIG } from '../lib/gap.js';
import { fetchTileSegments } from '../lib/tiles.js';

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
  segMarkers: {},        // id → { start, end } direction markers
  activeSegmentId: null,
  hoveredSegmentId: null,
  pickMode: true,
  bgLayer: null,
  requestTimestamps: [],
  totalRequests: 0,
  currentSearchId: null,
  refilterToken: 0,      // bump on each liveRefilter start, older runs abort
  savedSearches: [],
  athleteProfile: null,    // GAP profile computed from activities
  sport: 'running'         // 'running' or 'riding'
};

// ── Storage wrappers (always async, never throw) ─────────────────────────────
async function storageGet(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (err) {
    console.error('[storage] get error:', err, keys);
    return {};
  }
}

async function storageSet(obj) {
  try {
    await chrome.storage.local.set(obj);
    return true;
  } catch (err) {
    console.error('[storage] set error:', err, Object.keys(obj));
    return false;
  }
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const centerLatInput = $('#centerLat');
const centerLngInput = $('#centerLng');
const radiusSlider = $('#radiusSlider');
const radiusValue = $('#radiusValue');
const sportRadios = document.querySelectorAll('input[name="sport"]');
const surfaceTypeSelect = document.querySelector('#surfaceType');
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
const feasibilityRow = $('#feasibilityRow');
const feasibilityInfo = $('#feasibilityInfo');
const feasPresetBtns = document.querySelectorAll('.feas-preset');
const feasibilityMinSlider = $('#feasibilityMin');
const feasibilityMaxSlider = $('#feasibilityMax');
const feasibilityValues = $('#feasibilityValues');
const speedFilterLabel = $('#speedFilterLabel');
const paceInputs = $('#paceInputs');
const speedInputs = $('#speedInputs');
const speedMin = $('#speedMin');
const speedMax = $('#speedMax');
const sortKomPaceOption = $('#sortKomPaceOption');
const addSegUrlInput = $('#addSegUrl');
const addSegBtn = $('#addSegBtn');
const addSegStatus = $('#addSegStatus');
const zonePickBtn = $('#zonePickBtn');
const mapEl = $('#map');

// ── Sport helpers ───────────────────────────────────────────────────────────
function getSport() { return state.sport; }

function getActivityType() {
  return state.sport === 'riding' ? 'riding' : 'running';
}

function setSport(sport, resetView = true) {
  if (resetView && sport !== state.sport) {
    // Different sport → clear current results, they belong to the old sport.
    // Also purge in-memory detail cache: a segment's KOM belongs to one sport,
    // keeping it across a sport switch leaks stale data into the new search.
    state.currentSearchId = null;
    state.segments = [];
    state.exploreSegments = [];
    state.allDetails = {};
    clearSegmentsFromMap();
    resultsList.innerHTML = '';
    resultCount.textContent = '';
    progressDiv.style.display = 'none';
  }
  state.sport = sport;
  document.querySelector(`input[name="sport"][value="${sport}"]`).checked = true;
  updateSportUI();
  loadAthleteProfile();
}

function updateSportUI() {
  const isRunning = state.sport === 'running';
  // Filter label + inputs
  speedFilterLabel.textContent = isRunning ? 'Allure KOM (min/km)' : 'Vitesse KOM (km/h)';
  paceInputs.style.display = isRunning ? '' : 'none';
  speedInputs.style.display = isRunning ? 'none' : '';
  // Sort option
  sortKomPaceOption.textContent = isRunning ? 'Allure KOM' : 'Vitesse KOM';
}

// ── Map backgrounds ──────────────────────────────────────────────────────────
const MAP_BACKGROUNDS = {
  voyager: {
    name: 'CARTO Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxZoom: 20, attribution: '&copy; OSM &copy; CARTO' }
  },
  osm: {
    name: 'OSM Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }
  },
  opentopo: {
    name: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { subdomains: 'abc', maxZoom: 17, attribution: '&copy; OpenTopoMap (CC-BY-SA)' }
  },
  cyclosm: {
    name: 'CyclOSM',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    options: { subdomains: 'abc', maxZoom: 20, attribution: '&copy; CyclOSM &copy; OSM France' }
  }
};

const BG_STORAGE_KEY = 'explorer_map_bg';

// ── Init ─────────────────────────────────────────────────────────────────────
initMap();
initEvents();
initGeocode();
loadStatus();
loadAthleteProfile();
(async () => {
  await loadSavedSearches();
  await loadLastSearch();
})();

// ── Map ──────────────────────────────────────────────────────────────────────
function initMap() {
  L.Icon.Default.imagePath = '../vendor/images/';

  state.map = L.map('map', { zoomControl: true }).setView(
    [SEGMENT_DEFAULTS.CENTER.lat, SEGMENT_DEFAULTS.CENTER.lng], 13
  );

  // Restore saved background (default: voyager)
  storageGet(BG_STORAGE_KEY).then((data) => {
    const key = data[BG_STORAGE_KEY] || 'voyager';
    setMapBackground(key);
    const select = document.querySelector('#mapBgSelect');
    if (select) select.value = key;
  });

  state.map.on('click', (e) => {
    if (state.pickMode) {
      setCenter(e.latlng.lat, e.latlng.lng);
      mapHint.classList.add('hidden');
    } else {
      unhighlightAll();
    }
  });

  // Persist map view on move/zoom (debounced)
  let viewSaveTimer = null;
  state.map.on('moveend zoomend', () => {
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => saveMapView(), 300);
  });

  // Start in pick mode with crosshair
  mapEl.classList.add('pick-mode');
}

function setMapBackground(key) {
  const bg = MAP_BACKGROUNDS[key] || MAP_BACKGROUNDS.voyager;
  if (state.bgLayer) state.map.removeLayer(state.bgLayer);
  state.bgLayer = L.tileLayer(bg.url, bg.options).addTo(state.map);
  state.bgLayer.bringToBack();
  storageSet({ [BG_STORAGE_KEY]: key });
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
  Object.values(state.segMarkers).forEach(m => {
    state.map.removeLayer(m.start);
    state.map.removeLayer(m.end);
  });
  state.segMarkers = {};
}

function addSegmentToMap(seg) {
  // Prefer detail polyline (full, unclipped) over tile geometry (clipped to tile boundary)
  const detail = state.allDetails[seg.id];
  const detailPoly = detail && detail.map && detail.map.polyline;
  const points = detailPoly ? decodePolyline(detailPoly) : (seg._decodedPoints || (seg.points ? decodePolyline(seg.points) : null));
  if (!points || points.length < 2) return;

  const userKom = isUserKom(detail);
  const baseColor = userKom ? '#f59e0b' : '#FC4C02';

  const pl = L.polyline(points, {
    color: baseColor,
    weight: userKom ? 4 : 3,
    opacity: userKom ? 0.9 : 0.7
  }).addTo(state.map);

  pl.on('click', () => highlightSegment(seg.id));
  pl.on('mouseover', () => hoverSegment(seg.id));
  pl.on('mouseout', () => unhoverSegment(seg.id));
  // Build tooltip with name + feasibility ratio
  let tooltipText = (userKom ? '\u{1F451} ' : '') + seg.name;
  if (state.athleteProfile) {
    const komSec = getKomSeconds(detail);
    if (komSec != null && seg.distance > 0) {
      const ratio = feasibilityRatio(komSec, seg.distance, seg.avg_grade || 0, state.athleteProfile, getSport());
      if (ratio != null) {
        const label = ratio < 0.9 ? 'Battable' : ratio < 1.1 ? 'Realiste' : ratio < 1.2 ? 'Ambitieux' : 'Hors portee';
        tooltipText += ` — ${ratio.toFixed(2)} (${label})`;
      }
    }
  }
  pl.bindTooltip(tooltipText, { sticky: true });

  state.polylines[seg.id] = pl;

  // Direction markers (hidden by default, shown on focus/highlight)
  const startPt = points[0];
  const endPt = points[points.length - 1];

  const startMarker = L.circleMarker(startPt, {
    radius: 5, color: '#fff', fillColor: '#22c55e', fillOpacity: 1, weight: 2
  });

  const endIcon = L.divIcon({
    className: 'seg-end-marker',
    iconSize: [12, 12],
    iconAnchor: [6, 6]
  });
  const endMarker = L.marker(endPt, { icon: endIcon, interactive: false });

  state.segMarkers[seg.id] = { start: startMarker, end: endMarker };
}

function getSegmentBaseStyle(segId) {
  const detail = state.allDetails[segId];
  const userKom = isUserKom(detail);
  return userKom
    ? { color: '#f59e0b', weight: 4, opacity: 0.9 }
    : { color: '#FC4C02', weight: 3, opacity: 0.7 };
}

/** Hover a segment: clean up previous hover, then focus this one. */
function hoverSegment(id) {
  if (state.hoveredSegmentId === id) return;
  if (state.activeSegmentId === id) return;

  // Clean up previous hover if any
  if (state.hoveredSegmentId && state.hoveredSegmentId !== state.activeSegmentId) {
    clearFocus(state.hoveredSegmentId);
  }

  state.hoveredSegmentId = id;
  applyFocus(id);

  const card = document.querySelector(`.segment-card[data-id="${id}"]`);
  if (card) card.classList.add('hover');
}

/** Unhover a segment: only act if it's the currently hovered one. */
function unhoverSegment(id) {
  if (state.hoveredSegmentId !== id) return;

  state.hoveredSegmentId = null;

  if (id !== state.activeSegmentId) {
    clearFocus(id);
  }

  const card = document.querySelector(`.segment-card[data-id="${id}"]`);
  if (card) card.classList.remove('hover');
}

/** Visually focus a segment: bolden it, dim others, show markers. */
function applyFocus(id) {
  const hoverColor = isUserKom(state.allDetails[id]) ? '#d97706' : '#e02000';
  for (const [segId, pl] of Object.entries(state.polylines)) {
    if (segId == id) {
      pl.setStyle({ color: hoverColor, weight: 5, opacity: 1 });
      pl.bringToFront();
    } else if (segId != state.activeSegmentId) {
      const style = getSegmentBaseStyle(segId);
      style.opacity = 0.3;
      pl.setStyle(style);
    }
  }
  if (state.segMarkers[id]) {
    state.segMarkers[id].start.addTo(state.map);
    state.segMarkers[id].end.addTo(state.map);
  }
}

/** Remove focus from a segment: hide markers, restore base styles. */
function clearFocus(id) {
  if (state.segMarkers[id]) {
    state.segMarkers[id].start.remove();
    state.segMarkers[id].end.remove();
  }
  // Restore all non-active, non-hovered segments
  for (const [segId, pl] of Object.entries(state.polylines)) {
    if (segId == state.activeSegmentId) continue;
    const style = getSegmentBaseStyle(segId);
    if (state.activeSegmentId != null) style.opacity = 0.3;
    pl.setStyle(style);
  }
}

/** Pin a segment as active (click). */
function highlightSegment(id) {
  const prevId = state.activeSegmentId;

  // Clean up previous active
  if (prevId && prevId !== id) {
    clearFocus(prevId);
  }

  document.querySelectorAll('.segment-card.active').forEach(el => el.classList.remove('active'));
  state.activeSegmentId = id;
  state.hoveredSegmentId = null;

  applyFocus(id);

  const card = document.querySelector(`.segment-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function unhighlightAll() {
  const ids = [state.activeSegmentId, state.hoveredSegmentId].filter(Boolean);
  for (const id of ids) {
    if (state.segMarkers[id]) {
      state.segMarkers[id].start.remove();
      state.segMarkers[id].end.remove();
    }
  }
  state.activeSegmentId = null;
  state.hoveredSegmentId = null;
  document.querySelectorAll('.segment-card.active, .segment-card.hover').forEach(el => {
    el.classList.remove('active', 'hover');
  });
  for (const [segId, pl] of Object.entries(state.polylines)) {
    pl.setStyle(getSegmentBaseStyle(segId));
  }
}

function fitMapToSegments(segments) {
  const allPoints = segments.flatMap(s => {
    const d = state.allDetails[s.id];
    const dp = d && d.map && d.map.polyline;
    if (dp) return decodePolyline(dp);
    if (s._decodedPoints) return s._decodedPoints;
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

  // Zone pick mode toggle
  zonePickBtn.addEventListener('click', togglePickMode);

  searchBtn.addEventListener('click', startSearch);
  stopBtn.addEventListener('click', () => { state.aborted = true; });
  addSegBtn.addEventListener('click', addSegmentByUrl);
  addSegUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSegmentByUrl();
  });
  sortBy.addEventListener('change', () => { renderResults(state.segments); persistCurrentFilters(); });

  // Sport toggle
  sportRadios.forEach(r => r.addEventListener('change', (e) => {
    setSport(e.target.value);
  }));

  // Live filter inputs → refilter on input (debounced) and on change (instant on blur)
  const refilterInputs = [distMin, distMax, paceMin, paceMax, speedMin, speedMax,
    elevMin, elevMax, gradeMin, gradeMax];
  let refilterTimer = null;
  const debouncedRefilter = () => {
    clearTimeout(refilterTimer);
    refilterTimer = setTimeout(liveRefilter, 300);
  };
  refilterInputs.forEach(el => {
    el.addEventListener('input', debouncedRefilter);
    el.addEventListener('change', liveRefilter);
  });

  // Feasibility preset toggles → adjust slider + refilter
  feasPresetBtns.forEach(btn => btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    applyPresetsToSlider();
    liveRefilter();
  }));

  // Slider manual drag → deactivate presets + refilter
  feasibilityMinSlider.addEventListener('input', () => { onSliderManualChange(); liveRefilter(); });
  feasibilityMaxSlider.addEventListener('input', () => { onSliderManualChange(); liveRefilter(); });

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

  $('#settingsBtn').addEventListener('click', () => {
    $('#settingsModal').style.display = '';
    updateCacheStats();
  });
  $('#mapBgSelect').addEventListener('change', (e) => setMapBackground(e.target.value));
  $('#modalClose').addEventListener('click', () => $('#settingsModal').style.display = 'none');
  $('#modalClearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearSegmentsCache' });
    state.allDetails = {};
    rateInfo.textContent = 'Cache vide.';
    updateCacheStats();
  });
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) $('#settingsModal').style.display = 'none';
  });
}

async function updateCacheStats() {
  const el = $('#cacheStats');
  if (!el) return;
  try {
    const data = await storageGet([
      STORAGE_KEYS.SEGMENTS_CACHE,
      STORAGE_KEYS.SAVED_SEARCHES
    ]);
    const cache = data[STORAGE_KEYS.SEGMENTS_CACHE] || {};
    const searches = data[STORAGE_KEYS.SAVED_SEARCHES] || [];
    const cacheCount = Object.keys(cache).length;
    const cacheSize = new Blob([JSON.stringify(cache)]).size;
    const searchesSize = new Blob([JSON.stringify(searches)]).size;
    const totalKb = ((cacheSize + searchesSize) / 1024).toFixed(1);
    const cacheKb = (cacheSize / 1024).toFixed(1);
    const searchesKb = (searchesSize / 1024).toFixed(1);
    el.innerHTML = `
      <strong>Cache segments:</strong> ${cacheCount} entrees, ${cacheKb} Ko<br>
      <strong>Recherches sauvegardees:</strong> ${searches.length}, ${searchesKb} Ko<br>
      <strong>Total storage:</strong> ${totalKb} Ko / ~10240 Ko
    `;
  } catch (err) {
    el.textContent = 'Erreur lecture cache: ' + err.message;
  }
}

function applyCenterFromInputs() {
  const lat = parseFloat(centerLatInput.value);
  const lng = parseFloat(centerLngInput.value);
  if (!isNaN(lat) && !isNaN(lng)) setCenter(lat, lng);
}

function togglePickMode() {
  state.pickMode = !state.pickMode;
  zonePickBtn.classList.toggle('active', state.pickMode);
  mapEl.classList.toggle('pick-mode', state.pickMode);
  mapHint.classList.toggle('hidden', !state.pickMode || state.center != null);
}

// ── Feasibility presets + slider ─────────────────────────────────────────────
const FEAS_RANGES = {
  battable:  { min: 0.50, max: 0.9 },
  realiste:  { min: 0.9, max: 1.1 },
  ambitieux: { min: 1.1, max: 1.2 }
};

function getActiveFeasPresets() {
  return Array.from(feasPresetBtns)
    .filter(b => b.classList.contains('active'))
    .map(b => b.dataset.feas);
}

function setActiveFeasPresets(presets) {
  feasPresetBtns.forEach(b => {
    b.classList.toggle('active', presets.includes(b.dataset.feas));
  });
  applyPresetsToSlider();
}

/** When presets change, compute the merged range and set the slider. */
function applyPresetsToSlider() {
  const active = getActiveFeasPresets();
  if (active.length === 0) {
    // No preset → full range
    feasibilityMinSlider.value = 0.5;
    feasibilityMaxSlider.value = 1.5;
  } else {
    const lo = Math.min(...active.map(p => FEAS_RANGES[p].min));
    const hi = Math.max(...active.map(p => FEAS_RANGES[p].max));
    feasibilityMinSlider.value = lo;
    feasibilityMaxSlider.value = hi;
  }
  updateSliderLabel();
}

/** When slider is dragged manually, deactivate presets and update label. */
function onSliderManualChange() {
  let lo = parseFloat(feasibilityMinSlider.value);
  let hi = parseFloat(feasibilityMaxSlider.value);
  if (lo > hi) {
    feasibilityMinSlider.value = hi;
    feasibilityMaxSlider.value = lo;
  }
  // Deactivate presets — user is in manual mode
  feasPresetBtns.forEach(b => b.classList.remove('active'));
  updateSliderLabel();
}

function updateSliderLabel() {
  const lo = parseFloat(feasibilityMinSlider.value);
  const hi = parseFloat(feasibilityMaxSlider.value);
  feasibilityValues.textContent = `${lo.toFixed(2)} — ${hi.toFixed(2)}`;
}

// ── Athlete profile ─────────────────────────────────────────────────────────
async function loadAthleteProfile() {
  const sport = getSport();
  const cfg = SPORT_CONFIG[sport];
  const sportLabel = sport === 'running' ? 'courses' : 'sorties velo';

  try {
    const data = await storageGet(STORAGE_KEYS.ACTIVITIES);
    const activities = data[STORAGE_KEYS.ACTIVITIES];
    if (!activities || activities.length === 0) {
      feasibilityRow.classList.add('disabled');
      feasibilityInfo.textContent = 'Synchronisez vos activites dans le Dashboard pour activer ce filtre.';
      state.athleteProfile = null;
      return;
    }

    state.athleteProfile = computeAthleteProfile(activities, sport);

    if (!state.athleteProfile) {
      feasibilityRow.classList.add('disabled');
      feasibilityInfo.textContent = `Pas assez de ${sportLabel} pour calculer votre profil.`;
      return;
    }

    feasibilityRow.classList.remove('disabled');
    feasibilityInfo.textContent = '';
  } catch (err) {
    console.warn('Athlete profile error:', err);
    feasibilityRow.classList.add('disabled');
    feasibilityInfo.textContent = 'Erreur de chargement du profil.';
    state.athleteProfile = null;
  }
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
  const data = await storageGet(STORAGE_KEYS.SAVED_SEARCHES);
  state.savedSearches = data[STORAGE_KEYS.SAVED_SEARCHES] || [];
  renderSavedSearches();
}

async function persistSavedSearches() {
  // Strip heavy tile geometry before persisting (use detail polyline for display instead)
  const stripped = state.savedSearches.map(s => ({
    ...s,
    exploreSegments: (s.exploreSegments || []).map(seg => {
      const { _decodedPoints, ...rest } = seg;
      return rest;
    })
  }));
  await storageSet({ [STORAGE_KEYS.SAVED_SEARCHES]: stripped });
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
  const sport = getSport();
  return {
    center: state.center ? { ...state.center } : null,
    radius: state.radius,
    sport,
    activityType: getActivityType(),
    surface: surfaceTypeSelect.value,
    distMin: distMin.value,
    distMax: distMax.value,
    paceMin: sport === 'running' ? paceMin.value : '',
    paceMax: sport === 'running' ? paceMax.value : '',
    speedMin: sport === 'riding' ? speedMin.value : '',
    speedMax: sport === 'riding' ? speedMax.value : '',
    elevMin: elevMin.value,
    elevMax: elevMax.value,
    gradeMin: gradeMin.value,
    gradeMax: gradeMax.value,
    feasPresets: getActiveFeasPresets(),
    feasibilityMin: feasibilityMinSlider.value,
    feasibilityMax: feasibilityMaxSlider.value,
    sortBy: sortBy.value
  };
}

function applyParams(params) {
  if (params.center) {
    setCenter(params.center.lat, params.center.lng);
    if (!params._skipMapView) {
      state.map.setView([params.center.lat, params.center.lng], 13);
    }
    mapHint.classList.add('hidden');
  }
  if (params.radius) {
    state.radius = params.radius;
    radiusSlider.value = params.radius;
    radiusValue.textContent = `${params.radius} km`;
    updateCircle();
  }
  if (params.sport) setSport(params.sport, false);
  if (params.surface != null) surfaceTypeSelect.value = params.surface;
  if (params.distMin) distMin.value = params.distMin;
  if (params.distMax) distMax.value = params.distMax;
  paceMin.value = params.paceMin || '';
  paceMax.value = params.paceMax || '';
  speedMin.value = params.speedMin || '';
  speedMax.value = params.speedMax || '';
  elevMin.value = params.elevMin || '';
  elevMax.value = params.elevMax || '';
  gradeMin.value = params.gradeMin || '';
  gradeMax.value = params.gradeMax || '';
  if (params.feasPresets && params.feasPresets.length > 0) {
    setActiveFeasPresets(params.feasPresets);
  } else {
    setActiveFeasPresets([]);
  }
  if (params.sortBy) sortBy.value = params.sortBy;
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

    const isRiding = (search.params && search.params.sport === 'riding') || (search.params && search.params.activityType === 'riding');
    const sportIcon = isRiding ? '\u{1F6B4}' : '\u{1F3C3}';

    item.innerHTML = `
      <span class="saved-sport">${sportIcon}</span>
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
async function restoreSavedSearch(searchId, preserveMapView) {
  const search = state.savedSearches.find(s => s.id === searchId);
  if (!search) return;

  // Flush any pending debounced filter save before switching — otherwise the
  // previous search keeps the filter state of the one we're restoring into.
  if (state.currentSearchId && state.currentSearchId !== searchId) {
    await persistCurrentFilters();
  }

  // Block liveRefilter while we mutate exploreSegments/allDetails in bulk.
  state.searching = true;
  try {
    // Switch sport mode to match the saved search
    // Fallback: old searches without sport field → derive from activityType
    const savedSport = (search.params && search.params.sport)
      || (search.params && search.params.activityType === 'riding' ? 'riding' : 'running');
    setSport(savedSport, false);

    state.currentSearchId = searchId;
    const paramsToApply = preserveMapView
      ? { ...search.params, _skipMapView: true }
      : search.params;
    applyParams(paramsToApply);
    if (preserveMapView) {
      state.map.setView([preserveMapView.lat, preserveMapView.lng], preserveMapView.zoom);
    }

    // Load detail cache into memory
    const cache = await loadCache();
    for (const [id, entry] of Object.entries(cache)) {
      state.allDetails[id] = entry.data;
    }

    // Restore explore segments
    state.exploreSegments = search.exploreSegments || [];

    // Re-apply filters (using stored explore data + current detail cache)
    const filtered = applyFilters(state.exploreSegments);
    state.segments = filtered;

    // Update filtered IDs in saved search (in case cache updated details)
    search.filteredIds = filtered.map(s => s.id);
    await persistSavedSearches();

    renderSegmentList(filtered);
    renderSavedSearches();

    if (filtered.length > 0 && !preserveMapView) fitMapToSegments(filtered);

    progressDiv.style.display = '';
    setProgress(100, `${filtered.length} segment(s) — recherche restauree`);
  } finally {
    state.searching = false;
  }
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
    const radius = search.params.radius || 3;
    const bounds = centerRadiusToBounds(search.params.center.lat, search.params.center.lng, radius);
    const searchSport = search.params.sport || (search.params.activityType === 'riding' ? 'riding' : 'running');

    setProgress(0, 'Re-exploration via tiles...');
    const tileResult = await fetchTileSegments(bounds, searchSport, radius, null, search.params.surface || '0');
    if (tileResult.stats.auth > 0 && tileResult.segments.length === 0) {
      finishSearch('');
      showStravaLoginWarning(await buildTileAuthMessage(tileResult.stats));
      return;
    }
    const allTileSegs = tileResult.segments;
    if (state.aborted) { finishSearch('Annulee.'); return; }

    const center = search.params.center;
    const tileSegments = filterSegmentsByRadius(allTileSegs, center.lat, center.lng, radius);

    const merged = mergeSegments(state.exploreSegments, tileSegments);
    state.exploreSegments = merged;

    setProgress(15, `${merged.length} segments (${tileSegments.length} via tiles)`);

    // Fetch details — force re-fetch all
    for (let i = 0; i < merged.length; i++) {
      if (state.aborted) { finishSearch('Annulee.'); return; }
      const seg = merged[i];
      const pct = 35 + Math.round(60 * (i + 1) / merged.length);
      setProgress(pct, `Details ${i + 1}/${merged.length} — ${seg.name}`);

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

    const results = applyFilters(merged);
    state.segments = results;

    // Update saved search
    await updateSavedSearch(searchId, {
      exploreSegments: merged,
      filteredIds: results.map(s => s.id),
      createdAt: Date.now()
    });

    renderSegmentList(results);
    if (results.length > 0) fitMapToSegments(results);

    finishSearch(`${results.length} segment(s) — recherche rafraichie`);

  } catch (err) {
    finishSearch(`Erreur: ${err.message}`);
    console.error(err);
  }
}

// ── Last search (just params, for fresh page) ────────────────────────────────
async function loadLastSearch() {
  const data = await storageGet(STORAGE_KEYS.LAST_SEARCH);
  const last = data[STORAGE_KEYS.LAST_SEARCH];
  if (!last) return;

  // If we have a currentSearchId from a saved search, restore it
  if (last.currentSearchId) {
    const exists = state.savedSearches.find(s => s.id === last.currentSearchId);
    if (exists) {
      await restoreSavedSearch(last.currentSearchId, last.mapView);
      return;
    }
  }

  // Otherwise just restore params
  if (last.sport) setSport(last.sport, false);
  if (last.surface != null) surfaceTypeSelect.value = last.surface;
  if (last.center) {
    setCenter(last.center.lat, last.center.lng);
    if (last.mapView) {
      state.map.setView([last.mapView.lat, last.mapView.lng], last.mapView.zoom);
    } else {
      state.map.setView([last.center.lat, last.center.lng], 13);
    }
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
    if (last.filters.speedMin) speedMin.value = last.filters.speedMin;
    if (last.filters.speedMax) speedMax.value = last.filters.speedMax;
    if (last.filters.elevMin) elevMin.value = last.filters.elevMin;
    if (last.filters.elevMax) elevMax.value = last.filters.elevMax;
    if (last.filters.gradeMin) gradeMin.value = last.filters.gradeMin;
    if (last.filters.gradeMax) gradeMax.value = last.filters.gradeMax;
    if (last.filters.feasPresets && last.filters.feasPresets.length > 0) {
      setActiveFeasPresets(last.filters.feasPresets);
    } else {
      setActiveFeasPresets([]);
    }
    if (last.filters.sortBy) sortBy.value = last.filters.sortBy;
  }
}

async function saveMapView() {
  if (!state.map) return;
  const c = state.map.getCenter();
  const z = state.map.getZoom();
  const data = await storageGet(STORAGE_KEYS.LAST_SEARCH);
  const last = data[STORAGE_KEYS.LAST_SEARCH] || {};
  last.mapView = { lat: c.lat, lng: c.lng, zoom: z };
  await storageSet({ [STORAGE_KEYS.LAST_SEARCH]: last });
}

async function saveLastSearch() {
  const view = state.map ? (() => {
    const c = state.map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: state.map.getZoom() };
  })() : null;
  await storageSet({
    [STORAGE_KEYS.LAST_SEARCH]: {
      center: state.center,
      radius: state.radius,
      currentSearchId: state.currentSearchId,
      sport: getSport(),
      surface: surfaceTypeSelect.value,
      mapView: view,
      filters: {
        distMin: distMin.value, distMax: distMax.value,
        paceMin: paceMin.value, paceMax: paceMax.value,
        speedMin: speedMin.value, speedMax: speedMax.value,
        elevMin: elevMin.value, elevMax: elevMax.value,
        gradeMin: gradeMin.value, gradeMax: gradeMax.value,
        feasPresets: getActiveFeasPresets(),
        feasibilityMin: feasibilityMinSlider.value,
        feasibilityMax: feasibilityMaxSlider.value,
        sortBy: sortBy.value
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

const MAX_429_RETRIES = 4;   // 60s, 120s, 240s, 480s (cap ~8min)

async function apiFetch(path, token) {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    if (state.aborted) throw new Error('aborted');
    await waitForSlot();
    const resp = await fetch(`${STRAVA_API_BASE}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (resp.status !== 429) {
      if (!resp.ok) throw new Error(`API ${resp.status}: ${path}`);
      return resp.json();
    }
    if (attempt === MAX_429_RETRIES) {
      throw new Error(`API 429 (rate limit Strava) — abandon apres ${MAX_429_RETRIES + 1} tentatives`);
    }
    const waitMs = 60000 * Math.pow(2, attempt);
    const waitSec = Math.round(waitMs / 1000);
    updateRateInfo(`Rate limit Strava (429). Pause ${waitSec}s (tentative ${attempt + 2}/${MAX_429_RETRIES + 1})...`);
    await sleep(waitMs);
    state.requestTimestamps = [];
  }
  throw new Error('apiFetch: unreachable');
}

async function getSegmentDetail(id, token) {
  return apiFetch(`/segments/${id}`, token);
}

// ── Cache ────────────────────────────────────────────────────────────────────
async function loadCache() {
  const data = await storageGet(STORAGE_KEYS.SEGMENTS_CACHE);
  return data[STORAGE_KEYS.SEGMENTS_CACHE] || {};
}

async function saveCacheEntry(id, detail) {
  const data = await storageGet(STORAGE_KEYS.SEGMENTS_CACHE);
  const cache = data[STORAGE_KEYS.SEGMENTS_CACHE] || {};
  cache[id] = { data: detail, fetchedAt: Date.now() };
  await storageSet({ [STORAGE_KEYS.SEGMENTS_CACHE]: cache });
}

// ── Search flow ──────────────────────────────────────────────────────────────

/** Merge new segments into existing set — never lose previously found segments. */
function mergeSegments(existing, fresh) {
  const map = new Map();
  for (const seg of existing) map.set(seg.id, seg);
  for (const seg of fresh) map.set(seg.id, seg); // fresh data wins on duplicates
  return Array.from(map.values());
}

/**
 * Is a Strava session cookie present in this browser profile?
 *  true  — cookie exists (user has a session somewhere in this profile)
 *  false — no cookie (not logged in)
 *  null  — lookup failed (permission missing or API error)
 */
async function hasStravaSessionCookie() {
  if (!chrome.cookies || !chrome.cookies.get) return null;
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://www.strava.com',
      name: '_strava4_session'
    });
    return !!cookie;
  } catch (err) {
    console.warn('chrome.cookies lookup failed:', err.message);
    return null;
  }
}

function showStravaLoginWarning(messageHtml) {
  const html = messageHtml || `Connexion a <a href="https://www.strava.com/login" target="_blank" rel="noopener">strava.com</a> requise dans ce navigateur pour la decouverte de segments.`;
  const fullHtml = `⚠ ${html}`;
  let banner = document.getElementById('stravaLoginBanner');
  if (banner) {
    const span = banner.querySelector('.banner-msg');
    if (span) span.innerHTML = fullHtml;
    return;
  }
  banner = document.createElement('div');
  banner.id = 'stravaLoginBanner';
  banner.className = 'strava-login-banner';
  banner.innerHTML = `
    <span class="banner-msg">${fullHtml}</span>
    <button class="close-btn" title="Fermer">&times;</button>
  `;
  banner.querySelector('.close-btn').addEventListener('click', () => banner.remove());
  document.body.prepend(banner);
}

/** Extract segment ID from a Strava URL or raw ID. */
function extractSegmentId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const match = trimmed.match(/segments\/(\d+)/);
  if (match) return parseInt(match[1], 10);
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return null;
}

/** Fetch a segment by URL/ID and add it to the current results. */
async function addSegmentByUrl() {
  const segId = extractSegmentId(addSegUrlInput.value);
  if (!segId) {
    addSegStatus.textContent = 'URL ou ID invalide.';
    return;
  }

  // Already in results?
  if (state.exploreSegments.find(s => s.id === segId)) {
    addSegStatus.textContent = `Segment ${segId} deja present.`;
    return;
  }

  addSegBtn.disabled = true;
  addSegStatus.textContent = `Chargement du segment ${segId}...`;
  state.searching = true;

  try {
    const token = await getToken();
    const detail = await getSegmentDetail(segId, token);
    if (!detail || !detail.distance) {
      addSegStatus.textContent = 'Segment introuvable ou invalide.';
      return;
    }

    state.allDetails[segId] = detail;
    await saveCacheEntry(segId, detail);

    // Build an explore-like segment object from detail
    const seg = {
      id: detail.id,
      name: detail.name,
      distance: detail.distance,
      avg_grade: detail.average_grade,
      elev_difference: detail.total_elevation_gain,
      start_latlng: detail.start_latlng,
      end_latlng: detail.end_latlng,
      points: detail.map && detail.map.polyline
    };

    state.exploreSegments = mergeSegments(state.exploreSegments, [seg]);

    // Re-filter + render
    const results = applyFilters(state.exploreSegments);
    state.segments = results;
    renderSegmentList(results);
    state.searching = false;   // unlock before persist so persistCurrentFilters can run nested
    await persistCurrentFilters();

    // Update saved search exploreSegments if active
    if (state.currentSearchId) {
      await updateSavedSearch(state.currentSearchId, {
        exploreSegments: state.exploreSegments,
        filteredIds: results.map(s => s.id)
      });
    }

    addSegUrlInput.value = '';
    addSegStatus.textContent = `"${detail.name}" ajoute.`;
    highlightSegment(segId);
  } catch (err) {
    addSegStatus.textContent = `Erreur: ${err.message}`;
    console.error(err);
  } finally {
    addSegBtn.disabled = false;
    state.searching = false;
  }
}

/**
 * Phase 1 — Discover segments via Strava's (undocumented) tile endpoint.
 *  Returns { tileSegments, authFailed } — caller handles auth failure UX.
 *  Returns empty list on any other tile error (logged, not thrown).
 */
async function discoverSegmentsFromTiles(sport, center, radius, surface) {
  setProgress(0, 'Decouverte via tiles...');
  const bounds = centerRadiusToBounds(center.lat, center.lng, radius);
  try {
    const tileResult = await fetchTileSegments(bounds, sport, radius, (done, total, segs) => {
      const pct = Math.round(15 * done / total);
      setProgress(pct, `Tiles ${done}/${total} — ${segs} segments`);
    }, surface);
    if (state.aborted) return { tileSegments: [], authFailed: false, stats: tileResult.stats };

    // Auth considered failed when either the tile endpoint 401'd exhaustively,
    // OR the /maps page itself was served as login (no tile version, no tiles tried).
    const versionAuthFailed = tileResult.stats.versionAuthStatus && tileResult.stats.versionAuthStatus !== 'ok';
    const authFailed = (tileResult.stats.auth > 0 && tileResult.segments.length === 0)
      || (versionAuthFailed && tileResult.segments.length === 0);
    if (authFailed) return { tileSegments: [], authFailed: true, stats: tileResult.stats };

    const tileSegments = filterSegmentsByRadius(tileResult.segments, center.lat, center.lng, radius);
    setProgress(15, `${tileSegments.length} segments via tiles (${tileResult.segments.length} dans les tuiles)`);
    return { tileSegments, authFailed: false, stats: tileResult.stats };
  } catch (err) {
    console.warn('Tile discovery error:', err);
    return { tileSegments: [], authFailed: false, stats: null };
  }
}

/** Build a user-facing message explaining why tile fetching failed.
 *  Combines tile version auth status + browser cookie presence to differentiate
 *  "not logged in" vs "logged in but cookies blocked for extension". */
async function buildTileAuthMessage(stats) {
  const versionStatus = stats && stats.versionAuthStatus;
  if (versionStatus === 'formatChanged') {
    return `Strava a change le format de sa page /maps. L'extension a besoin d'une mise a jour.`;
  }
  if (versionStatus === 'unknown') {
    return `Impossible de contacter strava.com. Verifiez votre connexion reseau.`;
  }

  // versionStatus 'loggedOut' OR 'ok' (but tiles still 401) → same diagnosis flow.
  const hasCookie = await hasStravaSessionCookie();
  if (hasCookie === true) {
    return `Cookies Strava detectes dans le navigateur mais bloques pour cette extension. `
      + `Ouvre <code>chrome://settings/cookies</code>, ajoute <strong>strava.com</strong> aux sites autorises, `
      + `ou desactive "Bloquer les cookies tiers". Puis recharge cette page.`;
  }
  if (hasCookie === false) {
    return `Connexion a <a href="https://www.strava.com/login" target="_blank" rel="noopener">strava.com</a> `
      + `requise dans ce navigateur pour la decouverte de segments.`;
  }
  // hasCookie === null (API unavailable)
  return `Connexion a <a href="https://www.strava.com/login" target="_blank" rel="noopener">strava.com</a> `
    + `requise dans ce navigateur pour la decouverte de segments.`;
}

/**
 * Phase 2 — Decide which segments need a detail re-fetch and run them.
 *  Smart cache: re-fetch only if tile KOM differs from cached KOM (KOM changed
 *  means leaderboard moved, so effort_count/elev may also be stale).
 *  Writes to state.allDetails + persistent cache. Honors state.aborted.
 */
async function fetchSegmentDetails(segments, token) {
  const cache = await loadCache();
  for (const [id, entry] of Object.entries(cache)) {
    state.allDetails[id] = entry.data;
  }

  const needFetch = segments.filter(s => {
    const entry = cache[s.id];
    if (!entry) return true;                                    // pas en cache
    const cachedKom = getKomSeconds(entry.data);                // KOM en cache
    const tileKom = s._tileData && s._tileData.komElapsedTime;  // KOM actuel via tiles
    if (tileKom == null) return false;                          // pas d'info tile, garde cache
    if (cachedKom == null) return true;                         // cache sans KOM, re-fetch
    return tileKom !== cachedKom;                               // KOM changé → re-fetch
  });
  const fresh = segments.length - needFetch.length;
  const komChanged = needFetch.filter(s => cache[s.id]).length;
  const missing = needFetch.length - komChanged;

  if (needFetch.length === 0) {
    setProgress(95, `${fresh} segments, KOMs inchanges — aucun appel`);
    return;
  }
  const parts = [];
  if (fresh > 0) parts.push(`${fresh} inchanges`);
  if (komChanged > 0) parts.push(`${komChanged} KOM change`);
  if (missing > 0) parts.push(`${missing} nouveaux`);
  setProgress(35, `Details: ${parts.join(', ')} — ${needFetch.length} appels`);

  for (let i = 0; i < needFetch.length; i++) {
    if (state.aborted) return;

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
}

/**
 * Zone params of the active saved search differ from what the user now has in
 * the UI? If so, the accumulated segments no longer belong to this search.
 */
function zoneChangedVsCurrentSearch(sport) {
  if (!state.currentSearchId) return true;
  const active = state.savedSearches.find(s => s.id === state.currentSearchId);
  if (!active) return true;
  const p = active.params;
  return !p.center
    || p.center.lat !== state.center.lat
    || p.center.lng !== state.center.lng
    || p.radius !== state.radius
    || (p.sport || 'running') !== sport
    || (p.surface || '0') !== surfaceTypeSelect.value;
}

async function startSearch() {
  if (!state.center) {
    alert('Cliquez sur la carte pour definir le centre de recherche.');
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
    const sport = getSport();

    // Phase 1: Tile discovery
    const { tileSegments, authFailed, stats } = await discoverSegmentsFromTiles(
      sport, state.center, state.radius, surfaceTypeSelect.value
    );
    if (authFailed) {
      finishSearch('');
      showStravaLoginWarning(await buildTileAuthMessage(stats));
      return;
    }
    if (state.aborted) { finishSearch('Recherche annulee.'); return; }

    // Reset accumulated segments when the zone no longer matches the active search
    if (zoneChangedVsCurrentSearch(sport)) {
      state.exploreSegments = [];
      state.currentSearchId = null;
    }

    const merged = mergeSegments(state.exploreSegments, tileSegments);
    const newCount = merged.length - state.exploreSegments.length;
    state.exploreSegments = merged;

    setProgress(30, `${merged.length} segments total (${newCount > 0 ? '+' + newCount + ' nouveaux' : 'aucun nouveau'})`);

    if (merged.length === 0) {
      finishSearch('Aucun segment dans la zone.');
      return;
    }

    // Phase 2: Fetch details
    await fetchSegmentDetails(merged, token);
    if (state.aborted) { finishSearch('Recherche annulee.'); return; }

    // Phase 3: Filter, persist, render
    const results = applyFilters(merged);
    state.segments = results;

    if (state.currentSearchId) {
      await updateSavedSearch(state.currentSearchId, {
        params: getCurrentParams(),
        exploreSegments: merged,
        filteredIds: results.map(s => s.id),
        createdAt: Date.now()
      });
    } else {
      await saveCurrentSearch(merged, results);
    }
    await saveLastSearch();

    renderSegmentList(results);

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


/** Re-apply filters on existing explore data and refresh display.
 *  Guarded two ways:
 *   - state.searching: bail out if a full search is writing to exploreSegments.
 *   - refilterToken: a newer liveRefilter invalidates older ones so in-flight
 *     detail fetches from a previous filter don't clobber the latest UI. */
async function liveRefilter() {
  if (state.searching) return;
  if (state.exploreSegments.length === 0) return;

  const myToken = ++state.refilterToken;
  const results = applyFilters(state.exploreSegments);
  state.segments = results;

  renderSegmentList(results);
  await persistCurrentFilters();
  if (myToken !== state.refilterToken || state.searching) return;

  // Fetch missing details for newly visible segments
  const missing = results.filter(s => !state.allDetails[s.id]);
  if (missing.length > 0) {
    try {
      const token = await getToken();
      for (let i = 0; i < missing.length; i++) {
        if (state.aborted) break;
        if (myToken !== state.refilterToken || state.searching) return;
        const seg = missing[i];
        try {
          const detail = await getSegmentDetail(seg.id, token);
          state.allDetails[seg.id] = detail;
          await saveCacheEntry(seg.id, detail);
        } catch (err) {
          console.warn(`Detail ${seg.id}:`, err.message);
        }
      }
      if (myToken !== state.refilterToken || state.searching) return;
      // Re-render with fresh details
      const updated = applyFilters(state.exploreSegments);
      state.segments = updated;
      renderSegmentList(updated);
      await persistCurrentFilters();
    } catch (err) {
      console.warn('Live detail fetch error:', err);
    }
  }
}

/** Save current filter state to both lastSearch and the active saved search.
 *  Does NOT update the zone params (center/radius/sport) — zone is fixed per saved search. */
async function persistCurrentFilters() {
  await saveLastSearch();
  if (state.currentSearchId) {
    const search = state.savedSearches.find(s => s.id === state.currentSearchId);
    if (!search) return;
    // Preserve zone params (center, radius, sport, activityType) from the saved search
    const newParams = {
      ...getCurrentParams(),
      center: search.params.center,
      radius: search.params.radius,
      sport: search.params.sport,
      activityType: search.params.activityType,
      surface: search.params.surface
    };
    await updateSavedSearch(state.currentSearchId, {
      params: newParams,
      filteredIds: state.segments.map(s => s.id)
    });
  }
}

function applyFilters(exploreSegs) {
  const sport = getSport();
  const eMin = parseFloat(elevMin.value);
  const eMax = parseFloat(elevMax.value);
  const fMin = parseFloat(feasibilityMinSlider.value);
  const fMax = parseFloat(feasibilityMaxSlider.value);
  const useFeasibility = state.athleteProfile && (fMin > 0.5 || fMax < 1.5);

  // Speed/pace filter: running uses pace (sec/km, lower = faster),
  // riding uses speed (km/h, higher = faster)
  let speedFilterFn = null;
  if (sport === 'running') {
    const pMin = parsePaceInput(paceMin.value);
    const pMax = parsePaceInput(paceMax.value);
    if (pMin != null || pMax != null) {
      speedFilterFn = (secPerKm) => {
        if (pMin != null && secPerKm < pMin) return false;
        if (pMax != null && secPerKm > pMax) return false;
        return true;
      };
    }
  } else {
    const sMin = parseFloat(speedMin.value);
    const sMax = parseFloat(speedMax.value);
    if (!isNaN(sMin) || !isNaN(sMax)) {
      speedFilterFn = (secPerKm) => {
        const kmh = 3600 / secPerKm;
        if (!isNaN(sMin) && kmh < sMin) return false;
        if (!isNaN(sMax) && kmh > sMax) return false;
        return true;
      };
    }
  }

  const dmn = parseFloat(distMin.value);
  const dmx = parseFloat(distMax.value);
  const gMin = parseFloat(gradeMin.value);
  const gMax = parseFloat(gradeMax.value);

  const excluded = { distance: 0, grade: 0, elev: 0, speed: 0, feasibility: 0 };

  const results = exploreSegs.filter(seg => {
    // Distance + grade (available from explore data)
    if (!isNaN(dmn) && seg.distance < dmn) { excluded.distance++; return false; }
    if (!isNaN(dmx) && seg.distance > dmx) { excluded.distance++; return false; }
    if (!isNaN(gMin) && seg.avg_grade < gMin) { excluded.grade++; return false; }
    if (!isNaN(gMax) && seg.avg_grade > gMax) { excluded.grade++; return false; }

    const detail = state.allDetails[seg.id];
    if (!detail) return true;

    const elev = detail.total_elevation_gain;
    if (elev != null) {
      if (!isNaN(eMin) && elev < eMin) { excluded.elev++; return false; }
      if (!isNaN(eMax) && elev > eMax) { excluded.elev++; return false; }
    }

    const komTime = getKomSeconds(detail);
    if (komTime != null && seg.distance > 0 && speedFilterFn) {
      const secPerKm = komTime / (seg.distance / 1000);
      if (!speedFilterFn(secPerKm)) { excluded.speed++; return false; }
    }

    if (useFeasibility && komTime != null && seg.distance > 0) {
      const ratio = feasibilityRatio(
        komTime, seg.distance, seg.avg_grade || 0, state.athleteProfile, sport
      );
      if (ratio != null) {
        if (ratio < fMin || ratio > fMax) { excluded.feasibility++; return false; }
      }
    }

    return true;
  });

  const totalExcluded = Object.values(excluded).reduce((a, b) => a + b, 0);
  if (totalExcluded > 0) {
    const parts = Object.entries(excluded).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`);
    console.log(`[Filters] ${exploreSegs.length} bruts → ${results.length} apres filtres. Exclus: ${parts.join(', ')}`);
  }

  return results;
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
    if (komStr) {
      const sec = parseTimeToSeconds(komStr);
      if (sec != null) return sec;
      console.warn(`[KOM] Unparsed xoms for segment ${detail.id}:`, detail.xoms);
    }
  }
  return null;
}

function getPrSeconds(detail) {
  if (!detail || !detail.athlete_segment_stats) return null;
  return detail.athlete_segment_stats.pr_elapsed_time || null;
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
/** Clear current map segments, re-add from list, and render the sidebar list. */
function renderSegmentList(segments) {
  clearSegmentsFromMap();
  segments.forEach(seg => addSegmentToMap(seg));
  renderResults(segments);
}

function renderResults(segments) {
  const sorted = sortSegments([...segments]);
  resultCount.textContent = `(${sorted.length}/${state.exploreSegments.length})`;
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

function isUserKom(detail) {
  const komTime = getKomSeconds(detail);
  const prTime = getPrSeconds(detail);
  if (!komTime || !prTime) return false;
  return prTime <= komTime;
}

function buildSegmentCard(seg, detail) {
  const card = document.createElement('div');
  const userHasKom = isUserKom(detail);
  card.className = 'segment-card' + (userHasKom ? ' user-kom' : '');
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

  const sport = getSport();
  const komSec = getKomSeconds(detail);
  const komTimeStr = komSec != null ? formatSeconds(komSec) : '—';
  const secPerKm = (komSec != null && seg.distance > 0) ? komSec / (seg.distance / 1000) : null;
  const komSpeedLabel = sport === 'running' ? 'Allure' : 'Vitesse';
  const komSpeedStr = secPerKm != null
    ? (sport === 'running' ? formatPace(secPerKm) : formatSpeed(secPerKm))
    : '—';

  let ratioHtml = '';
  if (state.athleteProfile && komSec != null && seg.distance > 0) {
    const ratio = feasibilityRatio(komSec, seg.distance, seg.avg_grade || 0, state.athleteProfile, sport);
    if (ratio != null) {
      const label = ratio < 0.9 ? 'Battable' : ratio < 1.1 ? 'Realiste' : ratio < 1.2 ? 'Ambitieux' : 'Hors portee';
      const cls = ratio < 0.9 ? 'easy' : ratio < 1.1 ? 'realistic' : ratio < 1.2 ? 'ambitious' : 'hard';
      ratioHtml = `<span><span class="kom-label">Ratio</span> <span class="ratio-badge ${cls}">${ratio.toFixed(2)} — ${label}</span></span>`;
    }
  }

  const crownHtml = userHasKom ? '<span class="kom-crown" title="Vous detenez le KOM">\u{1F451}</span> ' : '';

  card.innerHTML = `
    <div class="seg-name">
      <span>${crownHtml}${esc(seg.name)}</span>
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
      <span><span class="kom-label">${komSpeedLabel}</span> <span class="kom-value">${komSpeedStr}</span></span>
      ${ratioHtml}
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
  card.addEventListener('mouseenter', () => hoverSegment(seg.id));
  card.addEventListener('mouseleave', () => unhoverSegment(seg.id));

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
      case 'feasibility': {
        const ra = getSegmentRatio(a, da);
        const rb = getSegmentRatio(b, db);
        return ra - rb;
      }
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

function getSegmentRatio(seg, detail) {
  if (!state.athleteProfile) return Infinity;
  const komTime = getKomSeconds(detail);
  if (komTime == null || seg.distance <= 0) return Infinity;
  const ratio = feasibilityRatio(komTime, seg.distance, seg.avg_grade || 0, state.athleteProfile, getSport());
  return ratio != null ? ratio : Infinity;
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
