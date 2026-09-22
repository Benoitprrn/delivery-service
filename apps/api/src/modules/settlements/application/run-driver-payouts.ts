import { randomUUID } from 'node:crypto'
import { addCalendarDays, type LocalDate } from '../domain/local-date.js'
import { parisLocalDate } from '../domain/paris-time.js'
import { buildTransferIdempotencyKey } from '../domain/idempotency.js'
import { buildTransferDescription, MAX_TRANSFER_TRIES, transferRetryDelaySeconds } from '../domain/driver-payout.js'
import { decideStatementPayout, type StatementPayoutDecision } from '../domain/payout-decision.js'
import type { ChargeClassification } from '../domain/charge-classification.js'
import { classifyDebitObservation } from '../domain/sepa-debit.js'
import { deriveStatementStatus } from '../domain/statement-status.js'
import { TransferRejectedError, TransferTransientError } from '../ports/driver-payout.js'
import type { DriverAccountLiveReader, DriverPayoutRepository, DriverTransferProvider, PayoutCandidate, PayRunWork, TransferResult } from '../ports/driver-payout.js'
import type { SepaDebitProvider } from '../ports/sepa-debit.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

export type DriverPayoutRunSummary = { runsCreated: number; runsProcessed: number; statements: number; transferred: number; transferredCents: number; waiting: number; rejected: number; unknown: number; annotated: number; errors: number }
export type RunDriverPayoutsConfig = { batchSize?: number; leaseSeconds?: number; idempotencyWindowMs?: number; recheckDelaySeconds?: number }

type Outcome = { kind: 'transferred'; amountCents: number } | { kind: 'waiting' } | { kind: 'rejected' } | { kind: 'unknown' }
type PendingTransfer = { id: string; idempotencyKey: string; amountCents: number; chargeId: string; debitAttemptId: string; tryNo: number }

const DEFAULTS = { batchSize: 20, leaseSeconds: 300, idempotencyWindowMs: 23 * 3_600_000, recheckDelaySeconds: 600 }

/**
 * Paie les livreurs (D-M / D-N / D-O). À `payrun_at` : pay-run GROUPÉ de tous les statements dont le SEPA restaurant est réellement
 * `succeeded` ; ensuite : pay-runs « drip » pour les statements devenus `succeeded` après. Un Transfer `source_transaction` par statement,
 * après un CONTRÔLE STRIPE de la charge (PI + charge `succeeded`, `paid`, `balance_transaction`) refait juste avant CHAQUE Transfer.
 * Chaque statement est indépendant. Un restaurant impayé ne débloque et ne bloque rien d'autre ; aucune avance, jamais.
 */
export class RunDriverPayoutsUseCase {
  private readonly config: Required<RunDriverPayoutsConfig>
  private readonly workerId = randomUUID()

  public constructor(
    private readonly repository: DriverPayoutRepository,
    private readonly debits: Pick<SepaDebitProvider, 'retrieveDebit' | 'livemode'>,
    private readonly transfers: DriverTransferProvider,
    private readonly accounts: DriverAccountLiveReader,
    private readonly logger: SettlementLogger,
    config: RunDriverPayoutsConfig = {}
  ) {
    this.config = { ...DEFAULTS, ...config }
  }

  public async execute(input: { now: Date }): Promise<DriverPayoutRunSummary> {
    const summary: DriverPayoutRunSummary = { runsCreated: 0, runsProcessed: 0, statements: 0, transferred: 0, transferredCents: 0, waiting: 0, rejected: 0, unknown: 0, annotated: 0, errors: 0 }
    summary.runsCreated = await this.repository.ensureRuns(input.now)
    const runs = await this.repository.claimRuns({ now: input.now, limit: this.config.batchSize, leaseSeconds: this.config.leaseSeconds, workerId: this.workerId })
    for (const run of runs) {
      try {
        await this.processRun(run, input.now, summary)
        summary.runsProcessed += 1
      } catch (error) {
        summary.errors += 1
        this.logger.error({ payRunId: run.id, errorClass: errorClassOf(error) }, 'Driver pay-run failed; it will be resumed when its lease expires')
      }
    }
    await this.annotatePending(summary)
    return summary
  }

