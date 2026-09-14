import { useLocalSearchParams, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ProofCodeEntry } from '../../../components/proof-code-entry';
import { ProofMethodChoice } from '../../../components/proof-method-choice';
import { ProofPhoto } from '../../../components/proof-photo';
import { ProofSignature } from '../../../components/proof-signature';
import { api, ApiError, type DeliveryProof } from '../../../lib/api';
import { showToast } from '../../../lib/toast';

type ProofScreenState = 'code' | 'method' | 'signature' | 'photo';

const SUCCESS_MESSAGE: Record<DeliveryProof['method'], string> = {
  code: 'Livraison confirmée par code ✓',
  signature: 'Livraison confirmée par signature ✓',
  photo: 'Livraison confirmée par photo ✓'
};

export default function DeliveryProofModal() {
  const router = useRouter();
  const { id, version } = useLocalSearchParams<{ id: string; version: string }>();
  const [screen, setScreen] = useState<ProofScreenState>('code');
  const expectedVersion = Number(version);

  async function submitProof(proof: DeliveryProof) {
    await api.completeOrder(id, expectedVersion, proof);
    showToast(SUCCESS_MESSAGE[proof.method]);
    router.back();
  }

  function handleAbsent() {
    Alert.alert(
      'Client absent',
      'Confirmer que le client est absent ? La commande passera en retour.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Confirmer', style: 'destructive', onPress: () => void confirmAbsent() }
      ]
    );
  }

  async function confirmAbsent() {
    try {
      await api.returnOrder(id, expectedVersion);
      showToast('Client absent — commande en retour');
      router.back();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Une erreur est survenue.');
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-page-mobile py-3">
        <Text className="font-sans text-body-lg text-stone-400">#{id.slice(-6)}</Text>
        <Pressable
          onPress={() => router.back()}
          className="h-touch-comfortable w-touch-comfortable items-center justify-center"
        >
          <X size={24} color="#57534E" />
        </Pressable>
      </View>

      <View className="flex-1 justify-center px-page-mobile">
        {screen === 'code' && (
          <ProofCodeEntry onSubmit={submitProof} onNeedAlternative={() => setScreen('method')} />
        )}
        {screen === 'method' && (
          <ProofMethodChoice
            onChooseSignature={() => setScreen('signature')}
            onChoosePhoto={() => setScreen('photo')}
          />
        )}
        {screen === 'signature' && <ProofSignature onSubmit={submitProof} />}
        {screen === 'photo' && <ProofPhoto onSubmit={submitProof} />}
      </View>

      <View className="px-page-mobile pb-6 pt-2">
        <Pressable
          onPress={handleAbsent}
          className="h-touch-comfortable items-center justify-center rounded-lg border-2 border-border active:bg-stone-100"
        >
          <Text className="font-sans-semibold text-body-lg text-stone-600">Client absent</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
