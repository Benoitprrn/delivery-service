import { InvalidAmountError, InvalidStatementStatusTransitionError } from './errors.js'
import { type StatementPayoutDecision } from './payout-decision.js'

export type StatementStatus = 'unpaid' | 'waiting_sepa' | 'succeeded_held' | 'unpaid_restaurant' | 'blocked_driver_account' | 'partial' | 'paid'
export function deriveStatementStatus(input: { dueCents: number; paidCents: number; decision: StatementPayoutDecision }): StatementStatus {
  if (!Number.isSafeInteger(input.dueCents) || !Number.isSafeInteger(input.paidCents) || input.dueCents < 0 || input.paidCents < 0 || input.paidCents > input.dueCents) throw new InvalidAmountError()
  if (input.paidCents === input.dueCents) return 'paid'
  if (input.paidCents > 0) return 'partial'
  if (input.decision.action === 'transfer') return 'unpaid'
  const statuses: Record<Exclude<import('./payout-decision.js').PayoutWaitReason, 'nothing_due'>, StatementStatus> = { no_debit: 'unpaid', processing: 'waiting_sepa', unpaid_restaurant: 'unpaid_restaurant', held_until_payrun: 'succeeded_held', blocked_driver_account: 'blocked_driver_account', charge_exhausted: 'unpaid' }
  return input.decision.reason === 'nothing_due' ? 'unpaid' : statuses[input.decision.reason]
}

/** Les écritures de transferts sont append-only : `paid` est un état terminal. */
export function transitionStatementStatus(current: StatementStatus, target: StatementStatus): StatementStatus {
  if (current === 'paid' && target !== 'paid') throw new InvalidStatementStatusTransitionError()
  return target
}
