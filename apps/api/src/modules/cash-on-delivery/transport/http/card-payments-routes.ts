import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import {
  LegalInformationRequiredError,
  PaymentConfigurationError,
  StripeIdempotencyConflictError,
  StripeProviderError,
  StripeUnavailableError
} from '../../../payments/public.js'
import { ConnectProviderError, ConnectUnavailableError } from '../../ports/connect-payments-provider.js'
import type { CardPaymentsUseCases } from '../../application/card-payments.js'

type Options = { cardPayments: Pick<CardPaymentsUseCases, 'getStatus' | 'createOnboardingLink'> }

// Le corps est vide (ou `{}`) : le serveur ne reçoit du client ni compte, ni configuration.
const onboardingLinkBodySchema = z.undefined().or(z.object({}).strict())

type PublicError = { statusCode: number; code: string }

/** Codes stables et sans message brut : `{ error, correlationId }`. */
function toPublicError(error: unknown): PublicError {
  if (error instanceof ZodError) {
    return { statusCode: 400, code: 'InvalidRequest' }
  }
  if (error instanceof LegalInformationRequiredError) {
    return { statusCode: 422, code: 'LegalInformationRequired' }
  }
  if (error instanceof PaymentConfigurationError) {
    return { statusCode: 422, code: 'AccountEmailUnavailable' }
  }
  if (error instanceof StripeIdempotencyConflictError) {
    return { statusCode: 409, code: 'CustomerCreationInProgress' }
  }
  if (error instanceof StripeUnavailableError || error instanceof ConnectUnavailableError) {
    return { statusCode: 503, code: 'StripeUnavailable' }
  }
  if (error instanceof StripeProviderError || error instanceof ConnectProviderError) {
    return { statusCode: 502, code: 'StripeProviderError' }
  }
  return { statusCode: 500, code: 'InternalError' }
}

function logFailure(request: FastifyRequest, error: unknown, publicError: PublicError): void {
  if (error instanceof StripeProviderError || error instanceof ConnectProviderError) {
    const cause = error.cause as { code?: unknown; requestId?: unknown } | undefined
    request.log.error(
      {
        errorClass: error.constructor.name,
        ...(typeof cause?.code === 'string' ? { code: cause.code } : {}),
        ...(typeof cause?.requestId === 'string' ? { requestId: cause.requestId } : {})
      },
      'Stripe provider request failed'
    )
  } else if (publicError.statusCode === 500) {
    request.log.error({ err: error }, 'Card payments request failed')
  }
}

function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const publicError = toPublicError(error)
  logFailure(request, error, publicError)
  return reply
    .code(publicError.statusCode)
    .send({ error: publicError.code, correlationId: request.correlationId })
}

function sendForbidden(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
}

export async function registerCardPaymentsHttpRoutes(
  app: FastifyInstance,
  options: Options
): Promise<void> {
  app.get('/api/v1/merchants/me/card-payments', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'merchant') {
        return sendForbidden(request, reply)
      }
      const status = await options.cardPayments.getStatus(request.authUser.id)
      return reply.send(status)
    } catch (error) {
      return sendError(request, reply, error)
    }
  })

  app.post('/api/v1/merchants/me/card-payments/onboarding-link', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'merchant') {
        return sendForbidden(request, reply)
      }
      onboardingLinkBodySchema.parse(request.body)
      const link = await options.cardPayments.createOnboardingLink(
        request.authUser.id,
        request.authUser.email
      )
      return reply.send({ url: link.url, expiresAt: link.expiresAt.toISOString() })
    } catch (error) {
      return sendError(request, reply, error)
    }
  })
}
