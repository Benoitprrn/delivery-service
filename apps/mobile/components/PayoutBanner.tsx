import { useRouter } from 'expo-router';
import { ChevronRight, CircleAlert } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { derivePayoutUi } from '../lib/payout-status';
import { usePayoutAccount } from '../lib/payout-account-context';

// Bandeau de l'écran Carte (D-F) : visible tant que le compte de paiement n'est pas prêt, car sans lui aucune course n'est proposée.
export function PayoutBanner() {
  const router = useRouter();
  const { status } = usePayoutAccount();
  if (status.kind !== 'ok') return null;
  const ui = derivePayoutUi(status.account);
  if (ui.ready) return null;
  const message = status.account.state === 'not_created' ? 'Configurez vos paiements pour voir les courses' : `${ui.title} : paiements non activés`;
  return (
    <Pressable
      onPress={() => router.push('/paiements')}
      className="min-h-touch-comfortable flex-row items-center gap-3 border-t border-amber-300 bg-amber-100 px-4 py-3 active:opacity-80"
    >
      <CircleAlert size={22} color="#B45309" />
      <View className="flex-1">
        <Text className="font-sans-semibold text-body text-amber-900">{message}</Text>
        <Text className="font-sans text-body text-amber-800">Sans compte de paiement prêt, aucune course n’est proposée.</Text>
      </View>
      <ChevronRight size={22} color="#B45309" />
    </Pressable>
  );
}