  private async processRun(run: PayRunWork, now: Date, summary: DriverPayoutRunSummary): Promise<void> {
    const candidates = await this.repository.listCandidates(run, now)
    const liveReady = new Map<string, boolean | null>()
    let paid = 0
    let amount = 0
    for (const candidate of candidates) {
      summary.statements += 1
      try {
        const outcome = await this.processStatement(candidate, run, now, liveReady)
        if (outcome.kind === 'transferred') { paid += 1; amount += outcome.amountCents; summary.transferred += 1; summary.transferredCents += outcome.amountCents }
        else if (outcome.kind === 'waiting') summary.waiting += 1
        else if (outcome.kind === 'rejected') summary.rejected += 1
        else summary.unknown += 1
      } catch (error) {
        // Un statement en erreur n'arrête jamais les autres.
        summary.errors += 1
        this.logger.error({ statementId: candidate.statementId, errorClass: errorClassOf(error) }, 'Driver payout failed for one statement; the others are unaffected')
      }
    }
    await this.repository.finishRun({ runId: run.id, total: candidates.length, paid, amountCents: amount, now })
  }

  private async processStatement(c: PayoutCandidate, run: PayRunWork, now: Date, liveReady: Map<string, boolean | null>): Promise<Outcome> {
    if (c.openTransfer !== null) return this.resume(c, c.openTransfer, run, now, liveReady)
    const evaluation = await this.evaluate(c, now, liveReady, 0)
    if (evaluation.decision.action === 'wait') {
      await this.hold(c, evaluation.decision, evaluation.holdReason, evaluation.nextAttemptAt)
      return { kind: 'waiting' }
    }
    if (c.failedTries >= MAX_TRANSFER_TRIES) {
      await this.repository.setStatementHold({ statementId: c.statementId, status: 'succeeded_held', holdReason: 'transfer_retries_exhausted', nextAttemptAt: new Date('9999-12-31T00:00:00Z') })
      this.logger.error({ statementId: c.statementId }, 'Driver transfer retries exhausted: intervention required (the amount stays due to the driver)')
      return { kind: 'waiting' }
    }
    const { amountCents, chargeId } = evaluation.decision
    const tryNo = c.lastTryNo + 1
    const begun = await this.repository.beginTransfer({
      statementId: c.statementId, payRunId: run.id, debitAttemptId: c.debit!.id, chargeId, destinationAccountId: c.driverAccount!.stripeAccountId, amountCents, tryNo,
      idempotencyKey: buildTransferIdempotencyKey({ statementId: c.statementId, chargeId, tryNo }), livemode: this.transfers.livemode
    })
    if (begun.outcome === 'refused') {
      await this.repository.setStatementHold({ statementId: c.statementId, status: 'succeeded_held', holdReason: 'transfer_refused_by_guards', nextAttemptAt: new Date(now.getTime() + this.config.recheckDelaySeconds * 1000) })
      this.logger.error({ statementId: c.statementId }, 'Driver transfer refused by the database guards')
      return { kind: 'waiting' }
    }
    return this.submit(c, { id: begun.transferId, idempotencyKey: buildTransferIdempotencyKey({ statementId: c.statementId, chargeId, tryNo }), amountCents, chargeId, debitAttemptId: c.debit!.id, tryNo }, run, now)
  }

