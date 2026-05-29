// ─── State ───
let rawData = [];
let charts = {};
let currentWindow = 'month';
let currentTab = 'charts';
let activitiesPage = 1;
let activitiesSort = { key: 'Date', dir: 'desc' };
const ITEMS_PER_PAGE = 30;
const DateTime = luxon.DateTime;
const USER_CONFIG_KEY = 'user_config';

// ─── User Config ───
const CONFIG_FIELDS = {
  inputs: ['date-min', 'dist-min', 'dist-max', 'elev-min', 'elev-max', 'fc-repos', 'fc-max', 'hr-exponent'],
  checkboxes: ['show-trend', 'zero-perf', 'zero-dist', 'zero-vol', 'zero-charge']
};

function saveUserConfig() {
  // Snapshot current sliders into the active mode's slot before persisting.
  syncHeatSlidersToState();
  const config = {
    window: currentWindow,
    sports: [],
    heatMode: heatmapState.mode,
    heatModeValues: heatmapState.modeValues
  };
  CONFIG_FIELDS.inputs.forEach(id => {
    config[id] = document.getElementById(id).value;
  });
  CONFIG_FIELDS.checkboxes.forEach(id => {
    config[id] = document.getElementById(id).checked;
  });
  config.sports = [...document.querySelectorAll('#sport-selector .type-pill.active')].map(p => p.textContent);
  chrome.storage.local.set({ [USER_CONFIG_KEY]: config });
}

async function restoreUserConfig() {
  const data = await chrome.storage.local.get(USER_CONFIG_KEY);
  const config = data[USER_CONFIG_KEY];
  if (!config) return;

  if (config.heatModeValues) {
    heatmapState.modeValues = { ...heatmapState.modeValues, ...config.heatModeValues };
  }
  if (config.heatMode) setHeatmapMode(config.heatMode, { skipSync: true });

  CONFIG_FIELDS.inputs.forEach(id => {
    if (config[id] !== undefined) document.getElementById(id).value = config[id];
  });
  CONFIG_FIELDS.checkboxes.forEach(id => {
    if (config[id] !== undefined) document.getElementById(id).checked = config[id];
  });
  if (config.window) {
    currentWindow = config.window;
    document.querySelectorAll('#window-selector .type-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.window === config.window);
    });
  }
  if (config.sports) {
    document.querySelectorAll('#sport-selector .type-pill').forEach(p => {
      if (config.sports.includes(p.textContent)) p.classList.add('active');
    });
  }
}

// ─── Messaging ───
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

// ─── Loading ───
function showLoading(text = 'Chargement...') {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading').classList.add('active');
}

function hideLoading() {
  document.getElementById('loading').classList.remove('active');
}

// Listen for progress updates from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    document.getElementById('loading-text').textContent = msg.detail;
  }
});

// ─── Status ───
async function updateTopBar() {
  const status = await sendMessage({ action: 'getStatus' });
  if (status.error) return;

  const stravaDot = document.getElementById('strava-dot');
  const stravaLabel = document.getElementById('strava-label');
  const syncText = document.getElementById('sync-text');
  const btnRefresh = document.getElementById('btn-refresh');

  stravaDot.className = `dot ${status.stravaConnected ? 'ok' : 'ko'}`;
  stravaLabel.textContent = status.stravaConnected
    ? `Strava: ${status.athlete?.firstname || 'connecté'}`
    : 'Strava: non connecté';

  if (status.lastSync) {
    const d = new Date(status.lastSync);
    syncText.textContent = `Synchro: ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} — ${status.activityCount} activités`;
  } else {
    syncText.textContent = status.activityCount > 0 ? `${status.activityCount} activités` : '';
  }

  btnRefresh.disabled = !status.stravaConnected;

  // Show empty state or dashboard
  const hasData = rawData.length > 0;
  if (!hasData && !status.stravaConnected) {
    document.getElementById('empty-state').style.display = 'block';
  } else {
    document.getElementById('empty-state').style.display = 'none';
  }

  // Update settings modal status
  updateSettingsStatus(status);
}

function updateSettingsStatus(status) {
  const stravaDot = document.getElementById('settings-strava-dot');
  const stravaText = document.getElementById('settings-strava-text');

  if (status.stravaConnected) {
    stravaDot.className = 'dot ok';
    stravaText.textContent = `Connecté (${status.athlete?.firstname || ''} ${status.athlete?.lastname || ''})`;
    document.getElementById('btn-disconnect-strava').style.display = '';
    document.getElementById('btn-connect-strava').style.display = 'none';
  } else if (status.stravaConfigured) {
    stravaDot.className = 'dot ko';
    stravaText.textContent = 'Configuré, non connecté';
    document.getElementById('btn-connect-strava').disabled = false;
    document.getElementById('btn-disconnect-strava').style.display = 'none';
    document.getElementById('btn-connect-strava').style.display = '';
  } else {
    stravaDot.className = 'dot ko';
    stravaText.textContent = 'Non configuré';
    document.getElementById('btn-connect-strava').disabled = true;
    document.getElementById('btn-disconnect-strava').style.display = 'none';
    document.getElementById('btn-connect-strava').style.display = '';
  }

  document.getElementById('data-count-info').textContent = `${status.activityCount} activités stockées localement.`;
}

// ─── Settings Modal ───
function openSettings() {
  document.getElementById('settings-modal').classList.add('active');
  // Load stored credentials
  chrome.storage.local.get(['strava_client_id', 'strava_client_secret'], (data) => {
    if (data.strava_client_id) document.getElementById('strava-client-id').value = data.strava_client_id;
    if (data.strava_client_secret) document.getElementById('strava-client-secret').value = data.strava_client_secret;
  });
  // Show callback domain (just the domain, ready to paste in Strava)
  if (chrome.identity && chrome.identity.getRedirectURL) {
    const uri = chrome.identity.getRedirectURL('strava');
    const domain = new URL(uri).hostname;
    document.getElementById('redirect-uri-display').textContent = domain;
  }
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('active');
}

// ─── Data loading ───
async function loadData() {
  showLoading('Chargement des données...');
  const result = await sendMessage({ action: 'loadData' });
  hideLoading();

  if (result.error) {
    console.error('Load error:', result.error);
    return;
  }

  if (result.activities && result.activities.length > 0) {
    rawData = result.activities.filter(row => row.ID);
    initFilters();
    // Defaults, then override with saved config
    document.getElementById('date-min').value = '2024-01-01';
    document.getElementById('date-max').value = DateTime.now().toISODate();
    await restoreUserConfig();
    showUI();
    updateDashboard();
  }
}

// ─── Refresh ───
async function doRefresh() {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Synchronisation...';
  showLoading('Récupération des activités Strava...');

  const result = await sendMessage({ action: 'refresh' });
  hideLoading();

  if (result.error) {
    btn.textContent = 'Erreur!';
    alert('Erreur: ' + result.error);
    setTimeout(() => { btn.textContent = 'Rafraîchir'; btn.disabled = false; }, 2000);
    return;
  }

  btn.textContent = `+${result.newCount} activités`;
  setTimeout(() => { btn.textContent = 'Rafraîchir'; btn.disabled = false; }, 2000);

  // Reload data
  if (result.activities) {
    const activeSports = [...document.querySelectorAll('#sport-selector .type-pill.active')].map(p => p.textContent);
    rawData = result.activities.filter(row => row.ID);
    initFilters();
    // Restore previously active sports
    document.querySelectorAll('#sport-selector .type-pill').forEach(p => {
      if (activeSports.includes(p.textContent)) p.classList.add('active');
    });
    showUI();
    updateDashboard();
  }

  updateTopBar();
}

