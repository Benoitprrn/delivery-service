import { describe, expect, it, vi } from 'vitest'
import {
  CardPaymentsUseCases,
  deriveCardPaymentsStatus
} from '../../src/modules/cash-on-delivery/application/card-payments.js'
import {
  ConnectUnavailableError,
  type ConnectAccountStatus
} from '../../src/modules/cash-on-delivery/ports/connect-payments-provider.js'
import type {
  MerchantConnect,
  MerchantConnectRepository
} from '../../src/modules/cash-on-delivery/ports/merchant-connect-repository.js'
import {
  CompleteSepaSetupIntentUseCase,
  CreateSepaSetupIntentUseCase,
  LegalInformationRequiredError
} from '../../src/modules/payments/application/sepa-payment-method.js'
import type {
  MerchantPaymentProfile,
  PaymentRepository
} from '../../src/modules/payments/ports/payment-repository.js'
import {
  StripeAccountTokenRequiredError,
  type StripeProvider
} from '../../src/modules/payments/ports/stripe-provider.js'
import type { MerchantLegalInformation } from '../../src/modules/merchants/public.js'
import { FakeConnectPaymentsProvider } from '../support/fake-connect-payments-provider.js'

const legal: MerchantLegalInformation = {
  merchantId: 'merchant-a',
  siret: '73282932000074',
  siren: '732829320',
  legalName: 'Restaurant A SAS',
  legalAddress: { line1: '1 rue Test', line2: null, postalCode: '01000', city: 'Bourg-en-Bresse', countryCode: 'FR', communeCode: null },
  billingAddress: null,
  vatNumber: null,
  buyerReference: null,
  sireneVerificationStatus: 'verified',
  sireneVerifiedAt: null
}

const merchantRecord = {
  id: 'merchant-a',
  name: 'Restaurant A',
  zoneId: null,
  address: null,
  phonePrimary: null,
  phoneSecondary: null,
  logoUrl: null,
  lat: null,
  lng: null,
  onboardingCompleted: false
}

const urls = { returnUrl: 'https://app.test/return', refreshUrl: 'https://app.test/refresh' }

class InMemoryConnects implements MerchantConnectRepository {
  readonly values = new Map<string, MerchantConnect>()
  saves = 0

  async findByMerchantId(merchantId: string): Promise<MerchantConnect | null> {
    return this.values.get(merchantId) ?? null
  }

  async save(value: MerchantConnect): Promise<MerchantConnect> {
    this.saves += 1
    this.values.set(value.merchantId, value)
    return value
  }
}

class RecordingConnectProvider extends FakeConnectPaymentsProvider {
  addFailure: Error | null = null
  statusFailure: Error | null = null

  constructor(private readonly events: string[]) {
    super()
    this.accountStatus = { ...this.accountStatus, merchantConfigured: false, cardPayments: 'restricted', requirementsCount: 25 }
  }

  override async getAccountStatus(accountId: string): Promise<ConnectAccountStatus> {
    if (this.statusFailure !== null) throw this.statusFailure
    this.events.push('connect.getAccountStatus')
    return super.getAccountStatus(accountId)
  }

  override async addMerchantConfiguration(input?: { accountId: string }): Promise<void> {
    this.events.push(`connect.addMerchantConfiguration:${input?.accountId}`)
    // Laisse d'autres appels concurrents entrer, pour prouver la sérialisation.
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (this.addFailure !== null) throw this.addFailure
    this.accountStatus = { ...this.accountStatus, merchantConfigured: true }
  }

  override async createOnboardingLink(input?: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: Date }> {
    this.events.push(`connect.createOnboardingLink:${input?.accountId}:${input?.returnUrl}:${input?.refreshUrl}`)
    return { url: `https://connect.test/${input?.accountId}`, expiresAt: new Date('2026-09-21T10:00:00.000Z') }
  }
}

/**
 * Le VRAI `ensureMerchantStripeAccount` de payments, sur des dépôts/fournisseur en mémoire.
 * `events` est un journal partagé : il prouve l'ORDRE des appels payments → Connect.
 */
