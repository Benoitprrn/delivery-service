export type PricingSettings = {
  ruleVersion: number
  pickupFeeCents: number
  kmRateCents: number
  minuteRateCents: number
  minimumDeliveryCents: number
  serviceFeeRateBps: number
}

const legacyDefaultSettings: PricingSettings = {
  ruleVersion: 1,
  pickupFeeCents: 100,
  kmRateCents: 37,
  minuteRateCents: 22,
  minimumDeliveryCents: 400,
  serviceFeeRateBps: 2000
}

/** Mirrors the database trigger's integer formula for pre-order estimates. */
export function computePriceCents(
  distanceM: number,
  durationS: number,
  settings: PricingSettings = legacyDefaultSettings
): number {
  const distanceComponent = Math.floor((distanceM * settings.kmRateCents) / 1_000)
  const durationComponent = Math.floor((durationS * settings.minuteRateCents) / 60)

  return Math.max(settings.minimumDeliveryCents, settings.pickupFeeCents + distanceComponent + durationComponent)
}

export function computeServiceFeeCents(deliveryCents: number, serviceFeeRateBps: number): number {
  return Math.floor((deliveryCents * serviceFeeRateBps) / 10_000)
}
