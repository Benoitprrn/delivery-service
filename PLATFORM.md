# Locadely (delivery-service) — Documentation technique de la plateforme

> Document de référence exhaustif décrivant l'état **réellement implémenté** de la plateforme, à la date du commit `8717473`. Rien de planifié ou en cours n'est décrit comme existant ; toute incertitude est explicitement signalée.
>
> **Nom du projet** : le dépôt et les fichiers de configuration internes utilisent le nom technique `delivery-service` (`package.json` racine : `"name": "delivery-service"`). Le nom commercial du produit, visible dans la configuration mobile (`apps/mobile/app.json` → `"owner": "locadely-foodely"`, projet Firebase `locadely-49c60`, tâche de fond `locadely-driver-location`), est **Locadely**. Les deux noms sont utilisés indifféremment dans ce document.
>
> **Écart de documentation important** : le `CLAUDE.md` racine et les `CLAUDE.md` de chaque app décrivent l'état du projet comme "Phase 1, flux minimal, sans auth, sans photos, sans paiement réel". **Le code réel dépasse largement cette description** : authentification Supabase JWT complète, moteur de dispatch séquentiel VROOM + pg-boss, notifications push, tracking GPS livreur avec rétention, preuve de livraison (code/signature/photo), calcul des gains livreur, et une application mobile multi-écrans entièrement construite sont tous présents et testés. Ce document décrit le code tel qu'il existe, pas la phase déclarée. Les écarts précis sont signalés au fil du texte et récapitulés en annexe (§15).
>
> **Fichier ARCHITECTURE.md** : ce fichier, référencé par convention dans certains outils d'analyse, **n'existe pas** dans ce dépôt. Les règles architecturales de ce document sont reconstruites à partir des fichiers `CLAUDE.md` (racine + par app) et vérifiées contre ce que le code impose réellement (ex. `.dependency-cruiser.cjs`).

---

## 1. Vue d'ensemble de la plateforme

**Concept métier** : Locadely est un service de livraison last-mile B2B en modèle marketplace — un commerçant crée une demande de livraison, elle devient visible par les livreurs éligibles d'une zone, et un livreur choisit librement de la prendre (aucune assignation automatique forcée par la plateforme). Le pilote actuel couvre une seule zone géographique : Bourg-en-Bresse (Ain, France). La tarification est calculée automatiquement à partir de la distance et de la durée d'un itinéraire vélo (OSRM), en centimes entiers, sans marge opérateur au lancement.

**Acteurs** :
- **Commerçant** : crée des demandes de livraison depuis l'application web (`apps/web`, `/merchant/*`), suit leurs statuts en temps réel, gère son profil (coordonnées, logo).
- **Livreur** : voit et accepte des offres de livraison depuis l'application mobile (`apps/mobile`), collecte la marchandise, livre, saisit la preuve de livraison. Statut de disponibilité et position GPS gérés côté serveur dans Valkey (cache éphémère), indépendamment l'un de l'autre.
- **Opérateur / admin** : rôle défini au niveau de l'authentification (`AuthRole = 'admin'`) mais **aucune interface web admin n'existe dans le code actuel** (pas de route `/admin/*`, malgré sa mention dans `apps/web/CLAUDE.md` comme fonctionnalité Phase 4).
- **Client final** : ne se connecte à aucun compte ; reçoit un lien de suivi public non-authentifié (`/track/:token`) basé sur un token opaque associé à la commande.

**Flux principal de bout en bout** (implémenté et testé, cf. `test/orders/state-machine.integration.test.ts` et `test/realtime/outbox-worker.test.ts` ; **`scripts/simulate.sh` est obsolète** — voir §3, il appelle une route d'assignation directe qui n'existe plus) :

```
1. Commerçant crée une commande (POST /api/v1/orders)
   → validation de la zone de livraison (rayon), géocodage/itinéraire OSRM, calcul du prix
   → commande insérée directement au statut AVAILABLE (le statut CREATED existe dans le
     modèle et la state machine, mais n'est jamais persisté par le chemin d'écriture actuel)

2. Le moteur de dispatch séquentiel (module `dispatch`) est déclenché automatiquement
   (l'événement order.created.v1 déclenche StartDispatchUseCase plutôt qu'une diffusion
   large) : il cherche un livreur candidat (groupage même commerçant, puis élargissement
   de rayon 1/2/3 km), vérifie la faisabilité via VROOM, et pousse une offre unique et
   séquentielle à un seul livreur à la fois (dispatch_offer_created)

3. Le livreur reçoit une notification push + un événement Socket.io, et dispose de 60s
   (configurable) pour Accepter ou Refuser l'offre (POST /api/v1/dispatch-offers/:id/accept|reject)
   → Accepter assigne la commande au livreur (ASSIGNED) ; Refuser ou expiration relance
     le dispatch vers le candidat suivant

4. Le livreur collecte la marchandise (POST /api/v1/orders/:id/collect) → COLLECTED

5. Le livreur livre et saisit une preuve (code à 4 chiffres, signature, ou photo)
   (POST /api/v1/orders/:id/complete) → COMPLETED

   Alternative : client absent → RETURNING puis RETURNED (POST .../return puis .../returned)
```

Chaque transition d'état est écrite dans une transaction unique (`UPDATE orders` + `INSERT order_events` + `INSERT outbox_event`), et les effets externes (Socket.io, push, déclenchement du dispatch suivant) sont publiés après coup par un worker outbox séparé — jamais dans la transaction elle-même.

---

## 2. Structure du monorepo

### Arborescence significative

```
apps/
  api/                 Backend Fastify — API REST /api/v1/ + WebSocket (Socket.io) + worker outbox
    src/
      app.ts, server.ts
      modules/         auth, dispatch, drivers, merchants, notifications, orders, pricing, zones
      platform/        config, correlation-id, db, logger, outbox-relay, pgboss, pg-error, transaction, valkey
      realtime/        socket-handler.ts
    test/              mirroring des modules + support/ (fixtures, tokens de test)
  web/                 Next.js — espace commerçant (/merchant/*) + pages statiques Phase-1
    app/               layout, page racine (redirect), login, merchant/{new,orders,account,layout}, track/[token]
    components/        ui/ (Button, Dialog, Input, Textarea, Toast) + composants métier
    lib/               config, orders, pickup-schedule, tracking, utils, supabase/{client,server,middleware,env}
    public/            driver.html, merchant.html — pages de démo Phase 1, indépendantes de l'app Next.js
  mobile/              App livreur React Native/Expo (Locadely)
    app/               _layout, index, login, (tabs)/{map,orders,compte}, order/[id]/{index,proof}, dispatch-offer/[id]
    components/        AvailabilityToggle, SliderButton, order-card, order-timeline, proof-*, wallet, etc.
    lib/                api, auth-context, availability-context, gps, location-task, location-tracking,
                        push-notifications, socket, supabase, dispatch-offer-context, colors, wallet-types...
    docs/              screen-contracts.md (contrat d'écran ↔ backend, partiellement obsolète)
packages/
  shared/              @delivery-service/shared — actuellement VIDE (export {} littéral), non consommé
supabase/
  migrations/          0001_init.sql → 0017_outbox_event_claim.sql (17 migrations, seule source de vérité du schéma)
  config.toml, seed.sql
design-system/
  terrain/             Design system "Terrain" — tokens CSS, tailwind.config.ts, globals.css, readme.md
docs/
  adr/                 0001-order-states.md, 0002-pricing-formula.md
infra/
  osrm/                profil vélo OSRM (bicycle.lua), script d'extraction Overpass, données Bourg-en-Bresse
  vroom/               config.yml (vroom-express, mode bridge, routage OSRM)
scripts/
  dev.sh, seed-auth.sh, simulate.sh
```

### npm workspaces

Root `package.json` : `"workspaces": ["apps/*", "packages/*"]`, `"engines": {"node": ">=24"}`, `"packageManager": "npm@11"`. Scripts racine : `dev:api`, `dev:web` (pas de `dev:mobile` malgré sa mention dans le `CLAUDE.md` racine — la commande mobile documentée est `npx expo start -w apps/mobile`), `test`/`typecheck`/`lint` (`--workspaces --if-present`), `check:boundaries`.

### Outils de qualité

- **TypeScript strict monorepo-wide** : `tsconfig.base.json` (étendu par les 4 workspaces) active `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module`/`moduleResolution: NodeNext`, `target: ES2023`. Aucun workspace ne désactive ces trois flags. TypeScript `^5.7.0` au niveau racine (utilisé par api/web) ; `apps/mobile` épingle sa propre version, `~6.0.3`.
- **dependency-cruiser** (`.dependency-cruiser.cjs`, `^16.0.0`) — deux règles `forbidden` en `severity: error`, appliquées uniquement à `apps/api/src` (`npm run check:boundaries` = `depcruise apps/api/src --config .dependency-cruiser.cjs`) :
  1. `no-deep-module-import` : un fichier de `modules/X/` ne peut pas importer un fichier de `modules/Y/` sauf `modules/Y/public.ts` — application automatisée de la règle CLAUDE.md "jamais d'import entre modules API sauf via leur public.ts".
  2. `no-circular` : aucune dépendance circulaire, entre modules ou à l'intérieur d'un module.
- **ESLint** (flat config racine, `eslint.config.js`) : `@eslint/js` + `typescript-eslint` recommended. `apps/web` étend en plus `eslint-config-next`. Règle notable : `no-use-before-define` désactivée délibérément (le pattern domain/application/ports/infrastructure/transport dépend de déclarations forward dans un même fichier).

