import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConnectWebhookSignatureError } from '../../ports/connect-webhook.js'
import { StripeUnavailableError } from '../../ports/stripe-provider.js'

export const STRIPE_CONNECT_WEBHOOK_PATH = '/api/v1/webhooks/stripe-connect'

// Contrat local (pas d'import de payments/public.ts) : garde les routes fines et sans cycle.
export type ConnectWebhookHttpHandlers = {
  receiveWebhook: (payload: string | Buffer, signature: string) => Promise<void>
}

type Options = { webhooks: ConnectWebhookHttpHandlers }

/**
 * Publique uniquement sur ce chemin exact (exemptée du JWT dans le hook
 * d'authentification) et du rate-limit global ; l'authenticité repose
 * exclusivement sur la signature Stripe vérifiée sur le corps brut.
 */
export async function registerStripeConnectWebhookRoute(app: FastifyInstance, options: Options): Promise<void> {
  app.post(STRIPE_CONNECT_WEBHOOK_PATH, { config: { rawBody: true, rateLimit: false } }, async (request, reply) => {
    const signature = request.headers['stripe-signature']
    if (typeof signature !== 'string') return reply.code(400).send({ error: 'InvalidSignature' })

    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody
    if (rawBody === undefined) return reply.code(400).send({ error: 'InvalidPayload' })

    try {
      await options.webhooks.receiveWebhook(rawBody, signature)
      return reply.send({ received: true })
    } catch (error) {
      if (error instanceof ConnectWebhookSignatureError) {
        return reply.code(400).send({ error: 'InvalidStripeWebhook' })
      }
      if (error instanceof StripeUnavailableError) {
        return reply.code(503).send({ error: 'StripeUnavailable', correlationId: request.correlationId })
      }
      // Échec de réception durable : 500 pour que Stripe rejoue la livraison.
      request.log.error({ err: error, correlationId: request.correlationId }, 'Stripe Connect webhook receipt failed')
      return reply.code(500).send({ error: 'StripeWebhookReceiptError', correlationId: request.correlationId })
    }
  })
}
