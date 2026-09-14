# Contrats par écran — App livreur (Phase 3)

Étape 1 du plan Phase 3 (voir mémoire projet). Documente, pour chaque écran, les
endpoints HTTP / événements Socket.io / état local nécessaires, et ce qui est
bloqué tant que le backend (Codex) n'a pas livré le point correspondant.

Légende des statuts backend : ✅ existe déjà · 🚧 en cours (punch-list Codex) · —
non nécessaire.

## Connexion (Login)

- HTTP : Supabase Auth (email/mot de passe) côté client — pas de route API dédiée.
- État local : JWT + refresh token dans `expo-secure-store`.
- Backend : ✅ (Supabase gère l'émission du JWT avec `app_metadata.role`).

## Disponibles (onglet Carte + liste sans carte en attendant l'étape 9)

- HTTP : `GET /api/v1/orders/available?zoneId=` ✅
- Socket : `new_order` (ajoute à la liste), `order_taken` (retire de la liste) ✅
- Action : `POST /api/v1/orders/:id/assign` — 🚧 body ne doit plus contenir
  `driverId` (dérivé du JWT, punch-list #2).
- État local : liste des commandes AVAILABLE de la zone du livreur connecté.
- Bloqué tant que #2 n'est pas livré : rien ne bloque l'affichage/le swipe,
  mais l'appel `assign` reste vulnérable à l'usurpation d'identité jusqu'au fix.

## Mes courses

- HTTP : `GET /api/v1/orders/driver` — 🚧 n'existe pas encore (punch-list #3).
  En attendant : écran construit contre une interface de données provisoire
  (pas de fausse autorisation côté client — voir décision Temps 2).
- Actions : `POST /api/v1/orders/:id/collect`, `POST /api/v1/orders/:id/complete`
  — 🚧 même fix driverId-from-JWT que ci-dessus (punch-list #2).
- État local : commandes ASSIGNED/COLLECTED du livreur connecté.
- **Bloqué tant que #3 n'existe pas** : impossible d'afficher une vraie vue
  "mes courses" séparée des commandes disponibles.

## Détail commande / Preuve de livraison

- Action finale : upload photo compressée + `POST /api/v1/orders/:id/complete`
  — 🚧 endpoint d'upload transitoire (punch-list #4), contrat exact à récupérer
  une fois livré par Codex (méthode d'association à la transition COMPLETED :
  multipart dans /complete, ou endpoint séparé pré-requis — à confirmer).
- Compression obligatoire côté client avant tout envoi réseau
  (`expo-image-manipulator`, JPEG 80 %, max 1920px, <500 Ko) — ne dépend pas
  du backend, peut être développé dès l'étape 8 sous Expo Go.
- **Bloqué tant que #4 n'existe pas** : `/complete` ne peut pas être appelé
  avec une preuve réelle (decision Temps 2 : upload transitoire retenu, pas de
  validation locale seule).

## Carte (MapLibre, étape 9-10)

- HTTP : réutilise `GET /orders/available` (markers pickup).
- Socket : réutilise `new_order`/`order_taken`.
- GPS : `POST /api/v1/drivers/location` — 🚧 n'existe pas (punch-list #1).
  Foreground uniquement (décision Temps 2), envoyé pendant ASSIGNED/COLLECTED.
- **Bloqué tant que #1 n'existe pas** : aucun envoi de position possible ;
  l'écran carte lui-même (affichage markers + panel) ne dépend pas de #1.

## Wallet (affichage seul)

- HTTP : 🚧 punch-list #5 — endpoint dédié agrégeant `driver_earning_cents`
  des commandes COMPLETED, ou décision explicite de mock côté client pendant
  le pilote (`payments/` reste un stub vide, ce n'est pas un vrai wallet).
- **Bloqué tant que #5 n'est pas tranché** : écran construit en dernier
  (étape 11), le plus de marge pour attendre la décision de Codex.

## Socket.io — sécurité (transverse, non bloquant)

- 🚧 punch-list #6 — le handshake actuel n'authentifie pas `zoneId` par JWT.
  Pas bloquant pour construire les écrans ci-dessus (broadcast de zone sans
  donnée sensible), mais à confirmer avant la mise en prod pilote.

## Résumé des dépendances bloquantes (punch-list Codex)

| # | Endpoint / fix | Bloque |
|---|---|---|
| 1 | `POST /drivers/location` | Étape 10 (GPS) |
| 2 | `driverId` depuis JWT (assign/collect/complete) | Sécurité réelle des étapes 4-5 |
| 3 | `GET /orders/driver` | Étape 4 (vraie vue "Mes courses") |
| 4 | Upload photo transitoire | Étape 7-8 (preuve de livraison) |
| 5 | Source de données wallet | Étape 11 (wallet) |
| 6 | Sécurité socket | Non bloquant, à confirmer |
