const btnDashboard = document.getElementById('btn-dashboard');
const btnRefresh = document.getElementById('btn-refresh');
const btnSettings = document.getElementById('btn-settings');
const stravaDot = document.getElementById('strava-dot');
const stravaStatus = document.getElementById('strava-status');
const syncInfo = document.getElementById('sync-info');
const refreshLabel = document.getElementById('refresh-label');

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
  } else if (status.stravaConfigured) {
    stravaDot.className = 'status-dot partial';
    stravaStatus.textContent = 'Strava: configuré, non connecté';
  } else {
    stravaDot.className = 'status-dot disconnected';
    stravaStatus.textContent = 'Strava: non configuré';
  }

  if (status.lastSync) {
    const date = new Date(status.lastSync);
    syncInfo.textContent = `Synchro: ${date.toLocaleDateString('fr-FR')} ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} — ${status.activityCount} activités`;
  } else {
    syncInfo.textContent = status.activityCount > 0 ? `${status.activityCount} activités` : 'Jamais synchronisé';
  }

  btnRefresh.disabled = !status.stravaConnected;
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
    setTimeout(() => { refreshLabel.textContent = 'Rafraîchir'; btnRefresh.disabled = false; }, 2000);
  } else {
    refreshLabel.textContent = `+${result.newCount} activités`;
    setTimeout(() => { refreshLabel.textContent = 'Rafraîchir'; updateStatus(); }, 2000);
  }
});

btnSettings.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#settings') });
  window.close();
});

updateStatus();
