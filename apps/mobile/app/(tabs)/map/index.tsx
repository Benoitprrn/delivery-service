import { Camera, GeoJSONSource, Layer, Map, Marker, type CameraRef } from '@maplibre/maplibre-react-native';
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
import { api, ApiError, type OrderRouteGeometry } from '../../../lib/api';
import { syncLocationTrackingProfile } from '../../../lib/location-tracking';
import { useAvailability } from '../../../lib/availability-context';
import { BLUE_500, EMERALD_600, STONE_800, WHITE } from '../../../lib/colors';
import type { DriverOrder } from '../../../lib/orders-types';
import { getSocket } from '../../../lib/socket';
import { supabase } from '../../../lib/supabase';

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY;
const BOURG_EN_BRESSE_CENTER: [number, number] = [5.2255, 46.2058]; // [lng, lat]
const INITIAL_ZOOM = 10;
const MIN_ZOOM = 10;
const MAX_ZOOM = 15;
const SINGLE_ORDER_ZOOM = 15;
const ORDER_ROUTE_ZOOM_MARGIN = 0.5;
const METERS_PER_PIXEL_AT_ZOOM_0 = 156543.03392;
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
// actif ne touche jamais son bord supérieur.
const CAMERA_BOTTOM_SAFETY_MARGIN = 24;
const FIT_BOUNDS_DURATION = 500;
const EASE_TO_DURATION = 300;
const HEADER_ARROW_SIZE = 52;
const HEADER_ICON_SIZE = 24;

type Bounds = [west: number, south: number, east: number, north: number];

// null si 0/1 commande ou si toutes les commandes partagent exactement les
// mêmes coordonnées — fitBounds sur des bounds dégénérées produit un
// comportement caméra indéfini selon la plateforme.
function computeBounds(orders: DriverOrder[]): Bounds | null {
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

type CameraPadding = { top: number; right: number; bottom: number; left: number };

// `fitBounds` délègue le calcul du zoom au SDK natif. Pour une paire de points
// très proche, ce calcul a été observé comme un no-op sur device, alors que le
// fit global (bounds beaucoup plus grands) fonctionne. On calcule donc ici une
// caméra explicite, stable et bornée par les mêmes min/max zoom que <Camera>.
function computeOrderCamera(order: DriverOrder, viewportWidth: number, viewportHeight: number, padding: CameraPadding) {
  const center: [number, number] = [
    (order.pickupLng + order.deliveryLng) / 2,
    (order.pickupLat + order.deliveryLat) / 2
  ];
  const latitudeRadians = (center[1] * Math.PI) / 180;
  const metersPerLongitudeDegree = 111_320 * Math.cos(latitudeRadians);
  const horizontalDistance = Math.abs(order.deliveryLng - order.pickupLng) * metersPerLongitudeDegree;
  const verticalDistance = Math.abs(order.deliveryLat - order.pickupLat) * 110_574;
  const availableWidth = Math.max(1, viewportWidth - padding.left - padding.right);
  const availableHeight = Math.max(1, viewportHeight - padding.top - padding.bottom);
  const metersPerPixelAtZoom0 = METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos(latitudeRadians);
  const zoomForWidth = horizontalDistance === 0 ? SINGLE_ORDER_ZOOM : Math.log2((metersPerPixelAtZoom0 * availableWidth) / horizontalDistance);
  const zoomForHeight = verticalDistance === 0 ? SINGLE_ORDER_ZOOM : Math.log2((metersPerPixelAtZoom0 * availableHeight) / verticalDistance);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zoomForWidth, zoomForHeight) - ORDER_ROUTE_ZOOM_MARGIN));

  return { center, zoom };
}

const ACTIVE_STATUSES = new Set(['ASSIGNED', 'COLLECTED', 'RETURNING']);

function buildHeaderLabel(count: number): string {
  if (count === 0) return 'Aucune course en cours';
  const noun = count === 1 ? 'course en cours' : 'courses en cours';
  return `${count} ${noun}`;
}

