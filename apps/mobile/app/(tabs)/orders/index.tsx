import { useFocusEffect, useRouter } from 'expo-router';
import { Bike, CircleX, PackageCheck, Undo2 } from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Socket } from 'socket.io-client';
import { EmptyState, ErrorState, LoadingState } from '../../../components/list-state';
import { OrderCard } from '../../../components/order-card';
import { api, ApiError } from '../../../lib/api';
import { EMERALD_600, WHITE } from '../../../lib/colors';
import { formatPriceEuros } from '../../../lib/format';
import type { DriverHistoryOrder, DriverOrder } from '../../../lib/orders-types';
import { getSocket } from '../../../lib/socket';
import { supabase } from '../../../lib/supabase';
import { showToast } from '../../../lib/toast';

type OrdersTab = 'active' | 'history';

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
  const [displayedTab, setDisplayedTab] = useState<OrdersTab>('active');
  const [isTabSwitching, setIsTabSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setIsRefreshing(true);
    setError(null);
    try {
      const [{ orders: myOrders }, { orders: history }] = await Promise.all([api.getMyOrders(), api.getMyOrderHistory()]);
      setActiveOrders(myOrders);
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

    void setup();

    return () => {
      cancelled = true;
      activeSocket?.off('order_taken', handleOrderTaken);
    };
  }, []);

  // Deux frames laissent le temps au loader d'être peint avant le montage des
  // cards de l'autre onglet, qui peut être coûteux sur certains appareils.
  useEffect(() => {
    if (!isTabSwitching) return;

    let secondFrame: ReturnType<typeof requestAnimationFrame> | null = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        setDisplayedTab(activeTab);
        setIsTabSwitching(false);
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [activeTab, isTabSwitching]);

  function switchTab(tab: OrdersTab) {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setIsTabSwitching(true);
  }

  async function handleCollect(order: DriverOrder) {
    setSubmittingId(order.id);
    try {
      await api.collectOrder(order.id, order.version);
      showToast('Collecte confirmée ✓');
      await load(false);
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message);
    } finally {
      setSubmittingId(null);
    }
  }

  function handleComplete(order: DriverOrder) {
    router.push({
      pathname: '/order/[id]/proof',
      params: { id: order.id, version: String(order.version) }
    });
  }

  function openDetail(order: DriverOrder) {
    router.push({
      pathname: '/order/[id]',
      params: { id: order.id, order: JSON.stringify(order) }
    });
  }

  async function handleConfirmReturn(order: DriverOrder) {
    setSubmittingId(order.id);
    try {
      await api.confirmReturn(order.id, order.version);
      showToast('Retour confirmé ✓');
      await load(false);
    } catch (err) {
      if (err instanceof ApiError) showToast(err.message);
    } finally {
      setSubmittingId(null);
    }
  }

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

  const isHistory = activeTab === 'history';
  const displayedOrders = displayedTab === 'history' ? historyOrders ?? [] : activeOrders ?? [];

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <FlatList
        data={isTabSwitching ? [] : displayedOrders}
        keyExtractor={(order) => order.id}
        contentContainerStyle={{ flexGrow: 1, gap: 12, paddingHorizontal: 16, paddingVertical: 16 }}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={EMERALD_600} />
        }
        ListHeaderComponent={
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
        }
        ListEmptyComponent={
          isTabSwitching ? (
            <View className="items-center py-12">
              <ActivityIndicator size="large" color={EMERALD_600} />
            </View>
          ) : (
            <EmptyState message={isHistory ? 'Aucune course dans votre historique' : 'Aucune course en cours'} />
          )
        }
        renderItem={({ item }) => {
          const isSubmitting = submittingId === item.id;
          let footer: ReactNode;
          if (isHistory) {
            const historyOrder = item as DriverHistoryOrder;
            footer = (
              <View className="border-t border-border pt-3">
                <Text className="text-center font-sans-semibold text-body-lg text-primary-700">
                  Gains : {formatPriceEuros(historyOrder.driverEarningCents)}
                </Text>
              </View>
            );
          } else if (item.status === 'ASSIGNED') {
            footer = (
              <Pressable
                onPress={() => void handleCollect(item)}
                disabled={isSubmitting}
                className="h-touch-comfortable flex-row items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <ActivityIndicator color={WHITE} />
                ) : (
                  <Text className="font-sans-bold text-body-lg text-white">J&apos;ai collecté le colis</Text>
                )}
              </Pressable>
            );
          } else if (item.status === 'COLLECTED') {
            footer = (
              <Pressable
                onPress={() => handleComplete(item)}
                className="h-touch-comfortable flex-row items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700"
              >
                <Text className="font-sans-bold text-body-lg text-white">Livraison effectuée</Text>
              </Pressable>
            );
          } else if (item.status === 'RETURNING') {
            footer = (
              <Pressable
                onPress={() => void handleConfirmReturn(item)}
                disabled={isSubmitting}
                className="h-touch-comfortable flex-row items-center justify-center rounded-lg bg-red-600 active:bg-red-700 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <ActivityIndicator color={WHITE} />
                ) : (
                  <Text className="font-sans-bold text-body-lg text-white">J&apos;ai retourné le colis</Text>
                )}
              </Pressable>
            );
          }
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
