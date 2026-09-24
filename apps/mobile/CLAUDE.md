# apps/mobile

App livreur, iOS + Android.

## Stack

React Native + Expo · NativeWind (Tailwind RN) · MapLibre React Native ·
design system Terrain (mêmes tokens que le web, valeurs `px` NativeWind).

## Commandes

```bash
npx expo start -w apps/mobile          # QR code, Expo Go
npx expo start --web -w apps/mobile    # fallback navigateur sans téléphone
eas build --profile development        # requis dès l'ajout de MapLibre
```

⚠️ **Expo Go ne suffit plus dès que MapLibre React Native est installé** —
c'est une lib native, elle exige un *development build* Expo
(`eas build --profile development`), pas seulement le QR code.

## Structure

```
app/
  (tabs)/
    map/        carte MapLibre plein écran, marqueurs pickup, panel swipeable
    orders/     mes courses en cours
    wallet/     wallet visuel (affichage uniquement, pas de paiement réel)
```

3 onglets fixes : Carte / Mes courses / Wallet. Aucun écran mobile n'existe
avant Phase 3 — Phase 1 et 2 valident le flux via pages HTML (`apps/web/public/`).

## Règles spécifiques mobile

- Socket.io : `io(API_URL, { transports: ["websocket"] })` uniquement,
  jamais de long-polling.
- GPS : l'app envoie sa position à `POST /api/v1/drivers/location`
  (HTTPS+JWT), jamais directement à Traccar.
- Geste "glisser pour prendre" : relâché avant la fin = retour position
  initiale, aucune validation accidentelle.
- Compression photo obligatoire avant upload (`expo-image-manipulator`,
  <500 Ko, JPEG 80%, max 1920px) — Phase 3.
- Textes jamais sous 16px (lisibilité en plein soleil). Touch targets
  ≥52px.

## Paiement à la livraison (Stripe Terminal)

- Lecteur physique cible : BBPOS WisePad 3 (Bluetooth) via
  `@stripe/stripe-terminal-react-native` (beta) ; Tap to Pay n'est pas utilisé.
  Le lecteur **simulé** officiel du SDK sert au développement et remplace
  UNIQUEMENT le matériel (`EXPO_PUBLIC_TERMINAL_MODE=simulated`) ; il est refusé
  dans un build de production. Toute la logique passe par le contrat
  `lib/terminal/reader-adapter.ts` (jamais le SDK directement dans un écran).
- Module natif : un **development build** est requis (Expo Go ne suffit pas) ;
  `minSdkVersion` 26 (`expo-build-properties`).
- `connect` repart toujours d'un contexte propre (`disconnectReader` +
  `clearCachedCredentials`), découvre, ANNULE la découverte dès qu'un lecteur est
  listé (sinon `BLUETOOTH_SCAN_TIMED_OUT`), puis `connectReader(locationId)`.
  Changer de restaurant = rappeler `connect`.
- Le SDK appelle le fournisseur de token plusieurs fois par cycle (2 à 4) ; ne
  pas appeler `disconnectReader` pour économiser la batterie (hors bascule de
  restaurant). La mise à jour du lecteur peut être requise (batterie > 50 %) :
  afficher la progression et ne pas interrompre.
- Aucun succès affiché avant la réponse de `finalize` : le serveur décide.
- Permissions Android : `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` et localisation
  approximative (dès Android 12) demandées par `requestNeededAndroidPermissions`.

## Mes paiements (compte Stripe du livreur, R31)

- Écrans racine `app/paiements/` : `index` (état, choix du type, actions), `onboarding` (composant Stripe
  `ConnectAccountOnboarding` INTÉGRÉ, prioritaire), `versements` (composants Stripe `ConnectPayouts`/`ConnectPayments`,
  ESSAI : à valider sur appareil). Repli de chaque écran : lien hébergé (`lib/open-external.ts`) ou Dashboard Express dans le
  **navigateur système** (`Linking.openURL`, jamais une WebView).
- Choix initial « Je suis indépendant / micro-entrepreneur » (`individual`) ou « J'ai une société » (`company`), confirmé par une
  alerte puis VERROUILLÉ (le serveur répond 409 `EntityTypeLocked` ensuite). Création explicite uniquement (`api.createPayoutAccount`).
