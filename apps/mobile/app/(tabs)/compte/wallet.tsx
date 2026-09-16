import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft, ChevronUp, Info } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { BackHandler, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState, ErrorState, LoadingState } from '../../../components/list-state';
import { api, ApiError } from '../../../lib/api';
import { EMERALD_600 } from '../../../lib/colors';
import { formatWeekRange, getIsoWeekStart, getWeeklyEarnings } from '../../../lib/earnings';
import { formatPriceEuros } from '../../../lib/format';
import { showToast } from '../../../lib/toast';
import type { CompletedOrderEarning, DriverEarnings } from '../../../lib/wallet-types';

const DAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

type DayEarnings = {
  date: Date;
  totalCents: number;
  completedOrderCount: number;
};

function parisCalendarDate(isoDate: string): Date | null {
  const source = new Date(isoDate);
  if (Number.isNaN(source.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(source);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    ? new Date(Date.UTC(year, month - 1, day))
    : null;
}

function getDayEarnings(orders: CompletedOrderEarning[], weekStart: Date): DayEarnings[] {
  return DAY_LABELS.map((_, index) => {
    const date = new Date(weekStart.getTime() + index * 24 * 60 * 60 * 1_000);
    const matchingOrders = orders.filter((order) => parisCalendarDate(order.completedAt)?.getTime() === date.getTime());
    return {
      date,
      totalCents: matchingOrders.reduce((total, order) => total + order.earningCents, 0),
      completedOrderCount: matchingOrders.length
    };
  });
}

function formatDayDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}

// Simulation visuelle temporaire : elle ne s'affiche que tant que l'API ne
// retourne aucune course récente. Dès que des gains réels existent, ils
// remplacent intégralement ces données de démonstration.
function buildDemoWeekEarnings(): CompletedOrderEarning[] {
  const weekStart = getIsoWeekStart(parisCalendarDate(new Date().toISOString()) ?? new Date());
  const createWeek = (start: Date, dailyTotals: number[], courseCounts: number[], prefix: string): CompletedOrderEarning[] =>
    dailyTotals.flatMap((dailyTotal, dayIndex) => {
      const courseCount = courseCounts[dayIndex]!;
      const baseEarning = Math.floor(dailyTotal / courseCount);
      return Array.from({ length: courseCount }, (_, courseIndex) => ({
        id: `demo-${prefix}-${dayIndex}-${courseIndex}`,
        completedAt: new Date(start.getTime() + dayIndex * 24 * 60 * 60 * 1_000 + (10 + courseIndex * 2) * 60 * 60 * 1_000).toISOString(),
        earningCents: courseIndex === courseCount - 1 ? dailyTotal - baseEarning * (courseCount - 1) : baseEarning,
        deliveryAddress: 'Course de démonstration'
      }));
    });

  const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1_000);
  return [
    ...createWeek(weekStart, [6_750, 8_430, 7_260, 9_140, 7_980, 10_560, 8_050], [3, 4, 3, 4, 3, 5, 4], 'current-week'),
    ...createWeek(lastWeekStart, [6_220, 7_940, 8_180, 6_810, 9_260, 10_430, 7_990], [3, 4, 4, 3, 4, 5, 4], 'previous-week')
  ];
}

function DayRow({ day, label, highlightToday, showDate = false }: { day: DayEarnings; label: string; highlightToday: boolean; showDate?: boolean }) {
  const isEmpty = day.completedOrderCount === 0;
  const colorClass = highlightToday ? 'text-primary-700' : isEmpty ? 'text-stone-400' : 'text-stone-700';
  const weightClass = highlightToday ? 'font-sans-bold' : 'font-sans';
  return (
    <View className="flex-row items-center justify-between gap-3 border-t border-border py-2.5 first:border-t-0">
      <Text className={`flex-1 text-body-lg ${weightClass} ${colorClass}`} numberOfLines={1}>
        {showDate ? `${label} ${formatDayDate(day.date)}` : label}
      </Text>
      <View className="items-end">
        <Text className={`text-body-lg ${weightClass} ${colorClass}`}>{formatPriceEuros(day.totalCents)}</Text>
        <Text className={`text-body ${weightClass} ${isEmpty ? 'text-stone-400' : 'text-stone-500'}`}>
          {day.completedOrderCount} course{day.completedOrderCount > 1 ? 's' : ''}
        </Text>
      </View>
    </View>
  );
}