// ─── UI ───
function showUI() {
  document.getElementById('filters-container').style.display = 'flex';
  document.getElementById('kpi-container').style.display = 'grid';
  document.getElementById('tab-bar').style.display = 'flex';
  document.getElementById('empty-state').style.display = 'none';
  ['c1', 'c2', 'c3', 'c4'].forEach(id => {
    document.getElementById(id).style.display = 'block';
  });
}

function initFilters() {
  const types = [...new Set(rawData.map(d => d.Type))].filter(t => t);
  const container = document.getElementById('sport-selector');
  container.innerHTML = '';
  types.forEach(type => {
    const pill = document.createElement('span');
    pill.className = 'type-pill';
    pill.textContent = type;
    pill.onclick = () => { pill.classList.toggle('active'); updateDashboard(); };
    container.appendChild(pill);
  });
}

function getWindowKey(date) {
  switch (currentWindow) {
    case 'day': return date.toISODate();
    case 'week': return date.startOf('week').toISODate();
    case 'month': return date.startOf('month').toFormat('yyyy-MM');
    case 'quarter': return `${date.year}-T${Math.ceil(date.month / 3)}`;
    case 'half': return `${date.year}-S${date.month <= 6 ? 1 : 2}`;
    case 'year': return `${date.year}`;
    default: return date.startOf('month').toFormat('yyyy-MM');
  }
}

function generatePeriodKeys(firstKey, lastKey, wType) {
  const keys = [];
  let cursor = parsePeriodKey(firstKey, wType);
  const end = parsePeriodKey(lastKey, wType);
  if (!cursor || !end || !cursor.isValid || !end.isValid) return keys;
  const maxIter = 5000; // safety guard
  let i = 0;
  while (cursor <= end && i++ < maxIter) {
    keys.push(getWindowKey(cursor));
    cursor = advancePeriod(cursor, wType);
  }
  return keys;
}

function parsePeriodKey(key, wType) {
  switch (wType) {
    case 'day': return DateTime.fromISO(key);
    case 'week': return DateTime.fromISO(key);
    case 'month': return DateTime.fromFormat(key, 'yyyy-MM');
    case 'quarter': { const [y, t] = key.split('-T'); return DateTime.local(+y, (+t - 1) * 3 + 1, 1); }
    case 'half': { const [y, s] = key.split('-S'); return DateTime.local(+y, (+s - 1) * 6 + 1, 1); }
    case 'year': return DateTime.local(+key, 1, 1);
    default: return DateTime.fromFormat(key, 'yyyy-MM');
  }
}

function advancePeriod(dt, wType) {
  switch (wType) {
    case 'day': return dt.plus({ days: 1 });
    case 'week': return dt.plus({ weeks: 1 });
    case 'month': return dt.plus({ months: 1 });
    case 'quarter': return dt.plus({ months: 3 });
    case 'half': return dt.plus({ months: 6 });
    case 'year': return dt.plus({ years: 1 });
    default: return dt.plus({ months: 1 });
  }
}

const windowLabels = {
  day: 'jour', week: 'semaine', month: 'mois',
  quarter: 'trimestre', half: 'semestre', year: 'année'
};

// ─── Helpers ───
function cleanNum(val) {
  if (typeof val === 'string') val = val.replace(',', '.');
  let n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function hmsToHours(str) {
  if (!str || typeof str !== 'string') return 0;
  const p = str.split(':');
  let s = 0, m = 1;
  while (p.length > 0) { s += m * parseInt(p.pop(), 10); m *= 60; }
  return isNaN(s) ? 0 : s / 3600;
}

// Score = SCORE_SCALE × pace_équivalente × bonus_endurance / hrEffort^hrExp
// Factors fixed at sensible defaults — variability added noise without information.
const DPLUS_FACTOR = 100;       // 1 km D+ ≈ 10 km plat (rule of thumb traileur)
const DIST_BONUS_FACTOR = 110;  // bonus endurance modéré (20km gagne +8% vs 2×10km)
const SCORE_SCALE = 3.5;        // magnitude only: brings typical runs into ~0-100

// Fraction of HR reserve used as the "physiological cost" input of the fitness
// score. Uses the trimean (P25 + 2·P50 + P75)/4 when the HR stream has been
// backfilled — a robust central-tendency estimator that incorporates spread.
// Independent of how the activity was recorded (auto-pause, walks counted, etc.)
// so trends compare like-for-like across sessions.
// Falls back to Moyenne_FC when the stream isn't fetched yet.
function hrEffortReserveFrac(d, fcRepos, hrReserve) {
  if (hrReserve <= 0) return null;
  const p25 = cleanNum(d.FC_p25);
  const p50 = cleanNum(d.FC_mediane);
  const p75 = cleanNum(d.FC_p75);
  if (p25 > 0 && p50 > 0 && p75 > 0) {
    const fc = (p25 + 2 * p50 + p75) / 4;
    return (fc - fcRepos) / hrReserve;
  }
  const mean = cleanNum(d.Moyenne_FC);
  if (mean > 0) return (mean - fcRepos) / hrReserve;
  return null;
}

// "tried but no HR data" (sensor off, manual entry) is stored as FC_mediane=null;
// "never tried" is the absence of the key entirely. Distinguish so the icon
// reflects sync state, not data quality.
function hrStreamState(d) {
  if (!cleanNum(d.Moyenne_FC)) return 'none';        // no HR at all
  if ('FC_mediane' in d) {
    return cleanNum(d.FC_mediane) > 0 ? 'synced' : 'no-data';
  }
  return 'pending';
}

function renderHrCell(a) {
  const mean = cleanNum(a.Moyenne_FC);
  if (!mean) return '-';
  const state = hrStreamState(a);
  const dot = {
    synced:  '<span class="hr-dot synced" title="Distribution FC dispo (utilisée pour le score)"></span>',
    pending: '<span class="hr-dot pending" title="Stream pas encore récupéré — rafraîchis pour score plus précis"></span>',
    'no-data': '<span class="hr-dot no-data" title="Stream récupéré mais sans données HR utilisables"></span>',
    none: ''
  }[state];
  return `${Math.round(mean)} bpm ${dot}`;
}

function computePerformanceScore(dist, elev, hours, hrEffort, hrExp, fallbackHrEffort) {
  if (hours <= 0) return 0;
  const equivDist = dist + (elev / DPLUS_FACTOR);
  const enduranceBonus = 1 + (dist / DIST_BONUS_FACTOR);
  const equivSpeed = equivDist / hours;
  let effort;
  if (hrEffort !== null && hrEffort > 0) {
    if (hrEffort <= 0.05) return 0;
    effort = hrEffort;
  } else {
    effort = fallbackHrEffort || 0.65;
  }
  const score = SCORE_SCALE * (equivSpeed * enduranceBonus) / Math.pow(effort, hrExp);
  return isFinite(score) ? score : 0;
}

function computeFallbackHrEffort(activities, fcMax, fcRepos) {
  const hrReserve = fcMax - fcRepos;
  if (hrReserve <= 0) return 0.65;
  const efforts = [];
  activities.forEach(d => {
    const e = hrEffortReserveFrac(d, fcRepos, hrReserve);
    if (e !== null && e > 0.05) efforts.push(e);
  });
  if (efforts.length === 0) return 0.65;
  return efforts.reduce((a, b) => a + b, 0) / efforts.length;
}

let lastFilteredActivities = [];

function openPersoModal() {
  document.getElementById('perso-modal').classList.add('active');
}

function closePersoModal() {
  document.getElementById('perso-modal').classList.remove('active');
}

// ─── Tabs ───
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');
  if (tabName === 'heatmap') renderHeatmap();
}

