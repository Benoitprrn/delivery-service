import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DriverConnectOnboardingIncompleteError,
  DriverConnectProviderError,
  DriverConnectUnavailableError,
  DriverPayoutAccountUseCases,
  registerDriverPayoutRoutes,
  type DriverConnectAccountRecord,
  type DriverConnectProvider,
  type DriverConnectRepository
} from '../../src/modules/settlements/public.js'

const driverId = '33333333-3333-3333-3333-333333333333'
const correlationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
let app: FastifyInstance
let authUser: { id: string; role: 'merchant' | 'driver' | 'admin'; email?: string } | undefined

function build(over: Partial<DriverConnectProvider> = {}, driverName: string | null = 'Jean-Paul') {
  let record: DriverConnectAccountRecord | null = null
  const repository: DriverConnectRepository = {
    findByDriverId: async () => record,
    insertIfAbsent: async (input) => { record ??= { driverId: input.driverId, stripeAccountId: input.stripeAccountId, entityType: input.entityType, transfersStatus: 'inactive', payoutsStatus: 'inactive', requirementsState: 'past_due', restrictedAt: null, lastSyncedAt: null } },
    updateStatus: async (_id, status) => { if (record !== null) record = { ...record, transfersStatus: status.transfers, payoutsStatus: status.payouts, requirementsState: status.requirements }; return record },
    findDriverIdByAccountId: async () => null
  }
  const provider: DriverConnectProvider = {
    createRecipientAccount: vi.fn(async () => ({ accountId: 'acct_secret_1', livemode: false })),
    getAccountStatus: vi.fn(async () => ({ accountId: 'acct_secret_1', entityType: 'individual' as const, transfers: 'restricted' as const, payouts: 'restricted' as const, requirements: 'past_due' as const })),
    createOnboardingLink: vi.fn(async () => ({ url: 'https://connect.stripe.com/setup/x', expiresAt: new Date('2026-09-21T12:00:00.000Z') })),
    createAccountSession: vi.fn(async () => ({ clientSecret: 'accs_secret_x', expiresAt: new Date('2026-09-21T13:00:00.000Z') })),
    createDashboardLink: vi.fn(async () => ({ url: 'https://connect.stripe.com/express/x' })),
    ...over
  }
  const payoutAccount = new DriverPayoutAccountUseCases(repository, provider, { returnUrl: 'https://app/return', refreshUrl: 'https://app/refresh' })
  return { provider, register: () => app.register(registerDriverPayoutRoutes, { payoutAccount, findDriverName: async () => driverName }) }
}

