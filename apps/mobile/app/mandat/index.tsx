import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MandateSignaturePad } from '../../components/mandate-signature-pad';
import { MandateStatusCard } from '../../components/MandateStatusCard';
import { ErrorState, LoadingState } from '../../components/list-state';
import { ApiError, api } from '../../lib/api';
import { EMERALD_600 } from '../../lib/colors';
import { deriveMandateUi } from '../../lib/mandate-status';
import { openMandatePdf } from '../../lib/open-external';
import type { MandateStatus } from '../../lib/mandate-types';
import { showToast } from '../../lib/toast';

// Machine à états locale du parcours de signature (plan §15.3) — le statut lui-même n'est JAMAIS
// une source de vérité locale : chaque retour sur l'écran (useFocusEffect) le relit depuis le
// backend, avant/après signature, y compris après une fermeture d'app en cours de route.
type Phase = 'loading' | 'error' | 'status' | 'read' | 'name' | 'signing';

const CONSENT_TEXT = 'J’ai lu le mandat et j’autorise Locadely à établir mes factures en mon nom.';

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View className="flex-row items-center gap-2 px-page-mobile py-3">
      <Pressable onPress={onBack} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
        <ChevronLeft size={24} color="#44403C" />
      </Pressable>
      <Text className="font-sans-bold text-h3 text-stone-800">{title}</Text>
    </View>
  );
}

export default function MandateScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<MandateStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [signerFirstName, setSignerFirstName] = useState('');
  const [signerLastName, setSignerLastName] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = await api.getMandateStatus();
      setStatus(next);
      setPhase('status');
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : 'Impossible de charger votre mandat de facturation.');
      setPhase('error');
    }
  }, []);

  // Toujours relire depuis le backend au focus — jamais un état optimiste local durable (plan §15.3/§10).
  useFocusEffect(useCallback(() => { void loadStatus(); }, [loadStatus]));

  async function handleAccept(imageBase64: string) {
    try {
      await api.acceptMandate(imageBase64, signerFirstName.trim(), signerLastName.trim());
      setConsentChecked(false);
      await loadStatus();
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : 'Impossible d’enregistrer votre mandat.');
      // Le POST est idempotent côté serveur (mandat courant retourné tel quel s'il existe déjà) :
      // une nouvelle tentative après une erreur transitoire (réseau) est sûre.
    }
  }

  async function handleOpenPdf() {
    setDownloading(true);
    try {
      await openMandatePdf();
    } finally {
      setDownloading(false);
    }
  }

  if (phase === 'loading') {
    return <SafeAreaView className="flex-1 bg-background" edges={['top']}><Header title="Mandat de facturation" onBack={() => router.back()} /><LoadingState /></SafeAreaView>;
  }
  if (phase === 'error') {
    return <SafeAreaView className="flex-1 bg-background" edges={['top']}><Header title="Mandat de facturation" onBack={() => router.back()} /><ErrorState message={errorMessage} onRetry={() => { setPhase('loading'); void loadStatus(); }} /></SafeAreaView>;
  }
  if (status === null) {
    return null;
  }

  const ui = deriveMandateUi(status);

  if (phase === 'name') {
    const canContinue = signerFirstName.trim() !== '' && signerLastName.trim() !== '';
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <Header title="Mandat de facturation" onBack={() => setPhase('read')} />
        <ScrollView contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 32 }}>
          <Text className="font-sans-bold text-h3 text-stone-800">Qui signe ce mandat ?</Text>
          <Text className="font-sans text-body-lg text-stone-600">Confirmez le prénom et le nom du signataire.</Text>
          <View className="gap-3">
            <TextInput
              value={signerFirstName}
              onChangeText={setSignerFirstName}
              placeholder="Prénom"
              placeholderTextColor="#A8A29E"
              autoCapitalize="words"
              className="h-touch-comfortable rounded-lg border-2 border-border bg-surface px-4 font-sans text-body-lg text-stone-800"
            />
            <TextInput
              value={signerLastName}
              onChangeText={setSignerLastName}
              placeholder="Nom"
              placeholderTextColor="#A8A29E"
              autoCapitalize="words"
              className="h-touch-comfortable rounded-lg border-2 border-border bg-surface px-4 font-sans text-body-lg text-stone-800"
            />
          </View>
          <Pressable
            onPress={() => setPhase('signing')}
            disabled={!canContinue}
            className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
          >
            <Text className="font-sans-bold text-body-lg text-white">Continuer</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'signing') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <Header title="Mandat de facturation" onBack={() => setPhase('name')} />
        <ScrollView contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 32 }}>
          <Pressable onPress={() => setConsentChecked((v) => !v)} className="min-h-touch-comfortable flex-row items-start gap-3 rounded-2xl border border-border bg-surface p-4 active:opacity-75">
            <View className={`mt-0.5 h-6 w-6 items-center justify-center rounded border-2 ${consentChecked ? 'border-primary-600 bg-primary-600' : 'border-border bg-white'}`}>
              {consentChecked ? <Text className="font-sans-bold text-body leading-none text-white">✓</Text> : null}
            </View>
            <Text className="flex-1 font-sans text-body-lg text-stone-700">{CONSENT_TEXT}</Text>
          </Pressable>
          <Text className="font-sans-bold text-h3 text-stone-800">Votre signature</Text>
          <MandateSignaturePad onSubmit={handleAccept} disabled={!consentChecked} />
          {consentChecked ? null : (
            <Text className="font-sans text-body text-stone-500">Cochez la case ci-dessus pour pouvoir signer.</Text>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'read') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <Header title="Mandat de facturation" onBack={() => setPhase('status')} />
        <ScrollView contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 32 }}>
          <Text className="font-sans text-body-lg text-stone-600">Lisez le mandat ci-dessous avant de le signer.</Text>
          <View className="rounded-2xl border border-border bg-surface p-4">
            <Text className="font-sans text-body text-stone-800">{status.previewText}</Text>
          </View>
          <Pressable
            onPress={() => setPhase('name')}
            className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700"
          >
            <Text className="font-sans-bold text-body-lg text-white">Signer</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // phase === 'status'
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <Header title="Mandat de facturation" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingBottom: 32 }}>
        <MandateStatusCard ui={ui} />
        {ui.action === 'sign' ? (
          <Pressable
            onPress={() => setPhase('read')}
            className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700"
          >
            <Text className="font-sans-bold text-body-lg text-white">Lire et signer</Text>
          </Pressable>
        ) : null}
        {ui.action === 'complete-profile' ? (
          <Pressable
            onPress={() => router.push('/compte/mon-compte')}
            className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700"
          >
            <Text className="font-sans-bold text-body-lg text-white">Compléter mon compte</Text>
          </Pressable>
        ) : null}
        {status.mandateExists ? (
          <Pressable
            onPress={() => void handleOpenPdf()}
            disabled={downloading}
            className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg border border-border bg-surface px-6 active:opacity-70 disabled:opacity-50"
          >
            {downloading ? <ActivityIndicator color={EMERALD_600} /> : <Text className="font-sans-semibold text-body-lg text-primary-700">Voir le mandat signé</Text>}
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
