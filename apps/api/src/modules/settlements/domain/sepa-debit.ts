import { classifyCharge } from './charge-classification.js'
import { InvalidIdempotencyKeyInputError } from './errors.js'
import type { LocalDate } from './local-date.js'
import { parisLocalTimeToUtc } from './paris-time.js'

/** Heure locale (Europe/Paris) à partir de laquelle le prélèvement du jour annoncé peut être créé : avant le cut-off SEPA de Stripe (10:30 CET). */
export const DEBIT_START_LOCAL_HOUR = 8

/** Clé d'idempotence Stripe d'une tentative : rejeu de la MÊME clé après crash/timeout, jamais un second PaymentIntent. */
export function buildDebitIdempotencyKey(input: { merchantSettlementId: string; attemptNo: number }): string {
  if (!input.merchantSettlementId || input.merchantSettlementId.includes(':') || !Number.isSafeInteger(input.attemptNo) || input.attemptNo < 1) throw new InvalidIdempotencyKeyInputError()
  return `debit:${input.merchantSettlementId}:attempt:${input.attemptNo}`
}

/** Le débit annoncé pour `debitDate` ne se crée jamais avant `debitDate` 08:00 Europe/Paris. */
export function isDebitDue(debitDate: LocalDate, now: Date, startHour = DEBIT_START_LOCAL_HOUR): boolean {
  return parisLocalTimeToUtc(debitDate, startHour, 0).getTime() <= now.getTime()
}

export type MandateCheck = { ok: true } | { ok: false; reason: 'no_active_sepa_method' | 'mandate_changed' }
/** Le mandat actif AU MOMENT du prélèvement doit être celui cité dans la pré-notification envoyée. */
export function checkNotifiedMandate(input: { notifiedMandateReference: string; activeMandateReference: string | null | undefined }): MandateCheck {
  if (input.activeMandateReference === null || input.activeMandateReference === undefined) return { ok: false, reason: 'no_active_sepa_method' }
  return input.activeMandateReference === input.notifiedMandateReference ? { ok: true } : { ok: false, reason: 'mandate_changed' }
}

/** Ce que Stripe dit d'un PaymentIntent de débit et de sa charge (lecture seule). */
export type DebitObservation = {
  paymentIntentId: string
  paymentIntentStatus: string
  amountCents: number
  currency: string
  livemode: boolean
  attemptIdMetadata: string | null
  chargeId: string | null
  chargeStatus: string | null
  paid: boolean
  hasBalanceTransaction: boolean
  availableOn: Date | null
  failureCode: string | null
  /** Litige ouvert sur la charge / montant remboursé (relus chez Stripe) : un débit `succeeded` contesté ne finance plus aucun Transfer. */
  disputed?: boolean
  amountRefundedCents?: number
}

/**
 * `failed` = REJET RÉEL du prélèvement (banque/Stripe : la charge a échoué) : le restaurant reste débiteur.
 * `technical` = tout ce qui ne prouve pas un impayé (annulation, statut inattendu, PaymentIntent sans erreur de paiement…) : intervention
 * requise, le restaurant n'est JAMAIS qualifié d'impayé.
 */
export type DebitClassification =
  | { state: 'processing' | 'succeeded'; failureCode: null }
  | { state: 'failed'; failureCode: string }
  | { state: 'technical'; failureCode: string }

/** `succeeded` UNIQUEMENT si PI + charge `succeeded`, `paid` et `balance_transaction` présent (même règle que le pré-contrôle des Transferts, R60). */
export function classifyDebitObservation(observation: DebitObservation): DebitClassification {
  const charged = classifyCharge({
    paymentIntentStatus: observation.paymentIntentStatus,
    chargeStatus: observation.chargeStatus ?? 'none',
    paid: observation.paid,
    hasBalanceTransaction: observation.hasBalanceTransaction,
    amountCents: observation.amountCents
  })
  if (charged === 'succeeded') return { state: 'succeeded', failureCode: null }
  if (observation.paymentIntentStatus === 'canceled') return { state: 'technical', failureCode: 'technical:payment_intent_canceled' }
  if (observation.chargeStatus === 'failed') return { state: 'failed', failureCode: observation.failureCode ?? 'payment_failed' }
  if (observation.paymentIntentStatus === 'requires_payment_method') {
    return observation.failureCode === null
      ? { state: 'technical', failureCode: 'technical:requires_payment_method_without_error' }
      : { state: 'failed', failureCode: observation.failureCode }
  }
  if (observation.chargeStatus === 'canceled') return { state: 'technical', failureCode: 'technical:charge_canceled' }
  if (observation.paymentIntentStatus !== 'processing' && observation.paymentIntentStatus !== 'succeeded') return { state: 'technical', failureCode: `technical:unexpected_status:${observation.paymentIntentStatus}` }
  return { state: 'processing', failureCode: null }
}
