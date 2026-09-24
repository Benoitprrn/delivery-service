import { ServiceRefundRejectedError, ServiceRefundTransientError, type MerchantServiceRefundProvider, type ServiceRefundRepository, type ServiceRefundWork } from '../ports/service-refund.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

export class RunServiceRefundsUseCase {
  public constructor(private readonly repository: ServiceRefundRepository, private readonly provider: MerchantServiceRefundProvider, private readonly logger: SettlementLogger, private readonly config: { limit?: number; leaseSeconds?: number; retrySeconds?: number } = {}) {}
  public async execute(input: { now: Date }): Promise<{ claimed: number; succeeded: number; failed: number; retryable: number }> {
    const works = await this.repository.claimDue({ now: input.now, limit: this.config.limit ?? 20, leaseSeconds: this.config.leaseSeconds ?? 120 })
    const summary = { claimed: works.length, succeeded: 0, failed: 0, retryable: 0 }
    for (const work of works) { const outcome = await this.process(work, input.now).catch((error) => { this.logger.error({ serviceRefundId: work.id, errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Service refund step failed; it will be resumed'); return 'retryable' as const }); summary[outcome] += 1 }
    return summary
  }
  private async process(work: ServiceRefundWork, now: Date): Promise<'succeeded' | 'failed' | 'retryable'> {
    const retry = async (errorClass: string): Promise<'retryable'> => { await this.repository.retryLater({ serviceRefundId: work.id, claimToken: work.claimToken, errorClass, retryAfterSeconds: this.config.retrySeconds ?? 300, now }); return 'retryable' }
    try {
      const existing = work.attemptCount > 1 ? await this.provider.findRefund({ chargeId: work.stripeChargeId, serviceRefundId: work.id }) : null
      const refund = existing ?? await this.provider.createRefund({ chargeId: work.stripeChargeId, amountCents: work.refundCents, idempotencyKey: work.idempotencyKey, metadata: { driver_reversal_service_refund_id: work.id, driver_transfer_reversal_id: work.reversalId, order_id: work.orderId } })
      if (refund.chargeId !== work.stripeChargeId || refund.amountCents !== work.refundCents || refund.status !== 'succeeded') return retry('refund_not_succeeded')
      return (await this.repository.complete({ serviceRefundId: work.id, claimToken: work.claimToken, stripeRefundId: refund.refundId, now })) === 'completed' ? 'succeeded' : 'retryable'
    } catch (error) {
      if (error instanceof ServiceRefundRejectedError) { await this.repository.fail({ serviceRefundId: work.id, claimToken: work.claimToken, code: `stripe_rejected:${error.code}`, now }); return 'failed' }
      return retry(error instanceof ServiceRefundTransientError ? error.errorClass : 'unavailable')
    }
  }
}
