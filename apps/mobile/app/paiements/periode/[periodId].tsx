import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorState, LoadingState } from '../../../components/list-state';
import { api, ApiError } from '../../../lib/api';
import { formatPriceEuros, formatSettlementDate, formatSettlementPeriod } from '../../../lib/format';
import { getSettlementLabel, SETTLEMENT_TONE_COLORS, type SettlementTone } from '../../../lib/settlement-labels';
import type { DriverPeriodView } from '../../../lib/settlements-types';

const TONE_STYLES: Record<SettlementTone, { box: string; text: string }> = {
  neutre: { box: 'border-border bg-stone-50', text: 'text-stone-700' },
  succès: { box: 'border-primary-600/30 bg-primary-50', text: 'text-primary-700' },
  attente: { box: 'border-amber-300 bg-amber-100', text: 'text-amber-800' },
  alerte: { box: 'border-red-300 bg-red-50', text: 'text-red-700' }
};

function Amount({ label, amount }: { label: string; amount: number }) {
  return <View className="flex-1 gap-1"><Text className="font-sans text-body text-stone-600">{label}</Text><Text className="font-sans-bold text-body-lg text-stone-800">{formatPriceEuros(amount)}</Text></View>;
}

export default function SettlementPeriodScreen() {
  const router = useRouter();
  const { periodId } = useLocalSearchParams<{ periodId: string }>();
  const [period, setPeriod] = useState<DriverPeriodView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api.getMySettlements();
      const found = response.periods.find((candidate) => candidate.periodId === periodId);
      if (found === undefined) { setError('Cette période est introuvable.'); return; }
      setPeriod(found);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Impossible de charger cette période.'); }
  }, [periodId]);
  useEffect(() => { void load(); }, [load]);
  if (period === null && error === null) return <SafeAreaView className="flex-1 bg-background" edges={['top']}><LoadingState /></SafeAreaView>;
  if (period === null) return <SafeAreaView className="flex-1 bg-background" edges={['top']}><ErrorState message={error ?? 'Impossible de charger cette période.'} onRetry={() => void load()} /></SafeAreaView>;
  return <SafeAreaView className="flex-1 bg-background" edges={['top']}>
    <View className="flex-row items-center gap-2 px-page-mobile py-3"><Pressable accessibilityLabel="Retour aux paiements" onPress={() => router.back()} className="h-touch-comfortable w-touch-comfortable items-center justify-center"><ChevronLeft size={24} color="#44403C" /></Pressable><Text className="font-sans-bold text-h3 text-stone-800">Détail de période</Text></View>
    <ScrollView contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 24 }}>
      <View className="gap-3 rounded-2xl border border-border bg-surface p-4"><Text className="font-sans-bold text-h3 text-stone-800">{formatSettlementPeriod(period.periodStart, period.periodEnd)}</Text><View className="flex-row gap-3"><Amount label="Total" amount={period.totalCents} /><Amount label="Envoyé" amount={period.sentCents} /><Amount label="En attente" amount={period.pendingCents} /></View>{period.payrunAt !== null && <Text className="font-sans text-body-lg text-stone-700">Paiement prévu le {formatSettlementDate(period.payrunAt)}</Text>}</View>
      <Text className="font-sans-bold text-h3 text-stone-800">Par restaurant</Text>
      {period.statements.map((statement) => {
        const status = getSettlementLabel(statement.displayState, statement.expectedPaymentAt);
        const style = TONE_STYLES[status.tone];
        return <View key={statement.statementId} className="gap-3 rounded-2xl border border-border bg-surface p-4"><Text className="font-sans-bold text-body-lg text-stone-800">{statement.merchantName}</Text><View className="flex-row gap-3"><Amount label="Dû" amount={statement.dueCents} /><Amount label="Envoyé" amount={statement.paidCents} /><Amount label="Reste" amount={statement.remainingCents} /></View><View className={`self-start rounded-full border px-3 py-2 ${style.box}`} accessibilityLabel={`État : ${status.label}`}><Text className={`font-sans-semibold text-body ${style.text}`} style={{ color: SETTLEMENT_TONE_COLORS[status.tone] }}>{status.label}</Text></View><Text className="font-sans text-body text-stone-600">{status.description}</Text>{statement.expectedPaymentAt !== null && <Text className="font-sans text-body-lg text-stone-700">Paiement prévu le {formatSettlementDate(statement.expectedPaymentAt)}</Text>}{statement.debtor !== null && <View className="gap-1 rounded-xl border border-amber-300 bg-amber-50 p-3"><Text className="font-sans-bold text-body-lg text-stone-800">Restaurant concerné</Text><Text className="font-sans text-body-lg text-stone-700">{statement.debtor.legalName}</Text><Text className="font-sans text-body text-stone-700">SIRET : {statement.debtor.siret}</Text><Text className="font-sans text-body text-stone-700">{statement.debtor.address}</Text><Text className="font-sans text-body text-stone-500">Informations communiquées pour le suivi de cet impayé</Text></View>}</View>;
      })}
    </ScrollView>
  </SafeAreaView>;
}
