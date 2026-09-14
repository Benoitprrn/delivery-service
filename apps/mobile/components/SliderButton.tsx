import { ArrowRight, Check } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import {
  PanGestureHandler,
  State,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent
} from 'react-native-gesture-handler';
import { ApiError } from '../lib/api';
import { EMERALD_600, EMERALD_700, STONE_500, WHITE } from '../lib/colors';
import { showToast } from '../lib/toast';

// TRACK_HEIGHT reste le plancher exact de la règle Terrain (zone tactile
// ≥52px) — c'est le rail entier qui capte le geste (voir le
// PanGestureHandler plus bas), pas THUMB_SIZE isolé, donc ce dernier peut
// être plus petit sans violer la règle.
const TRACK_HEIGHT = 52;
const THUMB_SIZE = 36;
const TRACK_PADDING = 6;
const THRESHOLD_RATIO = 0.95;
const CONFLICT_MESSAGE_MS = 2500;

const COLORS = {
  trackIdle: '#F5F5F4', // stone-100
  trackFilled: EMERALD_600,
  thumb: EMERALD_600,
  thumbFilled: EMERALD_700,
  labelIdle: STONE_500,
  labelFilled: WHITE,
  conflictText: '#B91C1C' // status-cancelled-text
};

type SliderState = 'idle' | 'submitting' | 'success' | 'conflict';

type SliderButtonProps = {
  label: string;
  onComplete: () => Promise<void>;
  onSuccess: () => void;
};

export function SliderButton({ label, onComplete, onSuccess }: SliderButtonProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [state, setState] = useState<SliderState>('idle');
  // useNativeDriver: false partout ici — on doit pouvoir re-clamper la
  // valeur en JS à chaque event (listener plus bas), ce qui est incompatible
  // avec le driver natif sur ce même Animated.Value.
  const translateX = useRef(new Animated.Value(0)).current;
  const conflictTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const maxTranslate = Math.max(0, trackWidth - THUMB_SIZE - TRACK_PADDING * 2);
  const isDisabled = state !== 'idle';
  const isFilled = state === 'submitting' || state === 'success';

  const fillWidth = Animated.add(translateX, new Animated.Value(THUMB_SIZE + TRACK_PADDING * 2));

  useEffect(() => {
    return () => {
      if (conflictTimer.current !== null) clearTimeout(conflictTimer.current);
    };
  }, []);

  function onTrackLayout(event: LayoutChangeEvent) {
    setTrackWidth(event.nativeEvent.layout.width);
  }

  function springBack() {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
  }

  const onGestureEvent = Animated.event([{ nativeEvent: { translationX: translateX } }], {
    useNativeDriver: false,
    listener: (event: PanGestureHandlerGestureEvent) => {
      const raw = event.nativeEvent.translationX;
      const clamped = Math.min(Math.max(raw, 0), maxTranslate);
      if (clamped !== raw) {
        translateX.setValue(clamped);
      }
    }
  });

  async function onHandlerStateChange(event: PanGestureHandlerStateChangeEvent) {
    if (event.nativeEvent.oldState !== State.ACTIVE || state !== 'idle') {
      return;
    }

    const finalX = Math.min(Math.max(event.nativeEvent.translationX, 0), maxTranslate);
    const ratio = maxTranslate === 0 ? 0 : finalX / maxTranslate;

    if (ratio < THRESHOLD_RATIO) {
      springBack();
      return;
    }

    Animated.timing(translateX, { toValue: maxTranslate, duration: 100, useNativeDriver: false }).start();
    setState('submitting');

    try {
      await onComplete();
      setState('success');
      setTimeout(onSuccess, 500);
    } catch (err) {
      springBack();
      if (err instanceof ApiError && err.status === 409) {
        setState('conflict');
        conflictTimer.current = setTimeout(() => setState('idle'), CONFLICT_MESSAGE_MS);
      } else {
        showToast(err instanceof ApiError ? err.message : 'Une erreur est survenue.');
        setState('idle');
      }
    }
  }

  const labelText = state === 'success' ? '✓ Course prise' : state === 'conflict' ? 'Course déjà prise' : label;
  const labelColor = state === 'conflict' ? COLORS.conflictText : isFilled ? COLORS.labelFilled : COLORS.labelIdle;

  return (
    // Le PanGestureHandler enveloppe tout le rail (56px), pas seulement le
    // thumb (44px) — sinon la zone qui capte réellement le geste ne fait
    // que 44px, sous le minimum Terrain de 52px, même si le rail visible
    // paraît saisissable sur toute sa hauteur. Trouvé lors de l'audit
    // responsive post-étape 10.
    <PanGestureHandler
      onGestureEvent={onGestureEvent}
      onHandlerStateChange={(event) => void onHandlerStateChange(event)}
      enabled={!isDisabled}
    >
      <View
        onLayout={onTrackLayout}
        style={[styles.track, { backgroundColor: isFilled ? COLORS.trackFilled : COLORS.trackIdle }]}
      >
        {/* Remplissage progressif derrière le thumb pendant le glissement —
            largeur animée = position du thumb, donc "fond devient
            progressivement vert" tombe naturellement de l'animation du
            geste, sans état dédié. En style inline (pas className) :
            NativeWind n'applique pas de façon fiable les classes sur les
            composants Animated.*, c'est ce qui rendait le thumb précédent
            invisible. */}
        <Animated.View pointerEvents="none" style={[styles.fill, { width: fillWidth, backgroundColor: COLORS.trackFilled }]} />

        <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
          {labelText}
        </Text>

        <Animated.View
          style={[
            styles.thumb,
            { backgroundColor: state === 'submitting' ? COLORS.thumbFilled : COLORS.thumb, transform: [{ translateX }] }
          ]}
        >
          {state === 'submitting' ? (
            <ActivityIndicator color={WHITE} size="small" />
          ) : state === 'success' ? (
            <Check size={20} color={WHITE} />
          ) : (
            <ArrowRight size={20} color={WHITE} />
          )}
        </Animated.View>
      </View>
    </PanGestureHandler>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    justifyContent: 'center',
    overflow: 'hidden'
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0
  },
  label: {
    textAlign: 'center',
    fontFamily: 'DM Sans SemiBold',
    fontSize: 16
  },
  thumb: {
    position: 'absolute',
    left: TRACK_PADDING,
    top: TRACK_PADDING,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  }
});
