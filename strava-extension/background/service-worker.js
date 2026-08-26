import { authenticate, fetchActivities, fetchActivitiesWeb, backfillStreams, disconnectStrava, getStoredTokens, ensureValidToken } from '../lib/strava.js';
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

    case 'syncTracks':
      return syncTracks(msg.limit);

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

    case 'getToken':
      return { token: await ensureValidToken() };

    case 'clearSegmentsCache':
      await chrome.storage.local.remove(STORAGE_KEYS.SEGMENTS_CACHE);
      return { ok: true };

    default:
      throw new Error(`Action inconnue: ${msg.action}`);
  }
}

// A logged-in strava.com session is enough to use the cookie-based endpoints
// (list + streams), no OAuth token required. We treat the session as usable if
// a Strava session/remember cookie is present; the actual fetch validates it
// and reports `session_expired` if it turns out to be logged out.
async function hasStravaWebSession() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'strava.com' });
    return cookies.some(c => c.name === '_strava4_session' || c.name === 'strava_remember_id');
  } catch {
    return false;
  }
}

async function getStatus() {
  const stravaTokens = await getStoredTokens();
  const lastSync = (await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC))[STORAGE_KEYS.LAST_SYNC];
  const athlete = (await chrome.storage.local.get(STORAGE_KEYS.STRAVA_ATHLETE))[STORAGE_KEYS.STRAVA_ATHLETE];
  const activities = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];
  const webSession = await hasStravaWebSession();

  return {
    stravaConnected: !!stravaTokens.accessToken,
    stravaConfigured: !!stravaTokens.clientId && !!stravaTokens.clientSecret,
    webSession,
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

  function broadcastProgress(step, detail) {
    chrome.runtime.sendMessage({ type: 'progress', step, detail }).catch(() => {});
  }

  // 1. Fetch the activity list. Primary path is the cookie-based web endpoint
  //    (the API is now paid). If it fails and OAuth is still configured, fall
  //    back to the API. A failure here must NOT abort the run: we still want to
  //    enrich the activities already imported (e.g. from the export folder).
  broadcastProgress('fetch', 'Récupération des activités Strava...');
  let fetched = [];
  let listError = null;
  try {
    fetched = await fetchActivitiesWeb(({ page, fetched: n }) => {
      broadcastProgress('fetch', `Page ${page} — ${n} activités récupérées...`);
    }, existingIds);
  } catch (e) {
    if (e.message === 'session_expired') {
      throw new Error('Session Strava expirée — ouvrez strava.com et reconnectez-vous, puis réessayez.');
    }
    console.warn('Web activity list failed, trying API fallback:', e.message);
    listError = e;
    const tokens = await getStoredTokens();
    if (tokens.accessToken || (tokens.clientId && tokens.clientSecret)) {
      try {
        let afterTimestamp = null;
        if (existing.length > 0) {
          const dates = existing.map(a => new Date(a.Date).getTime()).filter(t => !isNaN(t));
          if (dates.length > 0) afterTimestamp = Math.floor(Math.max(...dates) / 1000);
        }
        fetched = await fetchActivities(afterTimestamp, ({ page, fetched: n }) => {
          broadcastProgress('fetch', `(API) Page ${page} — ${n} activités...`);
        });
        listError = null;
      } catch (e2) {
        console.warn('API activity list fallback also failed:', e2.message);
      }
    }
  }

  const toAdd = fetched.filter(a => !existingIds.has(String(a.ID)));
  const allActivities = [...existing, ...toAdd];
  console.log(`[strava] refresh: existing=${existing.length}, fetched=${fetched.length}, new=${toAdd.length}, listError=${listError?.message || 'none'}`);

  if (toAdd.length > 0) {
    broadcastProgress('save', `Sauvegarde...`);
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITIES]: allActivities });
  }

  // A refresh fetches the LIST ONLY. Tracks are never pulled here: one
  // /streams request per activity is what trips Strava's anti-abuse and got the
  // account banned. Use the explicit 'syncTracks' action for that.
  const now = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SYNC]: now });

  return {
    activities: allActivities,
    newCount: toAdd.length,
    lastSync: now,
    listError: listError?.message || null,
    missingTracks: allActivities.filter(a => !('Map_polyline' in a) && !a._noGps).length
  };
}

/**
 * Explicit, user-triggered track sync — never runs as part of a refresh.
 * `limit` caps how many /streams requests a single run may issue.
 */
async function syncTracks(limit = 25) {
  const activities = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVITIES))[STORAGE_KEYS.ACTIVITIES] || [];
  const save = async () => { await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITIES]: activities }); };

  function broadcastProgress(step, detail) {
    chrome.runtime.sendMessage({ type: 'progress', step, detail }).catch(() => {});
  }

  try {
    const res = await backfillStreams(activities,
      ({ filled, totalNeeded }) => broadcastProgress('stream', `Tracés: ${filled}/${totalNeeded}...`),
      save,
      10,
      limit
    );
    return {
      activities,
      filled: res.filled,
      polyOk: res.polyOk || 0,
      remaining: res.remaining || 0,
      rateLimited: !!res.rateLimited,
      retryAfter: res.retryAfter || 0
    };
  } catch (e) {
    if (e.message === 'session_expired') {
      throw new Error('Session Strava expirée — ouvrez strava.com et reconnectez-vous, puis réessayez.');
    }
    throw e;
  }
}
