// Accès statique en notation point requis pour NEXT_PUBLIC_* — voir
// lib/supabase/env.ts pour le piège exact (l'accès dynamique process.env[x]
// n'est jamais inliné au build par Next.js pour le bundle navigateur).
function requireApiUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_URL
  if (value === undefined || value.length === 0) {
    throw new Error('Missing required environment variable: NEXT_PUBLIC_API_URL')
  }
  return value
}

export const apiUrl = requireApiUrl()

function requireOpenCageApiKey(): string {
  const value = process.env.NEXT_PUBLIC_OPENCAGE_API_KEY
  if (value === undefined || value.length === 0) {
    throw new Error('Missing required environment variable: NEXT_PUBLIC_OPENCAGE_API_KEY')
  }
  return value
}

export const openCageApiKey = requireOpenCageApiKey()
