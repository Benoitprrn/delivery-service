import { describe, expect, it } from 'vitest'
import { computePriceCents } from '../../src/modules/pricing/public.js'

describe('computePriceCents', () => {
  it('matches the ADR examples', () => {
    expect(computePriceCents(3_000, 720)).toBe(475)
    expect(computePriceCents(500, 180)).toBe(400)
    expect(computePriceCents(7_000, 1_500)).toBe(909)
  })
})
