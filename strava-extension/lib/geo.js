/**
 * Convert center point + radius to a bounding box.
 */
export function centerRadiusToBounds(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.32;
  const lngDelta = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  return {
    sw: { lat: lat - latDelta, lng: lng - lngDelta },
    ne: { lat: lat + latDelta, lng: lng + lngDelta }
  };
}

/**
 * Subdivide a bounding box into 4 quadrants.
 */
export function subdivideBox(sw, ne) {
  const midLat = (sw.lat + ne.lat) / 2;
  const midLng = (sw.lng + ne.lng) / 2;
  return [
    { sw: { lat: sw.lat, lng: sw.lng }, ne: { lat: midLat, lng: midLng } },
    { sw: { lat: sw.lat, lng: midLng }, ne: { lat: midLat, lng: ne.lng } },
    { sw: { lat: midLat, lng: sw.lng }, ne: { lat: ne.lat, lng: midLng } },
    { sw: { lat: midLat, lng: midLng }, ne: { lat: ne.lat, lng: ne.lng } }
  ];
}

/**
 * Haversine distance in km between two points.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Keep only segments whose start OR end point lies within `radiusKm` of the center.
 * Used because tile queries return square regions — we want a circular mask.
 */
export function filterSegmentsByRadius(segments, centerLat, centerLng, radiusKm) {
  return segments.filter(seg => {
    const startIn = seg.start_latlng
      && haversineKm(centerLat, centerLng, seg.start_latlng[0], seg.start_latlng[1]) <= radiusKm;
    const endIn = seg.end_latlng
      && haversineKm(centerLat, centerLng, seg.end_latlng[0], seg.end_latlng[1]) <= radiusKm;
    return startIn || endIn;
  });
}

/**
 * Decode a Google-encoded polyline string into [[lat, lng], ...].
 */
export function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Format bounds as Strava API expects: "sw.lat,sw.lng,ne.lat,ne.lng"
 */
export function boundsToString(sw, ne) {
  return `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`;
}

/**
 * Parse a time string to total seconds.
 * Supports: "5:34", "1:23:45", "52s", "1m30s", "2m", "1h05m30s"
 */
export function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();

  // Try "XhYmZs" / "YmZs" / "Xs" / "Ym" format
  const hmsMatch = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    return (parseInt(hmsMatch[1] || 0)) * 3600
      + (parseInt(hmsMatch[2] || 0)) * 60
      + (parseInt(hmsMatch[3] || 0));
  }

  // Try "M:SS" or "H:MM:SS" format
  const parts = str.split(':').map(Number);
  if (!parts.some(isNaN)) {
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
  }

  // Try bare number (seconds)
  const num = parseFloat(str);
  if (!isNaN(num)) return Math.round(num);

  return null;
}

/**
 * Format seconds as "M:SS" or "H:MM:SS".
 */
export function formatSeconds(totalSec) {
  if (totalSec == null) return '—';
  totalSec = Math.round(totalSec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format pace as "M:SS /km" from seconds per km.
 */
export function formatPace(secPerKm) {
  if (secPerKm == null || !isFinite(secPerKm)) return '—';
  return formatSeconds(secPerKm) + ' /km';
}

/**
 * Format speed as "XX.X km/h" from seconds per km.
 */
export function formatSpeed(secPerKm) {
  if (secPerKm == null || !isFinite(secPerKm) || secPerKm <= 0) return '—';
  const kmh = 3600 / secPerKm;
  return kmh.toFixed(1) + ' km/h';
}
