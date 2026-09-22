import type { LocalDate } from '../domain/local-date.js'
import type { DebitClassification, DebitObservation } from '../domain/sepa-debit.js'

export type DueSettlement = {
  merchantSettlementId: string
  /** Tentative à créer : 1 = prélèvement initial ; ≥ 2 = relance MANUELLE (nouvelle pré-notification envoyée pour cette tentative). */
  attemptNo: number
  merchantId: string
  amountCents: number
  debitDate: LocalDate
  preNotificationId: string
  notifiedMandateReference: string
}

export type DebitSource = { stripeAccountId: string; paymentMethodId: string; mandateId: string | null; mandateReference: string }

/** Moyen SEPA ACTIF du restaurant (module payments, injecté par `app.ts`) : lu au moment du prélèvement. */
export interface DebitSourceReader {
  findActive(merchantId: string): Promise<DebitSource | null>
}

export type DebitAttemptWork = {
  id: string
  merchantSettlementId: string
  merchantId: string
  attemptNo: number
  status: 'creating' | 'processing'
  amountCents: number
  idempotencyKey: string
  stripeAccountId: string
  paymentMethodId: string
  mandateId: string | null
  paymentIntentId: string | null
  claimToken: string
  createdAt: Date
}

export type CreateAttemptResult = { outcome: 'created'; work: DebitAttemptWork } | { outcome: 'skipped' } | { outcome: 'refused'; reason: 'debit_guard_refused' }

export interface SepaDebitRepository {
  /** Règlements notifiés, > 0 €, sans aucune tentative, dont la date annoncée est atteinte (08:00 Paris). */
  listDueSettlements(input: { now: Date; startHour: number; limit: number }): Promise<DueSettlement[]>
  /** UNE transaction : verrou du règlement, ligne `debit_attempts` (montant lu du règlement figé, jamais recalculé), statuts. Aucun appel réseau. */
  createAttempt(input: { merchantSettlementId: string; attemptNo: number; source: DebitSource; livemode: boolean; leaseSeconds: number }): Promise<CreateAttemptResult>
  setBlocked(merchantSettlementId: string, reason: string | null, now: Date): Promise<void>
  /** Tentatives `creating` (reprise après crash/timeout) et `processing` (suivi) dues, réservées par bail. */
  claimWork(input: { now: Date; limit: number; leaseSeconds: number }): Promise<DebitAttemptWork[]>
  applyObservation(input: { attemptId: string; claimToken: string; observation: DebitObservation; classification: DebitClassification; now: Date; syncDelaySeconds: number }): Promise<'applied' | 'lost_claim'>
  /** Rejet RÉEL (refus de la banque/du débiteur) : `failed`, le restaurant reste débiteur. */
  markRejected(input: { attemptId: string; claimToken: string; code: string; now: Date }): Promise<'applied' | 'lost_claim'>
  /** Erreur technique/config/incohérence Locadely : `technical_error` + règlement `technical_hold`, intervention requise, jamais « impayé restaurant ». */
  markTechnical(input: { attemptId: string; claimToken: string; code: string; paymentIntentId: string | null; chargeId: string | null; now: Date }): Promise<'applied' | 'lost_claim'>
  markRetryable(input: { attemptId: string; claimToken: string; errorClass: string; retryAfterSeconds: number; now: Date }): Promise<void>
}

export type CreateDebitInput = {
  idempotencyKey: string
  amountCents: number
  restaurantAccountId: string
  paymentMethodId: string
  mandateId: string | null
  transferGroup: string
  description: string
  metadata: { merchant_settlement_id: string; debit_attempt_id: string; merchant_id: string }
}

export interface SepaDebitProvider {
  readonly livemode: boolean
  createDebit(input: CreateDebitInput): Promise<DebitObservation>
  retrieveDebit(paymentIntentId: string): Promise<DebitObservation>
  /** Reprise > 24 h (l'idempotence Stripe expire) : retrouve le PaymentIntent par sa métadonnée `debit_attempt_id`. */
  findDebitByAttemptId(attemptId: string): Promise<DebitObservation | null>
}

/** Refus DÉFINITIF du débiteur (erreur carte/banque renvoyée par Stripe à la création) : la tentative est `failed`, rattachée au restaurant. */
export class SepaDebitRejectedError extends Error {
  public constructor(public readonly code: string) { super(`SEPA debit rejected: ${code}`); this.name = 'SepaDebitRejectedError' }
}
/** Mauvaise requête, mauvaise configuration ou incohérence (paramètre invalide, clé d'idempotence détournée…) : provient de NOTRE côté, jamais du restaurant. */
export class SepaDebitTechnicalError extends Error {
  public constructor(public readonly code: string) { super(`SEPA debit technical error: ${code}`); this.name = 'SepaDebitTechnicalError' }
}
/** Réseau, 5xx, limite de débit, authentification plateforme, idempotence en cours : rien n'est décidé, la MÊME clé sera rejouée. */
export class SepaDebitTransientError extends Error {
  public constructor(public readonly errorClass: string) { super(`SEPA debit transient failure: ${errorClass}`); this.name = 'SepaDebitTransientError' }
}
export class SepaDebitUnavailableError extends SepaDebitTransientError {
  public constructor() { super('stripe_unavailable'); this.name = 'SepaDebitUnavailableError' }
}
/** Stripe décrit un objet qui ne correspond pas à la tentative (montant, devise, métadonnée) : anomalie, aucun état modifié. */
export class DebitObservationMismatchError extends Error {
  public constructor(public readonly field: 'amount' | 'currency' | 'attempt_id' | 'livemode') { super(`Stripe debit observation mismatch: ${field}`); this.name = 'DebitObservationMismatchError' }
}
