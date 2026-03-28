# Strava Performance Dashboard — Chrome Extension

## Prérequis

### 1. Créer une app Strava

1. Va sur https://www.strava.com/settings/api
2. Crée une nouvelle application
3. **Authorization Callback Domain** : mets `<extension-id>.chromiumapp.org`
   (tu obtiendras l'ID exact après avoir chargé l'extension, étape 4)
4. Note le **Client ID** et **Client Secret**

### 2. Configurer Google Cloud (pour Google Sheets)

1. Va sur https://console.cloud.google.com
2. Crée un projet (ou utilise un existant)
3. Active l'API **Google Sheets API**
4. Va dans **Identifiants** > **Créer des identifiants** > **ID client OAuth**
5. Type d'application : **Extension Chrome**
6. ID de l'élément : l'ID de ton extension (visible après chargement)
7. Copie le **Client ID** généré
8. Remplace `REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com` dans `manifest.json`

### 3. Charger l'extension dans Chrome

1. Ouvre `chrome://extensions/`
2. Active le **Mode développeur** (en haut à droite)
3. Clique **Charger l'extension non empaquetée**
4. Sélectionne le dossier `strava-extension/`
5. Note l'**ID de l'extension** affiché

### 4. Mettre à jour les callback URLs

- **Strava** : retourne dans les settings de ton app Strava et mets le domain callback :
  `<ton-extension-id>.chromiumapp.org`
- **Google** : l'ID client OAuth doit référencer le bon extension ID

### 5. Configurer dans l'extension

1. Clique sur l'icône de l'extension > **Paramètres**
2. Entre ton **Client ID** et **Client Secret** Strava > **Sauvegarder**
3. Clique **Se connecter** pour autoriser Strava
4. Clique **Créer un nouveau Sheet** (ou lie un existant)
5. Clique **Rafraîchir** pour importer tes activités!

## Structure

```
strava-extension/
├── manifest.json              # Manifest V3
├── background/
│   └── service-worker.js      # Logique API (Strava + Sheets)
├── lib/
│   ├── config.js              # Constantes
│   ├── strava.js              # Wrapper API Strava
│   └── sheets.js              # Wrapper API Google Sheets
├── popup/
│   ├── popup.html/js/css      # Mini popup (status + raccourcis)
├── dashboard/
│   ├── dashboard.html/js/css  # Dashboard complet (port de stats.html)
├── vendor/
│   ├── chart.min.js           # Chart.js (local)
│   └── luxon.min.js           # Luxon (local)
└── icons/
    └── icon{16,48,128}.png    # Icônes
```

## Données

Les activités sont stockées dans Google Sheets avec les colonnes :
`ID, Nom, Type, Date, Distance_km, Duree, D_plus, Lien_activite, Moyenne_FC`

Format identique au CSV original — compatible import/export.
