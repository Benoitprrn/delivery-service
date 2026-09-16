import { useFocusEffect, useRouter } from 'expo-router';
import { Bike, CircleX, PackageCheck, Undo2 } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Socket } from 'socket.io-client';
import { EmptyState, ErrorState, LoadingState } from '../../../components/list-state';
import { OrderCard } from '../../../components/order-card';
import { OrderTimeline } from '../../../components/order-timeline';
import { api, ApiError } from '../../../lib/api';
import { syncLocationTrackingProfile } from '../../../lib/location-tracking';
import { EMERALD_600, WHITE } from '../../../lib/colors';
import { formatPriceEuros } from '../../../lib/format';
import type { DriverHistoryOrder, DriverOrder } from '../../../lib/orders-types';
import { getSocket } from '../../../lib/socket';
import { supabase } from '../../../lib/supabase';

type OrdersTab = 'active' | 'history';

function isFromTodayInParis(isoDate: string | null): boolean {
  if (isoDate === null) return false;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return false;

  const dayFormatter = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return dayFormatter.format(date) === dayFormatter.format(new Date());
}

function StatusBadge({ status }: { status: DriverOrder['status'] }) {
  if (status === 'ASSIGNED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-assigned-bg px-3 py-1.5">
        <Bike size={16} color="#1D4ED8" />
        <Text className="font-sans-semibold text-body-lg text-status-assigned-text">En route vers collecte</Text>
      </View>
    );
  }

  // Déviation délibérée du design system Terrain (status.return = orange)
  // Rouge demandé explicitement pour signaler un échec de livraison
  // TODO: harmoniser avec le design system si la palette évolue
  if (status === 'RETURNING') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-red-50 px-3 py-1.5">
        <Undo2 size={16} color="#DC2626" />
        <Text className="font-sans-semibold text-body-lg text-red-600">Retour en cours ↩</Text>
      </View>
    );
  }

  if (status === 'RETURNED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-red-800 px-3 py-1.5">
        <Undo2 size={16} color={WHITE} />
        <Text className="font-sans-semibold text-body-lg text-white">Retourné ✓</Text>
      </View>
    );
  }

  if (status === 'COMPLETED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-delivered-bg px-3 py-1.5">
        <PackageCheck size={16} color="#059669" />
        <Text className="font-sans-semibold text-body-lg text-status-delivered-text">Livrée ✓</Text>
      </View>
    );
  }

  if (status === 'CANCELLED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-cancelled-bg px-3 py-1.5">
        <CircleX size={16} color="#B91C1C" />
        <Text className="font-sans-semibold text-body-lg text-status-cancelled-text">Annulée</Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-1.5 self-start rounded-full bg-primary-600 px-3 py-1.5">
      <PackageCheck size={16} color={WHITE} />
      <Text className="font-sans-semibold text-body-lg text-white">Colis récupéré</Text>
    </View>
  );
}

