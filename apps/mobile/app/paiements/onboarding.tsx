import { ConnectAccountOnboarding } from '@stripe/stripe-react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StripeConnectShell } from '../../components/StripeConnectShell';
import { EMERALD_600 } from '../../lib/colors';
import { openHostedOnboarding } from '../../lib/open-external';
import { usePayoutAccount } from '../../lib/payout-account-context';

// Onboarding Stripe INTÉGRÉ (prioritaire). En cas d'échec de chargement du composant, le lien hébergé s'ouvre dans le
// navigateur système (repli déjà validé côté serveur).
export default function PayoutOnboardingScreen() {
  const router = useRouter();
  const { refresh } = usePayoutAccount();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // `completed` : le composant signale la fin de l'onboarding. Stripe active les capacités quelques secondes plus tard :
  // on relit alors l'état (le serveur relit Stripe) jusqu'à « prêt » (≈ 12 s max) au lieu d'afficher tout de suite un état
  // périmé « Stripe a besoin d'informations ». Retour manuel (flèche) : une seule relecture.
  async function close(completed: boolean) {
    setVerifying(true);
    try {
      for (let attempt = 0; attempt < (completed ? 6 : 1); attempt += 1) {
        const account = await refresh();
        if (account?.state === 'created' && account.ready) break;
        if (completed && attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      setVerifying(false);
      router.back();
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 px-page-mobile py-3">
        <Pressable onPress={() => void close(false)} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
          <ChevronLeft size={24} color="#44403C" />
        </Pressable>
        <Text className="font-sans-bold text-h3 text-stone-800">Configurer mes paiements</Text>
      </View>
      {verifying ? (
        <View className="flex-1 items-center justify-center gap-3">
          <ActivityIndicator size="large" color={EMERALD_600} />
          <Text className="font-sans text-body-lg text-stone-600">Vérification de vos informations…</Text>
        </View>
      ) : loadError === null ? (
        <StripeConnectShell purpose="onboarding">
          <ConnectAccountOnboarding
            onExit={() => void close(true)}
            onLoadError={(event) => setLoadError(event.error.message ?? event.error.type)}
          />
        </StripeConnectShell>
      ) : (
        <View className="flex-1 justify-center gap-4 px-page-mobile">
          <Text className="text-center font-sans text-body-lg text-stone-700">
            L’écran de configuration intégré n’a pas pu s’ouvrir. Vous pouvez continuer dans le navigateur.
          </Text>
          <Text className="text-center font-sans text-body text-stone-400">{loadError}</Text>
          <Pressable onPress={() => void openHostedOnboarding()} className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700">
            <Text className="font-sans-bold text-body-lg text-white">Ouvrir dans le navigateur</Text>
          </Pressable>
          <Pressable onPress={() => setLoadError(null)} className="h-touch-comfortable items-center justify-center">
            <Text className="font-sans-semibold text-body-lg text-primary-700">Réessayer</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}
