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
import { formatPriceEuros } from '../../../lib/format';
import { resolveReaderFamily } from '../../../lib/terminal/terminal-mode';
import { showToast } from '../../../lib/toast';

type ProofScreenState = 'code' | 'method' | 'signature' | 'photo';

const SUCCESS_MESSAGE: Record<DeliveryProof['method'], string> = {
  code: 'Livraison confirmée par code ✓',
  signature: 'Livraison confirmée par signature ✓',
  photo: 'Livraison confirmée par photo ✓'
};

export default function DeliveryProofModal() {
  const router = useRouter();
  const { id, version, codAmountCents } = useLocalSearchParams<{ id: string; version: string; codAmountCents?: string }>();
  const isCashOnDelivery = codAmountCents !== undefined;
  const [screen, setScreen] = useState<ProofScreenState>('code');
  const expectedVersion = Number(version);

  async function submitProof(proof: DeliveryProof) {
    if (isCashOnDelivery) {
      // COD : le code est vérifié par le serveur, qui crée la session et le paiement ; la commande
      // ne se termine qu'après l'encaissement (écran de paiement), jamais ici.
      if (proof.method !== 'code') return;
      const result = await api.createCompletionSession(id, expectedVersion, proof.code, resolveReaderFamily());
      if (result.status === 'completed') {
        showToast(SUCCESS_MESSAGE.code);
        router.dismissAll();
        return;
      }
      router.replace({ pathname: '/order/[id]/payment', params: { id } });
      return;
    }
    try {
      await api.completeOrder(id, expectedVersion, proof);
    } catch (err) {
      // Le paiement doit être encaissé avant de terminer un COD (le serveur reste l'autorité).
      if (err instanceof ApiError && err.code === 'CashOnDeliveryPaymentRequired') {
        throw new ApiError(err.status, 'Le paiement par carte doit être encaissé avant de terminer cette livraison.', undefined, err.code);
      }
      throw err;
    }
    showToast(SUCCESS_MESSAGE[proof.method]);
    // La preuve est ouverte depuis le détail, lui-même modal depuis la
    // timeline. Fermer toute la pile modale force le retour sur l'onglet,
    // dont useFocusEffect recharge la commande avec son statut final.
    router.dismissAll();
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
      router.dismissAll();
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

      {isCashOnDelivery && (
        <View className="mx-page-mobile mb-2 rounded-xl border border-border bg-stone-100 p-4">
          <Text className="font-sans-bold text-h3 text-stone-800">
            Paiement à la livraison — {formatPriceEuros(Number(codAmountCents))}
          </Text>
          <Text className="mt-1 font-sans text-body-lg text-stone-600">
            Code du client puis paiement par carte : la livraison ne se termine qu'après l'encaissement.
          </Text>
        </View>
      )}

      <View className="flex-1 justify-center px-page-mobile">
        {screen === 'code' && (
          <ProofCodeEntry
            onSubmit={submitProof}
            onNeedAlternative={() =>
              isCashOnDelivery
                ? Alert.alert(
                    'Code indisponible',
                    'Le code du client est obligatoire pour une livraison avec paiement. Utilisez « Client absent » si le client ne peut pas le fournir.'
                  )
                : setScreen('method')
            }
          />
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
