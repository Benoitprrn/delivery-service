import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { API_URL, ApiError, api } from './api';

const PUSH_TOKEN_STORAGE_KEY = 'driver-push-token';
const PUSH_TOKEN_ENDPOINT = `${API_URL}/api/v1/drivers/push-token`;
const PUSH_TOKEN_RETRY_DELAY_MS = 30_000;

type NotificationsModule = typeof import('expo-notifications');
type NotificationResponse = import('expo-notifications').NotificationResponse;

function openMapFromNotification(response: NotificationResponse): void {
  const data = response.notification.request.content.data;
  if (data !== undefined && typeof data.orderId === 'string') router.replace('/(tabs)/map');
}

async function registerPushToken(Notifications: NotificationsModule): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('new-orders', {
      name: 'Nouvelles courses',
      importance: Notifications.AndroidImportance.HIGH
    });
  }

  const permissions = await Notifications.getPermissionsAsync();
  const status = permissions.status === 'granted'
    ? permissions.status
    : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (await SecureStore.getItemAsync(PUSH_TOKEN_STORAGE_KEY) === token) return;

  console.info('[push] Enregistrement du token push', { url: PUSH_TOKEN_ENDPOINT, token });
  try {
    await api.registerPushToken(token);
    console.info('[push] Token push enregistré', { url: PUSH_TOKEN_ENDPOINT, token });
    await SecureStore.setItemAsync(PUSH_TOKEN_STORAGE_KEY, token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 502) {
      console.error('[push] Erreur 502 lors de l’enregistrement du token push', {
        url: PUSH_TOKEN_ENDPOINT,
        token
      });
    }
    throw error;
  }
}

// expo-notifications évalue requireNativeModule('ExpoPushTokenManager') dès
// son import. Un APK construit avant l'ajout du plugin ne contient pas ce
// module natif : l'import dynamique protège alors tout le layout racine, sur
// le même modèle que lib/location-tracking.ts.
export function usePushNotifications(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let responseSubscription: { remove: () => void } | undefined;
    let pushTokenRetryTimeout: ReturnType<typeof setTimeout> | undefined;

    async function start(): Promise<void> {
      let Notifications: NotificationsModule;
      try {
        Notifications = await import('expo-notifications');
      } catch (error) {
        console.warn('[push] Module natif expo-notifications indisponible — notifications désactivées pour cette session', error);
        return;
      }

      if (cancelled) return;

      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false
        })
      });

      const registerPushTokenWithRetry = (): void => {
        void registerPushToken(Notifications).catch((error: unknown) => {
          console.warn('[push] Impossible d’enregistrer le token ; nouvelle tentative dans 30 s', error);
          if (!cancelled) {
            pushTokenRetryTimeout = setTimeout(registerPushTokenWithRetry, PUSH_TOKEN_RETRY_DELAY_MS);
          }
        });
      };
      registerPushTokenWithRetry();

      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!cancelled && response !== null) openMapFromNotification(response);
      } catch (error) {
        console.warn('[push] Impossible de lire la dernière notification', error);
      }

      if (!cancelled) {
        responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
          openMapFromNotification(response);
        });
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (pushTokenRetryTimeout !== undefined) clearTimeout(pushTokenRetryTimeout);
      responseSubscription?.remove();
    };
  }, [enabled]);
}
