# Privacy Policy — Strava Performance Dashboard

**Last updated:** 2026-03-29

## Overview

Strava Performance Dashboard is a Chrome extension that displays your Strava activities in a personal analytics dashboard. Your privacy is important — this extension is designed to keep your data local.

## Data collected

This extension accesses the following data from the Strava API:
- Your athlete profile (first name, last name)
- Your activities (name, type, date, distance, duration, elevation gain, heart rate, activity ID)

## How data is stored

- All data is stored **locally on your device** using Chrome's `chrome.storage.local` API.
- Your Strava API credentials (Client ID, Client Secret) and OAuth tokens are also stored locally.
- **No data is transmitted to any server other than Strava's official API** (`www.strava.com`).

## Third-party services

This extension communicates only with:
- **Strava API** (`https://www.strava.com/api/v3/`) — to authenticate and fetch your activities

No analytics, tracking, or telemetry services are used.

## Data sharing

Your data is **never shared, sold, or transmitted** to any third party.

## Data deletion

You can disconnect your Strava account at any time via the extension settings, which removes all stored tokens. To fully remove all data, uninstall the extension.

## Permissions

| Permission | Reason |
|---|---|
| `identity` | Required for Strava OAuth authentication flow |
| `storage` | Store your activities and preferences locally |
| `unlimitedStorage` | Allow caching of large activity histories |
| `host_permissions: strava.com` | Communicate with the Strava API |

## Contact

For questions about this privacy policy, please open an issue on the project's GitHub repository.
