import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, CircleHelp, CreditCard, FileText, LogOut, TriangleAlert, UserRound } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../../lib/auth-context';
import { EMERALD_600 } from '../../../lib/colors';
import { apiRequest } from '../../../lib/api';
import { usePayoutAccount } from '../../../lib/payout-account-context';
import { derivePayoutUi } from '../../../lib/payout-status';

type AccountDestination = '/compte/mon-compte' | '/compte/mes-paiements' | '/compte/mes-factures';

function AccountEntry({
  label,
  icon,
  destination
}: {
  label: string;
  icon: React.ReactNode;
  destination: AccountDestination;
}) {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push(destination)}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="min-h-touch-comfortable flex-row items-center gap-3 px-4 py-3 active:bg-stone-50"
    >
      <View className="h-11 w-11 items-center justify-center rounded-full bg-primary-100">{icon}</View>
      <Text className="flex-1 font-sans-semibold text-body-lg text-stone-800">{label}</Text>
      <ChevronRight size={22} color="#78716C" />
    </Pressable>
  );
}

export default function AccountScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { status: payoutStatus } = usePayoutAccount();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [companyComplete, setCompanyComplete] = useState<boolean | null>(null);
  const [mandateSigned, setMandateSigned] = useState<boolean | null>(null);

  useFocusEffect(useCallback(() => {
    void apiRequest<{ status: { complete: boolean } }>('/api/v1/drivers/me/company-profile')
      .then((value) => setCompanyComplete(value.status.complete))
      .catch(() => setCompanyComplete(null));
    void apiRequest<{ mandateExists: boolean }>('/api/v1/drivers/me/einvoice-mandate')
      .then((value) => setMandateSigned(value.mandateExists))
      .catch(() => setMandateSigned(null));
  }, []));

  const payoutNotReady = payoutStatus.kind === 'ok' && !derivePayoutUi(payoutStatus.account).ready;

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut();
      router.replace('/login');
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingVertical: 16 }}>
        <View className="flex-1 gap-4">
          <Text className="font-sans-bold text-h2 text-stone-800">Mon Compte</Text>

          <View className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <View className="relative"><AccountEntry label="Mon entreprise" destination="/compte/mon-compte" icon={<UserRound size={22} color={EMERALD_600} />}/>{companyComplete === false && <View className="absolute right-12 top-0 bottom-0 justify-center" pointerEvents="none"><TriangleAlert size={20} color="#B45309"/></View>}</View>
            <View className="ml-[72px] border-t border-border" />
            <View className="relative"><AccountEntry label="Mes paiements" destination="/compte/mes-paiements" icon={<CreditCard size={22} color={EMERALD_600} />} />{payoutNotReady && <View className="absolute right-12 top-0 bottom-0 justify-center" pointerEvents="none"><TriangleAlert size={20} color="#B45309"/></View>}</View>
            <View className="ml-[72px] border-t border-border" />
            <View className="relative"><AccountEntry label="Mes factures" destination="/compte/mes-factures" icon={<FileText size={22} color={EMERALD_600} />} />{mandateSigned === false && <View className="absolute right-12 top-0 bottom-0 justify-center" pointerEvents="none"><TriangleAlert size={20} color="#B45309"/></View>}</View>
          </View>

          <View className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <View className="flex-row items-center gap-3 px-4 py-3">
              <View className="h-11 w-11 items-center justify-center rounded-full bg-primary-100">
                <CircleHelp size={22} color={EMERALD_600} />
              </View>
              <Text className="font-sans-semibold text-body-lg text-stone-800">Centre d’aide</Text>
            </View>
            <View className="ml-[72px] border-t border-border" />
            <View className="min-h-touch-comfortable flex-row items-center gap-3 px-4 pl-[72px]">
              <Text className="flex-1 font-sans text-body-lg text-stone-700">FAQ</Text>
              <ChevronRight size={22} color="#78716C" />
            </View>
            <View className="ml-[72px] border-t border-border" />
            <View className="min-h-touch-comfortable flex-row items-center gap-3 px-4 pl-[72px]">
              <Text className="flex-1 font-sans text-body-lg text-stone-700">Contacter l’assistance</Text>
              <ChevronRight size={22} color="#78716C" />
            </View>
          </View>

          <View className="flex-1" />
          <Pressable
            onPress={() => void handleSignOut()}
            disabled={isSigningOut}
            className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg bg-red-600 active:bg-red-700 disabled:opacity-50"
          >
            {isSigningOut ? <ActivityIndicator color="#FFFFFF" /> : <LogOut size={20} color="#FFFFFF" />}
            <Text className="font-sans-bold text-body-lg text-white">Se déconnecter</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
