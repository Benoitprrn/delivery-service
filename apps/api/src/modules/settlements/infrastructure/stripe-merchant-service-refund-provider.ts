import Stripe from 'stripe'
import { ServiceRefundRejectedError, ServiceRefundTransientError, type MerchantServiceRefundProvider, type StripeRefundView } from '../ports/service-refund.js'

export class StripeMerchantServiceRefundProvider implements MerchantServiceRefundProvider {
  public readonly livemode: boolean
  public constructor(private readonly stripe: Stripe, livemode: boolean) { this.livemode = livemode }
  public async createRefund(input: Parameters<MerchantServiceRefundProvider['createRefund']>[0]): Promise<StripeRefundView> {
    try {
      const refund = await this.stripe.refunds.create({ charge: input.chargeId, amount: input.amountCents, metadata: input.metadata }, { idempotencyKey: input.idempotencyKey })
      return { refundId: refund.id, chargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? input.chargeId, amountCents: refund.amount, status: refund.status ?? 'unknown' }
    } catch (error) { throw classifyServiceRefundError(error) }
  }
  public async findRefund(input: { chargeId: string; serviceRefundId: string }): Promise<StripeRefundView | null> {
    try {
      const list = await this.stripe.refunds.list({ charge: input.chargeId, limit: 100 })
      const refund = list.data.find((item) => item.metadata?.driver_reversal_service_refund_id === input.serviceRefundId)
      return refund === undefined ? null : { refundId: refund.id, chargeId: input.chargeId, amountCents: refund.amount, status: refund.status ?? 'unknown' }
    } catch (error) { throw new ServiceRefundTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable') }
  }
}

export function classifyServiceRefundError(error: unknown): Error {
  if (error instanceof Stripe.errors.StripeInvalidRequestError || error instanceof Stripe.errors.StripeIdempotencyError) return new ServiceRefundRejectedError(error instanceof Stripe.errors.StripeError ? error.code ?? 'invalid_request' : 'invalid_request')
  return new ServiceRefundTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable')
}
