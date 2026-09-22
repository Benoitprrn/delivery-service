import type { StatementStatus } from '../domain/statement-status.js'

export type PayRunWork = { id: string; periodId: string; driverId: string; kind: 'grouped' | 'drip'; scheduledFor: Date; periodStart: Date; periodEnd: Date }

export type PayoutCandidate = {
  statementId: string
  periodId: string
  driverId: string
  merchantSettlementId: string
  dueCents: number
  paidCents: number
  payrunAt: Date
  /** Débit retenu : celui qui a RÉUSSI s'il existe, sinon le plus récent. */
  debit: { id: string; status: 'creating' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'technical_error'; paymentIntentId: string | null; chargeId: string | null; amountCents: number; livemode: boolean; incidentOpen: boolean } | null
  alreadyTransferredFromDebitCents: number
  driverAccount: { stripeAccountId: string; transfersReadyLocally: boolean; livemode: boolean } | null
  openTransfer: { id: string; tryNo: number; idempotencyKey: string; amountCents: number; chargeId: string; debitAttemptId: string; createdAt: Date } | null
  lastTryNo: number
  failedTries: number
}

export type BeginTransferInput = { statementId: string; payRunId: string; debitAttemptId: string; chargeId: string; destinationAccountId: string; amountCents: number; tryNo: number; idempotencyKey: string; livemode: boolean }

export interface DriverPayoutRepository {
  /** Crée les pay-runs manquants : le groupé à `payrun_at` (un seul par livreur et période), puis les « drip » quand un reliquat devient payable. */
  ensureRuns(now: Date): Promise<number>
  claimRuns(input: { now: Date; limit: number; leaseSeconds: number; workerId: string }): Promise<PayRunWork[]>
  listCandidates(run: { periodId: string; driverId: string }, now: Date): Promise<PayoutCandidate[]>
  /** UNE transaction : ligne `driver_transfers` `creating` COMMITÉE avant tout appel Stripe ; les gardes de base peuvent la refuser. */
  beginTransfer(input: BeginTransferInput): Promise<{ outcome: 'created'; transferId: string } | { outcome: 'refused' }>
  /** UNE transaction : Transfer `succeeded` + `paid_cents` + statut du statement (contrainte différée). */
  completeTransfer(input: { transferId: string; stripeTransferId: string; destinationPaymentId: string | null; now: Date }): Promise<'completed' | 'already_final'>
  markTransferUnknown(transferId: string, now: Date): Promise<void>
  failTransfer(input: { transferId: string; code: string; now: Date; retryAfterSeconds: number | null; statementStatus: StatementStatus | null; holdReason: string }): Promise<void>
  setStatementHold(input: { statementId: string; status: StatementStatus; holdReason: string | null; nextAttemptAt: Date | null }): Promise<void>
  finishRun(input: { runId: string; total: number; paid: number; amountCents: number; now: Date }): Promise<void>
  listUnannotated(limit: number): Promise<Array<{ transferId: string; statementId: string; destinationAccountId: string; destinationPaymentId: string; periodStart: Date; periodEnd: Date }>>
  markAnnotated(transferId: string, now: Date): Promise<void>
}

export type TransferResult = { transferId: string; amountCents: number; currency: string; destinationAccountId: string; sourceTransactionId: string | null; destinationPaymentId: string | null; livemode: boolean }

export type CreateTransferInput = {
  idempotencyKey: string
  amountCents: number
  destinationAccountId: string
  sourceTransactionId: string
  description: string
  metadata: { driver_transfer_id: string; statement_id: string; driver_id: string; merchant_settlement_id: string; debit_attempt_id: string; funding_mode: 'source_transaction' }
}

export interface DriverTransferProvider {
  readonly livemode: boolean
  createTransfer(input: CreateTransferInput): Promise<TransferResult>
  /** Reprise > 24 h : retrouve le Transfer par le `transfer_group` hérité de la charge + `metadata.driver_transfer_id`. */
  findTransfer(input: { transferGroup: string; driverTransferId: string }): Promise<TransferResult | null>
  annotateDestinationPayment(input: { destinationAccountId: string; destinationPaymentId: string; description: string; metadata: Record<string, string> }): Promise<void>
}

/** Lecture Stripe de l'état du compte du livreur juste avant de payer (D-F) : le Transfer exige `stripe_transfers: active`. */
export interface DriverAccountLiveReader {
  isTransferReady(stripeAccountId: string): Promise<boolean>
}

/** Refus DÉFINITIF de Stripe pour ce Transfer (4xx) : jamais une faute du restaurant. `capability` = compte livreur restreint. */
export class TransferRejectedError extends Error {
  public constructor(public readonly code: string, public readonly capability: boolean) { super(`Transfer rejected: ${code}`); this.name = 'TransferRejectedError' }
}
/** Réseau, 5xx, limite, authentification plateforme : résultat INCONNU, la MÊME clé est rejouée. */
export class TransferTransientError extends Error {
  public constructor(public readonly errorClass: string) { super(`Transfer transient failure: ${errorClass}`); this.name = 'TransferTransientError' }
}
