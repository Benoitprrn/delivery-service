import { describe, expect, it, vi } from 'vitest'
import {
  DriverConnectProviderError,
  DriverEntityTypeLockedError,
  DriverPayoutAccountNotFoundError,
  DriverPayoutAccountUseCases,
  type DriverConnectAccountRecord,
  type DriverConnectAccountStatus,
  type DriverConnectProvider,
  type DriverConnectRepository
} from '../../src/modules/settlements/public.js'

function harness(initial: Partial<DriverConnectAccountRecord> | null = null) {
  let record: DriverConnectAccountRecord | null = initial === null ? null : {
    driverId: 'd1', stripeAccountId: 'acct_1', entityType: 'individual', transfersStatus: 'inactive', payoutsStatus: 'inactive', requirementsState: 'past_due', restrictedAt: null, lastSyncedAt: null, ...initial
  }
  const repository: DriverConnectRepository = {
    findByDriverId: vi.fn(async () => record),
    insertIfAbsent: vi.fn(async (input) => { record ??= { driverId: input.driverId, stripeAccountId: input.stripeAccountId, entityType: input.entityType, transfersStatus: 'inactive', payoutsStatus: 'inactive', requirementsState: 'past_due', restrictedAt: null, lastSyncedAt: null } }),
    updateStatus: vi.fn(async (_id, status) => { if (record === null) return null; record = { ...record, transfersStatus: status.transfers, payoutsStatus: status.payouts, requirementsState: status.requirements }; return record }),
    findDriverIdByAccountId: vi.fn(async () => null)
  }
  const provider = {
    createRecipientAccount: vi.fn(async () => ({ accountId: 'acct_new', livemode: false })),
    getAccountStatus: vi.fn(async (): Promise<DriverConnectAccountStatus> => ({ accountId: 'acct_1', entityType: 'individual', transfers: 'active', payouts: 'active', requirements: 'none' })),
    createOnboardingLink: vi.fn(async () => ({ url: 'https://link', expiresAt: new Date(0) })),
    createAccountSession: vi.fn(async () => ({ clientSecret: 'accs_secret', expiresAt: new Date(0) })),
    createDashboardLink: vi.fn(async () => ({ url: 'https://dash' }))
  } satisfies DriverConnectProvider
  const useCases = new DriverPayoutAccountUseCases(repository, provider, { returnUrl: 'https://app/return', refreshUrl: 'https://app/refresh' })
  return { useCases, repository, provider, current: () => record }
}
const create = (entityType: 'individual' | 'company' = 'individual') => ({ driverId: 'd1', entityType, displayName: 'Jean', contactEmail: undefined })

describe('driver payout account — explicit, idempotent creation with a locked entity type (D-P)', () => {
  it('creates the Stripe account once, under a deterministic key, persists it and returns the refreshed state', async () => {
    const { useCases, provider, repository } = harness()
    provider.getAccountStatus.mockResolvedValue({ accountId: 'acct_new', entityType: 'company', transfers: 'restricted', payouts: 'restricted', requirements: 'past_due' })
    const view = await useCases.create(create('company'))
    expect(provider.createRecipientAccount).toHaveBeenCalledWith({ driverId: 'd1', displayName: 'Jean', contactEmail: undefined, entityType: 'company', idempotencyKey: 'driver-connect-account-d1' })
    expect(repository.insertIfAbsent).toHaveBeenCalledWith({ driverId: 'd1', stripeAccountId: 'acct_new', entityType: 'company', livemode: false })
    expect(view).toMatchObject({ state: 'created', entityType: 'company', ready: false, actionRequired: true, transfers: 'restricted', requirements: 'past_due', stale: false })
  })

  it('does not call Stripe again when the account exists with the same entity type', async () => {
    const { useCases, provider } = harness({ transfersStatus: 'active', requirementsState: 'none' })
    await expect(useCases.create(create('individual'))).resolves.toMatchObject({ state: 'created', ready: true })
    expect(provider.createRecipientAccount).not.toHaveBeenCalled()
  })

  it('refuses to change the entity type once chosen, without touching Stripe', async () => {
    const { useCases, provider } = harness({ entityType: 'individual' })
    await expect(useCases.create(create('company'))).rejects.toBeInstanceOf(DriverEntityTypeLockedError)
    expect(provider.createRecipientAccount).not.toHaveBeenCalled()
  })

  it('locks against a concurrent creation that stored another entity type first', async () => {
    const { useCases, repository } = harness()
    vi.mocked(repository.insertIfAbsent).mockImplementation(async () => undefined) // un autre appel a déjà inséré « company »
    vi.mocked(repository.findByDriverId).mockResolvedValueOnce(null).mockResolvedValue({ driverId: 'd1', stripeAccountId: 'acct_other', entityType: 'company', transfersStatus: 'inactive', payoutsStatus: 'inactive', requirementsState: 'past_due', restrictedAt: null, lastSyncedAt: null })
    await expect(useCases.create(create('individual'))).rejects.toBeInstanceOf(DriverEntityTypeLockedError)
  })
})

