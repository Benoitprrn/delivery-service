import Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { mapRecipientStatus, StripeDriverConnectProvider } from '../../src/modules/settlements/public.js'
import { DriverConnectIdempotencyConflictError, DriverConnectOnboardingIncompleteError, DriverConnectProviderError } from '../../src/modules/settlements/public.js'

function fakeStripe() {
  const stripe = {
    v2: { core: { accounts: { create: vi.fn(), retrieve: vi.fn() }, accountLinks: { create: vi.fn() } } },
    accountSessions: { create: vi.fn() },
    accounts: { createLoginLink: vi.fn() }
  }
  return { stripe, provider: new StripeDriverConnectProvider(stripe as unknown as Stripe) }
}

describe('StripeDriverConnectProvider — account creation (SP5 parameters)', () => {
  it.each(['individual', 'company'] as const)('creates an Express recipient account for a %s with platform-borne fees and losses, under a deterministic idempotency key', async entityType => {
    const { stripe, provider } = fakeStripe()
    stripe.v2.core.accounts.create.mockResolvedValue({ id: 'acct_new', livemode: false })
    await expect(provider.createRecipientAccount({ driverId: 'd1', displayName: 'Jean Livreur', contactEmail: 'j@example.com', entityType, idempotencyKey: 'driver-connect-account-d1' })).resolves.toEqual({ accountId: 'acct_new', livemode: false })
    const [params, options] = stripe.v2.core.accounts.create.mock.calls[0] ?? []
    expect(params).toEqual({
      display_name: 'Jean Livreur',
      contact_email: 'j@example.com',
      dashboard: 'express',
      identity: { country: 'fr', entity_type: entityType },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      defaults: { currency: 'eur', responsibilities: { fees_collector: 'application', losses_collector: 'application' }, locales: ['fr-FR'] },
      metadata: { driver_id: 'd1' }
    })
    expect(options).toEqual({ idempotencyKey: 'driver-connect-account-d1' })
  })

  it('omits contact_email when the driver has none and never sends identity data, IBAN or a merchant configuration', async () => {
    const { stripe, provider } = fakeStripe()
    stripe.v2.core.accounts.create.mockResolvedValue({ id: 'acct_new', livemode: true })
    await provider.createRecipientAccount({ driverId: 'd1', displayName: 'X', contactEmail: undefined, entityType: 'individual', idempotencyKey: 'k' })
    const params = stripe.v2.core.accounts.create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params).not.toHaveProperty('contact_email')
    expect(JSON.stringify(params)).not.toMatch(/merchant|customer|iban|individual":\{/i)
  })

  it('maps an idempotency conflict (same key, other entity type) and other Stripe errors to dedicated errors', async () => {
    const { stripe, provider } = fakeStripe()
    const input = { driverId: 'd1', displayName: 'X', contactEmail: undefined, entityType: 'company' as const, idempotencyKey: 'k' }
    stripe.v2.core.accounts.create.mockRejectedValueOnce(new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests can only be used with the same parameters', type: 'idempotency_error' }))
    await expect(provider.createRecipientAccount(input)).rejects.toBeInstanceOf(DriverConnectIdempotencyConflictError)
    stripe.v2.core.accounts.create.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: 'boom', type: 'api_error' }))
    await expect(provider.createRecipientAccount(input)).rejects.toBeInstanceOf(DriverConnectProviderError)
  })
})

