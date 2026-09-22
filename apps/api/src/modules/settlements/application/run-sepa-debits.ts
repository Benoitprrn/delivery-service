import { classifyDebitObservation, checkNotifiedMandate, DEBIT_START_LOCAL_HOUR, type DebitObservation } from '../domain/sepa-debit.js'
import { SepaDebitRejectedError, SepaDebitTechnicalError, SepaDebitTransientError } from '../ports/sepa-debit.js'
import type { DebitAttemptWork, DebitSourceReader, SepaDebitProvider, SepaDebitRepository } from '../ports/sepa-debit.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

export type SepaDebitRunSummary = { due: number; created: number; blocked: number; synced: number; succeeded: number; failed: number; technical: number; retryable: number; errors: number }

export type RunSepaDebitsConfig = { startHour?: number; batchSize?: number; leaseSeconds?: number; syncIntervalSeconds?: number; retryDelaySeconds?: number; idempotencyWindowMs?: number }

const DEFAULTS = { batchSize: 50, leaseSeconds: 120, syncIntervalSeconds: 900, retryDelaySeconds: 120, idempotencyWindowMs: 23 * 3_600_000 }

/**
 * Exécute les prélèvements SEPA de la semaine (R50) : à la `debit_date` annoncée par la pré-notification (R41), un PaymentIntent par
 * restaurant sur la plateforme, puis suit `processing → succeeded | failed`. Chaque restaurant est traité isolément (une erreur ne
 * touche jamais un autre). Aucun Transfer livreur n'est créé ici : R60 ne lit que les tentatives `succeeded`.
 */
export class RunSepaDebitsUseCase {
  private readonly config: Required<RunSepaDebitsConfig>

  public constructor(
    private readonly repository: SepaDebitRepository,
    private readonly sources: DebitSourceReader,
    private readonly provider: SepaDebitProvider,
    private readonly logger: SettlementLogger,
    config: RunSepaDebitsConfig = {}
  ) {
    this.config = { startHour: DEBIT_START_LOCAL_HOUR, ...DEFAULTS, ...config }
  }

  public async execute(input: { now: Date }): Promise<SepaDebitRunSummary> {
    const summary: SepaDebitRunSummary = { due: 0, created: 0, blocked: 0, synced: 0, succeeded: 0, failed: 0, technical: 0, retryable: 0, errors: 0 }
    const now = input.now

    const due = await this.repository.listDueSettlements({ now, startHour: this.config.startHour, limit: this.config.batchSize })
    summary.due = due.length
    for (const settlement of due) {
      try {
        const source = await this.sources.findActive(settlement.merchantId)
        const check = checkNotifiedMandate({ notifiedMandateReference: settlement.notifiedMandateReference, activeMandateReference: source?.mandateReference })
        if (!check.ok || source === null) {
          await this.repository.setBlocked(settlement.merchantSettlementId, check.ok ? 'no_active_sepa_method' : check.reason, now)
          this.logger.warn({ merchantSettlementId: settlement.merchantSettlementId, reason: check.ok ? 'no_active_sepa_method' : check.reason }, 'SEPA debit blocked: the active mandate is not the notified one')
          summary.blocked += 1
          continue
        }
        const created = await this.repository.createAttempt({ merchantSettlementId: settlement.merchantSettlementId, attemptNo: settlement.attemptNo, source, livemode: this.provider.livemode, leaseSeconds: this.config.leaseSeconds })
        if (created.outcome === 'refused') {
          await this.repository.setBlocked(settlement.merchantSettlementId, created.reason, now)
          this.logger.error({ merchantSettlementId: settlement.merchantSettlementId, reason: created.reason }, 'SEPA debit refused by the database guards')
          summary.blocked += 1
        } else if (created.outcome === 'created') {
          summary.created += 1
          await this.process(created.work, now, summary)
        }
      } catch (error) {
        summary.errors += 1
        this.logger.error({ merchantSettlementId: settlement.merchantSettlementId, errorClass: errorClassOf(error) }, 'SEPA debit preparation failed; other restaurants are unaffected')
      }
    }

    const work = await this.repository.claimWork({ now, limit: this.config.batchSize, leaseSeconds: this.config.leaseSeconds })
    for (const attempt of work) {
      try {
        await this.process(attempt, now, summary)
      } catch (error) {
        summary.errors += 1
        this.logger.error({ debitAttemptId: attempt.id, errorClass: errorClassOf(error) }, 'SEPA debit step failed; it will be retried')
      }
    }
    return summary
  }

