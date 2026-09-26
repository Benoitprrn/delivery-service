import { Check } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { WHITE } from '../lib/colors';

// Geste volontaire : un simple tap ne suffit jamais pour une action irréversible (collecte,
// livraison, refus/acceptation d'offre) — il faut maintenir 0,5 s, comme dispatch-offer.
const HOLD_DURATION_MS = 500;

type HoldActionButtonProps = {
  label: string;
  variant: 'primary' | 'secondary';
  disabled: boolean;
  confirmed?: boolean;
  onComplete: () => Promise<void>;
};

export function HoldActionButton({ label, variant, disabled, confirmed = false, onComplete }: HoldActionButtonProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const confirmationScale = useRef(new Animated.Value(0)).current;
  const completedRef = useRef(false);

  useEffect(() => {
    if (!confirmed) {
      confirmationScale.setValue(0);
      return;
    }
    Animated.spring(confirmationScale, { toValue: 1, useNativeDriver: true, friction: 5, tension: 130 }).start();
  }, [confirmationScale, confirmed]);

  function reset() {
    progress.stopAnimation();
    progress.setValue(0);
    completedRef.current = false;
  }

  function start() {
    if (disabled) return;
    completedRef.current = false;
    progress.setValue(0);
    Animated.timing(progress, { toValue: 1, duration: HOLD_DURATION_MS, useNativeDriver: false }).start(({ finished }) => {
      if (!finished) return;
      completedRef.current = true;
      void onComplete().finally(reset);
    });
  }

  function cancel() {
    if (!completedRef.current) reset();
  }

  const isPrimary = variant === 'primary';
  const fillWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityHint="Maintenez ce bouton pendant une demi-seconde pour confirmer"
      className={`h-touch-comfortable flex-1 overflow-hidden rounded-lg border disabled:opacity-50 ${isPrimary ? 'border-primary-600 bg-primary-600' : 'border-border bg-surface'}`}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.holdFill, { width: fillWidth, backgroundColor: isPrimary ? '#047857' : '#E7E5E4' }]}
      />
      <View className="flex-1 items-center justify-center">
        <View className="flex-row items-center gap-1.5">
          {confirmed && (
            <Animated.View style={{ transform: [{ scale: confirmationScale }] }}>
              <Check size={19} color={WHITE} strokeWidth={3} />
            </Animated.View>
          )}
          <Text className={`font-sans-bold text-body ${isPrimary ? 'text-white' : 'text-stone-700'}`}>{label}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  holdFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0
  }
});
