import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DebitRetryNotAllowedError, DebitRetrySettlementNotFoundError, type RequestDebitRetryUseCase } from '../../application/request-debit-retry.js'

const paramsSchema = z.object({ merchantSettlementId: z.string().uuid() }).strict()
const bodySchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

/**
 * Opération admin MINIMALE (R70) : relancer manuellement un prélèvement restaurant échoué. Aucune logique métier ici : la route appelle le cas d'usage.
 * Réponse 202 : la relance n'est PAS un débit, elle ouvre une nouvelle pré-notification.
 */
export async function registerSettlementAdminRoutes(app: FastifyInstance, options: { requestDebitRetry: RequestDebitRetryUseCase }): Promise<void> {
  app.post('/api/v1/admin/settlements/:merchantSettlementId/debit-retry', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
    const params = paramsSchema.safeParse(request.params)
    const body = bodySchema.safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send({ error: 'ValidationError', correlationId: request.correlationId })
    try {
      const result = await options.requestDebitRetry.execute({ merchantSettlementId: params.data.merchantSettlementId, requestedBy: request.authUser.id, reason: body.data.reason })
      return reply.code(202).send({ attemptNo: result.attemptNo, cause: result.cause, preNotificationId: result.preNotificationId })
    } catch (error) {
      if (error instanceof DebitRetrySettlementNotFoundError) return reply.code(404).send({ error: 'MerchantSettlementNotFound', correlationId: request.correlationId })
      if (error instanceof DebitRetryNotAllowedError) return reply.code(409).send({ error: 'DebitRetryNotAllowed', reason: error.reason, correlationId: request.correlationId })
      throw error
    }
  })
}
