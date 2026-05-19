import { STRAVA_API_BASE, STRAVA_AUTH_URL, STRAVA_TOKEN_URL, STORAGE_KEYS, ACTIVITY_TYPES } from './config.js';

export async function getStoredTokens() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.STRAVA_ACCESS_TOKEN,
    STORAGE_KEYS.STRAVA_REFRESH_TOKEN,
    STORAGE_KEYS.STRAVA_EXPIRES_AT,
    STORAGE_KEYS.STRAVA_CLIENT_ID,
    STORAGE_KEYS.STRAVA_CLIENT_SECRET
  ]);
  return {
    accessToken: data[STORAGE_KEYS.STRAVA_ACCESS_TOKEN],
    refreshToken: data[STORAGE_KEYS.STRAVA_REFRESH_TOKEN],
    expiresAt: data[STORAGE_KEYS.STRAVA_EXPIRES_AT],
    clientId: data[STORAGE_KEYS.STRAVA_CLIENT_ID],
    clientSecret: data[STORAGE_KEYS.STRAVA_CLIENT_SECRET]
  };
}

export async function authenticate() {
  const { clientId, clientSecret } = await getStoredTokens();
  if (!clientId || !clientSecret) {
    throw new Error('Strava Client ID et Secret non configurés. Allez dans les paramètres.');
  }

  const redirectUrl = chrome.identity.getRedirectURL('strava');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUrl,
    response_type: 'code',
    scope: 'read,activity:read_all',
    approval_prompt: 'auto'
  });
  const authUrl = `${STRAVA_AUTH_URL}?${params.toString()}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true
  });

  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Pas de code d\'autorisation reçu de Strava');

  const tokenResponse = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenResponse.ok) throw new Error('Échec de l\'échange du token Strava');
  const tokens = await tokenResponse.json();

  await chrome.storage.local.set({
    [STORAGE_KEYS.STRAVA_ACCESS_TOKEN]: tokens.access_token,
    [STORAGE_KEYS.STRAVA_REFRESH_TOKEN]: tokens.refresh_token,
    [STORAGE_KEYS.STRAVA_EXPIRES_AT]: tokens.expires_at,
    [STORAGE_KEYS.STRAVA_ATHLETE]: tokens.athlete
  });

  return tokens.athlete;
}

export async function ensureValidToken() {
  const stored = await getStoredTokens();
  if (!stored.accessToken) throw new Error('Non connecté à Strava');

  const now = Math.floor(Date.now() / 1000);
  if (stored.expiresAt && stored.expiresAt > now + 60) {
    return stored.accessToken;
  }

  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: stored.clientId,
      client_secret: stored.clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!response.ok) throw new Error('Échec du refresh token Strava');
  const tokens = await response.json();

  await chrome.storage.local.set({
    [STORAGE_KEYS.STRAVA_ACCESS_TOKEN]: tokens.access_token,
    [STORAGE_KEYS.STRAVA_REFRESH_TOKEN]: tokens.refresh_token,
    [STORAGE_KEYS.STRAVA_EXPIRES_AT]: tokens.expires_at
  });

  return tokens.access_token;
}

function secondsToHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export async function fetchActivities(afterTimestamp = null, onProgress = null) {
  const token = await ensureValidToken();
  const allActivities = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    if (onProgress) onProgress({ page, fetched: allActivities.length });

    const params = new URLSearchParams({ page, per_page: perPage });
    if (afterTimestamp) params.set('after', afterTimestamp);

    const response = await fetch(`${STRAVA_API_BASE}/athlete/activities?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Rate limit Strava atteint. Réessayez dans 15 minutes.');
      }
      throw new Error(`Erreur API Strava: ${response.status}`);
    }

    const activities = await response.json();
    if (activities.length === 0) break;

    for (const act of activities) {
      if (!ACTIVITY_TYPES.includes(act.sport_type)) continue;

      allActivities.push({
        ID: act.id,
        Nom: act.name,
        Type: act.sport_type,
        Date: act.start_date,
        Distance_km: (act.distance / 1000).toFixed(2),
        Duree: secondsToHMS(act.moving_time),
        D_plus: Math.round(act.total_elevation_gain),
        Lien_activite: `https://www.strava.com/activities/${act.id}`,
        Moyenne_FC: act.average_heartrate || '',
        Map_polyline: act.map?.summary_polyline || null
      });
    }

    if (activities.length < perPage) break;
    page++;
  }

  return allActivities;
}

/**
 * Re-fetch the activity list endpoint to backfill `Map_polyline` on existing
 * activities that don't have it yet (older entries fetched before the field
 * was tracked). Uses summary_polyline from the list response — no detail call.
 *
 * Activities are returned newest first; we stop early once every needed ID
 * has been seen. Returns a new array; caller persists it.
 */
