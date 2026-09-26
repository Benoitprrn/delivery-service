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
tracking public et `POST /api/v1/auth/{merchant,driver}-signup` ; expose aussi le
port `AuthAdmin` (création/suppression d'utilisateur Supabase Auth via
l'API Admin `fetch`-based, `infrastructure/supabase-auth-admin.ts`) utilisé
  par `merchants` et `drivers` pour l'inscription. `SUPABASE_SECRET_KEY` (nouvelle Secret
API Key Supabase, remplace l'ancienne `service_role` legacy) est désormais
**obligatoire** (`platform/config.ts`) — l'API ne démarre pas sans, y
compris en local. Strictement backend : jamais `NEXT_PUBLIC_*`, jamais
loggée, jamais commitée.

L’inscription livreur (`POST /api/v1/auth/driver-signup`, migration `0054_driver_signup.sql`) exige `DRIVER_SIGNUP_ZONE_ID`, vérifié au démarrage contre `zones`. `account_phone_registry` (module `auth`) est l’unique invariant atomique d’unicité de téléphone entre comptes merchant/driver (contrainte `unique`, jamais un simple `SELECT` puis `INSERT`) ; les numéros sont conservés en E.164. Côté merchant, seul `merchant_account_contact.phone` (le titulaire du compte) y est inscrit — jamais `merchants.phone_primary`/`phone_secondary`, lignes opérationnelles du restaurant, légitimement partageables. **Dette assumée** : les `PATCH` existants (`/merchants/me/account-contact`, `/drivers/me`) ne mettent pas encore à jour ce registre lors d'un changement de téléphone après l'inscription — seul l'état à l'inscription (et le backfill de migration) est garanti ; à couvrir dans une tranche dédiée avant que l'invariant ne se dégrade en usage réel. `driver_terms_acceptances` est append-only (trigger, `UPDATE`/`DELETE` interdits) et ne vaut que preuve de la case d'inscription (jamais mandat SEPA/contrat) ; elle n'est écrite qu'APRÈS confirmation Auth (jamais dans la transaction locale de réservation, qui doit rester compensable — un premier essai l'écrivait trop tôt et rendait toute compensation impossible, corrigé).

Issue Auth ambiguë (`AuthProviderUnknownOutcomeError`, ex. timeout réseau) : `ProvisionDriverUseCase` tente d'abord une réconciliation par lookup (`getUserEmail`). Trois issues distinctes, jamais confondues : (1) compte confirmé créé → finalisé normalement, `201` ; (2) compte confirmé ABSENT (lookup réussi, réponse négative) → traité comme n'importe quel échec Auth, compensation immédiate (réservation locale supprimée), `502 DriverProvisioningError` — **retentable**, jamais un `202` (un vrai bug initial y envoyait aussi ce cas, corrigé — un `202` ne doit jamais représenter un résultat qu'on a déjà prouvé négatif) ; (3) issue réellement indécidable (le lookup lui-même échoue, aucune preuve possible dans un sens ou l'autre) → seul cas `202`, réservation conservée (jamais supprimée à l'aveugle), événement `driver.signup.reconcile.v1` enregistré dans `outbox_event`. **Aucun worker ne consomme cet événement aujourd'hui** (dead letter manuel, visible par log `error` uniquement) — accepté comme dette pour un cas désormais rare (double échec : création ET vérification), pas une infrastructure de réconciliation disproportionnée pour ce volume. `enable_signup` du projet Supabase **hébergé** (Auth réel, distinct du `config.toml` local qui ne gouverne que le Postgres local) reste activé — action manuelle requise dans le Dashboard avant que l'inscription livreur ne remplace effectivement tout accès direct.

**CGU append-only ≠ compte indélébile.** La contrainte porte sur la PREUVE (jamais falsifiable après coup), pas sur le compte utilisateur : `driver_terms_acceptances.driver_id` référence `drivers(id)` sans cascade, donc un livreur dont l'inscription a été finalisée (preuve écrite) ne peut plus être supprimé par un simple `DELETE FROM drivers` — attendu, pas un bug. Une future fermeture de compte / anonymisation RGPD ne doit JAMAIS tenter de supprimer physiquement cette ligne ; elle doit anonymiser en place (`drivers.first_name`/`last_name`/`phone` mis à `null`, déjà nullable) et libérer `account_phone_registry` (celui-ci n'est PAS append-only, `DELETE` normal) pour permettre la réutilisation du numéro — la preuve CGU reste alors seule et intacte, rattachée à un compte anonymisé plutôt que supprimé. Même patron déjà en place ailleurs dans ce module (`driver_einvoice_mandates` : `revoked_at`/`revocation_reason`, jamais de suppression). Aucun mécanisme de fermeture de compte n'existe encore — hors scope tant que non explicitement demandé.

Le formulaire mobile n'a qu'un seul champ mot de passe : `driverSignupBodySchema` n'exige donc pas de `passwordConfirmation` (contrairement à `merchant-signup`, dont le formulaire web affiche deux champs distincts — une confirmation qui compare la même valeur au champ unique mobile ne vérifierait rien).

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
  float, jamais d'arrondi au total. Modèle économique cible (livraison
  100% livreur + frais de service additifs 100% Locadely) : ADR 0005,
  chantier `docs/work/pricing-service-fee-plan.md` (SF1-SF13, clos le
  2026-09-23) : la clôture copie les montants figés
  `orders.delivery_cents`/`service_fee_cents`/`pricing_rule_version`, sans
  recalcul de taux. Un statement doit exactement la somme des livraisons du
  livreur ; un règlement restaurant porte `amount_cents = driver_amount_cents
  + service_fee_cents`.
  `pricing/domain/compute-price-cents.ts` prend désormais un `PricingSettings`
  en paramètre (`ruleVersion`, `pickupFeeCents`, `kmRateCents`, `minuteRateCents`,
  `minimumDeliveryCents`, `serviceFeeRateBps`) lu depuis `pricing_settings` via
  le port `PricingSettingsReader` (`pricing/ports/`, implémentation Postgres
  dans `pricing/infrastructure/`, `findActive()` = `rule_version` maximal,
  `findByRuleVersion(v)` = version figée exacte) ; `computeServiceFeeCents(
  deliveryCents, rateBps)` calcule le frais ADDITIF. `orders/infrastructure/
  postgres-order-repository.ts` : après l'insert (qui fige `price_cents` et
  `pricing_rule_version` via le trigger `0042`), résout le taux de service via
  `findByRuleVersion(row.pricing_rule_version)` — JAMAIS une règle "active"
  fraîchement relue, pour ne jamais dévier de la règle réellement figée sur la
  commande — puis fige en une seule `UPDATE` : `driver_earning_cents =
  delivery_cents = price_cents`, `service_fee_cents` (jamais soustrait du
  livreur). `GET /api/v1/orders/estimate` retourne `deliveryCents`/
  `serviceFeeCents` en plus de `priceCents` (conservé pour compatibilité,
  `priceCents === deliveryCents`), résolus avec le même override marchand
  (`merchants.service_fee_rate_bps_override` via `merchants/public.ts` — jamais
  un accès direct à la table depuis `orders`). `createOrdersModule` construit
  et injecte lui-même le `PricingSettingsReader` : aucune modification d'`app.ts`
  nécessaire pour ce câblage. Depuis SF10 (2026-09-23) : `orders/domain/order.ts` (`Order`) et
  `mapOrder` (`postgres-order-repository.ts`) exposent aussi `deliveryCents`/`serviceFeeCents`
  (déjà présents sur `OrderRow` depuis SF5, simplement pas mappés jusqu'ici) — consommés par le
  frontend web pour le détail d'une commande créée.
  `pricing_settings` (`0040_pricing_settings.sql`) : réglages tarifaires (collecte,
  €/km, €/min, minimum, taux de service par défaut) append-only et versionnés
  (`rule_version`) — changer un tarif = `INSERT` d'une nouvelle version, jamais
  `UPDATE`/`DELETE` (trigger `guard_pricing_settings`, bloque les deux). La règle
  active = `rule_version` maximal. `orders.price_cents` n'est plus une colonne
  générée depuis `0042_order_pricing_model.sql` : trigger `before insert`
  (`compute_order_price_cents`) la calcule et fige `orders.pricing_rule_version`
  en lisant `pricing_settings`, même formule/mêmes valeurs qu'avant (aucun
  changement de comportement applicatif). `orders.delivery_cents`/
  `orders.service_fee_cents` : alimentées à chaque création de commande depuis
  SF5 ; verrouillées après une transition unique NULL→valeur par
  `guard_order_pricing_immutable` (même régime que `driver_earning_cents`).
  Consommées par le règlement depuis SF6 (voir le bloc R40 plus bas).
  `merchants.service_fee_rate_bps_override`
  (`0041_merchant_service_fee_override.sql`) : colonne nullable 0-10000 bps,
  aucune résolution applicative ni interface admin construites à ce stade.
- Référence humaine de livraison (Étape 2 du chantier facturation,
  `docs/work/invoicing-preparation-plan.md` §4) : `orders.public_reference` (migration `0045`),
  texte 8 chiffres, aléatoire, généré par trigger `BEFORE INSERT` (jamais côté application,
  jamais acceptée en entrée API), unique (contrainte DB), immuable après création (trigger
  dédié, jamais réattribuée après annulation). Indépendante de `orders.id` (UUID technique) et
  de `orders.tracking_token` (reste l'unique secret du suivi public) — jamais un mécanisme
  d'accès. `PostgresOrderRepository.create()` relance l'insertion complète (jusqu'à 3 essais)
  sur une violation `23505` de `orders_public_reference_key` ; le trigger régénère un nouveau
  candidat à chaque tentative, aucune autre erreur n'est absorbée. Exposée sur `Order` (donc
  `MerchantOrder`/`DriverOrder`) et sur l'app mobile via un paramètre de route (`payment.tsx`/
  `proof.tsx` n'ont accès qu'à l'UUID de route, pas à l'objet commande complet).
