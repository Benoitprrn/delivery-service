import { useLocalSearchParams, useRouter } from 'expo-router';
import dispatchOfferSound from '../../../assets/sounds/dispatch_offer.wav';
import { Clock, CreditCard, Euro, Package, Route } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '../../../lib/api';
import { BLUE_500, EMERALD_600, STONE_500 } from '../../../lib/colors';
import { DetailsSection, PickupDeliverySummary, RecipientCard, SenderCard } from '../../../components/order-detail-sections';
import { HoldActionButton } from '../../../components/hold-action-button';
import type { DispatchOffer } from '../../../lib/dispatch-types';
import { formatDeliveryTimeEstimate, formatDistanceKm, formatDurationMin, formatPickupLabel, formatPriceEuros } from '../../../lib/format';
import { openMaps, openPhone } from '../../../lib/native-links';
import type { DriverOrder } from '../../../lib/orders-types';
import { showToast } from '../../../lib/toast';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; offer: DispatchOffer; order: DriverOrder };

const OFFER_ALERT_REPEAT_DELAYS_MS = [0, 20_000, 40_000] as const;
const OFFER_ALERT_VOLUME = 0.35;

type OptionalAudioPlayer = {
  volume: number;
  loop: boolean;
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => Promise<void>;
  remove?: () => void;
};

type OptionalAudioModule = {
  createAudioPlayer: (source: number) => OptionalAudioPlayer;
  setAudioModeAsync: (mode: {
    playsInSilentMode: boolean;
    interruptionMode: 'mixWithOthers';
  }) => Promise<void>;
};

// Les anciens development builds n'embarquent pas encore ExpoAudio. Le charger
// seulement à l'ouverture de l'offre laisse l'aperçu fonctionnel et silencieux
// sur ces builds, tandis que le prochain build jouera bien le son.
function loadOptionalAudio(): OptionalAudioModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-audio') as OptionalAudioModule;
  } catch {
    return null;
  }
}

function previewOffer(): { offer: DispatchOffer; order: DriverOrder } {
  const now = new Date();
  return {
    offer: {
      id: 'preview',
      orderId: 'preview-order',
      driverId: 'preview-driver',
      round: 1,
      radiusKm: 2,
      status: 'ACTIVE',
      version: 1,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: now.toISOString(),
      respondedAt: null
    },
    order: {
      id: 'preview-order',
      publicReference: 'APERÇU',
      merchantId: 'preview-merchant',
      driverId: null,
      zoneId: 'preview-zone',
      status: 'AVAILABLE',
      version: 1,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      pickupScheduledAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      orderDetails: '1 sac repas, 1 boisson et 1 dessert',
      deliveryInstructions: 'Sonnez à l’interphone, bâtiment B.',
      deliveryAddressComplement: null,
      pickupAddress: '12 rue de la République, Aix-les-Bains',
      pickupLat: 45.689,
      pickupLng: 5.909,
      deliveryAddress: '8 avenue du Grand Port, Aix-les-Bains',
      deliveryLat: 45.692,
      deliveryLng: 5.915,
      distanceM: 1_400,
      durationS: 480,
      priceCents: 650,
      deliveryCents: 650,
      serviceFeeCents: null,
      cashOnDelivery: { required: true, amountCents: 2480, currency: 'eur', collected: false },
      assignedAt: null,
      collectedAt: null,
      completedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      merchantName: 'Le Comptoir Savoyard',
      merchantPhone: '04 79 00 00 00'
    }
  };
}

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1_000));
}

function formatCountdown(seconds: number): string {
  return `0:${seconds.toString().padStart(2, '0')}`;
}

