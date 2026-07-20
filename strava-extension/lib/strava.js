import { STRAVA_API_BASE, STRAVA_WEB_BASE, STRAVA_AUTH_URL, STRAVA_TOKEN_URL, STORAGE_KEYS, ACTIVITY_TYPES } from './config.js';

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

// Map the many possible sport-type spellings the web endpoint may use onto the
// three types this app tracks. Returns null for anything we don't keep.
function normalizeSportType(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z]/g, '');
  if (s.includes('trail') && s.includes('run')) return 'TrailRun';
  if (s === 'run' || s === 'running') return 'Run';
  if (s === 'ride' || s === 'virtualride' || s === 'ebikeride' || s === 'cycling' || s === 'bike') return 'Ride';
  return null;
}

// Pull the first present value among several candidate keys.
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// Parse a distance that may arrive as raw meters (number) or a formatted string
// like "10.4 km" / "10,4 km". Returns kilometres as a fixed-2 string, or ''.
function toKm(raw, formatted) {
  if (typeof raw === 'number' && !isNaN(raw)) return (raw / 1000).toFixed(2);
  if (typeof formatted === 'string') {
    const n = parseFloat(formatted.replace(',', '.'));
    if (!isNaN(n)) return n.toFixed(2); // already km on the web display
  }
  return '';
}

// Read the activity id from a raw web model.
function webActivityId(m) {
  return pick(m, 'id', 'id_str', 'activity_id');
}

// Normalize one `training_activities` model to the app's activity shape.
// `Map_polyline` is intentionally left absent so backfillStreams() fills it.
// The web list carries no average heart rate; Moyenne_FC stays empty on this
// path (we no longer fetch HR streams — it got the account banned).
function normalizeWebActivity(m) {
  const sportType = normalizeSportType(pick(m, 'sport_type', 'type', 'activity_type', 'activity_type_display_name'));
  if (!sportType) return null;

  const id = webActivityId(m);
  if (id === undefined) return null;

  // Date: prefer the ISO `start_time` ("2026-07-06T10:30:37+0000"), else the
  // epoch-seconds `_raw` field. NEVER `start_date` — it is a localized display
  // string ("lun. 06/07/2026") that Date() cannot parse.
  let date = '';
  const iso = pick(m, 'start_time', 'start_date_local');
  if (typeof iso === 'string' && !isNaN(new Date(iso).getTime())) {
    date = new Date(iso).toISOString();
  } else {
    const epoch = pick(m, 'start_date_local_raw', 'start_date_raw');
    if (typeof epoch === 'number') date = new Date(epoch * 1000).toISOString();
  }

  const movingSec = pick(m, 'moving_time_raw', 'elapsed_time_raw');
  const elevRaw = pick(m, 'elevation_gain_raw', 'total_elevation_gain');

  const act = {
    ID: String(id),
    Nom: pick(m, 'name') || '',
    Type: sportType,
    Date: date,
    Distance_km: toKm(pick(m, 'distance_raw', 'distance_meters'), pick(m, 'distance')),
    Duree: typeof movingSec === 'number' ? secondsToHMS(movingSec) : (pick(m, 'moving_time', 'elapsed_time') || ''),
    D_plus: typeof elevRaw === 'number' ? Math.round(elevRaw) : (pick(m, 'elevation_gain') || ''),
    Lien_activite: pick(m, 'activity_url') || `https://www.strava.com/activities/${id}`,
    Moyenne_FC: '' // web list carries no average HR; only the API path fills this
    // Map_polyline omitted on purpose — backfillStreams() fills it from /streams.
  };
  // Hint from the list so the stream pass can skip activities with no track.
  if (m.has_latlng === false) act._noGps = true;
  return act;
}

/**
 * List the logged-in athlete's activities via Strava's internal web endpoint
 * (athlete/training_activities), authenticated by session cookies — no paid API
 * token. Paginates until every activity is seen. Returns activities normalized
 * to the app's shape and filtered to the tracked sport types.
 *
 * Activities are returned newest-first. When `knownIds` is provided, pagination
 * stops as soon as a whole page contains only already-known ids — that's the
 * incremental case (nothing new above the last sync), avoiding a full ~300-page
 * sweep of a large history on every refresh.
 *
 * Throws Error('session_expired') if Strava redirects to login.
 */
