# Strava Performance Dashboard — Chrome Extension

## Prérequis

### 1. Créer une app Strava

1. Va sur https://www.strava.com/settings/api
2. Crée une nouvelle application
3. **Authorization Callback Domain** : `hfdidibplabogcfajeagpnoobjjgpelb.chromiumapp.org`
4. Note le **Client ID** et **Client Secret**

> L'extension a un ID figé via le champ `key` du manifest, donc le même
> callback domain marche sur tous les Chrome / tous les PCs où tu charges
> ce dossier.

### 2. Charger l'extension dans Chrome

1. Ouvre `chrome://extensions/`
2. Active le **Mode développeur** (en haut à droite)
3. Clique **Charger l'extension non empaquetée**
4. Sélectionne le dossier `strava-extension/`
5. Vérifie l'ID affiché : `hfdidibplabogcfajeagpnoobjjgpelb`

### 3. Configurer dans l'extension

1. Clique sur l'icône de l'extension > **Paramètres**
2. Entre ton **Client ID** et **Client Secret** Strava > **Sauvegarder**
3. Clique **Se connecter** pour autoriser Strava
4. Clique **Rafraîchir** pour importer tes activités

## Données

Tout est stocké **localement** dans `chrome.storage.local` (extension Chrome).
Aucune donnée n'est envoyée vers un service tiers (hors Strava pour l'API).

## Structure

```
strava-extension/
├── manifest.json              # Manifest V3 (avec key figée)
├── background/
│   └── service-worker.js      # Logique API Strava
├── lib/
│   ├── config.js              # Constantes
│   ├── strava.js              # Wrapper API Strava
│   └── geo.js                 # Décodage polylines
├── popup/
│   └── popup.html/js/css      # Mini popup (status + raccourcis)
├── dashboard/
│   └── dashboard.html/js/css  # Dashboard complet
├── explorer/
│   └── explorer.html/js/css   # Explorateur cartographique
├── vendor/
│   ├── chart.min.js           # Chart.js
│   ├── luxon.min.js           # Luxon
│   └── leaflet.{js,css}       # Leaflet
└── icons/
    └── icon{16,48,128}.png    # Icônes
```

## Clé privée

La clé privée correspondant au champ `key` du manifest est stockée dans
`../strava-ext-key.pem` (gitignoré). Garde-la précieusement : elle te
permet de regénérer le même ID si jamais tu perds le manifest.
