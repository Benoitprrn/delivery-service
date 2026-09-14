import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { supabaseAnonKey, supabaseUrl } from './env'

// À appeler à chaque rendu serveur (jamais réutilisé entre requêtes).
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Appelé depuis un Server Component (lecture seule) : la session
          // est déjà rafraîchie par le middleware, rien à faire ici.
        }
      }
    }
  })
}
