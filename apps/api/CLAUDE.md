# apps/api

Backend Fastify. API REST `/api/v1/` + WebSocket (Socket.io) + worker outbox.

## Stack

Fastify · TypeScript strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Zod (validation entrées) · Pino JSON (logs) ·
Supabase CLI Postgres (port 54322, DB `postgres`) · Valkey 8.x (port 6379,
`maxmemory 256mb noeviction`) · pg-boss (Phase 2+ uniquement) · Socket.io
(`transports: ["websocket"]` seulement, jamais long-polling) · OSRM (port
5000, bbox Bourg-en-Bresse).

## Commandes

```bash
npm run dev -w apps/api          # hot reload, port 3000
npm run test -w apps/api         # vitest
npm run test:concurrency -w apps/api   # tests de course/concurrence
npm run typecheck -w apps/api
npm run lint -w apps/api
```

## Structure d'un module

```
src/modules/{name}/
  domain/            entités, value objects, événements — zéro dépendance externe
  application/       use cases (create-order, assign-order, ...)
  ports/             interfaces abstraites (OrderRepository, RoutingProvider, ...)
  infrastructure/    implémentations concrètes des ports
  transport/http/    routes Fastify — appellent un use case, rien d'autre
  public.ts          seul fichier importable par les autres modules
```

