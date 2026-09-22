# delivery-service

Service de livraison last-mile B2B, modèle marketplace (le livreur choisit sa
course, aucun dispatch automatique). Lancement pilote : Bourg-en-Bresse.

Monorepo npm workspaces. Un seul Claude Code lancé à la racine — jamais dans
un sous-dossier. Précise toujours l'app cible dans tes instructions
("Dans apps/api, ..." / "Dans apps/mobile, ...").

## Stack globale

- Node 24 LTS · TypeScript strict partout
- **API** : Fastify · Supabase CLI (Postgres+PostGIS, port 54322/Studio 54323) ·
  Valkey 8.x (port 6379) · pg-boss (Phase 2+) · Socket.io (websocket only) ·
  OSRM (port 5000, bbox Bourg-en-Bresse uniquement)
- **Web** : Next.js 14+ App Router · Tailwind CSS · shadcn/ui
- **Mobile** : React Native + Expo · NativeWind · MapLibre React Native
- **IA/externe** : Mistral Small 4 (OCR, structured output) · OpenCage
  (géocodage) · Stripe (paiement, destination charges) · Twilio (SMS) ·
  Resend (email)
- **Design system** : Terrain (`design-system/terrain/`) — voir ce dossier
  avant de construire un écran web ou mobile.

## Règles absolues — jamais d'exception

- Jamais de float pour de l'argent. Toujours des centimes entiers (`integer`).
- Jamais de logique métier dans les routes HTTP. Les routes appellent des
  use cases, rien d'autre.
- Jamais d'import entre modules API sauf via leur `public.ts`.
- Jamais de transaction PostgreSQL traversant un appel réseau externe
  (Twilio, Stripe, Mistral, etc.).
- Jamais de GPS dans le bus d'événements métier — c'est un flux technique,
  pas un événement de domaine.
- Tous les timestamps en UTC (`timestamptz`). Conversion Europe/Paris
  côté client uniquement.
- API versionnée `/api/v1/`.
- **Valkey 8.x, jamais Redis 8+** — Redis est repassé sous licence AGPL,
  incompatible avec notre règle BSD/MIT/Apache uniquement.
- Chaque transition d'état commande = une seule transaction : `UPDATE` +
  `INSERT order_events` + `INSERT outbox_event` + `COMMIT`. Le worker
  outbox publie les effets externes après coup, jamais dans la transaction.
- State machine commande : implémentation custom TypeScript uniquement
  (pas de librairie type XState). Voir `docs/adr/0001-order-states.md`.

## Structure du monorepo

```
apps/
  api/      Backend Fastify — voir apps/api/CLAUDE.md
  web/      Next.js commerçant + admin — voir apps/web/CLAUDE.md
  mobile/   App livreur RN/Expo — voir apps/mobile/CLAUDE.md
packages/
  shared/   Types et schémas partagés entre api/web/mobile
supabase/
  migrations/   Schéma SQL — source de vérité
design-system/
  terrain/  Tokens, composants et guidelines du design system Terrain
docs/
  adr/      Décisions d'architecture courtes et datées
```

## Commandes racine

```bash
npm run dev:api      # apps/api en hot reload
npm run dev:web      # apps/web en hot reload
npm run dev:mobile   # apps/mobile via Expo (QR code)
npm test             # tests de tous les workspaces
npm run typecheck    # typecheck de tous les workspaces
npm run lint         # lint de tous les workspaces
```

## Où trouver quoi

- Règles backend détaillées (modules, outbox, pg-boss) → `apps/api/CLAUDE.md`
- Règles web détaillées (routes, layout) → `apps/web/CLAUDE.md`
- Règles mobile détaillées (écrans, dev build) → `apps/mobile/CLAUDE.md`
- États commande et transitions autorisées → `docs/adr/0001-order-states.md`
- Formule de tarification → `docs/adr/0002-pricing-formula.md`

## État du projet

Phase 1 en cours : flux vertical minimal (commerçant crée → livreur voit →
prend → collecte → livre), sans photos, sans paiement réel.

Auth commerçant (email + mot de passe, Supabase Auth) : inscription rapide
(`POST /api/v1/auth/merchant-signup` — nom du commerce, e-mail, mot de passe
uniquement) et connexion existent. Aucune vérification e-mail/SMS. Un
commerçant fraîchement inscrit est authentifié avec `onboarding_completed =
false`. Les informations opérationnelles (nom, adresse géocodée, zone et
téléphone principal) sont renseignées dans « Mon compte » et leur complétude
est exposée séparément par `merchantInformationCompleted`. Tant que le reste
de l'onboarding n'est pas construit, `onboarding_completed = false` ne bloque
pas les commandes : seules les données opérationnelles réellement nécessaires
sont exigées (voir `apps/api/CLAUDE.md`).

