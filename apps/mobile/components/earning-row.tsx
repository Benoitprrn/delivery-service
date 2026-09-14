import { Text, View } from 'react-native';
import { formatEarningDate, formatPriceEuros } from '../lib/format';
import type { CompletedOrderEarning } from '../lib/wallet-types';

type Props = {
  earning: CompletedOrderEarning;
};

// Plus léger qu'OrderCard, volontairement : un relevé de gains n'a pas
// besoin de badge de statut (toujours COMPLETED) ni d'action (rien à faire
// sur une course déjà terminée) — seulement date, adresse, montant.
export function EarningRow({ earning }: Props) {
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <View className="flex-1 gap-1">
        <Text className="font-sans text-body-lg text-stone-400">{formatEarningDate(earning.completedAt)}</Text>
        <Text className="font-sans text-body-lg text-stone-800" numberOfLines={1}>
          {earning.deliveryAddress}
        </Text>
      </View>
      <Text className="font-sans-bold text-h3 text-primary-700">{formatPriceEuros(earning.earningCents)}</Text>
    </View>
  );
}
