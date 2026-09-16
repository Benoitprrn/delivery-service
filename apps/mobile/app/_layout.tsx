import '../global.css';
import '../lib/location-task';

import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
  useFonts
} from '@expo-google-fonts/dm-sans';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, useAuth } from '../lib/auth-context';
import { usePushNotifications } from '../lib/push-notifications';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'DM Sans': DMSans_400Regular,
    'DM Sans Medium': DMSans_500Medium,
    'DM Sans SemiBold': DMSans_600SemiBold,
    'DM Sans Bold': DMSans_700Bold
  });

  return (
    <AuthProvider>
      <AppShell fontsLoaded={fontsLoaded} />
    </AuthProvider>
  );
}

function AppShell({ fontsLoaded }: { fontsLoaded: boolean }) {
  const { status, role } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  // Garde le splash natif affiché tant que polices ET session ne sont pas
  // résolues — sinon flash de couleur (splash Emerald -> fond app) pendant
  // que la session se restaure depuis expo-secure-store.
  const ready = fontsLoaded && status !== 'loading';
  usePushNotifications(ready && status === 'signedIn' && role === 'driver');

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  useEffect(() => {
    if (!ready) return;

    const inTabsGroup = segments[0] === '(tabs)';
    // Modales de détail commande / offre de dispatch (voir
    // app/order/[id]/index.tsx et app/dispatch-offer/[id]/index.tsx) — routes
    // racine authentifiées, pas des onglets. Doivent compter comme "déjà au
    // bon endroit" sinon la garde les referme immédiatement après ouverture.
    const inOrderModal = segments[0] === 'order';
    const inDispatchOfferModal = segments[0] === 'dispatch-offer';
    const onLoginScreen = segments[0] === 'login';
    const isAuthorizedDriver = status === 'signedIn' && role === 'driver';

    if (!isAuthorizedDriver && !onLoginScreen) {
      router.replace('/login');
    } else if (isAuthorizedDriver && !inTabsGroup && !inOrderModal && !inDispatchOfferModal) {
      router.replace('/(tabs)/map');
    }
  }, [ready, status, role, segments, router]);

  if (!ready) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="order/[id]/index" options={{ presentation: 'modal' }} />
        <Stack.Screen name="order/[id]/proof" options={{ presentation: 'modal' }} />
        <Stack.Screen name="dispatch-offer/[id]/index" options={{ presentation: 'modal', gestureEnabled: false }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
