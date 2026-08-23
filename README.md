# Carnets d'Ascension

Un petit site pour comparer les stats Strava de la famille : distance, dénivelé,
nombre de sorties et vitesse moyenne, avec un classement par semaine / mois /
année / depuis toujours — une carte interactive qui superpose les tracés
GPS de tout le monde, une couleur par membre — et un tableau comparatif des
records vélo sur les distances de référence (5 miles, 10 km, 20 km, 40 km,
50 km, 100 km).

Chaque membre de la famille connecte **son propre compte Strava** via
l'écran d'autorisation officiel. Une nouvelle demande de connexion reste **en
attente** jusqu'à ce qu'un administrateur l'accepte. Le site est protégé par
un code d'accès partagé, et le mode admin par un second code séparé.

## Architecture

- **Render** (gratuit) fait tourner le site (Node.js / Express).
- **Supabase** (gratuit, sans limite de temps) stocke les données dans une
  vraie base PostgreSQL — comptes connectés, activités importées.

Deux services séparés, tous deux gratuits en continu, chacun spécialisé dans
son rôle (exécuter le code / stocker les données).

## 1. Créer une application Strava

1. Va sur https://www.strava.com/settings/api et crée une application.
2. Dans "Authorization Callback Domain", mets le nom de domaine de ton site
   **sans** `https://` ni chemin :
   - en local : `localhost`
   - une fois déployé : `ton-domaine.example`
3. Note le **Client ID** et le **Client Secret**.

## 2. Créer la base de données sur Supabase

1. Va sur https://supabase.com, crée un compte gratuit, puis un nouveau projet.
2. Choisis un mot de passe pour la base (note-le, tu en as besoin juste après).
3. Une fois le projet créé, clique sur **Connect** (en haut de l'écran du
   projet), puis choisis l'onglet **Transaction pooler** (pas "Direct
   connection", qui est en IPv6 et ne fonctionne pas depuis Render). Copie
   l'adresse (elle ressemble à
   `postgres://postgres.xxxx:[YOUR-PASSWORD]@aws-0-xxxx.pooler.supabase.com:6543/postgres`).
4. Remplace `[YOUR-PASSWORD]` par le mot de passe choisi à l'étape 2. C'est
   cette adresse complète que tu mettras dans `DATABASE_URL`.

Les tables (`members`, `activities`) sont créées automatiquement par le site
au premier démarrage — rien à faire manuellement sur Supabase.

## 3. Configurer le projet

```bash
cp .env.example .env
```

Remplis `.env` avec :
- `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` (étape 1)
- `DATABASE_URL` (étape 2)
- `BASE_URL` — l'URL publique du site (`http://localhost:3000` en local)
- `SITE_ACCESS_CODE` — le code que **toute la famille** utilise pour ouvrir
  le site. Un seul code, à partager par SMS/message une fois.
- `ADMIN_CODE` — un code que **toi seul** connais, pour valider les demandes
  de connexion et retirer un membre.
- `COOKIE_SECRET` — une valeur aléatoire pour signer les cookies de session :
  ```bash
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  ```

## 4. Installer et lancer

```bash
npm install
npm start
```

Le site est disponible sur `http://localhost:3000`.

## Comment ça se passe côté famille

1. Tu partages le lien du site **et** le `SITE_ACCESS_CODE` à la famille.
2. Chacun ouvre le site, entre le code, puis clique "Connecter via Strava" et
   autorise son compte.
3. Sa demande apparaît en **attente** — il n'est pas encore visible dans les
   classements.
4. Toi (avec le `ADMIN_CODE`, via le bouton "Mode admin" en haut du site) vois
   la demande dans "Demandes en attente" et cliques "Accepter" (ou "Refuser").
5. Une fois accepté, le membre apparaît dans le classement dès la prochaine
   synchronisation ("Synchroniser").

