import { ConnectPayments, ConnectPayouts } from '@stripe/stripe-react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StripeConnectShell } from '../../components/StripeConnectShell';
import { openStripeDashboard } from '../../lib/open-external';

type Tab = 'payouts' | 'payments';

// Essai des composants Stripe embarqués Payouts et Payments (virements et transactions). Le Dashboard Express reste le repli.
export default function PayoutHistoryScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('payouts');
  const [loadError, setLoadError] = useState<string | null>(null);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 px-page-mobile py-3">
        <Pressable onPress={() => router.back()} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
          <ChevronLeft size={24} color="#44403C" />
        </Pressable>
        <Text className="font-sans-bold text-h3 text-stone-800">Versements et transactions</Text>
      </View>
      <View className="flex-row gap-2 px-page-mobile pb-3">
        {(['payouts', 'payments'] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => { setTab(value); setLoadError(null); }}
            className={`h-touch-comfortable flex-1 items-center justify-center rounded-lg border ${tab === value ? 'border-primary-600 bg-primary-100' : 'border-border bg-surface'}`}
          >
            <Text className={`font-sans-semibold text-body-lg ${tab === value ? 'text-primary-700' : 'text-stone-600'}`}>{value === 'payouts' ? 'Virements' : 'Transactions'}</Text>
          </Pressable>
        ))}
      </View>
      {loadError === null ? (
        <StripeConnectShell purpose="wallet">
          <View className="flex-1">
            {tab === 'payouts'
              ? <ConnectPayouts style={{ flex: 1 }} onLoadError={(event) => setLoadError(event.error.message ?? event.error.type)} />
              : <ConnectPayments style={{ flex: 1 }} onLoadError={(event) => setLoadError(event.error.message ?? event.error.type)} />}
          </View>
        </StripeConnectShell>
      ) : (
        <View className="flex-1 justify-center gap-4 px-page-mobile">
          <Text className="text-center font-sans text-body-lg text-stone-700">Cet écran intégré n’a pas pu s’ouvrir. Votre espace Stripe complet reste disponible.</Text>
          <Text className="text-center font-sans text-body text-stone-400">{loadError}</Text>
          <Pressable onPress={() => void openStripeDashboard()} className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700">
            <Text className="font-sans-bold text-body-lg text-white">Ouvrir mon espace Stripe</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}
