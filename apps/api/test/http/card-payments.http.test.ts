import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { CardPaymentsUseCases } from '../../src/modules/cash-on-delivery/application/card-payments.js'
import { registerCardPaymentsHttpRoutes } from '../../src/modules/cash-on-delivery/transport/http/card-payments-routes.js'
import { UnavailableConnectPaymentsProvider } from '../../src/modules/cash-on-delivery/infrastructure/stripe-connect-direct-provider.js'
import {
  ConnectProviderError,
  type ConnectPaymentsProvider
} from '../../src/modules/cash-on-delivery/ports/connect-payments-provider.js'
import type {
  MerchantConnect,
  MerchantConnectRepository
} from '../../src/modules/cash-on-delivery/ports/merchant-connect-repository.js'
import {
  LegalInformationRequiredError,
  PaymentConfigurationError,
  StripeIdempotencyConflictError,
  StripeProviderError
} from '../../src/modules/payments/public.js'
import { FakeConnectPaymentsProvider } from '../support/fake-connect-payments-provider.js'

const correlationId = 'card-correlation'
const links = { returnUrl: 'https://app.test/account', refreshUrl: 'https://app.test/account' }

class Connects implements MerchantConnectRepository {
  readonly values = new Map<string, MerchantConnect>()
  async findByMerchantId(merchantId: string): Promise<MerchantConnect | null> { return this.values.get(merchantId) ?? null }
  async save(value: MerchantConnect): Promise<MerchantConnect> { this.values.set(value.merchantId, value); return value }
}

class TrackingProvider extends FakeConnectPaymentsProvider {
  addCalls = 0
  linkCalls = 0
  readonly statusAccountIds: string[] = []

  override async getAccountStatus(accountId: string) {
    this.statusAccountIds.push(accountId)
    return super.getAccountStatus(accountId)
  }

  override async addMerchantConfiguration(): Promise<void> {
    this.addCalls++
    this.accountStatus = { ...this.accountStatus, merchantConfigured: true }
  }

  override async createOnboardingLink(): Promise<{ url: string; expiresAt: Date }> {
    this.linkCalls++
    return { url: 'https://stripe.test/link', expiresAt: new Date('2026-09-21T10:00:00.000Z') }
  }
}

function paymentsPort() {
  const accountIds = new Map<string, string | null>([['merchant-a', null], ['merchant-b', null]])
  const state = { creates: 0, ensureFailure: null as Error | null }
  return {
    accountIds,
    state,
    api: {
      getMerchantStripeAccountId: async (merchantId: string) => accountIds.get(merchantId) ?? null,
      ensureMerchantStripeAccount: async (merchantId: string) => {
        if (state.ensureFailure !== null) throw state.ensureFailure
        let accountId = accountIds.get(merchantId)
        if (accountId === null || accountId === undefined) {
          accountId = `acct_${merchantId}`
          accountIds.set(merchantId, accountId)
          state.creates++
        }
        return { merchantId, stripeAccountId: accountId }
      }
    }
  }
}

type Actor = { id: string; role: 'merchant' | 'driver'; email?: string }

async function build(actor: Actor = { id: 'merchant-a', role: 'merchant', email: 'merchant@example.test' }, providerOverride?: ConnectPaymentsProvider) {
  const app = Fastify()
  app.decorateRequest('correlationId', '')
  app.decorateRequest('authUser')
  app.addHook('onRequest', async (request) => {
    request.correlationId = correlationId
    request.authUser = actor
  })
  const provider = new TrackingProvider()
  const port = paymentsPort()
  const connects = new Connects()
  const cardPayments = new CardPaymentsUseCases(port.api, providerOverride ?? provider, connects, links)
  await app.register(registerCardPaymentsHttpRoutes, { cardPayments })
  return { app, provider, port, connects }
}

const onboardingLink = { method: 'POST', url: '/api/v1/merchants/me/card-payments/onboarding-link' } as const
const status = { method: 'GET', url: '/api/v1/merchants/me/card-payments' } as const

