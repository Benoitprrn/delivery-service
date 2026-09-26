import type { FastifyInstance } from 'fastify'
import { SupabaseJwtVerifier } from './infrastructure/supabase-jwt-verifier.js'
import { SupabaseAuthAdmin } from './infrastructure/supabase-auth-admin.js'
import { PostgresAccountPhoneRegistry } from './infrastructure/postgres-account-phone-registry.js'
import { registerAuthentication } from './transport/http/authentication-hook.js'

export type { AuthenticatedUser, AuthRole } from './domain/authenticated-user.js'
export { UnauthorizedError } from './domain/errors.js'
export { AccountAlreadyExistsError, AuthProviderError, AuthProviderUnknownOutcomeError } from './domain/auth-admin-errors.js'
export type { AuthAdmin, AuthUserLookup } from './ports/auth-admin.js'
export type { AccountPhoneRegistry } from './ports/account-phone-registry.js'
export { PostgresAccountPhoneRegistry }

export function createAuthModule(supabaseUrl: string, serviceRoleKey: string) {
  const verifier = new SupabaseJwtVerifier(supabaseUrl)
  const admin = new SupabaseAuthAdmin(supabaseUrl, serviceRoleKey)

  return {
    registerAuthentication: (app: FastifyInstance) => registerAuthentication(app, { verifier }),
    verifyToken: verifier.verify.bind(verifier),
    admin
  }
}