// ─── Heatmap ───
document.getElementById('btn-heatmap-fullscreen').addEventListener('click', () => {
  const target = document.getElementById('tab-heatmap');
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (target.requestFullscreen) {
    target.requestFullscreen().catch(err => console.warn('Plein écran refusé:', err));
  }
});

document.addEventListener('fullscreenchange', () => {
  // Leaflet computes tile bounds from the container size at init/resize time;
  // after the viewport changes we have to nudge it to recompute.
  if (heatmapState.map) {
    setTimeout(() => heatmapState.map.invalidateSize(), 100);
  }
});

const heatmapState = {
  map: null,
  layer: null,
  dirty: true,
  mode: 'heat',
  fitNeeded: true,
  modeValues: {
    heat: { intensity: 0.6, radius: 6 },
    lines: { intensity: 0.6, radius: 2 }
  }
};

function syncHeatSlidersToState() {
  const intensityEl = document.getElementById('heat-intensity');
  const radiusEl = document.getElementById('heat-radius');
  if (!intensityEl || !radiusEl) return;
  heatmapState.modeValues[heatmapState.mode] = {
    intensity: parseFloat(intensityEl.value),
    radius: parseInt(radiusEl.value, 10)
  };
}

function applyModeValuesToSliders(mode) {
  const v = heatmapState.modeValues[mode];
  if (!v) return;
  document.getElementById('heat-intensity').value = v.intensity;
  document.getElementById('heat-radius').value = v.radius;
}

function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function initHeatmapMap() {
  if (heatmapState.map) return;
  heatmapState.map = L.map('heatmap-container', { preferCanvas: true }).setView([46.6, 2.5], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(heatmapState.map);
}

function renderHeatmap() {
  // Defer to next frame: the tab was just made visible via .active class,
  // and Leaflet/heatLayer need real container dimensions before the canvas
  // is created (otherwise getImageData on a 0×0 canvas throws).
  requestAnimationFrame(() => {
    const container = document.getElementById('heatmap-container');
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      // Still not laid out — try again next frame.
      requestAnimationFrame(() => renderHeatmap());
      return;
    }
    doRenderHeatmap();
  });
}

function doRenderHeatmap() {
  initHeatmapMap();
  heatmapState.map.invalidateSize();
  if (!heatmapState.dirty && heatmapState.layer) return;

  // Decode all polylines once; both modes consume them.
  const tracks = [];
  let withPoly = 0, withoutPoly = 0;
  for (const act of lastFilteredActivities) {
    if (!act.Map_polyline) { withoutPoly++; continue; }
    withPoly++;
    tracks.push(decodePolyline(act.Map_polyline));
  }

  const slider1 = parseFloat(document.getElementById('heat-intensity').value);
  const slider2 = parseInt(document.getElementById('heat-radius').value, 10);

  if (heatmapState.layer) {
    heatmapState.map.removeLayer(heatmapState.layer);
    heatmapState.layer = null;
  }

  let pointCount = 0;
  let allBoundsLats = [], allBoundsLngs = [];

  if (tracks.length > 0) {
    if (heatmapState.mode === 'heat') {
      // Sub-sample to cap at ~60k points for perf.
      const totalRaw = tracks.reduce((s, t) => s + t.length, 0);
      const sampleEvery = Math.max(1, Math.floor(totalRaw / 60000));
      const points = [];
      for (const pts of tracks) {
        for (let i = 0; i < pts.length; i += sampleEvery) {
          points.push([pts[i][0], pts[i][1], slider1]);
          allBoundsLats.push(pts[i][0]);
          allBoundsLngs.push(pts[i][1]);
        }
      }
      pointCount = points.length;
      heatmapState.layer = L.heatLayer(points, {
        radius: slider2,
        blur: slider2 * 1.5,
        maxZoom: 17,
        max: 1.0,
        gradient: { 0.2: 'blue', 0.4: 'cyan', 0.6: 'lime', 0.8: 'yellow', 1.0: 'red' }
      }).addTo(heatmapState.map);
    } else {
      // Lines mode: draw each polyline with low opacity, stacking creates density.
      const group = L.layerGroup();
      for (const pts of tracks) {
        L.polyline(pts, {
          color: '#fc4c02',
          weight: slider2,
          opacity: slider1 * 0.4,  // 0.04..0.8 range matches slider 0.1..2
          smoothFactor: 1.5
        }).addTo(group);
        for (const p of pts) { allBoundsLats.push(p[0]); allBoundsLngs.push(p[1]); }
        pointCount += pts.length;
      }
      group.addTo(heatmapState.map);
      heatmapState.layer = group;
    }

    if (heatmapState.fitNeeded && allBoundsLats.length > 0) {
      const bounds = [
        [Math.min(...allBoundsLats), Math.min(...allBoundsLngs)],
        [Math.max(...allBoundsLats), Math.max(...allBoundsLngs)]
      ];
      heatmapState.map.fitBounds(bounds, { padding: [30, 30] });
      heatmapState.fitNeeded = false;
    }
  }

  const stats = document.getElementById('heat-stats');
  const noun = heatmapState.mode === 'heat' ? 'points' : 'segments';
  stats.textContent = `${withPoly} activités tracées${withoutPoly > 0 ? ` · ${withoutPoly} sans tracé` : ''} · ${pointCount} ${noun}`;

  heatmapState.dirty = false;
}

function setHeatmapMode(mode, opts = {}) {
  // Snapshot outgoing mode's slider values before swapping (unless we're in
  // initial restore: sliders haven't been touched yet by the user).
  if (!opts.skipSync && heatmapState.mode !== mode) {
    syncHeatSlidersToState();
  }
  heatmapState.mode = mode;
  heatmapState.dirty = true;
  document.querySelectorAll('#heat-mode-selector .type-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.mode === mode);
  });
  // Adapt labels and slider ranges to the active mode.
  const label1 = document.getElementById('heat-label-1');
  const label2 = document.getElementById('heat-label-2');
  const radius = document.getElementById('heat-radius');
  if (mode === 'heat') {
    label1.textContent = 'Intensité';
    label2.textContent = 'Rayon';
    radius.min = 2; radius.max = 20;
  } else {
    label1.textContent = 'Opacité';
    label2.textContent = 'Épaisseur';
    radius.min = 1; radius.max = 6;
  }
  // Load incoming mode's stored slider values.
  applyModeValuesToSliders(mode);
  if (currentTab === 'heatmap') renderHeatmap();
}

function invalidateHeatmap() {
  heatmapState.dirty = true;
  heatmapState.fitNeeded = true;  // filter change → refit to new data extent
  if (currentTab === 'heatmap') renderHeatmap();
}

