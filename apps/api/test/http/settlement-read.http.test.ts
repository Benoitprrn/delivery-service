import { beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyRequest } from 'fastify'
import { registerSettlementReadRoutes } from '../../src/modules/settlements/transport/http/settlement-read-routes.js'
import { ReversalNotPendingError, ReversalRefusedError } from '../../src/modules/settlements/application/driver-reversals.js'
import { InvalidReversalCategoryError, ReversalApproverError } from '../../src/modules/settlements/domain/errors.js'

const ids = { driver: '11111111-1111-4111-8111-111111111111', merchant: '22222222-2222-4222-8222-222222222222', admin: '33333333-3333-4333-8333-333333333333', settlement: '44444444-4444-4444-8444-444444444444', reversal: '55555555-5555-4555-8555-555555555555', transfer: '66666666-6666-4666-8666-666666666666' }

describe('settlement read routes', () => {
  let app: ReturnType<typeof Fastify>
  let authUser: { id: string; role: 'merchant' | 'driver' | 'admin' } | undefined
  let calls: Record<string, unknown>[]

  beforeEach(async () => {
    calls = []; authUser = undefined; app = Fastify(); app.decorateRequest('correlationId', 'test'); app.decorateRequest('authUser')
    app.addHook('onRequest', async (request: FastifyRequest) => { if (authUser !== undefined) request.authUser = authUser })
    await registerSettlementReadRoutes(app, {
      driverSettlements: { execute: async (input: unknown) => { calls.push({ driver: input }); return { periods: [] } } }, merchantSettlements: { execute: async (input: unknown) => { calls.push({ merchant: input }); return { settlements: [] } } }, merchantSettlementDetail: { execute: async (input: unknown) => { calls.push({ detail: input }); return null } }, adminOverview: { execute: async (input: unknown) => { calls.push({ overview: input }); return {} } }, requestReversal: { execute: async (input: { category: string }) => { if (input.category === 'refused') throw new ReversalRefusedError('refused'); if (input.category === 'forbidden') throw new InvalidReversalCategoryError(); calls.push({ request: input }); return { reversal: { id: ids.reversal, status: 'pending' }, outcome: 'created' } } }, decideReversal: { approve: async (input: unknown) => { if ((input as { reversalId: string }).reversalId === '77777777-7777-4777-8777-777777777777') throw new ReversalApproverError(); calls.push({ approve: input }) }, reject: async (input: unknown) => { if ((input as { reversalId: string }).reversalId === '88888888-8888-4888-8888-888888888888') throw new ReversalNotPendingError(); calls.push({ reject: input }) } }
    } as never)
  })

  it('returns 403 for anonymous and wrong roles, and 400 for invalid query or UUID', async () => {
    expect((await app.inject('/api/v1/drivers/me/settlements')).statusCode).toBe(403)
    authUser = { id: ids.merchant, role: 'merchant' }
    expect((await app.inject('/api/v1/drivers/me/settlements')).statusCode).toBe(403)
    authUser = { id: ids.driver, role: 'driver' }
    expect((await app.inject('/api/v1/drivers/me/settlements?limit=0')).statusCode).toBe(400)
    authUser = { id: ids.merchant, role: 'merchant' }
    expect((await app.inject('/api/v1/merchants/me/settlements/not-a-uuid')).statusCode).toBe(400)
  })

  it('returns 200 for each read route and 404 for a missing merchant detail', async () => {
    authUser = { id: ids.driver, role: 'driver' }; expect((await app.inject('/api/v1/drivers/me/settlements?limit=2')).statusCode).toBe(200)
    authUser = { id: ids.merchant, role: 'merchant' }; expect((await app.inject('/api/v1/merchants/me/settlements?limit=2')).statusCode).toBe(200); expect((await app.inject(`/api/v1/merchants/me/settlements/${ids.settlement}`)).statusCode).toBe(404)
    authUser = { id: ids.admin, role: 'admin' }; expect((await app.inject('/api/v1/admin/settlements/overview?limit=2')).statusCode).toBe(200)
    expect(calls).toContainEqual({ driver: { driverId: ids.driver, limit: 2 } }); expect(calls).toContainEqual({ merchant: { merchantId: ids.merchant, limit: 2 } })
  })

  it('validates reversals and forwards every acting administrator id', async () => {
    authUser = { id: ids.admin, role: 'admin' }
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/reversals', payload: {} })).statusCode).toBe(400)
    const body = { driverTransferId: ids.transfer, category: 'driver_fault', reasonCode: 'lost_order', reason: 'Course perdue', decisionReference: 'DEC-1', amountCents: 100 }
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/reversals', payload: body })).statusCode).toBe(201)
    expect(calls).toContainEqual({ request: { ...body, orderId: null, requestedBy: ids.admin } })
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/reversals/${ids.reversal}/approve` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/reversals/${ids.reversal}/reject`, payload: { reason: 'Décision annulée' } })).statusCode).toBe(200)
    expect(calls.find((x) => 'approve' in x)).toMatchObject({ approve: { approvedBy: ids.admin } }); expect(calls.find((x) => 'reject' in x)).toMatchObject({ reject: { rejectedBy: ids.admin, reason: 'Décision annulée' } })
  })

  it('maps reversal refusal, forbidden category and decision conflicts to public status codes', async () => {
    authUser = { id: ids.admin, role: 'admin' }
    const body = { driverTransferId: ids.transfer, category: 'refused', reasonCode: 'lost_order', reason: 'Course perdue', decisionReference: 'DEC-1', amountCents: 100 }
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/reversals', payload: body })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/reversals', payload: { ...body, category: 'forbidden' } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/reversals/77777777-7777-4777-8777-777777777777/approve' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/reversals/88888888-8888-4888-8888-888888888888/reject', payload: { reason: 'Non validée' } })).statusCode).toBe(409)
  })
})
