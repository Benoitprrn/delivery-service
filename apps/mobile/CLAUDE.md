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

## Inscription livreur

- `app/driver-signup.tsx` (accès depuis `app/login.tsx`, lien « Créer un compte livreur partenaire »),
  route publique ajoutée aux segments non protégés de `app/_layout.tsx` (comme `login`). Formulaire :
  prénom, nom, e-mail, téléphone, un seul champ mot de passe (critères 8 car./maj/min/spécial affichés
  et cochés en direct), case CGU obligatoire (`components/Checkbox.tsx`, nouveau, réutilisable), bouton
  « Créer mon compte ». Pas de `passwordConfirmation` (contrairement à l'inscription commerçant web, qui
  affiche deux champs distincts) : un seul champ mot de passe, une confirmation dupliquée côté client
  n'aurait rien vérifié — `driverSignupBodySchema` ne l'accepte d'ailleurs plus (`.strict()`). Bypass
  volontaire de `request()` dans `lib/api.ts` → `api.driverSignup` car ce seul appel public doit
  distinguer `201` (compte créé) de `202` (issue Auth réellement indécidable, réservation conservée
  côté serveur pour réconciliation manuelle — voir `apps/api/CLAUDE.md`) que `fetch()` traite tous deux
  comme `ok`. `202` reste volontairement rare (un compte confirmé absent après une issue ambiguë est
  déjà compensé côté serveur et renvoyé en erreur retentable, jamais en `202`) et affiche un écran
  d'attente neutre (jamais un échec, jamais un succès immédiat) avec retour vers connexion. `201` enchaîne
  `supabase.auth.signInWithPassword` (miroir web `signup/page.tsx`) ; la garde de `app/_layout.tsx` fait
  le reste. Erreur de doublon (email OU téléphone, y compris cross-rôle) : message générique unique, ne
  précise jamais lequel.

## Alerte sonore offre de dispatch

- `app/dispatch-offer/[id]/index.tsx` joue un son bref et doux (`assets/sounds/dispatch_offer.wav`,
  deux tons synthétisés ~0,45 s, pas une sirène) 3 fois sur la fenêtre de réponse de 60 s
  (`OFFER_ALERT_REPEAT_DELAYS_MS = [0, 20_000, 40_000]`) plutôt qu'en boucle continue — assez pour
  alerter sans fatiguer l'oreille. Volume fixe modéré (`OFFER_ALERT_VOLUME = 0.35`), joue même en mode
  silencieux (`playsInSilentMode: true`, un livreur ne doit pas rater une course) mais ne coupe jamais
  l'audio d'une autre app (`interruptionMode: 'mixWithOthers'`). S'arrête net dès que l'offre est
  décidée (`decidedRef`), expirée, ou l'écran démonté ; jamais rejouée après.
- `expo-audio` chargé via `require()` protégé par `try/catch` (`loadOptionalAudio`), jamais un import
  statique du module natif : un development build existant qui n'embarque pas encore ce module reste
  fonctionnel et silencieux, sans crash, jusqu'au prochain build EAS (plugin déjà déclaré dans
  `app.json`, cf. règle « Batch EAS builds » — pas de build déclenché pour ça seul).
- Écran d'aperçu (`id === 'preview'`, carte « Aperçu d'une nouvelle course » du Compte) : mêmes
  données fictives, son inclus — sert aussi à valider le rendu et l'alerte sans vraie course.

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
- Accès : bandeau UNIQUE `components/PayoutBanner.tsx` sous l'en-tête de l'écran Carte tant que le livreur n'est pas prêt à
  recevoir des courses — que la cause soit D-F (compte de paiement) ou D-CP (dossier « Mon entreprise », voir plus bas) : même
  message (« Configurez votre compte pour recevoir des courses. »), jamais deux bandeaux empilés. Sa destination au clic dépend
  de la VRAIE cause (`!payoutReady ? '/paiements' : '/compte/mon-compte'`) — le compte de paiement bloque tout le reste, donc
  prioritaire. L'état Stripe vient de `lib/payout-account-context.tsx` (`PayoutAccountProvider` dans `app/_layout.tsx`, relu au
  montage et au retour au premier plan) et est traduit en libellés sans jargon par `lib/payout-status.ts` (fail-closed : tout
  état non « prêt » est à compléter). À la fin de l'onboarding intégré (`onExit`), l'écran relit l'état jusqu'à « prêt »
  (≈ 12 s max, « Vérification de vos informations… ») car Stripe active les capacités quelques secondes après la fin (constaté
  sur Pixel : sinon un état périmé « Stripe a besoin d'informations » s'affiche).
