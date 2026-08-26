const btnDashboard = document.getElementById('btn-dashboard');
const btnRefresh = document.getElementById('btn-refresh');
const btnSettings = document.getElementById('btn-settings');
const stravaDot = document.getElementById('strava-dot');
const stravaStatus = document.getElementById('strava-status');
const syncInfo = document.getElementById('sync-info');
const refreshLabel = document.getElementById('refresh-label');
const btnTracks = document.getElementById('btn-tracks');
const tracksLabel = document.getElementById('tracks-label');

// Tracks are fetched one /streams request per activity — deliberately manual,
// slow and capped, because bursts of those requests get the account banned.
const TRACK_BATCH = 25;

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

async function updateStatus() {
  const status = await sendMessage({ action: 'getStatus' });
  if (status.error) {
    stravaStatus.textContent = 'Erreur: ' + status.error;
    return;
  }

  if (status.stravaConnected) {
    stravaDot.className = 'status-dot connected';
    const name = status.athlete ? `${status.athlete.firstname} ${status.athlete.lastname}` : '';
    stravaStatus.textContent = `Strava: ${name || 'connecté'}`;
  } else if (status.webSession) {
    // Logged in on strava.com — cookie-based sync (list + streams) works without OAuth.
    stravaDot.className = 'status-dot connected';
    stravaStatus.textContent = 'Strava: session web active';
  } else if (status.stravaConfigured) {
    stravaDot.className = 'status-dot partial';
    stravaStatus.textContent = 'Strava: configuré, non connecté';
  } else {
    stravaDot.className = 'status-dot disconnected';
    stravaStatus.textContent = 'Strava: non connecté — ouvrez strava.com';
  }

  if (status.lastSync) {
    const date = new Date(status.lastSync);
    syncInfo.textContent = `Synchro: ${date.toLocaleDateString('fr-FR')} ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} — ${status.activityCount} activités`;
  } else {
    syncInfo.textContent = status.activityCount > 0 ? `${status.activityCount} activités` : 'Jamais synchronisé';
  }

  const usable = !!(status.stravaConnected || status.webSession);
  btnRefresh.disabled = !usable;
  btnTracks.disabled = !usable;
}

btnDashboard.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});

document.getElementById('btn-segments').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('explorer/explorer.html') });
  window.close();
});

btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  refreshLabel.textContent = 'Synchronisation...';
  const result = await sendMessage({ action: 'refresh' });
  if (result.error) {
    refreshLabel.textContent = 'Erreur!';
    stravaStatus.textContent = result.error;
    stravaStatus.title = result.error;
    setTimeout(() => { refreshLabel.textContent = 'Rafraîchir'; btnRefresh.disabled = false; updateStatus(); }, 4000);
  } else {
    refreshLabel.textContent = `+${result.newCount} activités`;
    if (result.missingTracks > 0) {
      stravaStatus.textContent = `${result.missingTracks} activités sans tracé — bouton « Récupérer les tracés »`;
    }
    setTimeout(() => { refreshLabel.textContent = 'Rafraîchir'; updateStatus(); }, 4000);
  }
});

btnTracks.addEventListener('click', async () => {
  btnTracks.disabled = true;
  tracksLabel.textContent = 'Tracés...';
  const result = await sendMessage({ action: 'syncTracks', limit: TRACK_BATCH });
  if (result.error) {
    tracksLabel.textContent = 'Erreur!';
    stravaStatus.textContent = result.error;
    stravaStatus.title = result.error;
  } else if (result.rateLimited) {
    const mins = Math.ceil((result.retryAfter || 900) / 60);
    tracksLabel.textContent = `+${result.polyOk} tracés`;
    stravaStatus.textContent = `Limite Strava atteinte — relancez dans ~${mins} min`;
  } else {
    tracksLabel.textContent = `+${result.polyOk} tracés`;
    stravaStatus.textContent = result.remaining > 0
      ? `${result.remaining} tracés restants — relancez plus tard`
      : 'Tous les tracés sont à jour';
  }
  setTimeout(() => { tracksLabel.textContent = 'Récupérer les tracés'; updateStatus(); }, 5000);
});

btnSettings.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#settings') });
  window.close();
});

updateStatus();
