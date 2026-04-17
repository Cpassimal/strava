export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

export const ACTIVITY_TYPES = ['Run', 'TrailRun', 'Ride'];

export const CSV_HEADERS = [
  'ID', 'Nom', 'Type', 'Date', 'Distance_km', 'Duree', 'D_plus', 'Lien_activite', 'Moyenne_FC', 'Excluded'
];

export const STORAGE_KEYS = {
  STRAVA_CLIENT_ID: 'strava_client_id',
  STRAVA_CLIENT_SECRET: 'strava_client_secret',
  STRAVA_ACCESS_TOKEN: 'strava_access_token',
  STRAVA_REFRESH_TOKEN: 'strava_refresh_token',
  STRAVA_EXPIRES_AT: 'strava_expires_at',
  STRAVA_ATHLETE: 'strava_athlete',
  ACTIVITIES: 'activities',
  LAST_SYNC: 'last_sync',
  SEGMENTS_CACHE: 'segments_cache',
  LAST_SEARCH: 'last_search',
  SAVED_SEARCHES: 'saved_searches'
};

// Segment Explorer defaults
export const SEGMENT_DEFAULTS = {
  CENTER: { lat: 47.218, lng: -1.553 },  // Nantes
  RADIUS_KM: 3,
  MAX_RADIUS_KM: 10,
  MIN_DISTANCE_M: 400,
  MAX_DISTANCE_M: 5000
};

export const RATE_LIMIT = {
  MAX_REQUESTS: 95,
  WINDOW_MS: 15 * 60 * 1000,
  MAX_EXPLORE_CALLS: 900,
  MAX_DAILY: 1000
};

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // cache max (prune)
export const DETAIL_FRESH_MS = 2 * 60 * 60 * 1000;     // 2h — re-fetch si plus vieux