Modules : `zones`, `merchants`, `drivers`, `pricing`, `orders`, `marketplace`,
`auth` (actifs en Phase 1) · `tracking`, `notifications`, `payments`,
`integrations` (vides jusqu'à Phase 2/3).

`auth` : vérification JWT Supabase (JWKS) sur tout `/api/v1/*` sauf le
tracking public et `POST /api/v1/auth/merchant-signup` ; expose aussi le
port `AuthAdmin` (création/suppression d'utilisateur Supabase Auth via
l'API Admin `fetch`-based, `infrastructure/supabase-auth-admin.ts`) utilisé
par `merchants` pour l'inscription. `SUPABASE_SECRET_KEY` (nouvelle Secret
API Key Supabase, remplace l'ancienne `service_role` legacy) est désormais
**obligatoire** (`platform/config.ts`) — l'API ne démarre pas sans, y
compris en local. Strictement backend : jamais `NEXT_PUBLIC_*`, jamais
loggée, jamais commitée.

## Règles spécifiques backend

- Deux connexions PostgreSQL distinctes, jamais interchangeables :
  `DATABASE_URL` (Supavisor, transaction mode, pour l'API) et
  `PGBOSS_DATABASE_URL` (connexion directe, session mode, pour pg-boss —
  **non utilisée en Phase 1**, pg-boss n'est pas encore installé).
- Outbox minimal actif dès Phase 1 : table `outbox_event` + relais
  `platform/outbox-relay.ts` (`setInterval` + `SELECT ... FOR UPDATE SKIP
  LOCKED`). Pas de pg-boss tant qu'aucun job différé réel n'existe.
- Machine à états commande : `modules/orders/domain/order-state-machine.ts`,
  table de transitions figée dans `docs/adr/0001-order-states.md` — ne pas
  la modifier sans mettre à jour l'ADR.
- Formule de prix : `modules/pricing/domain/*` — voir
  `docs/adr/0002-pricing-formula.md`. `floor()` par composante, jamais de
  float, jamais d'arrondi au total.
- Chaque requête HTTP porte un `correlationId` propagé dans tous les logs
  Pino et tous les événements émis.
- Assignation d'une commande : `UPDATE ... WHERE status='AVAILABLE' AND
  driver_id IS NULL AND version=$N`. Zéro ligne affectée = conflit, pas une
  erreur serveur.
- OCR (Phase 3) : utiliser le structured output / JSON Schema natif de
  l'API Mistral Small 4, jamais un prompt "retourne du JSON" seul.
- Paiement carte à la livraison (COD) : Stripe Terminal, **Direct Charge** sur
  l'Account v2 du restaurant (voir `docs/adr/0003-cod-direct-charge.md`). Le
  module `cash-on-delivery` possède sessions, paiements et provider Stripe ; il
  ne dialogue avec `orders`/`payments` que via leur `public.ts` (fonctions
  « participantes » recevant un `PoolClient`). Le PaymentIntent (`card_present`,
  capture manuelle, sans frais ni transfert) est créé par le serveur avec le
  montant figé sur la commande ; le mobile ne fournit jamais montant, devise,
  compte, état payé ni état livré. `finalize` relit le PI chez Stripe, capture
  (clé d'idempotence dérivée du paiement local ; `payment_intent_unexpected_state`
  ⇒ relire, `succeeded` = succès), puis UNE transaction : paiement, session et
  commande `COMPLETED` (`cash_on_delivery_collected_at`) ; un CHECK en base
  interdit `COMPLETED` sans encaissement. Le mode `readerFamily` simulé est refusé
  hors `TERMINAL_ALLOW_SIMULATED_READER=true`. Un restaurant n'a la configuration
  `merchant` (`dashboard=full`, responsabilités `stripe`/`stripe`, non modifiables
  ensuite) que sur opt-in ; toute création de commande COD exige `card_payments`
  actif. Aucune donnée d'identité/KYC Stripe n'est dupliquée localement.
  Opt-in : `GET /api/v1/merchants/me/card-payments` (état dérivé des capabilities
  `card_payments`/`cartes_bancaires_payments`, relu chez Stripe puis mis en cache dans
  `merchant_stripe_connect`) et `POST …/card-payments/onboarding-link` (ordre imposé :
  `ensureMerchantStripeAccount` de `payments` — création sérialisée + synchro d'identité
  tant que `merchant` est absent — puis `addMerchantConfiguration` une seule fois, puis lien
  hébergé `['customer','merchant']`). La garde de création de commande COD
  (`orders/ports/card-payments-readiness.ts`, câblée dans `app.ts` sur
  `CardPaymentsUseCases.isReady`) relit Stripe et échoue fermé : Stripe désactivé ou en erreur
  = 409 `CardPaymentsNotReady`, jamais de COD sans `card_payments` actif prouvé. Le défaut
  permissif de `createOrdersModule` est réservé aux tests ; `buildApp({ connectProvider })`
  permet d'injecter un fake Connect.
- Inscription commerçant (`POST /api/v1/auth/merchant-signup`, route
  publique exemptée du hook JWT sur ce chemin exact) : provisioning en deux
  temps sans transaction traversant le réseau — création de l'utilisateur
  Supabase Auth (`role: 'merchant'` directement, pas de rôle intermédiaire
  type `merchant_pending` — inutile, toute route métier échoue déjà
  proprement en 404 sans ligne `merchants` correspondante) puis insertion
  `merchants` incomplète
  (`onboarding_completed = false`, `zone_id`/`address`/`lat`/`lng`/téléphones
  tous `null`) dans une transaction locale. Échec de l'insert → compensation
  synchrone (suppression de l'utilisateur Auth) ; échec de la compensation →
  log explicite (`correlationId` + id Auth orphelin), pas de retry
  automatique. Voir `modules/merchants/application/provision-merchant.ts`.
- `merchants.onboarding_completed` (migrations `0018`/`0019`) : `zone_id`,
  `address`, `lat`, `lng` et les téléphones sont nullable ; passer à `true`
  exige ces quatre champs plus `phone_primary` (CHECK
  `merchants_onboarding_completed_check`). La complétude de la seule section
  opérationnelle est dérivée dans le domaine par
  `merchantInformationCompleted` (nom, adresse, coordonnées, zone et
  téléphone principal) : elle reste indépendante de l'onboarding global.
  Temporairement, `POST /api/v1/orders` n'est pas conditionné par
  `onboarding_completed` mais refuse toujours (403) un `merchantId` différent
  de `request.authUser.id` et exige les données opérationnelles nécessaires.
  Réactiver la garde globale dans `CreateOrderUseCase` une fois l'onboarding
  complet. `GET /api/v1/orders/estimate` exige également uniquement
  `merchant.lat`/`lng`/zone.
- Le géocodage est le module transversal `modules/geocoding` (frontière
  `public.ts`), utilisé par les commandes et les informations commerçant. Le
  serveur géocode l'adresse commerçant puis le module `zones` détermine la
  zone : ne jamais accepter `lat`, `lng` ou `zoneId` du client.
- Les informations légales/facturation sont stockées dans
  `merchant_legal_information` (relation 1:1 avec `merchants`) pour séparer
  l'identité facturable des données opérationnelles. Les adresses sont
  postales structurées, sans géocodage. Le SIREN est toujours déduit du SIRET
  côté serveur. Sirene est un provider interne à
  `merchants` : l'appel serveur préremplit mais ne persiste jamais seul.
  Son adresse postale courante est l'objet Sirene 3.11 `adresseEtablissement`,
  pas les champs plats historiques.
  `INSEE_API_KEY` reste exclusivement backend. Un échec technique ou d'accès
  autorise l'enregistrement manuel avec le statut métier `unavailable` ou
  `restricted`; une réponse Sirene techniquement inexploitable est traitée
  comme `unavailable`. Le statut Sirene 3.11 `P` (diffusion partielle) est
  traité comme `restricted` sans préremplir de données, notamment pour protéger
  les données d'entrepreneurs individuels; un SIRET explicitement introuvable est refusé. Ne jamais
  accepter ce statut depuis le client.
- Le moyen de paiement SEPA commerçant est séparé dans
  `merchant_payment_methods` : les objets Stripe (`Account` v2 customer-configured, `SetupIntent`,
  `PaymentMethod`, `Mandate`) vivent sur le compte plateforme. L'API ne reçoit
  jamais d'IBAN ni de `client_secret` à persister ; seul un résumé bancaire non
  sensible est conservé. Cette capacité reste indépendante de
  `onboarding_completed`.
- Le restaurant-payeur est un Account Stripe v2 « customer-configured » (jamais
  Customer v1). Il peut aussi recevoir `merchant` pour les paiements carte.
  Il est créé avec sa seule identité stable (`configuration.customer: {}` +
  `metadata.merchant_id`) sous la clé d’idempotence déterministe
  `merchant-customer-account-<merchantId>` : Stripe rejette pendant 24 h une clé
  réutilisée avec d’autres paramètres et rejoue même un échec, donc aucune
  donnée modifiable ne doit figurer dans la création. Le nom légal
  (`display_name`, `registered_name`), l’e-mail du compte (`contact_email`) et
  `billingAddress` (sinon `legalAddress`, `identity.business_details.address`,
  `entity_type: 'company'`, pays en minuscules) sont poussés par
  `updateCustomerAccount` avant chaque SetupIntent tant que `merchant` est
  absent; après, en France, `account_token_required` interdit la mise à jour
  d'identité API et Stripe/onboarding devient source de vérité. Le mandat SEPA
  vient du `billing_details` du PaymentMethod. Accounts v2 rejette une `line2`
  vide ou blanche avec `invalid_fields`, donc le provider l’omet. Un conflit
  `idempotency_key_in_use` est retenté (100/250/500 ms) en relisant le profil.
  `merchant_payment_profiles.stripe_account_id` (migration `0025`, qui refuse de
  renommer une base contenant encore des `cus_…` : un cutover Stripe séparé est
  alors requis). Les appels `v2.core.accounts.*` n'envoient aucune version
  explicite : le SDK utilise sa version GA (Accounts v2 est GA pour une
  plateforme Connect, ce qu'est Locadely). `STRIPE_ACCOUNTS_V2_API_VERSION` est
  un override facultatif sans valeur par défaut (ex. une version `.preview` pour
  une plateforme sans Connect, qui doit alors activer Accounts v2 dans le
  Dashboard Settings → Previews), transmis uniquement à ces appels; les autres
  appels (SetupIntent, PaymentMethod, Mandate) ne le reçoivent jamais. Le client
  Stripe a `timeout` 20 s et 2 retries réseau.
  `apiVersion` se passe uniquement dans l’objet d’**options** de requête (dernier
  argument, `RequestOptions.apiVersion`), jamais dans les paramètres : placée
  dans le corps, l’API répond `400 invalid_fields` (`'apiVersion: Unknown
  field.'`) et le typage la refuse (TS2353); dans le constructeur, le type
  n’accepte que la version GA du SDK (TS2322). Vérifié en Sandbox avec Connect
  actif : `retrieve`, `update` et le rejeu idempotent de `create` réussissent sans
  version explicite, le SDK envoyant sa version GA; une version inexistante
  répond `400 Invalid Stripe API version`, donc casserait toute création de
  SetupIntent. Sans
  override, l’`update` est appelé sans 3ᵉ argument : un objet d’options vide
  n’est pas reconnu comme options par le SDK.
- Création d’un SetupIntent avec une tentative `setup_pending` : réutilisation
  si Stripe la donne `requires_payment_method`/`requires_confirmation`/
  `requires_action`; `processing` → 409 `SetupProcessing`; `succeeded` →
  finalisation puis 409 `SetupAlreadyCompleted`; `canceled` → invalidation et
  nouvelle tentative; statut inconnu → 409 `SetupStatusUnsupported`.
  `/complete` renvoie un moyen déjà `active` sans appel Stripe et refuse
  (409 `PaymentMethodNotReady`) une tentative terminale. Il ne détache jamais
  l’ancien moyen : celui-ci passe `detach_pending` dans la transaction
  d’activation et le worker le détache ensuite.
- Restriction SEPA : le SetupIntent porte `allowed_payment_method_types:
  ['sepa_debit']` (jamais `payment_method_types`, déconseillé par Stripe) et
  `usage: 'off_session'`.
- Les réponses `GET` et `/complete` n’exposent que l’état et le résumé non
  sensible (`bankName`, `last4`, `country`); le `clientSecret` est la seule
  donnée Stripe transmise au navigateur, uniquement lors de la création. Les
  erreurs publiques valent `{ error, correlationId }` avec un code stable, sans
  message brut : `InvalidRequest` 400; `PaymentMethodNotReady`, `SetupProcessing`,
  `SetupAlreadyCompleted`, `SetupStatusUnsupported`, `CustomerCreationInProgress`
  409; `SetupNotCompleted`, `LegalInformationRequired`, `AccountEmailUnavailable`
  422; `StripeUnavailable` 503; `StripeProviderError` 502; toute autre erreur
  `InternalError` 500.
- La version installée de Stripe ne fournit pas de nom de banque dans le
  `PaymentMethod` SEPA : ce champ reste donc nul plutôt que d’être inféré ou
  conservé depuis une donnée non normative.
- Les champs `billing_details` Stripe sont optionnels dans le SDK, mais le use
  case n’ouvre un SetupIntent qu’après avoir validé les informations légales et
  l’e-mail requis localement.
- Pour les prélèvements futurs, le Stripe Creditor ID est l’identifiant
  créancier technique de Stripe, distinct de Locadely qui facture le
  commerçant. Aucun mécanisme de pré-notification ni réglage automatique de
  l’affichage sur relevé n’est implémenté dans ce module.
- Le endpoint webhook Stripe vérifie la signature sur le corps HTTP brut via
  `fastify-raw-body`; les endpoints de finalisation valident exclusivement les
  identifiants SetupIntent par Zod et les rechargent côté serveur.
- Configuration Stripe : `STRIPE_PAYMENTS_ENABLED` vaut `false` par défaut (une
  valeur vide compte aussi pour `false`). Désactivé, aucune clé n’est exigée et
  des clés présentes sont ignorées : le provider est indisponible, le worker de
  paiements n’est pas démarré et les routes Stripe répondent 503. Activé
  (`true`), `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` sont exigées
  simultanément au démarrage, dans tous les environnements.
  Les tests de configuration couvrent les valeurs vides, les paires incomplètes,
  le développement et la production.
  Une absence de clé ne peut pas être prise pour une signature webhook invalide.
- `test/setup.ts` force `STRIPE_PAYMENTS_ENABLED=false` et vide les clés : même
  si le `.env` local porte des clés Sandbox, les tests restent hors ligne.
- Réception webhook : seuls `setup_intent.succeeded`, `setup_intent.setup_failed`,
  `setup_intent.canceled`, `mandate.updated` et `payment_method.detached` sont
  persistés; tout autre type signé valide est acquitté 2xx sans persistance.
  La route est exemptée du rate-limit global. Un `merchant_id` de metadata
  n’est stocké que s’il a la syntaxe d’un UUID; la ligne locale du SetupIntent
  reste seule autorité de rattachement. Un `setup_intent.succeeded` dont la
  ligne locale est déjà terminale (`invalid`, `detach_pending`, `detached`) est
  un no-op terminal; une ligne inconnue échoue puis part en `dead_letter`.
- Endpoint webhook Stripe : abonner exactement ces cinq événements —
  `setup_intent.succeeded`, `setup_intent.setup_failed`, `setup_intent.canceled`,
  `mandate.updated`, `payment_method.detached`. `STRIPE_SECRET_KEY` : Stripe
  recommande une clé restreinte `rk_` plutôt qu’une clé secrète `sk_` (Accounts v2
  `/v2/core/accounts` et SetupIntents en écriture, PaymentMethods en écriture
  pour le détachement, Mandates en lecture — noms exacts à confirmer dans le
  Dashboard Sandbox).
- Worker de paiements (`startStripePaymentsWorker`, lancé par `buildApp()`
  uniquement si le flag est actif) : chaque cycle traite un lot de 10 événements
  webhook puis réconcilie 10 détachements `detach_pending`, chacun isolé par
  `try/catch` et sans appel Stripe dans une transaction. Détacher un
  PaymentMethod déjà absent (`resource_missing`) vaut succès. Les tests
  d’intégration de file (`postgres-payment-repository.integration.test.ts`)
  échouent explicitement si un worker externe (serveur de dev avec le flag
  actif) consomme la table : les exécuter alors avec un `DATABASE_URL` dédié.
- `stripe_webhook_events` ne contient ni payload ni secret : son statut
  `pending`/`processing`/`processed`/`failed`/`dead_letter` garantit que seule
  une mutation métier réussie déduplique un événement. Une livraison concurrente
  encore en cours doit être rejouée par Stripe, jamais acquittée comme un
  doublon réussi. Le `processing_token` lie la finalisation à son claim, y
  compris après la reprise d’un claim expiré (bail de 5 minutes).
  Un échec incrémente `attempts` et repousse `next_attempt_at` (backoff
  exponentiel 1 min → 6 h) : un événement défaillant ne bloque donc pas les
  suivants. À 20 tentatives il passe en `dead_letter` (jamais repris seul).
  `last_error` ne conserve que le nom de la classe d’erreur.
- `findDisplayMethod` privilégie le moyen `active`; un `invalid` n’est affiché
  que s’il a un `stripe_payment_method_id` (une tentative de remplacement
  échouée ne masque jamais le moyen actif). Les `detach_pending` portent
  `detach_attempts`/`detach_next_attempt_at`/bail (migration `0024`) pour une
  réconciliation durable du détachement.
- Une recharge de l’écran ne crée pas de tentative concurrente : le dernier
  `setup_pending` encore en `requires_payment_method` est repris; sinon il est
  invalidé localement avant la création d’une nouvelle tentative.
- Les tests de transport webhook emploient une signature HMAC locale qui reste
  effectivement vérifiée : absence ou invalidité répondent 400, tandis qu’un
  échec de traitement répond 500 pour déclencher la reprise Stripe.
- Le transport payments dépend d’un contrat local de handlers et non de
  `payments/public.ts`, afin de conserver les routes fines sans cycle de
  modules.
- Le résultat de claim webhook est discriminé (`claimed` avec jeton,
  `processed`, ou `in_progress`) avant toute mutation métier.
- Webhook Stripe Connect (Direct Charge COD) : `POST /api/v1/webhooks/stripe-connect`,
  endpoint distinct de `/api/v1/webhooks/stripe` (SEPA), avec son propre secret
  `STRIPE_CONNECT_WEBHOOK_SECRET`. Facultatif et jamais requis au démarrage : absent ou
  vide (ou `STRIPE_PAYMENTS_ENABLED=false`), la route répond 503 (jamais 400) et son worker
  n'est pas démarré. Publique uniquement sur ce chemin exact (`POST`, hook JWT) et exemptée
  du rate-limit global ; la signature est toujours vérifiée sur le corps brut (absente ou
  invalide = 400, échec de réception durable = 500 pour rejeu Stripe). Une destination
  d'événements Stripe = un secret : la variable accepte plusieurs secrets séparés par des
  virgules (une destination snapshot « comptes connectés » + une destination mince
  « Accounts v2 », même URL).
  Abonner exactement — snapshot (v1, portent `event.account`) : `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `payment_intent.canceled`,
  `payment_intent.amount_capturable_updated`, `charge.refunded`, `charge.dispute.created` ;
  minces (v2) : `v2.core.account[configuration.merchant].capability_status_updated`,
  `v2.core.account[configuration.merchant].updated`, `v2.core.account[requirements].updated`,
  `v2.core.account.closed`, et (livreurs, R30) `v2.core.account[configuration.recipient].capability_status_updated`,
  `v2.core.account[configuration.recipient].updated`. Tout autre type signé est acquitté 2xx sans persistance.
- Journal `stripe_connect_webhook_events` (migration `0029`, distinct de
  `stripe_webhook_events`) : jamais le payload, seulement l'id d'événement (unique), le type,
  le compte connecté (`event.account` ou `related_object.id`), l'id d'objet, le PaymentIntent
  et `merchant_id`/`order_id` de metadata s'ils ont la syntaxe d'un UUID (sans clé
  étrangère : jamais une autorité). Même mécanique que le SEPA : claim par
  `processing_token`, bail de 5 minutes, backoff exponentiel 1 min → 6 h, `dead_letter` à
  20 tentatives. Un événement n'est qu'un déclencheur : le worker (hors requête, aucun appel
  Stripe dans une transaction) appelle le port `reconcilePaymentIntent`, qui relit toujours le
  PaymentIntent chez Stripe ; le webhook ne finalise jamais une commande ni un paiement. Le
  compte de l'événement doit égaler `order_cash_on_delivery_payments.stripe_account_id` du
  PaymentIntent, sinon `dead_letter` immédiat + log d'erreur `security: true` sans
  réconciliation ; PaymentIntent ou compte inconnu = échec rejouable (la ligne locale peut
  ne pas être encore validée). `charge.refunded`/`charge.dispute.created` : marqués traités
  avec un `warn` structuré, aucune action automatique (politique D7 non tranchée). Les
  événements v2 relisent le compte via `getAccountStatus` (`CardPaymentsUseCases.getStatus`)
  et mettent à jour `merchant_stripe_connect`. Le module `payments` ne dépend pas de
  `cash-on-delivery` : `app.ts` injecte `ConnectWebhookDomainPorts`
  (`findPaymentAccountId`, `reconcilePaymentIntent`, `refreshMerchantAccountStatus`) ; tant que
  la réconciliation COD n'est pas branchée, `reconcilerNotWired` échoue systématiquement
  (événements rejouables puis `dead_letter`, jamais marqués traités à tort).
- Schéma de règlement livreurs (`0030`–`0033`) : `settlement_settings` (singleton, `go_live_at`
  immuable), `settlement_periods` (demi-ouvertes, non chevauchantes), `settlement_lines`
  (append-only, copie fidèle de `orders`, frais `floor(gain × bps / 10000)` PAR ligne),
  `settlement_statements` (ancre de la future auto-facture), `merchant_settlements`,
  `debit_attempts`, `driver_pay_runs`, `driver_transfers` (uniquement `source_transaction`,
  uniquement depuis un débit `succeeded` du même règlement, jamais avant `payrun_at`),
  `driver_transfer_reversals` (catégories `driver_fault`/`locadely_error` seulement),
  créances, `driver_connect_accounts` (`individual`/`company`), `driver_payout_observations`,
  réconciliation. Les totaux (lignes ↔ statement ↔ règlement) et `paid_cents` sont
  vérifiés par des contraintes différées au COMMIT : un Transfer réussi et la mise à jour de
  son statement se font dans la MÊME transaction. Aucune donnée d'identité/KYC/IBAN. Tests :
  `test/settlements/settlement-schema.integration.test.ts`, qui TRONQUE ces tables et refuse de
  tourner hors base nommée `*settlement*`/`*test*` : utiliser `source docs/work/r10-testdb.sh
  reset` (jamais dans un pipe : `DATABASE_URL` serait perdu), jamais la base de dev.
- Clôture hebdomadaire (R40, `modules/settlements`) : `CloseSettlementPeriodUseCase` (orchestration) lit
  `listSettleableOrders`/`countPreGoLiveFinalizedOrders` via le port `SettleableOrdersReader` (injecté par `app.ts`
  depuis `orders`), calcule le grand livre pur (`buildPeriodLedger`, `latestClosableMonday`,
  `computeSettlementSchedule`) puis `PostgresSettlementCloseRepository.closePeriod` : UNE transaction (verrou
  advisory global `settlement-period-close`, contrôle « déjà close », période `closed` + snapshot `go_live_at` +
  règlements + statements + lignes ; totaux revérifiés par les contraintes différées au COMMIT ; `finalized_at` et
  `order_created_at` lus en SQL, jamais via `Date` JS : microsecondes). Un perdant de course renvoie
  `already_closed`. Refus (`GoLiveNotSetError`) tant que `go_live_at` est absent ; les périodes vides sont closes aussi.
  Worker `startSettlementCloseWorker` (toutes les 60 s, sans chevauchement, activé par
  `SETTLEMENT_CLOSE_WORKER_ENABLED=true`, désactivé par défaut). Tests : `close-settlement-period.test.ts` (fakes) et
  `settlement-close.integration.test.ts` (base isolée requise ; `go_live_at` de TEST posé en désactivant le trigger
  `settlement_settings_guard`, jamais sur la base de dev ; verrou `test/support/settlement-singleton-lock.ts`
  partagé avec le test de schéma).
- Pré-notification SEPA du lundi (R41, `modules/settlements`, migration `0035`) : `SendPreNotificationsUseCase` (worker 60 s,
  `SETTLEMENT_PRE_NOTIFICATION_WORKER_ENABLED`, faux par défaut) : (1) `enqueueMissing` crée, idempotent (`unique(merchant_settlement_id)`), une
  notification `pending` par règlement clôturé de montant > 0 ; (2) `claimDue` réserve par bail (`for update skip locked`, jeton, reprise après expiration,
  30 tentatives max) ; (3) HORS transaction : lecture destinataire via le port `PreNotificationRecipientReader` (`app.ts` : e-mail Supabase Auth
  `AuthUserLookup.getUserEmail`, mandat actif `payments.findActiveSepaMandate`, nom légal `merchants`), envoi `ResendEmailSender`
  (`fetch`, en-tête `Idempotency-Key: settlement-pre-notification-<id>` stable, clé API jamais journalisée) ; (4) `markSent` (un seul `UPDATE`
  conditionné par le jeton, `sent_at` = horloge injectée, la même que celle de la date annoncée) ou `markFailed` (classe d'erreur, backoff 1 min → 1 h).
  Date annoncée = mercredi prévu, repoussée au premier jour ouvré FR ∪ TARGET laissant 2 jours calendaires après l'envoi (`announcedDebitDate`).
  Sans e-mail, mandat actif complet ou identifiant créancier : rien n'est envoyé, l'état reste `failed`/retentable. Base : `sent` immuable,
  `pre_notified_at` posable uniquement par le trigger de miroir, `guard_debit_pre_notification` (débit refusé sans notification `sent`, < 2 jours
  calendaires Europe/Paris, ou avant `debit_date`). Tests : `pre-notification.test.ts` (domaine), `resend-email-sender.test.ts`, bloc R41 de
  `settlement-close.integration.test.ts` (base isolée) et bloc « pre-notification gate » du test de schéma.
- Prélèvement SEPA (R50, `modules/settlements`, migration `0036`) : `RunSepaDebitsUseCase` (worker 60 s, `SETTLEMENT_DEBIT_WORKER_ENABLED`, faux par
  défaut ; exige `STRIPE_PAYMENTS_ENABLED=true`). (1) `listDueSettlements` : règlements `notified`, > 0 €, sans aucune tentative, dont la `debit_date` de la
  notification `sent` est atteinte à 08:00 Europe/Paris (`DEBIT_START_LOCAL_HOUR`, avant le cut-off SEPA 10:30) ; (2) le port `DebitSourceReader` (`app.ts` →
  `payments.findActiveSepaDebitSource`) donne le compte Stripe du restaurant et le moyen SEPA ACTIF ; `checkNotifiedMandate` exige que sa référence de mandat
  soit celle de la pré-notification, sinon `debit_blocked_reason` (`mandate_changed`/`no_active_sepa_method`) et rien n'est créé ; (3) `createAttempt` = UNE transaction
  (verrou du règlement, `debit_attempts` avec montant lu du règlement figé, instantané PM/mandat, bail, règlement `debit_scheduled`, statements `waiting_sepa`) ; les
  gardes de base (notification `sent`, ≥ 2 jours Europe/Paris, pas avant `debit_date`, mandat identique) → `debit_guard_refused` ; (4) HORS transaction :
  `StripeSepaDebitProvider.createDebit` (`paymentIntents.create`, `customer_account`, `confirm`, `off_session`, `mandate`, `transfer_group=settlement:<id>`,
  métadonnées `merchant_settlement_id`/`debit_attempt_id`/`merchant_id`, clé d'idempotence rejouée) ; (5) `applyObservation` : `classifyDebitObservation` (`succeeded` ⇔ PI
  + charge `succeeded`, `paid`, `balance_transaction`) → `debit_attempts` `processing|succeeded|failed` + règlement + statements (`succeeded_held`/`unpaid_restaurant`) dans la même
  transaction ; relecture toutes les 15 min tant que `processing` ; un état final n'est jamais relu. Reprise : bail expiré ou erreur transitoire → MÊME clé
  (< 23 h), au-delà recherche par métadonnée puis `failed:creation_not_confirmed` (jamais un second débit automatique). Erreurs : `StripeCardError`/`InvalidRequest` =
  refus définitif `request_rejected:<code>` ; réseau/5xx/auth/limite = transitoire ; une LECTURE en échec n'est jamais un échec de débit. Pas de relance automatique
  après un `failed` (D-K : relance manuelle, non construite). Tests : `sepa-debit.integration.test.ts` (base isolée, Stripe simulé), `domain/sepa-debit.test.ts`.
  DISTINCTION rejet réel / technique : `classifyDebitObservation` renvoie `failed` seulement si la charge a échoué (banque/Stripe) ; `StripeCardError` à la
  création = `failed` (`debit_declined:<code>`). Tout le reste est `technical_error` (migration `0036` : statut de tentative + `technical_error_at`, règlement
  `technical_hold`, statements INCHANGÉS) : `StripeInvalidRequestError`, clé d'idempotence détournée, PaymentIntent `canceled`/statut inattendu/sans erreur de paiement,
  objet Stripe incohérent (montant, devise, `debit_attempt_id`, livemode, l'id du PaymentIntent est conservé), création non confirmée après 24 h. Plus aucune relance
  automatique d'un `technical_error` ; réseau/5xx/authentification/limite restent transitoires (même clé rejouée).
- Paiement des livreurs (R60, `modules/settlements`, migration `0037`) : `RunDriverPayoutsUseCase` (worker 60 s, `SETTLEMENT_PAYOUT_WORKER_ENABLED`, faux par défaut).
  (1) `ensureRuns` : pay-run GROUPÉ (`scheduled_for = payrun_at`, un par livreur et période, même vide) puis pay-runs `drip` quand un statement devient payable
  (index unique : un seul pay-run ouvert par livreur et période) ; (2) `claimRuns` (bail) ; (3) par statement, isolément : débit retenu = celui qui a réussi sinon le plus
  récent ; compte livreur (local `driver_connect_accounts` ET relecture Stripe `ProviderDriverAccountLiveReader`, D-F) ; CONTRÔLE STRIPE de la charge avant CHAQUE Transfer
  (`retrieveDebit` + `classifyDebitObservation`, mêmes ids/montant/livemode que le débit) ; `decideStatementPayout` (`held_until_payrun`, `processing`, `unpaid_restaurant`,
  `blocked_driver_account`, `charge_exhausted`) ; (4) `beginTransfer` = ligne `driver_transfers` `creating` COMMITÉE avant l'appel Stripe (clé `stmt:<id>:charge:<charge>:try:<n>`,
  `destination_account_id`) ; `StripeDriverTransferProvider.createTransfer` (`source_transaction`, jamais d'avance) ; `completeTransfer` = Transfer `succeeded` + `paid_cents` +
  statut du statement dans UNE transaction. Erreurs : 4xx définitif (`InvalidRequest`, capacité manquante → `blocked_driver_account`, clé détournée) → `failed`, essai n+1
  (15 min → 6 h, 20 max) ; réseau/5xx/auth → `unknown`, MÊME clé rejouée ; reprise = recherche du Transfer par `transfer_group` + `metadata.driver_transfer_id` avant tout renvoi
  (crash après Stripe = adopté, jamais dupliqué) ; > 23 h introuvable → `creation_not_confirmed` puis essai n+1. `payout_hold_reason`/`payout_next_attempt_at` sur `settlement_statements`
  tracent les blocages. Annotation non bloquante `charges.update(destination_payment)` rejouée jusqu'à succès. Garde de base : `guard_driver_transfer` exige aussi une destination =
  compte Stripe ACTIF du livreur. Tests : `driver-payouts.integration.test.ts` (base isolée, Stripe simulé), `domain/driver-payout.test.ts`.
- Reversals de Transfers (R61, `modules/settlements`, migration `0038`) : catégories B `driver_fault` et C `locadely_error` UNIQUEMENT (`validateReversalRequest` : motif ÉNUMÉRÉ
  cohérent avec la catégorie, `order_stolen`/`order_lost`/`order_damaged` exigent la commande du statement, référence de décision et raison non vides, montant entier > 0 ; tout motif ou
  catégorie évoquant un restaurant/impayé/litige/SEPA = `RestaurantDefaultReversalForbiddenError`). Cycle : `RequestDriverReversalUseCase` (idempotent par (Transfer, `decision_reference`),
  `pending_approval`) → `DecideDriverReversalUseCase` (approbateur ≠ demandeur, aussi garanti par la base) → `ExecuteDriverReversalsUseCase` (worker `SETTLEMENT_REVERSAL_WORKER_ENABLED`) :
  (1) relit Transfer + solde du livreur chez Stripe (`StripeDriverReversalProvider`) et vérifie Transfer = ledger ; (2) `decideReversalExecution` (domaine pur) : refus si Stripe et ledger divergent sur le
  déjà-reversé, `bucket` = `pending` tant que `debit_attempts.available_on` n'est pas passé sinon `available`, `reverseNow = min(demandé, solde recouvrable du bucket)`, reste = créance
  (`allowNegativeBalance` JAMAIS activé : la compensation Stripe sur gains futurs attend la validation juridique) ; (3) le PLAN est persisté (colonnes `planned_*`, soldes lus, `stripe_amount_reversed_before`)
  et figé par trigger AVANT l'appel ; (4) `createReversal` avec la clé `reversal:<id>` et le montant du plan (rien si 0) ; (5) `complete` = reversal `succeeded` + créance `driver_receivables` dans UNE transaction
  (contrainte différée : créance = reliquat décidé). Reprise : le plan figé est réutilisé (jamais recalculé), `findReversal` (`metadata.driver_transfer_reversal_id`) avant tout renvoi. Une seule reversal `executing`
  par livreur (index unique : pas de double comptage du même solde). La reversal ne modifie ni le Transfer ni le statement (R60 ne re-paie rien). Tests : `driver-reversals.integration.test.ts` (base isolée, Stripe
  simulé, monde partagé `test/support/settlement-payout-world.ts`), `domain/reversal-decision.test.ts`.
- Incidents / webhooks / réconciliation / opérations (R70, `modules/settlements`, migration `0039`) : domaine pur (Codex, relu) : `triageSettlementEvent`/`reduceStripeEvent`
  (événements → action `refresh_debit` | `refresh_incident` | `audit_transfer` | `ignore`), `assessChargeIncidents` (litige/remboursement → incidents, `chargeUsable`, dette restaurant plafonnée),
  `compareDebitAttempt`/`compareTransfer`/`compareStripeTransferOrphan`/`compareDriverBalance` (constats `restaurant` vs `locadely_technical`), `decideDebitRetry`.
  Webhooks : `payments.createPaymentsModule(..., eventSink)` transmet l'événement plateforme VÉRIFIÉ à `ReceiveSettlementWebhookUseCase` (journal `settlement_stripe_events`, sans payload,
  unique par `event_id`) ; `ProcessSettlementWebhooksUseCase` (bail, backoff 30 s → 1 h, `dead_letter` après 15 essais) : `refresh_debit` → `requestSync` (réveille R50 qui relit Stripe) ;
  `refresh_incident` → `StripeChargeIncidentReader` (charge + `disputes.list`) puis `applyIncidents` (UNE transaction : `debit_incidents`, `merchant_receivables` `sepa_dispute`/`sepa_refund`, statements NON payés →
  `unpaid_restaurant`/`debit_incident`, remis en `succeeded_held` si le litige est gagné) ; `audit_transfer` → constats. La base refuse un Transfer depuis un débit avec incident ouvert/perdu
  (`guard_driver_transfer`) et R60 relit `disputed`/`amount_refunded` chez Stripe. Relance : `RequestDebitRetryUseCase` (opérateur + motif) ouvre la pré-notification de la tentative N+1
  (`settlement_pre_notifications.attempt_no`, unique par règlement et tentative) ; R41 l'envoie, R50 débite à la date annoncée (`listDueSettlements` gère `attempt_no > 1` sur règlement `failed`/`technical_hold`) ;
  `guard_debit_pre_notification` exige la pré-notification DE LA TENTATIVE. Réconciliation : `RunSettlementReconciliationUseCase` (≤ 500 débits/Transferts des 60 derniers jours, Transferts Stripe des 7 derniers
  jours sans ligne locale, soldes livreurs négatifs, payouts → `driver_payout_observations`) ; `settlement_reconciliation_findings` (un constat OUVERT par kind/objet, résolu quand il ne se reproduit plus sur un objet
  EXAMINÉ, `scope`). Workers `SETTLEMENT_WEBHOOK_WORKER_ENABLED` et `SETTLEMENT_RECONCILIATION_WORKER_ENABLED` (faux par défaut, un passage/jour dès 03:00 Paris). Tests :
  `settlement-ops.integration.test.ts` (base isolée), `test/http/settlement-admin.http.test.ts`, `domain/{stripe-event-triage,charge-incident,reconciliation,debit-retry}.test.ts`.
- Lecture du règlement (R80, `modules/settlements`, AUCUNE écriture ni règle financière modifiée) : contrat des réponses = `domain/settlement-views.ts` (types) et ports
  `ports/settlement-read.ts` (`SettlementReadRepository` en SQL : `PostgresSettlementReadRepository` ; `SettlementDirectory` : noms marchands/livreurs et identité légale, injecté par `app.ts` depuis les
  modules merchants/drivers). Domaine pur `domain/settlement-display.ts` (états d'affichage livreur `driverStatementDisplayState`, restaurant `merchantDisplayState`, totaux ; un règlement
  `technical_hold` n'est JAMAIS présenté comme une faute du restaurant). Cas d'usage `application/settlement-read.ts` (`GetDriverSettlementsUseCase`, `GetMerchantSettlementsUseCase`,
  `GetMerchantSettlementDetailUseCase`, `GetAdminOverviewUseCase`) et `application/current-week-estimate.ts` (estimation nette de la semaine ouverte via `listSettleableOrders`, frais 20 % par ligne ;
  lit tous les livreurs puis filtre : à optimiser avant tout volume). Routes `transport/http/settlement-read-routes.ts` : `GET /api/v1/drivers/me/settlements` (rôle `driver`),
  `GET /api/v1/merchants/me/settlements[/:id]` (rôle `merchant`, aucun gain livreur/frais/identifiant Stripe/code d'erreur brut), `GET /api/v1/admin/settlements/overview`,
  `POST /api/v1/admin/reversals`, `POST /api/v1/admin/reversals/:id/approve|reject` (rôle `admin` ; demandeur ≠ approbateur). L'identité légale du restaurant débiteur n'est renvoyée
  au livreur que si `SETTLEMENT_DRIVER_SEES_DEBTOR_IDENTITY=true` (défaut `false`, test seulement). Tests : `settlement-read.integration.test.ts` (base isolée),
  `settlement-read.test.ts`, `domain/settlement-display.test.ts`, `test/http/settlement-read.http.test.ts`. Compte admin : `app_metadata.role = 'admin'` dans Supabase (deux comptes de TEST sur la base dev).
- Gardes du règlement (R20) : `CreateOrderUseCase` exige `isMerchantInformationComplete` puis le port
  `MerchantSettlementReadinessReader` (adaptateur `createMerchantSettlementReadiness` : SEPA `active` via
  `payments.hasActiveSepaMethod` ET informations légales complètes ; seul `true` explicite passe, une erreur
  d'infrastructure remonte, rien n'est créé). `AssignOrderUseCase` et `ListAvailableOrdersUseCase` exigent le port
  `DriverEligibility` (`PostgresDriverPayoutReadinessReader` : compte `driver_connect_accounts` avec transferts `active`,
  sans `past_due`/`disabled`/`restricted_at` ; absent ou inconnu = non éligible). Les défauts permissifs des constructeurs
  sont réservés aux tests ; `app.ts` injecte toujours les vraies gardes. `buildApp({ merchantSettlementReadiness,
  driverEligibility })` permet aux tests HTTP de les remplacer. Les tests d'écriture sur les tables de règlement
  (`test/settlements/*.integration.test.ts`) sont IGNORÉS hors base nommée `*settlement*`/`*test*` et utilisent leurs propres
  restaurants/livreurs (`aaaaaaaa-…`, `bbbbbbbb-…`) pour ne pas perturber les fixtures partagées.
- Compte de paiement du livreur (R30, `modules/settlements`) : Account Stripe v2 `recipient`, `dashboard=express`,
  `fees_collector`/`losses_collector` = `application` (seules valeurs acceptées), Stripe collecte le KYC ; type d'entité
  `individual`/`company` choisi UNE fois (verrouillé : `409 EntityTypeLocked`). Création EXPLICITE par
  `POST /api/v1/drivers/me/payout-account` (clé d'idempotence `driver-connect-account-<driverId>`, jamais à l'inscription),
  puis `…/onboarding-link` (lien hébergé, configuration `recipient` seule), `…/account-session` (corps optionnel `{ purpose: 'onboarding' | 'wallet' }`, `onboarding` par défaut : secret embarqué pour l'onboarding ou composants Payments/Payouts pour le wallet,
  jamais stocké ni journalisé), `…/dashboard-link` (409 `OnboardingNotCompleted` avant la fin) et `GET` (état relu chez Stripe,
  dernier état connu marqué `stale` si Stripe est injoignable ; jamais l'`acct_` ni de donnée d'identité). Le cache local
  `driver_connect_accounts` est mis à jour par relecture Stripe, jamais depuis un webhook seul : `restricted_at` est posé quand un
  compte ACTIF se restreint (transferts `restricted`, exigences `past_due`/`disabled`) et effacé à la régularisation (D-F). Les
  webhooks Connect existants routent les événements v2 `recipient` (compte inconnu des restaurants → livreur, sinon échec rejouable)
  via `ConnectWebhookDomainPorts.refreshDriverAccountStatus`. `buildApp({ driverConnectProvider })` injecte un provider de test.
  Les URL de retour/rafraîchissement de l'onboarding hébergé sont `WEB_APP_URL/driver/payout-account/{return,refresh}` (pages à
  fournir avec l'écran mobile, R31).
- Tests financiers destructifs ou de bout en bout (règle D-R, 2026-09-22) : jamais de mécanisme qui efface ou réécrit des écritures financières immuables, jamais de protection PostgreSQL
  (trigger, contrainte, garde) affaiblie ou désactivée pour faciliter un test. Un gros scénario financier tourne sur une base JETABLE : créer la base, appliquer TOUTES les migrations
  dans l'ordre, tester, puis `drop database` (ex. `docs/work/r90-testdb.sh`). `go_live_at` s'y pose une seule fois avant la première commande ; la base de dev partagée garde `go_live_at = null`.
  Les petites suites unitaires/intégration gardent leurs bases isolées habituelles (`settlements_r10`, `payments_test`). Le schéma n'évolue que par NOUVELLES migrations (jamais de réécriture d'une migration déjà
  appliquée). Deux vérifications distinctes à conserver : Fresh install (base vide → toutes les migrations → dernière version) et Upgrade (ancienne version contenant des données financières → nouvelles migrations →
  historique intact, application fonctionnelle).