describe('GET /api/v1/merchants/me/card-payments', () => {
  it('returns exactly the contract the web UI reads', async () => {
    const { app, provider, port } = await build()
    port.accountIds.set('merchant-a', 'acct_merchant-a')
    provider.accountStatus = { ...provider.accountStatus, cardPayments: 'active', cartesBancaires: 'pending', requirementsCount: 0 }

    const response = await app.inject(status)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ state: 'ready', cardPaymentsReady: true, cartesBancairesStatus: 'pending', requirementsCount: 0 })
    await app.close()
  })

  it('maps restricted requirements to action_required', async () => {
    const { app, provider, port } = await build()
    port.accountIds.set('merchant-a', 'acct_merchant-a')
    provider.accountStatus = { ...provider.accountStatus, cardPayments: 'restricted', requirementsCount: 3 }

    expect((await app.inject(status)).json()).toMatchObject({ state: 'action_required', cardPaymentsReady: false, requirementsCount: 3 })
    await app.close()
  })

  it('is not_configured for a merchant without Account and does not leak another merchant status', async () => {
    const { app, provider, port } = await build({ id: 'merchant-b', role: 'merchant' })
    port.accountIds.set('merchant-a', 'acct_merchant-a')
    provider.accountStatus = { ...provider.accountStatus, cardPayments: 'active' }

    const response = await app.inject(status)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ state: 'not_configured', cardPaymentsReady: false, cartesBancairesStatus: 'not_requested', requirementsCount: 0 })
    expect(provider.statusAccountIds).not.toContain('acct_merchant-a')
    await app.close()
  })

  it('only ever reads the Account of the authenticated merchant', async () => {
    const { app, provider, port } = await build({ id: 'merchant-b', role: 'merchant' })
    port.accountIds.set('merchant-a', 'acct_merchant-a')
    port.accountIds.set('merchant-b', 'acct_merchant-b')

    await app.inject(status)

    expect(provider.statusAccountIds).toEqual(['acct_merchant-b'])
    await app.close()
  })

  it('is reserved to merchants (403 for a driver, nothing read)', async () => {
    const { app, provider, port } = await build({ id: 'driver-1', role: 'driver' })
    port.accountIds.set('driver-1', 'acct_driver')

    const response = await app.inject(status)

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'ForbiddenError', correlationId })
    expect(provider.statusAccountIds).toEqual([])
    await app.close()
  })

  it('answers 503 StripeUnavailable when Stripe is disabled', async () => {
    const { app, port } = await build(undefined, new UnavailableConnectPaymentsProvider())
    port.accountIds.set('merchant-a', 'acct_merchant-a')

    const response = await app.inject(status)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'StripeUnavailable', correlationId })
    await app.close()
  })
})

describe('POST /api/v1/merchants/me/card-payments/onboarding-link', () => {
  it('adds merchant once, reuses one Account, and returns a hosted link each time', async () => {
    const { app, provider, port, connects } = await build()
    provider.accountStatus = { ...provider.accountStatus, merchantConfigured: false }

    const first = await app.inject(onboardingLink)
    const second = await app.inject({ ...onboardingLink, payload: {} })

    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ url: 'https://stripe.test/link', expiresAt: '2026-09-21T10:00:00.000Z' })
    expect(second.statusCode).toBe(200)
    expect(port.state.creates).toBe(1)
    expect(provider.addCalls).toBe(1)
    expect(provider.linkCalls).toBe(2)
    expect(connects.values.get('merchant-a')).toMatchObject({ merchantConfiguredAt: expect.any(Date), cardPaymentsStatus: 'active', requirementsCount: 0 })
    await app.close()
  })

  it('does not request a link when the Account cannot be created (no configuration, no link)', async () => {
    const { app, provider, port } = await build()
    port.state.ensureFailure = new LegalInformationRequiredError('legal information incomplete')

    const response = await app.inject(onboardingLink)

    expect(response.statusCode).toBe(422)
    expect(provider.addCalls).toBe(0)
    expect(provider.linkCalls).toBe(0)
    await app.close()
  })

  it('is reserved to merchants (403 for a driver, nothing created)', async () => {
    const { app, provider, port } = await build({ id: 'driver-1', role: 'driver' })

    const response = await app.inject(onboardingLink)

    expect(response.statusCode).toBe(403)
    expect(port.state.creates).toBe(0)
    expect(provider.addCalls).toBe(0)
    expect(provider.linkCalls).toBe(0)
    await app.close()
  })

  it('rejects a body that tries to choose an Account or configuration (400)', async () => {
    const { app, provider } = await build()

    const response = await app.inject({ ...onboardingLink, payload: { accountId: 'acct_other' } })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'InvalidRequest', correlationId })
    expect(provider.linkCalls).toBe(0)
    await app.close()
  })

  it('answers 503 StripeUnavailable when Stripe is disabled', async () => {
    const { app } = await build(undefined, new UnavailableConnectPaymentsProvider())

    const response = await app.inject(onboardingLink)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'StripeUnavailable', correlationId })
    await app.close()
  })

  it.each([
    ['legal information missing', new LegalInformationRequiredError('secret detail'), 422, 'LegalInformationRequired'],
    ['account e-mail missing', new PaymentConfigurationError('secret detail'), 422, 'AccountEmailUnavailable'],
    ['Account creation in progress', new StripeIdempotencyConflictError(), 409, 'CustomerCreationInProgress'],
    ['payments Stripe error', new StripeProviderError({ code: 'invalid_fields' }), 502, 'StripeProviderError'],
    ['Connect Stripe error', new ConnectProviderError({ code: 'invalid_fields' }), 502, 'StripeProviderError'],
    ['unexpected error', new Error('secret detail sk_test_123'), 500, 'InternalError']
  ])('maps %s to a stable public code without raw messages', async (_label, failure, statusCode, code) => {
    const { app, port } = await build()
    port.state.ensureFailure = failure

    const response = await app.inject(onboardingLink)

    expect(response.statusCode).toBe(statusCode)
    expect(response.json()).toEqual({ error: code, correlationId })
    expect(response.body).not.toContain('secret detail')
    await app.close()
  })
})
