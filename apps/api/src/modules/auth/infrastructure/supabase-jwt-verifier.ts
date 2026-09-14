import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import type { AuthenticatedUser } from '../domain/authenticated-user.js'
import { UnauthorizedError } from '../domain/errors.js'
import type { JwtVerifier } from '../ports/jwt-verifier.js'

const authenticatedUserPayloadSchema = z.object({
  sub: z.string().min(1),
  app_metadata: z.object({
    role: z.enum(['merchant', 'driver', 'admin'])
  })
})

export class SupabaseJwtVerifier implements JwtVerifier {
  private readonly issuer: string
  private readonly jwks: JWTVerifyGetKey

  constructor(supabaseUrl: string) {
    this.issuer = `${supabaseUrl}/auth/v1`
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`))
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: 'authenticated'
      })
      const parsedPayload = authenticatedUserPayloadSchema.safeParse(payload)

      if (!parsedPayload.success) {
        throw new UnauthorizedError('Missing or invalid role claim')
      }

      return {
        id: parsedPayload.data.sub,
        role: parsedPayload.data.app_metadata.role
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error
      }

      throw new UnauthorizedError('Invalid or expired token')
    }
  }
}
