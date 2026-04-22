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

/**
 * Fetch the current tile version from strava.com/maps.
 * Strava embeds it in the page JS, we grep for it.
 *
 * Returns { version, authStatus } — authStatus is one of:
 *   'ok'            — /maps loaded authenticated, tile version extracted
 *   'loggedOut'     — /maps redirected to /login (no session or cookies stripped)
 *   'formatChanged' — /maps loaded OK but the tile version pattern is gone
 *   'unknown'       — network error or non-ok status
 */
async function getTileVersion() {
  const now = Date.now();
  if (cachedTileVersion && (now - tileVersionFetchedAt) < VERSION_TTL_MS) {
    return { version: cachedTileVersion, authStatus: 'ok' };
  }
  try {
    if (chrome && chrome.cookies && chrome.cookies.getAll) {
      try {
        const all = [
          ...(await chrome.cookies.getAll({ domain: '.strava.com' })),
          ...(await chrome.cookies.getAll({ domain: 'strava.com' })),
          ...(await chrome.cookies.getAll({ domain: 'www.strava.com' }))
        ];
        const dedup = Array.from(new Map(all.map(c => [c.name + '|' + c.domain, c])).values());
        console.log('[DEBUG cookies] total strava.com cookies:', dedup.length);
        const interesting = dedup.filter(c => /session|auth|csrf|remember/i.test(c.name));
        console.log('[DEBUG cookies] session-like:', interesting.map(c => ({
          name: c.name,
          domain: c.domain,
          sameSite: c.sameSite,
          secure: c.secure,
          httpOnly: c.httpOnly,
          partitionKey: c.partitionKey,
          expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session'
        })));
      } catch (e) {
        console.warn('[DEBUG cookies] error:', e.message);
      }
    }
    const resp = await fetch('https://www.strava.com/maps', {
      credentials: 'include',
      headers: { 'Referer': 'https://www.strava.com/' }
    });

    const finalUrl = resp.url || '';
    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    console.log('[DEBUG /maps] status:', resp.status, 'finalUrl:', finalUrl, 'redirected:', resp.redirected);
    console.log('[DEBUG /maps] headers:', respHeaders);

    if (/\/(login|session|sign[_-]?in)/i.test(finalUrl)) {
      console.log('[DEBUG /maps] → loggedOut (finalUrl match)');
      return { version: DEFAULT_TILE_VERSION, authStatus: 'loggedOut' };
    }
    if (!resp.ok) {
      console.log('[DEBUG /maps] → unknown (!resp.ok)');
      return { version: DEFAULT_TILE_VERSION, authStatus: 'unknown' };
    }

    const html = await resp.text();
    const match = html.match(/\/tiles\/segments\/(\d+)\//);
    console.log('[DEBUG /maps] html.length:', html.length, 'tileVersionMatch:', match && match[0]);
    console.log('[DEBUG /maps] occurrences tile/segment:', {
      tiles_segments: (html.match(/tiles\/segments\/\d+/g) || []).slice(0, 5),
      tileVersion_kw: (html.match(/tile[_-]?version[^,}]{0,60}/gi) || []).slice(0, 5),
      mapVersion_kw: (html.match(/map[_-]?version[^,}]{0,60}/gi) || []).slice(0, 5),
      segmentTile: (html.match(/segment[_-]?tile[^,}]{0,60}/gi) || []).slice(0, 5)
    });
    console.log('[DEBUG /maps] title match:', (html.match(/<title>([^<]*)<\/title>/i) || [])[1]);
    console.log('[DEBUG /maps] body sample (head):', html.slice(0, 800));
    console.log('[DEBUG /maps] body sample (mid):', html.slice(Math.floor(html.length / 2), Math.floor(html.length / 2) + 800));
    console.log('[DEBUG /maps] markers:', {
      hasAuthToken: /name="authenticity_token"/i.test(html),
      hasSignIn: /(sign[_ -]?in|connecte[rz]|log[_ -]?in)/i.test(html),
      hasSubscribe: /subscribe|premium|upsell|abonn/i.test(html),
      hasHeatmap: /heatmap/i.test(html),
      hasChallenge: /challenge|verify|captcha|cloudflare/i.test(html)
    });

    if (match) {
      cachedTileVersion = parseInt(match[1], 10);
      tileVersionFetchedAt = now;
      console.log('[DEBUG /maps] → ok, version:', cachedTileVersion);
      return { version: cachedTileVersion, authStatus: 'ok' };
    }

    const looksLikeLogin = /name="authenticity_token"/i.test(html)
      && /(sign[_ -]?in|connecte[rz]|log[_ -]?in)/i.test(html);
    if (looksLikeLogin) {
      console.log('[DEBUG /maps] → loggedOut (login markers in HTML)');
      return { version: DEFAULT_TILE_VERSION, authStatus: 'loggedOut' };
    }
    console.log('[DEBUG /maps] → formatChanged (no match, no login markers)');
    return { version: DEFAULT_TILE_VERSION, authStatus: 'formatChanged' };
  } catch (err) {
    console.warn('[DEBUG /maps] fetch error:', err.message);
    return { version: DEFAULT_TILE_VERSION, authStatus: 'unknown' };
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
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Referer': 'https://www.strava.com/maps' }
      });

      if (resp.status === 401 || resp.status === 403) {
        stats.auth++;
        continue;
      }
      if (!resp.ok) {
        stats.error++;
        continue;
      }

      const buf = await resp.arrayBuffer();
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
