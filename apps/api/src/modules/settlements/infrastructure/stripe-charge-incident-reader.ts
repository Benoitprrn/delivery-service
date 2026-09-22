import Stripe from 'stripe'
import type { ChargeIncidentView } from '../domain/charge-incident.js'
import type { ChargeIncidentReader } from '../ports/settlement-ops.js'

/** Relit la charge SEPA et son litige chez Stripe (jamais depuis le payload du webhook). */
export class StripeChargeIncidentReader implements ChargeIncidentReader {
  public constructor(private readonly stripe: Stripe) {}

  public async read(chargeId: string): Promise<ChargeIncidentView | null> {
    try {
      const charge = await this.stripe.charges.retrieve(chargeId)
      const dispute = charge.disputed ? (await this.stripe.disputes.list({ charge: chargeId, limit: 1 })).data[0] ?? null : null
      return {
        chargeId: charge.id,
        paymentIntentId: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null,
        chargeAmountCents: charge.amount,
        amountRefundedCents: charge.amount_refunded,
        dispute: dispute === null ? null : { id: dispute.id, status: dispute.status, amountCents: dispute.amount, reason: dispute.reason ?? null }
      }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') return null
      throw error
    }
  }
}