export async function fetchActivitiesWeb(onProgress = null, knownIds = null) {
  const allActivities = [];
  const perPage = 20; // the endpoint's native page size
  let page = 1;
  let loggedSample = false;
  let kept = 0, dropped = 0;

  while (true) {
    if (onProgress) onProgress({ page, fetched: allActivities.length });

    // Full param set the Training Log page itself sends — some are required for
    // the endpoint to return the activity list rather than an empty payload.
    const params = new URLSearchParams({
      keywords: '', activity_type: '', workout_type: '', commute: '',
      min_distance: '', max_distance: '', min_date: '', max_date: '',
      new_activity_only: 'false', item_type: 'activity',
      per_page: String(perPage), page: String(page)
    });
    const url = `${STRAVA_WEB_BASE}/athlete/training_activities?${params}`;

    const response = await fetch(url, {
      credentials: 'include',
      redirect: 'manual',
      // This endpoint historically answers text/javascript for XHR requests.
      headers: {
        'Accept': 'text/javascript, application/javascript, application/json, */*',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new Error('session_expired');
    }
    if (response.status === 401 || response.status === 403) throw new Error('session_expired');
    if (response.status === 429) throw new Error('Rate limit Strava atteint. Réessayez dans quelques minutes.');
    if (!response.ok) throw new Error(`Liste d'activités: HTTP ${response.status}`);

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Not JSON → almost certainly an HTML login/redirect page (logged out).
      console.warn(`[strava] training_activities page ${page}: non-JSON response (${raw.length}b). Snippet:`, raw.slice(0, 300));
      if (/login|sign.?in|authenticated/i.test(raw)) throw new Error('session_expired');
      throw new Error("Liste d'activités: réponse inattendue (non-JSON)");
    }

    const models = Array.isArray(data) ? data : (data.models || data.activities || []);
    console.log(`[strava] training_activities page ${page}: ${models.length} models (total=${data.total ?? '?'})`);

    // One-time raw-shape dump so field mappings can be verified/adjusted against
    // a real response (the endpoint is undocumented and its schema can drift).
    if (!loggedSample && models.length > 0) {
      console.log('[strava] training_activities sample model:', JSON.stringify(models[0]));
      loggedSample = true;
    }

    if (models.length === 0) break;

    for (const m of models) {
      const act = normalizeWebActivity(m);
      if (act) { allActivities.push(act); kept++; }
      else dropped++;
    }

    // Incremental stop: newest-first, so once a full page is entirely known we
    // have reached previously-synced history — nothing new remains below.
    if (knownIds && knownIds.size > 0) {
      const anyNew = models.some(m => {
        const id = webActivityId(m);
        return id !== undefined && !knownIds.has(String(id));
      });
      if (!anyNew) {
        console.log(`[strava] page ${page} fully known — stopping incremental fetch`);
        break;
      }
    }

    if (models.length < perPage) break;
    page++;
  }

  console.log(`[strava] fetchActivitiesWeb done: kept=${kept}, dropped(type filtered)=${dropped}`);
  return allActivities;
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
 * Fetch raw activity streams from Strava's internal web endpoint
 * (https://www.strava.com/activities/{id}/streams), authenticated by the
 * logged-in session cookies rather than the (now paid) API v3 token.
 *
 * Unlike the API, this endpoint returns an object keyed by stream type with
 * plain arrays, e.g. { latlng: [[lat,lng],...], heartrate: [...], time: [...] }.
 *
 * Returns the parsed object, or null on 404 (activity gone/private).
 * Throws:
 *   - Error('rate_limited') with `.retryAfter` on 429, so callers can pace.
 *   - Error('session_expired') when Strava redirects to login (no valid cookie).
 */
export async function fetchActivityStreams(activityId, types = ['latlng']) {
  const params = new URLSearchParams();
  for (const t of types) params.append('stream_types[]', t);
  const url = `${STRAVA_WEB_BASE}/activities/${activityId}/streams?${params}`;

  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'manual', // an auth redirect means "not logged in" — don't follow it
    headers: {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    }
  });

  // redirect:'manual' surfaces a 3xx as an opaque response (type 'opaqueredirect',
  // status 0). That only happens when the session cookie is missing/expired and
  // Strava bounces us to the login page.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new Error('session_expired');
  }
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) throw new Error('session_expired');
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After')) || 900;
    const err = new Error('rate_limited');
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!response.ok) throw new Error(`Stream ${activityId}: HTTP ${response.status}`);

  return response.json();
}

/**
 * Normalize the /streams payload to a plain { type: [values] } map, tolerating
 * the shapes the web endpoint may use:
 *   - { latlng: [[lat,lng],...], heartrate: [...] }         (keyed, plain arrays)
 *   - { latlng: { data: [...] }, ... }                       (keyed, wrapped)
 *   - [ { type: 'latlng', data: [...] }, ... ]               (list of streams)
 */
function normalizeStreams(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const s of raw) {
      if (s && s.type && Array.isArray(s.data)) out[s.type] = s.data;
    }
    return out;
  }
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (Array.isArray(v)) out[k] = v;
    else if (v && Array.isArray(v.data)) out[k] = v.data;
  }
  return out;
}

/**
 * Encode a raw latlng stream ([[lat,lng],...]) into a Google-encoded polyline
 * string — the same format the app stores in `Map_polyline` everywhere else
 * (GPX-parsed tracks and, formerly, the API's summary_polyline). Decimated to
 * keep storage bounded, matching the GPX import path.
 */
