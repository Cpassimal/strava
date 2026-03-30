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
  inputs: ['date-min', 'dist-min', 'dist-max', 'elev-min', 'elev-max', 'fc-repos', 'fc-max', 'dplus-factor', 'dist-bonus-factor'],
  checkboxes: ['show-trend', 'zero-perf', 'zero-dist', 'zero-vol', 'zero-charge']
};

function saveUserConfig() {
  const config = { window: currentWindow, sports: [] };
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
    rawData = result.activities.filter(row => row.ID && row.Moyenne_FC && parseFloat(row.Moyenne_FC) > 0);
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
    rawData = result.activities.filter(row => row.ID && row.Moyenne_FC && parseFloat(row.Moyenne_FC) > 0);
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
  document.getElementById('footnotes').style.display = 'block';
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

function computePerformanceScore(dist, elev, hours, hr, fcMax, fcRepos, dplusFactor, distBonusFactor) {
  const hrReserve = fcMax - fcRepos;
  if (hrReserve <= 0 || hours <= 0) return 0;
  const equivDist = dist + (elev / dplusFactor);
  const enduranceBonus = 1 + (dist / distBonusFactor);
  const equivSpeed = equivDist / hours;
  const hrEffort = (hr - fcRepos) / hrReserve;
  if (hrEffort <= 0.05) return 0;
  const score = (equivSpeed * enduranceBonus) / hrEffort;
  return isFinite(score) ? score : 0;
}

let lastFilteredActivities = [];

// ─── Calibration helpers ───
function getFilteredActivitiesForCalibration() {
  const minVal = document.getElementById('date-min').value;
  const maxVal = document.getElementById('date-max').value;
  const distMin = parseFloat(document.getElementById('dist-min').value) || 0;
  const distMaxVal = document.getElementById('dist-max').value;
  const distMax = distMaxVal ? parseFloat(distMaxVal) : Infinity;
  const elevMin = parseFloat(document.getElementById('elev-min').value) || 0;
  const elevMaxVal = document.getElementById('elev-max').value;
  const elevMax = elevMaxVal ? parseFloat(elevMaxVal) : Infinity;

  return rawData.filter(d => {
    const isTypeMatch = [...document.querySelectorAll('#sport-selector .type-pill.active')].map(p => p.textContent).includes(d.Type);
    const activityDate = (d.Date || '').split('T')[0];
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    const hours = hmsToHours(d.Duree);
    const hr = cleanNum(d.Moyenne_FC);
    return isTypeMatch && activityDate >= minVal && activityDate <= maxVal
      && dist >= distMin && dist <= distMax && elev >= elevMin && elev <= elevMax
      && hours > 0 && !d.Excluded && hr > 0;
  });
}

function avgPerfForSplit(activities, splitKey, median, dplusFactor, distBonusFactor) {
  const fcMax = parseInt(document.getElementById('fc-max').value) || 200;
  const fcRepos = parseInt(document.getElementById('fc-repos').value) || 46;
  const below = [], above = [];
  activities.forEach(d => {
    const val = cleanNum(d[splitKey]);
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    const hours = hmsToHours(d.Duree);
    const hr = cleanNum(d.Moyenne_FC);
    const score = computePerformanceScore(dist, elev, hours, hr, fcMax, fcRepos, dplusFactor, distBonusFactor);
    if (score <= 0) return;
    if (val <= median) below.push(score); else above.push(score);
  });
  const avgBelow = below.length > 0 ? below.reduce((a, b) => a + b, 0) / below.length : 0;
  const avgAbove = above.length > 0 ? above.reduce((a, b) => a + b, 0) / above.length : 0;
  return { avgBelow, avgAbove };
}

function computeMedian(values) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
}

