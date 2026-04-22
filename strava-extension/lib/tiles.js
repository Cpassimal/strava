/**
 * Strava segment tiles — undocumented tile endpoint for exhaustive segment discovery.
 * Returns MVT (Mapbox Vector Tiles) with full segment data including geometry.
 */

// ── Tile math (Web Mercator) ────────────────────────────────────────────────

export function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

export function getTilesForBounds(sw, ne, zoom) {
  const min = latLngToTile(ne.lat, sw.lng, zoom);
  const max = latLngToTile(sw.lat, ne.lng, zoom);
  const tiles = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}

/** Convert tile pixel coordinates to lat/lng. */
function tilePixelToLatLng(tileX, tileY, zoom, px, py, extent) {
  const n = Math.pow(2, zoom);
  const lng = (tileX + px / extent) / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + py / extent) / n)));
  const lat = latRad * 180 / Math.PI;
  return [lat, lng];
}

/** Pick zoom level based on search radius to balance coverage vs tile count. */
function zoomForRadius(radiusKm) {
  if (radiusKm <= 3) return 16;    // ~600m tiles, ~100 tiles for 3km
  if (radiusKm <= 10) return 15;   // ~1.2km tiles, ~100 tiles for 10km
  if (radiusKm <= 30) return 14;   // ~2.5km tiles, ~150 tiles for 30km
  return 13;                        // ~5km tiles
}

// ── Tile fetching ───────────────────────────────────────────────────────────

const DEFAULT_TILE_VERSION = 87224798;  // fallback only
let cachedTileVersion = null;
let tileVersionFetchedAt = 0;
const VERSION_TTL_MS = 60 * 60 * 1000;   // re-fetch every hour

// Chrome partitions cookies by top-level site; session cookies set during
// normal strava.com navigation are not visible to extension-origin fetches.
// We sidestep this by proxying fetches through a strava.com tab via
// chrome.scripting — the fetch then runs first-party and cookies flow.
let stravaTabId = null;

/** Find a user-opened strava.com tab. We deliberately do NOT open one
 *  ourselves: Chrome 147+ partitions cookies for extension-created tabs
 *  onto the extension's origin, so session cookies don't flow. Only
 *  user-navigated tabs reliably carry first-party strava.com cookies. */
async function getStravaTabId() {
  if (stravaTabId != null) {
    try {
      const t = await chrome.tabs.get(stravaTabId);
      if (t && /strava\.com/.test(t.url || '')) return stravaTabId;
    } catch { /* tab gone */ }
    stravaTabId = null;
  }
  // Broad match: any window, any strava.com page (www, app, subdomains).
  const queried = await Promise.all([
    chrome.tabs.query({ url: '*://www.strava.com/*' }),
    chrome.tabs.query({ url: '*://*.strava.com/*' }),
    chrome.tabs.query({ url: '*://strava.com/*' })
  ]);
  const all = queried.flat();
  const dedup = Array.from(new Map(all.map(t => [t.id, t])).values());
  console.log('[tiles] strava.com tabs found:', dedup.map(t => ({ id: t.id, url: t.url, status: t.status, windowId: t.windowId, incognito: t.incognito })));
  if (!dedup.length) throw new Error('NO_STRAVA_TAB');
  const picked = dedup.find(t => t.status === 'complete' && /^https:\/\/www\.strava\.com\//.test(t.url || ''))
    || dedup.find(t => t.status === 'complete')
    || dedup[0];
  console.log('[tiles] using tab', picked.id, picked.url);
  stravaTabId = picked.id;
  return stravaTabId;
}

export async function closeStravaProxyTab() {
  stravaTabId = null;
}

/** Fetch a strava.com URL from within a strava.com tab context so session
 *  cookies are sent. Returns { status, finalUrl, body } where body is a
 *  string (text mode) or base64 (binary mode), or { error } on failure. */
async function stravaFetch(url, { binary = false } = {}) {
  const tabId = await getStravaTabId();
  const [entry] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [url, binary],
    func: async (u, bin) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const status = r.status;
        const finalUrl = r.url;
        const docCookieSummary = (document.cookie || '').split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
        if (bin) {
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          return { status, finalUrl, body: btoa(s), docCookieSummary };
        }
        return { status, finalUrl, body: await r.text(), docCookieSummary };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    }
  });
  return entry && entry.result ? entry.result : { error: 'no script result' };
}

