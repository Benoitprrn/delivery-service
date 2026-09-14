export type AuthRole = 'merchant' | 'driver' | 'admin'

export type AuthenticatedUser = {
  id: string
  role: AuthRole
}
