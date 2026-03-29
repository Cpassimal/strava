# Strava Performance Dashboard

Extension Chrome qui connecte ton compte Strava et affiche un dashboard d'analyse de tes performances (course, trail, vélo).

## Fonctionnalités

- Synchronisation automatique de tes activités Strava
- Dashboard avec graphiques (distance, D+, fréquence cardiaque, etc.)
- Export / import CSV
- Données 100% en local (rien n'est envoyé à un serveur tiers)

## Installation

### 1. Créer une app Strava API

1. Va sur https://www.strava.com/settings/api
2. Remplis les champs :
   - **Application Name** : ce que tu veux (ex: "Mon Dashboard")
   - **Category** : "Data Importer"
   - **Club** : vide
   - **Website** : n'importe quoi (ex: `https://localhost`)
   - **Authorization Callback Domain** : laisser vide pour l'instant (on le remplira à l'étape 4)
3. Valide et note ton **Client ID** et **Client Secret**

### 2. Télécharger l'extension

```bash
git clone https://github.com/Cpassimal/strava.git
cd strava/strava-extension
```

### 3. Charger l'extension dans Chrome

1. Ouvre `chrome://extensions/` dans Chrome
2. Active le **Mode développeur** (toggle en haut à droite)
3. Clique **"Charger l'extension non empaquetée"**
4. Sélectionne le dossier `strava-extension/`
5. L'extension apparaît — note l'**ID** affiché (une longue chaîne de caractères)

### 4. Configurer le callback Strava

Retourne sur https://www.strava.com/settings/api et mets à jour le champ **Authorization Callback Domain** avec :

```
<ton-extension-id>.chromiumapp.org
```

Remplace `<ton-extension-id>` par l'ID copié à l'étape précédente.

### 5. Configurer l'extension

1. Clique sur l'icône de l'extension dans la barre Chrome
2. Clique **Paramètres**
3. Entre ton **Client ID** et **Client Secret** Strava
4. Clique **Sauvegarder**
5. Clique **Se connecter** — une fenêtre Strava s'ouvre pour autoriser l'accès
6. Une fois connecté, clique **Rafraîchir** pour importer tes activités

## Utilisation

- **Popup** : clic sur l'icône de l'extension pour voir le statut et synchroniser
- **Dashboard** : clic sur "Ouvrir le Dashboard" pour l'analyse complète
- **Export CSV** : depuis le dashboard, bouton d'export
- **Import CSV** : pour charger des données existantes

## Structure

```
strava-extension/
├── manifest.json           # Config extension (Manifest V3)
├── background/
│   └── service-worker.js   # Logique API Strava
├── lib/
│   ├── config.js           # Constantes
│   └── strava.js           # Wrapper API Strava
├── popup/
│   ├── popup.html/js/css   # Mini popup (statut + raccourcis)
├── dashboard/
│   ├── dashboard.html/js/css  # Dashboard complet
├── vendor/                 # Librairies JS (non versionné)
│   ├── chart.min.js
│   └── luxon.min.js
└── icons/                  # Icônes (non versionné)
```

## FAQ

**L'extension a accès à quoi sur mon Strava ?**
Uniquement en lecture : ton profil et tes activités. Elle ne peut rien modifier.

**Mes données vont où ?**
Nulle part. Tout est stocké en local dans Chrome (`chrome.storage`). Aucun serveur tiers.

**Pourquoi je dois créer ma propre app Strava ?**
Chaque utilisateur doit créer sa propre app Strava API pour obtenir ses propres identifiants. C'est une contrainte de l'API Strava — mais ça garantit aussi que personne d'autre n'a accès à tes tokens.

**"Rate limit atteint" ?**
L'API Strava limite à 100 requêtes / 15 min et 1000 / jour. Attends un peu et réessaye.
