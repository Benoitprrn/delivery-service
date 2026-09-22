import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { BackHandler, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState, ErrorState, LoadingState } from '../../../components/list-state';
import { PayoutStatusCard } from '../../../components/PayoutStatusCard';
import { api, ApiError } from '../../../lib/api';
import { EMERALD_600, RED_700 } from '../../../lib/colors';
import { formatPriceEuros, formatSettlementDate, formatSettlementPeriod } from '../../../lib/format';
import { openStripeDashboard } from '../../../lib/open-external';
import { usePayoutAccount } from '../../../lib/payout-account-context';
import { derivePayoutUi } from '../../../lib/payout-status';
import type { DriverPeriodView, DriverSettlementsResponse } from '../../../lib/settlements-types';

function Summary({ label, amount, alert = false }: { label: string; amount: number; alert?: boolean }) {
  return <View className="flex-1 gap-1 rounded-xl border border-border bg-surface p-3"><Text className="font-sans text-body text-stone-600">{label}</Text><Text className={`font-sans-bold text-body-lg ${alert ? 'text-red-700' : 'text-stone-800'}`}>{formatPriceEuros(amount)}</Text></View>;
}

export default function WalletScreen() {
  const router = useRouter();
  const { status: payoutStatus } = usePayoutAccount();
  const [settlements, setSettlements] = useState<DriverSettlementsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setIsRefreshing(true);
    setError(null);
    try { setSettlements(await api.getMySettlements()); } catch (err) { setError(err instanceof ApiError ? err.message : 'Impossible de charger vos paiements.'); } finally { if (refresh) setIsRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => {
    void load(false);
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { router.replace('/compte'); return true; });
    return () => subscription.remove();
  }, [load, router]));
  if (settlements === null && error === null) return <SafeAreaView className="flex-1 bg-background" edges={['top']}><LoadingState /></SafeAreaView>;
  if (settlements === null) return <SafeAreaView className="flex-1 bg-background" edges={['top']}><ErrorState message={error ?? 'Impossible de charger vos paiements.'} onRetry={() => void load(false)} /></SafeAreaView>;
  return <SafeAreaView className="flex-1 bg-background" edges={['top']}>
    <View className="flex-row items-center gap-2 px-page-mobile py-3"><Pressable accessibilityLabel="Retour au compte" onPress={() => router.replace('/compte')} className="h-touch-comfortable w-touch-comfortable items-center justify-center"><ChevronLeft size={24} color="#44403C" /></Pressable><Text className="font-sans-bold text-h3 text-stone-800">Mes paiements</Text></View>
    <FlatList<DriverPeriodView> data={settlements.periods} keyExtractor={(item) => item.periodId} contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingBottom: 24 }} refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={EMERALD_600} />}
      ListHeaderComponent={<View className="gap-5 pb-2">
        {settlements.currentWeek !== null && <View className="gap-2 rounded-2xl border border-primary-600/30 bg-primary-50 p-4"><Text className="font-sans-semibold text-body-lg text-stone-700">Semaine en cours (estimation)</Text><Text className="font-sans-bold text-h2 text-primary-700">{formatPriceEuros(settlements.currentWeek.estimatedNetCents)}</Text><Text className="font-sans text-body-lg text-stone-700">{settlements.currentWeek.deliveries} course{settlements.currentWeek.deliveries > 1 ? 's' : ''} · clôture le {formatSettlementDate(settlements.currentWeek.closesAt)}</Text><Text className="font-sans text-body text-stone-500">Estimation, non définitive</Text></View>}
        <View className="gap-2"><Text className="font-sans-bold text-h3 text-stone-800">Résumé</Text><View className="flex-row gap-2"><Summary label="Envoyé" amount={settlements.totals.sentCents} /><Summary label="En attente" amount={settlements.totals.pendingCents} /></View><Summary label="En attente d’un restaurant" amount={settlements.totals.unpaidByRestaurantCents} alert /></View>
        <Text className="font-sans-bold text-h3 text-stone-800">Périodes clôturées</Text>
      </View>}
      ListEmptyComponent={<EmptyState message="Aucune période clôturée pour l’instant." />}
      renderItem={({ item }) => <Pressable accessibilityLabel={`Voir la période ${formatSettlementPeriod(item.periodStart, item.periodEnd)}`} onPress={() => router.push(`/paiements/periode/${item.periodId}`)} className="min-h-touch-comfortable flex-row items-center gap-3 rounded-xl border border-border bg-surface p-4 active:bg-stone-50"><View className="flex-1 gap-1"><View className="flex-row items-center gap-2"><Text className="font-sans-semibold text-body-lg text-stone-800">{formatSettlementPeriod(item.periodStart, item.periodEnd)}</Text>{item.unpaidByRestaurantCents > 0 && <CircleAlert accessibilityLabel="Paiement d’un restaurant en attente" size={20} color={RED_700} />}</View><Text className="font-sans text-body text-stone-600">Total {formatPriceEuros(item.totalCents)} · envoyé {formatPriceEuros(item.sentCents)}</Text><Text className="font-sans text-body text-stone-600">En attente {formatPriceEuros(item.pendingCents)}</Text></View><ChevronRight size={22} color="#78716C" /></Pressable>}
      ListFooterComponent={<View className="gap-3 pt-3"><Text className="font-sans-bold text-h3 text-stone-800">Compte de paiement</Text>{payoutStatus.kind === 'ok' ? <PayoutStatusCard ui={derivePayoutUi(payoutStatus.account)} /> : <Text className="font-sans text-body-lg text-stone-500">{payoutStatus.kind === 'loading' ? 'Chargement de votre compte de paiement…' : payoutStatus.message}</Text>}<Pressable accessibilityLabel="Ouvrir les versements et transactions" onPress={() => router.push('/paiements/versements')} className="h-touch-comfortable items-center justify-center rounded-lg border border-border bg-surface active:opacity-70"><Text className="font-sans-semibold text-body-lg text-primary-700">Versements et transactions</Text></Pressable>{payoutStatus.kind === 'ok' && derivePayoutUi(payoutStatus.account).ready ? <Pressable accessibilityLabel="Ouvrir mon espace Stripe complet" onPress={() => void openStripeDashboard()} className="h-touch-comfortable items-center justify-center rounded-lg border border-border bg-surface active:opacity-70"><Text className="font-sans-semibold text-body-lg text-primary-700">Mon espace Stripe complet</Text></Pressable> : null}</View>}
    />
  </SafeAreaView>;
}
