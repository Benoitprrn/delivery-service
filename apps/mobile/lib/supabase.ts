import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import { AppState, Platform } from 'react-native'

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const supabaseUrl = requireEnv('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL)
const supabaseAnonKey = requireEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY)

// expo-secure-store, pas AsyncStorage : les clés que supabase-js génère
// (ex. "sb-<ref>-auth-token") sont déjà compatibles avec ses contraintes de
// nommage. Le pilote n'a qu'un JWT email/mot de passe minimal, largement
// sous la limite de 2048 octets par valeur de SecureStore — pas de
// chunking nécessaire à ce stade.
const secureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key)
}

// expo-secure-store n'a pas d'implémentation web (module natif absent) —
// il plante `npx expo start --web`, le fallback navigateur documenté dans
// apps/mobile/CLAUDE.md. Sur web uniquement, on retombe sur localStorage ;
// sur Android/iOS, c'est toujours SecureStore.
const webStorageAdapter = {
  getItem: (key: string) => Promise.resolve(typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: (key: string, value: string) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
    return Promise.resolve()
  },
  removeItem: (key: string) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
    return Promise.resolve()
  }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS === 'web' ? webStorageAdapter : secureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
})

// Recommandation officielle Supabase + Expo : suspendre le rafraîchissement
// automatique du token quand l'app passe en arrière-plan, sinon supabase-js
// continue d'émettre des requêtes réseau inutiles hors premier plan.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh()
  } else {
    void supabase.auth.stopAutoRefresh()
  }
})
