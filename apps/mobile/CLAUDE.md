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