function updateCalibrationIndicators() {
  const activities = getFilteredActivitiesForCalibration();
  const dplusFactor = parseInt(document.getElementById('dplus-factor').value) || 185;
  const distBonusFactor = parseInt(document.getElementById('dist-bonus-factor').value) || 110;

  const elevValues = activities.map(d => cleanNum(d.D_plus));
  const distValues = activities.map(d => cleanNum(d.Distance_km));
  const medianElev = computeMedian([...elevValues]);
  const medianDist = computeMedian([...distValues]);

  const elevSplit = avgPerfForSplit(activities, 'D_plus', medianElev, dplusFactor, distBonusFactor);
  const distSplit = avgPerfForSplit(activities, 'Distance_km', medianDist, dplusFactor, distBonusFactor);

  function renderIndicator(prefix, split) {
    document.getElementById(`perf-below-${prefix}`).textContent = split.avgBelow > 0 ? split.avgBelow.toFixed(2) : '-';
    document.getElementById(`perf-above-${prefix}`).textContent = split.avgAbove > 0 ? split.avgAbove.toFixed(2) : '-';
    const deltaEl = document.getElementById(`delta-${prefix}`);
    if (split.avgBelow > 0 && split.avgAbove > 0) {
      const pct = Math.abs(split.avgAbove - split.avgBelow) / ((split.avgAbove + split.avgBelow) / 2) * 100;
      deltaEl.textContent = pct < 1 ? 'OK' : `${pct.toFixed(0)}%`;
      deltaEl.className = `factor-delta ${pct < 5 ? 'balanced' : 'unbalanced'}`;
    } else {
      deltaEl.textContent = '';
      deltaEl.className = 'factor-delta';
    }
  }

  renderIndicator('elev', elevSplit);
  renderIndicator('dist', distSplit);
}

function autoCalibrate() {
  const activities = getFilteredActivitiesForCalibration();
  if (activities.length < 4) return;

  const elevValues = activities.map(d => cleanNum(d.D_plus));
  const distValues = activities.map(d => cleanNum(d.Distance_km));
  const medianElev = computeMedian([...elevValues]);
  const medianDist = computeMedian([...distValues]);

  let bestDplus = parseInt(document.getElementById('dplus-factor').value) || 185;
  let bestDist = parseInt(document.getElementById('dist-bonus-factor').value) || 110;

  // Alternate passes to converge both factors
  for (let pass = 0; pass < 3; pass++) {
    // Calibrate D+ factor
    let lo = 50, hi = 500;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const { avgBelow, avgAbove } = avgPerfForSplit(activities, 'D_plus', medianElev, mid, bestDist);
      if (avgBelow === 0 || avgAbove === 0) break;
      if (avgAbove < avgBelow) hi = mid; else lo = mid;
      if (Math.abs(hi - lo) < 1) break;
    }
    bestDplus = Math.round((lo + hi) / 2);

    // Calibrate dist factor
    lo = 50; hi = 500;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const { avgBelow, avgAbove } = avgPerfForSplit(activities, 'Distance_km', medianDist, bestDplus, mid);
      if (avgBelow === 0 || avgAbove === 0) break;
      if (avgAbove < avgBelow) hi = mid; else lo = mid;
      if (Math.abs(hi - lo) < 1) break;
    }
    bestDist = Math.round((lo + hi) / 2);
  }

  document.getElementById('dplus-factor').value = bestDplus;
  document.getElementById('dist-bonus-factor').value = bestDist;

  updateCalibrationIndicators();
  updateDashboard();
}