function base64ToArrayBuffer(b64) {
  const binStr = atob(b64);
  const buf = new ArrayBuffer(binStr.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binStr.length; i++) view[i] = binStr.charCodeAt(i);
  return buf;
}

/**
 * Fetch the current tile version from strava.com/maps.
 * Strava embeds it in the page JS, we grep for it.
 *
 * Returns { version, authStatus } — authStatus is one of:
 *   'ok'            — /maps loaded authenticated, tile version extracted
 *   'loggedOut'     — /maps redirected to /login (no session or cookies stripped)
 *   'formatChanged' — /maps loaded OK but the tile version pattern is gone
 *   'noTab'         — couldn't find or open a strava.com tab to proxy through
 *   'unknown'       — network error or non-ok status
 */
async function getTileVersion() {
  const now = Date.now();
  if (cachedTileVersion && (now - tileVersionFetchedAt) < VERSION_TTL_MS) {
    return { version: cachedTileVersion, authStatus: 'ok' };
  }
  try {
    const r = await stravaFetch('https://www.strava.com/maps', { binary: false });
    if (r.error) {
      console.warn('[tiles] stravaFetch /maps error:', r.error);
      return { version: DEFAULT_TILE_VERSION, authStatus: /tab|NO_STRAVA_TAB/i.test(r.error) ? 'noTab' : 'unknown' };
    }

    console.log('[tiles] /maps via tab →', {
      status: r.status,
      finalUrl: r.finalUrl,
      htmlLen: (r.body || '').length,
      hasTileVersion: /\/tiles\/segments\/(\d+)\//.test(r.body || ''),
      docCookies: r.docCookieSummary
    });

    const finalUrl = r.finalUrl || '';
    if (/\/(login|session|sign[_-]?in)/i.test(finalUrl)) {
      return { version: DEFAULT_TILE_VERSION, authStatus: 'loggedOut' };
    }
    if (r.status < 200 || r.status >= 300) {
      return { version: DEFAULT_TILE_VERSION, authStatus: 'unknown' };
    }

    const html = r.body || '';
    const match = html.match(/\/tiles\/segments\/(\d+)\//);
    if (match) {
      cachedTileVersion = parseInt(match[1], 10);
      tileVersionFetchedAt = now;
      return { version: cachedTileVersion, authStatus: 'ok' };
    }

    const looksLikeLogin = /name="authenticity_token"/i.test(html)
      && /(sign[_ -]?in|connecte[rz]|log[_ -]?in)/i.test(html);
    if (looksLikeLogin) {
      return { version: DEFAULT_TILE_VERSION, authStatus: 'loggedOut' };
    }
    return { version: DEFAULT_TILE_VERSION, authStatus: 'formatChanged' };
  } catch (err) {
    console.warn('getTileVersion error:', err.message);
    const msg = err.message || '';
    const isTabIssue = /Cannot access|No tab|scripting|permission|tab/i.test(msg);
    return { version: DEFAULT_TILE_VERSION, authStatus: isTabIssue ? 'noTab' : 'unknown' };
  }
}

/**
 * Fetch segments from Strava's tile endpoint for a given area.
 *
 * @param {{ sw: {lat,lng}, ne: {lat,lng} }} bounds
 * @param {string} sport  'running' or 'riding'
 * @param {number} radiusKm  Search radius in km (for zoom selection)
 * @param {function} [onProgress]  Optional callback(done, total, segCount)
 * @returns {Promise<Array>}  Array of segment objects
 */
export async function fetchTileSegments(bounds, sport, radiusKm, onProgress, surface) {
  const sportType = sport === 'riding' ? 'Ride' : 'Run';
  const zoom = zoomForRadius(radiusKm || 3);
  const tiles = getTilesForBounds(bounds.sw, bounds.ne, zoom);
  const surfaceTypes = surface != null ? String(surface) : '0';
  const { version: tileVersion, authStatus: versionAuthStatus } = await getTileVersion();
  const segmentsMap = new Map();

  const stats = { ok: 0, empty: 0, auth: 0, error: 0, versionAuthStatus };

  for (let ti = 0; ti < tiles.length; ti++) {
    const tile = tiles[ti];
    if (onProgress) onProgress(ti, tiles.length, segmentsMap.size);
    try {
      const params = new URLSearchParams({
        intent: 'popular',
        elevation_filter: 'all',
        surface_types: surfaceTypes,
        sport_types: sportType
      });

      const url = `https://www.strava.com/tiles/segments/${tileVersion}/${tile.z}/${tile.x}/${tile.y}?${params}`;
      const r = await stravaFetch(url, { binary: true });

      if (r.error) {
        stats.error++;
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        stats.auth++;
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        stats.error++;
        continue;
      }

      const buf = base64ToArrayBuffer(r.body || '');
      if (buf.byteLength === 0) {
        stats.empty++;
        continue;
      }

      const segments = decodeMvtSegments(buf, tile);
      stats.ok++;
      for (const seg of segments) {
        if (!segmentsMap.has(seg.id)) {
          segmentsMap.set(seg.id, seg);
        }
      }
    } catch (err) {
      stats.error++;
      console.warn(`Tile ${tile.z}/${tile.x}/${tile.y} error:`, err.message);
    }
  }

  return { segments: Array.from(segmentsMap.values()), stats };
}

// ── MVT decoder ─────────────────────────────────────────────────────────────

function decodeMvtSegments(buffer, tile) {
  const segments = [];
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return segments;

  try {
    const tileMsg = readMessage(bytes, 0, bytes.length);
    const layers = tileMsg[3] || [];

    for (const layerBytes of layers) {
      const layer = readMessage(layerBytes, 0, layerBytes.length);
      const keys = (layer[3] || []).map(b => readString(b));
      const values = (layer[4] || []).map(b => decodeValue(b));
      const extent = (layer[5] && layer[5].length > 0) ? layer[5][0] : 4096;
      const features = layer[2] || [];

      for (const featBytes of features) {
        const feat = readMessage(featBytes, 0, featBytes.length);

        // Extract properties from tags
        const props = {};
        const tagsRaw = feat[2] || [];
        const tags = tagsRaw.length > 0 && tagsRaw[0] instanceof Uint8Array
          ? decodePackedVarints(tagsRaw[0])
          : tagsRaw;
        for (let i = 0; i < tags.length - 1; i += 2) {
          const key = keys[tags[i]];
          const val = values[tags[i + 1]];
          if (key != null && val != null) props[key] = val;
        }

        const segId = props.segmentId || (feat[1] && feat[1].length > 0 ? feat[1][0] : null);
        if (!segId) continue;

        // Decode geometry
        const geomRaw = feat[4] || [];
        const geomData = geomRaw.length > 0 && geomRaw[0] instanceof Uint8Array
          ? decodePackedVarints(geomRaw[0])
          : geomRaw;
        const points = decodeLineString(geomData, tile, extent);

        segments.push({
          id: segId,
          name: props.name || '',
          distance: props.distance || 0,
          avg_grade: props.avgGrade || 0,
          elev_difference: props.elevGain || 0,
          points: null,
          _decodedPoints: points,
          start_latlng: points.length > 0 ? points[0] : null,
          end_latlng: points.length > 0 ? points[points.length - 1] : null,
          _tileData: {
            komElapsedTime: props.komElapsedTime,
            qomElapsedTime: props.qomElapsedTime,
            elevHigh: props.elevHigh,
            elevLow: props.elevLow,
            athletesAllTime: props.athletesAllTime,
            attemptsAllTime: props.attemptsAllTime
          }
        });
      }
    }
  } catch (err) {
    console.warn('MVT decode error:', err.message);
  }

  return segments;
}

/** Decode MVT geometry commands to [[lat, lng], ...] for a LineString. */
function decodeLineString(commands, tile, extent) {
  const points = [];
  let cx = 0, cy = 0;
  let i = 0;

  while (i < commands.length) {
    const cmdInt = commands[i++];
    const cmd = cmdInt & 0x7;
    const count = cmdInt >> 3;

    if (cmd === 1 || cmd === 2) {
      for (let j = 0; j < count && i + 1 < commands.length; j++) {
        const dx = signedDecode(commands[i++]);
        const dy = signedDecode(commands[i++]);
        cx += dx;
        cy += dy;
        points.push(tilePixelToLatLng(tile.x, tile.y, tile.z, cx, cy, extent));
      }
    } else if (cmd === 7) {
      // ClosePath — skip
    } else {
      break;
    }
  }

  return points;
}

/**
 * Zigzag decode for MVT geometry parameters.
 * MVT uses unsigned varints with zigzag encoding for signed deltas.
 */
function signedDecode(n) {
  return ((n >>> 1) ^ (-(n & 1))) | 0;
}

// ── Protobuf primitives ─────────────────────────────────────────────────────

function readMessage(bytes, start, end) {
  const fields = {};
  let pos = start;

  while (pos < end) {
    if (pos >= bytes.length) break;
    const [tag, newPos] = readVarint(bytes, pos);
    if (newPos === pos) break; // safety
    pos = newPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (!fields[fieldNum]) fields[fieldNum] = [];

    if (wireType === 0) {
      const [val, np] = readVarint(bytes, pos);
      pos = np;
      fields[fieldNum].push(val);
    } else if (wireType === 2) {
      const [len, np] = readVarint(bytes, pos);
      pos = np;
      if (pos + len > end) break; // safety
      fields[fieldNum].push(bytes.subarray(pos, pos + len));
      pos += len;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      fields[fieldNum].push(bytes.subarray(pos, pos + 8));
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      fields[fieldNum].push(bytes.subarray(pos, pos + 4));
      pos += 4;
    } else {
      break;
    }
  }

  return fields;
}

function readVarint(bytes, pos) {
  let result = 0;
  let shift = 0;
  let b;
  const startPos = pos;
  do {
    if (pos >= bytes.length) return [result >>> 0, pos];
    b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) return [result >>> 0, pos]; // safety for malformed data
  } while (b >= 0x80);
  return [result >>> 0, pos];
}