  /** Décision de paiement : état du débit en base, puis état du compte livreur, puis CONTRÔLE STRIPE de la charge (jamais un Transfer sans lui). */
  private async evaluate(c: PayoutCandidate, now: Date, liveReady: Map<string, boolean | null>, ownLiveTransferCents: number): Promise<{ decision: StatementPayoutDecision; holdReason: string | null; nextAttemptAt: Date | null }> {
    const later = (seconds: number): Date => new Date(now.getTime() + seconds * 1000)
    const debit = c.debit
    if (debit === null) return { decision: decideStatementPayout({ dueCents: c.dueCents, paidCents: c.paidCents, debit: null, driverAccount: { transfersActive: false }, now, payrunAt: c.payrunAt }), holdReason: null, nextAttemptAt: null }
    let classification: ChargeClassification = debit.status === 'succeeded' ? 'succeeded' : debit.status === 'failed' || debit.status === 'canceled' ? 'failed' : 'processing'
    let holdReason: string | null = debit.status === 'technical_error' ? 'debit_technical_error' : null
    // SEPA réussi PUIS contesté/remboursé : dette du RESTAURANT, aucun Transfer depuis cette charge (D-A/D-O) ; les statements déjà payés ne sont jamais repris.
    if (debit.status === 'succeeded' && debit.incidentOpen) { classification = 'failed'; holdReason = 'debit_incident' }
    let nextAttemptAt: Date | null = null
    let transfersActive = false
    if (classification === 'succeeded') {
      // Compte livreur : état local ET relecture Stripe (D-F) ; le pay-run ne paie jamais un compte restreint.
      const account = c.driverAccount
      transfersActive = account !== null && account.transfersReadyLocally && account.livemode === debit.livemode && await this.isLiveReady(account.stripeAccountId, liveReady)
      if (!transfersActive) {
        holdReason = 'blocked_driver_account'
        nextAttemptAt = later(this.config.recheckDelaySeconds)
      } else if (now.getTime() >= c.payrunAt.getTime()) {
        // CONTRÔLE STRIPE de la charge, refait avant CHAQUE Transfer : le débit « succeeded » local n'autorise rien à lui seul.
        const check = await this.recheckCharge(c)
        classification = check.classification
        if (check.holdReason !== null) { holdReason = check.holdReason; nextAttemptAt = later(this.config.recheckDelaySeconds) }
      }
    }
    const decision = decideStatementPayout({
      dueCents: c.dueCents, paidCents: c.paidCents,
      debit: { classification, chargeId: debit.chargeId ?? '', chargeAmountCents: debit.amountCents, alreadyTransferredFromChargeCents: Math.max(0, c.alreadyTransferredFromDebitCents - ownLiveTransferCents) },
      driverAccount: { transfersActive }, now, payrunAt: c.payrunAt
    })
    return { decision, holdReason, nextAttemptAt }
  }

  private async recheckCharge(c: PayoutCandidate): Promise<{ classification: ChargeClassification; holdReason: string | null }> {
    const debit = c.debit!
    if (debit.paymentIntentId === null || debit.chargeId === null) return { classification: 'processing', holdReason: 'debit_recheck_missing_ids' }
    const observation = await this.debits.retrieveDebit(debit.paymentIntentId)
    if (observation.chargeId !== debit.chargeId || observation.amountCents !== debit.amountCents || observation.currency !== 'eur' || observation.livemode !== debit.livemode) {
      this.logger.error({ statementId: c.statementId, debitAttemptId: debit.id }, 'Stripe charge does not match the recorded debit: no transfer')
      return { classification: 'processing', holdReason: 'debit_recheck_mismatch' }
    }
    if (observation.disputed === true || (observation.amountRefundedCents ?? 0) > 0) {
      this.logger.error({ statementId: c.statementId, debitAttemptId: debit.id }, 'Debit charge is disputed or refunded at Stripe: no transfer (restaurant incident, reconciliation records it)')
      return { classification: 'failed', holdReason: 'debit_incident' }
    }
    const classified = classifyDebitObservation(observation)
    if (classified.state === 'succeeded') return { classification: 'succeeded', holdReason: null }
    if (classified.state === 'failed') {
      this.logger.error({ statementId: c.statementId, debitAttemptId: debit.id, failureCode: classified.failureCode }, 'Recorded succeeded debit is no longer succeeded at Stripe: no transfer (reconciliation required)')
      return { classification: 'failed', holdReason: 'debit_recheck_failed' }
    }
    return { classification: 'processing', holdReason: classified.state === 'technical' ? 'debit_recheck_technical' : 'debit_recheck_processing' }
  }

