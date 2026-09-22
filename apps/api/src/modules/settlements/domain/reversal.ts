import { InvalidAmountError, InvalidReversalCategoryError, RestaurantDefaultReversalForbiddenError, ReversalAmountExceededError } from './errors.js'

export type ReversalCategory = 'driver_fault' | 'locadely_error'
export function parseReversalCategory(input: string): ReversalCategory {
  if (input === 'driver_fault' || input === 'locadely_error') return input
  if (/restaurant|sepa|merchant|impay|dispute/i.test(input)) throw new RestaurantDefaultReversalForbiddenError()
  throw new InvalidReversalCategoryError()
}
export function planReversal(input: { requestedCents: number; transferCents: number; alreadyReversedCents: number; driverRecoverableBalanceCents: number; allowNegativeBalance?: boolean }): { reverseNowCents: number; receivableCents: number } {
  const values = [input.requestedCents, input.transferCents, input.alreadyReversedCents, input.driverRecoverableBalanceCents]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new InvalidAmountError()
  const remaining = input.transferCents - input.alreadyReversedCents
  if (remaining < 0 || input.requestedCents > remaining) throw new ReversalAmountExceededError()
  const reverseNowCents = input.allowNegativeBalance ? input.requestedCents : Math.min(input.requestedCents, input.driverRecoverableBalanceCents)
  return { reverseNowCents, receivableCents: input.requestedCents - reverseNowCents }
}
