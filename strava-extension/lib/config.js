export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SHEET_HEADERS = [
  'ID', 'Nom', 'Type', 'Date', 'Distance_km', 'Duree', 'D_plus', 'Lien_activite', 'Moyenne_FC', 'Excluded'
];

export const ACTIVITY_TYPES = ['Run', 'TrailRun', 'Ride'];

export const STORAGE_KEYS = {
  STRAVA_CLIENT_ID: 'strava_client_id',
  STRAVA_CLIENT_SECRET: 'strava_client_secret',
  STRAVA_ACCESS_TOKEN: 'strava_access_token',
  STRAVA_REFRESH_TOKEN: 'strava_refresh_token',
  STRAVA_EXPIRES_AT: 'strava_expires_at',
  STRAVA_ATHLETE: 'strava_athlete',
  GOOGLE_SHEET_ID: 'google_sheet_id',
  LAST_SYNC: 'last_sync',
  CACHED_ACTIVITIES: 'cached_activities'
};
