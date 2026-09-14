import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import SignatureScreen, { type SignatureViewRef } from 'react-native-signature-canvas';
import { ApiError, type DeliveryProof } from '../lib/api';
import { WHITE } from '../lib/colors';
import { showToast } from '../lib/toast';

type Props = {
  onSubmit: (proof: DeliveryProof) => Promise<void>;
};

// Masque le footer par défaut de la lib (boutons Effacer/Valider intégrés à
// la WebView) — on utilise nos propres boutons RN en dessous, cohérents avec
// le reste du design system Terrain plutôt que le style HTML par défaut.
const WEB_STYLE = `
  .m-signature-pad--footer { display: none; margin: 0; }
  .m-signature-pad--body { border: none; }
  .m-signature-pad { box-shadow: none; border: none; }
  body,html { background-color: ${WHITE}; }
`;

export function ProofSignature({ onSubmit }: Props) {
  const ref = useRef<SignatureViewRef>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleOK(dataUrl: string) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    setIsSubmitting(true);
    try {
      await onSubmit({ method: 'signature', imageBase64: base64 });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Une erreur est survenue.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View className="flex-1 gap-4">
      <Text className="text-center font-sans-bold text-h3 text-stone-800">Signature du client</Text>

      <View className="flex-1 overflow-hidden rounded-2xl border-2 border-border bg-surface">
        <SignatureScreen
          ref={ref}
          onOK={(signature) => void handleOK(signature)}
          onEmpty={() => setIsEmpty(true)}
          onBegin={() => setIsEmpty(false)}
          onClear={() => setIsEmpty(true)}
          webStyle={WEB_STYLE}
          autoClear={false}
          descriptionText=""
        />
      </View>

      <View className="flex-row gap-3">
        <Pressable
          onPress={() => ref.current?.clearSignature()}
          disabled={isSubmitting}
          className="h-touch-comfortable flex-1 items-center justify-center rounded-lg border-2 border-border disabled:opacity-50"
        >
          <Text className="font-sans-bold text-body-lg text-stone-600">Effacer</Text>
        </Pressable>
        <Pressable
          onPress={() => ref.current?.readSignature()}
          disabled={isSubmitting || isEmpty}
          className="h-touch-comfortable flex-1 items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
        >
          {isSubmitting ? (
            <ActivityIndicator color={WHITE} />
          ) : (
            <Text className="font-sans-bold text-body-lg text-white">Valider</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