  /** Une tentative : création Stripe (clé d'idempotence rejouée si `creating`) ou relecture (si `processing`). */
  private async process(work: DebitAttemptWork, now: Date, summary: SepaDebitRunSummary): Promise<void> {
    try {
      const observation = await this.observe(work, now)
      if (observation === null) return await this.technical(work, 'technical:creation_not_confirmed', null, now, summary)
      const mismatch = findMismatch(work, observation, this.provider.livemode)
      if (mismatch !== null) return await this.technical(work, `technical:observation_mismatch_${mismatch}`, observation, now, summary)
      const classification = classifyDebitObservation(observation)
      if (classification.state === 'technical') return await this.technical(work, classification.failureCode, observation, now, summary)
      const applied = await this.repository.applyObservation({ attemptId: work.id, claimToken: work.claimToken, observation, classification, now, syncDelaySeconds: this.config.syncIntervalSeconds })
      if (applied === 'lost_claim') return
      summary.synced += 1
      if (classification.state === 'succeeded') summary.succeeded += 1
      if (classification.state === 'failed') {
        summary.failed += 1
        this.logger.warn({ debitAttemptId: work.id, merchantSettlementId: work.merchantSettlementId, failureCode: classification.failureCode }, 'SEPA debit failed; the restaurant stays owing the amount and no driver is paid from it')
      }
    } catch (error) {
      if (error instanceof SepaDebitRejectedError) {
        await this.repository.markRejected({ attemptId: work.id, claimToken: work.claimToken, code: `debit_declined:${error.code}`, now })
        summary.failed += 1
        this.logger.warn({ debitAttemptId: work.id, code: error.code }, 'SEPA debit declined at creation; the restaurant stays owing the amount')
        return
      }
      if (error instanceof SepaDebitTechnicalError) return this.technical(work, `technical:${error.code}`, null, now, summary)
      const errorClass = error instanceof SepaDebitTransientError ? error.errorClass : errorClassOf(error)
      await this.repository.markRetryable({ attemptId: work.id, claimToken: work.claimToken, errorClass, retryAfterSeconds: this.config.retryDelaySeconds, now })
      summary.retryable += 1
      this.logger.warn({ debitAttemptId: work.id, errorClass }, 'SEPA debit step will be retried with the same idempotency key')
    }
  }

  /** Erreur technique : état distinct, intervention requise ; le restaurant n'est PAS qualifié d'impayé et aucun paiement livreur n'est ouvert. */
  private async technical(work: DebitAttemptWork, code: string, observation: DebitObservation | null, now: Date, summary: SepaDebitRunSummary): Promise<void> {
    const applied = await this.repository.markTechnical({ attemptId: work.id, claimToken: work.claimToken, code, paymentIntentId: observation?.paymentIntentId ?? work.paymentIntentId, chargeId: observation?.chargeId ?? null, now })
    if (applied === 'lost_claim') return
    summary.technical += 1
    this.logger.error({ debitAttemptId: work.id, merchantSettlementId: work.merchantSettlementId, code }, 'SEPA debit technical error: intervention required; the restaurant is NOT marked unpaid')
  }

  private async observe(work: DebitAttemptWork, now: Date): Promise<DebitObservation | null> {
    if (work.status === 'processing' && work.paymentIntentId !== null) return this.provider.retrieveDebit(work.paymentIntentId)
    // Au-delà de la fenêtre d'idempotence Stripe (24 h), on ne rejoue plus la clé : on cherche le PaymentIntent par métadonnée.
    if (now.getTime() - work.createdAt.getTime() > this.config.idempotencyWindowMs) return this.provider.findDebitByAttemptId(work.id)
    return this.provider.createDebit({
      idempotencyKey: work.idempotencyKey,
      amountCents: work.amountCents,
      restaurantAccountId: work.stripeAccountId,
      paymentMethodId: work.paymentMethodId,
      mandateId: work.mandateId,
      transferGroup: `settlement:${work.merchantSettlementId}`,
      description: 'Locadely — règlement hebdomadaire des livraisons',
      metadata: { merchant_settlement_id: work.merchantSettlementId, debit_attempt_id: work.id, merchant_id: work.merchantId }
    })
  }
}

function findMismatch(work: DebitAttemptWork, observation: DebitObservation, livemode: boolean): 'amount' | 'currency' | 'attempt_id' | 'livemode' | null {
  if (observation.amountCents !== work.amountCents) return 'amount'
  if (observation.currency !== 'eur') return 'currency'
  if (observation.attemptIdMetadata !== null && observation.attemptIdMetadata !== work.id) return 'attempt_id'
  if (observation.livemode !== livemode) return 'livemode'
  return null
}

const errorClassOf = (error: unknown): string => error instanceof Error ? error.constructor.name : 'UnknownError'
