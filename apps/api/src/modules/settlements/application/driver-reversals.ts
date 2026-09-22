import { assertDistinctApprover, decideReversalExecution, validateReversalRequest, type ReversalPlan } from '../domain/reversal-decision.js'
import { InvalidAmountError, ReversalAmountExceededError, ReversalDecisionIncompleteError, ReversalLedgerMismatchError, SettlementDomainError } from '../domain/errors.js'
import { ReversalRejectedError, ReversalTransientError } from '../ports/driver-reversal.js'
import type { DriverReversalProvider, DriverReversalRepository, ReversalRecord, ReversalWork, RequestReversalResult } from '../ports/driver-reversal.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

export class ReversalRefusedError extends SettlementDomainError {
  public constructor(public readonly reason: string) { super('REVERSAL_REFUSED', `Reversal request refused: ${reason}`) }
}
export class ReversalNotFoundError extends SettlementDomainError {
  public constructor() { super('REVERSAL_NOT_FOUND', 'Reversal not found') }
}
export class ReversalNotPendingError extends SettlementDomainError {
  public constructor() { super('REVERSAL_NOT_PENDING', 'Only a pending reversal can be approved or rejected') }
}

/** Demande de reversal (catégories B/C, motif énuméré, décision référencée) : idempotente par (Transfer, référence de décision). */
export class RequestDriverReversalUseCase {
  public constructor(private readonly repository: DriverReversalRepository) {}

  public async execute(input: { driverTransferId: string; category: string; reasonCode: string; reason: string; decisionReference: string; amountCents: number; orderId?: string | null; requestedBy: string }): Promise<Extract<RequestReversalResult, { reversal: ReversalRecord }>> {
    const request = validateReversalRequest(input)
    if (input.requestedBy.trim() === '') throw new ReversalDecisionIncompleteError()
    const result = await this.repository.createRequest({ ...request, driverTransferId: input.driverTransferId, requestedBy: input.requestedBy })
    if (result.outcome === 'conflict') throw new ReversalRefusedError('decision_reference_already_used_with_other_terms')
    if (result.outcome === 'refused') throw new ReversalRefusedError(result.reason)
    return result
  }
}

/** Approbation / rejet par une AUTRE personne que le demandeur. Aucun appel Stripe ici. */
export class DecideDriverReversalUseCase {
  public constructor(private readonly repository: DriverReversalRepository) {}

  public async approve(input: { reversalId: string; approvedBy: string; now: Date }): Promise<void> {
    const record = await this.repository.findById(input.reversalId)
    if (record === null) throw new ReversalNotFoundError()
    assertDistinctApprover(record.requestedBy, input.approvedBy)
    const outcome = await this.repository.approve(input)
    if (outcome === 'not_found') throw new ReversalNotFoundError()
    if (outcome === 'not_pending') throw new ReversalNotPendingError()
  }

  public async reject(input: { reversalId: string; rejectedBy: string; reason: string; now: Date }): Promise<void> {
    if (input.reason.trim() === '') throw new ReversalDecisionIncompleteError()
    const outcome = await this.repository.reject(input)
    if (outcome === 'not_found') throw new ReversalNotFoundError()
    if (outcome === 'not_pending') throw new ReversalNotPendingError()
  }
}

export type ReversalRunSummary = { claimed: number; succeeded: number; failed: number; retryable: number; receivablesCents: number; reversedCents: number }
const DEFAULT_RETRY_SECONDS = 300

/**
 * Exécute les reversals APPROUVÉES. Ordre imposé : (1) relire le Transfer et le solde du livreur chez Stripe ; (2) le DOMAINE décide
 * (montant reversé + reliquat en créance) et la décision est PERSISTÉE ; (3) seulement alors, un appel Stripe avec le montant décidé et une
 * clé stable ; (4) résultat + créance dans une transaction. Une reprise réutilise le plan figé et retrouve d'abord la reversal chez Stripe.
 */
export class ExecuteDriverReversalsUseCase {
  public constructor(private readonly repository: DriverReversalRepository, private readonly provider: DriverReversalProvider, private readonly logger: SettlementLogger, private readonly config: { batchSize?: number; leaseSeconds?: number; retrySeconds?: number } = {}) {}

