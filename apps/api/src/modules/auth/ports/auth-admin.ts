export type CreateAuthUserInput = {
  id: string
  email: string
  password: string
  appMetadata: { role: 'merchant' | 'driver' }
}

export interface AuthAdmin {
  createUser(input: CreateAuthUserInput): Promise<void>
  deleteUser(id: string): Promise<void>
}

/** E-mail du compte (Supabase Auth est la seule source) ; `null` si le compte n'existe pas. */
export interface AuthUserLookup {
  getUserEmail(id: string): Promise<string | null>
}