function selectWindow(el) {
  document.querySelectorAll('#window-selector .type-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  currentWindow = el.dataset.window;
  updateDashboard();
}

// ─── Activities Table ───
function getSortValue(activity, key) {
  if (key === 'score') return activity.score || 0;
  if (key === 'charge') return activity.charge || 0;
  if (key === 'Distance_km') return cleanNum(activity.Distance_km);
  if (key === 'D_plus') return cleanNum(activity.D_plus);
  if (key === 'Moyenne_FC') return cleanNum(activity.Moyenne_FC);
  if (key === 'Date') return activity.Date || '';
  if (key === 'Duree') return hmsToHours(activity.Duree);
  return (activity[key] || '').toString().toLowerCase();
}

function sortActivities(list) {
  const { key, dir } = activitiesSort;
  return [...list].sort((a, b) => {
    const va = getSortValue(a, key);
    const vb = getSortValue(b, key);
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function getSearchFiltered() {
  const query = (document.getElementById('activities-search')?.value || '').toLowerCase().trim();
  if (!query) return lastFilteredActivities;
  return lastFilteredActivities.filter(a =>
    (a.Nom || '').toLowerCase().includes(query) ||
    (a.Type || '').toLowerCase().includes(query) ||
    (a.Date || '').includes(query)
  );
}

function renderActivitiesTable() {
  const sorted = sortActivities(getSearchFiltered());
  const totalPages = Math.max(1, Math.ceil(sorted.length / ITEMS_PER_PAGE));
  if (activitiesPage > totalPages) activitiesPage = totalPages;
  const start = (activitiesPage - 1) * ITEMS_PER_PAGE;
  const page = sorted.slice(start, start + ITEMS_PER_PAGE);

  const tbody = document.getElementById('activities-tbody');
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:#aaa; padding:40px;">Pas de données</td></tr>';
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  tbody.innerHTML = page.map(a => {
    const date = DateTime.fromISO(a.Date);
    const dateStr = date.isValid ? date.toFormat('dd/MM/yyyy HH:mm') : a.Date;
    const score = a.score ? a.score.toFixed(1) : '-';
    const excluded = a.Excluded;
    const hrDisplay = renderHrCell(a);
    return `<tr class="${excluded ? 'excluded' : ''}">
      <td>${dateStr}</td>
      <td><a href="${a.Lien_activite}" target="_blank">${a.Nom}</a></td>
      <td>${a.Type}</td>
      <td>${cleanNum(a.Distance_km).toFixed(1)} km</td>
      <td>${a.Duree}</td>
      <td>${cleanNum(a.D_plus)} m</td>
      <td>${hrDisplay}</td>
      <td>${score}</td>
      <td>${a.charge ? a.charge.toFixed(1) : '-'}</td>
      <td><button class="btn-exclude ${excluded ? 'is-excluded' : ''}" data-id="${a.ID}" data-excluded="${excluded ? '1' : '0'}">${excluded ? 'Inclure' : 'Exclure'}</button></td>
    </tr>`;
  }).join('');

  // Update sort indicators
  document.querySelectorAll('.activities-table th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === activitiesSort.key) {
      th.classList.add(activitiesSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });

  // Pagination
  const pag = document.getElementById('pagination');
  let html = '';
  html += `<button ${activitiesPage <= 1 ? 'disabled' : ''} data-page="${activitiesPage - 1}">&laquo;</button>`;

  const maxVisible = 7;
  let startPage = Math.max(1, activitiesPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

  if (startPage > 1) html += `<button data-page="1">1</button><span class="page-info">...</span>`;
  for (let i = startPage; i <= endPage; i++) {
    html += `<button data-page="${i}" class="${i === activitiesPage ? 'active' : ''}">${i}</button>`;
  }
  if (endPage < totalPages) html += `<span class="page-info">...</span><button data-page="${totalPages}">${totalPages}</button>`;

  html += `<button ${activitiesPage >= totalPages ? 'disabled' : ''} data-page="${activitiesPage + 1}">&raquo;</button>`;
  html += `<span class="page-info">${sorted.length} activités</span>`;
  pag.innerHTML = html;
}

// ─── Dashboard update ───
function updateDashboard() {
  saveUserConfig();
  const minVal = document.getElementById('date-min').value;
  const maxVal = document.getElementById('date-max').value;

  const distMin = parseFloat(document.getElementById('dist-min').value) || 0;
  const distMaxVal = document.getElementById('dist-max').value;
  const distMax = distMaxVal ? parseFloat(distMaxVal) : Infinity;

  const elevMin = parseFloat(document.getElementById('elev-min').value) || 0;
  const elevMaxVal = document.getElementById('elev-max').value;
  const elevMax = elevMaxVal ? parseFloat(elevMaxVal) : Infinity;

  const filtered = rawData.filter(d => {
    const isTypeMatch = [...document.querySelectorAll('#sport-selector .type-pill.active')].map(p => p.textContent).includes(d.Type);
    const activityDate = (d.Date || '').split('T')[0];
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    return isTypeMatch && activityDate >= minVal && activityDate <= maxVal && dist >= distMin && dist <= distMax && elev >= elevMin && elev <= elevMax;
  });

  const groupedData = {};
  let totalDist = 0, totalElev = 0, totalHours = 0, totalCount = 0;
  let totalPerfScore = 0, countForScore = 0, totalCharge = 0;
  const allDistances = [];
  const allElevations = [];

  const fcMax = parseInt(document.getElementById('fc-max').value) || 180;
  const fcRepos = parseInt(document.getElementById('fc-repos').value) || 60;
  const hrExp = parseFloat(document.getElementById('hr-exponent').value) || 1.0;
  const fallbackHrEffort = computeFallbackHrEffort(filtered, fcMax, fcRepos);

  const hrReserve = fcMax - fcRepos;
  filtered.forEach(d => {
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    const hours = hmsToHours(d.Duree);
    const hrEffort = hrEffortReserveFrac(d, fcRepos, hrReserve);
    const excluded = d.Excluded;
    if (hours === 0) return;

    const date = DateTime.fromISO(d.Date);
    if (!date.isValid) return;
    const key = getWindowKey(date);

    if (!groupedData[key]) {
      groupedData[key] = { dist: 0, elev: 0, hours: 0, count: 0, perfSum: 0, perfCount: 0, chargeSum: 0 };
    }

    // Always count for totals
    const equivDist = dist + (elev / DPLUS_FACTOR);
    const charge = equivDist;

    groupedData[key].dist += dist;
    groupedData[key].elev += elev;
    groupedData[key].hours += hours;
    groupedData[key].count += 1;
    groupedData[key].chargeSum += charge;
    totalCharge += charge;
    totalDist += dist;
    totalElev += elev;
    totalHours += hours;
    totalCount++;
    allDistances.push(dist);
    allElevations.push(elev);

    // Only count for score if not excluded
    if (!excluded) {
      const score = computePerformanceScore(dist, elev, hours, hrEffort, hrExp, fallbackHrEffort);
      groupedData[key].perfSum += score;
      groupedData[key].perfCount += 1;
      totalPerfScore += score;
      countForScore++;
    }
  });

  document.getElementById('kpi-count').textContent = totalCount;
  document.getElementById('kpi-dist').textContent = totalDist.toFixed(1) + ' km';
  document.getElementById('kpi-elev').textContent = Math.round(totalElev) + ' m';
  document.getElementById('kpi-time').textContent = Math.floor(totalHours) + 'h';
  document.getElementById('kpi-score').textContent = countForScore > 0 ? (totalPerfScore / countForScore).toFixed(1) : '0';
  document.getElementById('kpi-avg-charge').textContent = totalCount > 0 ? (totalCharge / totalCount).toFixed(1) : '0';

  // Median distance
  allDistances.sort((a, b) => a - b);
  const median = allDistances.length > 0
    ? (allDistances.length % 2 === 0
      ? (allDistances[allDistances.length / 2 - 1] + allDistances[allDistances.length / 2]) / 2
      : allDistances[Math.floor(allDistances.length / 2)])
    : 0;
  document.getElementById('kpi-median-dist').textContent = median > 0 ? median.toFixed(1) + ' km' : '-';

  // Median D+
  allElevations.sort((a, b) => a - b);
  const medianElev = allElevations.length > 0
    ? (allElevations.length % 2 === 0
      ? (allElevations[allElevations.length / 2 - 1] + allElevations[allElevations.length / 2]) / 2
      : allElevations[Math.floor(allElevations.length / 2)])
    : 0;
  document.getElementById('kpi-median-elev').textContent = medianElev > 0 ? Math.round(medianElev) + ' m' : '-';

  // Fill empty periods between first and last keys
  const existingKeys = Object.keys(groupedData).sort();
  if (existingKeys.length >= 2) {
    const emptyPeriod = { dist: 0, elev: 0, hours: 0, count: 0, perfSum: 0, perfCount: 0, chargeSum: 0 };
    const allPeriodKeys = generatePeriodKeys(existingKeys[0], existingKeys[existingKeys.length - 1], currentWindow);
    allPeriodKeys.forEach(k => {
      if (!groupedData[k]) groupedData[k] = { ...emptyPeriod };
    });
  }
  const sortedKeys = Object.keys(groupedData).sort();
  const nbPeriods = sortedKeys.length;
  document.getElementById('kpi-avg-period').textContent = nbPeriods > 0
    ? (totalCount / nbPeriods).toFixed(1)
    : '-';

  // Build filtered activities with computed score for the table
  lastFilteredActivities = filtered.map(d => {
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    const hours = hmsToHours(d.Duree);
    const hrEffort = hrEffortReserveFrac(d, fcRepos, hrReserve);
    const score = computePerformanceScore(dist, elev, hours, hrEffort, hrExp, fallbackHrEffort);
    const charge = dist + elev / DPLUS_FACTOR;
    return { ...d, score, charge };
  });
  activitiesPage = 1;
  renderActivitiesTable();
  invalidateHeatmap();

  // Toggle "Pas de données" messages
  const chartIds = ['c1', 'c2', 'c3', 'c4'];
  chartIds.forEach(id => {
    const box = document.getElementById(id);
    let msg = box.querySelector('.no-data-msg');
    if (sortedKeys.length === 0) {
      if (!msg) {
        msg = document.createElement('div');
        msg.className = 'no-data-msg';
        msg.textContent = 'Pas de données';
        box.appendChild(msg);
      }
      msg.style.display = '';
    } else if (msg) {
      msg.style.display = 'none';
    }
  });

  if (sortedKeys.length === 0) {
    if (charts.perf) Object.values(charts).forEach(c => c.destroy());
    charts = {};
    return;
  }
  renderCharts(sortedKeys, groupedData);
}

// ─── Charts ───
function renderCharts(labels, data) {
  if (charts.perf) Object.values(charts).forEach(c => c.destroy());

  const showTrend = document.getElementById('show-trend').checked;
  const options = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } };

  const getMovingAverage = (dataArray, windowSize = 4) => {
    return dataArray.map((val, idx, arr) => {
      const start = Math.max(0, idx - windowSize + 1);
      const subset = arr.slice(start, idx + 1);
      const sum = subset.reduce((a, b) => a + parseFloat(b), 0);
      return (sum / subset.length).toFixed(2);
    });
  };

  function safeNum(v) { return isFinite(v) ? v : 0; }

  // 1. Performance
  const perfData = labels.map(w => safeNum(data[w].perfCount > 0 ? data[w].perfSum / data[w].perfCount : 0).toFixed(1));
  const perfDatasets = [{
    label: 'Indice de Performance',
    data: perfData,
    borderColor: '#fc4c02',
    backgroundColor: 'rgba(252, 76, 2, 0.1)',
    fill: true, tension: 0.3
  }];
  if (showTrend) {
    perfDatasets.push({
      label: 'Tendance',
      data: getMovingAverage(perfData),
      borderColor: 'rgba(252, 76, 2, 0.5)',
      borderDash: [5, 5], pointRadius: 0, fill: false, tension: 0.3
    });
  }

  charts.perf = new Chart(document.getElementById('perfChart'), {
    type: 'line',
    data: { labels, datasets: perfDatasets },
    options: {
      ...options,
      plugins: { ...options.plugins, title: { display: true, text: 'Performance par ' + windowLabels[currentWindow] } },
      scales: { y: { min: document.getElementById('zero-perf').checked ? 0 : undefined } }
    }
  });

  // 2. Distance + D+
  const distData = labels.map(w => data[w].dist.toFixed(1));
  const elevData = labels.map(w => Math.round(data[w].elev));
  const distElevDatasets = [
    {
      label: 'Distance (km)', data: distData,
      borderColor: '#007aff', backgroundColor: 'rgba(0, 122, 255, 0.1)',
      fill: true, tension: 0.3, yAxisID: 'y'
    },
    {
      label: 'D+ (m)', data: elevData,
      borderColor: '#8b5cf6', backgroundColor: 'rgba(139, 92, 246, 0.1)',
      fill: true, tension: 0.3, yAxisID: 'y1'
    }
  ];
  if (showTrend) {
    distElevDatasets.push({
      label: 'Tendance Dist.',
      data: getMovingAverage(distData),
      borderColor: 'rgba(0, 122, 255, 0.5)',
      borderDash: [5, 5], pointRadius: 0, fill: false, tension: 0.3, yAxisID: 'y'
    });
  }

  const yMinDist = document.getElementById('zero-dist').checked ? 0 : undefined;
  charts.distElev = new Chart(document.getElementById('distElevChart'), {
    type: 'line',
    data: { labels, datasets: distElevDatasets },
    options: {
      ...options,
      plugins: { ...options.plugins, title: { display: true, text: 'Distance & Dénivelé par ' + windowLabels[currentWindow] } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Distance (km)' }, min: yMinDist },
        y1: { position: 'right', title: { display: true, text: 'D+ (m)' }, grid: { drawOnChartArea: false }, min: yMinDist }
      }
    }
  });

  // 3. Volume + Fréquence
  const yMinVol = document.getElementById('zero-vol').checked ? 0 : undefined;
  charts.vol = new Chart(document.getElementById('volumeChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Heures',
          data: labels.map(w => data[w].hours.toFixed(1)),
          backgroundColor: 'rgba(88, 86, 214, 0.7)',
          yAxisID: 'y'
        },
        {
          label: 'Activités / ' + windowLabels[currentWindow],
          type: 'line',
          data: labels.map(w => data[w].count),
          borderColor: '#32d74b',
          backgroundColor: 'rgba(50, 215, 75, 0.1)',
          fill: false, tension: 0, yAxisID: 'y1', pointRadius: 3
        }
      ]
    },
    options: {
      ...options,
      plugins: { ...options.plugins, title: { display: true, text: 'Volume & Fréquence par ' + windowLabels[currentWindow] } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Heures' }, min: yMinVol },
        y1: { position: 'right', title: { display: true, text: 'Nb activités' }, grid: { drawOnChartArea: false }, min: yMinVol }
      }
    }
  });

  // 4. Charge
  const chargeData = labels.map(w => data[w].chargeSum.toFixed(1));
  const chargeDatasets = [{
    label: 'Charge',
    data: chargeData,
    borderColor: '#ff9500',
    backgroundColor: 'rgba(255, 149, 0, 0.15)',
    fill: true, tension: 0.3
  }];
  if (showTrend) {
    chargeDatasets.push({
      label: 'Tendance',
      data: getMovingAverage(chargeData),
      borderColor: 'rgba(255, 149, 0, 0.5)',
      borderDash: [5, 5], pointRadius: 0, fill: false, tension: 0.3
    });
  }

  charts.charge = new Chart(document.getElementById('chargeChart'), {
    type: 'line',
    data: { labels, datasets: chargeDatasets },
    options: {
      ...options,
      plugins: { ...options.plugins, title: { display: true, text: 'Charge par ' + windowLabels[currentWindow] } },
      scales: { y: { min: document.getElementById('zero-charge').checked ? 0 : undefined } }
    }
  });
}

