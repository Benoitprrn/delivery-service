import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import SignatureScreen, { type SignatureViewRef } from 'react-native-signature-canvas';
import { WHITE } from '../lib/colors';

type Props = {
  onSubmit: (imageBase64: string) => Promise<void>;
  disabled?: boolean;
};

// Copie dédiée de components/proof-signature.tsx (Tranche 4c, plan §15.2) : texte/comportement
// distincts d'une preuve de livraison, même technique react-native-signature-canvas déjà éprouvée
// en production — zéro nouvelle dépendance.
const WEB_STYLE = `
  .m-signature-pad--footer { display: none; margin: 0; }
  .m-signature-pad--body { border: none; }
  .m-signature-pad { box-shadow: none; border: none; }
  body,html { background-color: ${WHITE}; }
`;

export function MandateSignaturePad({ onSubmit, disabled = false }: Props) {
  const ref = useRef<SignatureViewRef>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleOK(dataUrl: string) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    setIsSubmitting(true);
    try {
      await onSubmit(base64);
    } finally {
      setIsSubmitting(false);
    }
  }

  const busy = disabled || isSubmitting;

  return (
    <View className="gap-4">
      <View className="h-48 overflow-hidden rounded-2xl border-2 border-border bg-surface">
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
          disabled={busy}
          className="h-touch-comfortable flex-1 items-center justify-center rounded-lg border-2 border-border disabled:opacity-50"
        >
          <Text className="font-sans-bold text-body-lg text-stone-600">Effacer</Text>
        </Pressable>
        <Pressable
          onPress={() => ref.current?.readSignature()}
          disabled={busy || isEmpty}
          className="h-touch-comfortable flex-1 items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
        >
          {isSubmitting ? <ActivityIndicator color={WHITE} /> : <Text className="font-sans-bold text-body-lg text-white">Signer et accepter</Text>}
        </Pressable>
      </View>
    </View>
  );
}
