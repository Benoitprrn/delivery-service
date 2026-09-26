import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAvailability } from '../lib/availability-context';
import { usePayoutAccount } from '../lib/payout-account-context';
import { derivePayoutUi } from '../lib/payout-status';
import { EMERALD_600, STONE_200, WHITE } from '../lib/colors';
import { showToast } from '../lib/toast';

const UNAVAILABLE_RED = '#DC2626';
const TRACK_WIDTH = 56;
const TRACK_HEIGHT = 32;
const THUMB_SIZE = 24;
const TRACK_PADDING = 4;

export function AvailabilityToggle() {
  const { available, resolving, updating, toggle } = useAvailability();
  const { status: payoutStatus } = usePayoutAccount();
  // D-F côté UX seulement (le vrai blocage est déjà serveur, voir orders/
  // list-available-orders.ts et assign-order.ts) : passer disponible sans
  // compte de paiement prêt ne proposerait de toute façon aucune course,
  // donc autant ne jamais allumer le bascule plutôt que laisser un état vert
  // trompeur. Couper reste toujours permis, quel que soit l'état paiement.
  const payoutReady = payoutStatus.kind === 'ok' && derivePayoutUi(payoutStatus.account).ready;
  const progress = useRef(new Animated.Value(available ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: available ? 1 : 0,
      useNativeDriver: false,
      friction: 8,
      tension: 90
    }).start();
  }, [available, progress]);

  async function handlePress() {
    if (updating || resolving) return;
    if (!available && !payoutReady) {
      showToast('Configurez vos paiements pour recevoir des courses');
      // Reste sur place : un aller-retour rouge -> vert -> rouge suffit à
      // signaler le refus sans quitter l'écran (voir bandeau pour naviguer).
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: 150, useNativeDriver: false }),
        Animated.timing(progress, { toValue: 0, duration: 250, useNativeDriver: false })
      ]).start();
      return;
    }
    await toggle();
  }

  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [STONE_200, EMERALD_600]
  });
  const thumbColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [UNAVAILABLE_RED, WHITE]
  });
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [TRACK_PADDING, TRACK_WIDTH - THUMB_SIZE - TRACK_PADDING]
  });

  return (
    <View className="min-h-touch-comfortable flex-row items-center justify-between px-page-mobile">
      <Text className="font-sans-semibold text-body-lg text-stone-800">
        {available ? 'Vous êtes disponible' : 'Vous êtes indisponible'}
      </Text>
      <Pressable
        onPress={() => void handlePress()}
        disabled={updating || resolving}
        accessibilityRole="switch"
        accessibilityLabel="Disponibilité pour recevoir des courses"
        accessibilityState={{ checked: available, disabled: updating || resolving }}
        className="h-touch-comfortable w-16 items-center justify-center disabled:opacity-70"
      >
        <Animated.View style={[styles.track, { backgroundColor: trackColor }]}>
          <Animated.View style={[styles.thumb, { backgroundColor: thumbColor, transform: [{ translateX }] }]}>
            {updating && <ActivityIndicator size="small" color={available ? EMERALD_600 : UNAVAILABLE_RED} />}
          </Animated.View>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    justifyContent: 'center'
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  }
});
