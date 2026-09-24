import type { Pool, PoolClient } from 'pg'
import type { PricingSettings } from '../domain/compute-price-cents.js'
import type { PricingSettingsReader } from '../ports/pricing-settings-reader.js'

type PricingSettingsRow = {
  rule_version: number
  pickup_fee_cents: number
  km_rate_cents: number
  minute_rate_cents: number
  minimum_delivery_cents: number
  service_fee_rate_bps: number
}

function mapSettings(row: PricingSettingsRow): PricingSettings {
  return {
    ruleVersion: row.rule_version,
    pickupFeeCents: row.pickup_fee_cents,
    kmRateCents: row.km_rate_cents,
    minuteRateCents: row.minute_rate_cents,
    minimumDeliveryCents: row.minimum_delivery_cents,
    serviceFeeRateBps: row.service_fee_rate_bps
  }
}

export class PostgresPricingSettingsReader implements PricingSettingsReader {
  public constructor(private readonly pool: Pool) {}

  public async findActive(client?: PoolClient): Promise<PricingSettings> {
    const result = await (client ?? this.pool).query<PricingSettingsRow>(
      `select rule_version, pickup_fee_cents, km_rate_cents, minute_rate_cents,
              minimum_delivery_cents, service_fee_rate_bps
         from pricing_settings
        order by rule_version desc
        limit 1`
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('No active pricing settings found')
    return mapSettings(row)
  }

  public async findByRuleVersion(ruleVersion: number, client?: PoolClient): Promise<PricingSettings> {
    const result = await (client ?? this.pool).query<PricingSettingsRow>(
      `select rule_version, pickup_fee_cents, km_rate_cents, minute_rate_cents,
              minimum_delivery_cents, service_fee_rate_bps
         from pricing_settings
        where rule_version = $1`,
      [ruleVersion]
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error(`Pricing settings rule version ${ruleVersion} not found`)
    return mapSettings(row)
  }
}
