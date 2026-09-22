import { useLocalSearchParams, useRouter } from 'expo-router';
import { CreditCard, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError, type CompletionPayment } from '../../../lib/api';
import { formatPriceEuros } from '../../../lib/format';
import { ReaderError, type ReaderStatus } from '../../../lib/terminal/reader-adapter';
import { setTerminalOrder } from '../../../lib/terminal/terminal-provider';
import { resolveReaderFamily } from '../../../lib/terminal/terminal-mode';
import { useReaderAdapter } from '../../../lib/terminal/use-reader-adapter';
import { showToast } from '../../../lib/toast';

// Étape de paiement d'une livraison avec « Paiement à la livraison ».
// Le mobile ne décide JAMAIS que le paiement est réussi : il collecte et confirme le
// PaymentIntent remis par le serveur, puis appelle `finalize` ; le serveur relit Stripe,
// capture et termine la commande. Aucun succès n'est affiché avant la réponse de `finalize`.

type Phase = 'loading' | 'connecting' | 'updating' | 'collecting' | 'finalizing' | 'done' | 'error';
type Failure = { message: string; retry: 'connect' | 'payment' | 'finalize' | 'none' };

function statusPhase(status: ReaderStatus): Phase | null {
  if (status.phase === 'discovering' || status.phase === 'connecting') return 'connecting';
  if (status.phase === 'updating') return 'updating';
  if (status.phase === 'collecting' || status.phase === 'confirming') return 'collecting';
  return null;
}

function failureFor(error: unknown): Failure {
  if (error instanceof ReaderError) {
    switch (error.kind) {
      case 'battery_low':
        return { message: 'Batterie du lecteur trop faible pour la mise à jour. Rechargez-le puis réessayez.', retry: 'connect' };
      case 'update_failed':
        return { message: 'La mise à jour du lecteur a échoué. Réessayez.', retry: 'connect' };
      case 'reader_not_found':
        return { message: 'Lecteur introuvable. Allumez-le et rapprochez-le du téléphone.', retry: 'connect' };
      case 'multiple_readers':
        return { message: 'Plusieurs lecteurs détectés. Éteignez les autres lecteurs à proximité.', retry: 'connect' };
      case 'permission_denied':
        return { message: 'Autorisez la localisation et les appareils à proximité dans les réglages.', retry: 'connect' };
      case 'token_error':
      case 'network':
        return { message: 'Connexion impossible. Vérifiez votre réseau puis réessayez.', retry: 'connect' };
      case 'card_declined':
        return { message: 'Carte refusée. Demandez une autre carte.', retry: 'payment' };
      case 'collect_canceled':
        return { message: 'Paiement annulé.', retry: 'payment' };
      default:
        return { message: 'Le lecteur a rencontré une erreur. Réessayez.', retry: 'payment' };
    }
  }
  if (error instanceof ApiError) {
    if (error.code === 'PaymentDeclined') return { message: 'Carte refusée. Demandez une autre carte.', retry: 'payment' };
    if (error.code === 'PaymentNotConfirmed') return { message: 'Le paiement n’est pas encore confirmé. Réessayez dans un instant.', retry: 'finalize' };
    if (error.code === 'SessionExpired') return { message: 'La session a expiré. Recommencez la livraison depuis le code client.', retry: 'none' };
    if (error.status >= 500) return { message: 'Service indisponible. Réessayez dans un instant.', retry: 'finalize' };
    return { message: 'Impossible de terminer la livraison pour le moment.', retry: 'none' };
  }
  return { message: 'Une erreur est survenue. Réessayez.', retry: 'payment' };
}

const PHASE_TEXT: Record<Phase, string> = {
  loading: 'Préparation du paiement…',
  connecting: 'Connexion au lecteur de cartes…',
  updating: 'Mise à jour du lecteur en cours. Ne l’éteignez pas.',
  collecting: 'Présentez la carte du client sur le lecteur.',
  finalizing: 'Validation du paiement…',
  done: 'Livraison terminée',
  error: ''
};

