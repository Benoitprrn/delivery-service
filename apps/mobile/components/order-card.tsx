import { Clock, Euro, MapPin, Route, Store } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatDistanceKm, formatDurationMin, formatPickupLabel, formatPriceEuros } from '../lib/format';
import { BLUE_500, EMERALD_600, STONE_500 } from '../lib/colors';
import type { DriverOrder, Order } from '../lib/orders-types';

type OrderCardProps = {
  order: Order | DriverOrder;
  merchantName?: string;
  showOrderNumber?: boolean;
  statusBadge?: ReactNode;
  footer?: ReactNode;
  onPress?: () => void;
  // Nécessaire dans un conteneur à hauteur fixe (carrousel de la carte) où
  // une adresse longue sur 2 lignes ferait déborder la card — pas activé
  // par défaut pour garder les adresses complètes dans "Mes courses" (liste
  // verticale, pas de contrainte de hauteur).
  truncateAddresses?: boolean;
};

export function OrderCard({
  order,
  merchantName,
  showOrderNumber = false,
  statusBadge,
  footer,
  onPress,
  truncateAddresses = false
}: OrderCardProps) {
  const content = (
    <View className="gap-3 p-3">
      {(statusBadge !== undefined || showOrderNumber) && (
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1">{statusBadge}</View>
          {showOrderNumber && (
            <Text className="font-sans text-body-lg text-stone-400">#{order.id.slice(-6)}</Text>
          )}
        </View>
      )}

      <View className="flex-row items-center justify-between gap-2">
        {merchantName !== undefined ? (
          <View className="flex-1 flex-row items-center gap-2">
              <Store size={18} color={EMERALD_600} />
              <Text className="flex-1 font-sans-semibold text-sm text-stone-800">{merchantName}</Text>
          </View>
        ) : <View className="flex-1" />}
        <View className="flex-row items-center gap-1.5">
          <Clock size={16} color={BLUE_500} />
          <Text className="font-sans-semibold text-sm text-stone-700">{formatPickupLabel(order.pickupScheduledAt, order.createdAt)}</Text>
        </View>
      </View>

      <View className="gap-1">
        <View className="flex-row items-start gap-2">
          <MapPin size={18} color={EMERALD_600} className="mt-0.5" />
          <Text
            className="flex-1 font-sans text-sm text-stone-800"
            numberOfLines={truncateAddresses ? 1 : undefined}
            ellipsizeMode={truncateAddresses ? 'tail' : undefined}
          >
            {order.pickupAddress}
          </Text>
        </View>
        <View className="flex-row items-start gap-2">
          <MapPin size={18} color={STONE_500} className="mt-0.5" />
          <Text
            className="flex-1 font-sans text-sm text-stone-800"
            numberOfLines={truncateAddresses ? 1 : undefined}
            ellipsizeMode={truncateAddresses ? 'tail' : undefined}
          >
            {order.deliveryAddress}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap items-center gap-4 border-t border-border pt-3">
        <View className="flex-row items-center gap-1.5">
          <Route size={16} color={STONE_500} />
          <Text className="font-sans text-sm text-stone-500">{formatDistanceKm(order.distanceM)}</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <Clock size={16} color={STONE_500} />
          <Text className="font-sans text-sm text-stone-500">{formatDurationMin(order.durationS)}</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <Euro size={16} color={EMERALD_600} />
          <Text className="font-sans-semibold text-sm text-primary-700">{formatPriceEuros(order.priceCents)}</Text>
        </View>
      </View>

    </View>
  );

  return (
    <View className="rounded-2xl border border-border bg-surface shadow-sm">
      {onPress === undefined ? content : (
        <Pressable onPress={onPress} className="active:opacity-80">
          {content}
        </Pressable>
      )}
      {footer !== undefined && <View className="px-4 pb-4 pt-3">{footer}</View>}
    </View>
  );
}
