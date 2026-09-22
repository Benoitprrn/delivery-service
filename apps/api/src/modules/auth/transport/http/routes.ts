import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createMerchantsModule } from '../../../merchants/public.js'
import { AccountAlreadyExistsError, AuthProviderError } from '../../domain/auth-admin-errors.js'
import { MerchantProvisioningError } from '../../../merchants/public.js'
import { ZodError } from 'zod'
import { merchantSignupBodySchema } from './schemas.js'

type Options = { merchants: ReturnType<typeof createMerchantsModule> }

function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const correlationId = request.correlationId
  if (error instanceof ZodError) return reply.code(400).send({ error: 'ValidationError', message: 'Request validation failed', correlationId })
  if (error instanceof AccountAlreadyExistsError) return reply.code(409).send({ error: error.name, message: error.message, correlationId })
  if (error instanceof AuthProviderError) return reply.code(502).send({ error: error.name, message: error.message, correlationId })
  if (error instanceof MerchantProvisioningError) return reply.code(500).send({ error: error.name, message: error.message, correlationId })
  request.log.error({ err: error }, 'HTTP request failed')
  return reply.code(500).send({ error: 'InternalServerError', message: 'An unexpected error occurred', correlationId })
}

export async function registerAuthHttpRoutes(app: FastifyInstance, options: Options): Promise<void> {
  app.post('/api/v1/auth/merchant-signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = merchantSignupBodySchema.parse(request.body)
      const result = await options.merchants.provisionMerchant({ merchantName: body.merchantName, email: body.email, password: body.password, correlationId: request.correlationId, logger: request.log })
      return reply.code(201).send(result)
    } catch (error) {
      return sendError(request, reply, error)
    }
  })
}
