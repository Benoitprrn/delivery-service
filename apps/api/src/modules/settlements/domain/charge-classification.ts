import { InvalidAmountError } from './errors.js'

export type ChargeClassification = 'succeeded' | 'failed' | 'processing'
export function classifyCharge(snapshot: { paymentIntentStatus: string; chargeStatus: string; paid: boolean; hasBalanceTransaction: boolean; amountCents: number }): ChargeClassification {
  if (!Number.isSafeInteger(snapshot.amountCents) || snapshot.amountCents < 0) throw new InvalidAmountError()
  if (snapshot.paymentIntentStatus === 'succeeded' && snapshot.chargeStatus === 'succeeded' && snapshot.paid && snapshot.hasBalanceTransaction) return 'succeeded'
  if (snapshot.paymentIntentStatus === 'requires_payment_method' || snapshot.paymentIntentStatus === 'canceled' || snapshot.chargeStatus === 'failed' || snapshot.chargeStatus === 'canceled') return 'failed'
  return 'processing'
}
