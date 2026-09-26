import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, CircleCheck, TriangleAlert } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState, ErrorState, LoadingState } from '../../../components/list-state';
import { api, ApiError, type DriverInvoiceListItem } from '../../../lib/api';
import { EMERALD_600 } from '../../../lib/colors';
import { documentStatusLabel } from '../../../lib/document-status';
import { formatPriceEuros, formatSettlementDate } from '../../../lib/format';
import { openInvoiceDocument, openMandatePdf } from '../../../lib/open-external';

function InvoiceRow({ item }: { item: DriverInvoiceListItem }) {
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    try { await openInvoiceDocument(item.orderId, item.id); } finally { setOpening(false); }
  }
  return (
    <Pressable
      disabled={!item.facturXAvailable || opening}
      onPress={() => void open()}
      className="min-h-touch-comfortable flex-row items-center gap-3 rounded-xl border border-border bg-surface p-4 active:bg-stone-50"
    >
      <View className="flex-1 gap-1">
        <Text className="font-sans-semibold text-body-lg text-stone-800">{item.merchantName}</Text>
        <Text className="font-sans text-body text-stone-600">{formatSettlementDate(item.issuedAt)} · Course {item.orderPublicReference}</Text>
        <Text className="font-sans text-body text-stone-600">{documentStatusLabel(item)}</Text>
      </View>
      <Text className="font-sans-bold text-body-lg text-stone-800">{formatPriceEuros(item.totalHtCents)}</Text>
      {opening ? <ActivityIndicator size="small" color={EMERALD_600} /> : item.facturXAvailable ? <ChevronRight size={22} color="#78716C" /> : null}
    </Pressable>
  );
}

export default function InvoicesScreen() {
  const router = useRouter();
  const [mandateExists, setMandateExists] = useState<boolean | null>(null);
  const [invoices, setInvoices] = useState<DriverInvoiceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [openingMandate, setOpeningMandate] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setIsRefreshing(true);
    setError(null);
    try {
      const [mandate, list] = await Promise.all([api.getMandateStatus(), api.getMyInvoices()]);
      setMandateExists(mandate.mandateExists);
      setInvoices(list.invoices);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de charger vos factures.');
    } finally {
      if (refresh) setIsRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load(false);
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { router.replace('/compte'); return true; });
    return () => subscription.remove();
  }, [load, router]));

  async function handleMandatePress() {
    if (mandateExists) {
      setOpeningMandate(true);
      try { await openMandatePdf(); } finally { setOpeningMandate(false); }
      return;
    }
    router.push('/mandat');
  }

  const header = (
    <View className="flex-row items-center gap-2 px-page-mobile py-3">
      <Pressable accessibilityLabel="Retour au compte" onPress={() => router.replace('/compte')} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
        <ChevronLeft size={24} color="#44403C" />
      </Pressable>
      <Text className="font-sans-bold text-h3 text-stone-800">Mes factures</Text>
    </View>
  );

  if (invoices === null && error === null) return <SafeAreaView className="flex-1 bg-background" edges={['top']}>{header}<LoadingState /></SafeAreaView>;
  if (invoices === null) return <SafeAreaView className="flex-1 bg-background" edges={['top']}>{header}<ErrorState message={error ?? 'Impossible de charger vos factures.'} onRetry={() => void load(false)} /></SafeAreaView>;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {header}
      <FlatList<DriverInvoiceListItem>
        data={invoices}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={() => void load(true)} tintColor={EMERALD_600} />}
        ListHeaderComponent={
          <Pressable
            disabled={openingMandate}
            onPress={() => void handleMandatePress()}
            className={`mb-3 min-h-touch-comfortable flex-row items-center gap-3 rounded-xl border p-4 active:opacity-80 ${mandateExists ? 'border-primary-300 bg-primary-50' : 'border-amber-300 bg-amber-100'}`}
          >
            {mandateExists ? <CircleCheck size={22} color={EMERALD_600} /> : <TriangleAlert size={22} color="#B45309" />}
            <Text className={`flex-1 font-sans-semibold text-body-lg ${mandateExists ? 'text-primary-800' : 'text-amber-900'}`}>
              {mandateExists ? 'Mandat signé' : 'Mandat de facturation à signer'}
            </Text>
            {openingMandate ? <ActivityIndicator size="small" color={mandateExists ? EMERALD_600 : '#B45309'} /> : <ChevronRight size={22} color={mandateExists ? EMERALD_600 : '#B45309'} />}
          </Pressable>
        }
        ListEmptyComponent={<EmptyState message="Aucune facture pour l’instant." />}
        renderItem={({ item }) => <InvoiceRow item={item} />}
      />
    </SafeAreaView>
  );
}
