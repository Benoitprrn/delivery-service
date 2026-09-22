import { InvalidAmountError, InvalidReversalReasonError, ReversalApproverError, ReversalDecisionIncompleteError, ReversalLedgerMismatchError, RestaurantDefaultReversalForbiddenError } from './errors.js'
import { parseReversalCategory, planReversal, type ReversalCategory } from './reversal.js'

/** Motifs ÉNUMÉRÉS : aucun ne peut désigner un impayé, un litige ou une défaillance de restaurant (la base refuse tout autre code). */
export const DRIVER_FAULT_REASON_CODES = ['order_stolen', 'order_lost', 'order_damaged', 'fraud', 'other_validated_decision'] as const
export const LOCADELY_ERROR_REASON_CODES = ['duplicate_transfer', 'wrong_recipient', 'wrong_amount', 'other_locadely_error'] as const
export type ReversalReasonCode = typeof DRIVER_FAULT_REASON_CODES[number] | typeof LOCADELY_ERROR_REASON_CODES[number]
/** Ces motifs visent une commande précise du statement (traçabilité). */
export const ORDER_SCOPED_REASON_CODES: readonly ReversalReasonCode[] = ['order_stolen', 'order_lost', 'order_damaged']

export type ReversalRequest = {
  category: ReversalCategory
  reasonCode: ReversalReasonCode
  reason: string
  decisionReference: string
  amountCents: number
  orderId: string | null
}

/** Valide une DEMANDE de reversal : catégorie B/C, motif énuméré cohérent, décision référencée, montant entier > 0, commande si le motif l'exige. */
export function validateReversalRequest(input: { category: string; reasonCode: string; reason: string; decisionReference: string; amountCents: number; orderId?: string | null }): ReversalRequest {
  const category = parseReversalCategory(input.category)
  if (/restaurant|merchant|sepa|impay|dispute|litige/i.test(input.reasonCode)) throw new RestaurantDefaultReversalForbiddenError()
  const allowed: readonly string[] = category === 'driver_fault' ? DRIVER_FAULT_REASON_CODES : LOCADELY_ERROR_REASON_CODES
  if (!allowed.includes(input.reasonCode)) throw new InvalidReversalReasonError()
  if (input.reason.trim() === '' || input.decisionReference.trim() === '') throw new ReversalDecisionIncompleteError()
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new ReversalDecisionIncompleteError()
  const reasonCode = input.reasonCode as ReversalReasonCode
  const orderId = input.orderId ?? null
  if (ORDER_SCOPED_REASON_CODES.includes(reasonCode) && orderId === null) throw new InvalidReversalReasonError('This reason code needs the concerned order')
  return { category, reasonCode, reason: input.reason.trim(), decisionReference: input.decisionReference.trim(), amountCents: input.amountCents, orderId }
}

/** Le demandeur ne peut jamais approuver sa propre reversal. */
export function assertDistinctApprover(requestedBy: string, approvedBy: string): void {
  if (requestedBy === approvedBy) throw new ReversalApproverError()
}

/** Où se trouvent les fonds du Transfer chez le livreur : `pending` tant que la charge source n'est pas disponible (SP4 : la reversal prélève dans le MÊME état). */
export function fundsBucket(chargeAvailableOn: Date | null, now: Date): 'pending' | 'available' {
  return chargeAvailableOn !== null && chargeAvailableOn.getTime() <= now.getTime() ? 'available' : 'pending'
}

export type ReversalPlan = {
  /** Montant réellement reversé chez Stripe (jamais plus que ce que le livreur a comme solde dans le bon compartiment). */
  reverseNowCents: number
  /** Reste dû par le livreur, tracé en `driver_receivable` (jamais un solde négatif provoqué par nous). */
  receivableCents: number
  recoverableCents: number
  bucket: 'pending' | 'available'
}

/**
 * DÉCISION d'exécution, prise AVANT tout appel Stripe (SP4 : Stripe accepte une reversal même si le livreur est déjà payé et laisse un
 * solde négatif, compensé ensuite sur ses futurs Transfers). Nous ne le provoquons jamais : on reverse au plus le solde recouvrable du bon
 * compartiment ; le reste devient une créance tracée. Refus explicite si Stripe et le ledger divergent ou si le montant dépasse le restant.
 */
export function decideReversalExecution(input: {
  requestedCents: number
  transfer: { amountCents: number; ledgerReversedCents: number; stripeAmountReversedCents: number; chargeAvailableOn: Date | null }
  driverBalance: { availableCents: number; pendingCents: number }
  now: Date
  /** Décision explicite d'accepter un solde négatif (compensation Stripe sur gains futurs : à valider juridiquement, jamais activée en R61). */
  allowNegativeBalance?: boolean
}): ReversalPlan {
  const { transfer, driverBalance } = input
  if (![input.requestedCents, transfer.amountCents, transfer.ledgerReversedCents, transfer.stripeAmountReversedCents].every((v) => Number.isSafeInteger(v) && v >= 0) || input.requestedCents === 0) throw new InvalidAmountError()
  if (!Number.isSafeInteger(driverBalance.availableCents) || !Number.isSafeInteger(driverBalance.pendingCents)) throw new InvalidAmountError()
  if (transfer.stripeAmountReversedCents !== transfer.ledgerReversedCents) throw new ReversalLedgerMismatchError()
  const bucket = fundsBucket(transfer.chargeAvailableOn, input.now)
  const balance = bucket === 'pending' ? driverBalance.pendingCents : driverBalance.availableCents
  const recoverableCents = Math.max(0, balance)
  const plan = planReversal({
    requestedCents: input.requestedCents, transferCents: transfer.amountCents, alreadyReversedCents: transfer.stripeAmountReversedCents,
    driverRecoverableBalanceCents: recoverableCents, allowNegativeBalance: input.allowNegativeBalance === true
  })
  return { ...plan, recoverableCents, bucket }
}
