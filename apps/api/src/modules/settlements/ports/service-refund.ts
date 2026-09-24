export type ServiceRefundWork = { id: string; claimToken: string; attemptCount: number; stripeChargeId: string; refundCents: number; idempotencyKey: string; livemode: boolean; reversalId: string; orderId: string }
export type StripeRefundView = { refundId: string; chargeId: string; amountCents: number; status: string }

export interface MerchantServiceRefundProvider {
  readonly livemode: boolean
  createRefund(input: { chargeId: string; amountCents: number; idempotencyKey: string; metadata: Record<string, string> }): Promise<StripeRefundView>
  findRefund(input: { chargeId: string; serviceRefundId: string }): Promise<StripeRefundView | null>
}

export interface ServiceRefundRepository {
  claimDue(input: { now: Date; limit: number; leaseSeconds: number }): Promise<ServiceRefundWork[]>
  complete(input: { serviceRefundId: string; claimToken: string; stripeRefundId: string; now: Date }): Promise<'completed' | 'lost_claim'>
  fail(input: { serviceRefundId: string; claimToken: string; code: string; now: Date }): Promise<void>
  retryLater(input: { serviceRefundId: string; claimToken: string; errorClass: string; retryAfterSeconds: number; now: Date }): Promise<void>
}

export class ServiceRefundRejectedError extends Error { public constructor(public readonly code: string) { super(`Service refund rejected: ${code}`); this.name = 'ServiceRefundRejectedError' } }
export class ServiceRefundTransientError extends Error { public constructor(public readonly errorClass: string) { super(`Service refund transient failure: ${errorClass}`); this.name = 'ServiceRefundTransientError' } }