// ─── Event listeners ───

// Window selector
document.querySelectorAll('#window-selector .type-pill').forEach(pill => {
  pill.addEventListener('click', () => selectWindow(pill));
});

// Filter inputs
['date-min', 'date-max', 'dist-min', 'dist-max', 'elev-min', 'elev-max'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateDashboard);
});

['show-trend', 'zero-perf', 'zero-dist', 'zero-vol', 'zero-charge'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateDashboard);
});

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Heatmap controls
['heat-intensity', 'heat-radius'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    heatmapState.dirty = true;
    saveUserConfig();
    if (currentTab === 'heatmap') renderHeatmap();
  });
});
document.querySelectorAll('#heat-mode-selector .type-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    setHeatmapMode(pill.dataset.mode);
    saveUserConfig();
  });
});

// Table sort
document.querySelectorAll('.activities-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (activitiesSort.key === key) {
      activitiesSort.dir = activitiesSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      activitiesSort = { key, dir: key === 'Date' ? 'desc' : 'asc' };
    }
    renderActivitiesTable();
  });
});

// Activities search
document.getElementById('activities-search').addEventListener('input', () => {
  activitiesPage = 1;
  renderActivitiesTable();
});

// Exclude toggle (event delegation)
document.getElementById('activities-tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-exclude');
  if (!btn) return;
  const id = btn.dataset.id;
  const wasExcluded = btn.dataset.excluded === '1';
  const newExcluded = !wasExcluded;

  btn.disabled = true;
  btn.textContent = '...';

  const result = await sendMessage({ action: 'toggleExclude', activityId: id, excluded: newExcluded });
  if (result.error) {
    alert('Erreur: ' + result.error);
    btn.disabled = false;
    btn.textContent = wasExcluded ? 'Inclure' : 'Exclure';
    return;
  }

  // Update local state
  const activity = rawData.find(a => String(a.ID) === String(id));
  if (activity) activity.Excluded = newExcluded;
  const filtered = lastFilteredActivities.find(a => String(a.ID) === String(id));
  if (filtered) filtered.Excluded = newExcluded;

  // Re-render
  updateDashboard();
});

