import type { AuthenticatedUser } from '../domain/authenticated-user.js'

export interface JwtVerifier {
  verify(token: string): Promise<AuthenticatedUser>
}