function createWorld() {
  const events: string[] = []
  const profiles = new Map<string, MerchantPaymentProfile>()
  const connect = new RecordingConnectProvider(events)
  const connects = new InMemoryConnects()
  const stripe = {
    accountsCreated: 0,
    identityUpdates: 0,
    updateFailure: null as Error | null,
    async createCustomerAccount(input: { merchantId: string }) {
      this.accountsCreated += 1
      events.push(`payments.createCustomerAccount:${input.merchantId}`)
      return { id: `acct_${input.merchantId}` }
    },
    async hasMerchantConfiguration() {
      // Même vérité que l'Account chez Stripe.
      return connect.accountStatus.merchantConfigured
    },
    async updateCustomerAccount() {
      this.identityUpdates += 1
      events.push('payments.updateCustomerAccount')
      if (this.updateFailure !== null) throw this.updateFailure
    }
  }
  const repository = {
    async findProfile(merchantId: string) { return profiles.get(merchantId) ?? null },
    async saveProfile(profile: MerchantPaymentProfile) {
      const existing = profiles.get(profile.merchantId)
      if (existing !== undefined) return existing
      profiles.set(profile.merchantId, profile)
      return profile
    }
  } as unknown as PaymentRepository
  const stripeProvider = stripe as unknown as StripeProvider
  const complete = new CompleteSepaSetupIntentUseCase(repository, stripeProvider)
  const legalByMerchant = new Map<string, MerchantLegalInformation | null>([['merchant-a', legal]])
  const sepa = new CreateSepaSetupIntentUseCase(
    repository,
    stripeProvider,
    async (id) => ({ ...merchantRecord, id }),
    async (id) => legalByMerchant.get(id) ?? null,
    complete,
    async () => undefined
  )
  const payments = {
    getMerchantStripeAccountId: async (merchantId: string) => (await repository.findProfile(merchantId))?.stripeAccountId ?? null,
    ensureMerchantStripeAccount: async (merchantId: string, email: string | undefined) => {
      events.push('payments.ensureMerchantStripeAccount')
      return sepa.ensureMerchantStripeAccount(merchantId, email)
    }
  }
  let clock = new Date('2026-09-20T10:00:00.000Z')
  const warn = vi.fn()
  const useCases = new CardPaymentsUseCases(payments, connect, connects, urls, {
    logger: { warn },
    now: () => clock
  })
  return {
    events,
    profiles,
    connect,
    connects,
    stripe,
    legalByMerchant,
    useCases,
    warn,
    advanceClock(milliseconds: number) { clock = new Date(clock.getTime() + milliseconds) }
  }
}

function connectStatus(overrides: Partial<ConnectAccountStatus>): ConnectAccountStatus {
  return {
    accountId: 'acct_x',
    merchantConfigured: true,
    dashboard: 'full',
    cardPayments: 'active',
    cartesBancaires: 'active',
    requirementsCount: 0,
    ...overrides
  }
}

describe('deriveCardPaymentsStatus', () => {
  it.each([
    ['merchant not applied', { merchantConfigured: false, cardPayments: 'active' as const }, 'not_configured', false],
    ['card_payments active', { cardPayments: 'active' as const }, 'ready', true],
    ['card_payments pending', { cardPayments: 'pending' as const, requirementsCount: 2 }, 'pending_review', false],
    ['restricted with requirements', { cardPayments: 'restricted' as const, requirementsCount: 4 }, 'action_required', false],
    ['restricted without requirement', { cardPayments: 'restricted' as const }, 'restricted', false],
    ['inactive without requirement', { cardPayments: 'inactive' as const }, 'restricted', false],
    ['not requested', { cardPayments: 'not_requested' as const }, 'restricted', false]
  ])('%s', (_label, overrides, state, ready) => {
    const derived = deriveCardPaymentsStatus(connectStatus(overrides))
    expect(derived.state).toBe(state)
    expect(derived.cardPaymentsReady).toBe(ready)
  })

  it('is ready only from card_payments, never from cartes_bancaires alone', () => {
    const derived = deriveCardPaymentsStatus(connectStatus({ cardPayments: 'pending', cartesBancaires: 'active' }))
    expect(derived.cardPaymentsReady).toBe(false)
    const ready = deriveCardPaymentsStatus(connectStatus({ cardPayments: 'active', cartesBancaires: 'pending' }))
    expect(ready).toEqual({ state: 'ready', cardPaymentsReady: true, cartesBancairesStatus: 'pending', requirementsCount: 0 })
  })
})