describe('StripeDriverConnectProvider — onboarding, session and dashboard', () => {
  it('creates a hosted onboarding link limited to the recipient configuration', async () => {
    const { stripe, provider } = fakeStripe()
    stripe.v2.core.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/x', expires_at: '2026-09-21T12:00:00.000Z' })
    const link = await provider.createOnboardingLink({ accountId: 'acct_1', returnUrl: 'https://app/return', refreshUrl: 'https://app/refresh' })
    expect(stripe.v2.core.accountLinks.create.mock.calls[0]?.[0]).toEqual({ account: 'acct_1', use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['recipient'], return_url: 'https://app/return', refresh_url: 'https://app/refresh' } } })
    expect(link).toEqual({ url: 'https://connect.stripe.com/setup/x', expiresAt: new Date('2026-09-21T12:00:00.000Z') })
  })

  it('creates an onboarding-only account session and returns only its client secret', async () => {
    const { stripe, provider } = fakeStripe()
    stripe.accountSessions.create.mockResolvedValue({ client_secret: 'accs_secret_x', expires_at: 1_790_000_000, account: 'acct_1' })
    await expect(provider.createAccountSession('acct_1', 'onboarding')).resolves.toEqual({ clientSecret: 'accs_secret_x', expiresAt: new Date(1_790_000_000_000) })
    expect(stripe.accountSessions.create.mock.calls[0]?.[0]).toEqual({ account: 'acct_1', components: { account_onboarding: { enabled: true } } })
  })

  it('creates a wallet account session with only Payments and Payouts enabled', async () => {
    const { stripe, provider } = fakeStripe()
    stripe.accountSessions.create.mockResolvedValue({ client_secret: 'accs_secret_x', expires_at: 1_790_000_000, account: 'acct_1' })
    await expect(provider.createAccountSession('acct_1', 'wallet')).resolves.toEqual({ clientSecret: 'accs_secret_x', expiresAt: new Date(1_790_000_000_000) })
    expect(stripe.accountSessions.create.mock.calls[0]?.[0]).toEqual({ account: 'acct_1', components: { payments: { enabled: true }, payouts: { enabled: true } } })
  })

  it('maps Stripe refusing a Dashboard link before onboarding to OnboardingIncomplete', async () => {
    const { stripe, provider } = fakeStripe()
    stripe.accounts.createLoginLink.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'Cannot create a login link for an account that has not completed onboarding.', type: 'invalid_request_error' }))
    await expect(provider.createDashboardLink('acct_1')).rejects.toBeInstanceOf(DriverConnectOnboardingIncompleteError)
    stripe.accounts.createLoginLink.mockResolvedValueOnce({ url: 'https://connect.stripe.com/express/x' })
    await expect(provider.createDashboardLink('acct_1')).resolves.toEqual({ url: 'https://connect.stripe.com/express/x' })
  })
})

describe('mapRecipientStatus — Stripe account to local state, fail closed', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    id: 'acct_1',
    identity: { entity_type: 'individual' },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'active' }, payouts: { status: 'active' } } } } },
    requirements: { entries: [], summary: null },
    ...over
  })

  it('reads an onboarded account (SP5): transfers/payouts active, only an eventually due document', () => {
    expect(mapRecipientStatus(account({ requirements: { entries: [{}], summary: { minimum_deadline: { status: 'eventually_due' } } } })))
      .toEqual({ accountId: 'acct_1', entityType: 'individual', transfers: 'active', payouts: 'active', requirements: 'eventually_due' })
    expect(mapRecipientStatus(account()).requirements).toBe('none')
  })

  it('reads a freshly created account (SP5): restricted with a past-due summary, never active', () => {
    const fresh = mapRecipientStatus(account({ configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'restricted' }, payouts: { status: 'restricted' } } } } }, requirements: { entries: [{}], summary: { minimum_deadline: { status: 'past_due' } } } }))
    expect(fresh).toMatchObject({ transfers: 'restricted', payouts: 'restricted', requirements: 'past_due' })
  })

  it.each([
    ['missing capability', { configuration: { recipient: { capabilities: {} } } }, 'inactive'],
    ['no configuration at all', { configuration: null }, 'inactive'],
    ['unsupported capability', { configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'unsupported' } } } } } }, 'restricted'],
    ['unknown capability status', { configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'weird' } } } } } }, 'unknown']
  ])('never reports active for %s', (_label, over, expected) => {
    expect(mapRecipientStatus(account(over)).transfers).toBe(expected)
  })

  it('treats a closed account as restricted and disabled, and unknown requirement statuses as currently due', () => {
    expect(mapRecipientStatus(account({ closed: true }))).toMatchObject({ transfers: 'restricted', payouts: 'restricted', requirements: 'disabled' })
    expect(mapRecipientStatus(account({ requirements: { entries: [{}], summary: { minimum_deadline: { status: 'strange' } } } })).requirements).toBe('currently_due')
    expect(mapRecipientStatus(account({ identity: { entity_type: 'nonprofit' } })).entityType).toBeNull()
  })
})
