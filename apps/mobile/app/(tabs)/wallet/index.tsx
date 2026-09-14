import { useFocusEffect } from 'expo-router';
import { Info } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EarningRow } from '../../../components/earning-row';
import { EmptyState, ErrorState, LoadingState } from '../../../components/list-state';
import { api, ApiError } from '../../../lib/api';
import { EMERALD_600 } from '../../../lib/colors';
import { formatPriceEuros } from '../../../lib/format';
import type { DriverEarnings } from '../../../lib/wallet-types';

export default function WalletScreen() {
  const [earnings, setEarnings] = useState<DriverEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setIsRefreshing(true);
    setError(null);
    try {
      const result = await api.getMyEarnings();
      setEarnings(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger vos gains.');
    } finally {
      if (isRefresh) setIsRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load])
  );

  if (earnings === null && error === null) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  if (error !== null && earnings === null) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <ErrorState message={error} onRetry={() => void load(false)} />
      </SafeAreaView>
    );
  }

  const data = earnings as DriverEarnings;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <FlatList
        data={data.recentCompletedOrders}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ flexGrow: 1, gap: 12, paddingHorizontal: 16, paddingVertical: 16 }}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={EMERALD_600} />
        }
        ListHeaderComponent={
          <View className="mb-6 gap-4">
            <View className="flex-row items-center gap-2 self-start rounded-full bg-status-pending-bg px-3 py-1.5">
              <Info size={16} color="#92400E" />
              <Text className="font-sans-semibold text-body-lg text-status-pending-text">
                Gains provisoires — paiement par virement
              </Text>
            </View>

            <View className="items-center gap-1 rounded-2xl border border-border bg-surface p-6">
              <Text className="font-sans text-body-lg text-stone-500">Total gagné</Text>
              <Text className="font-sans-bold text-display text-primary-700">
                {formatPriceEuros(data.totalEarningCents)}
              </Text>
              <Text className="font-sans text-body-lg text-stone-400">
                {data.completedOrderCount} course{data.completedOrderCount > 1 ? 's' : ''} terminée
                {data.completedOrderCount > 1 ? 's' : ''}
              </Text>
            </View>

            {data.recentCompletedOrders.length > 0 && (
              <Text className="font-sans-semibold text-body-lg text-stone-600">Dernières courses</Text>
            )}
          </View>
        }
        ListEmptyComponent={<EmptyState message="Aucun gain pour l'instant" />}
        renderItem={({ item }) => <EarningRow earning={item} />}
      />
    </SafeAreaView>
  );
}
