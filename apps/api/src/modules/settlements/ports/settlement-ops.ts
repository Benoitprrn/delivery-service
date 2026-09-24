import type { ChargeIncidentAssessment, ChargeIncidentView } from '../domain/charge-incident.js'
import type { DebitAttemptSnapshot, DriverTransferSnapshot, ReconciliationFinding, ServiceRefundSnapshot, StripeDebitSnapshot, StripeRefundSnapshot, StripeTransferSnapshot } from '../domain/reconciliation.js'
import type { RetryAttemptSummary } from '../domain/debit-retry.js'
import type { ReducedSettlementEvent } from '../domain/stripe-event-triage.js'

/* ---------- Relance MANUELLE d'un prélèvement restaurant ---------- */
export interface DebitRetryRepository {
  loadContext(merchantSettlementId: string): Promise<{ amountCents: number; attempts: RetryAttemptSummary[]; hasOpenRetryRequest: boolean } | null>
  /** Pré-notification de la tentative N (jamais de débit sans elle : garde de base). `exists` = déjà demandée (concurrence). */
  createRetryNotification(input: { merchantSettlementId: string; attemptNo: number; amountCents: number; requestedBy: string; reason: string }): Promise<{ outcome: 'created'; preNotificationId: string } | { outcome: 'exists' }>
}

/* ---------- Webhooks plateforme : journal, déclencheurs ---------- */
export type ClaimedSettlementEvent = { event: ReducedSettlementEvent; attemptCount: number; token: string }
export interface SettlementEventRepository {
  /** Journal sans payload ; un doublon (même `event_id`) est ignoré. */
  record(event: ReducedSettlementEvent, now: Date): Promise<'recorded' | 'duplicate'>
  claimNext(input: { now: Date; leaseSeconds: number }): Promise<ClaimedSettlementEvent | null>
  complete(eventId: string, token: string, now: Date): Promise<boolean>
  /** `retryAfterSeconds = null` : `dead_letter` (visible, jamais marqué traité). */
  fail(input: { eventId: string; token: string; errorClass: string; retryAfterSeconds: number | null; now: Date }): Promise<boolean>
}

export type DebitAttemptRef = { id: string; merchantSettlementId: string; status: string }
export interface DebitOpsRepository {
  findAttempt(ids: { paymentIntentId: string | null; chargeId: string | null }): Promise<DebitAttemptRef | null>
  /** Réveille le suivi (R50) d'une tentative `creating`/`processing` : le webhook ne fait que déclencher la relecture Stripe. */
  requestSync(attemptId: string, now: Date): Promise<boolean>
  /** UNE transaction : incidents + créances restaurant + statuts des statements non payés. Jamais de reversal livreur (D-A/D-O). */
  applyIncidents(input: { attemptId: string; chargeId: string; assessment: ChargeIncidentAssessment; now: Date }): Promise<{ applied: boolean; owedCents: number }>
  knownSucceededServiceRefundCents(chargeId: string): Promise<number>
}

export interface ChargeIncidentReader {
  /** Relit la charge (et son litige) chez Stripe ; `null` si elle n'existe pas. */
  read(chargeId: string): Promise<ChargeIncidentView | null>
}

/* ---------- Réconciliation DB ↔ Stripe ---------- */
export type DebitReconciliationItem = { db: DebitAttemptSnapshot; knownServiceRefundCents: number }
export type TransferReconciliationItem = { db: DriverTransferSnapshot; ledgerReversedCents: number }
export type ServiceRefundReconciliationItem = { db: ServiceRefundSnapshot }
export type PayoutObservationInput = { driverId: string; stripeAccountId: string; payoutId: string; amountCents: number; status: string; automatic: boolean; arrivalDate: string | null; livemode: boolean }
export type ExaminedRef = { refType: ReconciliationFinding['refType']; refId: string }

export interface ReconciliationRepository {
  startRun(now: Date): Promise<string>
  finishRun(input: { runId: string; status: 'completed' | 'failed'; checked: number; discrepancies: number; summary: Record<string, number>; now: Date }): Promise<void>
  lastCompletedRunAt(): Promise<Date | null>
  loadDebits(input: { now: Date; sinceDays: number; limit: number }): Promise<DebitReconciliationItem[]>
  loadTransfers(input: { now: Date; sinceDays: number; limit: number }): Promise<TransferReconciliationItem[]>
  loadServiceRefunds(input: { now: Date; sinceDays: number; limit: number }): Promise<ServiceRefundReconciliationItem[]>
  loadTransferByStripeId(stripeTransferId: string, now: Date): Promise<TransferReconciliationItem | null>
  knownDriverTransferIds(ids: string[]): Promise<Set<string>>
  loadDriverAccounts(): Promise<Array<{ driverId: string; stripeAccountId: string; openReceivablesCents: number; livemode: boolean }>>
  /** Upsert des constats ouverts (un seul par kind/objet) ; un constat qui ne se reproduit plus sur un objet EXAMINÉ est résolu. */
  recordFindings(input: { runId: string | null; findings: ReconciliationFinding[]; examined: ExaminedRef[]; now: Date }): Promise<{ opened: number; stillOpen: number; resolved: number }>
  upsertPayouts(observations: PayoutObservationInput[], now: Date): Promise<number>
}

export interface ReconciliationStripeReader {
  readDebit(paymentIntentId: string): Promise<StripeDebitSnapshot | null>
  readTransfer(transferId: string): Promise<StripeTransferSnapshot | null>
  readRefund(refundId: string): Promise<StripeRefundSnapshot | null>
  readTransferOrigin(transferId: string): Promise<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null } | null>
  listRecentTransfers(sinceUnixSeconds: number): Promise<Array<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null }>>
  readDriverBalance(accountId: string): Promise<{ availableCents: number; pendingCents: number } | null>
  listPayouts(accountId: string, sinceUnixSeconds: number): Promise<Array<{ payoutId: string; amountCents: number; status: string; automatic: boolean; arrivalDate: string | null }>>
}
