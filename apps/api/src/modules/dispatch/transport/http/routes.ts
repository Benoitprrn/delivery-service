import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { DispatchOfferAccessDeniedError, DispatchOfferConflictError, DispatchOfferNotFoundError, DispatchPlannerUnavailableError } from '../../domain/errors.js'
import type { createDispatchModule } from '../../public.js'
import { acceptDispatchOfferBodySchema, dispatchOfferParamsSchema, rejectDispatchOfferBodySchema } from './schemas.js'

type DispatchHttpRoutesOptions = { dispatch: Pick<ReturnType<typeof createDispatchModule>, 'acceptOffer' | 'getOffer' | 'rejectOffer'> }

function sendMappedError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode = error instanceof ZodError ? 400
    : error instanceof DispatchOfferNotFoundError ? 404
      : error instanceof DispatchOfferAccessDeniedError ? 403
    : error instanceof DispatchOfferConflictError ? 409
      : error instanceof DispatchPlannerUnavailableError ? 503 : 500
  request.log.error({ err: error, statusCode }, 'HTTP request failed')
  return reply.code(statusCode).send({
    error: error instanceof ZodError ? 'ValidationError' : error instanceof Error ? error.name : 'InternalServerError',
    message: error instanceof ZodError ? 'Request validation failed' : error instanceof Error ? error.message : 'An unexpected error occurred',
    correlationId: request.correlationId
  })
}

export async function registerDispatchHttpRoutes(app: FastifyInstance, options: DispatchHttpRoutesOptions): Promise<void> {
  app.get('/api/v1/dispatch-offers/:offerId', async (request, reply) => {
    try {
      const { offerId } = dispatchOfferParamsSchema.parse(request.params)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      const result = await options.dispatch.getOffer(offerId, request.authUser.id)
      return reply.code(200).send(result)
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/dispatch-offers/:offerId/accept', async (request, reply) => {
    try {
      const { offerId } = dispatchOfferParamsSchema.parse(request.params)
      const { expectedVersion } = acceptDispatchOfferBodySchema.parse(request.body)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      await options.dispatch.acceptOffer(offerId, request.authUser.id, expectedVersion, request.correlationId)
      return reply.code(204).send()
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.post('/api/v1/dispatch-offers/:offerId/reject', async (request, reply) => {
    try {
      const { offerId } = dispatchOfferParamsSchema.parse(request.params)
      const { expectedVersion } = rejectDispatchOfferBodySchema.parse(request.body)
      if (request.authUser?.role !== 'driver') {
        return reply.code(403).send({ error: 'ForbiddenError', message: 'Only drivers can perform this action', correlationId: request.correlationId })
      }
      await options.dispatch.rejectOffer(offerId, request.authUser.id, expectedVersion, request.correlationId)
      return reply.code(204).send()
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })
}
