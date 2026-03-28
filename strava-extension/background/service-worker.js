import { authenticate, fetchActivities, disconnectStrava, getStoredTokens } from '../lib/strava.js';
import { createSpreadsheet, readActivities, appendActivities, getSheetId, disconnectGoogle, linkExistingSheet } from '../lib/sheets.js';
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

    case 'googleAuth':
      return { ok: true, sheetId: await getSheetId() };

    case 'googleCreateSheet':
      return { sheetId: await createSpreadsheet() };

    case 'googleLinkSheet':
      await linkExistingSheet(msg.sheetId);
      return { ok: true };

    case 'googleDisconnect':
      await disconnectGoogle();
      await chrome.storage.local.remove(STORAGE_KEYS.GOOGLE_SHEET_ID);
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

    default:
      throw new Error(`Action inconnue: ${msg.action}`);
  }
}

async function getStatus() {
  const stravaTokens = await getStoredTokens();
  const sheetId = await getSheetId();
  const lastSync = (await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC))[STORAGE_KEYS.LAST_SYNC];
  const athlete = (await chrome.storage.local.get(STORAGE_KEYS.STRAVA_ATHLETE))[STORAGE_KEYS.STRAVA_ATHLETE];

  return {
    stravaConnected: !!stravaTokens.accessToken,
    stravaConfigured: !!stravaTokens.clientId && !!stravaTokens.clientSecret,
    googleSheetId: sheetId,
    lastSync: lastSync || null,
    athlete: athlete || null
  };
}

async function loadData() {
  // Try Google Sheets first, fallback to cache
  const sheetId = await getSheetId();
  if (sheetId) {
    try {
      const activities = await readActivities();
      // Cache locally
      await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_ACTIVITIES]: activities });
      return { activities, source: 'sheets' };
    } catch (e) {
      console.warn('Sheets read failed, using cache:', e.message);
    }
  }

  const cached = (await chrome.storage.local.get(STORAGE_KEYS.CACHED_ACTIVITIES))[STORAGE_KEYS.CACHED_ACTIVITIES];
  return { activities: cached || [], source: cached ? 'cache' : 'none' };
}

async function refreshData() {
  // Load existing data to find the latest activity date
  const existing = await loadData();
  const existingIds = new Set(existing.activities.map(a => String(a.ID)));

  let afterTimestamp = null;
  if (existing.activities.length > 0) {
    const dates = existing.activities
      .map(a => new Date(a.Date).getTime())
      .filter(t => !isNaN(t));
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

  if (toAdd.length > 0) {
    broadcastProgress('sheets', `Écriture de ${toAdd.length} activités dans Google Sheets...`);
    const sheetId = await getSheetId();
    if (sheetId) {
      await appendActivities(toAdd);
    }

    const allActivities = [...existing.activities, ...toAdd];
    await chrome.storage.local.set({ [STORAGE_KEYS.CACHED_ACTIVITIES]: allActivities });
  }

  const now = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SYNC]: now });

  const allData = [...existing.activities, ...toAdd];
  return { activities: allData, newCount: toAdd.length, lastSync: now };
}
