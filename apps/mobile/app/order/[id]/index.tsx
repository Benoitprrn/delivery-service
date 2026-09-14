import { useLocalSearchParams, useRouter } from 'expo-router';
import { Bike, CalendarDays, CircleX, Clock, Euro, MapPin, PackageCheck, Phone, Route, Store, Undo2, X } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SliderButton } from '../../../components/SliderButton';
import { api } from '../../../lib/api';
import { EMERALD_600, STONE_500 } from '../../../lib/colors';
import {
  formatDistanceKm,
  formatDurationMin,
  formatEstimatedDelivery,
  formatFullDate,
  formatPickupLabel,
  formatPriceEuros
} from '../../../lib/format';
import { openMaps, openPhone } from '../../../lib/native-links';
import type { DriverOrder, OrderStatus } from '../../../lib/orders-types';
import { showToast } from '../../../lib/toast';

const RECIPIENT_VISIBLE_STATUSES = new Set(['COLLECTED', 'RETURNING', 'RETURNED', 'COMPLETED']);

function StatusBadge({ status }: { status: OrderStatus }) {
  if (status === 'ASSIGNED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-assigned-bg px-3 py-1.5">
        <Bike size={16} color="#1D4ED8" />
        <Text className="font-sans-semibold text-body-lg text-status-assigned-text">En route vers collecte</Text>
      </View>
    );
  }
  if (status === 'COLLECTED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-active-bg px-3 py-1.5">
        <PackageCheck size={16} color="#FFFFFF" />
        <Text className="font-sans-semibold text-body-lg text-status-active-text">Colis récupéré</Text>
      </View>
    );
  }
  if (status === 'RETURNING' || status === 'RETURNED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-return-bg px-3 py-1.5">
        <Undo2 size={16} color="#C2410C" />
        <Text className="font-sans-semibold text-body-lg text-status-return-text">
          {status === 'RETURNING' ? 'Retour en cours' : 'Retourné'}
        </Text>
      </View>
    );
  }
  if (status === 'COMPLETED') {
    return (
      <View className="flex-row items-center gap-1.5 self-start rounded-full bg-status-delivered-bg px-3 py-1.5">
        <PackageCheck size={16} color="#059669" />
        <Text className="font-sans-semibold text-body-lg text-status-delivered-text">Livrée</Text>
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
    <View className="self-start rounded-full bg-status-pending-bg px-3 py-1.5">
      <Text className="font-sans-semibold text-body-lg text-status-pending-text">Disponible</Text>
    </View>
  );
}

function parseOrder(raw: string | string[] | undefined): DriverOrder | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as DriverOrder;
  } catch {
    return null;
  }
}

