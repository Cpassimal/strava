import { authenticate, fetchActivities, disconnectStrava, getStoredTokens } from '../lib/strava.js';
import { STORAGE_KEYS } from '../lib/config.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true; // async response
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'getStatus':
      return getStatus();

    case 'stravaAuth':
      return { athlete: await authenticate() };

    case 'stravaDisconnect':
      await disconnectStrava();
      return { ok: true };

    case 'saveStravaCredentials':
      await chrome.storage.local.set({
        [STORAGE_KEYS.STRAVA_CLIENT_ID]: msg.clientId,
        [STORAGE_KEYS.STRAVA_CLIENT_SECRET]: msg.clientSecret
      });
      return { ok: true };

    case 'refresh':
      return refreshData();

    case 'loadData':
      return loadData();

    case 'toggleExclude': {
      const activities = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];
      const idx = activities.findIndex(a => String(a.ID) === String(msg.activityId));
      if (idx === -1) throw new Error(`Activité ${msg.activityId} non trouvée`);
      activities[idx].Excluded = msg.excluded;
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITIES]: activities });
      return { ok: true };
    }

    case 'importData':
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITIES]: msg.activities });
      return { ok: true };

    case 'bulkImportStrava': {
      const existing = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];
      const existingIds = new Set(existing.map(a => String(a.ID)));
      const toAdd = msg.activities.filter(a => !existingIds.has(String(a.ID)));
      const merged = [...existing, ...toAdd];
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITIES]: merged });
      return { ok: true, added: toAdd.length, skipped: msg.activities.length - toAdd.length };
    }

    default:
      throw new Error(`Action inconnue: ${msg.action}`);
  }
}

async function getStatus() {
  const stravaTokens = await getStoredTokens();
  const lastSync = (await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC))[STORAGE_KEYS.LAST_SYNC];
  const athlete = (await chrome.storage.local.get(STORAGE_KEYS.STRAVA_ATHLETE))[STORAGE_KEYS.STRAVA_ATHLETE];
  const activities = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];

  return {
    stravaConnected: !!stravaTokens.accessToken,
    stravaConfigured: !!stravaTokens.clientId && !!stravaTokens.clientSecret,
    lastSync: lastSync || null,
    athlete: athlete || null,
    activityCount: activities.length
  };
}

async function loadData() {
  const activities = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];
  return { activities };
}

async function refreshData() {
  const existing = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];
  const existingIds = new Set(existing.map(a => String(a.ID)));

  let afterTimestamp = null;
  if (existing.length > 0) {
    const dates = existing.map(a => new Date(a.Date).getTime()).filter(t => !isNaN(t));
    if (dates.length > 0) {
      afterTimestamp = Math.floor(Math.max(...dates) / 1000);
    }
  }

  function broadcastProgress(step, detail) {
    chrome.runtime.sendMessage({ type: 'progress', step, detail }).catch(() => {});
  }

  broadcastProgress('fetch', 'Récupération des activités Strava...');
  const newActivities = await fetchActivities(afterTimestamp, ({ page, fetched }) => {
    broadcastProgress('fetch', `Page ${page} — ${fetched} activités récupérées...`);
  });
  const toAdd = newActivities.filter(a => !existingIds.has(String(a.ID)));

  const allActivities = [...existing, ...toAdd];

  if (toAdd.length > 0) {
    broadcastProgress('save', `Sauvegarde de ${toAdd.length} nouvelles activités...`);
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITIES]: allActivities });
  }

  const now = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SYNC]: now });

  return { activities: allActivities, newCount: toAdd.length, lastSync: now };
}
