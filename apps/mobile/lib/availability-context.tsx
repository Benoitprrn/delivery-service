import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import { api, ApiError } from './api';
import { getCurrentPosition } from './gps';
import { subscribeToLocationTrackingErrors } from './location-task';
import { showToast } from './toast';

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
const GPS_ERROR_GRACE_MS = 2 * 60 * 1000;
const NETWORK_LOSS_DEBOUNCE_MS = 5_000;

type AvailabilityContextValue = {
  available: boolean;
  // true tant que l'état serveur n'a pas encore été résolu au moins une
  // fois — évite d'afficher "Indisponible" par défaut avant confirmation.
  resolving: boolean;
  updating: boolean;
  toggle: () => Promise<void>;
};

const AvailabilityContext = createContext<AvailabilityContextValue | undefined>(undefined);

export function AvailabilityProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [resolving, setResolving] = useState(true);
  const [updating, setUpdating] = useState(false);
  // Lu par l'intervalle de heartbeat sans le recréer à chaque changement de
  // disponibilité — seul l'effet qui (dé)programme l'intervalle dépend de
  // `available` (voir plus bas).
  const availableRef = useRef(available);
  availableRef.current = available;

  const setUnavailableAutomatically = async (): Promise<void> => {
    if (!availableRef.current) return;
    try {
      await api.setAvailability(false);
      setAvailable(false);
    } catch {
      // A network loss can prevent this request from leaving the phone. The
      // 10-minute server TTL remains the fallback and we never auto-enable.
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function resolveInitialState() {
      try {
        const profile = await api.getMyDriverProfile();
        if (cancelled) return;
        setAvailable(profile.isAvailable);
      } catch {
        // Sans réponse du serveur, l'état reste indisponible : on ne montre
        // jamais une valeur locale périmée à la place de celle de Valkey.
      } finally {
        if (!cancelled) setResolving(false);
      }
    }

    void resolveInitialState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!available) return;

    const intervalId = setInterval(() => {
      void api.sendAvailabilityHeartbeat().catch(() => {
        // Échec ponctuel de heartbeat : sans conséquence, la clé Valkey a 8
        // minutes de marge avant expiration et on retente au prochain tick.
      });
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [available]);

  useEffect(() => {
    let gpsErrorTimer: ReturnType<typeof setTimeout> | undefined;

    function clearGpsErrorTimer(): void {
      if (gpsErrorTimer !== undefined) clearTimeout(gpsErrorTimer);
      gpsErrorTimer = undefined;
    }

    return subscribeToLocationTrackingErrors((message) => {
      clearGpsErrorTimer();
      if (message.length === 0 || !availableRef.current) return;
      gpsErrorTimer = setTimeout(() => {
        void (async () => {
          // A valid permission and enabled system service mean the previously
          // reported native issue has been resolved; silence alone never
          // triggers this watchdog, so a stationary driver stays available.
          const [servicesEnabled, permission] = await Promise.all([
            Location.hasServicesEnabledAsync(),
            Location.getBackgroundPermissionsAsync()
          ]).catch(() => [false, { status: 'denied' }] as const);
          if (servicesEnabled && permission.status === 'granted') return;
          await setUnavailableAutomatically();
        })().catch(() => undefined);
      }, GPS_ERROR_GRACE_MS);
    });
  }, []);

  useEffect(() => {
    let networkLossTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const disconnected = state.isConnected === false || state.isInternetReachable === false;
      if (!disconnected) {
        if (networkLossTimer !== undefined) clearTimeout(networkLossTimer);
        networkLossTimer = undefined;
        return;
      }
      if (networkLossTimer !== undefined) return;
      networkLossTimer = setTimeout(() => {
        networkLossTimer = undefined;
        void setUnavailableAutomatically();
      }, NETWORK_LOSS_DEBOUNCE_MS);
    });
    return () => {
      if (networkLossTimer !== undefined) clearTimeout(networkLossTimer);
      unsubscribe();
    };
  }, []);

  const value = useMemo<AvailabilityContextValue>(
    () => ({
      available,
      resolving,
      updating,
      toggle: async () => {
        const next = !availableRef.current;
        setUpdating(true);
        try {
          if (!next) {
            await api.setAvailability(false);
          } else {
            const servicesEnabled = await Location.hasServicesEnabledAsync();
            if (!servicesEnabled) {
              throw new Error('Activez votre localisation pour vous rendre disponible');
            }
            const location = await getCurrentPosition();
            if (!('position' in location)) {
              throw new Error(
                location.reason === 'permission_denied'
                  ? 'Autorisez votre position pour vous rendre disponible.'
                  : location.reason === 'services_disabled'
                    ? 'Activez votre localisation pour vous rendre disponible'
                    : 'Position GPS introuvable. Réessayez dans quelques instants.'
              );
            }
            const backgroundPermission = await Location.requestBackgroundPermissionsAsync();
            if (backgroundPermission.status !== 'granted') {
              throw new Error('Autorisez la localisation en arrière-plan pour vous rendre disponible.');
            }
            await api.recordLocation(location.position.lat, location.position.lng, new Date(location.position.timestamp).toISOString());
            await api.setAvailability(true);
          }

          // Relit /drivers/me qui est alimenté par Valkey : aucune mise à
          // jour optimiste ne peut laisser l'UI dans un état faux.
          const profile = await api.getMyDriverProfile();
          setAvailable(profile.isAvailable);
          showToast(profile.isAvailable ? 'Vous êtes maintenant disponible.' : 'Vous êtes maintenant indisponible.');
        } catch (err) {
          showToast(
            err instanceof ApiError || err instanceof Error
              ? err.message
              : 'Impossible de mettre à jour votre disponibilité.'
          );
        } finally {
          setUpdating(false);
        }
      }
    }),
    [available, resolving, updating]
  );

  return <AvailabilityContext.Provider value={value}>{children}</AvailabilityContext.Provider>;
}

export function useAvailability(): AvailabilityContextValue {
  const context = useContext(AvailabilityContext);
  if (context === undefined) {
    throw new Error('useAvailability must be used within an AvailabilityProvider');
  }
  return context;
}
