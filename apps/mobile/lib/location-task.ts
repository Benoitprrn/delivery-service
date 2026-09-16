import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';

export const DRIVER_LOCATION_TASK = 'locadely-driver-location';

type LocationTrackingErrorListener = (message: string) => void;
const errorListeners = new Set<LocationTrackingErrorListener>();

export function subscribeToLocationTrackingErrors(listener: LocationTrackingErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

export function reportLocationTrackingError(message: string): void {
  for (const listener of errorListeners) listener(message);
}

export function reportLocationTrackingRecovered(): void {
  for (const listener of errorListeners) listener('');
}

TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error !== null && error !== undefined) {
    reportLocationTrackingError(error.message || 'Le suivi GPS a rencontré une erreur native.');
    return;
  }
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  const location = locations?.[locations.length - 1];
  if (location === undefined) return;
  try {
    await api.recordLocation(location.coords.latitude, location.coords.longitude, new Date(location.timestamp).toISOString());
    reportLocationTrackingRecovered();
  } catch {
    // A network/API failure is not a confirmed GPS failure.
  }
});
