import { describe, expect, it } from 'vitest'
import { computeLineFee, DEFAULT_FEE_RATE_BPS, sumStatementAmounts } from '../../../src/modules/settlements/public.js'

describe('fees', () => {
  it('applies floor to every line, not to the statement total', () => {
    expect([401, 475, 909].map((earningCents) => computeLineFee({ earningCents, feeRateBps: DEFAULT_FEE_RATE_BPS }).feeCents)).toEqual([80, 95, 181])
    expect(sumStatementAmounts([401, 475, 909].map((earningCents) => ({ earningCents, feeRateBps: 2_000 })))).toEqual({ grossCents: 1785, feeCents: 356, dueCents: 1429 })
  })
  it.each([-1, 1.5, Number.NaN])('refuses invalid cents %p', (earningCents) => expect(() => computeLineFee({ earningCents, feeRateBps: 2_000 })).toThrow())
  it.each([-1, 10_001, 1.5])('refuses invalid bps %p', (feeRateBps) => expect(() => computeLineFee({ earningCents: 1, feeRateBps })).toThrow())
})
