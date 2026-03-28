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

async function ensureValidToken() {
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
        Moyenne_FC: act.average_heartrate || ''
      });
    }

    if (activities.length < perPage) break;
    page++;
  }

  return allActivities;
}

export async function disconnectStrava() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.STRAVA_ACCESS_TOKEN,
    STORAGE_KEYS.STRAVA_REFRESH_TOKEN,
    STORAGE_KEYS.STRAVA_EXPIRES_AT,
    STORAGE_KEYS.STRAVA_ATHLETE
  ]);
}
