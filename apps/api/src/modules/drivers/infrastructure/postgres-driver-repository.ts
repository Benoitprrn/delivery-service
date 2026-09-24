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

  public async updateProfile(driverId: string, profile: { firstName: string; lastName: string; phone: string }): Promise<Driver | null> {
    const result = await this.pool.query<DriverRow>(
      `update drivers set first_name = $1, last_name = $2, phone = $3, name = $4 where id = $5
       returning id, name, first_name, last_name, phone, zone_id, is_available`,
      [profile.firstName, profile.lastName, profile.phone, `${profile.firstName} ${profile.lastName}`, driverId]
    )
    const row = result.rows[0]
    return row === undefined ? null : { id: row.id, name: row.name, firstName: row.first_name, lastName: row.last_name, phone: row.phone, zoneId: row.zone_id, isAvailable: row.is_available }
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
  public async upsertLegalInformation(value: DriverLegalInformation): Promise<DriverLegalInformation> {
    const a = value.legalAddress; const b = value.billingAddress
    const result = await this.pool.query(`insert into driver_legal_information (driver_id,professional_name,siret,siren,legal_address_line1,legal_address_line2,legal_address_postal_code,legal_address_city,legal_address_country_code,legal_address_commune_code,billing_address_line1,billing_address_line2,billing_address_postal_code,billing_address_city,billing_address_country_code,billing_address_commune_code,vat_number,vat_regime,legal_form) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) on conflict (driver_id) do update set professional_name=excluded.professional_name,siret=excluded.siret,siren=excluded.siren,legal_address_line1=excluded.legal_address_line1,legal_address_line2=excluded.legal_address_line2,legal_address_postal_code=excluded.legal_address_postal_code,legal_address_city=excluded.legal_address_city,legal_address_country_code=excluded.legal_address_country_code,legal_address_commune_code=excluded.legal_address_commune_code,billing_address_line1=excluded.billing_address_line1,billing_address_line2=excluded.billing_address_line2,billing_address_postal_code=excluded.billing_address_postal_code,billing_address_city=excluded.billing_address_city,billing_address_country_code=excluded.billing_address_country_code,billing_address_commune_code=excluded.billing_address_commune_code,vat_number=excluded.vat_number,vat_regime=excluded.vat_regime,legal_form=excluded.legal_form returning *`, [value.driverId,value.professionalName,value.siret,value.siren,a.line1,a.line2,a.postalCode,a.city,a.countryCode,a.communeCode,b?.line1 ?? null,b?.line2 ?? null,b?.postalCode ?? null,b?.city ?? null,b?.countryCode ?? null,b?.communeCode ?? null,value.vatNumber,value.vatRegime,value.legalForm])
    return this.legalFromRow(result.rows[0] as Record<string, unknown>)
  }
  private legalFromRow(row: Record<string, unknown>): DriverLegalInformation { const billingAddress = row.billing_address_line1 === null ? null : { line1: String(row.billing_address_line1), line2: row.billing_address_line2 as string | null, postalCode: String(row.billing_address_postal_code), city: String(row.billing_address_city), countryCode: String(row.billing_address_country_code), communeCode: row.billing_address_commune_code as string | null }; return { driverId: String(row.driver_id), professionalName: String(row.professional_name), siret: String(row.siret), siren: String(row.siren), legalAddress: { line1: String(row.legal_address_line1), line2: row.legal_address_line2 as string | null, postalCode: String(row.legal_address_postal_code), city: String(row.legal_address_city), countryCode: String(row.legal_address_country_code), communeCode: row.legal_address_commune_code as string | null }, billingAddress, vatNumber: row.vat_number as string | null, vatRegime: row.vat_regime as DriverLegalInformation['vatRegime'], legalForm: row.legal_form as string | null } }
}
