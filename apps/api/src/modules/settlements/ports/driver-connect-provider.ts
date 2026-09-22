import type { DriverEntityType } from '../domain/driver-account.js'

/**
 * Port Stripe Connect du compte de paiement d'un livreur (ADR 0004, D-G/D-H/D-P) : Account v2 `recipient`
 * (`stripe_balance.stripe_transfers`), `dashboard=express`, frais et pertes portés par la plateforme (seules valeurs
 * acceptées, essais SP5). Stripe collecte le KYC ; aucune identité/IBAN ne transite ni n'est stocké chez Locadely.
 */
export type CapabilityState = 'inactive' | 'pending' | 'active' | 'restricted' | 'unknown'
export type RequirementsState = 'none' | 'eventually_due' | 'currently_due' | 'past_due' | 'disabled'
export type AccountSessionPurpose = 'onboarding' | 'wallet'

export type DriverConnectAccountStatus = {
  accountId: string
  /** Type d'entité relu chez Stripe (informatif : le choix initial est verrouillé localement). */
  entityType: DriverEntityType | null
  transfers: CapabilityState
  payouts: CapabilityState
  requirements: RequirementsState
}

export interface DriverConnectProvider {
  /** Création idempotente (clé déterministe par livreur) : un rejeu renvoie le MÊME compte. */
  createRecipientAccount(input: {
    driverId: string
    displayName: string
    contactEmail: string | undefined
    entityType: DriverEntityType
    idempotencyKey: string
  }): Promise<{ accountId: string; livemode: boolean }>
  getAccountStatus(accountId: string): Promise<DriverConnectAccountStatus>
  /** Lien d'onboarding hébergé à usage unique (repli du composant embarqué). */
  createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: Date }>
  /** Secret de session pour l'onboarding embarqué (composant React Native) ; jamais stocké ni journalisé. */
  createAccountSession(accountId: string, purpose: AccountSessionPurpose): Promise<{ clientSecret: string; expiresAt: Date }>
  /** Lien du Dashboard Express : refusé par Stripe tant que l'onboarding n'est pas terminé. */
  createDashboardLink(accountId: string): Promise<{ url: string }>
}

export class DriverConnectUnavailableError extends Error {
  public constructor(message = 'Stripe is not configured') { super(message); this.name = 'DriverConnectUnavailable' }
}
export class DriverConnectProviderError extends Error {
  public constructor(public readonly cause: unknown) { super('Stripe request failed'); this.name = 'DriverConnectProviderError' }
}
/** Rejeu d'une création avec des paramètres différents (ex. autre type d'entité) sous la même clé d'idempotence. */
export class DriverConnectIdempotencyConflictError extends Error {
  public constructor() { super('A payout account creation with different parameters is already recorded'); this.name = 'DriverConnectIdempotencyConflict' }
}
/** Stripe refuse l'action tant que l'onboarding n'est pas terminé (ex. lien de Dashboard). */
export class DriverConnectOnboardingIncompleteError extends Error {
  public constructor() { super('The payout account onboarding is not completed'); this.name = 'DriverConnectOnboardingIncomplete' }
}
