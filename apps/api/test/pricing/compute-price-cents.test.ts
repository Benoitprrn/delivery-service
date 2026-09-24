import { describe, expect, it } from 'vitest'
import { computePriceCents, computeServiceFeeCents, type PricingSettings } from '../../src/modules/pricing/public.js'

const settings: PricingSettings = {
  ruleVersion: 3,
  pickupFeeCents: 100,
  kmRateCents: 37,
  minuteRateCents: 22,
  minimumDeliveryCents: 400,
  serviceFeeRateBps: 2000
}

describe('computePriceCents', () => {
  it('matches the ADR examples', () => {
    expect(computePriceCents(3_000, 720, settings)).toBe(475)
    expect(computePriceCents(500, 180, settings)).toBe(400)
    expect(computePriceCents(7_000, 1_500, settings)).toBe(909)
  })

  it('calculates additive service fees on the final delivery amount', () => {
    const deliveryCents = 600
    const serviceFeeCents = computeServiceFeeCents(deliveryCents, settings.serviceFeeRateBps)
    expect({ deliveryCents, serviceFeeCents, merchantTotalCents: deliveryCents + serviceFeeCents })
      .toEqual({ deliveryCents: 600, serviceFeeCents: 120, merchantTotalCents: 720 })

    const minimumDeliveryCents = computePriceCents(5_000, 150, settings)
    const minimumServiceFeeCents = computeServiceFeeCents(minimumDeliveryCents, settings.serviceFeeRateBps)
    expect({ deliveryCents: minimumDeliveryCents, serviceFeeCents: minimumServiceFeeCents, merchantTotalCents: minimumDeliveryCents + minimumServiceFeeCents })
      .toEqual({ deliveryCents: 400, serviceFeeCents: 80, merchantTotalCents: 480 })
  })

  it('uses a merchant override instead of the default service-fee rate', () => {
    expect(computeServiceFeeCents(600, 2_500)).toBe(150)
  })
})