// Pagination (event delegation)
document.getElementById('pagination').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (!btn || btn.disabled) return;
  activitiesPage = parseInt(btn.dataset.page);
  renderActivitiesTable();
});

// Top bar buttons
document.getElementById('btn-refresh').addEventListener('click', doRefresh);
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-setup')?.addEventListener('click', openSettings);

// Help button
document.getElementById('btn-help').addEventListener('click', () => {
  window.open('doc.html', '_blank');
});

// Personal parameters modal
document.getElementById('btn-perso').addEventListener('click', openPersoModal);
document.getElementById('btn-close-perso').addEventListener('click', closePersoModal);
document.getElementById('perso-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('perso-modal')) closePersoModal();
});
['fc-repos', 'fc-max', 'hr-exponent'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateDashboard);
});

// Settings modal
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('settings-modal')) closeSettings();
});

// Strava settings
document.getElementById('btn-save-strava').addEventListener('click', async () => {
  const clientId = document.getElementById('strava-client-id').value.trim();
  const clientSecret = document.getElementById('strava-client-secret').value.trim();
  if (!clientId || !clientSecret) { alert('Remplissez les deux champs'); return; }

  const result = await sendMessage({ action: 'saveStravaCredentials', clientId, clientSecret });
  if (result.error) { alert(result.error); return; }
  alert('Credentials sauvegardées!');
  updateTopBar();
});

document.getElementById('btn-connect-strava').addEventListener('click', async () => {
  showLoading('Connexion à Strava...');
  const result = await sendMessage({ action: 'stravaAuth' });
  hideLoading();
  if (result.error) { alert('Erreur: ' + result.error); return; }
  alert(`Connecté en tant que ${result.athlete?.firstname} ${result.athlete?.lastname}!`);
  updateTopBar();
});

document.getElementById('btn-copy-domain').addEventListener('click', () => {
  const domain = document.getElementById('redirect-uri-display').textContent;
  navigator.clipboard.writeText(domain).then(() => {
    const btn = document.getElementById('btn-copy-domain');
    btn.textContent = 'Copié!';
    setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
  });
});

document.getElementById('btn-disconnect-strava').addEventListener('click', async () => {
  await sendMessage({ action: 'stravaDisconnect' });
  updateTopBar();
});