describe('CardPaymentsUseCases.getStatus', () => {
  it('reports not_configured without calling Stripe or writing the cache when the merchant has no Account', async () => {
    const world = createWorld()
    await expect(world.useCases.getStatus('merchant-a')).resolves.toEqual({
      state: 'not_configured',
      cardPaymentsReady: false,
      cartesBancairesStatus: 'not_requested',
      requirementsCount: 0
    })
    expect(world.connect.calls.getAccountStatus).toBe(0)
    expect(world.connects.saves).toBe(0)
  })

  it('reads Stripe, caches only derived status, and keeps the first merchant_configured_at', async () => {
    const world = createWorld()
    world.profiles.set('merchant-a', { merchantId: 'merchant-a', stripeAccountId: 'acct_merchant-a' })
    world.connect.accountStatus = connectStatus({ cardPayments: 'restricted', requirementsCount: 3 })

    await expect(world.useCases.getStatus('merchant-a')).resolves.toMatchObject({ state: 'action_required', requirementsCount: 3 })
    const first = world.connects.values.get('merchant-a')
    expect(first).toEqual({
      merchantId: 'merchant-a',
      merchantConfiguredAt: new Date('2026-09-20T10:00:00.000Z'),
      cardPaymentsStatus: 'restricted',
      cartesBancairesStatus: 'active',
      requirementsCount: 3,
      lastSyncedAt: new Date('2026-09-20T10:00:00.000Z')
    })

    world.advanceClock(60_000)
    world.connect.accountStatus = connectStatus({ cardPayments: 'active' })
    await expect(world.useCases.getStatus('merchant-a')).resolves.toMatchObject({ state: 'ready', cardPaymentsReady: true })
    expect(world.connects.values.get('merchant-a')).toMatchObject({
      merchantConfiguredAt: new Date('2026-09-20T10:00:00.000Z'),
      cardPaymentsStatus: 'active',
      lastSyncedAt: new Date('2026-09-20T10:01:00.000Z')
    })
  })

  it('does not swallow Stripe failures', async () => {
    const world = createWorld()
    world.profiles.set('merchant-a', { merchantId: 'merchant-a', stripeAccountId: 'acct_merchant-a' })
    world.connect.statusFailure = new ConnectUnavailableError('disabled')
    await expect(world.useCases.getStatus('merchant-a')).rejects.toBeInstanceOf(ConnectUnavailableError)
  })
})

