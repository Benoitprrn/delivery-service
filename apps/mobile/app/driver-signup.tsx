import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft } from 'lucide-react-native';
import { EMERALD_600, STONE_800, WHITE } from '../lib/colors';
import { supabase } from '../lib/supabase';
import { api, ApiError } from '../lib/api';
import { Checkbox } from '../components/Checkbox';

// Même gris que app/login.tsx (pas de constante colors.ts pour ce ton précis).
const PLACEHOLDER_GRAY = '#A8A29E';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isLikelyFrenchPhone(value: string): boolean {
  const compact = value.trim().replace(/[\s.-]/g, '');
  return /^0[1-9]\d{8}$/.test(compact) || /^\+33[1-9]\d{8}$/.test(compact);
}

function isStrongPassword(value: string): boolean {
  return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function PasswordRequirement({ met, children }: { met: boolean; children: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <View className={`h-5 w-5 items-center justify-center rounded-full ${met ? 'bg-primary-100' : 'bg-stone-100'}`}>
        {met && <Check size={13} color={EMERALD_600} strokeWidth={3} />}
      </View>
      <Text className={`font-sans text-body-sm ${met ? 'text-primary-700' : 'text-stone-500'}`}>{children}</Text>
    </View>
  );
}

export default function DriverSignupScreen() {
  const router = useRouter();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pending, setPending] = useState(false);

  const emailValid = EMAIL_REGEX.test(email.trim());
  const phoneValid = isLikelyFrenchPhone(phone);
  const passwordValid = isStrongPassword(password);
  const passwordRequirements = {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    special: /[^A-Za-z0-9]/.test(password)
  };

  const canSubmit =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    emailValid &&
    phoneValid &&
    passwordValid &&
    termsAccepted &&
    !isSubmitting;

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/login');
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setPending(false);
    setIsSubmitting(true);

    try {
      const result = await api.driverSignup({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
        termsAccepted: true
      });

      if (result.status === 'pending') {
        // Compte réservé côté serveur mais issue Auth non confirmée (voir
        // provision-driver.ts) — jamais présenté comme un échec ni comme un
        // succès immédiat, sinon l'utilisateur retenterait une inscription
        // qui échouerait en doublon sans pouvoir se connecter non plus.
        setPending(true);
        setIsSubmitting(false);
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError !== null) {
        // Compte bien créé (201) : rediriger vers la connexion plutôt que
        // bloquer sur cet écran avec des identifiants déjà valides.
        router.replace('/login');
        return;
      }
      // Le layout racine écoute onAuthStateChange et redirige vers les
      // onglets dès que le rôle driver est confirmé.
    } catch (submitError) {
      setError(submitError instanceof ApiError ? submitError.message : 'La création du compte a échoué.');
      setIsSubmitting(false);
    }
  }

  if (pending) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 px-page-mobile">
          <Text className="text-center font-sans-bold text-h3 text-stone-800">Votre compte est en cours de finalisation</Text>
          <Text className="text-center font-sans text-body-lg text-stone-500">
            Cela peut prendre quelques instants. Réessayez de vous connecter un peu plus tard avec les identifiants que vous venez de créer.
          </Text>
          <Pressable
            onPress={() => router.replace('/login')}
            className="h-touch-comfortable items-center justify-center rounded-lg bg-primary-600 px-6 active:bg-primary-700"
          >
            <Text className="font-sans-bold text-body-lg text-white">Retour à la connexion</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.select({ ios: 'padding', android: 'height' })}>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          <View className="mb-6 flex-row items-center">
            <Pressable
              onPress={goBack}
              accessibilityRole="button"
              accessibilityLabel="Retour à la connexion"
              className="h-touch-comfortable w-touch-comfortable items-center justify-center -ml-2"
            >
              <ChevronLeft size={26} color={STONE_800} />
            </Pressable>
            <Text className="flex-1 text-center font-sans-bold text-h3 text-primary-600">Locadely</Text>
            <View className="h-touch-comfortable w-touch-comfortable" />
          </View>

          <View className="mb-6 gap-2">
            <Text className="font-sans-bold text-h2 text-stone-800">Devenez partenaire</Text>
            <Text className="font-sans text-body-lg text-stone-500">
              Créez votre compte pour commencer à livrer près de chez vous.
            </Text>
          </View>

          <View className="gap-5 rounded-2xl border border-border bg-surface p-4">
            <View className="gap-1">
              <Text className="font-sans-bold text-h3 text-stone-800">Vos informations</Text>
              <Text className="font-sans text-body text-stone-500">Tous les champs sont obligatoires.</Text>
            </View>

            <View className="gap-4">
          <View className="gap-1.5">
            <Text className="font-sans-semibold text-body-lg text-stone-800">Prénom</Text>
            <TextInput
              className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
              placeholder="Camille"
              placeholderTextColor={PLACEHOLDER_GRAY}
              autoComplete="given-name"
              returnKeyType="next"
              value={firstName}
              onChangeText={(value) => { setFirstName(value); setError(null); }}
            />
          </View>

          <View className="gap-1.5">
            <Text className="font-sans-semibold text-body-lg text-stone-800">Nom</Text>
            <TextInput
              className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
              placeholder="Martin"
              placeholderTextColor={PLACEHOLDER_GRAY}
              autoComplete="family-name"
              returnKeyType="next"
              value={lastName}
              onChangeText={(value) => { setLastName(value); setError(null); }}
            />
          </View>

          <View className="gap-1.5">
            <Text className="font-sans-semibold text-body-lg text-stone-800">Adresse e-mail</Text>
            <TextInput
              className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
              placeholder="vous@livreur.fr"
              placeholderTextColor={PLACEHOLDER_GRAY}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              returnKeyType="next"
              value={email}
              onChangeText={(value) => { setEmail(value); setError(null); }}
            />
          </View>

          <View className="gap-1.5">
            <Text className="font-sans-semibold text-body-lg text-stone-800">Numéro de téléphone</Text>
            <TextInput
              className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
              placeholder="06 12 34 56 78"
              placeholderTextColor={PLACEHOLDER_GRAY}
              autoComplete="tel"
              keyboardType="phone-pad"
              returnKeyType="next"
              value={phone}
              onChangeText={(value) => { setPhone(value); setError(null); }}
            />
          </View>

          <View className="gap-1.5">
            <Text className="font-sans-semibold text-body-lg text-stone-800">Mot de passe</Text>
            <TextInput
              className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
              placeholder="••••••••"
              placeholderTextColor={PLACEHOLDER_GRAY}
              autoCapitalize="none"
              autoComplete="new-password"
              secureTextEntry
              returnKeyType="done"
              value={password}
              onChangeText={(value) => { setPassword(value); setError(null); }}
            />
            <View className="gap-1.5 rounded-lg bg-stone-50 p-3">
              <Text className="font-sans-semibold text-body-sm text-stone-600">Votre mot de passe doit contenir</Text>
              <PasswordRequirement met={passwordRequirements.length}>8 caractères minimum</PasswordRequirement>
              <PasswordRequirement met={passwordRequirements.uppercase}>Une majuscule</PasswordRequirement>
              <PasswordRequirement met={passwordRequirements.lowercase}>Une minuscule</PasswordRequirement>
              <PasswordRequirement met={passwordRequirements.special}>Un caractère spécial</PasswordRequirement>
            </View>
          </View>

          <Checkbox
            checked={termsAccepted}
            onToggle={() => { setTermsAccepted((value) => !value); setError(null); }}
            label="J’accepte les CGU"
            accessibilityLabel="J’accepte les Conditions Générales d’Utilisation"
          />

          {error !== null && (
            <Text
              accessibilityRole="alert"
              className="rounded-md bg-status-cancelled-bg px-3.5 py-2.5 font-sans text-body-lg text-status-cancelled-text"
            >
              {error}
            </Text>
          )}

          <Pressable
            onPress={() => void handleSubmit()}
            disabled={!canSubmit}
            className="h-touch-comfortable flex-row items-center justify-center rounded-lg bg-primary-600 active:bg-primary-700 disabled:opacity-50"
          >
            {isSubmitting ? <ActivityIndicator color={WHITE} /> : <Text className="font-sans-bold text-body-lg text-white">Créer mon compte</Text>}
          </Pressable>
            </View>
          </View>

          <Text className="mt-5 text-center font-sans text-body text-stone-500">
            Vous avez déjà un compte ?{' '}
            <Text onPress={goBack} accessibilityRole="link" className="font-sans-semibold text-primary-600">
              Se connecter
            </Text>
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
