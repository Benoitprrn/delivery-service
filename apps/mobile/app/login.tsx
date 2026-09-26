import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { WHITE } from '../lib/colors'
import { supabase } from '../lib/supabase'

export default function LoginScreen() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit() {
    setError(null)
    setIsSubmitting(true)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError !== null) {
      setError('Email ou mot de passe incorrect.')
      setIsSubmitting(false)
      return
    }

    const role: unknown = data.session?.user.app_metadata?.role
    if (role !== 'driver') {
      setError('Accès réservé aux livreurs.')
      // Ne pas laisser une session non-livreur persister dans l'app livreur.
      await supabase.auth.signOut()
      setIsSubmitting(false)
      return
    }

    // Le layout racine écoute onAuthStateChange et redirige vers les
    // onglets dès que le rôle driver est confirmé — rien d'autre à faire ici.
    setIsSubmitting(false)
  }

  const canSubmit = email.length > 0 && password.length > 0 && !isSubmitting

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.select({ ios: 'padding', android: 'height' })}>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 32 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          <View className="mb-9 gap-2">
            <Text className="font-sans-bold text-h2 text-primary-600">Locadely</Text>
            <Text className="font-sans-bold text-h1 text-stone-800">Bon retour</Text>
            <Text className="font-sans text-body-lg text-stone-500">Connectez-vous pour accéder à votre espace livreur.</Text>
          </View>

          <View className="gap-5 rounded-2xl border border-border bg-surface p-4">
            <View className="gap-1">
              <Text className="font-sans-bold text-h3 text-stone-800">Connexion</Text>
              <Text className="font-sans text-body text-stone-500">Saisissez vos identifiants de livreur.</Text>
            </View>

            <View className="gap-4">
              <View className="gap-1.5">
                <Text className="font-sans-semibold text-body-lg text-stone-800">Adresse e-mail</Text>
                <TextInput
                  className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
                  placeholder="vous@livreur.fr"
                  placeholderTextColor="#A8A29E"
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  returnKeyType="next"
                  value={email}
                  onChangeText={(value) => { setEmail(value); setError(null) }}
                />
              </View>

              <View className="gap-1.5">
                <Text className="font-sans-semibold text-body-lg text-stone-800">Mot de passe</Text>
                <TextInput
                  className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
                  placeholder="••••••••"
                  placeholderTextColor="#A8A29E"
                  autoCapitalize="none"
                  autoComplete="current-password"
                  secureTextEntry
                  returnKeyType="done"
                  onSubmitEditing={() => void handleSubmit()}
                  value={password}
                  onChangeText={(value) => { setPassword(value); setError(null) }}
                />
              </View>

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
                {isSubmitting ? <ActivityIndicator color={WHITE} /> : <Text className="font-sans-bold text-body-lg text-white">Se connecter</Text>}
              </Pressable>

              <Pressable
                onPress={() => router.push('/driver-signup')}
                className="min-h-touch-comfortable items-center justify-center border-t border-border pt-3"
              >
                <Text className="font-sans-semibold text-body-lg text-primary-600">Devenir livreur partenaire</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