---

## 3. Stack technique complète

### Runtime & langage

| Composant | Version | Source |
|---|---|---|
| Node.js | 24 (LTS) | `.nvmrc`, `engines.node >= 24` |
| TypeScript (api/web/shared) | `^5.7.0` | `package.json` racine |
| TypeScript (mobile) | `~6.0.3` | `apps/mobile/package.json` |
| npm | `11` (`packageManager`) | `package.json` racine |

### Backend (apps/api)

| Dépendance | Version | Rôle |
|---|---|---|
| `fastify` | `^5.12.3` | serveur HTTP |
| `@fastify/cors` | `^10.0.0` | CORS (`origin: true`, permissif) |
| `@fastify/rate-limit` | `^10.0.0` | limite globale 100 req/min ; 20 req/min sur le tracking public |
| `@fastify/multipart` | `^10.1.1` | upload logo commerçant (1 fichier, 2 Mo max) |
| `@fastify/static` | `^10.1.3` | sert `apps/web/public` depuis le process API |
| `zod` | `^4.0.0` | validation des schémas HTTP |
| `pino` / `pino-pretty` | `^9.0.0` / `^13.0.0` | logs JSON structurés |
| `pg` | `^8.23.0` | client Postgres |
| `pg-boss` | `^12.32.0` | jobs différés/cron (expiration d'offre, réconciliation dispatch) |
| `ioredis` | `^5.6.1` | client Valkey |
| `jose` | `^6.0.0` | vérification JWT via JWKS distant |
| `bcryptjs` | `^3.0.3` | hachage du code de livraison à 4 chiffres (12 rounds) |
| `socket.io` / `socket.io-client` | `^4.8.3` | WebSocket temps réel |
| `tsx` | `^4.19.0` | exécution dev avec hot reload |
| `vitest` | `^5.0.0` | tests |

### Web (apps/web)

| Dépendance | Version |
|---|---|
| `next` | `^16.3.5` (le `CLAUDE.md` mentionne "Next.js 14+" — la version épinglée réelle est majeure 16, avec des ruptures de compatibilité réelles gérées dans le code : `proxy.ts` au lieu de `middleware.ts`, `allowedDevOrigins`, `params` en `Promise`) |
| `react` / `react-dom` | `^19.3.0` |
| `tailwindcss` | `^3.4.19` (v3, pas v4) |
| `@supabase/ssr` | `^0.12.7` |
| `@supabase/supabase-js` | `^2.116.0` |
| `@radix-ui/react-dialog` | `^1.1.23` |
| `leaflet` / `react-leaflet` | `^1.9.4` / `^5.0.0` |
| `socket.io-client` | `^4.8.3` |
| `lucide-react` | `^1.45.0` |

### Mobile (apps/mobile)

| Dépendance | Version |
|---|---|
| `expo` | `~57.0.22` |
| `react-native` | `0.86.3` |
| `react` / `react-dom` | `19.2.3` |
| `expo-router` | `~57.0.21` |
| `expo-location` | `~57.0.17` |
| `expo-task-manager` | `~57.0.17` |
| `expo-notifications` | `~57.0.18` |
| `expo-secure-store` | `~57.0.4` |
| `@maplibre/maplibre-react-native` | `^11.3.10` |
| `nativewind` | `^4.2.6` |
| `@supabase/supabase-js` | `^2.116.0` |
| `socket.io-client` | `^4.8.3` |
| `react-native-signature-canvas` | `^5.1.1` |
| `react-native-reanimated` / `react-native-worklets` | `4.5.1` / `0.10.1` (présents mais **aucun usage direct identifié** — probablement tirés transitivement) |

### Services externes et rôle précis

| Service | Rôle | Détail |
|---|---|---|
| **Supabase CLI (Postgres)** | base de données, port 54322 (Studio 54323) | **Sans PostGIS** — malgré la mention dans `CLAUDE.md`, aucune migration n'installe l'extension PostGIS ni ne déclare de colonne `geography`/`geometry` ; toutes les coordonnées sont des `double precision` avec contraintes `CHECK` de plage, et les calculs de distance/rayon sont faits en TypeScript (haversine, dupliqué 3 fois — voir §5). |
| **Supabase Auth** | authentification JWT (ES256, JWKS) | activé même si le `CLAUDE.md` racine le déclare "Phase 2" |
| **Supabase Storage** | stockage logo commerçant | bucket `merchant-logos` créé conditionnellement par la migration 0015 ; **désactivé en local** (`config.toml` `[storage] enabled = false`) |
| **Valkey 8.x** | cache éphémère : disponibilité livreur, position GPS live, compteur de capacité, verrouillage/lease de l'outbox | port 6379, jamais Redis 8+ (raison : licence AGPL de Redis, incompatible avec la règle BSD/MIT/Apache du projet) |
| **pg-boss** | jobs différés et cron sur une connexion Postgres dédiée (`PGBOSS_DATABASE_URL`, distincte du pool API `DATABASE_URL`) | expiration des offres de dispatch (délai unique), réconciliation des dispatchs bloqués (cron `*/5 * * * *`) |
| **Socket.io** | WebSocket temps réel, `transports: ['websocket']` uniquement, jamais de long-polling | namespace par défaut (commerçants/livreurs authentifiés) + namespace `/tracking` public |
| **OSRM** | calcul d'itinéraire vélo (distance, durée, géométrie) | port 5000, jeu de données limité à la bbox Bourg-en-Bresse (`infra/osrm/`) |
| **VROOM** (`vroom-express`) | vérification de faisabilité d'une offre de dispatch (un livreur peut-il honorer sa tournée actuelle + la nouvelle commande) | port interne 3010→3000 (conteneur Docker en mode bridge, atteint OSRM via `host.docker.internal:5000`) |
| **OpenCage** | géocodage d'adresse (création commande côté API ; autocomplete adresse appelé **directement depuis le navigateur** côté web) | |
| **Expo Push (exp.host)** | notifications push vers l'app mobile livreur | relais vers FCM/APNs pris en charge par Expo, pas d'intégration FCM directe dans le code API |
| **Firebase / FCM** | messagerie push Android sous-jacente à Expo Notifications | `google-services.json` (projet `locadely-49c60`, package `com.deliveryservice.driver`) — pas de configuration iOS (`GoogleService-Info.plist`) trouvée, cohérent avec `app.json` (`"platforms": ["android", "web"]` uniquement) |
| **Mistral, Stripe, Twilio, Resend** | **non implémentés dans le code actuel** — présents uniquement comme variables d'environnement vides dans `.env.example` (sections "Phase 2+"/"Phase 3"). Le code contient des marqueurs `TODO: TWILIO` explicites (ex. `orders.delivery_code_plain`, exposé en clair au commerçant en attendant l'intégration SMS) et un bouton Stripe Connect désactivé côté web ("Bientôt disponible"). |
| **Traccar** | mentionné dans les règles CLAUDE.md mobile ("jamais directement à Traccar") mais **aucune intégration Traccar trouvée** dans le code — la position GPS remonte uniquement via `POST /api/v1/drivers/location`. |

### Infrastructure locale

- `infra/osrm/` : profil cyclable `bicycle.lua` (vitesse par défaut 16 km/h, vitesse max 21 km/h), script `extract-bbox.sh` (interroge l'API Overpass directement sur la bbox Bourg-en-Bresse plutôt qu'un extrait régional entier, puis `osrm-extract`/`osrm-partition`/`osrm-customize` en pipeline MLD), données déjà extraites (~32 Mo `.osm.pbf`, ~4,68M nœuds).
- `infra/vroom/config.yml` : `vroom-express`, `router: osrm`, `routingServers.osrm.bike.host: host.docker.internal:5000`, `threads: 4`, `timeout: 300000`.
- Pas de fichier Docker Compose, pas de configuration nginx/reverse proxy, pas de scripts de provisioning VPS dans le dépôt — l'infrastructure de déploiement en production n'est pas documentée dans le code lu.

### Scripts de démarrage

- **`scripts/dev.sh`** : orchestre tout l'environnement local — démarre/crée les conteneurs Valkey et VROOM Docker, lance `supabase start`, vérifie qu'OSRM tourne déjà (ne le démarre pas lui-même), attend que VROOM réponde (`/health`), démarre l'API Fastify (`npm run dev -w apps/api`, poll sur `/health`), démarre le web Next.js (`npm run dev -w apps/web`, port 4000, poll sur `/login`). Arrêt propre via traps EXIT/INT/TERM.
- **`scripts/seed-auth.sh`** : crée deux comptes Supabase Auth de test via l'API admin (`merchant@test.fr` / `driver@test.fr`, mot de passe `test1234`), avec `app_metadata.role` et des UUID fixes correspondant aux données de `seed.sql`.
- **`scripts/simulate.sh`** : test de fumée du flux nominal (créer → lister disponibles → assigner → collecter → compléter), vérifié par requête `psql` directe sur `orders.status`. **Ce script est aujourd'hui obsolète/cassé** : son étape 5 appelle directement `POST /api/v1/orders/:id/assign` (vérifié, `scripts/simulate.sh` ligne 87-88) — route qui **n'existe plus** dans l'API actuelle (§6), l'assignation passant désormais exclusivement par l'acceptation d'une offre de dispatch. Ce script échouerait donc (404) s'il était exécuté contre le code actuel ; il documente le flux tel qu'il existait avant l'introduction du module `dispatch`. Ne simule de toute façon ni mouvement GPS, ni offres de dispatch, ni notifications push.

---

