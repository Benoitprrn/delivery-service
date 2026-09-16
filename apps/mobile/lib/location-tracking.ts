import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import type { DriverOrder } from './orders-types';
import { DRIVER_LOCATION_TASK, reportLocationTrackingError } from './location-task';

const ACTIVE_STATUSES = new Set<DriverOrder['status']>(['ASSIGNED', 'COLLECTED']);
const trackingProfileListeners = new Set<(hasActiveOrder: boolean) => void>();
let activeOrderTracking = false;

// Alimenté par les chargements de commandes existants, sans polling dédié.
export function syncLocationTrackingProfile(orders: readonly DriverOrder[]): void {
  const next = orders.some((order) => ACTIVE_STATUSES.has(order.status));
  if (next === activeOrderTracking) return;
  activeOrderTracking = next;
  for (const listener of trackingProfileListeners) listener(next);
}

function useHasActiveOrder(): boolean {
  const [hasActiveOrder, setHasActiveOrder] = useState(activeOrderTracking);
  useEffect(() => {
    trackingProfileListeners.add(setHasActiveOrder);
    return () => { trackingProfileListeners.delete(setHasActiveOrder); };
  }, []);
  return hasActiveOrder;
}

function trackingOptions(hasActiveOrder: boolean): Location.LocationTaskOptions {
  return {
    accuracy: hasActiveOrder ? Location.Accuracy.High : Location.Accuracy.Balanced,
    timeInterval: hasActiveOrder ? 5_000 : 30_000,
    distanceInterval: hasActiveOrder ? 10 : 50,
    foregroundService: {
      notificationTitle: 'Locadely — suivi actif',
      notificationBody: 'Votre position est partagée pour vos livraisons.'
    }
  };
}

export function useDriverLocationTracking(available: boolean): void {
  const hasActiveOrder = useHasActiveOrder();
  useEffect(() => {
    let disposed = false;
    async function configure(): Promise<void> {
      try {
        if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)) {
          await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
        }
        if (!available || disposed) return;
        if (!await Location.hasServicesEnabledAsync()) {
          reportLocationTrackingError('La localisation du téléphone est désactivée.');
          return;
        }
        const permission = await Location.getBackgroundPermissionsAsync();
        if (permission.status !== 'granted') {
          reportLocationTrackingError('L’autorisation de localisation en arrière-plan a été retirée.');
          return;
        }
        await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, trackingOptions(hasActiveOrder));
      } catch (error) {
        reportLocationTrackingError(error instanceof Error ? error.message : 'Le suivi GPS n’a pas pu démarrer.');
      }
    }
    void configure();
    return () => {
      disposed = true;
      void Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)
        .then(async (started) => { if (started) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK); })
        .catch(() => undefined);
    };
  }, [available, hasActiveOrder]);
}
