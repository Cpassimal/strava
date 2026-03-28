// ─── State ───
let rawData = [];
let charts = {};
let currentWindow = 'week';
const DateTime = luxon.DateTime;

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
  const googleDot = document.getElementById('google-dot');
  const stravaLabel = document.getElementById('strava-label');
  const googleLabel = document.getElementById('google-label');
  const syncText = document.getElementById('sync-text');
  const btnRefresh = document.getElementById('btn-refresh');

  stravaDot.className = `dot ${status.stravaConnected ? 'ok' : 'ko'}`;
  stravaLabel.textContent = status.stravaConnected
    ? `Strava: ${status.athlete?.firstname || 'connecté'}`
    : 'Strava: non connecté';

  googleDot.className = `dot ${status.googleSheetId ? 'ok' : 'ko'}`;
  googleLabel.textContent = status.googleSheetId ? 'Sheets: lié' : 'Sheets: non configuré';

  if (status.lastSync) {
    const d = new Date(status.lastSync);
    syncText.textContent = `Synchro: ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    syncText.textContent = '';
  }

  btnRefresh.disabled = !(status.stravaConnected && status.googleSheetId);

  // Show empty state or dashboard
  const hasData = rawData.length > 0;
  const isConfigured = status.stravaConnected && status.googleSheetId;

  if (!hasData && !isConfigured) {
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
  const googleDot = document.getElementById('settings-google-dot');
  const googleText = document.getElementById('settings-google-text');

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

  if (status.googleSheetId) {
    googleDot.className = 'dot ok';
    googleText.textContent = 'Sheet lié';
    document.getElementById('google-sheet-url').value = `https://docs.google.com/spreadsheets/d/${status.googleSheetId}`;
    document.getElementById('btn-disconnect-google').style.display = '';
  } else {
    googleDot.className = 'dot ko';
    googleText.textContent = 'Non configuré';
    document.getElementById('btn-disconnect-google').style.display = 'none';
  }
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
    document.getElementById('date-min').value = '2024-01-01';
    document.getElementById('date-max').value = DateTime.now().toISODate();
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
    rawData = result.activities.filter(row => row.ID && row.Moyenne_FC && parseFloat(row.Moyenne_FC) > 0);
    initFilters();
    showUI();
    updateDashboard();
  }

  updateTopBar();
}