describe('driver payout account — state is always re-read from Stripe and fails closed', () => {
  it('reports not_created without any Stripe call', async () => {
    const { useCases, provider } = harness()
    await expect(useCases.get('d1')).resolves.toEqual({ state: 'not_created' })
    expect(provider.getAccountStatus).not.toHaveBeenCalled()
  })

  it('is ready only for an active account: onboarding pending, restricted after activity and a recorded restriction are not', async () => {
    const pending = harness({ transfersStatus: 'pending' })
    pending.provider.getAccountStatus.mockResolvedValue({ accountId: 'a', entityType: 'individual', transfers: 'pending', payouts: 'inactive', requirements: 'currently_due' })
    await expect(pending.useCases.get('d1')).resolves.toMatchObject({ ready: false, actionRequired: true })
    const restricted = harness({ transfersStatus: 'active' })
    restricted.provider.getAccountStatus.mockResolvedValue({ accountId: 'a', entityType: 'individual', transfers: 'restricted', payouts: 'active', requirements: 'past_due' })
    await expect(restricted.useCases.get('d1')).resolves.toMatchObject({ ready: false })
    const flagged = harness({ restrictedAt: new Date() })
    await expect(flagged.useCases.get('d1')).resolves.toMatchObject({ ready: false }) // l'état Stripe est actif mais la base garde `restricted_at` tant que updateStatus ne l'efface pas
  })

  it('serves the last known state marked stale when Stripe is unreachable, never a fake "ready"', async () => {
    const { useCases, provider } = harness({ transfersStatus: 'inactive', requirementsState: 'past_due' })
    provider.getAccountStatus.mockRejectedValue(new DriverConnectProviderError(new Error('down')))
    await expect(useCases.get('d1')).resolves.toMatchObject({ state: 'created', ready: false, stale: true })
  })

  it('maps unknown stored values to unknown/currently_due instead of trusting them', async () => {
    const { useCases, provider } = harness({ transfersStatus: 'weird', requirementsState: 'weird' })
    provider.getAccountStatus.mockRejectedValue(new DriverConnectProviderError(new Error('down')))
    await expect(useCases.get('d1')).resolves.toMatchObject({ ready: false, transfers: 'unknown', requirements: 'currently_due' })
  })

  it('sync (webhook entry point) re-reads Stripe and updates the local state; a missing account is ignored', async () => {
    const { useCases, repository } = harness({})
    await useCases.sync('d1')
    expect(repository.updateStatus).toHaveBeenCalledWith('d1', { transfers: 'active', payouts: 'active', requirements: 'none' })
    const none = harness()
    vi.mocked(none.repository.findByDriverId).mockResolvedValue(null)
    await expect(none.useCases.sync('d1')).resolves.toBeNull()
  })
})

describe('driver payout account — links need an existing account', () => {
  it('fails with NotFound before creation and delegates after it, with the configured return URLs', async () => {
    const missing = harness()
    await expect(missing.useCases.createOnboardingLink('d1')).rejects.toBeInstanceOf(DriverPayoutAccountNotFoundError)
    await expect(missing.useCases.createAccountSession('d1', 'onboarding')).rejects.toBeInstanceOf(DriverPayoutAccountNotFoundError)
    await expect(missing.useCases.createDashboardLink('d1')).rejects.toBeInstanceOf(DriverPayoutAccountNotFoundError)
    const existing = harness({})
    await existing.useCases.createOnboardingLink('d1')
    expect(existing.provider.createOnboardingLink).toHaveBeenCalledWith({ accountId: 'acct_1', returnUrl: 'https://app/return', refreshUrl: 'https://app/refresh' })
    await expect(existing.useCases.createAccountSession('d1', 'wallet')).resolves.toEqual({ clientSecret: 'accs_secret', expiresAt: new Date(0) })
    expect(existing.provider.createAccountSession).toHaveBeenCalledWith('acct_1', 'wallet')
    await expect(existing.useCases.createDashboardLink('d1')).resolves.toEqual({ url: 'https://dash' })
  })
})