function openPersoModal() {
  document.getElementById('perso-modal').classList.add('active');
  updateCalibrationIndicators();
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
    const score = a.score ? a.score.toFixed(2) : '-';
    const excluded = a.Excluded;
    return `<tr class="${excluded ? 'excluded' : ''}">
      <td>${dateStr}</td>
      <td><a href="${a.Lien_activite}" target="_blank">${a.Nom}</a></td>
      <td>${a.Type}</td>
      <td>${cleanNum(a.Distance_km).toFixed(1)} km</td>
      <td>${a.Duree}</td>
      <td>${cleanNum(a.D_plus)} m</td>
      <td>${cleanNum(a.Moyenne_FC) ? Math.round(cleanNum(a.Moyenne_FC)) + ' bpm' : '-'}</td>
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

  const fcMax = parseInt(document.getElementById('fc-max').value) || 200;
  const fcRepos = parseInt(document.getElementById('fc-repos').value) || 46;
  const dplusFactor = parseInt(document.getElementById('dplus-factor').value) || 185;
  const distBonusFactor = parseInt(document.getElementById('dist-bonus-factor').value) || 110;

  filtered.forEach(d => {
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    const hours = hmsToHours(d.Duree);
    const hr = cleanNum(d.Moyenne_FC);
    const excluded = d.Excluded;
    if (hours === 0) return;

    const date = DateTime.fromISO(d.Date);
    if (!date.isValid) return;
    const key = getWindowKey(date);

    if (!groupedData[key]) {
      groupedData[key] = { dist: 0, elev: 0, hours: 0, count: 0, perfSum: 0, perfCount: 0, chargeSum: 0 };
    }

    // Always count for totals
    const equivDist = dist + (elev / dplusFactor);
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
      const score = computePerformanceScore(dist, elev, hours, hr, fcMax, fcRepos, dplusFactor, distBonusFactor);
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
  document.getElementById('kpi-score').textContent = countForScore > 0 ? (totalPerfScore / countForScore).toFixed(2) : '0';
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
    const hr = cleanNum(d.Moyenne_FC);
    const score = computePerformanceScore(dist, elev, hours, hr, fcMax, fcRepos, dplusFactor, distBonusFactor);
    const charge = dist + elev / dplusFactor;
    return { ...d, score, charge };
  });
  activitiesPage = 1;
  renderActivitiesTable();

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
  const perfData = labels.map(w => safeNum(data[w].perfCount > 0 ? data[w].perfSum / data[w].perfCount : 0).toFixed(2));
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

// Personal parameters modal
document.getElementById('btn-perso').addEventListener('click', openPersoModal);
document.getElementById('btn-close-perso').addEventListener('click', closePersoModal);
document.getElementById('perso-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('perso-modal')) closePersoModal();
});
document.getElementById('btn-auto-calibrate').addEventListener('click', autoCalibrate);
['fc-repos', 'fc-max', 'dplus-factor', 'dist-bonus-factor'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    updateCalibrationIndicators();
    updateDashboard();
  });
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
document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const result = await sendMessage({ action: 'loadData' });
  if (!result.activities || result.activities.length === 0) { alert('Aucune donnée à exporter'); return; }
  const headers = ['ID', 'Nom', 'Type', 'Date', 'Distance_km', 'Duree', 'D_plus', 'Lien_activite', 'Moyenne_FC', 'Excluded'];
  const csvRows = [headers.join(',')];
  result.activities.forEach(a => {
    csvRows.push([
      a.ID, `"${(a.Nom || '').replace(/"/g, '""')}"`, a.Type, a.Date,
      a.Distance_km, a.Duree, a.D_plus, a.Lien_activite, a.Moyenne_FC,
      a.Excluded ? 'TRUE' : ''
    ].join(','));
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
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  const activities = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].match(/(".*?"|[^,]*),?/g)?.map(v => v.replace(/,?$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) || [];
    if (!vals[0]) continue;
    activities.push({
      ID: vals[0], Nom: vals[1] || '', Type: vals[2] || '', Date: vals[3] || '',
      Distance_km: vals[4] || '', Duree: vals[5] || '', D_plus: vals[6] || '',
      Lien_activite: vals[7] || '', Moyenne_FC: vals[8] || '',
      Excluded: vals[9] === 'TRUE'
    });
  }
  if (activities.length === 0) { alert('Aucune activité trouvée dans le fichier'); return; }
  if (!confirm(`Importer ${activities.length} activités ? Cela remplacera les données actuelles.`)) return;
  showLoading('Import en cours...');
  await sendMessage({ action: 'importData', activities });
  hideLoading();
  alert(`${activities.length} activités importées!`);
  await loadData();
  updateTopBar();
  e.target.value = '';
});

document.getElementById('btn-clear-data').addEventListener('click', async () => {
  if (!confirm('Supprimer toutes les activités ? Cette action est irréversible.')) return;
  await sendMessage({ action: 'importData', activities: [] });
  rawData = [];
  updateDashboard();
  updateTopBar();
});

// ─── Init ───
async function init() {
  await updateTopBar();
  await loadData();

  // Open settings only if explicitly navigated via #settings
  if (window.location.hash === '#settings') {
    openSettings();
    history.replaceState(null, '', window.location.pathname);
  }
}

init();
