import { Camera, Map, Marker, type CameraRef } from '@maplibre/maplibre-react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ChevronLeft, ChevronRight, MapPin } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type ViewToken, useWindowDimensions } from 'react-native';
import { FlatList } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Socket } from 'socket.io-client';
import { AvailabilityToggle } from '../../../components/AvailabilityToggle';
import { ErrorState, LoadingState } from '../../../components/list-state';
import { OrderCard } from '../../../components/order-card';
import { SliderButton } from '../../../components/SliderButton';
import { api, ApiError } from '../../../lib/api';
import { useAvailability } from '../../../lib/availability-context';
import { EMERALD_600, STONE_800, WHITE } from '../../../lib/colors';
import type { AvailableOrder } from '../../../lib/orders-types';
import { getSocket } from '../../../lib/socket';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../../lib/toast';

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY;
const BOURG_EN_BRESSE_CENTER: [number, number] = [5.2255, 46.2058]; // [lng, lat]
const INITIAL_ZOOM = 12;
const SINGLE_ORDER_ZOOM = 15;
const MARKER_SIZE = 28;
const MARKER_SIZE_SELECTED = 36;
const MARKER_INACTIVE_OPACITY = 0.6;
// Zone tappable ≥52px (règle Terrain) même si le marqueur visible reste
// petit — un wrapper transparent plus grand que la vue visible, centré sur
// le même point d'ancrage géographique.
const MARKER_HIT_AREA = 52;

const CARD_BOTTOM_MARGIN = 8;
const CAMERA_TOP_MARGIN = 24;
const CAMERA_SIDE_MARGIN = 32;
// Marge supplémentaire au-dessus de la card flottante pour que le marqueur
// actif ne touche jamais son bord supérieur (Fix 5 du brief).
const CAMERA_BOTTOM_SAFETY_MARGIN = 24;
const FIT_BOUNDS_DURATION = 500;
const EASE_TO_DURATION = 300;
// Le brief demande un minimum de 44x44 pour les flèches ; la règle Terrain
// (apps/mobile/CLAUDE.md) impose ≥52px pour toute zone tactile — 52 satisfait
// les deux contraintes simultanément, donc on ne descend pas à 44.
const HEADER_ARROW_SIZE = 52;
const HEADER_ICON_SIZE = 24;

type Bounds = [west: number, south: number, east: number, north: number];

// null si 0/1 commande ou si toutes les commandes partagent exactement les
// mêmes coordonnées — fitBounds sur des bounds dégénérées produit un
// comportement caméra indéfini selon la plateforme.
function computeBounds(orders: AvailableOrder[]): Bounds | null {
  if (orders.length < 2) return null;

  let west = orders[0]!.pickupLng;
  let east = orders[0]!.pickupLng;
  let south = orders[0]!.pickupLat;
  let north = orders[0]!.pickupLat;

  for (const order of orders) {
    west = Math.min(west, order.pickupLng);
    east = Math.max(east, order.pickupLng);
    south = Math.min(south, order.pickupLat);
    north = Math.max(north, order.pickupLat);
  }

  if (west === east && south === north) return null;
  return [west, south, east, north];
}

function buildHeaderLabel(count: number): string {
  if (count === 0) return 'Aucune commande disponible';
  const noun = count === 1 ? 'commande disponible' : 'commandes disponibles';
  return `${count} ${noun}`;
}

