/**
 * Port Stripe Connect / Terminal du module cash-on-delivery.
 *
 * Indépendant du modèle de charge : le use case ne connaît que le restaurant
 * (`accountId` = Account Stripe v2 du restaurant). L'implémentation Direct
 * (`StripeConnectDirectProvider`) exécute tout sous `Stripe-Account`. Une
 * éventuelle implémentation Destination (PI plateforme + `transfer_data`) devra
 * respecter ce même contrat ; aucun appelant ne doit brancher sur le modèle.
 */

export type CapabilityStatus = 'active' | 'pending' | 'restricted' | 'inactive' | 'not_requested'

export type ConnectAccountStatus = {
  accountId: string
  merchantConfigured: boolean
  dashboard: 'full' | 'none' | 'express' | null
  cardPayments: CapabilityStatus
  cartesBancaires: CapabilityStatus
  /** Nombre d'informations encore demandées par Stripe (jamais leur contenu). */
  requirementsCount: number
}

export type TerminalPaymentIntent = {
  id: string
  accountId: string
  status: string
  amountCents: number
  amountCapturableCents: number
  amountReceivedCents: number
  currency: string
  clientSecret: string | null
  metadata: Record<string, string>
  captureMethod: string
  paymentMethodTypes: string[]
  applicationFeeAmountCents: number | null
  hasTransferData: boolean
  hasOnBehalfOf: boolean
  chargeId: string | null
  lastPaymentErrorCode: string | null
  lastPaymentErrorDeclineCode: string | null
}

export type TerminalAddress = { line1: string; city: string; postalCode: string; country: string }

export interface ConnectPaymentsProvider {
  /**
   * Ajoute la configuration `merchant` (opt-in du restaurant) : `dashboard=full`,
   * responsabilités `stripe`/`stripe`, capabilities `card_payments` ET
   * `cartes_bancaires_payments`. Irréversible côté API (dashboard/responsabilités).
   */
  addMerchantConfiguration(input: { accountId: string }): Promise<void>
  /** Lien d'onboarding hébergé à usage unique : `configurations` = TOUTES les configurations appliquées. */
  createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: Date }>
  getAccountStatus(accountId: string): Promise<ConnectAccountStatus>
  /** Location Terminal du restaurant, créée sur SON compte (idempotente par nom). */
  ensureTerminalLocation(input: { accountId: string; displayName: string; address: TerminalAddress }): Promise<{ locationId: string }>
  /** Secret de connexion Terminal borné à la Location, créé sous le compte du restaurant. */
  createConnectionToken(input: { accountId: string; locationId: string }): Promise<{ secret: string }>
  /** PI `card_present`, capture manuelle, sans frais plateforme ni transfert. */
  createTerminalPaymentIntent(input: {
    accountId: string
    amountCents: number
    currency: 'eur'
    idempotencyKey: string
    metadata: { orderId: string; merchantId: string; paymentId: string }
  }): Promise<TerminalPaymentIntent>
  retrievePaymentIntent(input: { accountId: string; paymentIntentId: string }): Promise<TerminalPaymentIntent>
  /** Capture du montant TOTAL du PI (jamais de montant fourni par un client). */
  capturePaymentIntent(input: { accountId: string; paymentIntentId: string; idempotencyKey: string }): Promise<TerminalPaymentIntent>
  cancelPaymentIntent(input: { accountId: string; paymentIntentId: string; idempotencyKey: string }): Promise<TerminalPaymentIntent>
}

/** Stripe refuse l'opération à cause de l'état du PI (ex. déjà capturé) : relire le PI puis décider. */
export class PaymentIntentUnexpectedStateError extends Error {
  constructor(cause?: unknown) {
    super('PaymentIntent is not in a state that allows this operation', { cause })
  }
}
export class ConnectResourceMissingError extends Error {
  constructor(cause?: unknown) {
    super('Stripe resource missing for this account', { cause })
  }
}
export class ConnectUnavailableError extends Error {}
export class ConnectProviderError extends Error {
  constructor(cause?: unknown) {
    super('Stripe Connect request failed', { cause })
  }
}
