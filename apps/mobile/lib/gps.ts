type LocationModule = typeof import('expo-location');

export type CurrentPositionResult =
  | { position: { lat: number; lng: number; timestamp: number } }
  | { reason: 'permission_denied' | 'services_disabled' | 'unavailable' };

// Pas d'option `timeout` dans expo-location ~57 (LocationOptions n'expose
// que accuracy/mayShowUserSettingsDialog/timeInterval/distanceInterval) —
// un fix GPS peut légitimement prendre plusieurs secondes, mais sans borne
// il peut aussi rester en attente indéfiniment (signal faible, indoor). Ce
// timeout JS fait courir getCurrentPositionAsync contre une limite, sans
// annuler l'appel natif sous-jacent (expo-location n'expose pas d'annulation
// pour cet appel) — juste pour ne pas bloquer l'utilisateur indéfiniment,
// avec repli sur la dernière position connue comme le cas d'échec normal.
const FIX_TIMEOUT_MS = 8_000;
const REQUIRED_ACCURACY_METERS = 100;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

let cachedModule: LocationModule | null = null;
let moduleLoadFailed = false;

// Import dynamique et différé plutôt qu'un `import * as Location from
// 'expo-location'` statique en haut du fichier : le module expo-location
// appelle requireNativeModule('ExpoLocation') dès son évaluation — si le
// module natif n'est pas lié dans le binaire installé (build EAS pas à jour,
// test sur Expo Go plutôt qu'un dev build...), un import statique plante à
// l'évaluation du module, ce qui peut faire tomber toute une route qui
// l'importe. En différant l'import réel et en l'entourant d'un try/catch,
// une absence du module natif désactive silencieusement la géolocalisation
// pour cette session plutôt que de faire planter l'app. Le résultat de
// l'import est mis en cache ici (partagé par tous les appelants) plutôt que
// par chaque hook/fonction : le module ES lui-même est déjà mis en cache par
// le runtime après un premier import réussi, seul l'échec mérite d'être
// mémorisé pour éviter de retenter un import voué à échouer à chaque appel.
async function loadLocationModule(): Promise<LocationModule | null> {
  if (cachedModule !== null || moduleLoadFailed) return cachedModule;
  try {
    cachedModule = await import('expo-location');
    return cachedModule;
  } catch (err) {
    moduleLoadFailed = true;
    console.error('[gps] module natif expo-location indisponible — géolocalisation désactivée pour cette session', err);
    return null;
  }
}

// Best-effort : renvoie null sur tout échec (module natif absent, permission
// refusée, GPS temporairement indisponible) plutôt que de lever — aucun
// appelant de ce module ne doit bloquer un flux utilisateur (bascule de
// disponibilité, tick de suivi) sur l'absence d'une position.
export async function getCurrentPosition(): Promise<CurrentPositionResult> {
  const Location = await loadLocationModule();
  if (Location === null) return { reason: 'unavailable' };

  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== 'granted' && permission.canAskAgain) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (permission.status !== 'granted') return { reason: 'permission_denied' };

    // Distinct de la permission app (vérifiée ci-dessus) : ce sont les
    // services de localisation du téléphone lui-même (le GPS système). Une
    // permission accordée mais des services système coupés produisaient
    // auparavant le même message générique "activez le GPS" que n'importe
    // quel autre échec — trompeur quand l'utilisateur a déjà vérifié que la
    // permission de l'app est bien active.
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) return { reason: 'services_disabled' };

    try {
      const position = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        FIX_TIMEOUT_MS
      );
      if (position.coords.accuracy === null || position.coords.accuracy > REQUIRED_ACCURACY_METERS) {
        throw new Error('insufficient_accuracy');
      }
      return { position: { lat: position.coords.latitude, lng: position.coords.longitude, timestamp: position.timestamp } };
    } catch {
      // Une permission peut être accordée avant que le GPS ait obtenu un fix.
      // Une dernière position récente suffit à initialiser le rayon de dispatch.
      const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000, requiredAccuracy: REQUIRED_ACCURACY_METERS });
      if (lastKnown === null) return { reason: 'unavailable' };
      return {
        position: {
          lat: lastKnown.coords.latitude,
          lng: lastKnown.coords.longitude,
          timestamp: lastKnown.timestamp
        }
      };
    }
  } catch {
    return { reason: 'unavailable' };
  }
}

// Le suivi périodique peut ignorer un tick sans message à l'utilisateur.
export async function getCurrentPositionOrNull(): Promise<{ lat: number; lng: number; timestamp: number } | null> {
  const result = await getCurrentPosition();
  return 'position' in result ? result.position : null;
}
