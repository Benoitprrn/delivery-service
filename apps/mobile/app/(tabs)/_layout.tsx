import { Tabs } from 'expo-router';
import { Map, Package, Wallet } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AvailabilityProvider } from '../../lib/availability-context';
import { EMERALD_600, WHITE } from '../../lib/colors';
import { useDriverLocationTracking } from '../../lib/location-tracking';

const ICON_SIZE = 22;
const ACTIVE_COLOR = EMERALD_600;
const INACTIVE_COLOR = '#A8A29E'; // stone-400

export default function TabsLayout() {
  const insets = useSafeAreaInsets();

  // Tourne tant que ce layout est monté (donc tant que le livreur est
  // authentifié, voir la garde du layout racine) — indépendant de l'onglet
  // actif, pour que le suivi GPS survive à un passage sur "Mes courses"
  // pendant une commande COLLECTED.
  useDriverLocationTracking();

  return (
    <AvailabilityProvider>
      <TabsNavigator insets={insets} />
    </AvailabilityProvider>
  );
}

function TabsNavigator({ insets }: { insets: ReturnType<typeof useSafeAreaInsets> }) {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACTIVE_COLOR,
        tabBarInactiveTintColor: INACTIVE_COLOR,
        tabBarStyle: {
          // 64px fixes (au lieu de 72) : toujours largement ≥52px de zone
          // tactile par item une fois l'inset système ajouté, mais moins
          // "gros" visuellement. L'inset système reste ajouté à la hauteur
          // et au padding pour dégager les gestes Android.
          height: 64 + insets.bottom,
          paddingBottom: insets.bottom + 6,
          paddingTop: 8,
          backgroundColor: WHITE,
          borderTopColor: '#E7E0D5'
        },
        tabBarLabelStyle: {
          // 14px reste le plancher choisi pour ce texte informatif — pas de
          // text-xs/12px, exclu explicitement pour cet écran.
          fontFamily: 'DM Sans Medium',
          fontSize: 14
        }
      }}
    >
      <Tabs.Screen
        name="map/index"
        options={{
          title: 'Carte',
          tabBarIcon: ({ color }) => <Map size={ICON_SIZE} color={color} />
        }}
      />
      <Tabs.Screen
        name="orders/index"
        options={{
          title: 'Mes courses',
          tabBarIcon: ({ color }) => <Package size={ICON_SIZE} color={color} />
        }}
      />
      <Tabs.Screen
        name="wallet/index"
        options={{
          title: 'Wallet',
          tabBarIcon: ({ color }) => <Wallet size={ICON_SIZE} color={color} />
        }}
      />
    </Tabs>
  );
}