export default function MyOrdersScreen() {
  const router = useRouter();
  const [activeOrders, setActiveOrders] = useState<DriverOrder[] | null>(null);
  const [historyOrders, setHistoryOrders] = useState<DriverHistoryOrder[] | null>(null);
  const [activeTab, setActiveTab] = useState<OrdersTab>('active');
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [currentNodeY, setCurrentNodeY] = useState<number | null>(null);
  const listRef = useRef<FlatList<DriverHistoryOrder>>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setIsRefreshing(true);
    setError(null);
    try {
      const [{ orders: myOrders }, { orders: history }] = await Promise.all([api.getMyOrders(), api.getMyOrderHistory()]);
      setActiveOrders(myOrders);
      syncLocationTrackingProfile(myOrders);
      setHistoryOrders(
        [...history].sort(
          (first, second) =>
            new Date(second.completedAt ?? second.updatedAt).getTime() - new Date(first.completedAt ?? first.updatedAt).getTime()
        )
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger vos courses.');
    } finally {
      if (isRefresh) setIsRefreshing(false);
    }
  }, []);

  // useFocusEffect couvre le montage initial ET le retour du modal de preuve
  // de livraison (order/[id]/proof) — la commande complétée/retournée doit
  // disparaître de cette liste, et cet écran n'a aucun autre moyen de savoir
  // que son état a changé pendant qu'il n'avait pas le focus (pas de state
  // partagé entre écrans, voir le pattern déjà en place pour drivers/me
  // ci-dessous).
  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load])
  );

  // Cas rare mais possible : une de mes courses ASSIGNED repasse
  // AVAILABLE puis est reprise par un autre livreur pendant que je suis sur
  // cet onglet — order_taken porte alors un driverId différent du mien, il
  // faut la retirer de ma liste. On ignore l'event si driverId === mon id
  // (c'est moi, mon propre flow assign/collect/complete met déjà à jour).
  useEffect(() => {
    let cancelled = false;
    let activeSocket: Socket | null = null;
    let myDriverId: string | null = null;

    function handleOrderTaken(payload: { orderId?: string; driverId?: string }) {
      if (typeof payload.orderId !== 'string' || payload.driverId === myDriverId) return;
      const takenId = payload.orderId;
      setActiveOrders((current) => (current === null ? current : current.filter((order) => order.id !== takenId)));
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
      // La liste gère déjà ses erreurs de chargement ; éviter une promesse
      // socket non gérée lorsque l'API est momentanément indisponible.
    });

    return () => {
      cancelled = true;
      activeSocket?.off('order_taken', handleOrderTaken);
    };
  }, []);

  function switchTab(tab: OrdersTab) {
    if (tab === activeTab) return;
    setActiveTab(tab);
  }

  function openDetail(order: DriverOrder) {
    router.push({
      pathname: '/order/[id]',
      params: { id: order.id, order: JSON.stringify(order) }
    });
  }

  const isHistory = activeTab === 'history';
  const displayedOrders = isHistory ? historyOrders ?? [] : [];
  // L'API des courses actives exclut volontairement COMPLETED/RETURNED/
  // CANCELLED. On les réintègre ici uniquement lorsqu'elles ont été closes
  // aujourd'hui, afin que la timeline raconte toute la journée du livreur.
  // Une mise en indisponibilité reste sans effet : elle peut n'être qu'une
  // pause et ne doit pas effacer le contexte de la tournée.
  const todayFinishedOrders = (historyOrders ?? []).filter((order) => isFromTodayInParis(order.completedAt ?? order.updatedAt));
  const timelineOrders: DriverOrder[] = [...(activeOrders ?? []), ...todayFinishedOrders];

  // Cet effet doit rester avant les retours de chargement ci-dessous : React
  // doit exécuter les mêmes hooks au premier rendu et après les réponses API.
  useEffect(() => {
    if (isHistory || currentNodeY === null) return;
    const frame = requestAnimationFrame(() => {
      // Le header est sticky : ne pas inclure sa hauteur dans l'offset, sinon
      // il recouvrirait le nœud cible. À cet offset, le nœud arrive juste sous
      // les toggles fixes.
      listRef.current?.scrollToOffset({ offset: Math.max(0, currentNodeY - 8), animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeOrders, historyOrders, isHistory, currentNodeY]);

  if ((activeOrders === null || historyOrders === null) && error === null) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  if (error !== null && (activeOrders === null || historyOrders === null)) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <ErrorState message={error} onRetry={() => void load(false)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <FlatList
        ref={listRef}
        data={displayedOrders}
        keyExtractor={(order) => order.id}
        stickyHeaderIndices={[0]}
        contentContainerStyle={{ flexGrow: 1, gap: 12, paddingHorizontal: 16, paddingVertical: 16 }}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={EMERALD_600} />
        }
        ListHeaderComponent={
          <View className="bg-background pb-3">
            <View className="flex-row rounded-xl border border-border bg-surface p-1">
              <Pressable
                onPress={() => switchTab('active')}
                className={`h-touch-comfortable flex-1 items-center justify-center rounded-lg ${!isHistory ? 'bg-primary-600' : ''}`}
              >
                <Text className={`font-sans-semibold text-body-lg ${!isHistory ? 'text-white' : 'text-stone-700'}`}>
                  En cours ({activeOrders?.length ?? 0})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => switchTab('history')}
                className={`h-touch-comfortable flex-1 items-center justify-center rounded-lg ${isHistory ? 'bg-primary-600' : ''}`}
              >
                <Text className={`font-sans-semibold text-body-lg ${isHistory ? 'text-white' : 'text-stone-700'}`}>
                  Historique ({historyOrders?.length ?? 0})
                </Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={
          isHistory ? (
            <EmptyState message={isHistory ? 'Aucune course dans votre historique' : 'Aucune course en cours'} />
          ) : timelineOrders.length > 0 ? (
            <OrderTimeline orders={timelineOrders} onPressOrder={openDetail} onCurrentNodeLayout={setCurrentNodeY} />
          ) : (
            <EmptyState message="Aucune course en cours" />
          )
        }
        renderItem={({ item }) => {
          const historyOrder = item as DriverHistoryOrder;
          const footer: ReactNode = (
            <View className="border-t border-border pt-3">
              <Text className="text-center font-sans-semibold text-body-lg text-primary-700">
                Gains : {formatPriceEuros(historyOrder.driverEarningCents)}
              </Text>
            </View>
          );
          return (
            <OrderCard
              order={item}
              merchantName={item.merchantName}
              statusBadge={<StatusBadge status={item.status} />}
              footer={footer}
              onPress={() => openDetail(item)}
            />
          );
        }}
      />
    </SafeAreaView>
  );
}