// Data management
const EXPORT_COLUMNS = ['ID', 'Nom', 'Type', 'Date', 'Distance_km', 'Duree', 'D_plus', 'Lien_activite', 'Moyenne_FC', 'FC_mediane', 'FC_p25', 'FC_p75', 'Map_polyline', 'Excluded'];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const result = await sendMessage({ action: 'loadData' });
  if (!result.activities || result.activities.length === 0) { alert('Aucune donnée à exporter'); return; }
  const csvRows = [EXPORT_COLUMNS.join(',')];
  result.activities.forEach(a => {
    csvRows.push(EXPORT_COLUMNS.map(col => {
      if (col === 'Excluded') return a.Excluded ? 'TRUE' : '';
      return csvEscape(a[col]);
    }).join(','));
  });
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `strava_activities_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btn-import-csv').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCSVRows(text);
  if (rows.length < 2) { alert('Fichier vide ou illisible'); e.target.value = ''; return; }
  const headers = rows[0];
  const idx = name => headers.indexOf(name);
  const activities = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = r[idx('ID')];
    if (!id) continue;
    const optionalNum = name => {
      const col = idx(name);
      if (col < 0) return undefined;
      const v = r[col];
      if (v === '' || v === undefined) return undefined;
      const n = parseFloat(v);
      return isNaN(n) ? undefined : n;
    };
    const a = {
      ID: id,
      Nom: r[idx('Nom')] || '',
      Type: r[idx('Type')] || '',
      Date: r[idx('Date')] || '',
      Distance_km: r[idx('Distance_km')] || '',
      Duree: r[idx('Duree')] || '',
      D_plus: r[idx('D_plus')] || '',
      Lien_activite: r[idx('Lien_activite')] || '',
      Moyenne_FC: r[idx('Moyenne_FC')] || '',
      Map_polyline: idx('Map_polyline') >= 0 ? (r[idx('Map_polyline')] || null) : null,
      Excluded: (r[idx('Excluded')] || '') === 'TRUE'
    };
    const fcMed = optionalNum('FC_mediane');
    if (fcMed !== undefined) a.FC_mediane = fcMed;
    const fcP25 = optionalNum('FC_p25');
    if (fcP25 !== undefined) a.FC_p25 = fcP25;
    const fcP75 = optionalNum('FC_p75');
    if (fcP75 !== undefined) a.FC_p75 = fcP75;
    activities.push(a);
  }
  if (activities.length === 0) { alert('Aucune activité trouvée dans le fichier'); e.target.value = ''; return; }
  if (!confirm(`Importer ${activities.length} activités ? Cela remplacera les données actuelles.`)) { e.target.value = ''; return; }
  showLoading('Import en cours...');
  await sendMessage({ action: 'importData', activities });
  hideLoading();
  alert(`${activities.length} activités importées!`);
  await loadData();
  updateTopBar();
  e.target.value = '';
});

// Bulk import from Strava export
document.getElementById('btn-import-bulk').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { activities } = parseStravaBulkCSV(text);
  if (activities.length === 0) { alert('Aucune activité compatible trouvée dans le fichier.'); e.target.value = ''; return; }
  if (!confirm(`${activities.length} activités trouvées. Les activités déjà présentes ne seront pas écrasées. Continuer ?`)) { e.target.value = ''; return; }
  showLoading('Import bulk en cours...');
  await sendMessage({ action: 'bulkImportStrava', activities });
  hideLoading();
  alert(`Import terminé ! ${activities.length} activités traitées (les doublons ont été ignorés).`);
  await loadData();
  updateTopBar();
  e.target.value = '';
});

// Bulk import from full Strava export folder (CSV + GPX/TCX tracks)
document.getElementById('btn-import-bulk-folder').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  const csvFile = files.find(f => f.name.toLowerCase() === 'activities.csv');
  if (!csvFile) {
    const sample = files.slice(0, 3).map(f => f.webkitRelativePath || f.name).join('\n  - ');
    alert(
      `activities.csv non trouvé dans le dossier sélectionné.\n\n` +
      `Sélectionnez le dossier racine de l'export Strava — celui qui contient ` +
      `à la fois "activities.csv" et le sous-dossier "activities/".\n\n` +
      `${files.length} fichiers reçus. Aperçu :\n  - ${sample}`
    );
    e.target.value = '';
    return;
  }

  showLoading('Lecture de activities.csv...');
  const csvText = await csvFile.text();
  const { activities, filenameToId } = parseStravaBulkCSV(csvText);
  if (activities.length === 0) {
    hideLoading();
    alert('Aucune activité compatible trouvée dans activities.csv.');
    e.target.value = '';
    return;
  }

  const trackFiles = files.filter(f => /\.(gpx|tcx|fit)(\.gz)?$/i.test(f.name));

  hideLoading();
  if (!confirm(
    `Trouvé :\n` +
    `• ${activities.length} activités dans activities.csv\n` +
    `• ${trackFiles.length} tracés GPX/TCX/FIT à parser\n\n` +
    `Les activités déjà présentes ne seront pas écrasées. Continuer ?`
  )) { e.target.value = ''; return; }

  // Parse track files in parallel batches.
  const polylineByActivityId = new Map();
  const chunkSize = 8;
  let parsed = 0, withTrack = 0, errors = 0;
  showLoading(`Tracés: 0/${trackFiles.length}...`);
  for (let i = 0; i < trackFiles.length; i += chunkSize) {
    const batch = trackFiles.slice(i, i + chunkSize);
    const results = await Promise.all(batch.map(f =>
      parseTrackFile(f).catch(err => { console.warn(`Échec ${f.name}:`, err); errors++; return null; })
    ));
    for (let j = 0; j < batch.length; j++) {
      const poly = results[j];
      if (!poly) continue;
      const id = filenameToId.get(batch[j].name);
      if (id) {
        polylineByActivityId.set(String(id), poly);
        withTrack++;
      }
    }
    parsed += batch.length;
    if (i % 32 === 0 || parsed >= trackFiles.length) {
      showLoading(`Tracés: ${parsed}/${trackFiles.length} (${withTrack} associés)...`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Attach polylines (leave absent if not found, so API backfill can still run later).
  for (const a of activities) {
    const poly = polylineByActivityId.get(String(a.ID));
    if (poly) a.Map_polyline = poly;
  }

  showLoading('Sauvegarde...');
  await sendMessage({ action: 'bulkImportStrava', activities });
  hideLoading();
  alert(
    `Import terminé !\n` +
    `${activities.length} activités traitées, ${withTrack} tracés associés` +
    (errors > 0 ? ` (${errors} erreurs de parsing).` : '.')
  );
  await loadData();
  updateTopBar();
  e.target.value = '';
});

function parseStravaBulkCSV(text) {
  const rows = parseCSVRows(text);
  if (rows.length < 2) return { activities: [], filenameToId: new Map() };
  const headers = rows[0];
  const col = name => headers.indexOf(name);

  // There are duplicate column names in the export (Distance appears twice, etc.)
  // We need the second occurrence for the detailed numeric values
  const iActivityId = col('Activity ID');
  const iActivityDate = col('Activity Date');
  const iActivityName = col('Activity Name');
  const iActivityType = col('Activity Type');
  const iFilename = col('Filename');
  // Moving Time, Distance, Elevation Gain are in the second block (after col 15)
  const iMovingTime = headers.indexOf('Moving Time', 15);
  const iDistance = headers.indexOf('Distance', 15);
  const iElevGain = headers.indexOf('Elevation Gain', 15);
  const iAvgHR = headers.indexOf('Average Heart Rate', 15);

  const activities = [];
  // The CSV "Filename" column is e.g. "activities/87190638.gpx.gz" — the upload ID,
  // which differs from the Activity ID. We index by basename for matching against
  // File.name from the folder picker.
  const filenameToId = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = r[iActivityId];
    if (!id) continue;
    const type = r[iActivityType] || '';
    const distM = parseFloat(r[iDistance]) || 0;
    const movingSec = parseFloat(r[iMovingTime]) || 0;
    const elevGain = parseFloat(r[iElevGain]) || 0;
    const avgHR = parseFloat(r[iAvgHR]) || 0;
    const dateStr = r[iActivityDate] || '';

    // Parse date "Jun 14, 2021, 6:50:44 AM" → ISO
    const isoDate = parseStravaDate(dateStr);

    const h = Math.floor(movingSec / 3600);
    const m = Math.floor((movingSec % 3600) / 60);
    const s = Math.round(movingSec % 60);
    const duree = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    if (iFilename >= 0 && r[iFilename]) {
      const basename = r[iFilename].split('/').pop();
      if (basename) filenameToId.set(basename, id);
    }

    activities.push({
      ID: id,
      Nom: r[iActivityName] || '',
      Type: type,
      Date: isoDate,
      Distance_km: (distM / 1000).toFixed(2),
      Duree: duree,
      D_plus: elevGain.toFixed(1),
      Lien_activite: `https://www.strava.com/activities/${id}`,
      Moyenne_FC: avgHR || '',
      Excluded: false
    });
  }
  return { activities, filenameToId };
}

