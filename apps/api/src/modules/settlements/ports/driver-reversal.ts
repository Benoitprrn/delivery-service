import type { ReversalPlan, ReversalReasonCode, ReversalRequest } from '../domain/reversal-decision.js'
import type { ReversalCategory } from '../domain/reversal.js'

export type ReversalRecord = {
  id: string
  driverTransferId: string
  category: ReversalCategory
  reasonCode: ReversalReasonCode
  reason: string
  decisionReference: string
  amountCents: number
  orderId: string | null
  requestedBy: string
  approvedBy: string | null
  status: 'pending_approval' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'rejected'
  reversedCents: number | null
  plannedReverseCents: number | null
  plannedReceivableCents: number | null
  stripeReversalId: string | null
  failureCode: string | null
}

export type RequestReversalResult = { outcome: 'created' | 'duplicate'; reversal: ReversalRecord } | { outcome: 'conflict' } | { outcome: 'refused'; reason: 'transfer_not_reversible' | 'amount_exceeds_transfer' | 'order_not_in_statement' }

/** Reversal réservée par un worker, avec tout ce qu'il faut pour décider sans autre lecture en base. */
export type ReversalWork = {
  id: string
  attemptCount: number
  claimToken: string
  driverTransferId: string
  stripeTransferId: string
  transferAmountCents: number
  destinationAccountId: string
  sourceChargeId: string
  chargeAvailableOn: Date | null
  livemode: boolean
  driverId: string
  statementId: string
  amountCents: number
  category: ReversalCategory
  reasonCode: ReversalReasonCode
  reason: string
  decisionReference: string
  orderId: string | null
  idempotencyKey: string
  /** Σ des reversals RÉUSSIES de ce Transfer (hors celle-ci) : le ledger. */
  ledgerReversedCents: number
  /** Plan déjà décidé lors d'une tentative précédente : il est REPRIS tel quel, jamais recalculé. */
  plan: (ReversalPlan & { stripeAmountReversedBeforeCents: number }) | null
  stripeReversalId: string | null
}

export interface DriverReversalRepository {
  createRequest(input: ReversalRequest & { driverTransferId: string; requestedBy: string }): Promise<RequestReversalResult>
  approve(input: { reversalId: string; approvedBy: string; now: Date }): Promise<'approved' | 'not_pending' | 'not_found'>
  reject(input: { reversalId: string; rejectedBy: string; reason: string; now: Date }): Promise<'rejected' | 'not_pending' | 'not_found'>
  findById(reversalId: string): Promise<ReversalRecord | null>
  claimDue(input: { now: Date; limit: number; leaseSeconds: number }): Promise<ReversalWork[]>
  /** Décision d'exécution persistée AVANT l'appel Stripe (plan, soldes lus, montant déjà reversé chez Stripe). */
  persistPlan(input: { reversalId: string; claimToken: string; plan: ReversalPlan; balance: { availableCents: number; pendingCents: number }; stripeAmountReversedBeforeCents: number; now: Date }): Promise<boolean>
  /** UNE transaction : reversal `succeeded` + créance `driver_receivable` du reliquat décidé. */
  complete(input: { reversalId: string; claimToken: string; reversedCents: number; stripeReversalId: string | null; balanceAfter: { availableCents: number; pendingCents: number } | null; now: Date }): Promise<'completed' | 'lost_claim'>
  fail(input: { reversalId: string; claimToken: string; code: string; now: Date }): Promise<void>
  retryLater(input: { reversalId: string; claimToken: string; errorClass: string; retryAfterSeconds: number; now: Date }): Promise<void>
}

export type StripeTransferView = { transferId: string; amountCents: number; amountReversedCents: number; destinationAccountId: string; sourceTransactionId: string | null; livemode: boolean }
export type StripeBalanceView = { availableCents: number; pendingCents: number }
export type StripeReversalView = { reversalId: string; transferId: string; amountCents: number }

export interface DriverReversalProvider {
  readonly livemode: boolean
  retrieveTransfer(transferId: string): Promise<StripeTransferView>
  retrieveDriverBalance(accountId: string): Promise<StripeBalanceView>
  createReversal(input: { idempotencyKey: string; transferId: string; amountCents: number; description: string; metadata: { driver_transfer_reversal_id: string; driver_transfer_id: string; category: string; reason_code: string; decision_reference: string } }): Promise<StripeReversalView>
  /** Reprise : retrouve la reversal déjà créée chez Stripe pour CETTE décision (`metadata.driver_transfer_reversal_id`). */
  findReversal(input: { transferId: string; reversalId: string }): Promise<StripeReversalView | null>
}

/** Refus définitif de Stripe (dépassement du restant, déjà entièrement reversé, requête invalide) : `failed`, aucune donnée modifiée chez Stripe. */
export class ReversalRejectedError extends Error {
  public constructor(public readonly code: string) { super(`Reversal rejected: ${code}`); this.name = 'ReversalRejectedError' }
}
/** Réseau, 5xx, limite, authentification : résultat inconnu, on retrouve puis rejoue avec la MÊME clé et le MÊME plan. */
export class ReversalTransientError extends Error {
  public constructor(public readonly errorClass: string) { super(`Reversal transient failure: ${errorClass}`); this.name = 'ReversalTransientError' }
}
