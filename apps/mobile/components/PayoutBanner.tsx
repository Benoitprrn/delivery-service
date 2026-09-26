import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, TriangleAlert } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { apiRequest } from '../lib/api';
import { derivePayoutUi } from '../lib/payout-status';
import { usePayoutAccount } from '../lib/payout-account-context';

// Bandeau UNIQUE de l'écran Carte : visible tant que le compte n'est pas prêt à recevoir des
// courses, que la cause soit le compte de paiement Stripe (D-F), le dossier « Mon entreprise »
// (D-CP) ou le mandat de facturation non signé (D-MD) — un seul et même message, jamais
// plusieurs bandeaux empilés pour des causes différentes.
export function PayoutBanner() {
  const router = useRouter();
  const { status } = usePayoutAccount();
  const [companyProfileComplete, setCompanyProfileComplete] = useState<boolean | null>(null);
  const [mandateSigned, setMandateSigned] = useState<boolean | null>(null);

  useFocusEffect(useCallback(() => {
    void apiRequest<{ status: { complete: boolean } }>('/api/v1/drivers/me/company-profile')
      .then((value) => setCompanyProfileComplete(value.status.complete))
      .catch(() => setCompanyProfileComplete(null));
    void apiRequest<{ mandateExists: boolean }>('/api/v1/drivers/me/einvoice-mandate')
      .then((value) => setMandateSigned(value.mandateExists))
      .catch(() => setMandateSigned(null));
  }, []));

  if (status.kind !== 'ok') return null;
  const payoutReady = derivePayoutUi(status.account).ready;
  if (payoutReady && companyProfileComplete !== false && mandateSigned !== false) return null;
  // Direction vers la vraie cause, dans l'ordre des gardes serveur : compte de paiement (D-F)
  // d'abord (bloque tout le reste), puis « Mon entreprise » (D-CP), puis le mandat (D-MD).
  const destination = !payoutReady ? '/paiements' : companyProfileComplete === false ? '/compte/mon-compte' : '/compte/mes-factures';
  return (
    <Pressable
      onPress={() => router.push(destination)}
      className="min-h-touch-comfortable flex-row items-center gap-2 border-t border-amber-300 bg-amber-100 px-4 active:opacity-80"
    >
      <TriangleAlert size={20} color="#B45309" />
      <Text className="flex-1 font-sans-semibold text-body text-amber-900">Configurez votre compte pour recevoir des courses.</Text>
      <ChevronRight size={20} color="#B45309" />
    </Pressable>
  );
}