  private async isLiveReady(stripeAccountId: string, cache: Map<string, boolean | null>): Promise<boolean> {
    if (!cache.has(stripeAccountId)) {
      try { cache.set(stripeAccountId, await this.accounts.isTransferReady(stripeAccountId)) } catch { cache.set(stripeAccountId, null) }
    }
    const ready = cache.get(stripeAccountId)
    if (ready === null) throw new TransferTransientError('driver_account_read_failed')
    return ready === true
  }

  private async hold(c: PayoutCandidate, decision: Extract<StatementPayoutDecision, { action: 'wait' }>, holdReason: string | null, nextAttemptAt: Date | null): Promise<void> {
    const status = deriveStatementStatus({ dueCents: c.dueCents, paidCents: c.paidCents, decision })
    await this.repository.setStatementHold({ statementId: c.statementId, status, holdReason: holdReason ?? decision.reason, nextAttemptAt })
  }

  /** Reprise d'un Transfer au résultat inconnu : on cherche d'abord s'il existe déjà chez Stripe ; sinon même contrôle qu'un Transfer neuf, puis MÊME clé. */
  private async resume(c: PayoutCandidate, open: NonNullable<PayoutCandidate['openTransfer']>, run: PayRunWork, now: Date, liveReady: Map<string, boolean | null>): Promise<Outcome> {
    const pending: PendingTransfer = { id: open.id, idempotencyKey: open.idempotencyKey, amountCents: open.amountCents, chargeId: open.chargeId, debitAttemptId: open.debitAttemptId, tryNo: open.tryNo }
    let existing: TransferResult | null
    try {
      existing = await this.transfers.findTransfer({ transferGroup: `settlement:${c.merchantSettlementId}`, driverTransferId: open.id })
    } catch {
      return { kind: 'unknown' }
    }
    if (existing !== null) return this.adopt(c, pending, existing, now)
    const evaluation = await this.evaluate(c, now, liveReady, open.amountCents)
    if (evaluation.decision.action !== 'transfer' || evaluation.decision.amountCents !== open.amountCents || evaluation.decision.chargeId !== open.chargeId) {
      // Le Transfer n'existe pas chez Stripe et n'est plus autorisé : on le ferme (jamais créé) ; un essai n+1 viendra quand tout sera de nouveau valide.
      await this.repository.failTransfer({ transferId: open.id, code: 'not_eligible_on_resume', now, retryAfterSeconds: this.config.recheckDelaySeconds, statementStatus: null, holdReason: evaluation.holdReason ?? 'not_eligible_on_resume' })
      return { kind: 'waiting' }
    }
    if (now.getTime() - open.createdAt.getTime() > this.config.idempotencyWindowMs) {
      // Introuvable après la fenêtre d'idempotence : la clé ne protège plus, mais la recherche par groupe est cohérente => essai n+1 sans risque de doublon.
      await this.repository.failTransfer({ transferId: open.id, code: 'creation_not_confirmed', now, retryAfterSeconds: 0, statementStatus: null, holdReason: 'creation_not_confirmed' })
      return { kind: 'waiting' }
    }
    return this.submit(c, pending, run, now)
  }

