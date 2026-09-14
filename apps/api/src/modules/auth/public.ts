import type { FastifyInstance } from 'fastify'
import { SupabaseJwtVerifier } from './infrastructure/supabase-jwt-verifier.js'
import { registerAuthentication } from './transport/http/authentication-hook.js'

export type { AuthenticatedUser, AuthRole } from './domain/authenticated-user.js'
export { UnauthorizedError } from './domain/errors.js'

export function createAuthModule(supabaseUrl: string) {
  const verifier = new SupabaseJwtVerifier(supabaseUrl)

  return {
    registerAuthentication: (app: FastifyInstance) => registerAuthentication(app, { verifier }),
    verifyToken: verifier.verify.bind(verifier)
  }
}
