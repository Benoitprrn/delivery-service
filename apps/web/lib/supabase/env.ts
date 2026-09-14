function requireSupabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (value === undefined || value.length === 0) {
    throw new Error('Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL')
  }
  return value
}

function requireSupabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (value === undefined || value.length === 0) {
    throw new Error('Missing required environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }
  return value
}

export const supabaseUrl = requireSupabaseUrl()
export const supabaseAnonKey = requireSupabaseAnonKey()
