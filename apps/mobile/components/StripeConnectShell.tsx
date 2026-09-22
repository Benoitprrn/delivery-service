import { ConnectComponentsProvider, loadConnectAndInitialize } from '@stripe/stripe-react-native';
import { useMemo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { api } from '../lib/api';
import type { PayoutSessionPurpose } from '../lib/payout-types';

// Clé PUBLIABLE de la plateforme (pk_…) : jamais la clé secrète. Lue paresseusement pour ne pas faire échouer tout le
// démarrage de l'app si elle manque : l'écran concerné affiche alors un message et le repli navigateur reste possible.
const PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;

export const hasStripePublishableKey = PUBLISHABLE_KEY !== undefined && PUBLISHABLE_KEY.length > 0;

// Fournit les composants Connect embarqués Stripe. `purpose` choisit les composants autorisés côté serveur
// (`onboarding` : onboarding seul ; `wallet` : Payments et Payouts). Le secret de session est demandé au serveur à chaque
// besoin (Stripe le renouvelle seul), jamais stocké.
export function StripeConnectShell({ purpose, children }: { purpose: PayoutSessionPurpose; children: ReactNode }) {
  const instance = useMemo(() => {
    if (!hasStripePublishableKey) return null;
    return loadConnectAndInitialize({
      publishableKey: PUBLISHABLE_KEY as string,
      fetchClientSecret: async () => (await api.createPayoutAccountSession(purpose)).clientSecret,
      appearance: { variables: { colorPrimary: '#059669' } }
    });
  }, [purpose]);

  if (instance === null) {
    return (
      <View className="flex-1 items-center justify-center px-page-mobile">
        <Text className="text-center font-sans text-body-lg text-stone-600">Configuration Stripe manquante dans cette version de l’application.</Text>
      </View>
    );
  }
  return <ConnectComponentsProvider connectInstance={instance}>{children}</ConnectComponentsProvider>;
}
