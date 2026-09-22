import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSettlementAdminRoutes, RequestDebitRetryUseCase, type DebitRetryRepository } from '../../src/modules/settlements/public.js'

const settlementId = '44444444-4444-4444-8444-444444444444'
const admin = '55555555-5555-5555-5555-555555555555'
const correlationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
let app: FastifyInstance
let authUser: { id: string; role: 'merchant' | 'driver' | 'admin' } | undefined
const created: Array<{ attemptNo: number; requestedBy: string; reason: string }> = []

function repository(context: Awaited<ReturnType<DebitRetryRepository['loadContext']>>): DebitRetryRepository {
  return {
    loadContext: async () => context,
    createRetryNotification: async (input) => { created.push({ attemptNo: input.attemptNo, requestedBy: input.requestedBy, reason: input.reason }); return { outcome: 'created', preNotificationId: 'pn-1' } }
  }
}
async function register(context: Awaited<ReturnType<DebitRetryRepository['loadContext']>>): Promise<void> {
  await app.register(registerSettlementAdminRoutes, { requestDebitRetry: new RequestDebitRetryUseCase(repository(context)) })
}
const url = `/api/v1/admin/settlements/${settlementId}/debit-retry`

describe('admin debit retry HTTP (R70)', () => {
  beforeEach(() => {
    created.length = 0
    app = Fastify()
    authUser = { id: admin, role: 'admin' }
    app.addHook('onRequest', async (request) => { request.correlationId = correlationId; if (authUser !== undefined) request.authUser = authUser })
  })
  afterEach(async () => { await app.close() })

  it('is reserved to admins (403 for merchants, drivers and anonymous)', async () => {
    await register({ amountCents: 100, attempts: [{ attemptNo: 1, status: 'failed' }], hasOpenRetryRequest: false })
    for (const user of [{ id: admin, role: 'merchant' as const }, { id: admin, role: 'driver' as const }, undefined]) {
      authUser = user
      expect((await app.inject({ method: 'POST', url, payload: { reason: 'Restaurant a régularisé son compte' } })).statusCode).toBe(403)
    }
    expect(created).toEqual([])
  })

  it('validates the settlement id and requires a reason (strict body)', async () => {
    await register({ amountCents: 100, attempts: [{ attemptNo: 1, status: 'failed' }], hasOpenRetryRequest: false })
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/settlements/not-a-uuid/debit-retry', payload: { reason: 'ok ok' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, payload: { reason: 'ok ok', attemptNo: 9 } })).statusCode).toBe(400)
  })

  it('opens a new pre-notification for the next attempt and answers 202 (it never debits)', async () => {
    await register({ amountCents: 100, attempts: [{ attemptNo: 1, status: 'failed' }], hasOpenRetryRequest: false })
    const response = await app.inject({ method: 'POST', url, payload: { reason: 'Restaurant a régularisé son compte' } })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ attemptNo: 2, cause: 'failed_debit', preNotificationId: 'pn-1' })
    expect(created).toEqual([{ attemptNo: 2, requestedBy: admin, reason: 'Restaurant a régularisé son compte' }])
  })

  it.each([
    [[{ attemptNo: 1, status: 'succeeded' as const }], false, 'debit_already_succeeded'],
    [[{ attemptNo: 1, status: 'processing' as const }], false, 'debit_in_flight'],
    [[{ attemptNo: 1, status: 'failed' as const }], true, 'open_retry_request'],
    [[], false, 'no_attempt']
  ])('answers 409 with the reason when the retry is not allowed (%j)', async (attempts, open, reason) => {
    await register({ amountCents: 100, attempts, hasOpenRetryRequest: open })
    const response = await app.inject({ method: 'POST', url, payload: { reason: 'Restaurant a régularisé son compte' } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'DebitRetryNotAllowed', reason })
    expect(created).toEqual([])
  })

  it('answers 404 for an unknown settlement', async () => {
    await register(null)
    expect((await app.inject({ method: 'POST', url, payload: { reason: 'Restaurant a régularisé son compte' } })).statusCode).toBe(404)
  })
})