async function parseTrackFile(file) {
  const lower = file.name.toLowerCase();
  let buffer;
  if (lower.endsWith('.gz')) {
    const buf = await file.arrayBuffer();
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buffer = await new Response(stream).arrayBuffer();
  } else {
    buffer = await file.arrayBuffer();
  }

  let points;
  if (/\.fit(\.gz)?$/i.test(file.name)) {
    points = parseFITPoints(buffer);
  } else {
    const text = new TextDecoder('utf-8').decode(buffer);
    if (lower.includes('.gpx')) points = parseGPXPoints(text);
    else if (lower.includes('.tcx')) points = parseTCXPoints(text);
    else return null;
  }

  if (!points || points.length < 2) return null;
  return encodePolyline(decimatePoints(points, 500));
}

// Minimal FIT parser — extracts lat/lng from "record" messages (global msg #20,
// fields 0=position_lat, 1=position_long, both sint32 semicircles).
// Spec: https://developer.garmin.com/fit/protocol/
function parseFITPoints(buffer) {
  const view = new DataView(buffer);
  const len = view.byteLength;
  if (len < 14) return [];

  const headerSize = view.getUint8(0);
  if (headerSize !== 12 && headerSize !== 14) return [];
  const sig = String.fromCharCode(
    view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
  );
  if (sig !== '.FIT') return [];

  const dataSize = view.getUint32(4, true);
  const dataEnd = Math.min(headerSize + dataSize, len - 2); // exclude trailing CRC
  let pos = headerSize;

  // localType -> { globalMsg, fields:[{num,size,baseType}], totalSize, le }
  const defs = new Map();
  const points = [];
  const SEMI_TO_DEG = 180 / 2147483648;

  while (pos < dataEnd) {
    const recHeader = view.getUint8(pos++);
    let isDef = false;
    let localType, hasDev = false;

    if (recHeader & 0x80) {
      // Compressed timestamp header — always a data record.
      localType = (recHeader >> 5) & 0x3;
    } else {
      isDef = !!(recHeader & 0x40);
      hasDev = !!(recHeader & 0x20);
      localType = recHeader & 0xF;
    }

    if (isDef) {
      pos += 1; // reserved
      const arch = view.getUint8(pos++);
      const le = arch === 0;
      const globalMsg = view.getUint16(pos, le); pos += 2;
      const numFields = view.getUint8(pos++);
      const fields = [];
      let totalSize = 0;
      for (let i = 0; i < numFields; i++) {
        const num = view.getUint8(pos++);
        const size = view.getUint8(pos++);
        const baseType = view.getUint8(pos++);
        fields.push({ num, size, baseType });
        totalSize += size;
      }
      if (hasDev) {
        const numDev = view.getUint8(pos++);
        for (let i = 0; i < numDev; i++) {
          const num = view.getUint8(pos++);
          const size = view.getUint8(pos++);
          const baseType = view.getUint8(pos++);
          fields.push({ num: -1, size, baseType }); // dev field — read past, ignore
          totalSize += size;
        }
      }
      defs.set(localType, { globalMsg, fields, totalSize, le });
    } else {
      const def = defs.get(localType);
      if (!def) break; // unknown definition — bail (file likely malformed)
      if (pos + def.totalSize > dataEnd) break;

      if (def.globalMsg === 20) { // record
        let lat = null, lng = null;
        let off = pos;
        for (const f of def.fields) {
          if (f.num === 0 && f.size === 4) {
            const v = view.getInt32(off, def.le);
            if (v !== 0x7FFFFFFF) lat = v * SEMI_TO_DEG;
          } else if (f.num === 1 && f.size === 4) {
            const v = view.getInt32(off, def.le);
            if (v !== 0x7FFFFFFF) lng = v * SEMI_TO_DEG;
          }
          off += f.size;
        }
        if (lat !== null && lng !== null) points.push([lat, lng]);
      }
      pos += def.totalSize;
    }
  }

  return points;
}

function parseGPXPoints(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const pts = doc.getElementsByTagName('trkpt');
  const points = [];
  for (const pt of pts) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lng = parseFloat(pt.getAttribute('lon'));
    if (!isNaN(lat) && !isNaN(lng)) points.push([lat, lng]);
  }
  return points;
}

function parseTCXPoints(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const positions = doc.getElementsByTagName('Position');
  const points = [];
  for (const pos of positions) {
    const latEl = pos.getElementsByTagName('LatitudeDegrees')[0];
    const lngEl = pos.getElementsByTagName('LongitudeDegrees')[0];
    if (latEl && lngEl) {
      const lat = parseFloat(latEl.textContent);
      const lng = parseFloat(lngEl.textContent);
      if (!isNaN(lat) && !isNaN(lng)) points.push([lat, lng]);
    }
  }
  return points;
}

function decimatePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// Google encoded polyline algorithm (same format Strava returns as summary_polyline).
function encodePolyline(points) {
  let result = '';
  let prevLat = 0, prevLng = 0;
  for (const [lat, lng] of points) {
    const ilat = Math.round(lat * 1e5);
    const ilng = Math.round(lng * 1e5);
    result += encodePolylineNumber(ilat - prevLat) + encodePolylineNumber(ilng - prevLng);
    prevLat = ilat;
    prevLng = ilng;
  }
  return result;
}

function encodePolylineNumber(num) {
  num = num < 0 ? ~(num << 1) : (num << 1);
  let result = '';
  while (num >= 0x20) {
    result += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>>= 5;
  }
  result += String.fromCharCode(num + 63);
  return result;
}

function parseStravaDate(str) {
  // "Jun 14, 2021, 6:50:44 AM" → ISO 8601
  if (!str) return '';
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString();
  return str;
}

function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else {
        field += ch;
      }
    }
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm('Supprimer toutes les activités ? Cette action est irréversible.')) return;
  await sendMessage({ action: 'importData', activities: [] });
  rawData = [];
  updateDashboard();
  updateTopBar();
});


// ─── Init ───
async function maybeShowMigrationBanner() {
  const { migration_v2_dismissed } = await chrome.storage.local.get('migration_v2_dismissed');
  if (migration_v2_dismissed) return;
  const banner = document.getElementById('migration-banner');
  const domainEl = document.getElementById('migration-banner-domain');
  if (!banner || !domainEl) return;
  domainEl.textContent = `${chrome.runtime.id}.chromiumapp.org`;
  banner.style.display = 'flex';
  document.getElementById('btn-dismiss-migration').addEventListener('click', () => {
    chrome.storage.local.set({ migration_v2_dismissed: true });
    banner.style.display = 'none';
  });
}

async function init() {
  await maybeShowMigrationBanner();
  await updateTopBar();
  await loadData();

  // Open settings only if explicitly navigated via #settings
  if (window.location.hash === '#settings') {
    openSettings();
    history.replaceState(null, '', window.location.pathname);
  }
}

init();
