import { decideDebitRetry } from '../domain/debit-retry.js'
import { SettlementDomainError } from '../domain/errors.js'
import type { DebitRetryRepository } from '../ports/settlement-ops.js'

export class DebitRetryNotAllowedError extends SettlementDomainError {
  public constructor(public readonly reason: string) { super('DEBIT_RETRY_NOT_ALLOWED', `Debit retry not allowed: ${reason}`) }
}
export class DebitRetrySettlementNotFoundError extends SettlementDomainError {
  public constructor() { super('DEBIT_RETRY_SETTLEMENT_NOT_FOUND', 'Merchant settlement not found') }
}

/**
 * Relance MANUELLE d'un prélèvement restaurant échoué (ou en erreur technique, une fois corrigée). Jamais automatique : un opérateur la
 * demande avec un motif. Elle ne débite RIEN : elle ouvre une nouvelle pré-notification pour la tentative suivante ; le prélèvement ne
 * partira (R50) que lorsque cet e-mail aura été envoyé (≥ 2 jours calendaires avant) et si le mandat actif est celui qu'il cite.
 */
export class RequestDebitRetryUseCase {
  public constructor(private readonly repository: DebitRetryRepository) {}

  public async execute(input: { merchantSettlementId: string; requestedBy: string; reason: string }): Promise<{ attemptNo: number; cause: 'failed_debit' | 'technical_error'; preNotificationId: string }> {
    if (input.reason.trim() === '' || input.requestedBy.trim() === '') throw new DebitRetryNotAllowedError('reason_and_operator_required')
    const context = await this.repository.loadContext(input.merchantSettlementId)
    if (context === null) throw new DebitRetrySettlementNotFoundError()
    const decision = decideDebitRetry({ settlementAmountCents: context.amountCents, attempts: context.attempts, hasOpenRetryRequest: context.hasOpenRetryRequest })
    if (!decision.allowed) throw new DebitRetryNotAllowedError(decision.reason)
    const created = await this.repository.createRetryNotification({ merchantSettlementId: input.merchantSettlementId, attemptNo: decision.nextAttemptNo, amountCents: context.amountCents, requestedBy: input.requestedBy, reason: input.reason.trim() })
    if (created.outcome === 'exists') throw new DebitRetryNotAllowedError('open_retry_request')
    return { attemptNo: decision.nextAttemptNo, cause: decision.cause, preNotificationId: created.preNotificationId }
  }
}
