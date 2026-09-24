import { InvalidAmountError } from './errors.js'
import type { ReversalCategory } from './reversal.js'

function cents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidAmountError()
}

/** Deterministic consequence of a completed R61 reversal; it is not another approval decision. */
export function isServiceRefundEligible(input: { category: ReversalCategory; orderId: string | null; reversedCents: number }): boolean {
  cents(input.reversedCents)
  return input.category === 'driver_fault' && input.orderId !== null && input.reversedCents > 0
}

/** Amount from this Transfer reversal that can still be attributed to this order. */
export function clampAttributedReversalCents(input: { reversedCents: number; deliveryCents: number; previouslyRecoveredCents: number }): number {
  cents(input.reversedCents); cents(input.deliveryCents); cents(input.previouslyRecoveredCents)
  if (input.deliveryCents <= 0 || input.previouslyRecoveredCents > input.deliveryCents) throw new InvalidAmountError()
  return Math.min(input.reversedCents, input.deliveryCents - input.previouslyRecoveredCents)
}

/** Integer-only cumulative allocation; mirrors 0044's PostgreSQL integer division CHECK. */
export function computeCumulativeServiceRefundCents(input: { deliveryCents: number; serviceFeeCents: number; previouslyRecoveredCents: number; reversedCents: number }): number {
  cents(input.deliveryCents); cents(input.serviceFeeCents); cents(input.previouslyRecoveredCents); cents(input.reversedCents)
  const recoveredAfter = BigInt(input.previouslyRecoveredCents) + BigInt(input.reversedCents)
  if (input.deliveryCents <= 0 || recoveredAfter > BigInt(input.deliveryCents)) throw new InvalidAmountError()
  const before = BigInt(input.previouslyRecoveredCents) * BigInt(input.serviceFeeCents) / BigInt(input.deliveryCents)
  const after = recoveredAfter * BigInt(input.serviceFeeCents) / BigInt(input.deliveryCents)
  const result = after - before
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidAmountError()
  return Number(result)
}