- Le mobile ne fournit ni montant, ni identifiant Stripe : le serveur dérive tout. Le secret de session (`api.createPayoutAccountSession`,
  `purpose: 'onboarding' | 'wallet'`) est demandé à chaque besoin par `components/StripeConnectShell.tsx`, jamais stocké.
- Dépendance native `@stripe/stripe-react-native` (0.77.0) : **development build EAS requis** (Expo Go ne suffit pas). Clé PUBLIABLE
  `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`.env` local et environnement EAS `preview`) ; jamais la clé secrète.
- « Mes paiements » (R80, écran `app/(tabs)/compte/mes-paiements.tsx` — a remplacé l'ancien `wallet.tsx`) affiche, depuis
  `GET /api/v1/drivers/me/settlements` (`api.getMySettlements`, types miroirs dans `lib/settlements-types.ts`) : estimation de
  la semaine en cours (non définitive, total seulement — **aucun détail jour par jour**, ni ici ni pour une période clôturée :
  le backend calcule course par course mais ne renvoie que des totaux), résumé envoyé / en attente / dû par un restaurant,
  périodes clôturées ; `app/paiements/periode/[periodId].tsx` détaille une période **par restaurant** (état lisible via
  `lib/settlement-labels.ts`, sans jargon Stripe, ton neutre ; « paiement prévu le … »). Bloc « Restaurant concerné » (nom
  légal, SIRET, adresse) UNIQUEMENT si l'API le renvoie (feature flag serveur, base RGPD à valider avant production). Dates
  converties en Europe/Paris CÔTÉ CLIENT ; la fin d'une période est exclusive (le dernier jour affiché est la veille).
  Section « Compte de paiement » en pied d'écran (2026-09-25) : tant que le compte n'est pas prêt, bouton unique
  « Configurer mon moyen de paiement » → `/paiements` (écran dédié : choix indépendant/société, onboarding) ; une fois prêt,
  deux boutons distincts — « Historique des virements » (renommé depuis « Versements et transactions », jugé ambigu : donnait
  l'impression de dupliquer les périodes ci-dessus alors que c'est la vue Stripe brute) → `/paiements/versements`, et
  « Gérer mes paiements » → Dashboard Stripe externe (`openStripeDashboard()`, navigateur système).
- Pages de retour du lien hébergé : `WEB_APP_URL/driver/payout-account/{return,refresh}` (à fournir côté web ; le composant intégré n'en a
  pas besoin).

## Compte → Mon Entreprise (brouillon + complétude serveur, 2026-09-25)

- Écran `app/(tabs)/compte/mon-compte.tsx` (« Mon entreprise » depuis `app/(tabs)/compte/index.tsx`) :
  Mes informations (prénom/nom/téléphone + e-mail lecture seule) et Mon entreprise (forme
  juridique, raison sociale, SIRET, adresse légale, régime de TVA, n° de TVA si `assujetti`) + les
  2 documents obligatoires (pièce d'identité, extrait Kbis). Source UNIQUE, remplace l'ancien
  trio d'écrans/endpoints (`GET/PATCH /api/v1/drivers/me` + `/legal-information` séparés,
  supprimés — voir « Nettoyage » plus bas) : `GET/PATCH /api/v1/drivers/me/company-profile`
  (`apps/api/src/modules/drivers/application/company-profile.ts`, table brouillon
  `driver_company_profile_drafts`). Documents : `GET/POST/DELETE /api/v1/drivers/me/documents...`
  (module générique `modules/documents`), sélection via `expo-document-picker` (PDF/JPEG/PNG — un
  Kbis/RCS est souvent un PDF, `expo-image-picker` seul ne l'aurait pas permis), upload multipart
  via `lib/api.ts` → `uploadMultipart()`.
- **Brouillon toujours sauvegardable, même incomplet** : `PATCH .../company-profile` n'exige
  aucun champ (tous nullable côté Zod). Le bouton « Enregistrer » fonctionne à tout moment ;
  aucune donnée n'est perdue entre deux sessions.
- **Complétude calculée côté serveur, jamais côté client** : la réponse porte `status.complete`
  et `status.missing[]` (liste des champs/documents manquants). Tant qu'au moins un champ `*` ou
  un document manque, l'écran affiche « Informations incomplètes » et `app/(tabs)/compte/
  index.tsx` affiche un triangle d'alerte sur l'entrée « Mon entreprise ».
- **Publication différée** : tant que `status.complete` est `false`, la sauvegarde ne touche QUE
  le brouillon — jamais `drivers.first_name/last_name/phone/name` ni
  `driver_legal_information` (les données légales publiées, une fois écrites, ne sont jamais
  effacées rétroactivement par un champ ou un document redevenu manquant ensuite — elles restent
  la dernière version complète connue).
- **Garde D-CP (dispatch)** : un livreur dont ce dossier est incomplet ne se voit proposer ni ne
  peut prendre aucune course — vérifiée côté serveur (`DriverCompanyProfileReadiness`,
  `apps/api/src/modules/orders/ports/driver-company-profile-readiness.ts`), **distincte** de D-F
  (compte de paiement Stripe) : erreur dédiée `DriverCompanyProfileNotReadyError` (403,
  jamais `DriverPayoutAccountNotReadyError`, pour que le livreur comprenne laquelle des deux
  conditions lui manque). Couvert par le même bandeau UNIQUE `components/PayoutBanner.tsx` que D-F
  (voir section « Mes paiements » ci-dessus — jamais un second bandeau empilé) tant que le dossier
  n'est pas complet ; `app/dispatch-offer/[id]/index.tsx` traduit spécifiquement le code
  `DriverCompanyProfileNotReady` en message clair (« Complétez "Mon entreprise" avant de prendre
  des courses ») et renvoie vers l'écran, si jamais une offre était acceptée après être devenu
  ineligible entre la proposition et l'acceptation.
- Aucun statut `verified`/`rejected` ni validation admin — hors scope de cette tranche.

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

- Écran `app/mandat/index.tsx`. **Correctif 2026-09-25** : contrairement à ce que ce document
  affirmait, aucune carte « Mandat de facturation » n'a jamais existé dans
  `app/(tabs)/compte/index.tsx` — l'écran était injoignable depuis l'app (trouvé lors de l'audit
  Compte → Mes factures). Point d'entrée actuel, temporaire : le bandeau UNIQUE de l'écran Carte
  (`components/PayoutBanner.tsx`, D-F/D-CP/D-MD confondus) y redirige quand c'est la seule cause
  restante. **Décision produit amendant ADR 0007 §2 (2026-09-25)** : le mandat non signé bloque
  désormais aussi le dispatch (garde D-MD côté serveur, `modules/orders`) — plus seulement la
  transmission Super PDP. Le vrai point d'entrée définitif (carte dans une page « Mes factures »
  fusionnée mandat + factures) reste à construire. Machine à états locale
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

## Annulation d'une course par le livreur (2026-09-26)

`app/order/[id]/index.tsx`, uniquement quand `order.status === 'ASSIGNED'` (jamais après collecte,
même contrainte que côté backend) : lien texte discret « Annuler » dans l'en-tête, à côté du bouton
de fermeture (X) — décision explicite après un premier essai en bouton secondaire sous « J'ai
collecté le colis », jugé trop visuellement lourd. Texte rouge, pas de fond, pas de proéminence.
Confirmation via `Alert.alert` natif (déjà utilisé ailleurs dans l'app — `proof.tsx`/`payment.tsx`/
`paiements/index.tsx` —, pas de nouveau composant) avant tout appel réseau ; l'annulation elle-même
n'a pas d'écran dédié, juste un toast puis `router.back()`, même patron que « J'ai retourné le
colis ». `api.unassignOrder(orderId, expectedVersion)` → `POST /api/v1/orders/:id/unassign`
(backend : voir `apps/api/CLAUDE.md`). Aucun état local propre à cette action au-delà de
l'`isSubmitting` déjà partagé avec le bouton de collecte (un seul appel réseau possible à la fois
sur cet écran).

`components/hold-action-button.tsx` (extrait de `dispatch-offer/[id]/index.tsx`, qui l'importe
désormais au lieu d'une définition locale) : geste volontaire par appui maintenu 0,5 s
(`Animated.timing`, remplissage coloré qui glisse de 0 à 100 % de la largeur), jamais un simple
tap, pour toute action irréversible sur une commande — Accepter/Refuser une offre (dispatch-offer),
et désormais aussi « J'ai collecté le colis » et « Livraison effectuée » (`order/[id]/index.tsx`).
« J'ai retourné le colis » (statut `RETURNING`) reste un `Pressable` simple au tap, volontairement
non touché par cette tranche (non demandé).

## Remasquage des données client après livraison (2026-09-26)

`RECIPIENT_VISIBLE_STATUSES` (`app/order/[id]/index.tsx`) ne contient plus `COMPLETED` — nom et
téléphone du client redeviennent masqués (`**********`, via `RecipientCard masked`) une fois la
commande livrée, cohérent avec le masquage déjà appliqué avant collecte. Source de vérité réelle
côté backend (voir `apps/api/CLAUDE.md`, `driverOrderSelect`) : le serveur renvoie désormais
`customerName`/`customerPhone` à `null` pour un `COMPLETED`, ce changement mobile suit simplement
cette donnée plutôt que de la reconstituer — sans le backend corrigé, l'écran afficherait `—`
(repli déjà géré) plutôt qu'un vrai masquage visuel cohérent.

## Bascule En cours/Historique de Courses, bug tactile corrigé (2026-09-26)

`app/(tabs)/orders/index.tsx` : la barre de bascule « En cours »/« Historique » vivait dans
`ListHeaderComponent` du `FlatList`, rendue collante via `stickyHeaderIndices={[0]}` — bug connu de
React Native sur Android : une fois défilé, le header reste visuellement épinglé mais cesse de
transmettre les touches (position visuelle correcte, cible tactile qui ne l'est plus). Corrigé en
sortant la barre du `FlatList` : c'est désormais une `View` sibling fixe entre le `SafeAreaView` et
le `FlatList`, jamais dans le contenu défilant, aucun mécanisme sticky nécessaire. L'effet
d'auto-défilement vers le nœud « en cours » de la timeline (`scrollToOffset` basé sur
`currentNodeY`) n'a pas eu besoin d'ajustement : l'offset 0 du `FlatList` correspond déjà au
sommet réel de son propre contenu maintenant que la barre n'en fait plus partie.

## Connexion au serveur de dev : ADB Wi-Fi uniquement (2026-09-26)

Le workflow tunnel Cloudflare (dépendance `cloudflared`, script `npm run tunnel`,
`scripts/start-tunnel.mjs`) a été retiré — décision produit, jamais utilisé sur les machines de
développement réelles du projet. Seul le débogage sans fil ADB (`adb reverse` des ports Metro/API/
Supabase/OSRM) est supporté pour connecter l'app à un serveur de dev, aucune exposition publique du
bundler.
