import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { DecideDriverReversalUseCase, RequestDriverReversalUseCase, ReversalNotFoundError, ReversalNotPendingError, ReversalRefusedError } from '../../application/driver-reversals.js'
import { GetAdminOverviewUseCase, GetDriverSettlementsUseCase, GetMerchantSettlementDetailUseCase, GetMerchantSettlementsUseCase } from '../../application/settlement-read.js'
import { InvalidReversalCategoryError, InvalidReversalReasonError, RestaurantDefaultReversalForbiddenError, ReversalApproverError, ReversalDecisionIncompleteError } from '../../domain/errors.js'

const limit = (defaultValue: number, max: number) => z.object({ limit: z.coerce.number().int().min(1).max(max).default(defaultValue) }).strict()
const merchantSettlementParams = z.object({ merchantSettlementId: z.string().uuid() }).strict()
const reversalParams = z.object({ reversalId: z.string().uuid() }).strict()
const reversalBody = z.object({ driverTransferId: z.string().uuid(), category: z.string(), reasonCode: z.string(), reason: z.string().trim().min(3).max(500), decisionReference: z.string().trim().min(1).max(100), amountCents: z.number().int().positive(), orderId: z.string().uuid().optional() }).strict()
const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

export type SettlementReadRoutesOptions = {
  driverSettlements: GetDriverSettlementsUseCase
  merchantSettlements: GetMerchantSettlementsUseCase
  merchantSettlementDetail: GetMerchantSettlementDetailUseCase
  adminOverview: GetAdminOverviewUseCase
  requestReversal: RequestDriverReversalUseCase
  decideReversal: DecideDriverReversalUseCase
  clock?: () => Date
}

function forbidden(request: FastifyRequest, reply: FastifyReply) { return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId }) }
function validation(request: FastifyRequest, reply: FastifyReply) { return reply.code(400).send({ error: 'ValidationError', correlationId: request.correlationId }) }

export async function registerSettlementReadRoutes(app: FastifyInstance, options: SettlementReadRoutesOptions): Promise<void> {
  app.get('/api/v1/drivers/me/settlements', async (request, reply) => {
    if (request.authUser?.role !== 'driver') return forbidden(request, reply)
    const query = limit(12, 52).safeParse(request.query); if (!query.success) return validation(request, reply)
    return reply.send(await options.driverSettlements.execute({ driverId: request.authUser.id, limit: query.data.limit }))
  })
  app.get('/api/v1/merchants/me/settlements', async (request, reply) => {
    if (request.authUser?.role !== 'merchant') return forbidden(request, reply)
    const query = limit(26, 52).safeParse(request.query); if (!query.success) return validation(request, reply)
    return reply.send(await options.merchantSettlements.execute({ merchantId: request.authUser.id, limit: query.data.limit }))
  })
  app.get('/api/v1/merchants/me/settlements/:merchantSettlementId', async (request, reply) => {
    if (request.authUser?.role !== 'merchant') return forbidden(request, reply)
    const params = merchantSettlementParams.safeParse(request.params); if (!params.success) return validation(request, reply)
    const result = await options.merchantSettlementDetail.execute({ merchantId: request.authUser.id, merchantSettlementId: params.data.merchantSettlementId })
    return result === null ? reply.code(404).send({ error: 'MerchantSettlementNotFound', correlationId: request.correlationId }) : reply.send(result)
  })
  app.get('/api/v1/admin/settlements/overview', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return forbidden(request, reply)
    const query = limit(100, 200).safeParse(request.query); if (!query.success) return validation(request, reply)
    return reply.send(await options.adminOverview.execute({ limit: query.data.limit }))
  })
  app.post('/api/v1/admin/reversals', async (request, reply) => {
    if (request.authUser?.role !== 'admin') return forbidden(request, reply)
    const body = reversalBody.safeParse(request.body); if (!body.success) return validation(request, reply)
    try {
      const result = await options.requestReversal.execute({ ...body.data, orderId: body.data.orderId ?? null, requestedBy: request.authUser.id })
      return reply.code(201).send({ reversalId: result.reversal.id, outcome: result.outcome, status: result.reversal.status })
    } catch (error) {
      if (error instanceof ReversalRefusedError) return reply.code(409).send({ error: 'ReversalRefused', reason: error.reason, correlationId: request.correlationId })
      if (error instanceof RestaurantDefaultReversalForbiddenError || error instanceof InvalidReversalReasonError || error instanceof ReversalDecisionIncompleteError || error instanceof InvalidReversalCategoryError) return reply.code(422).send({ error: error.constructor.name, correlationId: request.correlationId })
      throw error
    }
  })
  const decide = (action: 'approve' | 'reject') => async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser?.role !== 'admin') return forbidden(request, reply)
    const params = reversalParams.safeParse(request.params); if (!params.success) return validation(request, reply)
    const rejected = action === 'reject' ? rejectBody.safeParse(request.body) : null
    if (rejected !== null && !rejected.success) return validation(request, reply)
    try {
      const now = (options.clock ?? (() => new Date()))()
      if (action === 'approve') await options.decideReversal.approve({ reversalId: params.data.reversalId, approvedBy: request.authUser.id, now })
      else if (rejected !== null && rejected.success) await options.decideReversal.reject({ reversalId: params.data.reversalId, rejectedBy: request.authUser.id, reason: rejected.data.reason, now })
      return reply.send({ ok: true })
    } catch (error) {
      if (error instanceof ReversalApproverError) return reply.code(409).send({ error: 'SameApprover', correlationId: request.correlationId })
      if (error instanceof ReversalNotFoundError) return reply.code(404).send({ error: 'ReversalNotFound', correlationId: request.correlationId })
      if (error instanceof ReversalNotPendingError) return reply.code(409).send({ error: 'ReversalNotPending', correlationId: request.correlationId })
      throw error
    }
  }
  app.post('/api/v1/admin/reversals/:reversalId/approve', decide('approve'))
  app.post('/api/v1/admin/reversals/:reversalId/reject', decide('reject'))
}