// ─── UI ───
function showUI() {
  document.getElementById('filters-container').style.display = 'flex';
  document.getElementById('kpi-container').style.display = 'grid';
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

// ─── Window selection ───
function selectWindow(el) {
  document.querySelectorAll('#window-selector .type-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  currentWindow = el.dataset.window;
  updateDashboard();
}

function getWindowKey(date) {
  switch (currentWindow) {
    case 'day': return date.toISODate();
    case 'week': return date.startOf('week').toISODate();
    case 'month': return date.startOf('month').toFormat('yyyy-MM');
    case 'quarter': return `${date.year}-T${Math.ceil(date.month / 3)}`;
    case 'half': return `${date.year}-S${date.month <= 6 ? 1 : 2}`;
    case 'year': return `${date.year}`;
    default: return date.startOf('week').toISODate();
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

function computePerformanceScore(dist, elev, hours, hr, fcMax, fcRepos) {
  const hrReserve = fcMax - fcRepos;
  if (hrReserve <= 0 || hours <= 0) return 0;
  const equivDist = dist + (elev / 100);
  const enduranceBonus = 1 + (dist / 100);
  const equivSpeed = equivDist / hours;
  const hrEffort = (hr - fcRepos) / hrReserve;
  if (hrEffort <= 0.05) return 0; // FC trop proche de FC repos → score non fiable
  const score = (equivSpeed * enduranceBonus) / hrEffort;
  return isFinite(score) ? score : 0;
}

// ─── Dashboard update ───
function updateDashboard() {
  const minVal = document.getElementById('date-min').value;
  const maxVal = document.getElementById('date-max').value;

  const filtered = rawData.filter(d => {
    const isTypeMatch = [...document.querySelectorAll('#sport-selector .type-pill.active')].map(p => p.textContent).includes(d.Type);
    const activityDate = (d.Date || '').split('T')[0];
    return isTypeMatch && activityDate >= minVal && activityDate <= maxVal;
  });

  const groupedData = {};
  let totalDist = 0, totalElev = 0, totalHours = 0, totalPerfScore = 0, countWithScore = 0, totalHR = 0;

  const fcMax = parseInt(document.getElementById('fc-max').value) || 200;
  const fcRepos = parseInt(document.getElementById('fc-repos').value) || 46;

  filtered.forEach(d => {
    const dist = cleanNum(d.Distance_km);
    const elev = cleanNum(d.D_plus);
    const hours = hmsToHours(d.Duree);
    const hr = cleanNum(d.Moyenne_FC);
    if (hours === 0) return;

    const date = DateTime.fromISO(d.Date);
    if (!date.isValid) return;
    const key = getWindowKey(date);

    if (!groupedData[key]) {
      groupedData[key] = { dist: 0, elev: 0, hours: 0, count: 0, perfSum: 0, hrSum: 0 };
    }

    const score = computePerformanceScore(dist, elev, hours, hr, fcMax, fcRepos);

    groupedData[key].hrSum += hr;
    groupedData[key].dist += dist;
    groupedData[key].elev += elev;
    groupedData[key].hours += hours;
    groupedData[key].count += 1;
    groupedData[key].perfSum += score;

    totalDist += dist;
    totalElev += elev;
    totalHours += hours;
    totalPerfScore += score;
    totalHR += hr;
    countWithScore++;
  });

  document.getElementById('kpi-dist').textContent = totalDist.toFixed(1) + ' km';
  document.getElementById('kpi-elev').textContent = Math.round(totalElev) + ' m';
  document.getElementById('kpi-time').textContent = Math.floor(totalHours) + 'h';
  document.getElementById('kpi-score').textContent = countWithScore > 0 ? (totalPerfScore / countWithScore).toFixed(2) : '0';
  document.getElementById('kpi-hr').textContent = countWithScore > 0 ? Math.round(totalHR / countWithScore) + ' bpm' : '-';

  const sortedKeys = Object.keys(groupedData).sort();

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
  const perfData = labels.map(w => safeNum(data[w].perfSum / data[w].count).toFixed(2));
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
      plugins: { ...options.plugins, title: { display: true, text: 'Performance (Vitesse Équiv. pondérée par FC)' } },
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

  // 4. FC Moyenne
  const hrData = labels.map(w => safeNum(data[w].hrSum / data[w].count).toFixed(0));
  const hrDatasets = [{
    label: 'FC Moyenne (bpm)', data: hrData,
    borderColor: '#ff3b30', backgroundColor: 'rgba(255, 59, 48, 0.1)',
    fill: true, tension: 0.3, spanGaps: true
  }];
  if (showTrend) {
    hrDatasets.push({
      label: 'Tendance',
      data: getMovingAverage(hrData),
      borderColor: 'rgba(255, 59, 48, 0.5)',
      borderDash: [5, 5], pointRadius: 0, fill: false, tension: 0.3
    });
  }

  charts.hr = new Chart(document.getElementById('hrChart'), {
    type: 'line',
    data: { labels, datasets: hrDatasets },
    options: {
      ...options,
      plugins: { ...options.plugins, title: { display: true, text: 'Évolution Fréquence Cardiaque' } },
      scales: { y: { min: document.getElementById('zero-hr').checked ? 40 : undefined } }
    }
  });
}

// ─── Event listeners ───

// Window selector
document.querySelectorAll('#window-selector .type-pill').forEach(pill => {
  pill.addEventListener('click', () => selectWindow(pill));
});

// Filter inputs
['date-min', 'date-max', 'fc-repos', 'fc-max'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateDashboard);
});

['show-trend', 'zero-perf', 'zero-dist', 'zero-vol', 'zero-hr'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateDashboard);
});

// Top bar buttons
document.getElementById('btn-refresh').addEventListener('click', doRefresh);
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-setup')?.addEventListener('click', openSettings);

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

// Google settings
function extractSheetId(input) {
  // Accept full URL or raw ID
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Fallback: treat as raw ID if it looks like one
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  return null;
}

document.getElementById('btn-link-sheet').addEventListener('click', async () => {
  const raw = document.getElementById('google-sheet-url').value.trim();
  if (!raw) { alert('Collez le lien de votre Google Sheet'); return; }
  const sheetId = extractSheetId(raw);
  if (!sheetId) { alert('Lien invalide. Collez l\'URL complète du Google Sheet.'); return; }
  showLoading('Vérification...');
  const result = await sendMessage({ action: 'googleLinkSheet', sheetId });
  hideLoading();
  if (result.error) { alert('Erreur: ' + result.error); return; }
  alert('Sheet lié!');
  updateTopBar();
});

document.getElementById('btn-disconnect-google').addEventListener('click', async () => {
  await sendMessage({ action: 'googleDisconnect' });
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
