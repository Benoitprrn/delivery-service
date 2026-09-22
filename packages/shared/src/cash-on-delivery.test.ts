import { describe, expect, it } from 'vitest'
import { cashOnDeliveryInputSchema } from './index.js'

describe('cashOnDeliveryInputSchema', () => {
  it('accepts an integer amount in bounds', () => {
    expect(cashOnDeliveryInputSchema.parse({ amountCents: 150 })).toEqual({ amountCents: 150 })
  })

  it.each([
    { amountCents: 150.5 },
    { amountCents: 99 },
    { amountCents: 50001 },
    { amountCents: '150' },
    { amountCents: 150, extra: true }
  ])('rejects invalid input %o', input => {
    expect(cashOnDeliveryInputSchema.safeParse(input).success).toBe(false)
  })
})
