import { ChevronDown, MapPin, Phone, Store, UserRound } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EMERALD_600, STONE_500 } from '../lib/colors';

// Blocs partagés entre l'écran « nouvelle offre » (dispatch-offer) et l'écran détail d'une
// commande déjà acceptée (order/[id]) : un seul design pour toute la vie d'une commande,
// de sa réception à sa livraison.

export function DetailsSection({
  title,
  icon,
  expanded,
  onToggle,
  children
}: {
  title: string;
  icon: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-surface">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="min-h-touch-comfortable flex-row items-center gap-3 px-4 active:bg-stone-50"
      >
        {icon}
        <Text className="flex-1 font-sans-bold text-body-lg text-stone-800">{title}</Text>
        <ChevronDown size={22} color={STONE_500} style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
      </Pressable>
      {expanded && <View className="gap-3 border-t border-border p-4">{children}</View>}
    </View>
  );
}

export function PickupDeliverySummary({ pickupLabel, deliveryLabel }: { pickupLabel: string; deliveryLabel: string }) {
  return (
    <View className="flex-row rounded-2xl bg-primary-50 p-4">
      <View className="flex-1 gap-1">
        <Text className="font-sans-semibold text-body text-primary-700">Collecte</Text>
        <Text className="font-sans-bold text-h2 text-primary-800">{pickupLabel}</Text>
      </View>
      <View className="flex-1 gap-1 border-l border-primary-200 pl-4">
        <Text className="font-sans-semibold text-body text-primary-700">Livraison</Text>
        <Text className="font-sans-bold text-h2 text-primary-800">{deliveryLabel}</Text>
      </View>
    </View>
  );
}

export function SenderCard({
  merchantName,
  merchantPhone,
  pickupAddress,
  onOpenPhone,
  onOpenMaps
}: {
  merchantName: string;
  merchantPhone: string | null;
  pickupAddress: string;
  onOpenPhone: (phone: string) => void;
  onOpenMaps: () => void;
}) {
  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-2">
        <Store size={20} color={EMERALD_600} />
        <Text className="font-sans-bold text-h3 text-stone-800">Expéditeur</Text>
      </View>
      <View className="gap-1">
        <Text className="font-sans-semibold text-body text-stone-500">Nom</Text>
        <Text className="font-sans text-body-lg text-stone-800">{merchantName}</Text>
      </View>
      {merchantPhone !== null && merchantPhone.trim().length > 0 && (
        <Pressable onPress={() => onOpenPhone(merchantPhone)} className="min-h-touch-comfortable gap-1">
          <Text className="font-sans-semibold text-body text-stone-500">Téléphone</Text>
          <View className="flex-row items-center gap-2">
            <Phone size={19} color={EMERALD_600} />
            <Text className="font-sans-semibold text-body-lg text-primary-700">{merchantPhone}</Text>
          </View>
        </Pressable>
      )}
      <Pressable onPress={onOpenMaps} className="min-h-touch-comfortable gap-1">
        <Text className="font-sans-semibold text-body text-stone-500">Adresse</Text>
        <View className="flex-row items-start gap-2">
          <MapPin size={19} color={EMERALD_600} />
          <Text className="flex-1 font-sans-semibold text-body-lg text-primary-700">{pickupAddress}</Text>
        </View>
      </Pressable>
    </View>
  );
}

export function RecipientCard({
  masked,
  customerName,
  customerPhone,
  deliveryAddress,
  deliveryAddressComplement,
  onOpenPhone,
  onOpenMaps
}: {
  // Nom/téléphone restent masqués tant que le colis n'est pas en main (avant COLLECTED) —
  // seule l'adresse est utile plus tôt, pour juger la course avant/juste après acceptation.
  masked: boolean;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string;
  deliveryAddressComplement: string | null;
  onOpenPhone: (phone: string) => void;
  onOpenMaps: () => void;
}) {
  return (
    <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-2">
        <UserRound size={20} color={STONE_500} />
        <Text className="font-sans-bold text-h3 text-stone-800">Destinataire</Text>
      </View>
      <View className="gap-1">
        <Text className="font-sans-semibold text-body text-stone-500">Nom</Text>
        <Text className="font-sans text-body-lg text-stone-800">
          {masked ? '**********' : customerName !== null && customerName.trim().length > 0 ? customerName : '—'}
        </Text>
      </View>
      <View className="gap-1">
        <Text className="font-sans-semibold text-body text-stone-500">Téléphone</Text>
        {masked || customerPhone === null || customerPhone.trim().length === 0 ? (
          <Text className="font-sans text-body-lg text-stone-800">**********</Text>
        ) : (
          <Pressable onPress={() => onOpenPhone(customerPhone)} className="min-h-touch-comfortable flex-row items-center gap-2">
            <Phone size={19} color={STONE_500} />
            <Text className="font-sans-semibold text-body-lg text-primary-700">{customerPhone}</Text>
          </Pressable>
        )}
      </View>
      <Pressable onPress={onOpenMaps} className="min-h-touch-comfortable gap-1">
        <Text className="font-sans-semibold text-body text-stone-500">Adresse</Text>
        <View className="flex-row items-start gap-2">
          <MapPin size={19} color={STONE_500} />
          <View className="flex-1 gap-1">
            <Text className="font-sans-semibold text-body-lg text-primary-700">{deliveryAddress}</Text>
            {deliveryAddressComplement !== null && deliveryAddressComplement.trim().length > 0 && (
              <Text className="font-sans text-body text-stone-600">{deliveryAddressComplement}</Text>
            )}
          </View>
        </View>
      </Pressable>
    </View>
  );
}
