import type { PoolClient } from 'pg'
import type { PricingSettings } from '../domain/compute-price-cents.js'

export interface PricingSettingsReader {
  findActive(client?: PoolClient): Promise<PricingSettings>
  findByRuleVersion(ruleVersion: number, client?: PoolClient): Promise<PricingSettings>
}
