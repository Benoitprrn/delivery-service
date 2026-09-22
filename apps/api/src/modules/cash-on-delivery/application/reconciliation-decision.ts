import type { CashOnDeliveryPaymentStatus } from '../domain/cash-on-delivery-payment-state-machine.js'
import type { CashOnDeliveryPayment } from '../ports/cash-on-delivery-payment-repository.js'
import type { TerminalPaymentIntent } from '../ports/connect-payments-provider.js'

/** Statuts locaux dont le sort dépend encore de Stripe. */
export const ACTIVE_PAYMENT_STATUSES: readonly CashOnDeliveryPaymentStatus[] = ['created', 'intent_created', 'processing', 'authorized', 'unknown']
/** Statuts locaux définitifs : plus de transition possible. */
export const TERMINAL_PAYMENT_STATUSES: readonly CashOnDeliveryPaymentStatus[] = ['captured', 'failed', 'canceled']

export type ReconciliationDecision =
  /** Le PaymentIntent ne correspond pas au paiement local : ne jamais compléter. */
  | { kind: 'contaminated'; mismatches: string[] }
  /** Capturé chez Stripe : compléter atomiquement (jamais de seconde capture). */
  | { kind: 'complete_captured' }
  /** Capturé chez Stripe alors que le paiement local est déjà `failed`/`canceled` : revue humaine. */
  | { kind: 'captured_on_terminal_payment' }
  /** Autorisé chez Stripe, session encore vivante : refléter `authorized`. */
  | { kind: 'mark_authorized' }
  /** Annuler le PaymentIntent (libère l'autorisation) ; `local` = statut local cible, `null` = déjà terminal. */
  | { kind: 'cancel_intent'; local: 'canceled' | 'failed' | null }
  /** Déjà annulé chez Stripe : refléter `canceled`. */
  | { kind: 'mark_canceled' }
  /** Rien à faire pour l'instant. */
  | { kind: 'wait' }

/**
 * Champs (jamais leurs valeurs) pour lesquels le PaymentIntent lu chez Stripe
 * s'écarte du paiement local. Même contrat que la validation de `finalize`.
 */
export function findPaymentIntentMismatches(intent: TerminalPaymentIntent, payment: CashOnDeliveryPayment): string[] {
  const mismatches: string[] = []
  if (intent.id !== payment.stripePaymentIntentId) mismatches.push('id')
  if (intent.accountId !== payment.stripeAccountId) mismatches.push('account')
  if (intent.amountCents !== payment.amountCents) mismatches.push('amount')
  if (intent.currency !== 'eur') mismatches.push('currency')
  if (intent.captureMethod !== 'manual') mismatches.push('capture_method')
  if (intent.paymentMethodTypes.length !== 1 || intent.paymentMethodTypes[0] !== 'card_present') mismatches.push('payment_method_types')
  if (intent.applicationFeeAmountCents !== null) mismatches.push('application_fee')
  if (intent.hasTransferData) mismatches.push('transfer_data')
  if (intent.hasOnBehalfOf) mismatches.push('on_behalf_of')
  if (intent.metadata.order_id !== payment.orderId) mismatches.push('metadata.order_id')
  if (intent.metadata.payment_id !== payment.id) mismatches.push('metadata.payment_id')
  return mismatches
}

/**
 * Fonction pure : que faire d'un paiement local au vu du PaymentIntent lu chez
 * Stripe. `sessionAbandoned` = session expirée depuis plus que le délai de grâce.
 */
export function decideReconciliation(input: {
  payment: CashOnDeliveryPayment
  intent: TerminalPaymentIntent
  sessionAbandoned: boolean
}): ReconciliationDecision {
  const { payment, intent } = input
  const mismatches = findPaymentIntentMismatches(intent, payment)
  if (mismatches.length > 0) return { kind: 'contaminated', mismatches }

  const terminal = TERMINAL_PAYMENT_STATUSES.includes(payment.status)
  const dead = payment.status === 'failed' || payment.status === 'canceled' || input.sessionAbandoned

  switch (intent.status) {
    case 'succeeded':
      if (intent.amountReceivedCents !== payment.amountCents) return { kind: 'contaminated', mismatches: ['amount_received'] }
      return terminal ? { kind: 'captured_on_terminal_payment' } : { kind: 'complete_captured' }
    case 'canceled':
      return terminal ? { kind: 'wait' } : { kind: 'mark_canceled' }
    case 'requires_capture':
      if (dead) return { kind: 'cancel_intent', local: terminal ? null : 'canceled' }
      return ['intent_created', 'processing', 'unknown'].includes(payment.status) ? { kind: 'mark_authorized' } : { kind: 'wait' }
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      if (!dead) return { kind: 'wait' }
      if (terminal) return { kind: 'cancel_intent', local: null }
      return { kind: 'cancel_intent', local: intent.lastPaymentErrorCode !== null ? 'failed' : 'canceled' }
    default:
      // `processing` ou statut inconnu : Stripe n'a pas tranché.
      return { kind: 'wait' }
  }
}
