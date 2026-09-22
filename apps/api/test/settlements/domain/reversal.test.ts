import { describe, expect, it } from 'vitest'
import { parseReversalCategory, planReversal } from '../../../src/modules/settlements/public.js'

describe('reversals', () => {
  it('forbids restaurant and SEPA causes while accepting only B/C categories', () => {
    expect(parseReversalCategory('driver_fault')).toBe('driver_fault'); expect(parseReversalCategory('locadely_error')).toBe('locadely_error')
    expect(() => parseReversalCategory('sepa_return')).toThrow(); expect(() => parseReversalCategory('other')).toThrow()
  })
  it.each(['restaurant_default', 'sepa_return', 'card_dispute', 'merchant_insolvency', 'impaye'])('refuses the restaurant-side cause %s with the dedicated error', cause => {
    expect(() => parseReversalCategory(cause)).toThrowError(expect.objectContaining({ code: 'RESTAURANT_DEFAULT_REVERSAL_FORBIDDEN' }))
  })
  it('rejects unknown categories with the generic error', () => {
    expect(() => parseReversalCategory('theft')).toThrowError(expect.objectContaining({ code: 'INVALID_REVERSAL_CATEGORY' }))
  })
  it('creates a receivable instead of a negative-balance reversal by default', () => {
    expect(planReversal({ requestedCents: 80, transferCents: 100, alreadyReversedCents: 0, driverRecoverableBalanceCents: 30 })).toEqual({ reverseNowCents: 30, receivableCents: 50 })
    expect(planReversal({ requestedCents: 80, transferCents: 100, alreadyReversedCents: 0, driverRecoverableBalanceCents: 0, allowNegativeBalance: true })).toEqual({ reverseNowCents: 80, receivableCents: 0 })
  })
  it('refuses to reverse more than the un-reversed transfer', () => expect(() => planReversal({ requestedCents: 81, transferCents: 100, alreadyReversedCents: 20, driverRecoverableBalanceCents: 100 })).toThrow())
})
