import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { supabaseAnonKey, supabaseUrl } from './env'

type SessionResult = {
  response: NextResponse
  user: User | null
}

// Rafraîchit la session Supabase (tokens en cookies) à chaque requête et
// renvoie l'utilisateur authentifié, s'il y en a un. getUser() est utilisé
// plutôt que getSession() : il revalide le JWT auprès de Supabase Auth au
// lieu de faire confiance au cookie tel quel.
export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value)
        }
      }
    }
  })

  const {
    data: { user }
  } = await supabase.auth.getUser()

  return { response, user }
}