  private async submit(c: PayoutCandidate, transfer: PendingTransfer, run: PayRunWork, now: Date): Promise<Outcome> {
    const account = c.driverAccount!
    const periodFirstDay: LocalDate = parisLocalDate(run.periodStart)
    const periodLastDay: LocalDate = addCalendarDays(parisLocalDate(run.periodEnd), -1)
    try {
      const result = await this.transfers.createTransfer({
        idempotencyKey: transfer.idempotencyKey,
        amountCents: transfer.amountCents,
        destinationAccountId: account.stripeAccountId,
        sourceTransactionId: transfer.chargeId,
        description: buildTransferDescription({ periodFirstDay, periodLastDay, statementId: c.statementId }),
        metadata: { driver_transfer_id: transfer.id, statement_id: c.statementId, driver_id: c.driverId, merchant_settlement_id: c.merchantSettlementId, debit_attempt_id: transfer.debitAttemptId, funding_mode: 'source_transaction' }
      })
      return await this.adopt(c, transfer, result, now)
    } catch (error) {
      if (error instanceof TransferRejectedError) {
        const failedTries = c.failedTries + 1
        await this.repository.failTransfer({
          transferId: transfer.id, code: error.code, now,
          retryAfterSeconds: failedTries >= MAX_TRANSFER_TRIES ? null : transferRetryDelaySeconds(failedTries),
          statementStatus: error.capability ? 'blocked_driver_account' : null,
          holdReason: error.capability ? 'blocked_driver_account' : `transfer_rejected:${error.code}`
        })
        this.logger.error({ statementId: c.statementId, code: error.code }, 'Driver transfer rejected by Stripe; the restaurant is not concerned and the amount stays due to the driver')
        return { kind: 'rejected' }
      }
      if (error instanceof TransferTransientError) {
        await this.repository.markTransferUnknown(transfer.id, now)
        this.logger.warn({ statementId: c.statementId, errorClass: error.errorClass }, 'Driver transfer result unknown; the same idempotency key will be replayed')
        return { kind: 'unknown' }
      }
      throw error
    }
  }

  /** Vérifie que le Transfer Stripe est bien celui décidé, puis l'enregistre (Transfer + paid_cents + statut, une transaction). */
  private async adopt(c: PayoutCandidate, transfer: PendingTransfer, result: TransferResult, now: Date): Promise<Outcome> {
    const account = c.driverAccount!
    const matches = result.amountCents === transfer.amountCents && result.currency === 'eur' && result.destinationAccountId === account.stripeAccountId
      && (result.sourceTransactionId === null || result.sourceTransactionId === transfer.chargeId) && result.livemode === this.transfers.livemode
    if (!matches) {
      await this.repository.markTransferUnknown(transfer.id, now)
      await this.repository.setStatementHold({ statementId: c.statementId, status: 'succeeded_held', holdReason: 'transfer_mismatch', nextAttemptAt: new Date(now.getTime() + 3_600_000) })
      this.logger.error({ statementId: c.statementId, driverTransferId: transfer.id }, 'Stripe transfer does not match the decided transfer: intervention required')
      return { kind: 'unknown' }
    }
    const completed = await this.repository.completeTransfer({ transferId: transfer.id, stripeTransferId: result.transferId, destinationPaymentId: result.destinationPaymentId, now })
    if (completed === 'already_final') return { kind: 'waiting' }
    this.logger.info({ statementId: c.statementId, driverTransferId: transfer.id, amountCents: transfer.amountCents }, 'Driver transfer sent')
    return { kind: 'transferred', amountCents: transfer.amountCents }
  }

  /** Non bloquant : `description`/métadonnées du paiement de destination pour le Dashboard Express du livreur ; rejoué aux cycles suivants. */
  private async annotatePending(summary: DriverPayoutRunSummary): Promise<void> {
    for (const item of await this.repository.listUnannotated(20)) {
      try {
        await this.transfers.annotateDestinationPayment({
          destinationAccountId: item.destinationAccountId, destinationPaymentId: item.destinationPaymentId,
          description: buildTransferDescription({ periodFirstDay: parisLocalDate(item.periodStart), periodLastDay: addCalendarDays(parisLocalDate(item.periodEnd), -1), statementId: item.statementId }),
          metadata: { statement_id: item.statementId }
        })
        await this.repository.markAnnotated(item.transferId, new Date())
        summary.annotated += 1
      } catch {
        this.logger.warn({ driverTransferId: item.transferId }, 'Destination payment annotation failed; it will be retried')
      }
    }
  }
}

const errorClassOf = (error: unknown): string => error instanceof Error ? error.constructor.name : 'UnknownError'