- Identités légales et documents (Étape 3 du chantier facturation,
  `docs/work/invoicing-preparation-plan.md` §5, migration `0046`) : `driver_legal_information`
  (1:1, symétrique à `merchant_legal_information` mais sans vérification Sirene — routes
  `GET/PATCH /api/v1/drivers/me/legal-information`), `merchant_legal_information` étendue de
  `legal_form`/`vat_regime` (jamais déduit de `vat_number`, valeur explicite ou rien),
  `merchant_account_contact` (1:1, responsable du compte — `GET/PATCH
  /api/v1/merchants/me/account-contact`, e-mail toujours celui du compte Auth, jamais dupliqué
  en base). `drivers.first_name`/`last_name` sont la source de saisie ; `PATCH
  /api/v1/drivers/me` recalcule `drivers.name` dans la même requête à chaque sauvegarde — plus
  aucune divergence avec l'affichage opérationnel (dispatch, commandes) qui continue de lire
  `name`. SIRET/adresse postale sont dupliqués localement dans `modules/drivers` plutôt
  qu'importés de `modules/merchants` (règle absolue : aucun import cross-module hors
  `public.ts`).
  Justificatifs : module `modules/documents` (générique, ne dépend d'aucun autre module métier),
  table `account_documents` (propriétaire exclusif `driver_id` XOR `merchant_id`, `document_type`
  générique `identity_document`/`business_registration_document` — jamais littéralement
  « kbis » comme type technique). Stockage Supabase Storage, bucket **privé**
  `account-documents` (jamais `/storage/v1/object/public/...`), créé sur le **projet Supabase
  hébergé réel** référencé par `SUPABASE_URL` — ce dépôt ne fait tourner que PostgreSQL en local
  (port 54322) ; Auth et Storage passent toujours par le projet hébergé, le Storage local du
  stack CLI reste désactivé à dessein (`supabase/config.toml`). Chemin non devinable
  `{drivers|merchants}/{ownerId}/{documentType}/{documentId}.{ext}` ; validation de la
  **signature binaire réelle** (PDF/JPEG/PNG), pas seulement le `content-type` déclaré, en plus
  de la limite 10 MiB déjà posée par le bucket. Remplacement : upload du nouvel objet → une
  transaction DB (ancien marqué `replaced_at`, nouveau inséré) → suppression best-effort de
  l'ancien objet Storage APRÈS la transaction (jamais d'appel réseau dans une transaction
  PostgreSQL), un échec de suppression est journalisé (`warn` + `correlationId`) sans jamais
  faire échouer la requête. Une « suppression » sans remplacement pose seulement `replaced_at`
  (aucune ligne n'est jamais effacée, trace d'audit légère) ; un document courant = ligne avec
  `replaced_at is null`, garanti unique par propriétaire et type par un index partiel. Lecture :
  URL signée 5 minutes générée à la demande par `GET .../documents/:type/signed-url`, jamais
  persistée, jamais renvoyée par l'endpoint de liste (qui n'expose que type/nom/date). Limite
  globale `@fastify/multipart` à 10 MiB (`app.ts`, relevée depuis 2 MiB pour les logos).
  Aucun statut `verified`/`rejected`/workflow admin — volontairement hors scope de cette étape.
  Tests : `test/drivers/legal-information.test.ts`, `test/documents/account-documents.test.ts`,
  `test/http/documents.http.test.ts`, `test/merchants/account-contact.test.ts`.
