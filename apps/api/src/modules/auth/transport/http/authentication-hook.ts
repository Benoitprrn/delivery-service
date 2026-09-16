import type { FastifyInstance } from 'fastify'
import type { AuthenticatedUser } from '../../domain/authenticated-user.js'
import { UnauthorizedError } from '../../domain/errors.js'
import type { JwtVerifier } from '../../ports/jwt-verifier.js'

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedUser
  }
}

export function registerAuthentication(app: FastifyInstance, options: { verifier: JwtVerifier }): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      return
    }

    // The opaque order tracking token is the sole credential for this public route.
    if (!request.url.startsWith('/api/v1/') || /^\/api\/v1\/orders\/track\/[^/?]+(?:\?.*)?$/.test(request.url)) {
      return
    }

    const authorization = request.headers.authorization
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null

    const token = match?.[1]
    if (token === undefined) {
      await reply.code(401).send({
        error: 'UnauthorizedError',
        message: 'Missing or invalid Authorization header',
        correlationId: request.correlationId
      })
      return
    }

    try {
      request.authUser = await options.verifier.verify(token)
    } catch (error) {
      const message = error instanceof UnauthorizedError ? error.message : 'Invalid or expired token'

      await reply.code(401).send({
        error: 'UnauthorizedError',
        message,
        correlationId: request.correlationId
      })
      return
    }
  })
}
