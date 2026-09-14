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