- Moteur de facturation interne (Étape 4, `docs/work/invoicing-preparation-plan.md` §6-§8, ADR
  `0006-invoice-engine.md`, migration `0047_invoice_engine.sql`) : une commande `COMPLETED` (jamais
  `RETURNED` — décision du 2026-09-23 amendant §6.9, un retour devient une nouvelle commande
  distincte hors scope pour l'instant, jamais `CANCELLED`) déclenche, via l'outbox existant
  `order.completed.v1`, exactly deux factures en UNE transaction locale : livreur→restaurant
  (`issuer_kind='driver'`, `invoice_type_code='389'`, montant `delivery_cents`) et
  Locadely→restaurant (`issuer_kind='locadely'`, `invoice_type_code='380'`, montant
  `service_fee_cents`). Anti-doublon `unique(order_id, issuer_kind)` : un replay/`23505` est un
  no-op réussi, jamais une erreur. Numérotation légale : `assign_document_number(doc_kind,
  issuer_kind, issuer_driver_id, seller_siren)` (fonction SQL, allocation atomique verrouillée
  dans la transaction d'émission), deux séries par émetteur réel (`DRV-<SIREN>-######` par
  livreur, `LOC-######` pour Locadely), continues sans réinitialisation annuelle. Snapshot légal
  figé à l'émission depuis `driver_legal_information`/`merchant_legal_information` (Étape 3) et
  `platform_legal_identity` (identité légale propre de Locadely, singleton `id=true`, toutes
  colonnes nullable — **à renseigner manuellement avant toute émission réelle**, une émission avec
  identité Locadely incomplète doit être refusée, jamais bidonnée). `invoices`/`invoice_lines`
  et `credit_notes`/`credit_note_lines` sont append-only (trigger, `DELETE` toujours interdit) ;
  seules colonnes mutables après émission d'une facture : `transmission_status` (dimension
  transmission générique, aucun détail fournisseur ici) et `settlement_line_id` (`NULL` → valeur,
  une seule fois, rattachement tardif optionnel, jamais requis à l'émission — facture ≠ paiement,
  aucun statut de paiement stocké sur `invoices`). `line_vat_cents` vérifié par `CHECK` SQL
  (`floor(line_ht_cents × vat_rate_bps / 10000)`). Avoir (`credit_notes`) : décision humaine
  documentée (`decision_reference`/`decision_reason` obligatoires), jamais généré automatiquement
  par un reversal/refund Stripe ; le cumul des avoirs d'une ligne d'origine ne peut jamais dépasser
  son `line_ht_cents` (trigger `guard_credit_note_line_within_original`, vérifié immédiatement).
  Rattachement futur à un fournisseur de transmission (Super PDP) : table séparée
  `invoice_provider_submissions`, vide et inutilisée tant qu'aucun appel réseau n'existe — jamais
  de colonnes `superpdp_*` sur `invoices`/`credit_notes`. Garde « driver invoice readiness »
  (distincte de D-F/`DriverEligibility`, jamais fondée sur Super PDP) : nécessaire avant toute
  proposition/acceptation de course, champs requis = `drivers.first_name`/`last_name`,
  `driver_legal_information` complet, `vat_regime` renseigné, `vat_number` si `assujetti`. Base
  jetable de test : `docs/work/r47-testdb.sh` (`invoices_r47`, même discipline D-R que R90).
  Toutes les colonnes montant (`invoices`/`invoice_lines`/`credit_notes`/`credit_note_lines`) sont
  `integer`, jamais `bigint` : `node-postgres` renvoie un `bigint` Postgres comme chaîne de
  caractères en JS, ce qui aurait silencieusement cassé le typage `number` du repository (bug
  trouvé par le test d'intégration, corrigé avant toute donnée réelle).
  **Implémentation (module `modules/invoices/`, backend Codex, relu et corrigé par Claude)** :
  `IssueOrderInvoicesUseCase`/`PostgresInvoiceRepository.issueForCompletedOrder(orderId)` — une
  transaction locale, `SELECT ... FOR UPDATE` sur la commande, un conflit `23505` sur
  `unique(order_id, issuer_kind)` est un no-op réussi (replay sûr), une identité légale
  incomplète lève `InvoiceIssuanceDeferredError` (transaction annulée, retry indéfini via
  l'outbox générique — pas de plafond sur ce chemin). Câblé dans `app.ts` : le callback `emit` de
  `startOutboxRelay` route `order.completed.v1` vers `invoices.issueForCompletedOrder` avant
  d'appeler le `socketEmitter` générique (aucun handler socket n'existe aujourd'hui pour cet
  eventType, donc pas de couplage réel observé). `CreateCreditNoteUseCase` : cas d'usage interne
  uniquement, aucune route publique dans cette tranche, délègue le plafond cumulatif au trigger
  SQL. `GetOrderDocumentsUseCase` + `GET /api/v1/orders/:id/documents` (rôle `merchant` : ses
  deux factures/avoirs ; rôle `driver` : uniquement sa propre facture/ses avoirs, jamais celle de
  Locadely ni d'un autre livreur — isolation par requête SQL scoping, jamais côté application).
  Garde câblée EN PLUS de `DriverEligibility` (D-F) dans `ListAvailableOrdersUseCase` et
  `AssignOrderUseCase` (`DriverInvoiceInformationNotReadyError`, 403, même style que
  `DriverPayoutAccountNotReady`) ; `buildApp({ driverInvoiceReadiness })` permet aux tests HTTP
  de la remplacer (tout test qui passe déjà un `driverEligibility` permissif doit désormais aussi
  passer celui-ci, sinon il échoue contre la vraie base — régression trouvée et corrigée dans
  `test/http/orders.http.test.ts`). Trou de schéma trouvé par Codex, corrigé par Claude : rien
  n'empêchait `credit_note_lines.original_invoice_line_id` de référencer une ligne d'une AUTRE
  facture que `credit_notes.original_invoice_id` — vérifié désormais dans
  `guard_credit_note_line_within_original`. Tests : `test/invoices/issue-order-invoices.
  integration.test.ts` (base isolée `invoices_r47`, 8 scénarios : émission, idempotence replay,
  commande legacy, identité livreur/Locadely incomplète, isolation, avoir partiel + rejet du
  dépassement, garde de facturabilité), `test/invoices/create-credit-note.test.ts` (unitaire).
- Connecteur Super PDP (Étape 5, `docs/work/invoicing-preparation-plan.md` §9-§10, ADR
  `0007-superpdp-connector.md`, migration `0048_superpdp_integration.sql`) : **fondations codées et
  testées, PAS opérationnel** (câblage Postgres/HTTP/mobile manquant, aucun credential — §10.3-
  §10.5, ne pas présenter comme fonctionnel). Ports séparés `EInvoiceProvider`/
  `EInvoiceMandateProvider` (`modules/invoices/ports/`), jamais fusionnés. `SuperPdpOAuthClient`
  (`client_credentials`, cache mémoire, jamais loggé). `SuperPdpEInvoiceProvider` : soumission via
  conversion `to=cii` (XML) — **jamais `to=factur-x`/JSON directement à `POST /invoices`, qui
  n'accepte jamais de JSON** ; le Factur-X lisible se récupère séparément via
  `GET /invoices/{id}?format=factur-x` (jamais `/download`, déprécié), généré côté Super PDP sans
  gabarit PDF fourni par Locadely. `en16931-mapper.ts` inclut `legal_registration_identifier`
  (SIREN, ISO 6523 ICD `0002`) vendeur ET acheteur — sans lui le rapprochement automatique du
  mandat livreur par SIREN (§7.3) n'a rien à rapprocher. `DriverEInvoiceReadiness` : garde isolée
  dans le module invoices, **jamais câblée dans `orders`** — bloque uniquement la transmission
  d'une facture livreur (mandat non `verified`), jamais la course ni l'émission interne (ADR 0007
  §2, à ne jamais confondre avec `DriverInvoiceReadiness`). `invoices.seller_electronic_address_*`
  (nullable, snapshot immuable) : schéma configurable via `SUPERPDP_ELECTRONIC_ADDRESS_SCHEME`
  (défaut `0225`, hypothèse Peppol non confirmée par la spec JSON), jamais une constante en dur.
  `invoices.payment_means_type_code`/`payment_terms_text` : constantes SQL réelles (prélèvement
  SEPA, 100% des commandes), défaut jamais retiré pour ne pas casser l'émission existante.
  `invoice_provider_submissions.submission_status` inclut `unknown_outcome` : un timeout après
  envoi n'est **jamais retenté automatiquement**, faute de mécanisme documenté de recherche par
  `external_id`. Bucket Storage privé `einvoice-documents` créé et vérifié. Config
  `SUPERPDP_ENABLED`/`SUPERPDP_CLIENT_ID`/`SUPERPDP_CLIENT_SECRET`/`SUPERPDP_API_BASE_URL` (un
  seul host, sandbox/production se distinguent par les identifiants) dans `platform/config.ts`,
  forcés hors ligne dans `test/setup.ts`. **Premier test sandbox réel réussi (2026-09-23,
  compte Burger Queen)** : le socle technique complet fonctionne (auth, conversion `to=cii`,
  soumission XML, polling `invoice_events`, récupération Factur-X) — confirmé 2 bugs de mapping
  supplémentaires en conditions réelles, corrigés : `totals.total_vat_amount` (BT-110) est un
  objet `{value, currency_code}` (schéma `amount`), jamais une chaîne décimale comme les autres
  totaux ; la TVA par ligne utilise le schéma `line_vat_information`
  (`invoiced_item_vat_category_code`/`invoiced_item_vat_rate`/`exemption_reason`), jamais
  `vat_category_code`/`vat_category_rate` (ces noms n'existent qu'au niveau document, dans
  `vat_break_down`). **Mandat résolu (2026-09-23, plan §10.6) : `POST /v1.beta/company_mandates`
  exige que la partie `object` porte `Content-Type: application/json` EXPLICITE** (un `FormData.
  set('object', <string>)` envoie `text/plain` par défaut et Super PDP le rejette avec le même
  message générique et trompeur que pour un PDF invalide, quel que soit le contenu JSON) —
  corrigé en `Blob` typé dans `superpdp-einvoice-mandate-provider.ts`, comme `pdf` l'était déjà.
  Les noms de champs `object`/`pdf` sont corrects tels quels (l'hypothèse d'un nom différent,
  `metadata`, suggérée par une incohérence de la spec, est fausse — vérifiée et écartée). Un PDF
  invalide (pas d'en-tête `%PDF` réel) produit la MÊME erreur générique — les deux causes sont
  indépendantes et cumulatives. `en16931-mapper.ts` corrige aussi 3 rejets Schematron réels
  trouvés en sandbox : `invoiced_quantity_code` jamais omis (défaut `"C62"`), `seller.tax_
  registration_identifier` = SIREN sur toute ligne exonérée (BR-E-02, jamais un faux numéro de
  TVA), 3 mentions légales obligatoires dans `notes` (`PMT`/`PMD`/`AAB`, BR-FR-05), `process_
  control.business_process_type` jamais vide (défaut `"M1"`, BR-FR-08). Validé par
  `test/invoices/superpdp-sandbox.test.ts` (opt-in réseau réel, `SUPERPDP_SANDBOX_TESTS=1`,
  jamais dans la suite normale — `test/setup.ts` ne force `SUPERPDP_ENABLED=false` que si cette
  variable est absente).
- Socle de persistance Super PDP (Étape 5 Tranche 1, `docs/work/invoicing-preparation-plan.md`
  §11, migration `0049_einvoice_work_persistence.sql`) : chaque `INSERT invoices`/`INSERT
  credit_notes` (`postgres-invoice-repository.ts`) crée désormais, dans la MÊME transaction,
  une ligne `invoice_provider_submissions` `prepared` (`external_id` = l'UUID du document
  lui-même, déterministe, jamais régénéré) — jamais après coup, jamais dépendant d'un worker
  séparé. `invoices.seller_electronic_address_scheme`/`_value` sont désormais toujours
  renseignées à l'émission (`PostgresInvoiceRepository` prend `electronicAddressScheme: string`
  en second paramètre constructeur — une simple chaîne de configuration injectée par l'appelant,
  `createInvoicesModule(pool, config.SUPERPDP_ELECTRONIC_ADDRESS_SCHEME)` dans `app.ts` — le
  repository ne connaît jamais Super PDP lui-même). `PostgresEInvoiceWorkRepository`/
  `PostgresEInvoiceEventsRepository` (nouveau fichier `infrastructure/postgres-einvoice-work-
  repository.ts`) : `claimDue` réserve par bail `FOR UPDATE SKIP LOCKED` (même patron que
  `platform/outbox-relay.ts`), reconstruit un `SubmissionWork` complet (snapshot vendeur/
  acheteur/lignes) pour une facture OU un avoir (l'avoir joint sa facture d'origine pour
  l'identité, jamais dupliquée) ; `resolveBuyerElectronicAddress` reste volontairement non
  implémenté ici (retourne toujours `null`) — l'annuaire Super PDP est un appel réseau, jamais
  une responsabilité de ce repository DB, tranche 3 branchera un port séparé.
  `einvoice_events` (nouvelle table, migration 0049) conserve chaque événement individuel
  dédupliqué par `(provider, provider_event_id)` — condition nécessaire à la projection
  cumulative déjà écrite (`projectSubmissionStatus`, ADR 0007 §6), impossible avec le seul
  curseur global qui existait avant. `unknownOutcome` ne pose jamais de `next_attempt_at` :
  un résultat ambigu ne se retente jamais seul. Deux fichiers de test d'intégration sur
  `modules/invoices` tournant en parallèle (vitest, fichiers séparés) sur la même base isolée
  se disputaient les mêmes tables append-only (`TRUNCATE` concurrent) : `test/support/
  invoice-tables-lock.ts` (verrou consultatif, même mécanique que `settlement-singleton-lock.ts`)
  sérialise désormais tout fichier de test touchant `invoices`/`credit_notes`/
  `invoice_provider_submissions`/`einvoice_events`. `en16931-mapper.ts` → `euro()` : corrigé
  d'une division flottante (`cents/100`, violait la règle argent) vers une conversion
  entièrement en `BigInt`. `EInvoiceMandateProvider.createMandate` accepte désormais
  `grantorNumberScheme` optionnel (`'fr_siren'` par défaut, `'sandbox'` pour les tests) — le
  SIREN livreur réel n'est jamais concerné en production, seul un test sandbox a besoin de
  l'autre valeur. Tests : `test/invoices/einvoice-work-repository.integration.test.ts` (base
  isolée, bail/reprise après expiration/idempotence submission/idempotence événements/curseur
  jamais régressif), `test/invoices/superpdp-mapping.test.ts` (`euro()` ciblé). Câblage
  Postgres du WORKER lui-même (exécution réelle, `app.ts`, polling réel) : PAS FAIT, tranches
  suivantes (§11.G).
- Câblage réel des workers Super PDP (Étape 5 Tranche 2, `docs/work/invoicing-preparation-plan.md`
  §13, backend Codex, relu et corrigé par Claude, aucune migration) : `startEInvoiceSubmissionWorker`/
  `startEInvoicePollingWorker` (nouveau `infrastructure/einvoice-workers.ts`, même patron non chevauchant
  qu'`outbox-relay.ts`) construits dans `app.ts` uniquement si `SUPERPDP_ENABLED=true` ET les deux secrets
  présents ; sinon aucun provider ni worker n'existe (`einvoice-composition.test.ts` le vérifie).
  `SuperPdpEInvoiceProvider.submitInvoice` classe chaque échec (`ports/einvoice-provider.ts`) :
  `EInvoiceNetworkBeforeSendError` (DNS/connexion avant envoi, 429, tout 5xx, échec OAuth/conversion —
  retentable) ; `EInvoiceUnknownOutcomeError` (timeout `AbortController` 20 s ou coupure pendant/après le
  `POST /v1.beta/invoices` — issue non prouvée, **jamais retentée automatiquement**) ; toute autre erreur
  (4xx déterministe) = `failed` non retentable. `retryAt(attempts, now)` (exporté,
  `run-einvoice-submissions.ts`) : 1 min → 2 min → 4 min… doublement plafonné 6 h, sans plafond d'essais
  (pas de `dead_letter` dans cette tranche). `unknown_outcome` reste exclu de `claimDue` (Tranche 1) :
  aucune résolution automatique, faute de recherche documentée par `external_id` côté Super PDP —
  situation assumée. `PollEInvoiceEventsUseCase.execute` consomme toutes les pages `hasAfter` avec garde
  anti-boucle si le curseur n'avance pas. `projectSubmissionStatus` (écrite en Tranche 1) est désormais
  câblée en production : `PostgresEInvoiceEventsRepository.applyProjectedStatus` recalcule le statut
  depuis TOUS les événements persistés d'une soumission (insensible ordre/doublons) et ne répercute une
  projection terminale (`accepted`→`invoices/credit_notes.transmission_status='confirmed'`,
  `rejected`→`'rejected'`) QUE depuis `submission_status='submitted'` — **bug trouvé et corrigé en
  review** : la version initiale de Codex permettait à un événement tardif de faire basculer une
  soumission déjà terminale vers l'autre état terminal (contraire à l'immutabilité ADR 0007), corrigé par
  un `UPDATE ... WHERE submission_status = 'submitted'` (`rowCount=0` = no-op), verrouillé par un nouveau
  test. `PostgresDriverEInvoiceReadinessReader` (nouveau) injecté uniquement dans le worker de soumission
  pour bloquer la transmission d'une facture livreur sans mandat `verified` (jamais la course, jamais
  l'émission interne). `SUPERPDP_SUBMISSION_INTERVAL_SECONDS` (défaut 30 s) ajoutée à
  `platform/config.ts`, aux côtés de `SUPERPDP_POLL_INTERVAL_SECONDS` (défaut 300 s) déjà existante.
  Tests : `test/invoices/superpdp-einvoice-provider.test.ts` (classification d'erreurs par fake `fetch`),
  `test/invoices/einvoice-composition.test.ts` (`buildApp()` sans Super PDP), extension de
  `einvoice-work-repository.integration.test.ts` (non-régression terminal→terminal). Toujours **PAS
  opérationnel en production** : annuaire acheteur, mandat backend/mobile, Factur-X UI, avoir sandbox
  restent des tranches futures non commencées (§13 du plan).
- Annuaire électronique français + éligibilité de transmission (Étape 5 Tranche 3,
  `docs/work/invoicing-preparation-plan.md` §14, migration `0050_einvoice_buyer_directory.sql`,
  backend Codex, relu/complété/corrigé par Claude) : `GET /v1.beta/french_directory/entries?number=
  <SIREN>` — **toujours le SIREN, jamais le SIRET**, confirmé littéralement par la spec réelle du
  paramètre `number`. `domain/directory-selection.ts` → `selectBuyerDirectoryEntry` (pur) : une seule
  entrée `is_active` → sélection automatique (son `identifier` coupé sur le premier `:` en
  `{scheme, value}`) ; zéro ou plusieurs entrées actives → jamais un choix arbitraire
  (`not_addressable`/`ambiguous`, le schéma Super PDP réel n'a AUCUN champ de priorité entre entrées —
  une hypothèse antérieure de champ `is_replyto` en §9.O était fausse, corrigée). `domain/
  transmission-readiness.ts` → `canSubmitElectronicInvoice` (pur, 5 états explicites : `ready`,
  `missing_seller_electronic_address`, `waiting_for_mandate`, `waiting_for_recipient_address`,
  `invalid_recipient_configuration`) — jamais un booléen, toujours une raison. Cache DB
  `merchant_einvoice_directory_cache` (une ligne par commerçant, upsertable, **jamais append-only,
  jamais une donnée légale** — une simple donnée technique de transmission) via `ports/
  einvoice-directory-cache.ts`/`PostgresEInvoiceDirectoryCacheRepository`. `RefreshBuyerElectronic
  AddressUseCase` (`application/resolve-buyer-electronic-address.ts`) implémente
  `BuyerElectronicAddressResolver` : `resolve()` sert le cache si le SIREN correspond et a moins de
  24 h, sinon délègue à `refresh()` qui appelle TOUJOURS l'annuaire et persiste même un échec
  (`lookup_failed`) — jamais d'exception qui remonte. Deux points d'appel : (1) au worker de
  soumission Tranche 2 (`run-einvoice-submissions.ts`, une seule résolution par item, plus de forêt de
  `if` — un statut non `ready` devient `retryable` avec `not_ready:<statut>`, remplaçant l'ancien
  `continue` muet du mandat livreur ET l'ancienne branche ad hoc de l'adresse acheteur) ; (2) déclenché
  par `merchants` à chaque sauvegarde réussie de SIRET via le nouveau port `ElectronicAddress
  ResolutionTrigger` (`onLegalInformationUpdated`, fire-and-forget, `merchants` ne connaît jamais
  `invoices` directement — `app.ts` relie les deux par le même patron de liaison tardive déjà utilisé
  pour `syncDriverPresence`/`merchantSettlementReady`). `merchant_legal_information.buyer_reference`
  (BT-10, texte libre nullable) : concept EN16931 **séparé** de l'adresse électronique (BT-49), jamais
  fusionné ; exposé par `GET/PATCH /api/v1/merchants/me/legal-information` (`buyerReference`), jamais
  requis par `isMerchantLegalInformationComplete` ; PAS ENCORE câblé dans `en16931-mapper.ts` (collecté
  et persisté, mais pas encore transmis dans le document EN16931 lui-même — signalé, non bloquant).
  Nouveau champ de réponse `electronicInvoicingStatus` (`'available'|'unavailable'|'unknown'`, port
  `ElectronicInvoicingStatusReader`, dérivé du cache par `createInvoicesModule(...).
  getElectronicInvoicingStatus`) exposé à la racine de la réponse GET/PATCH legal-information, présent
  même quand `legalInformation` est `null`. `createInvoicesModule` construit désormais toujours son
  cache de lecture de statut (lecture DB seule, jamais bloqué par `SUPERPDP_ENABLED`) ; le provider
  réseau (`SuperPdpFrenchDirectoryProvider`) et le résolveur de rafraîchissement restent, eux,
  conditionnés à Super PDP activé avec ses deux secrets, exactement comme les workers de la Tranche 2.
  Facturation interne (Étape 4) jamais affectée : rien ici ne conditionne la création de commande ni
  `IssueOrderInvoicesUseCase`, uniquement la transmission Super PDP. Tests : `test/invoices/{directory-
  selection,transmission-readiness,resolve-buyer-electronic-address}.test.ts` (purs), extension
  `einvoice-workers.test.ts` et `merchants/legal-information.test.ts`, extension `einvoice-work-
  repository.integration.test.ts` (base isolée — avoir + `getElectronicInvoicingStatus` en aller-
  retour réel, ajoutés par Claude après que Codex, sans accès Postgres dans son sandbox, ait
  honnêtement signalé ne pas avoir pu les exécuter ni les finir).
- Mandat de facturation électronique du livreur — fondations (Étape 5 Tranche 4a,
  `docs/work/invoicing-preparation-plan.md` §15/§15.18, migration
  `0051_driver_einvoice_mandate_signing.sql`, backend Codex, relu/corrigé/complété par Claude) :
  **sous-tranche 4a DONE, 4b DONE (voir bloc suivant), 4c (mobile)/4d (sandbox réel) PAS
  COMMENCÉES.** Table `mandate_templates`
  (append-only, même patron que `pricing_settings` : `version` clé primaire, trigger interdisant
  `UPDATE`/`DELETE`), **vide dans tous les environnements** — le texte légal réel du mandat n'est pas
  encore décidé, le code doit échouer proprement (`MandateTemplateNotConfiguredError`, 503) plutôt que
  fabriquer un texte fictif. `driver_einvoice_mandates` porte désormais un snapshot légal complet
  (`grantor_name_snapshot`, `grantor_professional_name_snapshot`, `grantor_siret_snapshot`, adresse/
  TVA/forme juridique), en `NOT NULL` direct (pas un `CHECK` de complétude séparé — **piège de
  migration trouvé et évité** : Postgres réévalue un `CHECK`, même `NOT VALID`, sur la ligne ENTIÈRE à
  chaque `UPDATE`, ce qui aurait rendu impossible toute future mise à jour du statut fournisseur d'un
  mandat existant ; légitime ici uniquement parce que la table est vérifiée à zéro ligne dans tous les
  environnements réels). `acceptance_method` accepte désormais aussi `'mobile_drawn_signature'`
  (`'mobile_checkbox'` conservé). Contrainte `unique(driver_id, signed_pdf_sha256)` anti-doublon.
  `AcceptDriverEInvoiceMandateUseCase` (`application/accept-driver-einvoice-mandate.ts`) : idempotent
  par construction (`findCurrent` en tout premier — si un mandat non révoqué existe déjà, il est
  retourné TEL QUEL, aucun nouveau rendu/upload, couvre le cas « app fermée puis reprise » et un retry
  réseau) ; valide les octets magiques PNG de la signature (même technique que `modules/documents`,
  jamais réutilisée directement — bucket et types différents) ; snapshote `driver_legal_information`
  (via `drivers/public.ts` → `getLegalInformation`, déjà exposé, aucune extension de frontière
  nécessaire) et `platform_legal_identity` (même requête de complétude, y compris `vat_number` si
  `assujetti`, que `postgres-invoice-repository.ts` — dupliquée à l'identique, jamais réinventée) ;
  vérifie l'intégrité du gabarit (`hasValidMandateTemplateHash`, `domain/mandate-template.ts`) avant
  tout rendu ; génère l'id du mandat AVANT le rendu (pour qu'il apparaisse dans le PDF ET dans le
  chemin Storage) ; rend le PDF (`PdfLibMandatePdfRenderer`, `pdf-lib`, nouvelle dépendance backend —
  licence MIT, aucune dépendance native, vérifiée avant d'être acceptée), l'uploade dans
  `einvoice-documents` (chemin `drivers/{driverId}/einvoice-mandates/{mandateId}/mandate.pdf`, HORS
  transaction), puis insère la ligne immuable en UNE transaction. **Décision assumée** : la signature
  PNG brute n'est jamais stockée séparément — seul son SHA-256 est conservé dans `acceptance_evidence`
  (objet JSON structuré : méthode, horodatage, signataire, version/hash du gabarit, texte de
  consentement exact, hash signature/PDF), la signature reste uniquement visible, intégrée, dans le
  PDF final. Rendu PDF déterministe **vérifié empiriquement** (même entrée → même SHA-256 sur deux
  rendus consécutifs) : `setCreationDate`/`setModificationDate` explicitement fixés sur `acceptedAt`
  (jamais l'horloge système), retour à la ligne manuel avec pagination automatique si le texte du
  gabarit dépasse une page (jamais de troncature silencieuse). `GetDriverEInvoiceMandateStatusUseCase`
  expose aussi `legalDataDrift` (`domain/mandate-acceptance.ts`, pur) : `null` si aucun mandat n'existe
  encore (distinct de « pas de dérive »), sinon liste précise des champs légaux ayant changé depuis la
  signature — **jamais de révocation automatique**, un simple drapeau informatif (`revoked_at`/
  `revocation_reason` existent en base depuis 0048 mais ne sont écrits par aucun code, y compris ici,
  décision assumée). `DriverEInvoiceReadiness`/`PostgresDriverEInvoiceReadinessReader` (Tranche 2/3)
  **inchangés** : un mandat créé ici reste `provider_verification_status='not_submitted'`, aucun appel
  Super PDP dans cette sous-tranche. Routes : `GET/POST /api/v1/drivers/me/einvoice-mandate`,
  `GET /api/v1/drivers/me/einvoice-mandate/pdf-url` (rôle `driver`, jamais d'autre livreur ni
  paramètre client pour l'identité — toujours `request.authUser.id`). Tests : `test/invoices/{mandate-
  acceptance,mandate-template,pdf-lib-mandate-pdf-renderer,accept-driver-einvoice-mandate,get-driver-
  einvoice-mandate-status,supabase-einvoice-mandate-storage}.test.ts` (purs/fakes) et `driver-
  einvoice-mandate-repository.integration.test.ts` (base isolée). **Deux bugs trouvés et corrigés par
  Claude en review** (Codex n'a ni accès Postgres ni, cette fois, accès DNS npm dans son sandbox —
  n'a pu ni installer `pdf-lib` ni exécuter le moindre test dépendant de Postgres) : un paramètre par
  défaut de test mal typé excluait silencieusement `null` (échec `tsc`), et un UUID de fixture
  comportait un caractère en trop (`23505`/UUID invalide à l'exécution).
- Mandat de facturation électronique du livreur — soumission/polling Super PDP (Étape 5 Tranche 4b,
  `docs/work/invoicing-preparation-plan.md` §15.19, migration
  `0052_driver_einvoice_mandate_submission.sql`, backend Codex, relu/corrigé/testé par Claude) :
  **4b DONE.** `driver_einvoice_mandates` porte
  désormais un axe technique de soumission (`submission_status` `prepared|submitting|submitted|
  retryable|failed|unknown_outcome`, `attempts`/`last_attempt_at`/`next_attempt_at`/`locked_until`)
  **strictement distinct** de `provider_verification_status` (axe fournisseur, 0048, inchangé) et
  volontairement HORS du trigger d'immutabilité — mutable par le worker, contrairement au contenu
  accepté. `RunEInvoiceMandateSubmissionsUseCase`/`PollEInvoiceMandatesUseCase`
  (`infrastructure/postgres-einvoice-mandate-work-repository.ts`, bail `FOR UPDATE SKIP LOCKED`
  identique au patron `PostgresEInvoiceWorkRepository`) : `claimDue` exclut pour toujours
  `submitted`/`failed`/`unknown_outcome` (jamais de renvoi automatique après une issue ambiguë, même
  règle que la Tranche 2 factures) ; `retryAt` (Tranche 2) réutilisé tel quel, aucune deuxième
  fonction de backoff. `SuperPdpEInvoiceMandateProvider.createMandate` classe maintenant ses échecs
  avec les MÊMES classes que `submitInvoice` (`EInvoiceNetworkBeforeSendError`/
  `EInvoiceUnknownOutcomeError`, `ports/einvoice-provider.ts`) — réseau avant envoi/429/5xx
  retentable, abandon après envoi jamais retenté seul, 4xx déterministe `failed`. **Bug réel trouvé
  et corrigé par Claude en review** : Codex avait câblé le SIRET (14 chiffres) comme identifiant du
  grantor pour le schéma `fr_siren` — la spec Super PDP (`grantor_number_scheme`, valeur `fr_siren`)
  et §7.2 du plan sont explicites, un mandat `direction=out` identifie son grantor **uniquement par
  son SIREN** (9 chiffres), jamais un SIRET ; corrigé, le champ `grantorSiret` devenu inutile a été
  retiré plutôt que laissé mort. `EInvoiceMandateStorage.downloadMandatePdf` (nouvelle méthode) relit
  le PDF déjà stocké en 4a pour le soumettre — jamais régénéré par le worker. Un seul flag
  `SUPERPDP_MANDATE_WORKER_ENABLED` couvre les deux workers mandat (soumission+polling, choix
  différent des factures qui ont deux flags séparés) ; nouvelle config
  `SUPERPDP_MANDATE_GRANTOR_NUMBER_SCHEME` (`fr_siren` par défaut, jamais une valeur en dur dans le
  code applicatif) ; cadence partagée avec les workers factures
  (`SUPERPDP_SUBMISSION_INTERVAL_SECONDS`/`SUPERPDP_POLL_INTERVAL_SECONDS`, décision Claude non
  bloquante). `DriverEInvoiceReadiness` **inchangée** : dès qu'un mandat passe `verified`, la
  transmission des factures livreur reprend automatiquement au cycle suivant, aucun câblage
  supplémentaire nécessaire. Incident CLI trouvé (non causé par cette tranche, non corrigé ici) :
  `npx supabase migration up --local` rejoue 0047 sur cette base — l'historique
  `supabase_migrations.schema_migrations` s'arrête à 0046 alors que 0047-0052 sont déjà réellement
  appliquées au schéma réel ; les migrations de ce chantier depuis 0047 ont donc systématiquement été
  appliquées par `psql` direct, jamais par `migration up` sur cette base. Tests :
  `test/invoices/{einvoice-mandate-workers,superpdp-einvoice-mandate-provider}.test.ts` (purs, 13/13
  verts), suite complète `test/invoices` sur base jetable fraîche 0001→0052 (76 passés, 3 sandbox
  opt-in ignorés), non-régression `test/http`/`test/drivers` (143/143, identique à la Tranche 4a).
- Mandat de facturation électronique du livreur — texte V1 réel + parcours mobile complet (Étape 5
  Tranche 4c, `docs/work/invoicing-preparation-plan.md` §15.20, migration
  `0053_mandate_template_v1_and_grantor_name_snapshot.sql`, backend Codex relu/corrigé/testé par
  Claude, frontend mobile et SQL par Claude) : **4c DONE.** `mandate_templates` porte désormais le texte légal V1 réel
  (14 placeholders `{{...}}`, jamais reformulé), inséré une seule fois par la migration (hash
  calculé par Postgres lui-même via une CTE référençant le texte une seule fois — zéro risque de
  divergence texte/hash). **Le renderer PDF de 4a a été entièrement réécrit** (pas complété) : il
  construisait ses propres sections « Bénéficiaire »/« Mandant » autour du texte du gabarit, ce
  qui ne pouvait pas fonctionner avec un texte réel conçu comme un document complet portant ses
  propres placeholders (identité, référence, signature) — architecture incompatible découverte
  et corrigée AVANT le début du backend, pas après coup. `domain/mandate-template.ts` →
  `substituteMandateTemplate(text, fields)` (remplacement global pur, placeholder non fourni
  laissé tel quel) ; `PdfLibMandatePdfRenderer` coupe le texte sur le marqueur littéral
  `{{handwritten_signature}}`, substitue chaque moitié, dessine la signature entre les deux ;
  nouveau port `DriverProfileReader` (adapté depuis `drivers.findDriverById`, déjà exposé) pour le
  prénom/nom CIVIL du livreur (`grantor_first_name_snapshot`/`grantor_last_name_snapshot`,
  distinct du nom du SIGNATAIRE déjà figé depuis 0048), désormais requis avant toute signature
  (réutilise `DriverLegalInformationRequiredError`, jamais une nouvelle erreur pour cette nuance).
  `GetDriverEInvoiceMandateStatusUseCase` expose désormais `blockedReason` (4 causes explicites,
  jamais un booléen), `submissionStatus`/`lastError` (relus depuis 0052, jamais exposés avant
  cette tranche), et `previewText` — **jamais recalculé une fois le mandat signé** (`null` dès que
  `mandateExists`, quel que soit l'état de dérive légale : seul le PDF réellement signé fait foi
  ensuite, jamais une reconstruction depuis des données live potentiellement différentes) ; avant
  signature, les 5 champs propres à l'instant de signature (signataire, date, référence,
  signature) sont remplacés par des espaces réservés explicites en français, jamais vides
  silencieusement. **Bug réel trouvé et corrigé par Claude au typecheck** (Codex affirmait
  « typecheck passed », faux) : `blockedReason` assigné par une chaîne de ternaires sans
  annotation de type était élargi en `string` par TypeScript, cassant la compatibilité avec le
  type de la route HTTP — corrigé par une annotation explicite du type union exporté. **Second
  gap réel trouvé et corrigé par Claude** (préexistant depuis la Tranche 4a, révélé par la
  contention accrue d'un fichier de test supplémentaire) : `driver-einvoice-mandate-repository.
  integration.test.ts` n'avait pas `vi.setConfig({ hookTimeout: 60_000 })` comme tous les autres
  tests d'intégration `modules/invoices` sérialisés par le même verrou consultatif
  (`lockInvoiceTables`) — sans lui le `beforeAll` échouait au hasard selon la charge concurrente
  des autres fichiers ; corrigé, stable sur deux exécutions consécutives. Rendu PDF **vérifié
  visuellement** (pas seulement par hash) avec le vrai texte lu en base : les 9 articles,
  l'identité Mandant/Mandataire, la référence, la version et la signature s'affichent tous
  correctement, aucune troncature, aucun placeholder orphelin. Frontend mobile
  (`apps/mobile`, voir `apps/mobile/CLAUDE.md`) : écran « Mandat de facturation » complet
  (lecture, consentement, signature manuscrite, statuts sans jargon), point d'entrée dans Compte.
  Tests : suite `test/invoices` sur base jetable fraîche 0001→0053, 78 passés/3 ignorés (sandbox
  opt-in), aucun échec ; non-régression `test/http`/`test/drivers` 143/143. `typecheck`/`lint`
  verts sur `apps/api` ET `apps/mobile` ; `check:boundaries` : 2 violations préexistantes
  identiques, aucune nouvelle. Hors-scope confirmé non touché : tout mécanisme de révocation/
  re-signature après dérive d'identité (le bandeau reste purement informatif, comme conçu dès la
  Tranche 4a).
- Mandat de facturation électronique du livreur — validation sandbox réelle bout en bout (Étape 5
  Tranche 4d, `docs/work/invoicing-preparation-plan.md` §15.21, entièrement Claude — aucune
  délégation Codex sur ce test précis, son bac à sable n'a ni Postgres ni sortie réseau vers
  `api.superpdp.tech`) : **TRANCHE 4 (mandat livreur) INTÉGRALEMENT DONE.** Nouveau test opt-in
  `test/invoices/mandate-workflow-sandbox.test.ts` (`SUPERPDP_SANDBOX_TESTS=1`, base JETABLE
  obligatoire, jamais la base de dev — un mandat inséré ne peut plus jamais être supprimé) exerce
  le vrai code de bout en bout, sans mock ni fixture simplifié : `AcceptDriverEInvoiceMandateUseCase`
  (vrai template V1, vrai renderer, vraie signature de test, vrai Storage) →
  `RunEInvoiceMandateSubmissionsUseCase` (vrai worker, vrai `POST company_mandates` sandbox) →
  `PollEInvoiceMandatesUseCase` (vrai polling). Grantor de test = Tricatel (`000000001`, jamais un
  SIREN inventé ni un vrai SIREN livreur en scheme `sandbox` — un mandat `direction=out`
  n'identifie son grantor QUE par son SIREN, plan §7.2). **Bug réel trouvé et corrigé** (angle
  mort jamais révélé avant cette tranche, aucun test précédent n'ayant jamais exercé un vrai appel
  Storage) : `test/setup.ts` neutralisait inconditionnellement `SUPABASE_SECRET_KEY` AVANT que
  `dotenv` ne charge le vrai `.env` (qui ne réécrit jamais une variable déjà présente) — corrigé
  par le même mécanisme d'opt-in déjà utilisé pour `SUPERPDP_ENABLED`/`SUPERPDP_CLIENT_ID`/
  `SUPERPDP_CLIENT_SECRET` (la ligne ne s'exécute plus sous `SUPERPDP_SANDBOX_TESTS=1`), zéro
  impact sur la suite normale. Un seul mandat autorisé par grantor côté Super PDP sandbox
  (constaté empiriquement, `DELETE /v1.beta/company_mandates/{id}` confirmé fonctionnel) : le test
  nettoie tout mandat `sandbox`/`000000001` existant dans son `beforeAll`, rejouable indéfiniment
  sans accumuler de mandats sandbox inutiles. `LIST`/`DELETE` sont des appels `fetch` locaux au
  fichier de test (`GET /v1.beta/company_mandates` confirmé renvoyer `{ data: [...], has_more }`),
  jamais ajoutés au port `EInvoiceMandateProvider` de production — aucun cas d'usage réel n'en a
  besoin. Résultat observé en conditions réelles (id Super PDP `13525`) :
  `not_submitted`→`submitted`→`not_verified` (jamais `verified` — vérification humaine côté Super
  PDP sans SLA, **résultat valide et attendu**, jamais attendu artificiellement) ; `GET`/`LIST`/
  `DOWNLOAD` fonctionnent (PDF valide, taille cohérente, jamais une égalité byte à byte exigée) ;
  rejouer le worker après succès ne recrée jamais de second mandat (`claimDue` exclut
  `submission_status='submitted'`) ; rejouer le polling reste idempotent ; un `getMandate` en échec
  simulé ne casse jamais le worker. Tests : nouveau fichier 2/2 verts contre le vrai sandbox ;
  suite `test/invoices` sans le flag (base jetable fraîche 0001→0053) 78 passés/5 ignorés, aucun
  échec ; non-régression `test/http`/`test/drivers` 143/143 (confirme le correctif
  `SUPABASE_SECRET_KEY` sans effet hors opt-in) ; `typecheck`/`lint` verts ; `check:boundaries` : 2
  violations préexistantes identiques.
- Documents/Factur-X consultables commerçant + livreur (Étape 5 Tranche 5 révisée,
  `docs/work/invoicing-preparation-plan.md` §16, backend Codex relu/corrigé/testé par Claude,
  aucune migration — schéma déjà suffisant, confirmé avant de commencer) : **DONE, chantier
  F-PREP/Super PDP intégralement terminé.** `GET /api/v1/orders/:id/documents` enrichi
  (`InvoiceDocument`/`CreditNoteDocument`) de `submissionStatus` (axe travail worker),
  `lastError`, `facturXAvailable` (`true` ssi `transmissionStatus='confirmed'` — seul un document
  réellement accepté par Super PDP a un Factur-X récupérable) ; `originalInvoiceId` (UUID interne)
  **retiré**, remplacé par `originalInvoiceNumber`. Nouvelle route
  `GET /api/v1/orders/:id/documents/:documentId/factur-x?kind=invoice|credit_note` →
  `GetInvoiceDocumentFileUseCase` : revérifie l'autorisation indépendamment de `/documents`,
  refuse tout document non `confirmed` (`409`, aucun appel provider), sert la copie déjà en cache
  (`invoice_provider_submissions.document_storage_path`, colonne existante depuis 0049, jamais
  écrite avant cette tranche) sans jamais rappeler le provider, sinon appelle
  `EInvoiceProvider.getDocument` HORS transaction, uploade/hash/persiste la mise en cache
  définitive (bucket privé `einvoice-documents`, déjà générique Super PDP — nouvel adaptateur
  `SupabaseEInvoiceDocumentStorage` dédié, jamais réutilisation de la classe mandat dont la
  signature est spécifique), renvoie une URL signée courte durée. BT-10 (`buyer_reference`)
  câblé : confirmé par la spec Super PDP live que c'est un champ TOP-LEVEL de `en_invoice`,
  jamais imbriqué dans `buyer` — lu FRAIS à chaque soumission depuis
  `merchant_legal_information.buyer_reference` (jamais figé à l'émission, comme l'adresse
  électronique acheteur déjà résolue de la même façon). **Bug réel trouvé et corrigé par Claude**
  (course concurrente) : l'upload du document Factur-X manquait `x-upsert: true` — deux requêtes
  concurrentes voyant toutes deux `document_storage_path` nul auraient fait échouer la seconde
  avec « resource already exists » au lieu d'écraser un contenu identique ; corrigé. **Bug réel
  trouvé et corrigé par Claude au typecheck** (`tsc` réellement rouge malgré le rapport Codex,
  cinquième fois sur ce chantier) : `test/invoices/einvoice-workers.test.ts` (Tranche 2, non
  touché par cette tranche) construisait un `TransmissionInvoice` sans le nouveau champ requis
  `buyerReference` — corrigé. **Nouveau test d'intégration réel écrit par Claude** (aucun test
  Codex n'exerçait `PostgresInvoiceDocumentFileRepository` contre du vrai Postgres, son bac à
  sable n'a pas accès à la base) dans `issue-order-invoices.integration.test.ts` : confirme en
  conditions réelles qu'un livreur ne voit jamais la facture Locadely ni les documents d'un autre
  livreur, qu'un commerçant ne voit jamais ceux d'un autre commerçant, et que `cacheDocument`
  persiste réellement. Frontend : web (`components/order-modal.tsx`, `lib/invoices.ts`) et mobile
  (`app/order/[id]/index.tsx`, `lib/document-status.ts`, voir `apps/mobile/CLAUDE.md`) traduisent
  les deux axes de statut en un seul libellé sans jargon (« À transmettre »/« En cours d'envoi »/
  « Traitement en cours »/« Transmise »/« Rejetée »/« Action requise »/« Statut inconnu —
  vérification nécessaire »), bouton « Voir le document » quand `facturXAvailable`. Tests :
  backend ciblé 27/27 + nouveau test d'intégration réel ; suite `test/invoices` sur base jetable
  fraîche 85 passés/5 ignorés (sandbox opt-in), aucun échec ; non-régression `test/http`/
  `test/drivers` 143/143 ; `typecheck`/`lint` verts sur `apps/api`/`apps/web`/`apps/mobile` ;
  `check:boundaries` : 2 violations préexistantes identiques, aucune nouvelle.
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
  **Depuis SF6 (2026-09-22, `0043_settlement_ledger_additive_model.sql`)** : le grand livre ne calcule plus aucun
  taux — `buildPeriodLedger` copie `deliveryCents`/`serviceFeeCents`/`pricingRuleVersion` déjà figés sur chaque
  commande (`SettleableOrder`, exposés par `orders/infrastructure/postgres-order-repository.ts`'s `listSettleableOrders`,
  plus `driver_earning_cents`/`merchant_price_cents` n'existent plus dans ce flux). `settlement_lines` fige
  `delivery_cents`/`service_fee_cents`/`pricing_rule_version` (jamais `merchant_amount_cents`, colonne générée
  `delivery_cents + service_fee_cents`) ; `settlement_statements.due_cents` = somme des `delivery_cents` du livreur
  (plein montant, jamais soustrait) ; `merchant_settlements` fige `amount_cents = driver_amount_cents +
  service_fee_cents` (CHECK) et ces deux composantes sont revérifiées par les contraintes différées contre la
  somme réelle des lignes. `domain/fees.ts` (`computeLineFee`, modèle soustractif) est supprimé — plus rien ne
  recalcule un frais à la clôture. `ports/settlement-close.ts` (`SettlementSettings`/`ClosePeriodInput`) n'expose
  plus `feeRateBps`/`feeRuleVersion` (colonnes `settlement_settings.fee_rate_bps`/`fee_rule_version` volontairement
  laissées en base, inutilisées, pas supprimées). `current-week-estimate.ts` : `estimatedAmountCents` est la somme
  des `deliveryCents`, sans calcul net-après-frais.
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
- Prélèvement SEPA (R50, `modules/settlements`, migration `0036`) : **vérifié SF7 (2026-09-22) sous le modèle additif SF6, aucun code modifié** —
  `debit_attempts.amount_cents` reste copié de `merchant_settlements.amount_cents` (colonne inchangée, correcte depuis SF6 : `driver_amount_cents +
  service_fee_cents`), transmis tel quel au `PaymentIntent` Stripe ; l'e-mail de pré-notification (R41) affiche un montant neutre, jamais qualifié de
  "prix de livraison". `RunSepaDebitsUseCase` (worker 60 s, `SETTLEMENT_DEBIT_WORKER_ENABLED`, faux par
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
- Paiement des livreurs (R60, `modules/settlements`, migration `0037`) : **vérifié SF8 (2026-09-22) sous le modèle additif SF6, aucun code modifié** —
  `Transfer.amount` reste le plein `settlement_statements.due_cents` (colonne inchangée, correcte depuis SF6, jamais un net après soustraction d'un frais
  de service) ; la charge SEPA capturée vaut désormais le total additif (ex. 1200) mais seul `due_cents` (ex. 1000) est transférable — les 200 de
  service Locadely restent structurellement sur la plateforme, sans logique dédiée pour les y garder (`Σ Transfers ≤ due_cents`, trigger `0031` inchangé).
  Grep exhaustif `net_cents`/`fee_cents`/`gross_cents` sur tout R60/R61 : zéro résultat. `RunDriverPayoutsUseCase` (worker 60 s, `SETTLEMENT_PAYOUT_WORKER_ENABLED`, faux par défaut).
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
- Reversals de Transfers (R61, `modules/settlements`, migration `0038`) : **vérifié SF9 (2026-09-23) sous le modèle additif SF6, aucun code modifié** —
  raisonnent uniquement sur le solde du Transfer déjà envoyé chez Stripe (montant, jamais sa composition), aucun motif énuméré lié à `service_fee_cents`
  ou à une réclamation restaurant, aucune règle ajoutée. catégories B `driver_fault` et C `locadely_error` UNIQUEMENT (`validateReversalRequest` : motif ÉNUMÉRÉ
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
- Remboursement service Locadely (SF9.5, `modules/settlements`, migration `0044`, 2026-09-23) : mouvement STRICTEMENT SÉPARÉ du reversal ci-dessus —
  jamais fusionné, jamais dans `driver_transfer_reversals`. Table dédiée `driver_reversal_service_refunds`, une ligne par reversal `driver_fault`
  `succeeded` avec `order_id` (jamais `locadely_error`, jamais sans commande — gardé par `guard_driver_reversal_service_refund` + `isServiceRefundEligible`
  côté TS). Création AUTOMATIQUE (aucune approbation humaine) : `PostgresDriverReversalRepository.complete()` insère la ligne `pending` dans la MÊME
  transaction que la clôture du reversal, `previously_recovered_cents` recalculé en direct (sous-requête sur les reversals `driver_fault` `succeeded`
  antérieurs du même `order_id`), `refund_cents` = formule cumulative en `BigInt` (`domain/service-refund.ts`, `computeCumulativeServiceRefundCents`,
  vérifiée aussi par CHECK SQL) — évite toute dérive d'arrondi sur plusieurs reversals partiels du même ordre. Worker séparé
  `RunServiceRefundsUseCase`/`startServiceRefundWorker` (`SETTLEMENT_SERVICE_REFUND_WORKER_ENABLED`, faux par défaut) : DB-first, `stripe.refunds.create`
  sur la charge SEPA d'origine (`driver_transfers.stripe_charge_id`), reprise après crash par recherche `metadata.driver_reversal_service_refund_id`
  avant tout renvoi. **R70 adapté pour ne jamais classer ces remboursements comme incident/créance restaurant** : `assessChargeIncidents`/
  `compareDebitAttempt` reçoivent `knownServiceRefundCents` (somme des remboursements de service `succeeded` pour la charge) et ne qualifient d'incident
  que le montant remboursé non expliqué ; nouveau comparateur `compareServiceRefund` (toujours `locadely_technical`). Tests :
  `domain/service-refund.test.ts`, cas dédié dans `domain/charge-incident.test.ts`/`domain/reconciliation.test.ts`,
  `service-refund-repository.integration.test.ts` (SF13, base isolée — le vrai chemin retry de `PostgresServiceRefundRepository`).
  **Bug trouvé et corrigé par le replay Sandbox SF13 (2026-09-23)** : `retryLater()` n'était exercée par AUCUN test contre du vrai
  PostgreSQL avant SF13 (le seul test existant utilisait un repository entièrement fake) — un vrai `refunds.create` transitoire déclenchait
  une vraie erreur PostgreSQL (`$5 + make_interval(...)` sans `::timestamptz`, inférence de type cassée, contrairement à toutes les requêtes
  soeurs du module qui castent bien leur paramètre `now`), empêchant toute reprise. Corrigé (ajout du cast), verrouillé par le nouveau test.
- Incidents / webhooks / réconciliation / opérations (R70, `modules/settlements`, migration `0039`) : **vérifié SF9 (2026-09-23) sous le modèle additif
  SF6, aucun code modifié** — `merchant_receivables` reste une créance RESTAURANT sur le montant réel du litige/remboursement Stripe (jamais une part
  décomposée livraison/service, jamais une reversal livreur) ; « encaissement = transfert livreur + part Locadely » est garanti par construction (`CHECK
  amount_cents = driver_amount_cents + service_fee_cents`, migration `0043`) + la cohérence DB↔Stripe déjà vérifiée par R70. Domaine pur (Codex, relu) : `triageSettlementEvent`/`reduceStripeEvent`
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
  `GET /api/v1/merchants/me/settlements[/:id]` (rôle `merchant`, jamais l'identité ni le gain du livreur, aucun identifiant Stripe ni code d'erreur brut — **depuis SF10 (2026-09-23),
  expose en revanche SA PROPRE décomposition `deliveryCents`/`serviceFeeCents` en plus d'`amountCents`, au niveau période ET par ligne : ce n'est plus un secret à cacher sous le
  modèle additif ADR 0005, c'est sa propre facture**), `GET /api/v1/admin/settlements/overview`,
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
- Garde D-CP (Compte → Mon Entreprise, 2026-09-25, `modules/orders`) : `AssignOrderUseCase` et
  `ListAvailableOrdersUseCase` exigent aussi le port `DriverCompanyProfileReadiness`
  (`ports/driver-company-profile-readiness.ts`), **distinct** de D-F (`DriverEligibility`, compte
  de paiement Stripe) et de la garde de facturation ADR 0006 — les trois causes doivent rester
  identifiables séparément. `app.ts` l'injecte en lisant `drivers.getCompanyProfileStatus` (module
  `drivers`, voir plus bas). Refus : erreur DÉDIÉE `DriverCompanyProfileNotReadyError` (403,
  jamais `DriverPayoutAccountNotReadyError` — les deux causes ne doivent jamais partager un même
  code d'erreur, sinon le client ne peut pas distinguer laquelle des deux conditions manque).
  `buildApp({ driverCompanyProfileReadiness })` permet aux tests HTTP de la remplacer ; défaut
  permissif réservé aux tests unitaires du module `orders`. Tests :
  `test/orders/settlement-guards.test.ts` (bloc « D-CP », fakes, y compris l'ordre de priorité
  D-F avant D-CP quand les deux échouent) et `test/drivers/company-profile.integration.test.ts`
  (base réelle : brouillon partiel, calcul `complete`/`missing`, publication différée vers
  `drivers`/`driver_legal_information` uniquement une fois complet, non-effacement rétroactif de
  la publication si un document est ensuite supprimé).
- Garde D-MD (mandat de facturation électronique, 2026-09-25, `modules/orders`) : décision produit
  amendant ADR 0007 §2 — un livreur qui n'a pas SIGNÉ son mandat ne se voit proposer ni ne peut
  prendre aucune course (impossible d'émettre sa facture de livraison sans mandat). `AssignOrderUseCase`
  et `ListAvailableOrdersUseCase` exigent le port `DriverMandateReadiness`
  (`ports/driver-mandate-readiness.ts`), **distinct** de D-F/D-CP et de `DriverEInvoiceReadiness`
  (module `invoices`, transmission uniquement) : critère = mandat SIGNÉ (`driver_einvoice_mandates`,
  `revoked_at is null`), **jamais** la vérification Super PDP (`provider_verification_status`) —
  décision assumée, à revoir plus tard quand un contrôle fiable sera possible. `app.ts` l'injecte en
  lisant `invoices.hasSignedMandate` (nouvel export `modules/invoices/public.ts`, requête directe sur
  `driver_einvoice_mandates`, câblage tardif car `invoices` est construit après `orders`, même patron
  que D-CP). Refus : erreur DÉDIÉE `DriverMandateNotReadyError` (403). Ordre de priorité si plusieurs
  gardes échouent : D-F, puis D-CP, puis D-MD (`buildApp({ driverMandateReadiness })` pour les tests
  HTTP ; défaut permissif réservé aux tests unitaires du module `orders`). Tests :
  `test/orders/settlement-guards.test.ts` (bloc « D-MD », fakes).
- Compte → Mon Entreprise (livreur, 2026-09-25) : `DriverCompanyProfileUseCases`
  (`modules/drivers/application/company-profile.ts`) — brouillon distinct du profil légal
  publiable, table `driver_company_profile_drafts` (1:1 `drivers`, tous champs nullable, seedée
  paresseusement depuis `drivers`/`driver_legal_information` au premier accès pour les comptes
  déjà existants). `GET/PATCH /api/v1/drivers/me/company-profile` : le `PATCH` accepte n'importe
  quel sous-ensemble de champs `null` (aucune validation de complétude côté Zod, seulement des
  formats/tailles) et upsert toujours le brouillon. La complétude (`{complete, missing[]}`) est
  calculée à la lecture (nom/prénom/téléphone FR, forme juridique, raison sociale, SIRET Luhn-
  valide, adresse complète, régime de TVA + n° si `assujetti`, présence des 2
  `account_documents` non remplacés) — **jamais** stockée. Publication : `save()` n'écrit dans
  `drivers`/`driver_legal_information` qu'après avoir vérifié que le résultat est complet ; sinon
  seul le brouillon est mis à jour. `drivers.getCompanyProfileStatus` (exposé par `public.ts`)
  alimente à la fois le badge « à compléter » de l'app et la garde D-CP ci-dessus — une seule
  source de vérité. Remplace l'ancien flux à 3 endpoints (Étape 3) — voir « Nettoyage » plus bas.
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
- Annulation d'une course par le livreur (2026-09-26) : la transition `ASSIGNED → AVAILABLE`, documentée mais jusqu'ici jamais implémentée dans `docs/adr/0001-order-states.md`, est désormais exposée par
  `POST /api/v1/orders/:id/unassign` (`UnassignOrderUseCase`, rôle `driver`, corps `{expectedVersion}`, même forme que `.../collect`/`.../return`). `PostgresOrderRepository.unassign()` fait, en UNE transaction :
  `UPDATE orders SET status='AVAILABLE', driver_id=null, assigned_at=null, version=version+1` + append d'une entrée `{driverId, reason:'driver_cancelled', round:0, refusedAt}` dans `metadata.dispatch_attempts`
  (même mécanisme jsonb que `recordDispatchAttempt`, mais dans la MÊME transaction que le changement de statut plutôt qu'un second `UPDATE` versionné séparé) + `INSERT order_events` (from `ASSIGNED`) +
  `INSERT outbox_event` (`order.unassigned.v1`, `buildOrderUnassignedEvent`). Cette entrée `dispatch_attempts` est **obligatoire, jamais optionnelle** : sans elle, le dispatcher séquentiel (module `dispatch`,
  `StartDispatchUseCase`, qui exclut par `dispatchAttempts.map(driverId)`) pourrait réoffrir instantanément la même commande au livreur qui vient de l'annuler — c'est le mécanisme d'exclusion PERMANENTE pour
  cette commande, `DispatchAttempt.reason` étend donc `'refused' | 'timeout'` à `'refused' | 'timeout' | 'driver_cancelled'` (`domain/dispatch.ts`). `UnassignOrderUseCase` appelle ensuite
  `capacityWriter.decrement(driverId)`, hors transaction, même patron que `ConfirmReturnUseCase`/`CompleteOrderUseCase`. `realtime/socket-handler.ts` route `order.unassigned.v1` exactement comme
  `order.created.v1` (`dispatch.startDispatch(orderId)`, retour immédiat, aucune diffusion socket générique) — c'est le SEUL mécanisme qui fait réellement « repartir la commande dans le dispatch », le worker
  outbox l'appelle après la transaction, jamais dedans (aucun appel réseau dans le bloc `inTransaction`). Aucune restriction temporelle ni pénalité : possible tant que `status === 'ASSIGNED'`, plus du tout après
  `COLLECTED` (ADR 0001, aucune exception). Tests : `test/orders/order-lifecycle.test.ts` (cycle réel Postgres — transition, événements, exclusion en base ET via `orders.findDispatchMetadata()`, réassignabilité par un AUTRE appel `assignOrder`, gardes
  mauvais livreur/version/statut), `test/http/orders.http.test.ts` (route HTTP, 403 non-driver — les tests HTTP de ce fichier dépendent de l'auth Supabase HÉBERGÉE réelle via `test/support/get-driver-access-
  token.ts`, indisponible dans certains environnements d'exécution sans le compte de test provisionné côté hébergé ; préexistant, non spécifique à cette tranche). **Bug réel trouvé et corrigé en revue** : le
  filtre de type de `findDispatchMetadata()` (même fichier, méthode préexistante) n'acceptait que `reason === 'refused' | 'timeout'` — une entrée `driver_cancelled` pourtant bien écrite en base était donc
  silencieusement filtrée avant d'atteindre `StartDispatchUseCase`, rendant l'exclusion inopérante malgré une ligne présente en base (le test de non-régression `order-lifecycle.test.ts` vérifie désormais
  explicitement via `orders.findDispatchMetadata()`, pas seulement la colonne brute).
- Remasquage des données client après livraison (2026-09-26) : `driverOrderSelect` (source unique de `findDriverOrderById`/`findActiveByDriverId`/`findHistoryByDriverId`/`findAvailableInZone`,
  `postgres-order-repository.ts`) masquait déjà `customer_name`/`customer_phone` (`CASE WHEN o.status IN (...) THEN ... ELSE null END`) pour tout statut avant collecte, mais laissait `COMPLETED` dans la
  liste des statuts visibles — le nom et le téléphone du client restaient donc lisibles indéfiniment pour le livreur une fois la commande livrée, y compris dans l'historique. Ce `CASE` ne couvre plus que
  `('COLLECTED', 'RETURNING', 'RETURNED')` : `COMPLETED` en est sorti, aucune raison opérationnelle de garder ces champs visibles après la livraison. `RETURNED` reste volontairement inchangé (non demandé,
  décision produit distincte à trancher séparément si besoin). Source unique de vérité : ce `CASE` dans `driverOrderSelect`, jamais dupliqué ailleurs — les quatre méthodes qui le composent en héritent
  automatiquement. Test : `test/orders/order-lifecycle.test.ts` (assertion ajoutée à la fin du scénario `AVAILABLE → ... → COMPLETED`, via `orders.findDriverOrderById()`).
- Cycle `check:boundaries` `modules/merchants` corrigé (2026-09-26) : `MerchantAccountContact` (`{firstName, lastName, phone}`) vivait dans `application/account-contact.ts`, importé en retour par
  `ports/merchant-repository.ts` (`MerchantAccountContactRepository`) — cycle type-only (`import type` des deux côtés, aucun impact runtime, TypeScript l'efface entièrement à la compilation) mais interdit
  par `.dependency-cruiser.cjs` (`options.tsPreCompilationDeps: true`, choix délibéré du projet qui fait aussi compter les dépendances de type dans la règle `no-circular`). Déplacé vers `domain/merchant.ts`,
  à côté de `Merchant` — même patron que ce type frère, déjà importé sans souci par `ports/`. `application/account-contact.ts` et `ports/merchant-repository.ts` importent désormais tous les deux depuis
  `domain/`, jamais l'un depuis l'autre. Aucun changement de logique, uniquement le type déplacé et les imports ajustés (`infrastructure/postgres-merchant-repository.ts`, `transport/http/routes.ts`,
  `test/merchants/account-contact.test.ts`).