describe('driver payout account HTTP (R30)', () => {
  beforeEach(() => {
    app = Fastify()
    authUser = { id: driverId, role: 'driver', email: 'jp@example.com' }
    app.addHook('onRequest', async (request) => {
      request.correlationId = correlationId
      if (authUser !== undefined) request.authUser = authUser
    })
  })
  afterEach(async () => { await app.close() })

  it.each([
    ['GET', '/api/v1/drivers/me/payout-account'],
    ['POST', '/api/v1/drivers/me/payout-account'],
    ['POST', '/api/v1/drivers/me/payout-account/onboarding-link'],
    ['POST', '/api/v1/drivers/me/payout-account/account-session'],
    ['POST', '/api/v1/drivers/me/payout-account/dashboard-link']
  ] as const)('refuses non-drivers on %s %s with 403', async (method, url) => {
    await build().register()
    for (const role of ['merchant', 'admin'] as const) {
      authUser = { id: driverId, role }
      const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: { entityType: 'individual' } } : {}) })
      expect(response.statusCode).toBe(403)
    }
    authUser = undefined
    expect((await app.inject({ method, url, ...(method === 'POST' ? { payload: { entityType: 'individual' } } : {}) })).statusCode).toBe(403)
  })

  it('reports not_created, then creates on explicit request only, and never exposes the Stripe account id', async () => {
    const { provider, register } = build()
    await register()
    expect((await app.inject({ method: 'GET', url: '/api/v1/drivers/me/payout-account' })).json()).toEqual({ state: 'not_created' })
    expect(provider.createRecipientAccount).not.toHaveBeenCalled()

    const created = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'company' } })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ state: 'created', entityType: 'company', ready: false, actionRequired: true })
    expect(created.body).not.toMatch(/acct_/)
    expect(provider.createRecipientAccount).toHaveBeenCalledWith(expect.objectContaining({ driverId, displayName: 'Jean-Paul', contactEmail: 'jp@example.com', entityType: 'company', idempotencyKey: `driver-connect-account-${driverId}` }))
  })

  it.each([{ entityType: 'sole_trader' }, {}, { entityType: 'individual', driverId: 'other', accountId: 'acct_x' }])('rejects an invalid or over-specified body %j with 400 (nothing accepted from the client)', async payload => {
    const { provider, register } = build()
    await register()
    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'InvalidRequest', correlationId })
    expect(provider.createRecipientAccount).not.toHaveBeenCalled()
  })

  it('locks the entity type: a second creation with another type is 409 EntityTypeLocked, the same type is idempotent', async () => {
    const { provider, register } = build()
    await register()
    await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    const again = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    expect(again.statusCode).toBe(200)
    const locked = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'company' } })
    expect(locked.statusCode).toBe(409)
    expect(locked.json()).toMatchObject({ error: 'EntityTypeLocked' })
    expect(provider.createRecipientAccount).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for links before creation, then onboarding link, embedded session secret and (once onboarded) dashboard link', async () => {
    const { provider, register } = build()
    await register()
    for (const path of ['onboarding-link', 'account-session', 'dashboard-link']) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/drivers/me/payout-account/${path}` })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: 'PayoutAccountNotFound' })
    }
    await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    const link = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account/onboarding-link' })
    expect(link.json()).toEqual({ url: 'https://connect.stripe.com/setup/x', expiresAt: '2026-09-21T12:00:00.000Z' })
    const session = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account/account-session' })
    expect(session.json()).toEqual({ clientSecret: 'accs_secret_x', expiresAt: '2026-09-21T13:00:00.000Z' })
    expect(session.body).not.toMatch(/acct_/)
    expect(provider.createAccountSession).toHaveBeenCalledWith('acct_secret_1', 'onboarding')
    const wallet = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account/account-session', payload: { purpose: 'wallet' } })
    expect(wallet.statusCode).toBe(200)
    expect(wallet.json()).toEqual({ clientSecret: 'accs_secret_x', expiresAt: '2026-09-21T13:00:00.000Z' })
    expect(provider.createAccountSession).toHaveBeenLastCalledWith('acct_secret_1', 'wallet')
    const dashboard = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account/dashboard-link' })
    expect(dashboard.json()).toEqual({ url: 'https://connect.stripe.com/express/x' })
    expect(provider.createOnboardingLink).toHaveBeenCalledWith({ accountId: 'acct_secret_1', returnUrl: 'https://app/return', refreshUrl: 'https://app/refresh' })
  })

  it.each([{ purpose: 'x' }, { extra: 1 }])('rejects an invalid account-session body %j with 400', async payload => {
    const { provider, register } = build()
    await register()
    await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account/account-session', payload })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'InvalidRequest', correlationId })
    expect(provider.createAccountSession).not.toHaveBeenCalled()
  })

  it('answers 409 OnboardingNotCompleted when Stripe refuses the Dashboard link before onboarding', async () => {
    const { register } = build({ createDashboardLink: async () => { throw new DriverConnectOnboardingIncompleteError() } })
    await register()
    await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account/dashboard-link' })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'OnboardingNotCompleted' })
  })

  it('answers 503 when Stripe is disabled and 502 on a Stripe failure, without leaking provider details', async () => {
    const disabled = build({ createRecipientAccount: async () => { throw new DriverConnectUnavailableError() } })
    await disabled.register()
    const unavailable = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toMatchObject({ error: 'StripeUnavailable' })
    await app.close()
    app = Fastify()
    app.addHook('onRequest', async (request) => { request.correlationId = correlationId; request.authUser = { id: driverId, role: 'driver' } })
    await build({ createRecipientAccount: async () => { throw new DriverConnectProviderError(new Error('sk_live_secret internal detail')) } }).register()
    const failed = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    expect(failed.statusCode).toBe(502)
    expect(failed.body).not.toMatch(/sk_live|internal detail/)
  })

  it('answers 404 when the driver profile does not exist (no Stripe call)', async () => {
    const { provider, register } = build({}, null)
    await register()
    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/payout-account', payload: { entityType: 'individual' } })
    expect(response.statusCode).toBe(404)
    expect(provider.createRecipientAccount).not.toHaveBeenCalled()
  })
})
