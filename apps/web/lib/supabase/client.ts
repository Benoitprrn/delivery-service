import { createBrowserClient } from '@supabase/ssr'
import { supabaseAnonKey, supabaseUrl } from './env'

// createBrowserClient gère lui-même la persistance de session dans les
// cookies du navigateur (document.cookie) — ne pas passer d'option `cookies`
// custom, ce n'est nécessaire que pour un store non standard.
export function createSupabaseBrowserClient() {
  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}