- Accès : bandeau `PayoutBanner` sous l'en-tête de l'écran Carte tant que le compte n'est pas prêt (D-F : sans compte prêt, aucune
  course n'est proposée) et carte « Paiement » permanente du Wallet. L'état vient de `lib/payout-account-context.tsx`
  (`PayoutAccountProvider` dans `app/_layout.tsx`, relu au montage et au retour au premier plan) et est traduit en libellés sans
  jargon par `lib/payout-status.ts` (fail-closed : tout état non « prêt » est à compléter). À la fin de l'onboarding intégré
  (`onExit`), l'écran relit l'état jusqu'à « prêt » (≈ 12 s max, « Vérification de vos informations… ») car Stripe active les
  capacités quelques secondes après la fin (constaté sur Pixel : sinon un état périmé « Stripe a besoin d'informations » s'affiche).
- Le mobile ne fournit ni montant, ni identifiant Stripe : le serveur dérive tout. Le secret de session (`api.createPayoutAccountSession`,
  `purpose: 'onboarding' | 'wallet'`) est demandé à chaque besoin par `components/StripeConnectShell.tsx`, jamais stocké.
- Dépendance native `@stripe/stripe-react-native` (0.77.0) : **development build EAS requis** (Expo Go ne suffit pas). Clé PUBLIABLE
  `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`.env` local et environnement EAS `preview`) ; jamais la clé secrète.
- « Mes paiements » (R80) : le Wallet (`app/(tabs)/compte/wallet.tsx`) affiche, depuis `GET /api/v1/drivers/me/settlements` (`api.getMySettlements`,
  types miroirs dans `lib/settlements-types.ts`) : estimation de la semaine en cours (non définitive), résumé envoyé / en attente / dû par un restaurant, périodes
  clôturées ; `app/paiements/periode/[periodId].tsx` détaille une période par restaurant (état lisible via `lib/settlement-labels.ts`, sans jargon Stripe, ton neutre ;
  « paiement prévu le … »). Bloc « Restaurant concerné » (nom légal, SIRET, adresse) UNIQUEMENT si l'API le renvoie (feature flag serveur, base RGPD à valider avant
  production). Dates converties en Europe/Paris CÔTÉ CLIENT ; la fin d'une période est exclusive (le dernier jour affiché est la veille).
- Pages de retour du lien hébergé : `WEB_APP_URL/driver/payout-account/{return,refresh}` (à fournir côté web ; le composant intégré n'en a
  pas besoin).

## Identités légales et documents (Étape 3, `docs/work/invoicing-preparation-plan.md` §5)

- `app/(tabs)/compte/mon-compte.tsx` restructuré en 3 sections : Informations personnelles
  (prénom/nom/téléphone éditables + e-mail lecture seule, source `GET/PATCH
  /api/v1/drivers/me` — plus jamais `user_metadata`, source de vérité unique), Informations
  professionnelles (`GET/PATCH /api/v1/drivers/me/legal-information`), Documents (pièce
  d'identité + justificatif d'entreprise générique, `GET/POST/DELETE
  /api/v1/drivers/me/documents...`). Badge « Non vérifié » et champ date de naissance
  (fictifs, sans backend) supprimés.
- Sélection de fichier : `expo-document-picker` (accepte PDF/JPEG/PNG — un Kbis/RCS est
  souvent un PDF, `expo-image-picker` seul ne l'aurait pas permis), upload multipart via
  `lib/api.ts` → `uploadMultipart()`.

## Modèle économique livraison/frais de service (SF11, ADR 0005, 2026-09-23)

- Le livreur ne voit jamais que son propre gain (`deliveryCents`, plein montant, jamais un net après commission) :
  `app/order/[id]/index.tsx` et `components/order-card.tsx` affichent `order.deliveryCents ?? order.priceCents`
  (repli pour une commande antérieure à SF5, où `deliveryCents` est `null`). `serviceFeeCents` (part Locadely)
  n'est ni lu ni affiché côté livreur — les vues `DriverStatementView`/`DriverPeriodView` de l'API ne l'exposent
  d'ailleurs pas. Le bloc paiement à la livraison (`order.cashOnDelivery.amountCents`, Stripe Terminal Direct
  Charge, ADR 0003) est un flux séparé (encaissement client) et reste le montant total — ne pas confondre avec
  le gain du livreur.
- « Cette semaine » a maintenant UNE seule source : `api.getMySettlements()` → `currentWeek` (champ
  `estimatedAmountCents`, renommé depuis `estimatedNetCents` — même calcul, somme des `deliveryCents`, juste un
  nom qui ne suggère plus une soustraction). La carte Wallet de `app/(tabs)/compte/index.tsx` et l'écran
  `app/(tabs)/compte/wallet.tsx` lisent désormais la même valeur (avant SF11, la carte utilisait un calcul
  local indépendant sans filtre `go_live_at`, pouvant diverger de l'écran détaillé). `currentWeek === null`
  (pas de `go_live_at` posé, ou aucune course) affiche un tiret sur la carte plutôt qu'un montant erroné.
  `lib/earnings.ts`, `components/earning-row.tsx`, `lib/wallet-types.ts` et `api.getMyEarnings()` sont supprimés
  (code mort après cette unification) ; l'endpoint backend `GET /api/v1/orders/driver/earnings` reste en place,
  simplement plus appelé par l'app.

## Mandat de facturation électronique (Étape 5 Tranche 4c, `docs/work/invoicing-preparation-plan.md` §15.20)

- Écran `app/mandat/index.tsx`, point d'entrée : nouvelle carte « Mandat de facturation » dans
  `app/(tabs)/compte/index.tsx` (jamais sur Carte — le mandat ne bloque que la transmission des
  factures Super PDP, jamais le dispatch, ADR 0007 §2). Machine à états locale
  (`loading|error|status|read|name|signing`) — jamais de source de vérité locale durable :
  `useFocusEffect` relit toujours `api.getMandateStatus()` à l'entrée sur l'écran, y compris après
  signature ou après une fermeture d'app en cours de route. Aucun appel Super PDP direct depuis le
  mobile (uniquement `getMandateStatus`/`acceptMandate`/`getMandatePdfUrl`, `lib/api.ts`).
- `lib/mandate-status.ts` → `deriveMandateUi` (pur, même patron que `derivePayoutUi`/
  `lib/payout-status.ts`) : statuts sans jargon (jamais `not_verified`/`provider_mandate_id` à
  l'écran), fail-closed sur un état non reconnu, bandeau de dérive légale (`drift`) toujours
  secondaire et jamais bloquant, `unknown_outcome`/`failed` → « Action requise » sans bouton de
  relance (aucune interface de relance manuelle construite pour ce flux, cohérent avec le reste du
  chantier règlement).
- `components/mandate-signature-pad.tsx` : copie DÉDIÉE de `components/proof-signature.tsx`
  (texte/comportement propres à ce mandat), même `react-native-signature-canvas` déjà installée —
  zéro nouvelle dépendance de signature.
- Aperçu avant signature (`status.previewText`) : texte déjà substitué renvoyé par le backend
  (gabarit réel + données prérequises du livreur), jamais reconstruit côté client à partir de
  fragments séparés — garantit que ce qui est lu est exactement ce qui sera signé. Une fois un
  mandat signé, l'aperçu redevient `null` côté backend : l'app affiche alors seulement le bouton
  « Voir le mandat signé » (`lib/open-external.ts` → `openMandatePdf`, navigateur système, jamais
  une WebView), jamais une reconstruction depuis des données live potentiellement différentes.
- Tests : `apps/mobile` n'a AUCUNE infrastructure de test de composant React Native (zéro fichier
  avant cette tranche, aucun `jest`/`testing-library`) — décision assumée de ne pas en créer une
  pour ce seul écran. `vitest` ajouté (devDependency, `vitest.config.mts`, script `test`)
  UNIQUEMENT pour la logique pure sans dépendance React Native : `lib/mandate-status.test.ts` (15
  tests, tous les états de `deriveMandateUi`). Le dessin/effacement de la signature, l'ouverture/
  fermeture d'écran et la reprise après fermeture d'app ne sont couverts par aucun test automatisé
  (comme le reste de l'app) — vérifiés par relecture attentive et par un rendu PDF réel de bout en
  bout côté backend.

## Documents de facturation (Étape 4, `docs/work/invoicing-preparation-plan.md` §8, enrichi Étape 5 Tranche 5 révisée §16)

`app/order/[id]/index.tsx` affiche, pour une commande `COMPLETED` uniquement
(`api.getOrderDocuments`), toutes ses propres factures (`DriverOrderDocuments`, type contraint à
`issuerKind: 'driver'`/`invoiceTypeCode: '389'`) et ses avoirs éventuels (avec la référence de la
facture d'origine, `originalInvoiceNumber` — jamais un UUID interne) — jamais le montant ni
l'existence de la facture Locadely (le serveur ne l'expose de toute façon jamais à un livreur).
`lib/document-status.ts` → `documentStatusLabel` traduit les deux axes de statut backend
(`transmissionStatus` figé + `submissionStatus` travail worker) en un libellé sans jargon —
corrige un vrai gap trouvé en revue (l'écran affichait auparavant le statut technique brut
`confirmed`/`rejected` tel quel dès qu'il différait de `not_submitted`). Bouton « Voir » par
document quand `facturXAvailable` (`api.getInvoiceDocumentFacturXUrl` → URL signée courte durée,
ouverte via `Linking.openURL`, jamais une WebView), erreur `409` traduite explicitement (« pas
encore prêt »).