## 4. Architecture backend (apps/api)

### Structure d'un module

```
src/modules/{name}/
  domain/            entités, value objects, événements — zéro dépendance externe
  application/       use cases (create-order, assign-order, ...)
  ports/             interfaces abstraites (OrderRepository, RoutingProvider, ...)
  infrastructure/    implémentations concrètes des ports
  transport/http/    routes Fastify — appellent un use case, rien d'autre
  public.ts          seul fichier importable par les autres modules (imposé par dependency-cruiser)
```

### Modules existants

| Module | Responsabilité | État |
|---|---|---|
| `zones` | lecture seule d'une zone de livraison (id, centre, rayon) | minimal, sans HTTP ni use case — repository pur |
| `merchants` | profil commerçant, upload logo | complet |
| `drivers` | profil livreur, disponibilité, position GPS, capacité, token push | complet — la disponibilité/position/capacité "rapides" vivent dans Valkey, pas Postgres |
| `pricing` | formule de prix pure, sans état | complet (fonction unique) |
| `orders` | agrégat racine : cycle de vie, state machine, événements, vues commerçant/livreur, code/preuve de livraison, gains, tracking | complet — module central |
| `dispatch` | dispatch séquentiel piloté par VROOM | complet — remplace un module `marketplace` supprimé (visible en `git status`, non nettoyé dans `apps/api/CLAUDE.md`) |
| `notifications` | notifications push Expo | complet, aucune route HTTP (invoqué en interne uniquement) |
| `auth` | vérification JWT Supabase (JWKS) | complet, petit et autonome |

Les modules `tracking`, `payments`, `integrations` mentionnés dans `apps/api/CLAUDE.md` comme "vides jusqu'à Phase 2/3" **n'existent pas comme dossiers distincts** dans l'arborescence actuelle — le tracking GPS/livraison est en réalité intégré dans `drivers` et `orders`.

### Pattern outbox

Table `outbox_event` (voir §5 pour le schéma complet). Le worker (`platform/outbox-relay.ts`, `startOutboxRelay(pool, emit, intervalMs = 2000)`) :

1. Toutes les 2s, réclame un lot de 10 lignes non publiées via :
   ```sql
   update outbox_event
   set locked_until = now() + interval '30 seconds'
   where id in (
     select id from outbox_event
     where published_at is null and (locked_until is null or locked_until < now())
     order by created_at asc, id asc
     limit 10
     for update skip locked
   )
   returning id, event_type, aggregate_id, payload, correlation_id
   ```
   `FOR UPDATE SKIP LOCKED` permet à plusieurs instances de relais de se répartir les lignes sans se bloquer mutuellement.
2. Pour chaque ligne : appelle `emit()` (réseau/Socket.io, **hors transaction**). Succès → `published_at = now()`. Échec → `attempts += 1`, `locked_until = null` (retenté au cycle suivant, dans 2s). **Aucun mécanisme de dead-letter/max-attempts observé** — un événement en échec permanent est retenté indéfiniment.
3. Fait aussi le ménage : suppression des `order_proof_assets` et `driver_locations` expirés à chaque cycle.

Insertion dans `outbox_event`, toujours dans la même transaction que la mutation métier (`PostgresOrderRepository.insertTransitionEvent()` pour `create`/`assign`/`collect`/`complete`/`returnOrder`/`confirmReturn`, et directement dans `PostgresDispatchRepository.createOffer()` pour les offres de dispatch). La contrainte `outbox_event_aggregate_version_key unique(aggregate_id, aggregate_version)` (migration 0002) garantit qu'un même changement de version d'un agrégat ne produit jamais deux lignes outbox.

`createSocketEventEmitter` (dans `realtime/socket-handler.ts`) est l'implémentation `emit` branchée sur le relais : elle route chaque `event_type` vers soit (a) le déclenchement du dispatch (`order.created.v1` → `StartDispatchUseCase`, jamais diffusé en socket), (b) une émission Socket.io ciblée, (c) une notification push (best-effort, erreurs journalisées non bloquantes).

### Transaction pattern

`platform/transaction.ts` (`inTransaction<T>(pool, work)`) : `BEGIN` → `work(client)` → `COMMIT`, `ROLLBACK` en cas d'erreur métier (connexion relâchée proprement dans le pool), destruction de la connexion seulement si l'état est réellement incertain (rollback lui-même en échec). Timeouts du pool (`platform/db.ts`) : `statement_timeout: 5000`, `idle_in_transaction_session_timeout: 5000` — ce qui a forcé à précalculer le hash bcrypt du code de livraison **avant** d'ouvrir la transaction de complétion (bcryptjs pur JS à 12 rounds peut dépasser 5s sous contention CPU).

Chaque transition d'état (`assign`, `collect`, `complete`, `returnOrder`, `confirmReturn`) enchaîne dans une seule transaction : `UPDATE orders ... RETURNING *` + `INSERT order_events` + `INSERT outbox_event`. Aucun appel réseau externe (OSRM, VROOM, Expo, Stripe...) n'a été trouvé à l'intérieur d'un bloc `inTransaction` — conforme à la règle absolue du `CLAUDE.md` racine.

### Optimistic locking (`version`)

**Note de cohérence vérifiée** : dans `AssignOrderUseCase.execute()`, l'incrément du compteur de capacité Valkey (`capacityWriter.increment(driverId)`) est appelé **après** que la transaction Postgres d'assignation a validé, pas à l'intérieur de celle-ci — un crash entre les deux laisserait la commande `ASSIGNED` en base sans que le compteur Valkey soit incrémenté. Auto-réparable au prochain cache-miss (`GetDriverCapacityUseCase` reconstruit alors depuis Postgres), mais transitoirement incohérent.

Toute mutation d'une commande prend un `expectedVersion` et écrit :
```sql
update orders set ..., version = version + 1
where id = $1 and status = 'X' and version = $N
returning *
```
`rowCount !== 1` → `OrderConflictError` (conflit, pas une erreur serveur). Exemple exact pour l'assignation (`assign-order.ts` / `postgres-order-repository.ts`) :
```sql
update orders
set driver_id = $1, status = 'ASSIGNED', assigned_at = now(), updated_at = now(), version = version + 1
where id = $2 and status = 'AVAILABLE' and driver_id is null and version = $3
returning *
```
Le même pattern CAS protège `dispatch_offers` (`accept`/`reject`/`expire` → `update dispatch_offers set status=$1, ... version = version + 1 where id=$2 and status='ACTIVE' and version=$3`). Testé sous concurrence réelle par `test/orders/race-condition.integration.test.ts` (exécuté séparément via `npm run test:concurrency`).

### correlationId

`platform/correlation-id.ts` : un hook Fastify `onRequest` lit `x-correlation-id` entrant (sinon génère un UUID), l'attache à `request.correlationId`, l'échoue sur la réponse, et crée un logger Pino enfant qui porte l'id automatiquement sur chaque log de la requête. Chaque commande d'use case (`AssignOrderCommand`, etc.) porte un `correlationId?: string` optionnel (généré si absent, pour les déclenchements internes comme les retries de dispatch). L'id est inséré à la fois dans `order_events` et `outbox_event` lors de chaque transition, rendant la chaîne HTTP → transition → audit → outbox → effet externe traçable de bout en bout par un seul identifiant.

### pg-boss

`platform/pgboss.ts` — instance dédiée sur `PGBOSS_DATABASE_URL` (connexion directe/session mode, distincte du pool API en mode transaction/Supavisor). Deux jobs enregistrés dans `modules/dispatch/infrastructure/pgboss-dispatch-scheduler.ts` :
- **`dispatch-offer-expiry`** : job différé unique par offre (`pgBoss.send(queue, {offerId, expectedVersion}, {startAfter: 60, singletonKey: offerId})`), déclenche `ExpireDispatchOfferUseCase` (les conflits sur une offre déjà résolue par HTTP sont silencieusement ignorés).
- **`dispatch-reconciliation`** : cron `*/5 * * * *`, relance `StartDispatchUseCase` sur toute commande `AVAILABLE` sans livreur, non modifiée depuis plus de 5 minutes et non déjà marquée `dispatch_failed` — filet de sécurité pour un dispatch mort en plein vol (panne VROOM, crash serveur).

### Socket.io

Serveur attaché directement au serveur HTTP Fastify, `transports: ['websocket']` uniquement.