describe('CardPaymentsUseCases.createOnboardingLink', () => {
  it('creates the Account, syncs identity, THEN adds merchant, THEN requests the link (in that order)', async () => {
    const world = createWorld()
    const link = await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')

    expect(link).toEqual({ url: 'https://connect.test/acct_merchant-a', expiresAt: new Date('2026-09-21T10:00:00.000Z') })
    expect(world.events).toEqual([
      'payments.ensureMerchantStripeAccount',
      'payments.createCustomerAccount:merchant-a',
      'payments.updateCustomerAccount',
      'connect.getAccountStatus',
      'connect.addMerchantConfiguration:acct_merchant-a',
      'connect.getAccountStatus',
      'connect.createOnboardingLink:acct_merchant-a:https://app.test/return:https://app.test/refresh'
    ])
    expect(world.connects.values.get('merchant-a')).toMatchObject({ merchantConfiguredAt: expect.any(Date), cardPaymentsStatus: 'restricted' })
  })

  it('never creates a second Account and adds the merchant configuration exactly once across sequential calls', async () => {
    const world = createWorld()
    await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')
    await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')
    await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')

    expect(world.stripe.accountsCreated).toBe(1)
    expect(world.events.filter((event) => event.startsWith('connect.addMerchantConfiguration'))).toHaveLength(1)
    expect(world.events.filter((event) => event.startsWith('connect.createOnboardingLink'))).toHaveLength(3)
  })

  it('never updates identity after merchant is applied (France account_token_required)', async () => {
    const world = createWorld()
    await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')
    expect(world.stripe.identityUpdates).toBe(1)

    await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')
    await world.useCases.createOnboardingLink('merchant-a', 'changed@test.fr')
    expect(world.stripe.identityUpdates).toBe(1)

    const lastUpdate = world.events.lastIndexOf('payments.updateCustomerAccount')
    const add = world.events.findIndex((event) => event.startsWith('connect.addMerchantConfiguration'))
    expect(lastUpdate).toBeLessThan(add)
  })

  it('still adds merchant once when a race makes the identity update fail with account_token_required', async () => {
    const world = createWorld()
    world.stripe.updateFailure = new StripeAccountTokenRequiredError()
    await expect(world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')).resolves.toMatchObject({ url: expect.any(String) })
    expect(world.events.filter((event) => event.startsWith('connect.addMerchantConfiguration'))).toHaveLength(1)
  })

  it('serializes concurrent requests: one Account, one merchant configuration, one link each', async () => {
    const world = createWorld()
    const links = await Promise.all(
      Array.from({ length: 5 }, () => world.useCases.createOnboardingLink('merchant-a', 'a@test.fr'))
    )

    expect(links).toHaveLength(5)
    expect(world.stripe.accountsCreated).toBe(1)
    expect(world.events.filter((event) => event.startsWith('connect.addMerchantConfiguration'))).toHaveLength(1)
    expect(world.events.filter((event) => event.startsWith('connect.createOnboardingLink'))).toHaveLength(5)
  })

  it('requests no link and adds no configuration when the Account cannot be ensured', async () => {
    const world = createWorld()
    world.legalByMerchant.set('merchant-a', null)
    await expect(world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(LegalInformationRequiredError)

    expect(world.events).toEqual(['payments.ensureMerchantStripeAccount'])
    expect(world.stripe.accountsCreated).toBe(0)
    expect(world.connects.saves).toBe(0)
  })

  it('requests no link when the merchant configuration cannot be added, and retries the addition next time', async () => {
    const world = createWorld()
    world.connect.addFailure = new Error('stripe rejected')
    await expect(world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')).rejects.toThrow('stripe rejected')
    expect(world.events.some((event) => event.startsWith('connect.createOnboardingLink'))).toBe(false)
    expect(world.connects.saves).toBe(0)

    world.connect.addFailure = null
    await expect(world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')).resolves.toMatchObject({ url: expect.any(String) })
    expect(world.events.filter((event) => event.startsWith('connect.addMerchantConfiguration'))).toHaveLength(2)
    expect(world.stripe.accountsCreated).toBe(1)
  })

  it('isolates merchants: another merchant gets its own Account and its own configuration', async () => {
    const world = createWorld()
    world.legalByMerchant.set('merchant-b', { ...legal, merchantId: 'merchant-b' })
    await world.useCases.createOnboardingLink('merchant-a', 'a@test.fr')
    world.connect.accountStatus = { ...world.connect.accountStatus, merchantConfigured: false }
    await world.useCases.createOnboardingLink('merchant-b', 'b@test.fr')

    expect(world.stripe.accountsCreated).toBe(2)
    expect(world.events).toContain('connect.addMerchantConfiguration:acct_merchant-b')
    expect(world.events).toContain('connect.createOnboardingLink:acct_merchant-b:https://app.test/return:https://app.test/refresh')
  })
})

describe('CardPaymentsUseCases.isReady (COD guard input)', () => {
  it('is true only when card_payments is active on the merchant Account', async () => {
    const world = createWorld()
    world.profiles.set('merchant-a', { merchantId: 'merchant-a', stripeAccountId: 'acct_merchant-a' })

    world.connect.accountStatus = connectStatus({ cardPayments: 'active' })
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(true)

    world.connect.accountStatus = connectStatus({ cardPayments: 'pending' })
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(false)

    world.connect.accountStatus = connectStatus({ cardPayments: 'restricted', requirementsCount: 2 })
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(false)

    world.connect.accountStatus = connectStatus({ merchantConfigured: false, cardPayments: 'active' })
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(false)
  })

  it('is false without any Stripe Account', async () => {
    const world = createWorld()
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(false)
    expect(world.connect.calls.getAccountStatus).toBe(0)
  })

  it('fails closed and logs when Stripe is unavailable or errors', async () => {
    const world = createWorld()
    world.profiles.set('merchant-a', { merchantId: 'merchant-a', stripeAccountId: 'acct_merchant-a' })
    world.connect.accountStatus = connectStatus({ cardPayments: 'active' })

    world.connect.statusFailure = new ConnectUnavailableError('disabled')
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(false)
    world.connect.statusFailure = new Error('network')
    await expect(world.useCases.isReady('merchant-a')).resolves.toBe(false)

    expect(world.warn).toHaveBeenCalledTimes(2)
    expect(world.warn).toHaveBeenCalledWith(
      { merchantId: 'merchant-a', errorClass: 'ConnectUnavailableError' },
      expect.any(String)
    )
  })
})
