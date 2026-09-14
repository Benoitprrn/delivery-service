import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string
  }
}

const HEADER = 'x-correlation-id'

export function registerCorrelationId(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '')

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers[HEADER]
    const correlationId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID()
    request.correlationId = correlationId
    reply.header(HEADER, correlationId)
    request.log = request.log.child({ correlationId })
  })
}