export default function AvailableOrdersScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [orders, setOrders] = useState<AvailableOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [cardHeight, setCardHeight] = useState(0);
  const listRef = useRef<FlatList<AvailableOrder>>(null);
  const cameraRef = useRef<CameraRef>(null);
  const { available } = useAvailability();
  // true seulement après qu'un fitBounds (ou un easeTo de secours pour 0/1
  // commande) a été appliqué pour la liste courante — évite que l'effet de
  // suivi de sélection (ci-dessous) ne fasse la course avec le cadrage
  // global au chargement initial ou après un changement de liste.
  const canFollowSelectionRef = useRef(false);

  const visibleOrders = orders ?? [];

  const load = useCallback(async () => {
    setError(null);
    try {
      const profile = await api.getMyDriverProfile();
      setZoneId(profile.zoneId);
      const availableOrders = await api.getAvailableOrders(profile.zoneId);
      setOrders(availableOrders);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger les commandes disponibles.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  // Recale la sélection si la liste se réduit (order_taken) pendant que la
  // dernière card du carrousel est affichée.
  useEffect(() => {
    if (orders !== null && selectedIndex >= orders.length) {
      setSelectedIndex(Math.max(0, orders.length - 1));
    }
  }, [orders, selectedIndex]);

  // Temps réel : identique au flux déjà branché à l'étape 6, seule la cible
  // de rendu change (carrousel + marqueurs au lieu d'une FlatList verticale).
  useEffect(() => {
    if (zoneId === null) return;

    let cancelled = false;
    let activeSocket: Socket | null = null;

    function handleNewOrder() {
      void load();
    }

    function handleOrderTaken(payload: { orderId?: string }) {
      if (typeof payload.orderId !== 'string') return;
      const takenId = payload.orderId;
      setOrders((current) => (current === null ? current : current.filter((order) => order.id !== takenId)));
    }

    function handleReconnect() {
      void load();
    }

    void supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (token === undefined || cancelled) return;
      activeSocket = getSocket(zoneId, token);
      activeSocket.on('new_order', handleNewOrder);
      activeSocket.on('order_taken', handleOrderTaken);
      activeSocket.io.on('reconnect', handleReconnect);
    });

    return () => {
      cancelled = true;
      if (activeSocket !== null) {
        activeSocket.off('new_order', handleNewOrder);
        activeSocket.off('order_taken', handleOrderTaken);
        activeSocket.io.off('reconnect', handleReconnect);
      }
    };
  }, [zoneId, load]);

  // Recalculée seulement quand ses entrées primitives changent (pas un objet
  // recréé à chaque rendu) — utilisée comme dépendance d'effet ci-dessous.
  //
  // Ne PAS ajouter TAB_BAR_HEIGHT/insets.bottom ici : le Tab Navigator
  // (BottomTabView d'expo-router) place la tab bar en flux normal, sibling
  // de la zone d'écrans (flex: 1) — le bas de cet écran correspond déjà au
  // haut de la tab bar, cet espace est déjà exclu, l'ajouter ici le
  // compterait une deuxième fois (bug constaté : card quasi centrée).
  const cameraPadding = useMemo(
    () => ({
      top: insets.top + CAMERA_TOP_MARGIN,
      left: CAMERA_SIDE_MARGIN,
      right: CAMERA_SIDE_MARGIN,
      bottom: cardHeight + CAMERA_BOTTOM_SAFETY_MARGIN
    }),
    [insets.top, cardHeight]
  );

  // Cadrage global : se déclenche au chargement de la carte et à chaque
  // changement réel de la liste de commandes (nouvelle commande, commande
  // prise par quelqu'un d'autre, rechargement) — jamais sur un simple
  // changement de sélection dans le carrousel (voir l'effet suivant).
  useEffect(() => {
    canFollowSelectionRef.current = false;
    if (!mapReady) return;

    const bounds = computeBounds(visibleOrders);
    if (bounds !== null) {
      cameraRef.current?.fitBounds(bounds, { padding: cameraPadding, duration: FIT_BOUNDS_DURATION });
      canFollowSelectionRef.current = true;
    } else if (visibleOrders.length === 1) {
      const [only] = visibleOrders;
      cameraRef.current?.easeTo({
        center: [only!.pickupLng, only!.pickupLat],
        zoom: SINGLE_ORDER_ZOOM,
        padding: cameraPadding,
        duration: FIT_BOUNDS_DURATION
      });
      canFollowSelectionRef.current = true;
    }
    // visibleOrders est dérivé de `orders` à chaque rendu (pas de useMemo) —
    // orders est la dépendance stable à surveiller, pas visibleOrders.
  }, [mapReady, orders, cameraPadding]);

  // Suit la sélection du carrousel (swipe, flèche ou tap marqueur) en
  // gardant le même padding, pour que le marqueur actif reste toujours
  // dégagé au-dessus de la card flottante. Ignoré tant que le cadrage
  // global de la liste courante n'a pas eu lieu (effet précédent).
  useEffect(() => {
    if (!canFollowSelectionRef.current) return;
    const order = visibleOrders[selectedIndex];
    if (order === undefined) return;
    cameraRef.current?.easeTo({
      center: [order.pickupLng, order.pickupLat],
      padding: cameraPadding,
      duration: EASE_TO_DURATION
    });
  }, [selectedIndex]);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0];
    if (first?.index !== null && first?.index !== undefined) {
      setSelectedIndex(first.index);
    }
  }).current;

  // Point d'entrée unique pour tout ce qui doit déplacer le carrousel vers
  // un index donné — swipe (via onViewableItemsChanged ci-dessus), tap sur
  // un marqueur, ou tap sur une flèche du header (Fix 2 : "même effet que
  // swipe").
  function moveToIndex(index: number) {
    if (index < 0 || index >= visibleOrders.length) return;
    setSelectedIndex(index);
    listRef.current?.scrollToIndex({ index, animated: true });
  }

  function selectOrder(orderId: string) {
    moveToIndex(visibleOrders.findIndex((order) => order.id === orderId));
  }

  function openDetail(order: AvailableOrder) {
    router.push({ pathname: '/order/[id]', params: { id: order.id, order: JSON.stringify(order) } });
  }

  async function handleAssign(order: AvailableOrder): Promise<void> {
    await api.assignOrder(order.id, order.version);
  }

  function handleAssignSuccess(): void {
    showToast('Course prise ✓');
    void load();
  }

  function handleCardZoneLayout(event: LayoutChangeEvent) {
    setCardHeight(event.nativeEvent.layout.height);
  }

  if (orders === null && error === null) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  if (error !== null && orders === null) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <ErrorState message={error} onRetry={() => void load()} />
      </SafeAreaView>
    );
  }

  if (MAPTILER_KEY === undefined || MAPTILER_KEY.length === 0) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-page-mobile" edges={['top']}>
        <Text className="text-center font-sans text-body-lg text-stone-500">
          Configuration de la carte manquante (clé MapTiler absente de .env).
        </Text>
      </SafeAreaView>
    );
  }

  const canGoPrevious = visibleOrders.length > 0 && selectedIndex > 0;
  const canGoNext = visibleOrders.length > 0 && selectedIndex < visibleOrders.length - 1;

  return (
    <View className="flex-1">
      <StatusBar style="dark" />

      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={`https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`}
        attribution
        logo
        onDidFinishLoadingMap={() => setMapReady(true)}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{ center: BOURG_EN_BRESSE_CENTER, zoom: INITIAL_ZOOM }}
          minZoom={12}
          maxZoom={15}
          maxBounds={[5.10, 46.10, 5.40, 46.32]}
        />
        {visibleOrders.map((order, index) => (
          <Marker
            key={order.id}
            id={order.id}
            lngLat={[order.pickupLng, order.pickupLat]}
            onPress={(event) => selectOrder(event.nativeEvent.id)}
          >
            <View style={styles.markerHitArea}>
              <View style={[styles.marker, index === selectedIndex ? styles.markerSelected : styles.markerInactive]} />
            </View>
          </Marker>
        ))}
      </Map>

      {/* Bloc blanc unifié : safe area top + header navigation, un seul
          conteneur continu au-dessus de la carte (Fix 1 + Fix 2). */}
      <View className="absolute left-0 right-0 top-0 z-10 bg-white" style={{ paddingTop: insets.top }}>
        <View className="h-14 flex-row items-center px-1">
          <Pressable
            onPress={() => moveToIndex(selectedIndex - 1)}
            disabled={!canGoPrevious}
            hitSlop={8}
            className="items-center justify-center rounded-full disabled:opacity-30"
            style={{ width: HEADER_ARROW_SIZE, height: HEADER_ARROW_SIZE }}
          >
            <ChevronLeft size={HEADER_ICON_SIZE} color={STONE_800} />
          </Pressable>
          <Text className="flex-1 text-center font-sans-semibold text-sm text-stone-800" numberOfLines={1}>
            {buildHeaderLabel(visibleOrders.length)}
          </Text>
          <Pressable
            onPress={() => moveToIndex(selectedIndex + 1)}
            disabled={!canGoNext}
            hitSlop={8}
            className="items-center justify-center rounded-full disabled:opacity-30"
            style={{ width: HEADER_ARROW_SIZE, height: HEADER_ARROW_SIZE }}
          >
            <ChevronRight size={HEADER_ICON_SIZE} color={STONE_800} />
          </Pressable>
        </View>
      </View>

      <AvailabilityToggle />

      {/* Card flottante sur la carte (Fix 4), au-dessus du tab bar. Pas de
          TAB_BAR_HEIGHT/insets.bottom ici : le bas de cet écran est déjà
          au-dessus de la tab bar (flux normal du Tab Navigator, pas un
          overlay) — voir le commentaire sur cameraPadding plus haut. */}
      <View
        onLayout={handleCardZoneLayout}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: CARD_BOTTOM_MARGIN
        }}
      >
        {!available ? (
          <View className="w-[90%] self-center rounded-2xl border border-border bg-surface p-3 shadow-sm">
            <View className="items-center gap-1">
              <MapPin size={20} color={EMERALD_600} />
              <Text className="text-center font-sans-semibold text-sm text-stone-800">Vous êtes indisponible</Text>
              <Text className="text-center font-sans text-sm text-stone-500">
                Activez le toggle en haut pour voir les courses de votre zone
              </Text>
            </View>
          </View>
        ) : visibleOrders.length === 0 ? (
          <View className="w-[90%] self-center rounded-2xl border border-border bg-surface p-3 shadow-sm">
            <View className="items-center gap-1">
              <MapPin size={20} color={EMERALD_600} />
              <Text className="text-center font-sans-semibold text-sm text-stone-800">
                Aucune course disponible dans votre zone
              </Text>
              <Text className="text-center font-sans text-sm text-stone-500">Revenez plus tard</Text>
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={visibleOrders}
            keyExtractor={(order) => order.id}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            viewabilityConfig={viewabilityConfig}
            onViewableItemsChanged={onViewableItemsChanged}
            getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
            initialScrollIndex={selectedIndex < visibleOrders.length ? selectedIndex : 0}
            renderItem={({ item }) => (
              <View style={{ width }}>
                <View className="w-[90%] self-center">
                  <OrderCard
                    order={item}
                    merchantName={item.merchantName}
                    truncateAddresses
                    onPress={() => openDetail(item)}
                    footer={
                      <SliderButton
                        label="Glisser pour prendre →"
                        onComplete={() => handleAssign(item)}
                        onSuccess={handleAssignSuccess}
                      />
                    }
                  />
                </View>
              </View>
            )}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  markerHitArea: {
    width: MARKER_HIT_AREA,
    height: MARKER_HIT_AREA,
    alignItems: 'center',
    justifyContent: 'center'
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    backgroundColor: EMERALD_600,
    borderWidth: 3,
    borderColor: WHITE
  },
  markerSelected: {
    width: MARKER_SIZE_SELECTED,
    height: MARKER_SIZE_SELECTED,
    borderRadius: MARKER_SIZE_SELECTED / 2,
    borderWidth: 4
  },
  markerInactive: {
    opacity: MARKER_INACTIVE_OPACITY
  }
});