Les informations légales et de facturation sont une section distincte : SIRET,
identité légale, adresses postales structurées et TVA facultative. Sa
complétude dérivée (`merchantLegalInformationCompleted`) reste également
indépendante de l'onboarding global.

Le mandat SEPA du commerçant est un Account Stripe v2 « customer-configured »
(`acct_…`) de la plateforme, stable dans `merchant_payment_profiles`
(`stripe_account_id`). Chaque tentative est une ligne distincte de
`merchant_payment_methods`, afin qu'un moyen actif et un remplacement puissent
coexister ; un index partiel PostgreSQL garantit au plus un moyen `active`.
Lors d'un remplacement, l'activation du nouveau moyen précède le détachement
Stripe de l'ancien, qui passe `detach_pending` dans la même transaction ; un
worker durable le détache ensuite (bail, backoff, 20 tentatives) et un échec
laisse le nouveau actif sans jamais le bloquer.
`STRIPE_PAYMENTS_ENABLED` vaut `false` par défaut : les clés Stripe restent
alors optionnelles et l'API démarre sans Stripe. `false` désactive réellement
le provider et le worker, même si des clés sont présentes. `true` exige les
deux secrets backend au démarrage, dans tous les environnements.
L'Account emploie initialement le nom légal (`display_name`, `registered_name`),
l’e-mail issu du JWT du compte commerçant (`contact_email`) et l’adresse de
facturation (sinon légale, `identity.business_details.address`). L'API les
resynchronise avant un SetupIntent seulement tant que `merchant` n'est pas
appliqué. Un restaurant peut ensuite recevoir cette configuration pour les
paiements carte; en France, `account_token_required` bloque ces mises à jour
API. Stripe/onboarding devient alors source de vérité identité; le mandat SEPA
provient du `billing_details` du PaymentMethod.
La création concurrente de l'Account est sérialisée dans le use case et protégée
en plus par une clé d'idempotence Stripe fondée sur le merchant. Comme Stripe
rejette une clé réutilisée avec d'autres paramètres, la création ne porte que
l'identité stable (`configuration.customer` vide + `metadata.merchant_id`) ;
nom, e-mail et adresse passent par une mise à jour avant chaque SetupIntent tant
que `merchant` est absent.
Locadely étant une plateforme Connect, l'API Accounts v2 lui est disponible en
disponibilité générale : les appels `v2.core.accounts.*` n'envoient aucune
version explicite (le SDK utilise sa version GA). `STRIPE_ACCOUNTS_V2_API_VERSION`
n'est qu'un override facultatif (par exemple une version `.preview` pour une
plateforme sans Connect), transmis uniquement en `RequestOptions.apiVersion`.
Les tests payments utilisent le port Stripe avec un fake local ; aucune clé
Stripe ni requête réseau n'est nécessaire à leur exécution.
Les tests HTTP vérifient aussi les signatures webhook sur le corps brut avec
une signature locale, sans jamais désactiver cette vérification.
Le frontend n'obtient du backend que le `client_secret`; il extrait ensuite
l'identifiant du SetupIntent depuis la réponse Stripe à `confirmSetup`.
Les futurs prélèvements utiliseront le Stripe Creditor ID, identifiant
technique de Stripe — il ne faut jamais le présenter comme appartenant à
Locadely. Locadely reste l’entreprise facturante et son nom visible dépendra
de la configuration ultérieure du compte plateforme ; la pré-notification du
prélèvement hebdomadaire est envoyée par Locadely (R41, voir plus bas).
Le webhook Stripe est public uniquement sur son chemin exact, puis protégé par
la vérification obligatoire de signature sur le corps brut. Après validation,
il persiste seulement l'identifiant, le type et les identifiants métier minimaux
puis répond 2xx; un worker PostgreSQL durable le claim et le traite hors de la
requête. Son journal ne stocke jamais le payload : un événement passe de
`pending`/`processing` à `processed` seulement après la mutation métier, avec
un jeton de claim empêchant qu’un worker expiré ne valide le travail d’un autre;
un échec ou un arrêt le rend rejouable.
Une valeur Stripe vide dans `.env` est traitée comme absente, afin de ne jamais
empêcher le démarrage ou les tests hors ligne.
L'UI « Moyen de paiement » utilise exclusivement Stripe Elements/Payment
Element ; aucun champ IBAN Locadely n'est rendu ni conservé côté navigateur.
La section suit immédiatement « Informations légales et facturation » dans
« Mon Compte », avant les réglages d'e-mail et de mot de passe.

