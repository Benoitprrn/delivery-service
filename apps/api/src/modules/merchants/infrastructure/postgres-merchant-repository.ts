import type { Pool, PoolClient } from 'pg'
import { inTransaction } from '../../../platform/transaction.js'
import { MerchantNotFoundError } from '../domain/errors.js'
import type { Merchant } from '../domain/merchant.js'
import type { MerchantInformationPatch, MerchantRepository, MerchantLegalInformation, MerchantLegalInformationPatch, MerchantLegalInformationRepository, SireneVerificationStatus } from '../ports/merchant-repository.js'

type MerchantRow = {
  id: string
  name: string
  zone_id: string | null
  address: string | null
  phone_primary: string | null
  phone_secondary: string | null
  logo_url: string | null
  lat: number | null
  lng: number | null
  onboarding_completed: boolean
}

type LegalRow = { merchant_id: string; siret: string; siren: string; legal_name: string; legal_address_line1: string; legal_address_line2: string | null; legal_address_postal_code: string; legal_address_city: string; legal_address_country_code: string; legal_address_commune_code: string | null; billing_address_line1: string | null; billing_address_line2: string | null; billing_address_postal_code: string | null; billing_address_city: string | null; billing_address_country_code: string | null; billing_address_commune_code: string | null; vat_number: string | null; sirene_verification_status: SireneVerificationStatus; sirene_verified_at: Date | null }
export class PostgresMerchantRepository implements MerchantRepository, MerchantLegalInformationRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(id: string, client?: PoolClient): Promise<Merchant | null> {
    const result = await (client ?? this.pool).query<MerchantRow>(
      'select id, name, zone_id, address, phone_primary, phone_secondary, logo_url, lat, lng, onboarding_completed from merchants where id = $1',
      [id]
    )
    const row = result.rows[0]

    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          zoneId: row.zone_id,
          address: row.address,
          phonePrimary: row.phone_primary,
          phoneSecondary: row.phone_secondary,
          logoUrl: row.logo_url,
          lat: row.lat,
          lng: row.lng,
          onboardingCompleted: row.onboarding_completed
        }
  }

  public async createIncomplete(id: string, name: string): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `insert into merchants (id, name, onboarding_completed, zone_id, address, lat, lng, phone_primary, phone_secondary, logo_url)
         values ($1, $2, false, null, null, null, null, null, null, null)`,
        [id, name]
      )
    })
  }

  public async updateInformation(id: string, patch: MerchantInformationPatch, client?: PoolClient): Promise<Merchant> {
    const result = await (client ?? this.pool).query<MerchantRow>(
      `update merchants
       set name = $1, address = $2, lat = $3, lng = $4, zone_id = $5, phone_primary = $6, phone_secondary = $7
       where id = $8
       returning id, name, zone_id, address, phone_primary, phone_secondary, logo_url, lat, lng, onboarding_completed`,
      [patch.name, patch.address, patch.lat, patch.lng, patch.zoneId, patch.phonePrimary, patch.phoneSecondary, id]
    )
    const row = result.rows[0]

    if (row === undefined) {
      throw new MerchantNotFoundError(`Merchant ${id} not found`)
    }

    return {
      id: row.id,
      name: row.name,
      zoneId: row.zone_id,
      address: row.address,
      phonePrimary: row.phone_primary,
      phoneSecondary: row.phone_secondary,
      logoUrl: row.logo_url,
      lat: row.lat,
      lng: row.lng,
      onboardingCompleted: row.onboarding_completed
    }
  }

  public async updateLogoUrl(id: string, logoUrl: string): Promise<Merchant> {
    const result = await this.pool.query<MerchantRow>(
      `update merchants set logo_url = $1 where id = $2
       returning id, name, zone_id, address, phone_primary, phone_secondary, logo_url, lat, lng, onboarding_completed`,
      [logoUrl, id]
    )
    const row = result.rows[0]
    if (row === undefined) throw new MerchantNotFoundError(`Merchant ${id} not found`)
    return {
      id: row.id, name: row.name, zoneId: row.zone_id, address: row.address,
      phonePrimary: row.phone_primary, phoneSecondary: row.phone_secondary, logoUrl: row.logo_url,
      lat: row.lat, lng: row.lng, onboardingCompleted: row.onboarding_completed
    }
  }

  public async findLegalInformation(merchantId: string): Promise<MerchantLegalInformation | null> {
    const result = await this.pool.query<LegalRow>('select * from merchant_legal_information where merchant_id = $1', [merchantId]); const row = result.rows[0]
    return row === undefined ? null : this.legalFromRow(row)
  }
  public async upsertLegalInformation(patch: MerchantLegalInformationPatch): Promise<MerchantLegalInformation> {
    const a = patch.legalAddress; const b = patch.billingAddress
    const result = await this.pool.query<LegalRow>(`insert into merchant_legal_information (merchant_id,siret,siren,legal_name,legal_address_line1,legal_address_line2,legal_address_postal_code,legal_address_city,legal_address_country_code,legal_address_commune_code,billing_address_line1,billing_address_line2,billing_address_postal_code,billing_address_city,billing_address_country_code,billing_address_commune_code,vat_number,sirene_verification_status,sirene_verified_at)
values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,case when $18='verified' then now() else null end)
on conflict (merchant_id) do update set siret=excluded.siret,siren=excluded.siren,legal_name=excluded.legal_name,legal_address_line1=excluded.legal_address_line1,legal_address_line2=excluded.legal_address_line2,legal_address_postal_code=excluded.legal_address_postal_code,legal_address_city=excluded.legal_address_city,legal_address_country_code=excluded.legal_address_country_code,legal_address_commune_code=excluded.legal_address_commune_code,billing_address_line1=excluded.billing_address_line1,billing_address_line2=excluded.billing_address_line2,billing_address_postal_code=excluded.billing_address_postal_code,billing_address_city=excluded.billing_address_city,billing_address_country_code=excluded.billing_address_country_code,billing_address_commune_code=excluded.billing_address_commune_code,vat_number=excluded.vat_number,sirene_verification_status=excluded.sirene_verification_status,sirene_verified_at=case when excluded.sirene_verification_status='verified' then now() else null end
returning *`, [patch.merchantId,patch.siret,patch.siren,patch.legalName,a.line1,a.line2,a.postalCode,a.city,a.countryCode,a.communeCode,b?.line1 ?? null,b?.line2 ?? null,b?.postalCode ?? null,b?.city ?? null,b?.countryCode ?? null,b?.communeCode ?? null,patch.vatNumber,patch.sireneVerificationStatus])
    return this.legalFromRow(result.rows[0]!)
  }
  private legalFromRow(row: LegalRow): MerchantLegalInformation { const legalAddress={line1:row.legal_address_line1,line2:row.legal_address_line2,postalCode:row.legal_address_postal_code,city:row.legal_address_city,countryCode:row.legal_address_country_code,communeCode:row.legal_address_commune_code}; const billingAddress=row.billing_address_line1 === null ? null : {line1:row.billing_address_line1,line2:row.billing_address_line2,postalCode:row.billing_address_postal_code!,city:row.billing_address_city!,countryCode:row.billing_address_country_code!,communeCode:row.billing_address_commune_code}; return {merchantId:row.merchant_id,siret:row.siret,siren:row.siren,legalName:row.legal_name,legalAddress,billingAddress,vatNumber:row.vat_number,sireneVerificationStatus:row.sirene_verification_status,sireneVerifiedAt:row.sirene_verified_at} }
}