export async function backfillPolylines(existingActivities, onProgress = null) {
  // "never tried" = field absent. null means tried-but-empty (no GPS), skip.
  const needed = new Map();
  for (const a of existingActivities) {
    if (!('Map_polyline' in a)) needed.set(String(a.ID), a);
  }
  if (needed.size === 0) return { activities: existingActivities, filled: 0 };

  const token = await ensureValidToken();
  const perPage = 100;
  let page = 1;
  let filled = 0;
  const totalNeeded = needed.size;

  while (needed.size > 0) {
    if (onProgress) onProgress({ page, remaining: needed.size, filled, totalNeeded });

    const params = new URLSearchParams({ page, per_page: perPage });
    const response = await fetch(`${STRAVA_API_BASE}/athlete/activities?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      if (response.status === 429) throw new Error('Rate limit Strava atteint. Réessayez dans 15 minutes.');
      throw new Error(`Erreur API Strava: ${response.status}`);
    }

    const acts = await response.json();
    if (acts.length === 0) break;

    for (const act of acts) {
      const target = needed.get(String(act.id));
      if (target) {
        target.Map_polyline = act.map?.summary_polyline || null;
        needed.delete(String(act.id));
        filled++;
      }
    }

    if (acts.length < perPage) break;
    page++;
  }

  // Anything still in `needed` wasn't found in the list (deleted/private?) —
  // mark as null so we don't retry forever.
  for (const a of needed.values()) {
    a.Map_polyline = null;
  }

  return { activities: existingActivities, filled };
}

/**
 * Fetch the heartrate stream for a single activity and compute robust HR stats
 * (median + percentiles). Returns null if no HR data (missing sensor, private activity).
 * Throws { message: 'rate_limited', retryAfter } on 429 so callers can pace.
 */
export async function fetchHrStream(activityId, token) {
  const url = `${STRAVA_API_BASE}/activities/${activityId}/streams?keys=heartrate&key_by_type=true`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (response.status === 404) return null;
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After')) || 900;
    const err = new Error('rate_limited');
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!response.ok) throw new Error(`Stream ${activityId}: HTTP ${response.status}`);

  const data = await response.json();
  const hr = data?.heartrate?.data;
  if (!Array.isArray(hr) || hr.length === 0) return null;

  const sorted = [...hr].filter(v => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    FC_mediane: pct(0.50),
    FC_p75: pct(0.75),
    FC_p25: pct(0.25)
  };
}

/**
 * Backfill HR stats from streams for all activities that have a summary HR but
 * no stream-derived stats yet. Persists progress every `saveEvery` activities so
 * a long run survives interruption. Handles 429 by sleeping for Retry-After.
 *
 * Activities are mutated in place. Setting `FC_mediane = null` marks an activity
 * as "tried but no HR data" so we don't retry it forever.
 */
export async function backfillHrStreams(activities, onProgress = null, saveProgress = null, saveEvery = 10) {
  const target = activities.filter(a => !('FC_mediane' in a) && a.Moyenne_FC);
  const totalNeeded = target.length;
  if (totalNeeded === 0) return { activities, filled: 0, totalNeeded: 0 };

  const token = await ensureValidToken();
  let filled = 0;

  for (let i = 0; i < target.length; i++) {
    const a = target[i];
    if (onProgress) onProgress({ filled, totalNeeded, current: i + 1 });

    try {
      const stats = await fetchHrStream(a.ID, token);
      if (stats === null) {
        a.FC_mediane = null; // tried, no data — don't retry
      } else {
        Object.assign(a, stats);
      }
      filled++;
    } catch (e) {
      if (e.message === 'rate_limited') {
        const waitSec = Math.max(60, e.retryAfter);
        if (onProgress) onProgress({ filled, totalNeeded, current: i + 1, waiting: waitSec });
        if (saveProgress) await saveProgress(activities); // persist before sleep
        await new Promise(r => setTimeout(r, waitSec * 1000 + 1000));
        i--; // retry this activity
        continue;
      }
      // Other error: mark as tried-failed to avoid hammering
      console.warn(`HR stream fail for ${a.ID}:`, e.message);
      a.FC_mediane = null;
      filled++;
    }

    if (saveProgress && filled > 0 && filled % saveEvery === 0) {
      await saveProgress(activities);
    }
  }

  if (saveProgress) await saveProgress(activities);
  return { activities, filled, totalNeeded };
}

export async function disconnectStrava() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.STRAVA_ACCESS_TOKEN,
    STORAGE_KEYS.STRAVA_REFRESH_TOKEN,
    STORAGE_KEYS.STRAVA_EXPIRES_AT,
    STORAGE_KEYS.STRAVA_ATHLETE
  ]);
}
