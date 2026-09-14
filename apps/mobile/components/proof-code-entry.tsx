import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { ApiError, type DeliveryProof } from '../lib/api';
import { EMERALD_600 } from '../lib/colors';

type Props = {
  onSubmit: (proof: DeliveryProof) => Promise<void>;
  onNeedAlternative: () => void;
};

const DIGIT_COUNT = 4;

export function ProofCodeEntry({ onSubmit, onNeedAlternative }: Props) {
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Array<TextInput | null>>([]);

  const code = digits.join('');

  useEffect(() => {
    if (code.length === DIGIT_COUNT && !isSubmitting) {
      void submit();
    }
    // Volontairement déclenché uniquement par le remplissage du code, pas par
    // isSubmitting (qui changerait de valeur pendant le submit lui-même).
  }, [code]);

  async function submit() {
    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit({ method: 'code', code });
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setError('Une erreur est survenue.');
        resetDigits();
        return;
      }
      if (err.attemptsRemaining !== undefined) {
        setError(
          err.attemptsRemaining > 0
            ? `Code incorrect. Il reste ${err.attemptsRemaining} tentative${err.attemptsRemaining > 1 ? 's' : ''}.`
            : 'Code incorrect. Dernière tentative épuisée.'
        );
        resetDigits();
        if (err.attemptsRemaining === 0) {
          setTimeout(onNeedAlternative, 1500);
        }
      } else if (err.status === 422 || err.status === 423) {
        // Code expiré (422 sans compteur) ou verrouillé (423) — plus rien à
        // tenter côté code, on bascule directement sur la méthode alternative.
        onNeedAlternative();
      } else {
        setError(err.message);
        resetDigits();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function resetDigits() {
    setDigits(Array(DIGIT_COUNT).fill(''));
    inputRefs.current[0]?.focus();
  }

  function handleChange(index: number, value: string) {
    const digit = value.replace(/[^0-9]/g, '').slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    if (digit !== '' && index < DIGIT_COUNT - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyPress(index: number, key: string) {
    if (key === 'Backspace' && digits[index] === '' && index > 0) {
      inputRefs.current[index - 1]?.focus();
      setDigits((prev) => {
        const next = [...prev];
        next[index - 1] = '';
        return next;
      });
    }
  }

  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text className="text-center font-sans-bold text-h3 text-stone-800">Code de livraison</Text>
        <Text className="text-center font-sans text-body-lg text-stone-500">
          Demandez au client le code à 4 chiffres reçu pour cette commande.
        </Text>
      </View>

      <View className="flex-row justify-center gap-3">
        {digits.map((digit, index) => (
          <TextInput
            key={index}
            ref={(ref) => {
              inputRefs.current[index] = ref;
            }}
            value={digit}
            onChangeText={(value) => handleChange(index, value)}
            onKeyPress={(event) => handleKeyPress(index, event.nativeEvent.key)}
            keyboardType="number-pad"
            maxLength={1}
            editable={!isSubmitting}
            autoFocus={index === 0}
            className="h-touch-comfortable w-touch-comfortable rounded-lg border-2 border-border bg-surface text-center font-sans-bold text-h3 text-stone-800"
          />
        ))}
      </View>

      {isSubmitting && <ActivityIndicator color={EMERALD_600} />}
      {error !== null && !isSubmitting && (
        <Text className="text-center font-sans-semibold text-body-lg text-status-cancelled-text">{error}</Text>
      )}

      <Pressable onPress={onNeedAlternative} className="h-touch-comfortable items-center justify-center">
        <Text className="font-sans-semibold text-body-lg text-primary-700 underline">
          Code expiré ou client sans code →
        </Text>
      </Pressable>
    </View>
  );
}
