import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, CircleHelp, CreditCard, LogOut, ShieldAlert } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { EMERALD_600 } from '../../../lib/colors';
import { getWeeklyEarnings } from '../../../lib/earnings';
import { formatPriceEuros } from '../../../lib/format';
import { useAuth } from '../../../lib/auth-context';
import { showToast } from '../../../lib/toast';
import type { DriverEarnings } from '../../../lib/wallet-types';

function driverName(user: ReturnType<typeof useAuth>['user']): string {
  const metadata = user?.user_metadata ?? {};
  const firstName = typeof metadata.first_name === 'string' ? metadata.first_name : '';
  const lastName = typeof metadata.last_name === 'string' ? metadata.last_name : '';
  const fullName = typeof metadata.full_name === 'string' ? metadata.full_name : typeof metadata.name === 'string' ? metadata.name : '';
  return `${firstName} ${lastName}`.trim() || fullName || 'Livreur Terminus';
}

function InitialsAvatar({ name, size = 'h-16 w-16' }: { name: string; size?: string }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'L';
  return (
    <View className={`${size} items-center justify-center rounded-full bg-primary-100`}>
      <Text className="font-sans-bold text-h3 text-primary-700">{initials}</Text>
    </View>
  );
}

function Chevron() {
  return <ChevronRight size={22} color="#78716C" />;
}

export default function AccountScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [earnings, setEarnings] = useState<DriverEarnings | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const loadEarnings = useCallback(async () => {
    try {
      setEarnings(await api.getMyEarnings());
    } catch {
      // La carte reste lisible avec un tiret si le réseau est temporairement indisponible.
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadEarnings();
  }, [loadEarnings]));

  const name = driverName(user);
  const thisWeek = useMemo(
    () => getWeeklyEarnings(earnings?.recentCompletedOrders ?? [])[0] ?? { totalCents: 0, completedOrderCount: 0 },
    [earnings]
  );

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
          <Pressable onPress={() => router.push('/compte/mon-compte')} className="rounded-2xl border border-border bg-surface p-4 shadow-sm active:opacity-75">
            <View className="flex-row items-center gap-3">
              <InitialsAvatar name={name} />
              <View className="flex-1 gap-1">
                <Text className="font-sans-bold text-h3 text-stone-800">{name}</Text>
                <View className="flex-row items-center gap-1.5">
                  <ShieldAlert size={16} color="#DC2626" />
                  <Text className="font-sans-semibold text-body text-red-600">Non vérifié</Text>
                </View>
              </View>
              <Chevron />
            </View>
          </Pressable>

          <Pressable onPress={() => router.push('/compte/wallet')} className="rounded-2xl border border-border bg-surface p-4 shadow-sm active:opacity-75">
            <View className="flex-row items-start gap-3">
              <View className="h-12 w-12 items-center justify-center rounded-full bg-primary-100">
                <CreditCard size={23} color={EMERALD_600} />
              </View>
              <View className="flex-1 gap-1">
                <Text className="font-sans-bold text-h3 text-stone-800">Wallet</Text>
                {earnings === null ? (
                  <ActivityIndicator color={EMERALD_600} />
                ) : (
                  <>
                    <Text className="font-sans-bold text-h2 text-primary-700">{formatPriceEuros(thisWeek.totalCents)}</Text>
                    <Text className="font-sans text-body text-stone-500">
                      {thisWeek.completedOrderCount} course{thisWeek.completedOrderCount > 1 ? 's' : ''} cette semaine
                    </Text>
                  </>
                )}
              </View>
              <Chevron />
            </View>
          </Pressable>

          <View className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <View className="flex-row items-center gap-2 border-b border-border px-4 py-3">
              <CircleHelp size={20} color={EMERALD_600} />
              <Text className="font-sans-bold text-body-lg text-stone-800">Centre d'aide</Text>
            </View>
            <Pressable onPress={() => showToast('Bientôt disponible')} className="min-h-touch-comfortable flex-row items-center px-4 active:bg-stone-50">
              <Text className="flex-1 font-sans text-body-lg text-stone-700">FAQ</Text>
              <Chevron />
            </Pressable>
            <Pressable onPress={() => showToast('Bientôt disponible')} className="min-h-touch-comfortable flex-row items-center border-t border-border px-4 active:bg-stone-50">
              <Text className="flex-1 font-sans text-body-lg text-stone-700">Contacter l'assistance</Text>
              <Chevron />
            </Pressable>
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
