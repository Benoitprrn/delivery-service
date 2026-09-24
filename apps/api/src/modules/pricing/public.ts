import type { Pool } from 'pg'
import { PostgresPricingSettingsReader } from './infrastructure/postgres-pricing-settings-reader.js'

export { computePriceCents, computeServiceFeeCents } from './domain/compute-price-cents.js'
export type { PricingSettings } from './domain/compute-price-cents.js'
export type { PricingSettingsReader } from './ports/pricing-settings-reader.js'

export function createPricingSettingsReader(pool: Pool): PostgresPricingSettingsReader {
  return new PostgresPricingSettingsReader(pool)
}