export default function DispatchOfferModal() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  // La route preview ne lit ni n'écrit le serveur : elle affiche uniquement
  // les données locales ci-dessus pour travailler l'interface.
  const isPreview = id === 'preview';
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [remaining, setRemaining] = useState(60);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'order' | 'driver' | null>(null);
  // Une seule décision (accepter/refuser/expiration locale) par offre — évite
  // un double-tap ou un tap juste après expiration de relancer un second
  // appel réseau pendant que le premier est encore en vol.
  const decidedRef = useRef(false);

  useEffect(() => {
    if (isPreview) {
      const { offer, order } = previewOffer();
      setState({ status: 'ready', offer, order });
      setRemaining(remainingSeconds(offer.expiresAt));
      return;
    }
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
  }, [id, isPreview]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const intervalId = setInterval(() => {
      setRemaining(remainingSeconds(state.offer.expiresAt));
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [state]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const audio = loadOptionalAudio();
    if (audio === null) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const expiresAt = new Date(state.offer.expiresAt).getTime();
    let player: OptionalAudioPlayer;

    try {
      player = audio.createAudioPlayer(dispatchOfferSound);
    } catch {
      return;
    }

    // Son volontairement discret : il utilise le volume média de l'appareil
    // et ne prend pas le contrôle de l'audio d'une autre app.
    void audio.setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(() => undefined);
    player.volume = OFFER_ALERT_VOLUME;
    player.loop = false;

    for (const delay of OFFER_ALERT_REPEAT_DELAYS_MS) {
      timers.push(setTimeout(() => {
        if (cancelled || Date.now() >= expiresAt) return;
        void player.seekTo(0).then(() => {
          if (!cancelled) player.play();
        }).catch(() => undefined);
      }, delay));
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      player.pause();
      void player.seekTo(0);
      player.remove?.();
    };
  }, [state]);

  const isExpired = state.status === 'ready' && remaining <= 0;

  async function handleAccept() {
    if (state.status !== 'ready' || decidedRef.current) return;
    if (isPreview) {
      setAccepted(true);
      showToast('Aperçu uniquement — aucune course n’a été acceptée.');
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      router.dismissTo('/(tabs)/orders');
      return;
    }
    decidedRef.current = true;
    setIsSubmitting(true);
    try {
      await api.acceptDispatchOffer(state.offer.id, state.offer.version);
      setAccepted(true);
      showToast('Course acceptée ✓');
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      router.dismissTo('/(tabs)/orders');
    } catch (err) {
      decidedRef.current = false;
      setIsSubmitting(false);
      if (err instanceof ApiError && err.status === 409) {
        showToast('Trop tard, cette offre a expiré.');
        router.back();
        return;
      }
      if (err instanceof ApiError && err.code === 'DriverCompanyProfileNotReady') {
        showToast('Complétez « Mon entreprise » avant de prendre des courses.');
        router.replace('/compte/mon-compte');
        return;
      }
      if (err instanceof ApiError && err.code === 'DriverMandateNotReady') {
        showToast('Signez votre mandat de facturation avant de prendre des courses.');
        router.replace('/compte/mes-factures');
        return;
      }
      showToast(err instanceof ApiError ? err.message : 'Impossible d’accepter cette course.');
    }
  }

  async function handleReject() {
    if (state.status !== 'ready' || decidedRef.current) return;
    if (isPreview) {
      router.back();
      return;
    }
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
      <View className="flex-row items-center px-page-mobile py-3">
        <View className="flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary-50 px-3 py-2">
          <Clock size={18} color={EMERALD_600} />
          <Text className="font-sans-semibold text-body text-primary-700">Répondez dans</Text>
          <Text className="font-sans-bold text-h3 text-primary-700">{formatCountdown(remaining)}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 16 }}>
        <View className="gap-1">
          <Text className="font-sans-bold text-h2 text-stone-800">Nouvelle course</Text>
          {isPreview && <Text className="font-sans text-body text-stone-500">Aperçu uniquement — aucune course réelle.</Text>}
        </View>

        <PickupDeliverySummary
          pickupLabel={formatPickupLabel(order.pickupScheduledAt, order.createdAt)}
          deliveryLabel={formatDeliveryTimeEstimate(order.pickupScheduledAt, order.createdAt, order.collectedAt, order.durationS)}
        />

        {order.cashOnDelivery?.required === true && order.cashOnDelivery.amountCents !== null && (
          <View className="flex-row items-center gap-3 rounded-xl border border-accent-200 bg-accent-100 p-4">
            <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-200">
              <CreditCard size={22} color="#B45309" />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="font-sans-semibold text-body text-accent-800">Encaissement à la livraison</Text>
            </View>
            <Text className="font-sans-bold text-body-lg text-accent-800">{formatPriceEuros(order.cashOnDelivery.amountCents)}</Text>
          </View>
        )}

        <SenderCard
          merchantName={order.merchantName}
          merchantPhone={order.merchantPhone}
          pickupAddress={order.pickupAddress}
          onOpenPhone={(phone) => void openPhone(phone)}
          onOpenMaps={() => void openMaps({ latitude: order.pickupLat, longitude: order.pickupLng, label: order.merchantName })}
        />

        <RecipientCard
          masked
          customerName={null}
          customerPhone={null}
          deliveryAddress={order.deliveryAddress}
          deliveryAddressComplement={order.deliveryAddressComplement}
          onOpenPhone={(phone) => void openPhone(phone)}
          onOpenMaps={() => void openMaps({ latitude: order.deliveryLat, longitude: order.deliveryLng, label: 'Livraison' })}
        />

        <DetailsSection title="Détails commande" icon={<Package size={20} color={EMERALD_600} />} expanded={expandedSection === 'order'} onToggle={() => setExpandedSection((current) => current === 'order' ? null : 'order')}>
          {order.orderDetails !== null && <Text className="font-sans text-body-lg text-stone-800">{order.orderDetails}</Text>}
        </DetailsSection>

        <DetailsSection title="Informations livreur" icon={<Route size={20} color={BLUE_500} />} expanded={expandedSection === 'driver'} onToggle={() => setExpandedSection((current) => current === 'driver' ? null : 'driver')}>
          <View className="gap-1">
            <Text className="font-sans-semibold text-body text-stone-500">Référence</Text>
            <Text className="font-sans text-body-lg text-stone-800">#{order.publicReference}</Text>
          </View>
          {order.deliveryInstructions !== null && (
            <View className="gap-1">
              <Text className="font-sans-semibold text-body text-stone-500">Consignes de livraison</Text>
              <Text className="rounded-lg bg-stone-100 p-3 font-sans text-body text-stone-700">{order.deliveryInstructions}</Text>
            </View>
          )}
        </DetailsSection>

        <View className="flex-row gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="flex-1 gap-1">
            <Route size={20} color={STONE_500} />
            <Text className="font-sans-semibold text-body text-stone-500">Distance</Text>
            <Text className="font-sans-bold text-body-lg text-stone-800">{formatDistanceKm(order.distanceM)}</Text>
          </View>
          <View className="flex-1 gap-1 border-l border-border pl-3">
            <Clock size={20} color={BLUE_500} />
            <Text className="font-sans-semibold text-body text-stone-500">Durée</Text>
            <Text className="font-sans-bold text-body-lg text-stone-800">{formatDurationMin(order.durationS)}</Text>
          </View>
          <View className="flex-1 gap-1 border-l border-border pl-3">
            <Euro size={20} color={EMERALD_600} />
            <Text className="font-sans-semibold text-body text-stone-500">Gain</Text>
            <Text className="font-sans-bold text-body-lg text-primary-700">{formatPriceEuros(order.deliveryCents ?? order.priceCents)}</Text>
          </View>
        </View>
      </ScrollView>

      <View className="flex-row gap-3 px-page-mobile pb-6 pt-2">
        <HoldActionButton label="Refuser" variant="secondary" disabled={isSubmitting || accepted || isExpired} onComplete={handleReject} />
        <HoldActionButton label="Accepter" variant="primary" disabled={isSubmitting || accepted || isExpired} confirmed={accepted} onComplete={handleAccept} />
      </View>
    </SafeAreaView>
  );
}
