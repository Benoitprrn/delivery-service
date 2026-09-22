import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { LegalInformationRequiredError, PaymentConfigurationError, PaymentMethodNotReadyError, SetupAlreadyCompletedError, SetupProcessingError, SetupStatusUnsupportedError, StripeSetupFailedError, StripeWebhookSignatureError } from '../../application/sepa-payment-method.js'
import { z, ZodError } from 'zod'
import { StripeIdempotencyConflictError, StripeProviderError, StripeUnavailableError } from '../../ports/stripe-provider.js'
import type { MerchantPaymentMethod } from '../../ports/payment-repository.js'

type PaymentHttpHandlers = {
  getPaymentMethod: (merchantId: string) => Promise<MerchantPaymentMethod | null>
  createSetupIntent: (merchantId: string, email: string | undefined) => Promise<{ clientSecret: string }>
  completeSetupIntent: (merchantId: string, setupIntentId: string) => Promise<MerchantPaymentMethod>
  receiveWebhook: (payload: string | Buffer, signature: string) => Promise<void>
}
type Options = { payments: PaymentHttpHandlers }
const completeSchema = z.object({ setupIntentId: z.string().min(3).max(255) }).strict()
const setupSchema = z.undefined().or(z.object({}).strict())
type PaymentMethodResponse = { status: 'active' | 'invalid'; bankName: string | null; last4: string | null; country: string | null }
function display(method: { status: string; bankName: string | null; last4: string | null; country: string | null } | null): PaymentMethodResponse | null {
  return method === null || (method.status !== 'active' && method.status !== 'invalid') ? null : { status: method.status, bankName: method.bankName, last4: method.last4, country: method.country }
}
function error(request: FastifyRequest, reply: FastifyReply, e: unknown): FastifyReply {
  const correlationId = request.correlationId
  const mapped = e instanceof ZodError ? [400, 'InvalidRequest'] as const
    : e instanceof PaymentMethodNotReadyError ? [409, 'PaymentMethodNotReady'] as const
      : e instanceof SetupProcessingError ? [409, 'SetupProcessing'] as const
        : e instanceof SetupAlreadyCompletedError ? [409, 'SetupAlreadyCompleted'] as const
          : e instanceof SetupStatusUnsupportedError ? [409, 'SetupStatusUnsupported'] as const
            : e instanceof StripeSetupFailedError ? [422, 'SetupNotCompleted'] as const
              : e instanceof LegalInformationRequiredError ? [422, 'LegalInformationRequired'] as const
                : e instanceof PaymentConfigurationError ? [422, 'AccountEmailUnavailable'] as const
                  : e instanceof StripeIdempotencyConflictError ? [409, 'CustomerCreationInProgress'] as const
                    : e instanceof StripeUnavailableError ? [503, 'StripeUnavailable'] as const
                      : e instanceof StripeProviderError ? [502, 'StripeProviderError'] as const
                        : [500, 'InternalError'] as const
  if (e instanceof StripeProviderError) {
    const cause = e.cause as { code?: unknown; requestId?: unknown } | undefined
    request.log.error({ errorClass: e.constructor.name, correlationId, ...(typeof cause?.code === 'string' ? { code: cause.code } : {}), ...(typeof cause?.requestId === 'string' ? { requestId: cause.requestId } : {}) }, 'Stripe provider request failed')
  } else if (mapped[0] === 500) {
    request.log.error({ err: e, correlationId }, 'Payment request failed')
  }
  return reply.code(mapped[0]).send({ error: mapped[1], correlationId })
}
export async function registerPaymentHttpRoutes(app: FastifyInstance, options: Options): Promise<void> {
  app.get('/api/v1/merchants/me/payment-method', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'merchant') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
      return reply.send({ paymentMethod: display(await options.payments.getPaymentMethod(request.authUser.id)) })
    } catch (e) { return error(request, reply, e) }
  })
  app.post('/api/v1/merchants/me/payment-method/setup-intents', async (request, reply) => {
    try { if (request.authUser?.role !== 'merchant') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId }); setupSchema.parse(request.body); const setup=await options.payments.createSetupIntent(request.authUser.id, request.authUser.email); return reply.send({ clientSecret: setup.clientSecret }) } catch (e) { return error(request, reply, e) }
  })
  app.post('/api/v1/merchants/me/payment-method/setup-intents/complete', async (request, reply) => {
    try { if (request.authUser?.role !== 'merchant') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId }); const body = completeSchema.parse(request.body); return reply.send({ paymentMethod: display(await options.payments.completeSetupIntent(request.authUser.id, body.setupIntentId)) }) } catch (e) { return error(request, reply, e) }
  })
  app.post('/api/v1/webhooks/stripe', { config: { rawBody: true, rateLimit: false } }, async (request, reply) => {
    try { const signature = request.headers['stripe-signature']; if (typeof signature !== 'string') return reply.code(400).send({ error: 'InvalidSignature' }); const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody; if (rawBody === undefined) return reply.code(400).send({ error: 'InvalidPayload' }); await options.payments.receiveWebhook(rawBody, signature); return reply.send({ received: true }) } catch (e) { if(e instanceof StripeWebhookSignatureError)return reply.code(400).send({error:'InvalidStripeWebhook'});if(e instanceof StripeUnavailableError)return reply.code(503).send({error:'StripeUnavailable',correlationId:request.correlationId});request.log.error({err:e,correlationId:request.correlationId},'Stripe webhook receipt failed');return reply.code(500).send({error:'StripeWebhookReceiptError',correlationId:request.correlationId}) }
  })
}
