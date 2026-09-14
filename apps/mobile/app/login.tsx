import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WHITE } from '../lib/colors'
import { supabase } from '../lib/supabase'

export default function LoginScreen() {
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
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 justify-center gap-10 px-page-mobile">
        <View className="items-center gap-1">
          <Text className="font-sans-bold text-h2 text-primary-600">Terminus</Text>
          <Text className="font-sans text-body-lg text-stone-500">Espace livreur</Text>
        </View>

        <View className="gap-4">
          <View className="gap-1.5">
            <Text className="font-sans-semibold text-body-lg text-stone-800">Email</Text>
            <TextInput
              className="h-touch-comfortable rounded-md border-[1.5px] border-border bg-surface px-3.5 font-sans text-body-lg text-stone-800"
              placeholder="vous@livreur.fr"
              placeholderTextColor="#A8A29E"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
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
              value={password}
              onChangeText={setPassword}
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
            {isSubmitting ? (
              <ActivityIndicator color={WHITE} />
            ) : (
              <Text className="font-sans-bold text-body-lg text-white">Se connecter</Text>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  )
}