export default function DeliveryPaymentScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const sessionRef = useRef<{ sessionId: string; payment: CompletionPayment } | null>(null);
  const runningRef = useRef(false);

  const reader = useReaderAdapter(resolveReaderFamily(), (status) => {
    const next = statusPhase(status);
    if (next !== null) setPhase(next);
    setProgress(status.phase === 'updating' ? (status.updateProgress ?? 0) : null);
  });

  const finish = useCallback(() => {
    setPhase('done');
    showToast('Livraison terminée ✓');
    // Comme pour la preuve : fermer toute la pile modale pour recharger la commande à l'état final.
    router.dismissAll();
  }, [router]);

  const finalize = useCallback(async () => {
    const current = sessionRef.current;
    if (current === null) return;
    setPhase('finalizing');
    await api.finalizeCompletion(id, current.sessionId, current.payment.id);
    finish();
  }, [finish, id]);

  const collectAndFinalize = useCallback(async () => {
    const current = sessionRef.current;
    if (current === null || current.payment.paymentIntentClientSecret === null) throw new Error('paiement indisponible');
    setPhase('collecting');
    await reader.collectAndConfirm(current.payment.paymentIntentClientSecret);
    await finalize();
  }, [finalize, reader]);

  const connectThenCollect = useCallback(async () => {
    const current = sessionRef.current;
    if (current === null) return;
    setPhase('connecting');
    await reader.connect({ locationId: current.payment.terminalLocationId });
    await collectAndFinalize();
  }, [collectAndFinalize, reader]);

  const run = useCallback(
    async (requested: 'load' | Failure['retry']) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setFailure(null);
      // Jamais « erreur sans message » : on quitte l'état d'erreur dès qu'on efface la panne.
      setPhase('loading');
      // Sans session en mémoire (le chargement initial a échoué), un « Réessayer » doit recharger l'état serveur.
      const step = requested !== 'load' && sessionRef.current === null ? 'load' : requested;
      try {
        if (step === 'load') {
          const state = await api.getCompletionState(id);
          if (state.order.status === 'COMPLETED') return finish();
          if (state.session === null || state.payment === null) {
            throw new ApiError(409, 'session', undefined, 'SessionExpired');
          }
          sessionRef.current = { sessionId: state.session.id, payment: state.payment };
          setAmountCents(state.payment.amountCents);
          if (state.nextAction === 'finalize') return await finalize();
          if (state.nextAction === 'retry_payment') {
            const retried = await api.retryCompletionPayment(id, state.session.id);
            sessionRef.current = { sessionId: state.session.id, payment: retried.payment };
          }
          await connectThenCollect();
        } else if (step === 'connect') {
          await connectThenCollect();
        } else if (step === 'payment') {
          // Carte refusée ou collecte annulée : nouvelle tentative (nouveau PaymentIntent), sans ressaisir le code.
          const current = sessionRef.current;
          if (current === null) throw new ApiError(409, 'session', undefined, 'SessionExpired');
          const retried = await api.retryCompletionPayment(id, current.sessionId);
          sessionRef.current = { sessionId: current.sessionId, payment: retried.payment };
          await collectAndFinalize();
        } else if (step === 'finalize') {
          await finalize();
        }
      } catch (error) {
        const next = failureFor(error);
        setFailure(next);
        setPhase('error');
      } finally {
        runningRef.current = false;
      }
    },
    [collectAndFinalize, connectThenCollect, finalize, finish, id]
  );

  useEffect(() => {
    setTerminalOrder(id);
    void run('load');
    return () => {
      setTerminalOrder(null);
      void reader.cancelCollection().catch(() => undefined);
    };
    // Démarrage unique à l'ouverture de l'écran.
  }, [id]);

  function handleClose() {
    if (phase === 'collecting' || phase === 'finalizing') {
      Alert.alert('Paiement en cours', 'Ne quittez pas cet écran pendant le paiement.');
      return;
    }
    router.back();
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-page-mobile py-3">
        <Text className="font-sans text-body-lg text-stone-400">#{id.slice(-6)}</Text>
        <Pressable onPress={handleClose} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
          <X size={24} color="#57534E" />
        </Pressable>
      </View>

      <View className="flex-1 items-center justify-center px-page-mobile">
        <CreditCard size={48} color="#57534E" />
        {amountCents !== null && (
          <Text className="mt-3 font-sans-bold text-h1 text-stone-800">{formatPriceEuros(amountCents)}</Text>
        )}
        <Text className="mt-1 font-sans text-body-lg text-stone-500">Paiement à la livraison</Text>

        {phase !== 'error' && (
          <View className="mt-8 items-center">
            {phase !== 'done' && <ActivityIndicator size="large" color="#059669" />}
            <Text className="mt-4 text-center font-sans-semibold text-h3 text-stone-800">{PHASE_TEXT[phase]}</Text>
            {phase === 'updating' && progress !== null && (
              <Text className="mt-2 font-sans text-body-lg text-stone-600">{Math.round(progress * 100)} %</Text>
            )}
          </View>
        )}

        {phase === 'error' && failure !== null && (
          <View className="mt-8 w-full items-center">
            <Text className="text-center font-sans-semibold text-h3 text-red-700">{failure.message}</Text>
            {failure.retry !== 'none' && (
              <Pressable
                onPress={() => void run(failure.retry)}
                className="mt-6 h-touch-comfortable w-full items-center justify-center rounded-lg bg-primary-600 active:opacity-80"
              >
                <Text className="font-sans-semibold text-body-lg text-white">Réessayer</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => router.back()}
              className="mt-3 h-touch-comfortable w-full items-center justify-center rounded-lg border-2 border-border active:bg-stone-100"
            >
              <Text className="font-sans-semibold text-body-lg text-stone-600">Retour</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}
