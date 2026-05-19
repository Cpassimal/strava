# Strava Performance Dashboard

Extension Chrome qui connecte ton compte Strava et affiche un dashboard d'analyse de tes performances (course, trail, velo).

## Fonctionnalites

### Dashboard
- Synchronisation automatique de tes activites Strava
- Graphiques par periode (distance, D+, frequence cardiaque, performance, charge)
- Score de performance base sur la FC mediane (stream HR), robuste au warm-up et au drift cardiaque
- Charge d'entrainement (volume + D+ converti en plat equivalent)
- Filtrage par type d'activite, periode, distance, elevation
- Export / import CSV (compatible export officiel Strava)
- Donnees 100% en local (rien n'est envoye a un serveur tiers)

### Segment Explorer
- Exploration de segments Strava sur une carte interactive (Leaflet)
- Mode **Course** et **Velo** avec physique adaptee a chaque sport
- Recherche par zone geographique (clic carte, geocodage Nominatim)
- Filtres : distance, D+, pente, allure KOM (course) / vitesse KOM (velo)
- **Score de faisabilite KOM** : compare le KOM d'un segment a ton niveau actuel
  - Calcul base sur le GAP (Grade Adjusted Pace) avec modele Riegel adapte
  - Profil athlete construit automatiquement depuis tes activites recentes
  - Ratio affiche sur chaque segment : Battable / Realiste / Ambitieux / Hors portee
  - Filtre par slider double-curseur sur le ratio de faisabilite
- Sauvegarde et restauration de recherches (avec icone sport)
- Cache des details segments (evite les appels API redondants)
- Rate limiting respecte (100 req/15min, 1000/jour)

## Installation

### 1. Creer une app Strava API

1. Va sur https://www.strava.com/settings/api
2. Remplis les champs :
   - **Application Name** : ce que tu veux (ex: "Mon Dashboard")
   - **Category** : "Data Importer"
   - **Club** : vide
   - **Website** : n'importe quoi (ex: `https://localhost`)
   - **Authorization Callback Domain** : laisser vide pour l'instant (on le remplira a l'etape 4)
3. Valide et note ton **Client ID** et **Client Secret**

### 2. Telecharger l'extension

```bash
git clone https://github.com/Cpassimal/strava.git
cd strava/strava-extension
```

### 3. Charger l'extension dans Chrome

1. Ouvre `chrome://extensions/` dans Chrome
2. Active le **Mode developpeur** (toggle en haut a droite)
3. Clique **"Charger l'extension non empaquetee"**
4. Selectionne le dossier `strava-extension/`
5. L'extension apparait — note l'**ID** affiche (une longue chaine de caracteres)

### 4. Configurer le callback Strava

Retourne sur https://www.strava.com/settings/api et mets a jour le champ **Authorization Callback Domain** avec :

```
<ton-extension-id>.chromiumapp.org
```

Remplace `<ton-extension-id>` par l'ID copie a l'etape precedente.

### 5. Configurer l'extension

1. Clique sur l'icone de l'extension dans la barre Chrome
2. Clique **Parametres**
3. Entre ton **Client ID** et **Client Secret** Strava
4. Clique **Sauvegarder**
5. Clique **Se connecter** — une fenetre Strava s'ouvre pour autoriser l'acces
6. Une fois connecte, clique **Rafraichir** pour importer tes activites

## Utilisation

- **Popup** : clic sur l'icone de l'extension pour voir le statut et synchroniser
- **Dashboard** : clic sur "Ouvrir le Dashboard" pour l'analyse complete
- **Segment Explorer** : clic sur "Explorer les segments" pour la recherche de segments
- **Export CSV** : depuis le dashboard, bouton d'export
- **Import CSV** : pour charger des donnees existantes

### Segment Explorer — Mode d'emploi

1. Choisis ton sport (Course / Velo) en haut du panneau filtres
2. Clique sur la carte ou cherche un lieu pour definir la zone de recherche
3. Ajuste le rayon et les filtres (distance, pente, allure/vitesse, D+)
4. Clique **Rechercher** — l'extension explore la zone et recupere les details des segments
5. Les resultats s'affichent sur la carte et dans la liste laterale
6. Chaque segment affiche un badge de faisabilite si ton profil athlete est disponible
7. Les recherches sont sauvegardees automatiquement et restaurables

