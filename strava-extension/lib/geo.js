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
 * Parse a time string like "5:34" or "1:23:45" to total seconds.
 */
export function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
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
