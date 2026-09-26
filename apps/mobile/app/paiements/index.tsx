import { useFocusEffect, useRouter } from 'expo-router';
import { Briefcase, ChevronLeft, ExternalLink, User } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorState, LoadingState } from '../../components/list-state';
import { PayoutStatusCard } from '../../components/PayoutStatusCard';
import { ApiError, api } from '../../lib/api';
import { EMERALD_600 } from '../../lib/colors';
import { openHostedOnboarding, openStripeDashboard } from '../../lib/open-external';
import { usePayoutAccount } from '../../lib/payout-account-context';
import { derivePayoutUi } from '../../lib/payout-status';
import type { PayoutEntityType } from '../../lib/payout-types';
import { showToast } from '../../lib/toast';

const CHOICES: { entityType: PayoutEntityType; title: string; hint: string; confirm: string }[] = [
  { entityType: 'individual', title: 'Je suis indépendant / micro-entrepreneur', hint: 'Vous travaillez en votre nom.', confirm: 'indépendant / micro-entrepreneur' },
  { entityType: 'company', title: 'J’ai une société', hint: 'SASU, EURL, SAS… Vous facturez au nom de votre société.', confirm: 'société' }
];

function PrimaryButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700 disabled:opacity-50">
      <Text className="font-sans-bold text-body-lg text-white">{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress, external = false }: { label: string; onPress: () => void; external?: boolean }) {
  return (
    <Pressable onPress={onPress} className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg border border-border bg-surface px-6 active:opacity-70">
      <Text className="font-sans-semibold text-body-lg text-primary-700">{label}</Text>
      {external ? <ExternalLink size={18} color={EMERALD_600} /> : null}
    </Pressable>
  );
}

export default function PayoutHubScreen() {
  const router = useRouter();
  const { status, refresh } = usePayoutAccount();
  const [busy, setBusy] = useState(false);

  // Relit l'état à chaque retour sur l'écran (retour de l'onboarding embarqué ou du navigateur système).
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  function confirmChoice(choice: (typeof CHOICES)[number]) {
    Alert.alert(
      'Confirmer votre choix',
      `Vous êtes : ${choice.confirm}.\n\nCe choix est définitif : il ne pourra plus être modifié depuis l’application.`,
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Confirmer', onPress: () => void createAccount(choice.entityType) }
      ]
    );
  }

  async function createAccount(entityType: PayoutEntityType) {
    setBusy(true);
    try {
      await api.createPayoutAccount(entityType);
      await refresh();
      router.push('/paiements/onboarding');
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : 'Impossible de créer votre compte de paiement.');
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <View className="flex-row items-center gap-2 px-page-mobile py-3">
      <Pressable onPress={() => router.back()} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
        <ChevronLeft size={24} color="#44403C" />
      </Pressable>
      <Text className="font-sans-bold text-h3 text-stone-800">Mes paiements</Text>
    </View>
  );

  if (status.kind === 'loading') {
    return <SafeAreaView className="flex-1 bg-background" edges={['top']}>{header}<LoadingState /></SafeAreaView>;
  }
  if (status.kind === 'error') {
    return <SafeAreaView className="flex-1 bg-background" edges={['top']}>{header}<ErrorState message={status.message} onRetry={() => void refresh()} /></SafeAreaView>;
  }

  const account = status.account;
  const ui = derivePayoutUi(account);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {header}
      <ScrollView contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 32 }}>
        <PayoutStatusCard ui={ui} />

        {account.state === 'not_created' ? (
          <View className="gap-3">
            <Text className="font-sans-bold text-h3 text-stone-800">Vous êtes…</Text>
            {CHOICES.map((choice) => (
              <Pressable
                key={choice.entityType}
                disabled={busy}
                onPress={() => confirmChoice(choice)}
                className="min-h-touch-comfortable flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-70 disabled:opacity-50"
              >
                <View className="h-12 w-12 items-center justify-center rounded-full bg-primary-100">
                  {choice.entityType === 'individual' ? <User size={23} color={EMERALD_600} /> : <Briefcase size={23} color={EMERALD_600} />}
                </View>
                <View className="flex-1 gap-0.5">
                  <Text className="font-sans-semibold text-body-lg text-stone-800">{choice.title}</Text>
                  <Text className="font-sans text-body text-stone-500">{choice.hint}</Text>
                </View>
              </Pressable>
            ))}
            <Text className="font-sans text-body text-stone-500">Ce choix est définitif. Stripe, notre prestataire de paiement, vous demandera ensuite les informations nécessaires (identité, IBAN).</Text>
          </View>
        ) : (
          <View className="gap-3">
            {ui.action === 'onboard' ? (
              <>
                <PrimaryButton label="Continuer la configuration" onPress={() => router.push('/paiements/onboarding')} />
                <SecondaryButton label="Ouvrir dans le navigateur" external onPress={() => void openHostedOnboarding()} />
              </>
            ) : (
              <SecondaryButton label="Gérer mon compte" external onPress={() => void openStripeDashboard()} />
            )}
            <SecondaryButton label="Actualiser" onPress={() => { void refresh().then((next) => { if (next === null) showToast('Actualisation impossible.'); }); }} />
            <Text className="font-sans text-body text-stone-500">
              Type de compte : {account.entityType === 'individual' ? 'indépendant / micro-entrepreneur' : 'société'} (non modifiable depuis l’application).
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