Le paiement carte à la livraison (COD) est en cours de construction : Stripe
Terminal avec lecteur physique (WisePad 3), Direct Charge sur l'Account v2 du
restaurant, sans commission Locadely. Décision et gates (dont l'essai obligatoire
avec un vrai lecteur avant production) : `docs/adr/0003-cod-direct-charge.md` ;
le suivi du chantier reste dans `docs/work/`, jamais ici.

Le règlement des livreurs (ADR `docs/adr/0004-driver-settlement.md`, plan
`docs/work/driver-settlement-plan.md`) a son schéma (migrations `0030`–`0034`, sans worker
ni endpoint encore) : périodes, lignes figées, statements livreur × restaurant,
règlements restaurant, débits SEPA, pay-runs, Transfers `source_transaction`, reversals B/C,
créances, comptes Connect livreur (`individual` ou `company`), payouts observés,
réconciliation ; `0034` fige `driver_earning_cents`/`distance_m`/`duration_s` des commandes
(migrations `0030`–`0034` appliquées à la base de dev le 2026-09-21).
La base porte les invariants (frais par ligne `floor`, `go_live_at`, aucun Transfer sans débit
`succeeded` ni avant `payrun_at`, Σ Transfers ≤ dû, `paid_cents` = Σ Transfers réussis). Le domaine
pur est dans `modules/settlements/domain` ; `orders` expose `listSettleableOrders` et
`countPreGoLiveFinalizedOrders`. La clôture hebdomadaire (R40) est un worker PostgreSQL (`SETTLEMENT_CLOSE_WORKER_ENABLED`,
`false` par défaut) : chaque lundi 00:05 Europe/Paris il clôture, de la plus ancienne à la plus récente, les périodes
exigibles depuis `go_live_at` (rattrapage ≤ 12 semaines), en UNE transaction par période ; il est inerte tant que
`go_live_at` n'est pas posé (valeur posée seulement juste avant la production, après suppression des courses de test).
La pré-notification SEPA (R41, migration `0035`, appliquée à la base de dev le 2026-09-21) est un e-mail Resend envoyé
après la clôture, une ligne durable `settlement_pre_notifications` par règlement restaurant (`SETTLEMENT_PRE_NOTIFICATION_WORKER_ENABLED`,
`false` par défaut ; exige `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SEPA_CREDITOR_ID`, `SETTLEMENT_SUPPORT_EMAIL`). Elle annonce le montant exact, la
date de prélèvement, les 4 derniers caractères de l'IBAN, la référence du mandat et l'identifiant créancier Stripe. `pre_notified_at` n'est
qu'un miroir posé par la base quand la notification passe `sent` ; le débit (R50) est refusé par un trigger sans notification `sent` d'au moins
2 jours calendaires (Europe/Paris) ni avant la date annoncée. Un échec est tracé (`failed`) et retenté avec backoff, jamais compté comme envoyé.
Le prélèvement SEPA du restaurant (R50, migration `0036`, appliquée à la base de dev le 2026-09-21) est un worker
(`SETTLEMENT_DEBIT_WORKER_ENABLED`, `false` par défaut, exige Stripe activé) : à la `debit_date` de la pré-notification, dès 08:00 Europe/Paris,
il crée UN PaymentIntent SEPA plateforme par règlement restaurant > 0 € (montant lu du règlement figé, clé d'idempotence
`debit:<règlement>:attempt:1`), à condition que le mandat actif soit celui de la pré-notification ; il suit ensuite `processing → succeeded | failed`
par relecture Stripe. Chaque restaurant est indépendant ; un échec reste rattaché au restaurant (statements `unpaid_restaurant`) et ne crée aucun
Transfer livreur (R60 ne lit que les `debit_attempts` `succeeded`). Un rejet RÉEL du prélèvement (banque/Stripe) = `failed` ; toute erreur
technique (mauvaise requête, configuration, incohérence, PaymentIntent annulé, création non confirmée) = `technical_error` + règlement `technical_hold`,
intervention requise, et le restaurant n'est JAMAIS marqué impayé.
Le paiement des livreurs (R60, migration `0037`, appliquée à la base de dev le 2026-09-21) est un worker (`SETTLEMENT_PAYOUT_WORKER_ENABLED`, `false` par
défaut, exige Stripe activé) : à `payrun_at` un pay-run GROUPÉ par livreur et période, puis des pay-runs « drip » pour les statements dont le SEPA
réussit plus tard. Un Transfer `source_transaction` par statement, uniquement si le débit est `succeeded` ET que le contrôle Stripe de la charge, refait
juste avant chaque Transfer, le confirme ; un impayé, un compte livreur restreint ou une erreur Stripe ne bloquent jamais les autres statements.
Les reversals de Transfers déjà envoyés (R61, migration `0038`, appliquée à la base de dev le 2026-09-21) ne concernent QUE la faute du livreur
(commande volée/perdue/endommagée, fraude, autre décision validée) ou une erreur Locadely (doublon, mauvais destinataire ou montant), avec un motif énuméré,
une référence de décision et une approbation par une AUTRE personne ; jamais parce qu'un restaurant échoue, conteste ou ne paie pas. Le domaine décide avant
tout appel Stripe (SP4 : Stripe accepte une reversal même si le livreur est déjà payé et laisse un solde négatif) : on reverse au plus le solde recouvrable du bon
compartiment (pending/available), le reste devient une créance `driver_receivable` ; la décision est persistée puis figée, Stripe n'est appelé qu'ensuite
(worker `SETTLEMENT_REVERSAL_WORKER_ENABLED`, `false` par défaut ; aucune interface admin avant R70, les cas d'usage sont exposés par `modules/settlements/public.ts`).
Incidents, webhooks, réconciliation et opérations (R70, migration `0039`, appliquée à la base de dev le 2026-09-21) : (1) le webhook plateforme
(`/api/v1/webhooks/stripe`, signature déjà vérifiée) journalise sans payload les événements PaymentIntent/charge/litige/Transfer pertinents
(`SETTLEMENT_WEBHOOK_WORKER_ENABLED`) ; ce ne sont que des DÉCLENCHEURS : le traitement réveille le suivi R50 ou RELIT la charge/le litige/le Transfer chez Stripe
(doublons et désordre sans effet, reprise après crash par bail, `dead_letter` visible) ; (2) un SEPA réussi PUIS contesté/remboursé crée un incident et une créance du RESTAURANT
(`merchant_receivables`), bloque tout nouveau Transfer depuis cette charge (base + relecture Stripe) et laisse les statements déjà payés intacts : jamais de reversal livreur
(D-A/D-O) ; (3) la relance d'un prélèvement restaurant échoué est MANUELLE (`POST /api/v1/admin/settlements/:id/debit-retry`, rôle `admin`) et exige une NOUVELLE pré-notification
par tentative (≥ 2 jours calendaires, mandat cité = mandat débité, garde en base) ; aucun nouveau débit automatique après un vrai échec ; si la relance réussit, R60 la paie en drip ;
(4) une réconciliation quotidienne DB ↔ Stripe (`SETTLEMENT_RECONCILIATION_WORKER_ENABLED`) enregistre des constats classés `restaurant` (incident du prélèvement) ou
`locadely_technical` (écart d'intégrité de notre côté), jamais mélangés, et observe les payouts des livreurs ; lecture seule.
Deux gardes
sont actives : un restaurant sans mandat SEPA actif, sans informations légales ou sans
informations opérationnelles complètes ne peut pas commander (D-D, 409
`MerchantPaymentSetupIncomplete`) ; un livreur sans compte de paiement Stripe prêt (ou restreint)
ne se voit proposer aucune course et ne peut en prendre aucune (D-F, 403
`DriverPayoutAccountNotReady`). Le compte de paiement Stripe du livreur (Account v2 `recipient` Express,
`individual` ou `company` choisi une fois) se crée EXPLICITEMENT via
`/api/v1/drivers/me/payout-account` (état, création, lien d'onboarding, session embarquée, lien Dashboard) ;
sans compte prêt, un livreur ne voit aucune course (en dev, le livreur de test doit d'abord configurer ses paiements).
L'app livreur expose « Mes paiements » (`apps/mobile/app/paiements/`, R31) : choix `individual`/`company` verrouillé, onboarding Stripe
intégré (composants React Native Stripe, development build requis) avec repli navigateur système, bandeau sur Carte et carte dans Wallet.
Lecture et interfaces du règlement (R80, sans changer les règles financières R40–R70) : l'API expose en lecture seule
`GET /api/v1/drivers/me/settlements` (« Mes paiements » : semaine en cours estimée, périodes clôturées, statements par restaurant avec un état
d'affichage sans jargon ; l'identité légale du restaurant débiteur n'est renvoyée que si `SETTLEMENT_DRIVER_SEES_DEBTOR_IDENTITY=true`, désactivé par défaut,
environnement de test seulement), `GET /api/v1/merchants/me/settlements[/:id]` (restaurant : montants restaurant uniquement, jamais de gain livreur ni de frais) et
`GET /api/v1/admin/settlements/overview` + `POST /api/v1/admin/reversals[/:id/approve|reject]` (rôle `admin`, double approbation). L'app livreur affiche « Mes paiements »
(`apps/mobile`, onglet Compte > Wallet, détail par période) ; le web restaurant a `/merchant/settlements` et le back-office minimal `/admin/settlements`
(relance de débit, reversals, incidents, créances, constats, statements bloqués, événements en échec) réservé au rôle `admin` (Supabase `app_metadata.role`).