function decodePackedVarints(bytes) {
  const values = [];
  let pos = 0;
  while (pos < bytes.length) {
    const [val, np] = readVarint(bytes, pos);
    if (np === pos) break;
    pos = np;
    values.push(val);
  }
  return values;
}

function readString(bytes) {
  return new TextDecoder().decode(bytes);
}

function decodeValue(bytes) {
  const msg = readMessage(bytes, 0, bytes.length);
  // string_value (field 1, wire type 2)
  if (msg[1] && msg[1].length > 0 && msg[1][0] instanceof Uint8Array) return readString(msg[1][0]);
  // float_value (field 2, wire type 5)
  if (msg[2] && msg[2].length > 0 && msg[2][0] instanceof Uint8Array) {
    return new DataView(msg[2][0].buffer, msg[2][0].byteOffset, 4).getFloat32(0, true);
  }
  // double_value (field 3, wire type 1)
  if (msg[3] && msg[3].length > 0 && msg[3][0] instanceof Uint8Array) {
    return new DataView(msg[3][0].buffer, msg[3][0].byteOffset, 8).getFloat64(0, true);
  }
  // int_value (field 4, wire type 0)
  if (msg[4] && msg[4].length > 0) return msg[4][0];
  // uint_value (field 5, wire type 0)
  if (msg[5] && msg[5].length > 0) return msg[5][0];
  // sint_value (field 6, wire type 0)
  if (msg[6] && msg[6].length > 0) return signedDecode(msg[6][0]);
  // bool_value (field 7, wire type 0)
  if (msg[7] && msg[7].length > 0) return msg[7][0] !== 0;
  return null;
}