Seul le mode admin permet d'accepter une demande ou de retirer quelqu'un
(bouton ✕ sur son nom) — un membre normal ne peut pas dégager un autre membre.

## Pourquoi pas juste un site statique comme le Catan ?

Un site 100% statique (comme une page GitHub Pages) ne peut rien stocker de
partagé entre plusieurs personnes par lui-même — au mieux il garde des
données dans le navigateur de chacun, séparément. Pour que toute la famille
voie le même classement, il faut un endroit central qui stocke les données :
ici, Supabase.

Et pour la connexion Strava, l'API exige un `client_secret` qui ne doit
**jamais** apparaître dans du code envoyé au navigateur (sinon n'importe qui
pourrait l'utiliser pour se faire passer pour ton application) — ça impose
un petit serveur qui tourne en continu, ici Render.

## Déploiement

1. Crée un compte Render (https://render.com), connecte ton dépôt GitHub,
   crée un **Web Service** avec :
   - Build Command : `npm install`
   - Start Command : `npm start`
   - Instance Type : **Free** (aucun disque à ajouter, Supabase s'en charge)
2. Dans l'onglet **Environment**, ajoute toutes les variables de ton `.env`
   (`STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `DATABASE_URL`,
   `SITE_ACCESS_CODE`, `ADMIN_CODE`, `COOKIE_SECRET`, `BASE_URL`).
3. Une fois déployé, récupère l'adresse fournie par Render, mets-la à jour
   dans `BASE_URL` (sur Render) et dans le "Authorization Callback Domain"
   de ton application Strava.

## La carte des tracés

En dessous du classement, une carte interactive (Leaflet, gratuite, fond de
carte sombre) affiche le tracé GPS de chaque activité, une couleur fixe par
membre (visible aussi dans le graphique de dénivelé, pour la cohérence). Elle
se recalcule automatiquement à chaque "Synchroniser" et à chaque changement
de filtre (période / sport).

Le tracé vient directement du `summary_polyline` que Strava renvoie avec
chaque activité — pas d'appel API supplémentaire, pas d'export manuel à
gérer. Les activités enregistrées sans données GPS (entraînement indoor,
saisie manuelle...) n'apparaissent simplement pas sur la carte.

## Les records vélo

Un tableau compare les meilleurs temps de chaque membre sur des distances de
référence (5 miles, 10 km, 20 km, 40 km, 50 km, 100 km), avec le temps, la
vitesse moyenne et la date de la performance.

Strava calcule bien ce genre de records pour le vélo dans son appli, mais ne
les expose pas via l'API pour les applications tierces (seule la course à
pied l'est). Le site les recalcule donc lui-même : à chaque synchronisation,
il télécharge le tracé GPS (distance/temps) de chaque nouvelle sortie vélo et
cherche, avec une fenêtre glissante, la portion la plus rapide pour chaque
distance de référence. Chaque activité n'est analysée qu'une seule fois
(marquée en base une fois traitée), et le nombre d'analyses par synchro est
plafonné pour rester sous les limites de l'API Strava — sur un gros
historique, plusieurs clics sur "Synchroniser" peuvent être nécessaires pour
tout traiter.

## Structure du projet

```
server.js            → routes Express (auth Strava, sessions, API stats)
lib/db.js             → connexion PostgreSQL (pool) + création du schéma
lib/strava.js         → échange/rafraîchissement de jetons, import des activités
public/index.html      → page unique (+ écran de verrouillage)
public/app.js           → logique front (accès, admin, classements)
public/style.css        → thème « carnet d'expédition »
```

## Limites connues

- Le premier import remonte **tout l'historique** disponible sur Strava (peut
  prendre un peu de temps si quelqu'un a plusieurs années d'activités —
  ajustable dans `lib/strava.js`, `syncMemberActivities`, si tu préfères
  limiter la fenêtre pour aller plus vite).
- La synchronisation n'est déclenchée que manuellement (bouton
  "Synchroniser"), pas automatiquement en tâche de fond.