export default function WalletScreen() {
  const router = useRouter();
  const [earnings, setEarnings] = useState<DriverEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [openWeekStart, setOpenWeekStart] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setIsRefreshing(true);
    setError(null);
    try {
      setEarnings(await api.getMyEarnings());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger vos gains.');
    } finally {
      if (isRefresh) setIsRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load(false);
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/compte');
      return true;
    });
    return () => subscription.remove();
  }, [load, router]));

  const displayedOrders = useMemo(() => {
    const realOrders = earnings?.recentCompletedOrders ?? [];
    return realOrders.length > 0 ? realOrders : buildDemoWeekEarnings();
  }, [earnings]);
  const weeklyEarnings = useMemo(() => getWeeklyEarnings(displayedOrders), [displayedOrders]);
  const currentWeekStart = useMemo(() => getIsoWeekStart(parisCalendarDate(new Date().toISOString()) ?? new Date()), []);
  const currentWeek = weeklyEarnings.find((week) => week.start.getTime() === currentWeekStart.getTime()) ?? {
    start: currentWeekStart,
    end: new Date(currentWeekStart.getTime() + 6 * 24 * 60 * 60 * 1_000),
    totalCents: 0,
    completedOrderCount: 0,
    orders: []
  };
  const currentWeekDays = getDayEarnings(currentWeek.orders, currentWeek.start);
  const pastWeeks = weeklyEarnings.filter((week) => week.start.getTime() !== currentWeekStart.getTime());
  const today = parisCalendarDate(new Date().toISOString())?.getTime();
  const currentWeekKey = currentWeek.start.toISOString();
  const isCurrentWeekOpen = openWeekStart === currentWeekKey;

  if (earnings === null && error === null) {
    return <SafeAreaView className="flex-1 bg-background" edges={['top']}><LoadingState /></SafeAreaView>;
  }

  if (error !== null && earnings === null) {
    return <SafeAreaView className="flex-1 bg-background" edges={['top']}><ErrorState message={error} onRetry={() => void load(false)} /></SafeAreaView>;
  }

  const data = earnings as DriverEarnings;
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 px-page-mobile py-3">
        <Pressable onPress={() => router.replace('/compte')} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
          <ChevronLeft size={24} color="#44403C" />
        </Pressable>
        <Text className="font-sans-bold text-h3 text-stone-800">Wallet</Text>
      </View>
      <FlatList
        data={[] as string[]}
        keyExtractor={(item) => item}
        contentContainerStyle={{ flexGrow: 1, gap: 12, paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={EMERALD_600} />}
        ListHeaderComponent={
          <View className="mb-6 gap-5">
            <View className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
              <Pressable onPress={() => setOpenWeekStart(isCurrentWeekOpen ? null : currentWeekKey)} className="min-h-touch-comfortable flex-row items-center gap-2 px-5 py-4 active:bg-primary-50">
                <View className="flex-1 gap-1">
                  <Text className="font-sans-semibold text-body-lg text-stone-600">Semaine en cours</Text>
                  <Text className="font-sans-bold text-h3 text-primary-700">Gains : {formatPriceEuros(currentWeek.totalCents)}</Text>
                  <Text className="font-sans text-body-lg text-stone-500">
                    {currentWeek.completedOrderCount} course{currentWeek.completedOrderCount > 1 ? 's' : ''}
                  </Text>
                </View>
                {isCurrentWeekOpen ? <ChevronUp size={22} color={EMERALD_600} /> : <ChevronDown size={22} color={EMERALD_600} />}
              </Pressable>
              {isCurrentWeekOpen && (
                <View className="border-t border-border px-5 pb-2">
                  {currentWeekDays.map((day, index) => (
                    <DayRow
                      key={DAY_LABELS[index]}
                      day={day}
                      label={DAY_LABELS[index]!}
                      highlightToday={day.date.getTime() === today}
                    />
                  ))}
                </View>
              )}
            </View>

            <View className="gap-3">
              <Text className="font-sans-bold text-h3 text-stone-800">Historique des versements</Text>
              {pastWeeks.length === 0 ? (
                <Text className="font-sans text-body-lg text-stone-400">Aucun versement précédent</Text>
              ) : pastWeeks.map((week) => {
                const weekKey = week.start.toISOString();
                const isOpen = openWeekStart === weekKey;
                const days = getDayEarnings(week.orders, week.start);
                return (
                  <View key={weekKey} className="overflow-hidden rounded-xl border border-border bg-surface">
                    <Pressable onPress={() => setOpenWeekStart(isOpen ? null : weekKey)} className="min-h-touch-comfortable flex-row items-center gap-2 px-4 py-3 active:bg-stone-50">
                      <View className="flex-1 gap-0.5">
                        <Text className="font-sans-semibold text-body-lg text-stone-800">Semaine du {formatWeekRange(week.start, week.end)}</Text>
                        <Text className="font-sans text-body text-stone-500">{formatPriceEuros(week.totalCents)} — En attente ⏳</Text>
                      </View>
                      {isOpen ? <ChevronUp size={20} color={EMERALD_600} /> : <ChevronDown size={20} color={EMERALD_600} />}
                    </Pressable>
                    {isOpen && (
                      <View className="border-t border-border px-4 pb-2">
                        {days.map((day, index) => (
                          <DayRow key={DAY_LABELS[index]} day={day} label={DAY_LABELS[index]!} highlightToday={false} showDate />
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>

            <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
              <View className="flex-row items-center gap-2">
                <Info size={20} color={EMERALD_600} />
                <Text className="font-sans-bold text-h3 text-stone-800">Paiement</Text>
              </View>
              <Text className="font-sans text-body-lg text-stone-600">Paiements par virement bancaire</Text>
              <Pressable onPress={() => showToast('Connexion bancaire disponible en Phase 5')} className="h-touch-comfortable items-center justify-center rounded-lg border-2 border-primary-600 active:bg-primary-50">
                <Text className="font-sans-semibold text-body-lg text-primary-700">Connecter mon compte bancaire</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={displayedOrders.length === 0 ? <EmptyState message="Aucun gain pour l'instant" /> : null}
        renderItem={() => null}
      />
    </SafeAreaView>
  );
}
