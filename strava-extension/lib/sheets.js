import { SHEETS_API_BASE, SHEET_HEADERS, STORAGE_KEYS } from './config.js';

async function getGoogleToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function sheetsRequest(path, options = {}) {
  const token = await getGoogleToken();
  const response = await fetch(`${SHEETS_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Google Sheets API error: ${response.status} - ${error.error?.message || 'Unknown'}`);
  }
  return response.json();
}

export async function createSpreadsheet(title = 'Strava Activities') {
  const token = await getGoogleToken();
  const response = await fetch(SHEETS_API_BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: { title },
      sheets: [{
        properties: { title: 'Activities' },
        data: [{
          startRow: 0,
          startColumn: 0,
          rowData: [{
            values: SHEET_HEADERS.map(h => ({ userEnteredValue: { stringValue: h } }))
          }]
        }]
      }]
    })
  });

  if (!response.ok) throw new Error('Impossible de créer le Google Sheet');
  const sheet = await response.json();
  const sheetId = sheet.spreadsheetId;

  await chrome.storage.local.set({ [STORAGE_KEYS.GOOGLE_SHEET_ID]: sheetId });
  return sheetId;
}

export async function getSheetId() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.GOOGLE_SHEET_ID);
  return data[STORAGE_KEYS.GOOGLE_SHEET_ID] || null;
}

async function getFirstSheetName(sheetId) {
  const meta = await sheetsRequest(`/${sheetId}?fields=sheets.properties.title`);
  return meta.sheets[0].properties.title;
}

async function ensureHeaders(sheetId, sheetName) {
  const range = `'${sheetName}'!A1:I1`;
  const data = await sheetsRequest(`/${sheetId}/values/${encodeURIComponent(range)}`);
  if (!data.values || data.values.length === 0 || data.values[0][0] !== 'ID') {
    await sheetsRequest(`/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [SHEET_HEADERS] })
    });
  }
}

export async function readActivities() {
  const sheetId = await getSheetId();
  if (!sheetId) return [];

  try {
    const sheetName = await getFirstSheetName(sheetId);
    const range = `'${sheetName}'!A2:I`;
    const data = await sheetsRequest(`/${sheetId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`);
    if (!data.values || data.values.length === 0) return [];

    return data.values.map(row => ({
      ID: row[0] || '',
      Nom: row[1] || '',
      Type: row[2] || '',
      Date: row[3] || '',
      Distance_km: row[4] || '',
      Duree: row[5] || '',
      D_plus: row[6] || '',
      Lien_activite: row[7] || '',
      Moyenne_FC: row[8] || ''
    }));
  } catch (e) {
    if (e.message.includes('404')) {
      return [];
    }
    throw e;
  }
}

export async function appendActivities(activities) {
  if (!activities.length) return;
  const sheetId = await getSheetId();
  if (!sheetId) throw new Error('Aucun Google Sheet configuré');

  const sheetName = await getFirstSheetName(sheetId);
  await ensureHeaders(sheetId, sheetName);

  const values = activities.map(a => [
    String(a.ID),
    a.Nom,
    a.Type,
    a.Date,
    String(a.Distance_km),
    a.Duree,
    String(a.D_plus),
    a.Lien_activite,
    String(a.Moyenne_FC)
  ]);

  const range = `'${sheetName}'!A:I`;
  await sheetsRequest(`/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values })
  });
}

export async function disconnectGoogle() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

export async function linkExistingSheet(sheetId) {
  // Verify the sheet is accessible
  await sheetsRequest(`/${sheetId}?fields=properties.title`);
  await chrome.storage.local.set({ [STORAGE_KEYS.GOOGLE_SHEET_ID]: sheetId });
}