  public async execute(input: { now: Date }): Promise<ReversalRunSummary> {
    const summary: ReversalRunSummary = { claimed: 0, succeeded: 0, failed: 0, retryable: 0, receivablesCents: 0, reversedCents: 0 }
    const works = await this.repository.claimDue({ now: input.now, limit: this.config.batchSize ?? 10, leaseSeconds: this.config.leaseSeconds ?? 300 })
    summary.claimed = works.length
    for (const work of works) {
      try {
        const outcome = await this.process(work, input.now)
        if (outcome.kind === 'succeeded') { summary.succeeded += 1; summary.reversedCents += outcome.reversedCents; summary.receivablesCents += outcome.receivableCents }
        else if (outcome.kind === 'failed') summary.failed += 1
        else summary.retryable += 1
      } catch (error) {
        // Une reversal en erreur n'arrête jamais les autres ; le bail expirera et elle sera reprise avec son plan figé.
        this.logger.error({ reversalId: work.id, errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Driver reversal step failed; it will be resumed')
        summary.retryable += 1
      }
    }
    return summary
  }

  private async process(work: ReversalWork, now: Date): Promise<{ kind: 'succeeded'; reversedCents: number; receivableCents: number } | { kind: 'failed' } | { kind: 'retryable' }> {
    const fail = async (code: string): Promise<{ kind: 'failed' }> => {
      await this.repository.fail({ reversalId: work.id, claimToken: work.claimToken, code, now })
      this.logger.error({ reversalId: work.id, code }, 'Driver reversal failed without any Stripe change; intervention required')
      return { kind: 'failed' }
    }
    const retry = async (errorClass: string): Promise<{ kind: 'retryable' }> => {
      await this.repository.retryLater({ reversalId: work.id, claimToken: work.claimToken, errorClass, retryAfterSeconds: this.config.retrySeconds ?? DEFAULT_RETRY_SECONDS, now })
      return { kind: 'retryable' }
    }

    let transferView
    try {
      transferView = await this.provider.retrieveTransfer(work.stripeTransferId)
    } catch (error) {
      return retry(error instanceof ReversalTransientError ? error.errorClass : 'unavailable')
    }
    if (transferView.amountCents !== work.transferAmountCents || transferView.destinationAccountId !== work.destinationAccountId || (transferView.sourceTransactionId !== null && transferView.sourceTransactionId !== work.sourceChargeId) || transferView.livemode !== work.livemode) {
      return fail('technical:transfer_mismatch')
    }

    let plan: ReversalPlan
    if (work.plan !== null) {
      plan = work.plan // reprise : le plan décidé est figé, jamais recalculé (la clé Stripe et le montant restent identiques)
    } else {
      let balance
      try {
        balance = await this.provider.retrieveDriverBalance(work.destinationAccountId)
      } catch (error) {
        return retry(error instanceof ReversalTransientError ? error.errorClass : 'unavailable')
      }
      try {
        plan = decideReversalExecution({
          requestedCents: work.amountCents,
          transfer: { amountCents: work.transferAmountCents, ledgerReversedCents: work.ledgerReversedCents, stripeAmountReversedCents: transferView.amountReversedCents, chargeAvailableOn: work.chargeAvailableOn },
          driverBalance: balance, now // allowNegativeBalance JAMAIS activé ici (compensation Stripe sur gains futurs : validation juridique requise)
        })
      } catch (error) {
        if (error instanceof ReversalLedgerMismatchError) return fail('technical:ledger_mismatch')
        if (error instanceof ReversalAmountExceededError) return fail('amount_exceeds_remaining')
        if (error instanceof InvalidAmountError) return fail('technical:invalid_amount')
        throw error
      }
      const persisted = await this.repository.persistPlan({ reversalId: work.id, claimToken: work.claimToken, plan, balance, stripeAmountReversedBeforeCents: transferView.amountReversedCents, now })
      if (!persisted) return { kind: 'retryable' } // bail perdu : un autre worker a la main
    }

    let stripeReversalId: string | null = null
    if (plan.reverseNowCents > 0) {
      try {
        const alreadyDone = work.plan !== null || work.attemptCount > 1 ? await this.provider.findReversal({ transferId: work.stripeTransferId, reversalId: work.id }) : null
        if (alreadyDone !== null) {
          if (alreadyDone.amountCents !== plan.reverseNowCents) return fail('technical:reversal_amount_mismatch')
          stripeReversalId = alreadyDone.reversalId
        } else {
          const created = await this.provider.createReversal({
            idempotencyKey: work.idempotencyKey, transferId: work.stripeTransferId, amountCents: plan.reverseNowCents,
            description: `Locadely — reversal (${work.category}, décision ${work.decisionReference})`,
            metadata: { driver_transfer_reversal_id: work.id, driver_transfer_id: work.driverTransferId, category: work.category, reason_code: work.reasonCode, decision_reference: work.decisionReference }
          })
          if (created.amountCents !== plan.reverseNowCents) return fail('technical:reversal_amount_mismatch')
          stripeReversalId = created.reversalId
        }
      } catch (error) {
        if (error instanceof ReversalRejectedError) return fail(`stripe_rejected:${error.code}`)
        return retry(error instanceof ReversalTransientError ? error.errorClass : 'unavailable')
      }
    }

    const balanceAfter = await this.provider.retrieveDriverBalance(work.destinationAccountId).catch(() => null)
    const completed = await this.repository.complete({ reversalId: work.id, claimToken: work.claimToken, reversedCents: plan.reverseNowCents, stripeReversalId, balanceAfter, now })
    if (completed === 'lost_claim') return { kind: 'retryable' }
    if (balanceAfter !== null && balanceAfter.availableCents < 0) {
      this.logger.error({ reversalId: work.id, driverId: work.driverId }, 'Driver Stripe balance is negative after a reversal: reconciliation required (Stripe recovers it from future transfers)')
    }
    this.logger.info({ reversalId: work.id, reversedCents: plan.reverseNowCents, receivableCents: plan.receivableCents, category: work.category }, 'Driver reversal executed')
    return { kind: 'succeeded', reversedCents: plan.reverseNowCents, receivableCents: plan.receivableCents }
  }
}