function polylineFromLatlng(latlng) {
  if (!Array.isArray(latlng) || latlng.length < 2) return null;
  return encodePolyline(decimatePoints(latlng, 500));
}

/**
 * Backfill the map polyline from the cookie-authenticated /streams endpoint,
 * one request per activity.
 *
 * The web activity list has no polyline, so we fetch the latlng stream for
 * every activity still missing a track. `_noGps` hints from the list let us
 * skip activities that can't yield a track. Persists every `saveEvery`
 * activities so a long run survives interruption; handles 429 by stopping and
 * resuming on the next refresh.
 *
 * We deliberately do NOT fetch heart rate here: repeatedly requesting the
 * heartrate stream trips Strava's anti-abuse and gets the account banned. HR
 * on the API path still comes from the activity summary (no extra request).
 *
 * Activities are mutated in place. Setting `Map_polyline` to null marks
 * "tried but no data" so we don't retry forever.
 */
export async function backfillStreams(activities, onProgress = null, saveProgress = null, saveEvery = 10) {
  const needsPoly = a => !('Map_polyline' in a) && !a._noGps;
  // Only sync activities that are missing their TRACK (the heatmap need) — these
  // are the newly-added ones; old activities already got tracks from the export
  // folder.
  const target = activities.filter(a => needsPoly(a));
  // Newest-first so the most recent gaps fill before the rate budget runs out.
  target.sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
  const totalNeeded = target.length;
  if (totalNeeded === 0) return { activities, filled: 0, totalNeeded: 0, rateLimited: false };

  let filled = 0;
  let polyOk = 0, polyNull = 0;
  let loggedSample = false;

  for (let i = 0; i < target.length; i++) {
    const a = target[i];
    if (onProgress) onProgress({ filled, totalNeeded, current: i + 1 });

    try {
      const raw = await fetchActivityStreams(a.ID, ['latlng']);
      if (raw === null) {
        // 404 — activity gone/private. Mark tried so we don't retry.
        a.Map_polyline = null; polyNull++;
      } else {
        const streams = normalizeStreams(raw);
        // One-time dump of the real stream shape for verification.
        if (!loggedSample) {
          console.log(`[strava] streams sample (act ${a.ID}): keys=${JSON.stringify(Object.keys(streams))}, ` +
            `latlng.len=${Array.isArray(streams.latlng) ? streams.latlng.length : 'n/a'}, ` +
            `latlng[0]=${JSON.stringify(streams.latlng?.[0])}`);
          loggedSample = true;
        }
        a.Map_polyline = polylineFromLatlng(streams.latlng);
        if (a.Map_polyline) polyOk++; else polyNull++;
      }
      filled++;
    } catch (e) {
      if (e.message === 'rate_limited') {
        // Strava's /streams rate limit (~100 req / 15 min). A long foreground
        // sleep isn't reliable in an MV3 service worker (it gets killed), so we
        // save what we have and stop; the next refresh resumes newest-first.
        if (saveProgress) await saveProgress(activities);
        console.warn(`[strava] rate limited after ${filled} fetch(es) — stopping. Retry in ~${e.retryAfter}s. polyline ok=${polyOk}`);
        return { activities, filled, totalNeeded, rateLimited: true, retryAfter: e.retryAfter, polyOk, polyNull };
      }
      if (e.message === 'session_expired') throw e; // bubble up — user must re-login on strava.com
      // Other error: mark as tried-failed to avoid hammering
      console.warn(`Stream fail for ${a.ID}:`, e.message);
      a.Map_polyline = null;
      filled++;
    }

    if (saveProgress && filled > 0 && filled % saveEvery === 0) {
      await saveProgress(activities);
    }

    // Be polite — a first run sweeps the whole history; rapid-fire requests can
    // trip Strava's anti-abuse before we ever see a 429.
    await new Promise(r => setTimeout(r, 120));
  }

  if (saveProgress) await saveProgress(activities);
  console.log(`[strava] backfillStreams done: filled=${filled}/${totalNeeded}, polyline ok=${polyOk} null=${polyNull}`);
  return { activities, filled, totalNeeded };
}

// ---------------------------------------------------------------------------
// Polyline encoding (Google encoded polyline algorithm — same format the GPX
// import path in the dashboard produces). Kept here so the service worker can
// encode latlng streams without importing dashboard code.
// ---------------------------------------------------------------------------

function decimatePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

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

export async function disconnectStrava() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.STRAVA_ACCESS_TOKEN,
    STORAGE_KEYS.STRAVA_REFRESH_TOKEN,
    STORAGE_KEYS.STRAVA_EXPIRES_AT,
    STORAGE_KEYS.STRAVA_ATHLETE
  ]);
}
