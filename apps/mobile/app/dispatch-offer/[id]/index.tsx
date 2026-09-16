import { useLocalSearchParams, useRouter } from 'expo-router';
import { Clock, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OrderCard } from '../../../components/order-card';
import { api, ApiError } from '../../../lib/api';
import { EMERALD_600, WHITE } from '../../../lib/colors';
import type { DispatchOffer } from '../../../lib/dispatch-types';
import type { DriverOrder } from '../../../lib/orders-types';
import { showToast } from '../../../lib/toast';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; offer: DispatchOffer; order: DriverOrder };

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1_000));
}

function formatCountdown(seconds: number): string {
  return `0:${seconds.toString().padStart(2, '0')}`;
}

export default function DispatchOfferModal() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [remaining, setRemaining] = useState(60);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Une seule décision (accepter/refuser/expiration locale) par offre — évite
  // un double-tap ou un tap juste après expiration de relancer un second
  // appel réseau pendant que le premier est encore en vol.
  const decidedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api.getDispatchOffer(id).then(
      ({ offer, order }) => {
        if (cancelled) return;
        setState({ status: 'ready', offer, order });
        setRemaining(remainingSeconds(offer.expiresAt));
      },
      (err) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Offre introuvable.' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const intervalId = setInterval(() => {
      setRemaining(remainingSeconds(state.offer.expiresAt));
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [state]);

  const isExpired = state.status === 'ready' && remaining <= 0;

  async function handleAccept() {
    if (state.status !== 'ready' || decidedRef.current) return;
    decidedRef.current = true;
    setIsSubmitting(true);
    try {
      await api.acceptDispatchOffer(state.offer.id, state.offer.version);
      showToast('Course acceptée ✓');
      router.back();
    } catch (err) {
      decidedRef.current = false;
      setIsSubmitting(false);
      if (err instanceof ApiError && err.status === 409) {
        showToast('Trop tard, cette offre a expiré.');
        router.back();
        return;
      }
      showToast(err instanceof ApiError ? err.message : 'Impossible d’accepter cette course.');
    }
  }

  async function handleReject() {
    if (state.status !== 'ready' || decidedRef.current) return;
    decidedRef.current = true;
    setIsSubmitting(true);
    try {
      await api.rejectDispatchOffer(state.offer.id, state.offer.version);
    } catch {
      // Le refus a peut-être déjà été enregistré côté serveur (expiration
      // concurrente) — dans tous les cas, cette offre ne doit plus être
      // affichée au livreur, donc on ferme sans bloquer sur l'erreur réseau.
    } finally {
      router.back();
    }
  }

  if (state.status === 'loading') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center gap-3 bg-background">
        <ActivityIndicator size="large" color={EMERALD_600} />
      </SafeAreaView>
    );
  }

  if (state.status === 'error') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center gap-4 bg-background px-page-mobile">
        <Text className="text-center font-sans text-body-lg text-stone-500">{state.message}</Text>
        <Pressable
          onPress={() => router.back()}
          className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700"
        >
          <Text className="font-sans-bold text-body-lg text-white">Fermer</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const { order } = state;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-page-mobile py-3">
        <View className="flex-row items-center gap-2 rounded-full bg-primary-50 px-3 py-1.5">
          <Clock size={18} color={EMERALD_600} />
          <Text className="font-sans-bold text-h3 text-primary-700">{formatCountdown(remaining)}</Text>
        </View>
        <Pressable
          accessibilityLabel="Fermer l'offre"
          onPress={() => void handleReject()}
          className="h-touch-comfortable w-touch-comfortable items-center justify-center"
        >
          <X size={24} color="#57534E" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 16 }}>
        <Text className="font-sans-bold text-h2 text-stone-800">Nouvelle course proposée</Text>
        <OrderCard order={order} merchantName={order.merchantName} />
      </ScrollView>

      <View className="flex-row gap-3 px-page-mobile pb-6 pt-2">
        <Pressable
          onPress={() => void handleReject()}
          disabled={isSubmitting || isExpired}
          className="h-touch-comfortable flex-1 items-center justify-center rounded-lg border border-border bg-surface active:bg-stone-100 disabled:opacity-50"
        >
          <Text className="font-sans-bold text-body-lg text-stone-700">Refuser</Text>
        </Pressable>
        <Pressable
          onPress={() => void handleAccept()}
          disabled={isSubmitting || isExpired}
          className="h-touch-comfortable flex-1 items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
        >
          {isSubmitting ? (
            <ActivityIndicator color={WHITE} />
          ) : (
            <Text className="font-sans-bold text-body-lg text-white">{isExpired ? 'Expirée' : 'Accepter'}</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
