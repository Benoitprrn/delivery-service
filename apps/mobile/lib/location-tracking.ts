import { useEffect } from 'react';
import { api } from './api';

const TRACKING_INTERVAL_MS = 5_000;
const ACTIVE_STATUSES = new Set(['ASSIGNED', 'COLLECTED']);

type LocationModule = typeof import('expo-location');

// Suivi GPS premier plan uniquement (décision produit étape 10 — pas de
// permission ACCESS_BACKGROUND_LOCATION Android 13, pas de foreground
// service). Ce hook vit au niveau du layout des onglets plutôt que dans
// l'écran carte lui-même : il doit continuer de tourner même si le livreur
// consulte "Mes courses" pendant une commande COLLECTED, pas seulement
// quand l'onglet Carte a le focus.
export function useDriverLocationTracking(): void {
  useEffect(() => {
    let cancelled = false;
    let hasPermission = false;
    let permissionRequested = false;
    let locationModule: LocationModule | null = null;
    let moduleLoadFailed = false;

    // Import dynamique et différé plutôt qu'un `import * as Location from
    // 'expo-location'` statique en haut du fichier : le module expo-location
    // appelle requireNativeModule('ExpoLocation') dès son évaluation (voir
    // node_modules/expo-location/build/ExpoLocation.js) — si le module natif
    // n'est pas lié dans le binaire installé (build EAS pas à jour, test sur
    // Expo Go plutôt qu'un dev build...), un import statique plante à
    // l'évaluation du module, ce qui remonte jusqu'à faire échouer
    // l'évaluation de app/(tabs)/_layout.tsx tout entier (symptôme observé :
    // "Route (tabs)/_layout.tsx is missing the required default export",
    // alors que l'export lui-même n'a rien — c'est l'import qui casse tout
    // avant que le fichier ne s'évalue). En différant l'import réel jusqu'au
    // premier tick et en l'entourant d'un try/catch, une absence du module
    // natif désactive silencieusement le suivi GPS au lieu de faire tomber
    // toute la navigation par onglets.
    async function loadLocationModule(): Promise<LocationModule | null> {
      if (locationModule !== null || moduleLoadFailed) return locationModule;
      try {
        locationModule = await import('expo-location');
        return locationModule;
      } catch (err) {
        moduleLoadFailed = true;
        console.error(
          '[location-tracking] module natif expo-location indisponible — suivi GPS désactivé pour cette session',
          err
        );
        return null;
      }
    }

    async function tick(): Promise<void> {
      if (cancelled || moduleLoadFailed) return;
      try {
        const { orders } = await api.getMyOrders();
        const hasActiveOrder = orders.some((order) => ACTIVE_STATUSES.has(order.status));
        if (!hasActiveOrder) return;

        const Location = await loadLocationModule();
        if (Location === null) return;

        if (!hasPermission) {
          // Demandée une seule fois par montage — si refusée, ne pas
          // re-solliciter l'utilisateur à chaque tick de 5s.
          if (permissionRequested) return;
          permissionRequested = true;
          const { status } = await Location.requestForegroundPermissionsAsync();
          hasPermission = status === 'granted';
          if (!hasPermission) return;
        }

        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        await api.recordLocation(
          position.coords.latitude,
          position.coords.longitude,
          new Date(position.timestamp).toISOString()
        );
      } catch {
        // Échec ponctuel (GPS temporairement indisponible, requête réseau,
        // profil pas encore chargé...) — sans conséquence, on retente au
        // prochain tick 5s plus tard.
      }
    }

    void tick();
    const intervalId = setInterval(() => void tick(), TRACKING_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);
}
