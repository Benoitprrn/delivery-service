type TokenResponse = {
  access_token?: unknown
}

const SETUP_ERROR = 'Unable to obtain driver test access token. Run scripts/seed-auth.sh and verify that local Supabase is running.'

export async function getDriverAccessToken(): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

  if (supabaseUrl === undefined || supabaseAnonKey === undefined) {
    throw new Error(`${SETUP_ERROR} SUPABASE_URL and SUPABASE_ANON_KEY must be configured.`)
  }

  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ email: 'driver@test.fr', password: 'test1234' })
    })
  } catch {
    throw new Error(SETUP_ERROR)
  }

  let payload: TokenResponse
  try {
    payload = await response.json() as TokenResponse
  } catch {
    throw new Error(SETUP_ERROR)
  }

  if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error(SETUP_ERROR)
  }

  return payload.access_token
}
