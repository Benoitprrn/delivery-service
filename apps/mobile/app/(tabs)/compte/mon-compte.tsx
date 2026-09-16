import { useFocusEffect, useRouter } from 'expo-router';
import { Camera, ChevronLeft, FileUp, ShieldAlert } from 'lucide-react-native';
import { BackHandler, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useCallback } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../../lib/auth-context';
import { EMERALD_600 } from '../../../lib/colors';
import { showToast } from '../../../lib/toast';

function Field({ label, value }: { label: string; value?: string | undefined }) {
  return (
    <View className="gap-1.5">
      <Text className="font-sans-semibold text-body text-stone-600">{label}</Text>
      <TextInput value={value ?? ''} editable={false} placeholder="À renseigner" placeholderTextColor="#A8A29E" className="h-touch-comfortable rounded-lg border border-border bg-stone-50 px-3 font-sans text-body-lg text-stone-700" />
    </View>
  );
}

function UploadButton({ label }: { label: string }) {
  return (
    <Pressable onPress={() => showToast('Ajout de document bientôt disponible')} className="h-touch-comfortable flex-row items-center justify-center gap-2 rounded-lg border-2 border-primary-600 active:bg-primary-50">
      <FileUp size={19} color={EMERALD_600} />
      <Text className="font-sans-semibold text-body-lg text-primary-700">{label}</Text>
    </Pressable>
  );
}

export default function MyAccountScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const metadata = user?.user_metadata ?? {};
  const firstName = typeof metadata.first_name === 'string' ? metadata.first_name : '';
  const lastName = typeof metadata.last_name === 'string' ? metadata.last_name : '';
  const fullName = typeof metadata.full_name === 'string' ? metadata.full_name : typeof metadata.name === 'string' ? metadata.name : '';

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/compte');
      return true;
    });
    return () => subscription.remove();
  }, [router]));

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 px-page-mobile py-3">
        <Pressable onPress={() => router.replace('/compte')} className="h-touch-comfortable w-touch-comfortable items-center justify-center">
          <ChevronLeft size={24} color="#44403C" />
        </Pressable>
        <Text className="font-sans-bold text-h3 text-stone-800">Mon compte</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }}>
        <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
          <Text className="font-sans-bold text-h3 text-stone-800">Identité</Text>
          <Pressable onPress={() => showToast('Modification de photo bientôt disponible')} className="items-center gap-2 self-start active:opacity-75">
            <View className="h-20 w-20 items-center justify-center rounded-full bg-primary-100">
              <Camera size={28} color={EMERALD_600} />
            </View>
            <Text className="font-sans-semibold text-body text-primary-700">Modifier la photo</Text>
          </Pressable>
          <Field label="Prénom" value={firstName || fullName.split(' ')[0]} />
          <Field label="Nom" value={lastName || fullName.split(' ').slice(1).join(' ')} />
          <Field label="Date de naissance" />
          <Field label="Téléphone" value={typeof metadata.phone === 'string' ? metadata.phone : ''} />
          <Field label="Email" value={user?.email} />
        </View>

        <View className="gap-4 rounded-2xl border border-border bg-surface p-4">
          <Text className="font-sans-bold text-h3 text-stone-800">Mon entreprise</Text>
          <Field label="Numéro SIRET" />
          <Field label="Nom de l'entreprise" />
          <Field label="Adresse de l'entreprise" />
          <UploadButton label="Joindre Kbis" />
          <UploadButton label="Joindre pièce d'identité" />
        </View>

        <View className="flex-row items-center gap-2 rounded-xl bg-red-50 px-3 py-3">
          <ShieldAlert size={20} color="#DC2626" />
          <Text className="font-sans-semibold text-body-lg text-red-600">Non vérifié</Text>
        </View>
        <Pressable onPress={() => showToast('Enregistrement bientôt disponible')} className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700">
          <Text className="font-sans-bold text-body-lg text-white">Enregistrer</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