export default function MyOrdersMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [orders, setOrders] = useState<DriverOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [cardHeight, setCardHeight] = useState(0);
  // Tracés préchargés pour toutes les commandes visibles, indexés par
  // orderId — pas un seul état pour "la commande sélectionnée", pour que
  // changer de card dans le carrousel soit instantané (simple lecture du
  // cache) plutôt que d'attendre un aller-retour OSRM à chaque swipe.
  const [routeGeometryByOrderId, setRouteGeometryByOrderId] = useState<Record<string, OrderRouteGeometry>>({});
  const listRef = useRef<FlatList<DriverOrder>>(null);
  const cameraRef = useRef<CameraRef>(null);
  // Conserver cette position dans la séquence des hooks : elle existe depuis
  // l'écran Carte initial et évite un désalignement lors du Fast Refresh.
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
      const { orders: myOrders } = await api.getMyOrders();
      setOrders(myOrders.filter((order) => ACTIVE_STATUSES.has(order.status)));
      syncLocationTrackingProfile(myOrders);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger vos courses en cours.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  // Recale la sélection si la liste se réduit (livraison terminée pendant
  // que la dernière card du carrousel est affichée).
  useEffect(() => {
    if (orders !== null && selectedIndex >= orders.length) {
      setSelectedIndex(Math.max(0, orders.length - 1));
    }
  }, [orders, selectedIndex]);

  // Précharge le tracé pickup → livraison de TOUTES les commandes visibles
  // dès que la liste change (pas seulement celle sélectionnée). Best-effort
  // par commande : l'échec d'un tracé (OSRM indisponible, réseau) n'empêche
  // pas les autres de se charger, laisse juste cette commande sans tracé.
  useEffect(() => {
    if (visibleOrders.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(
      visibleOrders.map(async (order) => {
        const { geometry } = await api.getOrderRoute(order.id);
        return [order.id, geometry] as const;
      })
    ).then((results) => {
      if (cancelled) return;
      const loaded = Object.fromEntries(
        results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      );
      setRouteGeometryByOrderId((current) => ({ ...current, ...loaded }));
    });
    return () => {
      cancelled = true;
    };
    // orders (pas visibleOrders) est la dépendance stable — même raison que
    // les effets caméra ci-dessous.
  }, [orders]);

  const selectedRouteGeometry = visibleOrders[selectedIndex] !== undefined
    ? (routeGeometryByOrderId[visibleOrders[selectedIndex]!.id] ?? null)
    : null;

  // Cas rare mais possible : une de mes courses repasse disponible puis est
  // reprise par un autre livreur pendant que je suis sur cet onglet —
  // order_taken porte alors un driverId différent du mien, il faut la
  // retirer de ma liste (même garde que app/(tabs)/orders/index.tsx). On
  // ignore l'event si driverId === mon id, mon propre flow accept/collect/
  // complete recharge déjà via le focus effect ci-dessus.
  useEffect(() => {
    let cancelled = false;
    let activeSocket: Socket | null = null;
    let myDriverId: string | null = null;

    function handleOrderTaken(payload: { orderId?: string; driverId?: string }) {
      if (typeof payload.orderId !== 'string' || payload.driverId === myDriverId) return;
      const takenId = payload.orderId;
      setOrders((current) => (current === null ? current : current.filter((order) => order.id !== takenId)));
    }

    async function setup() {
      const [{ data: sessionData }, profile] = await Promise.all([supabase.auth.getSession(), api.getMyDriverProfile()]);
      const token = sessionData.session?.access_token;
      myDriverId = sessionData.session?.user.id ?? null;
      if (token === undefined || cancelled) return;
      activeSocket = getSocket(profile.zoneId, token);
      activeSocket.on('order_taken', handleOrderTaken);
    }

    void setup().catch(() => {
      // Le chargement de l'écran possède déjà son propre état d'erreur. Une
      // indisponibilité API ponctuelle ne doit pas remonter comme promesse non
      // gérée depuis le branchement socket.
    });

    return () => {
      cancelled = true;
      activeSocket?.off('order_taken', handleOrderTaken);
    };
  }, []);

  // Recalculée seulement quand ses entrées primitives changent (pas un objet
  // recréé à chaque rendu) — utilisée comme dépendance d'effet ci-dessous.
  //
  // Ne PAS ajouter TAB_BAR_HEIGHT/insets.bottom ici : le Tab Navigator
  // (BottomTabView d'expo-router) place la tab bar en flux normal, sibling
  // de la zone d'écrans (flex: 1) — le bas de cet écran correspond déjà au
  // haut de la tab bar, cet espace est déjà exclu, l'ajouter ici le
  // compterait une deuxième fois.
  const cameraPadding = useMemo(
    () => ({
      top: insets.top + CAMERA_TOP_MARGIN,
      left: CAMERA_SIDE_MARGIN,
      right: CAMERA_SIDE_MARGIN,
      bottom: cardHeight + CAMERA_BOTTOM_SAFETY_MARGIN
    }),
    [insets.top, cardHeight]
  );
  // Miroir de cameraPadding lu par le cadrage global ci-dessous SANS être une
  // dépendance de son effet — cardHeight (donc cameraPadding) change à
  // chaque commande sélectionnée (texte de card différent), ce qui
  // redéclenchait ce cadrage global et écrasait le cadrage pickup+livraison
  // de la sélection fait par l'effet suivant.
  const cameraPaddingRef = useRef(cameraPadding);
  cameraPaddingRef.current = cameraPadding;

  // Cadrage global : se déclenche au chargement de la carte et à chaque
  // changement réel de la liste de commandes — jamais sur un simple
  // changement de sélection dans le carrousel (voir l'effet suivant), ni sur
  // un changement de padding seul (voir cameraPaddingRef ci-dessus).
  useEffect(() => {
    canFollowSelectionRef.current = false;
    if (!mapReady) return;

    const padding = cameraPaddingRef.current;
    const bounds = computeBounds(visibleOrders);
    if (bounds !== null) {
      cameraRef.current?.fitBounds(bounds, { padding, duration: FIT_BOUNDS_DURATION });
      canFollowSelectionRef.current = true;
    } else if (visibleOrders.length === 1) {
      const [only] = visibleOrders;
      const camera = computeOrderCamera(only!, width, height, padding);
      cameraRef.current?.easeTo({ ...camera, padding, duration: FIT_BOUNDS_DURATION });
      canFollowSelectionRef.current = true;
    }
    // visibleOrders est dérivé de `orders` à chaque rendu (pas de useMemo) —
    // orders est la dépendance stable à surveiller, pas visibleOrders.
  }, [mapReady, orders, width, height]);

  // Suit la sélection du carrousel (swipe, flèche ou tap marqueur) en
  // gardant le même padding, pour que le marqueur actif reste toujours
  // dégagé au-dessus de la card flottante. Ignoré tant que le cadrage
  // global de la liste courante n'a pas eu lieu (effet précédent).
  useEffect(() => {
    if (!canFollowSelectionRef.current) return;
    const order = visibleOrders[selectedIndex];
    if (order === undefined) return;
    const camera = computeOrderCamera(order, width, height, cameraPadding);
    cameraRef.current?.easeTo({ ...camera, padding: cameraPadding, duration: EASE_TO_DURATION });
  }, [selectedIndex, cameraPadding, width, height]);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0];
    if (first?.index !== null && first?.index !== undefined) {
      setSelectedIndex(first.index);
    }
  }).current;

  // Point d'entrée unique pour tout ce qui doit déplacer le carrousel vers
  // un index donné — swipe (via onViewableItemsChanged ci-dessus), tap sur
  // un marqueur, ou tap sur une flèche du header.
  function moveToIndex(index: number) {
    if (index < 0 || index >= visibleOrders.length) return;
    setSelectedIndex(index);
    listRef.current?.scrollToIndex({ index, animated: true });
  }

  function selectOrder(orderId: string) {
    moveToIndex(visibleOrders.findIndex((order) => order.id === orderId));
  }

  function openDetail(order: DriverOrder) {
    router.push({ pathname: '/order/[id]', params: { id: order.id, order: JSON.stringify(order) } });
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
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          maxBounds={[5.10, 46.10, 5.40, 46.32]}
        />
        {selectedRouteGeometry !== null && (
          <GeoJSONSource id="order-route-source" data={{ type: 'Feature', properties: {}, geometry: selectedRouteGeometry }}>
            <Layer
              id="order-route-line"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': BLUE_500, 'line-width': 3, 'line-opacity': 0.8 }}
            />
          </GeoJSONSource>
        )}
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
        {/* Point de livraison affiché uniquement pour la commande sélectionnée
            dans le carrousel — l'afficher pour toutes les commandes en même
            temps surchargerait la carte quand plusieurs sont en cours. */}
        {visibleOrders[selectedIndex] !== undefined && (
          <Marker
            key={`delivery-${visibleOrders[selectedIndex]!.id}`}
            id={`delivery-${visibleOrders[selectedIndex]!.id}`}
            lngLat={[visibleOrders[selectedIndex]!.deliveryLng, visibleOrders[selectedIndex]!.deliveryLat]}
          >
            <View style={styles.markerHitArea}>
              <View style={styles.deliveryMarker} />
            </View>
          </Marker>
        )}
      </Map>

      {/* Bloc blanc unifié : safe area top + header navigation, un seul
          conteneur continu au-dessus de la carte. */}
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

      {/* Card flottante sur la carte, au-dessus du tab bar. Pas de
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
        {visibleOrders.length === 0 ? (
          <View className="w-[90%] self-center rounded-2xl border border-border bg-surface p-3 shadow-sm">
            <View className="items-center gap-1">
              <MapPin size={20} color={EMERALD_600} />
              <Text className="text-center font-sans-semibold text-sm text-stone-800">Aucune course en cours</Text>
              <Text className="text-center font-sans text-sm text-stone-500">
                {available
                  ? 'Restez disponible pour recevoir une proposition de course'
                  : 'Mettez-vous disponible pour recevoir des commandes'}
              </Text>
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
                  <OrderCard order={item} merchantName={item.merchantName} truncateAddresses onPress={() => openDetail(item)} />
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
  },
  deliveryMarker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    backgroundColor: BLUE_500,
    opacity: 0.7,
    borderWidth: 3,
    borderColor: WHITE
  }
});
