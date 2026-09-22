import { type ChargeClassification } from './charge-classification.js'
import { InvalidAmountError } from './errors.js'

export type PayoutWaitReason = 'nothing_due' | 'no_debit' | 'processing' | 'unpaid_restaurant' | 'held_until_payrun' | 'blocked_driver_account' | 'charge_exhausted'
export type StatementPayoutDecision = { action: 'transfer'; amountCents: number; chargeId: string } | { action: 'wait'; reason: PayoutWaitReason }
export function decideStatementPayout(input: { dueCents: number; paidCents: number; debit: { classification: ChargeClassification; chargeId: string; chargeAmountCents: number; alreadyTransferredFromChargeCents: number } | null; driverAccount: { transfersActive: boolean }; now: Date; payrunAt: Date }): StatementPayoutDecision {
  const amounts = [input.dueCents, input.paidCents, ...(input.debit === null ? [] : [input.debit.chargeAmountCents, input.debit.alreadyTransferredFromChargeCents])]
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) throw new InvalidAmountError()
  const remaining = input.dueCents - input.paidCents
  if (remaining <= 0) return { action: 'wait', reason: 'nothing_due' }
  if (input.debit === null) return { action: 'wait', reason: 'no_debit' }
  if (input.debit.classification === 'failed') return { action: 'wait', reason: 'unpaid_restaurant' }
  if (input.debit.classification === 'processing') return { action: 'wait', reason: 'processing' }
  if (input.now.getTime() < input.payrunAt.getTime()) return { action: 'wait', reason: 'held_until_payrun' }
  if (!input.driverAccount.transfersActive) return { action: 'wait', reason: 'blocked_driver_account' }
  const amountCents = Math.min(remaining, input.debit.chargeAmountCents - input.debit.alreadyTransferredFromChargeCents)
  return amountCents <= 0 ? { action: 'wait', reason: 'charge_exhausted' } : { action: 'transfer', amountCents, chargeId: input.debit.chargeId }
}
