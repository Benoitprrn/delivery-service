import type { DriverEntityType } from '../domain/driver-account.js'
import { derivePayoutReadiness } from '../domain/driver-account.js'
import {
  DriverConnectProviderError,
  DriverConnectUnavailableError,
  type CapabilityState,
  type AccountSessionPurpose,
  type DriverConnectProvider,
  type RequirementsState
} from '../ports/driver-connect-provider.js'
import type { DriverConnectAccountRecord, DriverConnectRepository } from '../ports/driver-connect-repository.js'

export class DriverPayoutAccountNotFoundError extends Error {
  public constructor() { super('The driver has no payout account yet'); this.name = 'DriverPayoutAccountNotFound' }
}
/** D-P : le type d'entité est choisi UNE fois avant l'onboarding ; un changement relève d'un traitement manuel. */
export class DriverEntityTypeLockedError extends Error {
  public constructor(public readonly currentEntityType: DriverEntityType) { super('The payout account entity type cannot be changed'); this.name = 'DriverEntityTypeLocked' }
}

export type PayoutAccountView =
  | { state: 'not_created' }
  | {
    state: 'created'
    entityType: DriverEntityType
    /** Vrai seulement si le livreur peut recevoir des courses et des paiements (garde D-F). */
    ready: boolean
    /** Une action du livreur (onboarding, pièce demandée) est nécessaire. */
    actionRequired: boolean
    transfers: CapabilityState
    requirements: RequirementsState
    /** Vrai si Stripe est injoignable : l'état affiché est le dernier connu. */
    stale: boolean
  }

const KNOWN_CAPABILITIES: readonly string[] = ['inactive', 'pending', 'active', 'restricted', 'unknown']
const KNOWN_REQUIREMENTS: readonly string[] = ['none', 'eventually_due', 'currently_due', 'past_due', 'disabled']

function toView(record: DriverConnectAccountRecord, stale: boolean): PayoutAccountView {
  const readiness = derivePayoutReadiness({ transfersStatus: record.transfersStatus, requirementsState: record.requirementsState, payoutsStatus: record.payoutsStatus })
  const ready = readiness === 'ready' && record.restrictedAt === null
  return {
    state: 'created',
    entityType: record.entityType,
    ready,
    actionRequired: !ready || record.requirementsState === 'currently_due',
    transfers: (KNOWN_CAPABILITIES.includes(record.transfersStatus) ? record.transfersStatus : 'unknown') as CapabilityState,
    requirements: (KNOWN_REQUIREMENTS.includes(record.requirementsState) ? record.requirementsState : 'currently_due') as RequirementsState,
    stale
  }
}

export class DriverPayoutAccountUseCases {
  public constructor(
    private readonly repository: DriverConnectRepository,
    private readonly provider: DriverConnectProvider,
    private readonly urls: { returnUrl: string; refreshUrl: string }
  ) {}

  /** Création EXPLICITE (« Configurer mes paiements »), idempotente ; le type d'entité est ensuite verrouillé. */
  public async create(input: { driverId: string; entityType: DriverEntityType; displayName: string; contactEmail: string | undefined }): Promise<PayoutAccountView> {
    const existing = await this.repository.findByDriverId(input.driverId)
    if (existing !== null) {
      if (existing.entityType !== input.entityType) throw new DriverEntityTypeLockedError(existing.entityType)
      return this.get(input.driverId)
    }
    // Clé déterministe par livreur : deux appels concurrents obtiennent le même compte Stripe ; le réseau reste hors transaction.
    const created = await this.provider.createRecipientAccount({
      driverId: input.driverId,
      displayName: input.displayName,
      contactEmail: input.contactEmail,
      entityType: input.entityType,
      idempotencyKey: `driver-connect-account-${input.driverId}`
    })
    await this.repository.insertIfAbsent({ driverId: input.driverId, stripeAccountId: created.accountId, entityType: input.entityType, livemode: created.livemode })
    const stored = await this.repository.findByDriverId(input.driverId)
    if (stored === null) throw new Error('Driver payout account was not persisted')
    if (stored.entityType !== input.entityType) throw new DriverEntityTypeLockedError(stored.entityType)
    return this.get(input.driverId)
  }

  /** Relit Stripe (source de vérité) et met le cache local à jour ; Stripe injoignable = dernier état connu, marqué `stale`. */
  public async get(driverId: string): Promise<PayoutAccountView> {
    const record = await this.repository.findByDriverId(driverId)
    if (record === null) return { state: 'not_created' }
    try {
      const refreshed = await this.sync(driverId)
      return toView(refreshed ?? record, false)
    } catch (error) {
      if (error instanceof DriverConnectUnavailableError || error instanceof DriverConnectProviderError) return toView(record, true)
      throw error
    }
  }

  /** Point d'entrée des webhooks : relit le compte chez Stripe puis met à jour l'état local (jamais depuis l'événement). */
  public async sync(driverId: string): Promise<DriverConnectAccountRecord | null> {
    const record = await this.repository.findByDriverId(driverId)
    if (record === null) return null
    const status = await this.provider.getAccountStatus(record.stripeAccountId)
    return this.repository.updateStatus(driverId, { transfers: status.transfers, payouts: status.payouts, requirements: status.requirements })
  }

  public async createOnboardingLink(driverId: string): Promise<{ url: string; expiresAt: Date }> {
    return this.provider.createOnboardingLink({ accountId: await this.accountId(driverId), ...this.urls })
  }

  public async createAccountSession(driverId: string, purpose: AccountSessionPurpose): Promise<{ clientSecret: string; expiresAt: Date }> {
    return this.provider.createAccountSession(await this.accountId(driverId), purpose)
  }

  public async createDashboardLink(driverId: string): Promise<{ url: string }> {
    return this.provider.createDashboardLink(await this.accountId(driverId))
  }

  private async accountId(driverId: string): Promise<string> {
    const record = await this.repository.findByDriverId(driverId)
    if (record === null) throw new DriverPayoutAccountNotFoundError()
    return record.stripeAccountId
  }
}
