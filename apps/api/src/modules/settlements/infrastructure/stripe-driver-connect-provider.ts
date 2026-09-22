import Stripe from 'stripe'
import type { DriverEntityType } from '../domain/driver-account.js'
import {
  DriverConnectIdempotencyConflictError,
  DriverConnectOnboardingIncompleteError,
  DriverConnectProviderError,
  DriverConnectUnavailableError,
  type CapabilityState,
  type AccountSessionPurpose,
  type DriverConnectAccountStatus,
  type DriverConnectProvider,
  type RequirementsState
} from '../ports/driver-connect-provider.js'

type V2Options = { apiVersion?: string }

/**
 * Account v2 `recipient` Express (essais Sandbox SP5) : `dashboard=express`, `fees_collector`/`losses_collector` =
 * `application` (seules valeurs acceptées), Stripe collecte le KYC (`requirements_collector: stripe`, aucun token de
 * compte requis). Les appels `v2.core.*` n'envoient aucune version explicite (voir apps/api/CLAUDE.md).
 */
export class StripeDriverConnectProvider implements DriverConnectProvider {
  public constructor(private readonly stripe: Stripe, private readonly accountsV2ApiVersion?: string) {}

  public async createRecipientAccount(input: { driverId: string; displayName: string; contactEmail: string | undefined; entityType: DriverEntityType; idempotencyKey: string }): Promise<{ accountId: string; livemode: boolean }> {
    const account = await this.request(() => this.stripe.v2.core.accounts.create({
      display_name: input.displayName,
      ...(input.contactEmail === undefined ? {} : { contact_email: input.contactEmail }),
      dashboard: 'express',
      identity: { country: 'fr', entity_type: input.entityType },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      defaults: { currency: 'eur', responsibilities: { fees_collector: 'application', losses_collector: 'application' }, locales: ['fr-FR'] },
      metadata: { driver_id: input.driverId }
    }, { ...this.v2Options(), idempotencyKey: input.idempotencyKey }))
    return { accountId: account.id, livemode: account.livemode }
  }

  public async getAccountStatus(accountId: string): Promise<DriverConnectAccountStatus> {
    const account = await this.request(() => this.stripe.v2.core.accounts.retrieve(accountId, { include: ['configuration.recipient', 'identity', 'requirements'] }, this.v2Options()))
    return mapRecipientStatus(account)
  }

  public async createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: Date }> {
    const link = await this.request(() => this.stripe.v2.core.accountLinks.create({
      account: input.accountId,
      // Doit être EXACTEMENT l'ensemble des configurations appliquées au compte : ici `recipient` seulement.
      use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['recipient'], return_url: input.returnUrl, refresh_url: input.refreshUrl } }
    }, this.v2Options()))
    return { url: link.url, expiresAt: new Date(link.expires_at) }
  }

  public async createAccountSession(accountId: string, purpose: AccountSessionPurpose): Promise<{ clientSecret: string; expiresAt: Date }> {
    const components = purpose === 'onboarding'
      ? { account_onboarding: { enabled: true } }
      : { payments: { enabled: true }, payouts: { enabled: true } }
    const session = await this.request(() => this.stripe.accountSessions.create({ account: accountId, components }))
    return { clientSecret: session.client_secret, expiresAt: new Date(session.expires_at * 1000) }
  }

  public async createDashboardLink(accountId: string): Promise<{ url: string }> {
    try {
      const link = await this.stripe.accounts.createLoginLink(accountId)
      return { url: link.url }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && /not completed onboarding/i.test(error.message)) throw new DriverConnectOnboardingIncompleteError()
      throw this.wrap(error)
    }
  }

  private v2Options(): V2Options { return this.accountsV2ApiVersion === undefined ? {} : { apiVersion: this.accountsV2ApiVersion } }

  private wrap(error: unknown): unknown {
    if (error instanceof Stripe.errors.StripeError) return new DriverConnectProviderError(error)
    return error
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof Stripe.errors.StripeIdempotencyError) throw new DriverConnectIdempotencyConflictError()
      throw this.wrap(error)
    }
  }
}

export class UnavailableDriverConnectProvider implements DriverConnectProvider {
  private unavailable(): DriverConnectUnavailableError { return new DriverConnectUnavailableError() }
  public createRecipientAccount(): Promise<{ accountId: string; livemode: boolean }> { return Promise.reject(this.unavailable()) }
  public getAccountStatus(): Promise<DriverConnectAccountStatus> { return Promise.reject(this.unavailable()) }
  public createOnboardingLink(): Promise<{ url: string; expiresAt: Date }> { return Promise.reject(this.unavailable()) }
  public createAccountSession(_accountId: string, _purpose: AccountSessionPurpose): Promise<{ clientSecret: string; expiresAt: Date }> { return Promise.reject(this.unavailable()) }
  public createDashboardLink(): Promise<{ url: string }> { return Promise.reject(this.unavailable()) }
}

type RecipientAccountLike = {
  id: string
  closed?: boolean | null | undefined
  identity?: { entity_type?: string | null | undefined } | null | undefined
  configuration?: { recipient?: { capabilities?: { stripe_balance?: { stripe_transfers?: { status?: string } | null; payouts?: { status?: string } | null } | null } | null } | null } | null | undefined
  requirements?: { entries?: readonly unknown[] | null; summary?: { minimum_deadline?: { status?: string } | null } | null } | null | undefined
}

function capability(value: { status?: string } | null | undefined): CapabilityState {
  if (value === null || value === undefined || value.status === undefined) return 'inactive'
  if (value.status === 'active' || value.status === 'pending' || value.status === 'restricted') return value.status
  return value.status === 'unsupported' ? 'restricted' : 'unknown'
}

function requirementsState(account: RecipientAccountLike): RequirementsState {
  if (account.closed === true) return 'disabled'
  const entries = account.requirements?.entries ?? []
  if (entries.length === 0) return 'none'
  const deadline = account.requirements?.summary?.minimum_deadline?.status
  return deadline === 'past_due' || deadline === 'eventually_due' || deadline === 'currently_due' ? deadline : 'currently_due'
}

/** Projection PURE d'un Account v2 (relu chez Stripe) vers l'état local ; exportée pour les tests. Fail-closed : inconnu ≠ actif. */
export function mapRecipientStatus(account: RecipientAccountLike): DriverConnectAccountStatus {
  const balance = account.configuration?.recipient?.capabilities?.stripe_balance
  const entity = account.identity?.entity_type
  return {
    accountId: account.id,
    entityType: entity === 'individual' || entity === 'company' ? entity : null,
    transfers: account.closed === true ? 'restricted' : capability(balance?.stripe_transfers),
    payouts: account.closed === true ? 'restricted' : capability(balance?.payouts),
    requirements: requirementsState(account)
  }
}