## Structure

```
strava-extension/
├── manifest.json              # Config extension (Manifest V3)
├── background/
│   └── service-worker.js      # Logique API Strava
├── lib/
│   ├── config.js              # Constantes et cles de stockage
│   ├── strava.js              # Wrapper API Strava
│   ├── geo.js                 # Utilitaires geo (bounds, haversine, polyline, formatage pace/vitesse)
│   └── gap.js                 # Grade Adjusted Pace : profils sport, Riegel, faisabilite KOM
├── popup/
│   ├── popup.html/js/css      # Mini popup (statut + raccourcis)
├── dashboard/
│   ├── dashboard.html/js/css  # Dashboard complet (graphiques, KPIs, activites)
├── explorer/
│   ├── explorer.html/js/css   # Segment Explorer (carte, filtres, resultats)
├── vendor/                    # Librairies JS
│   ├── chart.min.js
│   ├── luxon.min.js
│   └── leaflet.js + leaflet.css
└── icons/
    └── icon{16,48,128}.png
```

## FAQ

**L'extension a acces a quoi sur mon Strava ?**
Uniquement en lecture : ton profil et tes activites. Elle ne peut rien modifier.

**Mes donnees vont ou ?**
Nulle part. Tout est stocke en local dans Chrome (`chrome.storage`). Aucun serveur tiers.

**Pourquoi je dois creer ma propre app Strava ?**
Chaque utilisateur doit creer sa propre app Strava API pour obtenir ses propres identifiants. C'est une contrainte de l'API Strava — mais ca garantit aussi que personne d'autre n'a acces a tes tokens.

**"Rate limit atteint" ?**
L'API Strava limite a 100 requetes / 15 min et 1000 / jour. L'extension gere automatiquement les pauses. En cas de rate limit Strava (429), elle attend 60s avant de reprendre.

**Comment fonctionne le score de faisabilite ?**
Le score compare le KOM d'un segment a ton niveau estime. Il utilise le GAP (allure ajustee au denivele) pour normaliser les efforts, la formule de Riegel pour projeter ta vitesse a la distance du segment, et un facteur d'effort training/race. Le ratio resultant indique si le KOM est a ta portee (< 1.0), realiste (~1.0), ambitieux (1.0-1.2) ou hors portee (> 1.2).

**Comment fonctionne le score de performance du dashboard ?**
La formule est `score = 3.5 × (vitesse_equivalente × bonus_endurance) / hrEffort^expHR` ou :
- `vitesse_equivalente = (distance + D+/100) / duree` — convertit le D+ en distance equivalente (1 km de D+ = 10 km plat, regle de pouce traileur, fixe)
- `bonus_endurance = 1 + distance/110` — recompense moderement les longues sorties (20km gagne +8% vs 2x10km, fixe)
- `hrEffort = (FC_mediane - FC_repos) / (FC_max - FC_repos)` — % de la reserve cardiaque
- `expHR` : exposant de la penalite cardio (parametre manuel, defaut 1.0 = lineaire ; 0.5 = doux, 1.5 = fort)
- Le facteur 3.5 cale les valeurs typiques sur 0-100 (sans plafond dur)

**Pourquoi FC mediane et pas FC moyenne ?**
La FC moyenne est biaisee : un warm-up en EF tire la moyenne vers le bas sur les sorties courtes, et le HR drift (deshydratation, fatigue) la tire vers le haut sur les longues. La FC mediane est robuste a ces deux biais. Elle est calculee a partir du stream HR seconde par seconde, recupere **automatiquement au refresh** (1 appel API par activite, rate limit Strava gere). Compter ~1h en arriere-plan pour la premiere synchro (~350 activites), ensuite c'est instantane pour les nouvelles activites. Un petit point vert dans la colonne FC du tableau indique les activites synchronisees ; gris = en attente. Si la mediane n'est pas disponible, le score utilise la FC moyenne du resume Strava en fallback.