export default function OrderDetailModal() {
  const router = useRouter();
  const { order: orderParam } = useLocalSearchParams<{ id: string; order?: string }>();
  const order = parseOrder(orderParam);

  async function handleAssign() {
    if (order === null) return;
    await api.assignOrder(order.id, order.version);
  }

  function handleSuccess() {
    showToast('Course prise ✓');
    router.back();
  }

  if (order === null) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center gap-4 bg-background px-page-mobile">
        <Text className="text-center font-sans text-body-lg text-stone-500">Détail de la commande indisponible.</Text>
        <Pressable
          onPress={() => router.back()}
          className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700"
        >
          <Text className="font-sans-bold text-body-lg text-white">Retour</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const recipientVisible = RECIPIENT_VISIBLE_STATUSES.has(order.status);
  const estimatedDelivery = formatEstimatedDelivery(order.collectedAt, order.durationS);
  const statusDate = (order.status === 'COMPLETED' || order.status === 'RETURNED') && order.completedAt !== null
    ? order.completedAt
    : order.updatedAt;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-page-mobile py-3">
        <Text className="font-sans text-body-lg text-stone-400">#{order.id.slice(-6)}</Text>
        <Pressable
          accessibilityLabel="Fermer le détail de la commande"
          onPress={() => router.back()}
          className="h-touch-comfortable w-touch-comfortable items-center justify-center"
        >
          <X size={24} color="#57534E" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }}>
        <View className="gap-2">
          <StatusBadge status={order.status} />
          <View className="flex-row items-center gap-2">
            <CalendarDays size={20} color={STONE_500} />
            <Text className="font-sans text-body-lg text-stone-700">{formatFullDate(statusDate)}</Text>
          </View>
        </View>

        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="flex-row items-center gap-2">
            <Store size={20} color={EMERALD_600} />
            <View className="flex-1">
              <Text className="font-sans-semibold text-body-lg text-stone-500">Expéditeur</Text>
              <Text className="font-sans-bold text-h3 text-stone-800">{order.merchantName}</Text>
            </View>
          </View>

          {order.merchantPhone !== null && order.merchantPhone.trim().length > 0 && (
            <Pressable
              accessibilityRole="link"
              onPress={() => void openPhone(order.merchantPhone!)}
              className="min-h-touch-comfortable flex-row items-center gap-2 border-t border-border pt-3 active:opacity-70"
            >
              <Phone size={20} color={EMERALD_600} />
              <Text className="font-sans text-body-lg text-primary-700">{order.merchantPhone}</Text>
            </Pressable>
          )}

          <Pressable
            accessibilityRole="link"
            onPress={() => void openMaps({ latitude: order.pickupLat, longitude: order.pickupLng, label: order.pickupAddress })}
            className="min-h-touch-comfortable flex-row items-start gap-2 border-t border-border pt-3 active:opacity-70"
          >
            <MapPin size={20} color={EMERALD_600} className="mt-0.5" />
            <View className="flex-1">
              <Text className="font-sans-semibold text-body-lg text-stone-500">Adresse de ramassage</Text>
              <Text className="font-sans text-body-lg text-primary-700">{order.pickupAddress}</Text>
            </View>
          </Pressable>

          <View className="flex-row items-center gap-2 border-t border-border pt-3">
            <Clock size={20} color={EMERALD_600} />
            <Text className="font-sans text-body-lg text-stone-800">{formatPickupLabel(order.pickupScheduledAt, order.createdAt)}</Text>
          </View>
        </View>

        {recipientVisible && (
          <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
            {order.customerName !== null && order.customerName.trim().length > 0 && (
              <View className="flex-row items-center gap-2">
                <MapPin size={20} color={STONE_500} />
                <View className="flex-1">
                  <Text className="font-sans-semibold text-body-lg text-stone-500">Destinataire</Text>
                  <Text className="font-sans-bold text-h3 text-stone-800">{order.customerName}</Text>
                </View>
              </View>
            )}

            {order.customerPhone !== null && order.customerPhone.trim().length > 0 && (
              <Pressable
                accessibilityRole="link"
                onPress={() => void openPhone(order.customerPhone!)}
                className="min-h-touch-comfortable flex-row items-center gap-2 border-t border-border pt-3 active:opacity-70"
              >
                <Phone size={20} color={STONE_500} />
                <Text className="font-sans text-body-lg text-primary-700">{order.customerPhone}</Text>
              </Pressable>
            )}

            <Pressable
              accessibilityRole="link"
              onPress={() => void openMaps({ latitude: order.deliveryLat, longitude: order.deliveryLng, label: order.deliveryAddress })}
              className="min-h-touch-comfortable flex-row items-start gap-2 border-t border-border pt-3 active:opacity-70"
            >
              <MapPin size={20} color={STONE_500} className="mt-0.5" />
              <View className="flex-1">
                <Text className="font-sans-semibold text-body-lg text-stone-500">Adresse client</Text>
                <Text className="font-sans text-body-lg text-primary-700">{order.deliveryAddress}</Text>
                {order.deliveryAddressComplement !== null && order.deliveryAddressComplement.trim().length > 0 && (
                  <Text className="font-sans text-body-lg text-stone-500">{order.deliveryAddressComplement}</Text>
                )}
              </View>
            </Pressable>

            {estimatedDelivery !== null && (
              <View className="flex-row items-center gap-2 border-t border-border pt-3">
                <Clock size={20} color={STONE_500} />
                <Text className="font-sans text-body-lg text-stone-800">Livraison estimée {estimatedDelivery}</Text>
              </View>
            )}
          </View>
        )}

        {order.orderDetails !== null && order.orderDetails.trim().length > 0 && (
          <View className="gap-1 rounded-2xl border border-border bg-surface p-4">
            <Text className="font-sans-semibold text-body-lg text-stone-500">Détails commande</Text>
            <Text className="font-sans text-body-lg text-stone-800">{order.orderDetails}</Text>
          </View>
        )}

        {order.deliveryInstructions !== null && order.deliveryInstructions.trim().length > 0 && (
          <View className="gap-1 rounded-2xl border border-border bg-surface p-4">
            <Text className="font-sans-semibold text-body-lg text-stone-500">Commentaire livreur</Text>
            <Text className="font-sans text-body-lg text-stone-800">{order.deliveryInstructions}</Text>
          </View>
        )}

        <View className="flex-row items-center justify-between rounded-2xl border border-border bg-surface p-4">
          <View className="flex-row items-center gap-1.5">
            <Route size={18} color={STONE_500} />
            <Text className="font-sans text-body-lg text-stone-500">{formatDistanceKm(order.distanceM)}</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <Clock size={18} color={STONE_500} />
            <Text className="font-sans text-body-lg text-stone-500">{formatDurationMin(order.durationS)}</Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <Euro size={20} color={EMERALD_600} />
            <Text className="font-sans-bold text-h3 text-primary-700">{formatPriceEuros(order.priceCents)}</Text>
          </View>
        </View>
      </ScrollView>

      {order.status === 'AVAILABLE' && (
        <View className="px-page-mobile pb-6 pt-2">
          <SliderButton label="Glisser pour prendre →" onComplete={handleAssign} onSuccess={handleSuccess} />
        </View>
      )}
    </SafeAreaView>
  );
}