**Namespaces** : défaut (commerçants/livreurs authentifiés par JWT) ; `/tracking` (public, l'auth est la possession du `tracking_token` opaque).

**Rooms** : `zone_${zoneId}` (livreurs, selon disponibilité), `merchant_${merchantId}` (auto-join à la connexion), `tracking:${trackingToken}` (clients de suivi public).

**Auth (namespace défaut)** : middleware `io.use` vérifiant le JWT (`SupabaseJwtVerifier`, même vérificateur que HTTP) ; `role='merchant'` → room commerçant ; `role='driver'` → lookup du profil livreur, room de zone selon disponibilité.

**Événements émis** : `driver_position_updated` (namespace `/tracking`, `{lat, lng, tracking_token}`) ; `dispatch_offer_created` (direct au livreur concerné) ; `dispatch_failed` (room commerçant) ; `order_taken` (room de zone, quand une autre commande est assignée) ; `order_updated` (room de zone, cas générique). **Aucun événement métier n'est reçu du client** — toutes les écritures passent par HTTP.

**Constat vérifié dans le code** (`realtime/socket-handler.ts`, lignes ~52-68 pour le join de room zone, ligne 111 pour le join marchand, lignes 180-193 pour l'émission) : les commerçants rejoignent uniquement `merchant_${merchantId}` — **jamais** une room `zone_${zoneId}` (ce join est réservé aux livreurs, selon leur disponibilité). Or `order_taken` et `order_updated` ne sont émis que vers `zone_${zoneId}`. Conséquence directe : **un socket commerçant ne reçoit jamais ces deux événements** — seul `dispatch_failed` (émis vers `merchant_${merchantId}`) atteint réellement un commerçant en temps réel. Voir §11 pour l'impact côté web.

Le registre des sockets par livreur est **local au process** (pas de fan-out Valkey pub/sub) — limite documentée en commentaire, assumée pour une instance API unique.

### Règles architecturales interdites (reconstruites depuis les CLAUDE.md + code)

- Jamais de logique métier dans les routes HTTP — les routes appellent un use case et rien d'autre. Vérifié par lecture de chaque `transport/http/routes.ts`.
- Jamais d'import entre modules API sauf via `public.ts` — imposé mécaniquement par `no-deep-module-import` (dependency-cruiser).
- Jamais de dépendance circulaire (`no-circular`, dependency-cruiser).
- Jamais de transaction Postgres traversant un appel réseau externe.
- Jamais de GPS dans le bus d'événements métier (`order_events`/`outbox_event`) — les positions GPS vivent dans `driver_locations` (Postgres, rétention 7 jours) et Valkey, jamais comme `DomainEvent`.
- Jamais de float pour de l'argent — tous les montants sont des `integer` en centimes.
- API versionnée `/api/v1/` (convention par chemin littéral dans chaque route, pas un préfixe Fastify centralisé — chaque route est déclarée avec le chemin complet).
- Valkey 8.x exclusivement, jamais Redis 8+ (raison de licence, cf. §3).
- **Constat** : `assertTransition`/`canTransition` (la state machine, §8) sont exportés et testés unitairement mais **jamais appelés depuis le chemin d'écriture réel** — la garde effective en production est la clause SQL littérale `WHERE status = '...'` de chaque méthode du repository. Les deux sont cohérents aujourd'hui (vérifié méthode par méthode) mais rien ne les maintient mécaniquement synchronisés.

---

## 5. Schéma de données

Source de vérité : `supabase/migrations/0001_init.sql` → `0017_outbox_event_claim.sql` (17 migrations). **Pas de PostGIS** (voir §3) — coordonnées en `double precision` avec `CHECK` de plage. **Pas de RLS** configurée (aucune `ENABLE ROW LEVEL SECURITY` ni `CREATE POLICY` dans les 17 migrations) — cohérent avec un contrôle d'accès actuellement géré uniquement au niveau applicatif (JWT + vérifications de rôle dans chaque handler).

### Tables

**`zones`**
| colonne | type | contraintes |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| name | text | not null |
| center_lat / center_lng | double precision | `between -90/90`, `-180/180` |
| radius_km | numeric(5,2) | `> 0` |
| created_at | timestamptz | `now()` |

**`merchants`**
| colonne | type | contraintes |
|---|---|---|
| id | uuid PK | part de `unique(id, zone_id)` |
| name | text | not null |
| zone_id | uuid | FK `zones(id)` |
| lat / lng | double precision | range check |
| address | text | not null (ajoutée 0003) |
| phone_landline | text | nullable (ajoutée 0006 sous le nom `phone`, `NOT NULL` ; renommée + rendue nullable en 0015) |
| phone_mobile | text | nullable (ajoutée 0015) |
| logo_url | text | nullable (ajoutée 0015) |
| — | — | `merchants_contact_phone_check` : au moins un des deux téléphones non nul |

**`drivers`**
| colonne | type | contraintes |
|---|---|---|
| id | uuid PK | part de `unique(id, zone_id)` |
| name | text | not null |
| zone_id | uuid | FK `zones(id)` |
| is_available | boolean | `default false` (colonne historique — la disponibilité "vive" réelle est dans Valkey, voir §10) |
| phone | text | nullable (0012) |
| push_token | text | nullable (0013) |

**`orders`** (table centrale, 30 colonnes après 0016)
| colonne | type | contraintes |
|---|---|---|
| id | uuid PK | |
| merchant_id / driver_id / zone_id | uuid | FK ; `driver_id` nullable ; FK composites `orders_merchant_zone_fk (merchant_id, zone_id)→merchants(id, zone_id)` et `orders_driver_zone_fk (driver_id, zone_id)→drivers(id, zone_id)` garantissant la cohérence merchant/driver ↔ zone |
| status | `order_status` enum | `default 'AVAILABLE'` (voir §8) |
| version | integer | `default 1`, `>= 1` — verrou optimiste |
| pickup_address/lat/lng, delivery_address/lat/lng | text / double precision | range checks |
| distance_m, duration_s | integer | `>= 0` |
| **price_cents** | integer | **colonne générée** : `GENERATED ALWAYS AS (greatest(400, 100 + floor(distance_m*37/1000) + floor(duration_s*22/60))) STORED` — voir §5-bis pour la formule |
| driver_earning_cents | integer | ajoutée 0010, initialisée = `price_cents`, `>= 0` |
| assigned_at / collected_at / completed_at | timestamptz | nullable |
| customer_name / customer_phone / customer_email | text | ajoutées 0005, email nullable |
| delivery_code_hash / delivery_code_plain / delivery_code_generated_at / delivery_code_expires_at / delivery_code_failed_attempts / delivery_code_locked_at | — | ajoutées 0008 — `delivery_code_plain` porte un commentaire SQL explicite : colonne temporaire exposant le code en clair au commerçant en attendant l'intégration Twilio, à retirer ensuite |
| delivery_proof_method | text | `check in ('code','signature','photo')` |
| pickup_scheduled_at, order_details, delivery_instructions, delivery_address_complement | — | ajoutées 0011 |
| tracking_token | uuid | ajoutée 0014, `unique`, `default gen_random_uuid()` — base du lien de suivi public |
| metadata | jsonb | ajoutée 0016, `default '{"dispatch_attempts": [], "dispatch_radius_km": null, "dispatch_failed": false}'` |
| created_at / updated_at | timestamptz | **pas de trigger d'auto-update sur `updated_at`** — mis à jour explicitement par chaque `UPDATE` applicatif |

Contrainte `orders_driver_status_check` (version courante, depuis 0004) :
```sql
check (
  (status in ('CREATED', 'AVAILABLE', 'CANCELLED') and driver_id is null)
  or (status in ('ASSIGNED', 'COLLECTED', 'COMPLETED', 'RETURNING', 'RETURNED') and driver_id is not null)
)
```
Index : `orders_zone_status_idx(zone_id, status)`, `orders_driver_id_idx(driver_id)`, `orders_merchant_created_idx(merchant_id, created_at desc)`, `orders_tracking_token_idx(tracking_token)`.

**`order_events`** — journal d'audit append-only
| colonne | type |
|---|---|
| id, order_id, from_status (nullable), to_status, actor_type (`merchant`/`driver`/`system`), actor_id, correlation_id, created_at |

Immuabilité **imposée en base** par deux triggers (0001) :
```sql
create function prevent_order_events_mutation() returns trigger as $$
begin raise exception 'order_events is an immutable append-only log'; end;
$$ language plpgsql;

create trigger order_events_no_update before update or delete on order_events
  for each row execute function prevent_order_events_mutation();
create trigger order_events_no_truncate before truncate on order_events
  for each statement execute function prevent_order_events_mutation();
```

**`outbox_event`** — voir §4 pour le pattern. Colonnes finales : `id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, payload jsonb, correlation_id, created_at, published_at, attempts, last_error, locked_until` (`locked_until` ajouté en 0017 pour le claim/lease du worker). Contrainte unique `(aggregate_id, aggregate_version)` (0002). Index partiel `where published_at is null`.

**`driver_locations`** — historique GPS durable (uniquement quand le livreur a une commande active, voir §10). `id, driver_id, lat, lng, recorded_at, received_at, expires_at` (rétention 7 jours, ajoutée 0009, purgée par le worker outbox à chaque cycle).

**`order_proof_assets`** (renommée depuis `order_proof_photos` en 0008) — une ligne par commande (`order_id` est la PK, FK `ON DELETE CASCADE`), `content bytea`, `content_type` (`image/jpeg`/`image/png`), `kind` (`photo` ≤ 512 000 octets / `signature` ≤ 262 144 octets), `expires_at` (purgée par le même worker). Explicitement documentée en commentaire SQL comme table transitoire, hors du journal de domaine.

**`dispatch_offers`** (nouvelle en 0016) — voir §9 pour le détail complet.

### Enum

Seul type énuméré du schéma : **`order_status`**. Créé en 0001 avec 12 valeurs (`CREATED, ASSIGNED, COLLECTED, IN_TRANSIT, AT_DELIVERY, PROOF_COLLECTION, PAYMENT_PENDING, COMPLETED, CANCELLED, DRIVER_CANCELLED_BEFORE_PICKUP, RETURNING, RETURNED`), **entièrement reconstruit en 0004** (Postgres ne permettant pas de retirer une valeur d'un enum en place) en 8 valeurs finales : `CREATED, AVAILABLE, ASSIGNED, COLLECTED, COMPLETED, CANCELLED, RETURNING, RETURNED`. Aucune migration ultérieure ne le modifie. Tous les autres champs à choix contrôlé (`actor_type`, `kind`, `status` de `dispatch_offers`, `delivery_proof_method`) sont des `text` avec `CHECK`, pas des enums Postgres.

### `config.toml` — points clés

Ports locaux : API 54321, DB 54322 (shadow 54320), Studio 54323. `[realtime] enabled = false` (commentaire : "le temps réel de ce projet passe par Socket.io, pas par Supabase Realtime"). `[storage] enabled = false` en local (commentaire : "pas de photos/OCR en Phase 1"). `[auth] enabled = true` malgré le "Phase 1 sans auth" du CLAUDE.md racine (commentaire : "Activé — Phase 2, auth JWT Supabase pour l'espace commerçant"). `[auth.sms.twilio] enabled = false`. Pas de bucket Storage déclaré dans `config.toml` lui-même — le bucket `merchant-logos` est créé par SQL conditionnel dans la migration 0015.

### `seed.sql`

Une zone (Bourg-en-Bresse, centre 46.2058/5.2255, rayon 10 km), un commerçant ("Restaurant Le Terminus"), un livreur ("Jean-Paul"), UUID fixes (`111...1`/`222...2`/`333...3`). **Incohérence détectée** : `seed.sql` insère dans la colonne `merchants.phone`, renommée `phone_landline` en migration 0015 — ce fichier de seed échouerait tel quel contre le schéma post-0015 (à corriger ou vérifier séparément).

### Clés Valkey (inventaire complet)

| Clé | TTL | Rôle |
|---|---|---|
| `driver:${driverId}:is_available` | 600s (10 min), renouvelé par heartbeat via `EXPIRE` (ne recrée pas une clé expirée) | disponibilité "vive" du livreur — source de vérité au-dessus de `drivers.is_available` (colonne Postgres obsolète) |
| `driver:${driverId}:collected_count` | aucun | compteur de capacité (commandes actives), incrémenté/décrémenté à l'assignation/complétion, jamais négatif |
| `driver:{${driverId}}:current_position` | 300s (5 min) | dernière position GPS connue, JSON `{lat,lng,recordedAt}` |
| `driver:{${driverId}}:last_known_position` | aucun | fallback si `current_position` a expiré |
| `drivers:position_ids` | aucun | index global (Set) des livreurs ayant une position enregistrée, utilisé pour la recherche par rayon |

Écriture atomique via script Lua (`record()`) : rejette une position dont l'horodatage est plus ancien que la position déjà connue (anti-régression GPS), tout en gardant l'index à jour.

---

## 6. API REST complète

Toutes les routes sont déclarées avec leur chemin complet `/api/v1/...` directement dans `app.ts`/chaque `routes.ts` (pas de préfixe Fastify centralisé). CORS `origin: true` (permissif). Rate limit global 100 req/min, 20 req/min sur le tracking public. Upload multipart limité à 1 fichier / 2 Mo.

### merchants (rôle `merchant` requis)

| Méthode | Chemin | Codes | Use case |
|---|---|---|---|
| GET | `/api/v1/merchants/me` | 200 | `getMerchant` |
| PATCH | `/api/v1/merchants/me` | 200 / 422 | `updateMerchant` |
| POST | `/api/v1/merchants/me/logo` | 200 / 422 | `uploadLogo` (multipart, ≤2 Mo, jpeg/png) |

### drivers (rôle `driver` requis)

| Méthode | Chemin | Codes | Use case |
|---|---|---|---|
| GET | `/api/v1/drivers/me` | 200 / 404 | `getLiveDriverProfile` |
| POST | `/api/v1/drivers/availability` | 200 | `setAvailability` (`{available}`, lat/lng legacy ignorés) |
| POST | `/api/v1/drivers/me/disconnect` | 204 | `disconnect` |
| POST | `/api/v1/drivers/push-token` | 204 | `registerPushToken` |
| POST | `/api/v1/drivers/heartbeat` | 204 | `heartbeat` |
| POST | `/api/v1/drivers/location` | 204 | `recordLocation` |

### orders

| Méthode | Chemin | Auth | Codes | Use case |
|---|---|---|---|---|
| POST | `/api/v1/orders` | authentifié (pas de contrôle de rôle explicite observé) | 201 | `createOrder` |
| GET | `/api/v1/orders/available` | driver | 200 | `listAvailableOrders` |
| GET | `/api/v1/orders/estimate` | authentifié (utilisé en pratique par merchant, pas de rôle forcé) | 200 | `estimateOrder` |
| GET | `/api/v1/orders/track/:token` | **public**, rate-limit 20/min | 200 / 404 | `getOrderTracking` |
| GET | `/api/v1/orders/merchant` | merchant | 200 | `getMerchantOrders` |
| GET | `/api/v1/orders/driver` | driver | 200 | `getDriverOrders` |
| GET | `/api/v1/orders/driver/history` | driver | 200 | `getDriverHistory` |
| GET | `/api/v1/orders/driver/earnings` | driver | 200 | `getDriverEarnings` |
| GET | `/api/v1/orders/:id/route` | driver | 200 | `getOrderRoute` |
| POST | `/api/v1/orders/:id/collect` | driver | 200 | `collectOrder` |
| POST | `/api/v1/orders/:id/complete` | driver | 200 | `completeOrder` |
| POST | `/api/v1/orders/:id/return` | driver | 200 | `returnOrder` |
| POST | `/api/v1/orders/:id/returned` | driver | 200 | `confirmReturn` |

### dispatch (rôle `driver` requis)

| Méthode | Chemin | Codes | Use case |
|---|---|---|---|
| GET | `/api/v1/dispatch-offers/:offerId` | 200 / 404 | `getOffer` |
| POST | `/api/v1/dispatch-offers/:offerId/accept` | 204 / 409 | `acceptOffer` |
| POST | `/api/v1/dispatch-offers/:offerId/reject` | 204 | `rejectOffer` |

`GET /health` (hors `/api/v1`, non authentifié) → `{status:'ok'}`.

### Mapping erreurs métier → HTTP

| Erreur | Statut |
|---|---|
| `OrderNotFoundError` / `MerchantNotFoundError` | 404 |
| `OrderConflictError` / `DispatchOfferConflictError` | 409 |
| `OrderRouteAccessDeniedError` / `DispatchOfferAccessDeniedError` | 403 |
| `InvalidTransitionError`, `InvalidZoneAssignmentError`, `DeliveryOutsideZoneError`, `PastPickupScheduleError`, `InvalidProofOfDeliveryError`, `AddressNotFoundError`, `RouteNotFoundError`, `DeliveryCodeInvalidError`, `DeliveryCodeExpiredError` | 422 |
| `DeliveryCodeLockedError` | 423 |
| `RoutingProviderResponseError` / `GeocodingProviderResponseError` | 502 |
| `RoutingUnavailableError` / `GeocodingUnavailableError` / `DispatchPlannerUnavailableError` | 503 |
| `ZodError` | 400 (422 pour le cas spécial "au moins un téléphone requis") |
| autre | 500 |

Corps d'erreur uniforme : `{ error, message, correlationId }` (+ `attemptsRemaining` pour les échecs de code de livraison).

---

## 7. Événements métier

### Enveloppe `DomainEvent`

```ts
type DomainEvent = {
  eventType: string        // ex. 'order.created.v1'
  eventVersion: number     // toujours 1 actuellement
  aggregateVersion: number // = order.version au moment de la construction
  payload: Record<string, unknown>
}
```

### Événements de domaine (`modules/orders/domain/order-events.ts`)

| eventType | payload |
|---|---|
| `order.created.v1` | `orderId, zoneId, merchantId, distanceM, durationS, priceCents` |
| `order.assigned.v1` | `orderId, zoneId, merchantId, driverId` |
| `order.collected.v1` | `orderId, zoneId, merchantId, driverId` |
| `order.completed.v1` | `orderId, zoneId, merchantId, driverId` |
| `order.returning.v1` | `orderId, zoneId, merchantId, driverId` |
| `order.returned.v1` | `orderId, zoneId, merchantId, driverId` |
| `dispatch.offer_created.v1` (construit directement dans `PostgresDispatchRepository`) | `offerId, orderId, driverId, round, radiusKm, expiresAt` |
| `order.dispatch_failed.v1` (construit directement dans `PostgresOrderRepository.markDispatchFailed`) | `orderId, merchantId` |

Chaque événement est émis par la méthode du repository qui exécute la transition correspondante, dans la même transaction que le `UPDATE`/`INSERT order_events` (voir §4).

### Événements Socket.io

Voir §4 — `driver_position_updated`, `dispatch_offer_created`, `dispatch_failed`, `order_taken`, `order_updated`. **Aucun GPS n'est jamais émis comme `DomainEvent`** (règle absolue respectée) — `driver_position_updated` est diffusé directement au niveau Socket.io par `RecordDriverLocationUseCase`, hors du flux outbox.

### Flux outbox → consommateurs

`order.created.v1` → déclenche `StartDispatchUseCase` (pas de diffusion). `dispatch.offer_created.v1` → émission Socket.io ciblée + notification push. `order.assigned.v1` → `order_taken` (room de zone). `order.dispatch_failed.v1` → `dispatch_failed` (room commerçant). Les autres événements de transition tombent dans le cas générique `order_updated` (room de zone).

---

## 8. Flux d'états commande

Source de vérité : `docs/adr/0001-order-states.md`, implémentation `modules/orders/domain/order-state-machine.ts`/`order-status.ts` — les deux sont identiques (vérifié valeur par valeur).

```
CREATED   ──► AVAILABLE, CANCELLED
AVAILABLE ──► ASSIGNED, CANCELLED
ASSIGNED  ──► COLLECTED, AVAILABLE
COLLECTED ──► COMPLETED, RETURNING
COMPLETED ──► (terminal)
CANCELLED ──► (terminal)
RETURNING ──► RETURNED
RETURNED  ──► (terminal)
```

Flux nominal : `CREATED → AVAILABLE → ASSIGNED → COLLECTED → COMPLETED`. Alternatives documentées : annulation commerçant (`CREATED/AVAILABLE → CANCELLED`), annulation livreur avant collecte (`ASSIGNED → AVAILABLE`, remplace un ancien statut `DRIVER_CANCELLED_BEFORE_PICKUP` retiré), client absent (`COLLECTED → RETURNING → RETURNED`, seul chemin possible après collecte — plus aucune annulation possible une fois `COLLECTED`).

```ts
function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}
function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(...)
}
```

**Constat important** : `assertTransition` n'est appelée nulle part dans le chemin d'écriture réel (repository) — voir §4. La garde effective en production est la clause `WHERE status = '...'` littérale de chaque méthode SQL, cohérente aujourd'hui avec la table mais non liée mécaniquement à elle.

**Cas particuliers** :
- La transition `COLLECTED → COMPLETED` par code de livraison prend un verrou de ligne explicite (`SELECT ... FOR UPDATE`) avant de vérifier/consommer les tentatives, car la logique de verrouillage anti-brute-force (3 tentatives max, `delivery_code_failed_attempts`) doit lire-puis-écrire de façon conditionnelle. Les preuves signature/photo suivent directement le CAS standard `WHERE status='COLLECTED' AND version=$N`.
- Les commandes sont créées directement au statut `AVAILABLE` — `CREATED` existe dans le type/enum mais n'est jamais persisté comme état intermédiaire par le chemin d'écriture actuel.
- `ASSIGNED → AVAILABLE` (annulation livreur avant collecte) et les deux transitions vers `CANCELLED` sont **déclarées légales et testées unitairement dans la state machine, mais aucune méthode de repository ni route HTTP ne les implémente** dans le code actuel — probablement hors du périmètre du flux vertical minimal actuellement livré ; à confirmer.

États retirés de l'enum d'origine (0001 → 0004, documentés dans l'ADR comme délibérément éliminés) : `IN_TRANSIT` (aucun événement/requête n'en dépendait), `AT_DELIVERY` (aucun chemin d'écriture légitime), `PROOF_COLLECTION`/`PAYMENT_PENDING` (étapes d'écran validées ensemble juste avant `COMPLETED`, pas des statuts persistés), `DRIVER_CANCELLED_BEFORE_PICKUP` (remplacé par `ASSIGNED → AVAILABLE` direct).

---

## 9. Système de dispatch

Le module `dispatch` remplace un ancien module `marketplace` (supprimé, visible en `git status`, non nettoyé dans `apps/api/CLAUDE.md`) par un dispatch **séquentiel**, une offre à la fois, vérifiée par VROOM — pas de diffusion à tous les livreurs éligibles.

### Table `dispatch_offers` (migration 0016)

```sql
create table dispatch_offers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  driver_id uuid not null references drivers(id),
  round smallint not null,
  radius_km numeric(4,2),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ACCEPTED','REJECTED','EXPIRED')),
  version integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index dispatch_offers_one_active_per_driver on dispatch_offers (driver_id) where status = 'ACTIVE';
create index dispatch_offers_order_idx on dispatch_offers (order_id, created_at);
```
L'**index unique partiel** `dispatch_offers_one_active_per_driver` est le mécanisme CAS central : impossible pour un livreur d'avoir deux offres `ACTIVE` simultanées, garanti par Postgres lui-même (pas de verrou applicatif). `orders.metadata jsonb` (0016) porte le suivi côté commande : `dispatch_attempts[]`, `dispatch_radius_km`, `dispatch_failed`.

### Séquence complète d'une offre

1. **Déclenchement** : `order.created.v1` (via l'outbox) appelle `StartDispatchUseCase.execute(orderId)`. Idempotent (no-op si une offre active existe déjà) ; abandonne silencieusement si la commande n'est plus `AVAILABLE`.
2. **Groupage (round 0, `radiusKm = null`)** : cherche des livreurs ayant déjà une commande active pour le **même commerçant** avec une heure de collecte dans une fenêtre de 30 minutes (`GROUPAGE_WINDOW_MINUTES`), excluant les livreurs déjà tentés, ne retenant que ceux avec une position connue.
3. **Escalade de rayon** : si le groupage échoue, tente successivement 1 km, 2 km, 3 km via `findAvailableWithinRadius` (Valkey, index de position + haversine), triés par distance croissante au point de collecte.
4. **Pour chaque candidat** (`NotifyNextCandidateUseCase`, séquentiel — un seul candidat testé à la fois) : vérifie disponibilité + capacité (`< 2` commandes actives), demande à VROOM si le candidat peut honorer ses commandes en cours **plus** la nouvelle (`checkFeasibility`). Premier candidat faisable → crée l'offre (`repository.createOffer`, expiration = `now + 60s` par défaut, `DISPATCH_OFFER_TTL_SECONDS`), planifie l'expiration via pg-boss, arrête la boucle.
5. **Réponse du livreur** (`POST /dispatch-offers/:id/accept|reject`) ou **expiration** (job pg-boss) : `accept` bascule l'offre `ACCEPTED` (CAS) puis assigne la commande (`AssignOrderUseCase`, CAS indépendant — **écart documenté explicitement dans le code** : si l'assignation échoue après acceptation de l'offre, la réconciliation est différée, non automatisée) ; `reject`/`expire` enregistrent une tentative (`dispatch_attempts`) puis relancent immédiatement `StartDispatchUseCase` pour le candidat suivant.
6. **Épuisement** : si tous les rounds échouent sans candidat faisable, `orders.markDispatchFailed` marque `metadata.dispatch_failed = true` et émet `order.dispatch_failed.v1` (→ notifie le commerçant en Socket.io, room `merchant_${id}`).
7. **Panne VROOM** : si VROOM est injoignable, le run de dispatch est abandonné silencieusement, sans exclure de livreur ni marquer d'échec — le filet de sécurité est le cron de réconciliation pg-boss (5 min).

### Paramètres VROOM exacts (`infrastructure/vroom-dispatch-planner.ts`)

```json
{
  "vehicles": [{
    "id": 1, "profile": "bike", "capacity": [2], "speed_factor": 1.0,
    "start": [driverLng, driverLat], "end": [driverLng, driverLat]
  }],
  "shipments": [{
    "pickup":   { "id": N, "location": [pickupLng, pickupLat],   "service": 60, "time_windows": [[pickupAt, pickupAt]] },
    "delivery": { "id": N, "location": [deliveryLng, deliveryLat], "service": 60, "time_windows": [[deliveryAt, deliveryAt + 600]] }
  }]
}
```
`service: 60` (1 min de service à chaque arrêt), `capacity: [2]` (2 commandes simultanées max par livreur — cohérent avec le seuil de capacité utilisé côté application), `profile: 'bike'` (obligatoire — VROOM par défaut sur `"car"`, non déclaré côté serveur, ce qui provoquerait une 400 mal classée). La requête HTTP vers VROOM est bornée à **5000 ms** (`AbortSignal.timeout(5_000)`, vérifié dans `vroom-dispatch-planner.ts`) — plus court que le `timeout: 300000` déclaré côté configuration VROOM elle-même (`infra/vroom/config.yml`), donc c'est bien le client API qui impose la limite pratique. Résultat non faisable si `unassigned.length > 0`.

**Refus d'offre — champ `reason` non exploité** : le corps `POST /dispatch-offers/:id/reject` accepte un champ `reason` libre optionnel (validé par Zod, 1 à 500 caractères), mais `RejectDispatchOfferUseCase` enregistre toujours la tentative avec un motif fixe littéral `'refused'` dans `dispatch_attempts` — le texte fourni par le livreur n'est ni persisté ni utilisé ailleurs dans le code lu.

### Jobs pg-boss et clés Valkey liées

Voir §4 (jobs pg-boss) et §5/§10 (clés Valkey `drivers:position_ids`, `driver:{id}:current_position`/`last_known_position`, utilisées par `findAvailableWithinRadius`).

---

## 10. GPS et disponibilité livreur

Les deux signaux sont **explicitement dissociés** : un livreur peut être disponible sans position récente, ou avoir une position récente sans être disponible (l'envoi de position en mode "idle disponible" continue même hors commande active).

### Clés Valkey

| Clé | TTL | Détail |
|---|---|---|
| `driver:${driverId}:is_available` | 600s, renouvelé par `EXPIRE` (heartbeat) | ne ressuscite jamais une clé déjà expirée — l'absence de heartbeat pendant >600s rend le livreur indisponible sans écriture explicite |
| `driver:${driverId}:collected_count` | aucun | compteur de capacité (0..2) |
| `driver:{${driverId}}:current_position` | 300s | position GPS "chaude" |
| `driver:{${driverId}}:last_known_position` | aucun | fallback après expiration de la position chaude |
| `drivers:position_ids` | aucun | index Set utilisé pour la recherche par rayon |

Écriture via script Lua atomique (`RecordDriverLocationUseCase` → `ValkeyDriverPositionRepository.record()`) : rejette toute position dont l'horodatage est antérieur à la dernière connue (anti-régression sur une livraison de paquets GPS désordonnée), tout en maintenant l'index à jour même dans ce cas.

Persistance durable Postgres (`driver_locations`, rétention 7 jours) : **seulement si le livreur a une commande active** — sinon la position ne va qu'en Valkey (éphémère). Les positions purgées automatiquement par le worker outbox.

### Modes GPS côté mobile (`apps/mobile/lib/location-tracking.ts`)

```ts
function trackingOptions(hasActiveOrder: boolean) {
  return {
    accuracy: hasActiveOrder ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: hasActiveOrder ? 5_000 : 30_000,       // ms
    distanceInterval: hasActiveOrder ? 10 : 50,          // mètres
  }
}
```
- **Mode "en course"** (commande `ASSIGNED`/`COLLECTED`) : précision élevée, intervalle 5s, distance minimale 10 m.
- **Mode "disponible / idle"** : précision équilibrée, intervalle 30s, distance minimale 50 m.

Suivi implémenté via `expo-location` + `expo-task-manager` (`TaskManager.defineTask`), **en arrière-plan** (notification Android foreground-service obligatoire, `isAndroidBackgroundLocationEnabled: true`). Aucune position n'est envoyée si le livreur est indisponible. Un "watchdog" local repasse automatiquement le livreur indisponible après 2 minutes d'erreur GPS confirmée (`GPS_ERROR_GRACE_MS`) ou 5 secondes de perte réseau confirmée (`NETWORK_LOSS_DEBOUNCE_MS`), en complément du TTL serveur de 600s.

**Écart documentation/code** : `apps/mobile/docs/screen-contracts.md` décrit un GPS "foreground only" ; le code livré fait du tracking en arrière-plan complet — soit la décision a changé depuis la rédaction du contrat, soit le document est obsolète.

### Heartbeat de disponibilité

`HEARTBEAT_INTERVAL_MS = 2 min`, actif uniquement pendant que `available === true`. `POST /api/v1/drivers/heartbeat`, corps `{}` (Fastify exige un corps JSON avec ce content-type). Ne transporte ni position ni autre donnée — distinct de `recordLocation`.

---

## 11. Frontend web (apps/web)

### Routes (App Router)

| Route | Type | Rôle |
|---|---|---|
| `/` | server | redirige vers `/login` ou `/merchant/new` selon la session |
| `/login` | client | email/mot de passe (Supabase Auth) |
| `/merchant/new` | client | création de commande (CTA principal) |
| `/merchant/orders` | client | liste des commandes, onglets En cours/Programmé/Terminé, rafraîchissement temps réel |
| `/merchant/account` | client | profil commerçant, logo, changement email/mot de passe, bouton Stripe Connect désactivé |
| `/track/[token]` | client | suivi public non authentifié |

**Non implémenté malgré la documentation** : `apps/web/CLAUDE.md` décrit un back-office `/admin/*` (Phase 4) et une page `/merchant/notifications` — **aucune des deux n'existe** dans le code actuel. `apps/web/public/{merchant,driver}.html` sont des pages HTML statiques de démo Phase 1, indépendantes de l'app Next.js (Socket.io CDN, pas de JWT, query-param `zoneId`).

### Composants principaux

`ui/` (Button, Dialog/Radix, Input, Textarea, Toast) ; composants métier : `AddressAutocomplete` (appelle OpenCage **directement depuis le navigateur**), `DeliveryMap`/`TrackingMap` (Leaflet, chargés en `next/dynamic({ssr:false})`), `OrderCard`/`OrderModal` (liste et détail commande — inclut un stopgap temporaire affichant le code de livraison en clair au commerçant en attendant Twilio, et un bouton "Signaler un litige" désactivé), `PriceCard`, `Sidebar`.

### Connexion Socket.io

Deux usages distincts :
- `/merchant/orders` : namespace par défaut, `io(apiUrl, {transports:['websocket'], auth:{token: <JWT Supabase>}})`. Écoute `new_order`, `order_taken`, `order_updated` (déclenche un refetch complet, pas de patch incrémental) et `dispatch_failed` (refetch + toast d'erreur). **Constat vérifié (voir §4)** : le socket commerçant ne rejoint jamais de room de zone, or `order_taken`/`order_updated` ne sont émis que vers les rooms de zone — ces deux écouteurs ne se déclenchent donc jamais en pratique. `new_order` n'est de toute façon jamais émis par le serveur (aucun `emit('new_order', ...)` trouvé côté API). **Seul `dispatch_failed` fonctionne réellement** comme mécanisme de rafraîchissement temps réel côté commerçant ; une commande nouvellement assignée/collectée/complétée n'est visible côté web qu'après un rechargement manuel ou une navigation qui redéclenche `loadOrders()`.
- `/track/[token]` : namespace `/tracking`, `auth: {tracking_token}` (pas de JWT). Écoute uniquement `driver_position_updated`. Complété par un poll de secours toutes les 20s sur l'endpoint REST de tracking, car aucun changement de statut n'est jamais émis sur ce canal (règle "jamais de GPS dans le bus d'événements métier").

### Auth

Supabase Auth email/mot de passe, session en cookies via `@supabase/ssr` (pas de `localStorage`). Trois clients Supabase distincts selon le contexte d'exécution Next.js (navigateur, Server Component, middleware). Protection des routes via `apps/web/proxy.ts` (équivalent du middleware Next.js — renommé dans cette version de Next), redirection `/merchant/*` → `/login` si non authentifié, revérification server-side redondante dans `app/merchant/layout.tsx`.

**Aucun test** n'existe sous `apps/web` (aucun fichier `*.test.*`/`*.spec.*`, aucun runner configuré).

---

## 12. App mobile livreur (apps/mobile)

### Écrans (expo-router)

3 onglets fixes : **Carte** (`(tabs)/map`), **Mes courses** (`(tabs)/orders`), **Compte** (`(tabs)/compte`, avec deux sous-routes cachées `mon-compte` et `wallet`). Écrans en modal (stack racine) : `order/[id]/index` (détail + actions contextuelles selon statut), `order/[id]/proof` (preuve de livraison en 4 étapes), `dispatch-offer/[id]/index` (décision d'offre, geste de fermeture désactivé, compte à rebours 60s).

**Écrans stub identifiés explicitement dans le code** : `compte/mon-compte.tsx` (champs en lecture seule, tous les boutons affichent un toast "bientôt disponible") ; `compte/wallet.tsx` (données de démonstration simulées tant qu'aucune commande complétée réelle n'existe).

### Navigation et garde de session

Stack racine avec garde combinant l'état des polices et de la session ; redirige vers `/login` si non authentifié-livreur, vers `/(tabs)/map` sinon. `useDriverLocationTracking`/`useIncomingDispatchOffer` montés au niveau des tabs (pas du layout racine) pour survivre aux changements d'onglet tout en lisant l'état de disponibilité.

### Contextes globaux

- `AuthProvider`/`useAuth()` : état de session Supabase, rôle extrait de `app_metadata.role`.
- `AvailabilityProvider`/`useAvailability()` : état de disponibilité, résolu au démarrage via `GET /drivers/me` (jamais de valeur locale par défaut avant confirmation serveur).
- `useIncomingDispatchOffer()` : hook d'écoute globale (pas un vrai Context), ouvre l'écran d'offre dès réception de `dispatch_offer_created`.

### MapLibre

Carte plein écran centrée sur Bourg-en-Bresse (`[5.2255, 46.2058]`, zoom 10, bornes `[5.10,46.10,5.40,46.32]`), style MapTiler (clé `EXPO_PUBLIC_MAPTILER_KEY`, **absente de `.env.example`** — écart de documentation). Marqueurs de collecte par commande visible (zone tactile 52px pour un disque visuel de 28px, conforme à la règle Terrain "touch target ≥52px"), marqueur de livraison uniquement pour la commande sélectionnée dans le carrousel. Tracé d'itinéraire OSRM par `GeoJSONSource`. **Aucun marqueur de position GPS du livreur lui-même n'est rendu** — le suivi GPS alimente uniquement le backend, pas d'affichage local.

### GPS et notifications push

Voir §10 pour le détail GPS. Notifications push : `expo-notifications`, canal Android `new-orders`, token Expo Push comparé à `expo-secure-store` avant réenregistrement, retry automatique toutes les 30s en cas d'échec (`POST /api/v1/drivers/push-token`). `google-services.json` présent (projet Firebase `locadely-49c60`), **aucune configuration iOS** trouvée (`app.json` liste `"platforms": ["android", "web"]` uniquement, malgré `CLAUDE.md` mentionnant "iOS + Android").

### Socket.io mobile

Singleton `getSocket(zoneId, token)`, `transports:['websocket']` uniquement. Écoute `order_taken` (retire une commande prise par un autre livreur) et `dispatch_offer_created`. **Écart détecté** : `docs/screen-contracts.md` documente un événement `new_order` et un écran "commandes disponibles" — **aucun listener `new_order` ni écran de ce type n'existe dans le code actuel** ; `api.getAvailableOrders` est défini mais n'est appelé nulle part.

### Endpoint mort : `api.assignOrder`

`apps/mobile/lib/api.ts` définit `assignOrder(orderId, expectedVersion)` qui appelle `POST /api/v1/orders/${orderId}/assign` (vérifié ligne 93-94 du fichier). **Cette route n'existe plus côté API** (la liste complète des routes `orders` en §6 ne comporte aucune route `.../assign` — l'assignation d'une commande ne se fait plus que via l'acceptation d'une offre de dispatch, `POST /dispatch-offers/:id/accept`). Cette fonction du client mobile est donc du code mort/obsolète, vraisemblablement un reliquat du modèle d'assignation directe antérieur au module `dispatch`.

### Design system

`tailwind.config.js` copie littéralement les tokens Terrain. NativeWind v4. Couleurs hors `className` (icônes, `ActivityIndicator`) centralisées dans `lib/colors.ts`. Règles Terrain vérifiées dans le code : touch targets ≥52px, texte jamais sous 16px (exception documentée : labels d'onglets à 14px).

**Aucun test** n'existe sous `apps/mobile`.

---

## 13. Authentification et sécurité

### Supabase Auth — JWT

`SupabaseJwtVerifier` (`apps/api/src/modules/auth/infrastructure/supabase-jwt-verifier.ts`) : vérification via **JWKS distant** (`jose.createRemoteJWKSet`, `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), `issuer = ${SUPABASE_URL}/auth/v1`, `audience: 'authenticated'` imposé. L'algorithme exact (ES256 selon la configuration Supabase standard) est négocié par `jose` à partir des métadonnées de la clé publiée, pas codé en dur côté application. Rôle extrait exclusivement de la claim custom `app_metadata.role` (`merchant`/`driver`/`admin`), absence ou valeur invalide → `UnauthorizedError`. Toute autre erreur de vérification (signature, expiration, issuer/audience) est normalisée en un message générique, sans fuiter le détail `jose` au client.

### Middleware Fastify

Hook global `onRequest` : ignore `OPTIONS` (préflight CORS) et les chemins hors `/api/v1/*`, exemption explicite pour `GET /api/v1/orders/track/:token` (sécurité par possession du token, pas par JWT). Pour toute autre route `/api/v1/*` : exige `Authorization: Bearer <token>`, 401 sinon, attache `request.authUser` en cas de succès. Les vérifications de rôle (`authUser.role !== 'driver'` etc.) sont répétées **individuellement dans chaque handler** — pas de décorateur Fastify réutilisable observé.

### Row Level Security

**Aucune RLS configurée** dans les 17 migrations (aucun `ENABLE ROW LEVEL SECURITY`, aucun `CREATE POLICY`) — le contrôle d'accès repose entièrement sur la couche applicative (JWT + vérifications de rôle par handler), pas sur des politiques Postgres.

### Rate limiting

Global : 100 req/min par IP (`@fastify/rate-limit`). Spécifique : 20 req/min sur `GET /api/v1/orders/track/:token` (endpoint public, token potentiellement devinable — protection anti-énumération renforcée, confirmée par un test dédié qui vérifie un 404 identique pour un token inconnu ou malformé).

### Optimistic locking

Voir §4/§6 — CAS par colonne `version` sur `orders` et `dispatch_offers`, testé sous concurrence réelle.

### CORS

`@fastify/cors` avec `{origin: true}` — reflète n'importe quelle origine de requête (permissif, pas de liste blanche de domaines observée).

---

## 14. Tests

### Backend (apps/api)

`vitest.config.ts` : `environment: node`, `testTimeout: 15000` (relevé de 5000 pour absorber bcryptjs à 12 rounds sous contention). **La suite tourne majoritairement contre de vrais services locaux** : le pool Postgres partagé réel (`test/setup.ts` ferme le pool en fin de suite), une instance Supabase Auth locale réelle pour les tokens de test (`scripts/seed-auth.sh` requis au préalable), un serveur OSRM réel, une API OpenCage réelle (pour au moins un test par fichier concerné), et des connexions Socket.io réelles en process. Quelques fichiers isolés utilisent des fakes/stubs pour leurs collaborateurs directs (ex. `DispatchRepository`, `PushProvider`) tout en dépendant toujours de la vraie base en aval.

Répartition (fichiers, non exhaustif ligne à ligne) : `dispatch/` (1 fichier — pas de test dédié pour `start-dispatch`, `notify-next-candidate`, `vroom-dispatch-planner`, `postgres-dispatch-repository`), `drivers/` (6 fichiers), `http/` (8 fichiers, y compris auth et scoping d'identité), `merchants/` (2), `notifications/` (2), `orders/` (12, y compris state machine exhaustive et tests de concurrence réelle), `pricing/` (2, y compris cross-check contre la colonne générée Postgres), `realtime/` (1, worker outbox avec vrais sockets), `routing/` (2, OSRM/OpenCage réels). Aucun test dédié pour le module `zones` ni `auth` au-delà du test HTTP générique.

`npm test` = `vitest run` (suite complète) ; `npm run test:concurrency` = uniquement `test/orders/race-condition.integration.test.ts`, exécuté isolément.

### Frontend web / mobile

**Aucun fichier de test** dans `apps/web` ni `apps/mobile` — aucun runner configuré (pas de script `test`, aucune dépendance Jest/Vitest/Testing Library). La qualité de ces deux apps repose uniquement sur `typecheck` et `lint`.

### CI (`.github/workflows/ci.yml`)

Un seul workflow, un seul job (`ubuntu-latest`), déclenché sur push vers `main` et toute pull request : checkout → Node 24 (cache npm) → `npm ci` → `npm run typecheck` → `npm run lint` → `npm run check:boundaries` → `npm test`. Pas de matrice, pas de conteneurs de service (Postgres/Valkey/OSRM/VROOM) définis dans le workflow — la manière dont les tests d'intégration d'`apps/api` obtiennent ces services en CI n'a pas été vérifiée dans ce document (hors du périmètre des fichiers lus). Pas d'étape de build ni de déploiement.

---

## 15. Annexe — écarts documentation vs code constatés

Récapitulatif des divergences relevées au fil du document entre les `CLAUDE.md`/ADR/contrats d'écran et le code réellement présent, à corriger ou clarifier :

1. **Phase déclarée obsolète** : le `CLAUDE.md` racine et chaque `CLAUDE.md` d'app décrivent une "Phase 1 sans auth/photos/paiement" ; le code contient déjà auth JWT complète, dispatch VROOM/pg-boss, push, GPS, preuve de livraison, gains, et une app mobile entièrement construite.
2. **Module `marketplace`** : documenté comme actif en Phase 1 dans `apps/api/CLAUDE.md`, entièrement supprimé du code (remplacé par le module `dispatch`).
3. **pg-boss** : `apps/api/CLAUDE.md` affirme qu'il n'est "pas encore installé" ; il est en réalité une dépendance directe pleinement câblée.
4. **PostGIS** : mentionné dans le `CLAUDE.md` racine comme partie de la stack Postgres ; aucune migration ne l'installe, tout est en `double precision` + haversine applicatif.
5. **`no dev:mobile` script racine** malgré sa mention dans le `CLAUDE.md` racine.
6. **`apps/web/CLAUDE.md`** décrit `/admin/*` et `/merchant/notifications` : aucun des deux n'existe.
7. **`packages/shared`** : vide, non consommé — seul point du `CLAUDE.md` qui correspond exactement à l'état "Phase 1" documenté.
8. **`seed.sql`** insère dans `merchants.phone`, colonne renommée `phone_landline` en migration 0015 — incohérence littérale entre seed et schéma actuel.
9. **GPS mobile** : `docs/screen-contracts.md` décrit un tracking "foreground only" ; le code livré fait du tracking en arrière-plan complet (`expo-task-manager`).
10. **Écran "Disponibles" / événement `new_order`** : documentés dans `docs/screen-contracts.md` côté mobile, non implémentés dans le code actuel (`api.getAvailableOrders` défini mais jamais appelé).
11. **Plateformes mobiles** : `apps/mobile/CLAUDE.md` dit "iOS + Android" ; `app.json` ne liste que `["android", "web"]`, pas de configuration iOS trouvée.
12. **Clé MapTiler** (`EXPO_PUBLIC_MAPTILER_KEY`) utilisée dans le code mobile mais absente de `apps/mobile/.env.example`.
13. **`assertTransition`** (state machine) jamais appelée en production — la garde réelle est dupliquée en SQL littéral dans chaque méthode du repository.
14. **Transitions `ASSIGNED → AVAILABLE`** et **`→ CANCELLED`** : légales dans la table de transitions et testées unitairement, mais sans méthode de repository ni route HTTP les implémentant.
15. **Haversine dupliqué 3 fois** indépendamment (`orders/domain/geo.ts`, `drivers/infrastructure/valkey-driver-position-repository.ts`, `dispatch/application/start-dispatch.ts`) plutôt que partagé.
16. **`SendNewOrderPushesUseCase`** : implémenté et testé mais aucun point d'appel trouvé dans le flux de dispatch séquentiel actuel — probablement un reliquat de l'ancien modèle de diffusion large (`marketplace`).
17. **Temps réel commerçant effectivement mort pour la plupart des événements** (vérifié dans le code, `realtime/socket-handler.ts`) : les commerçants ne rejoignent jamais de room de zone, or `order_taken`/`order_updated` ne sont émis que vers ces rooms — seul `dispatch_failed` atteint réellement un socket commerçant. L'écran `/merchant/orders` écoute aussi `new_order`, qui n'est jamais émis par le serveur. En pratique, le commerçant ne voit une commande changer de statut qu'en rechargeant/renaviguant la page, pas en temps réel (à l'exception du cas d'échec de dispatch).
18. **`apps/mobile/lib/api.ts` → `assignOrder()`** cible `POST /api/v1/orders/:id/assign`, route absente de l'API actuelle — code mort côté mobile, reliquat du modèle d'assignation directe pré-dispatch.
19. **`scripts/simulate.sh`** appelle la même route `.../assign` inexistante à son étape 5 — le script échouerait (404) s'il était exécuté aujourd'hui ; il ne reflète plus le flux d'assignation réel (désormais exclusivement via acceptation d'offre de dispatch).
