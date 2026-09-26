import type { Pool } from 'pg'
import type { Driver } from '../domain/driver.js'
import type { DriverLegalInformationRepository, DriverRepository } from '../ports/driver-repository.js'
import type { DriverLegalInformation } from '../application/legal-information.js'

type DriverRow = {
  id: string
  name: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  zone_id: string
  is_available: boolean
}

export class PostgresDriverRepository implements DriverRepository, DriverLegalInformationRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(id: string): Promise<Driver | null> {
    const result = await this.pool.query<DriverRow>(
      'select id, name, first_name, last_name, phone, zone_id, is_available from drivers where id = $1',
      [id]
    )
    const row = result.rows[0]

    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          zoneId: row.zone_id,
          // Postgres retains this legacy field, but Valkey is the live availability source of truth.
          isAvailable: row.is_available
        }
  }

  public async findIdsByZoneId(zoneId: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>('select id from drivers where zone_id = $1', [zoneId])
    return result.rows.map((row) => row.id)
  }

  public async setPushToken(driverId: string, token: string): Promise<void> {
    await this.pool.query('update drivers set push_token = $1 where id = $2', [token, driverId])
  }

  public async findPushTokensByDriverIds(driverIds: readonly string[]): Promise<string[]> {
    if (driverIds.length === 0) return []
    const result = await this.pool.query<{ push_token: string }>(
      'select push_token from drivers where id = any($1) and push_token is not null',
      [driverIds]
    )
    return result.rows.map((row) => row.push_token)
  }

  public async findLegalInformation(driverId: string): Promise<DriverLegalInformation | null> {
    const result = await this.pool.query('select * from driver_legal_information where driver_id = $1', [driverId])
    return result.rows[0] === undefined ? null : this.legalFromRow(result.rows[0])
  }
  private legalFromRow(row: Record<string, unknown>): DriverLegalInformation { const billingAddress = row.billing_address_line1 === null ? null : { line1: String(row.billing_address_line1), line2: row.billing_address_line2 as string | null, postalCode: String(row.billing_address_postal_code), city: String(row.billing_address_city), countryCode: String(row.billing_address_country_code), communeCode: row.billing_address_commune_code as string | null }; return { driverId: String(row.driver_id), professionalName: String(row.professional_name), siret: String(row.siret), siren: String(row.siren), legalAddress: { line1: String(row.legal_address_line1), line2: row.legal_address_line2 as string | null, postalCode: String(row.legal_address_postal_code), city: String(row.legal_address_city), countryCode: String(row.legal_address_country_code), communeCode: row.legal_address_commune_code as string | null }, billingAddress, vatNumber: row.vat_number as string | null, vatRegime: row.vat_regime as DriverLegalInformation['vatRegime'], legalForm: row.legal_form as string | null } }
}
