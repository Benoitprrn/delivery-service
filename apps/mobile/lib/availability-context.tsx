import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { showToast } from './toast';

const STORAGE_KEY = 'driver_availability';
// Aligné sur le TTL Valkey côté API (EX 300s) — appelé avant expiration pour
// que la clé driver:{id}:is_available ne tombe jamais pendant que le livreur
// est réellement disponible (voir apps/api/src/modules/drivers).
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;

type AvailabilityContextValue = {
  available: boolean;
  // true tant que l'état serveur n'a pas encore été résolu au moins une
  // fois — évite d'afficher "Indisponible" par défaut avant confirmation.
  resolving: boolean;
  toggle: () => Promise<void>;
};

const AvailabilityContext = createContext<AvailabilityContextValue | undefined>(undefined);

async function readCachedAvailability(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(STORAGE_KEY)) === 'true';
  } catch {
    return false;
  }
}

async function writeCachedAvailability(value: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Persistance best-effort : un échec ici ne doit pas bloquer le toggle,
    // seul le confort "survit au redémarrage" est perdu pour cette session.
  }
}

export function AvailabilityProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [resolving, setResolving] = useState(true);
  // Lu par l'intervalle de heartbeat sans le recréer à chaque changement de
  // disponibilité — seul l'effet qui (dé)programme l'intervalle dépend de
  // `available` (voir plus bas).
  const availableRef = useRef(available);
  availableRef.current = available;

  useEffect(() => {
    let cancelled = false;

    async function resolveInitialState() {
      const cached = await readCachedAvailability();
      if (!cancelled) setAvailable(cached);

      // La clé Valkey expire au bout de 5 minutes (TTL) sans heartbeat — la
      // valeur mise en cache peut donc être périmée après un redémarrage de
      // l'app. Le profil livreur fait toujours foi.
      try {
        const profile = await api.getMyDriverProfile();
        if (cancelled) return;
        setAvailable(profile.isAvailable);
        void writeCachedAvailability(profile.isAvailable);
      } catch {
        // Hors-ligne au démarrage : on garde la valeur mise en cache le
        // temps qu'une action réseau (toggle, chargement carte) échoue et
        // informe l'utilisateur autrement.
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
        // Échec ponctuel de heartbeat : sans conséquence, la clé Valkey a 5
        // minutes de marge avant expiration et on retente au prochain tick.
      });
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [available]);

  const value = useMemo<AvailabilityContextValue>(
    () => ({
      available,
      resolving,
      toggle: async () => {
        const next = !availableRef.current;
        setAvailable(next);
        try {
          const result = await api.setAvailability(next);
          setAvailable(result.available);
          void writeCachedAvailability(result.available);
        } catch (err) {
          setAvailable(!next);
          showToast(err instanceof ApiError ? err.message : 'Impossible de mettre à jour votre disponibilité.');
        }
      }
    }),
    [available, resolving]
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
