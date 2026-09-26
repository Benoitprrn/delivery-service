import type { Pool } from 'pg'
import { inTransaction } from '../../../platform/transaction.js'
import { isValidSiret, normalizeSiret } from './legal-information.js'

export type MissingCompanyProfileItem =
  | 'first_name' | 'last_name' | 'phone' | 'legal_form' | 'professional_name'
  | 'siret' | 'legal_address_line1' | 'legal_address_postal_code' | 'legal_address_city'
  | 'vat_regime' | 'vat_number' | 'identity_document' | 'business_registration_document'

export type DriverCompanyProfile = {
  firstName: string | null; lastName: string | null; phone: string | null; legalForm: string | null
  professionalName: string | null; siret: string | null
  legalAddress: { line1: string | null; postalCode: string | null; city: string | null }
  vatNumber: string | null; vatRegime: 'assujetti' | 'franchise_en_base' | 'exonere' | null
}
export type DriverCompanyProfileStatus = { complete: boolean; missing: MissingCompanyProfileItem[] }
type Row = { first_name: string | null; last_name: string | null; phone: string | null; legal_form: string | null; professional_name: string | null; siret: string | null; legal_address_line1: string | null; legal_address_postal_code: string | null; legal_address_city: string | null; vat_number: string | null; vat_regime: DriverCompanyProfile['vatRegime']; has_identity_document: boolean; has_business_registration_document: boolean }
const nonBlank = (value: string | null): value is string => value !== null && value.trim().length > 0
const frenchPhone = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/

export class DriverCompanyProfileUseCases {
  public constructor(private readonly pool: Pool) {}
  private async row(driverId: string): Promise<Row | null> {
    // New sign-ups can be created after the migration. Seed their draft lazily
    // from the operational/profile tables without treating it as legal data.
    await this.pool.query(`insert into driver_company_profile_drafts(driver_id,first_name,last_name,phone,legal_form,professional_name,siret,legal_address_line1,legal_address_postal_code,legal_address_city,vat_number,vat_regime) select d.id,d.first_name,d.last_name,d.phone,li.legal_form,li.professional_name,li.siret,li.legal_address_line1,li.legal_address_postal_code,li.legal_address_city,li.vat_number,li.vat_regime from drivers d left join driver_legal_information li on li.driver_id=d.id where d.id=$1 on conflict(driver_id) do nothing`, [driverId])
    const result = await this.pool.query<Row>(`select p.*, exists(select 1 from account_documents ad where ad.driver_id=p.driver_id and ad.document_type='identity_document' and ad.replaced_at is null) as has_identity_document, exists(select 1 from account_documents ad where ad.driver_id=p.driver_id and ad.document_type='business_registration_document' and ad.replaced_at is null) as has_business_registration_document from driver_company_profile_drafts p where p.driver_id=$1`, [driverId])
    return result.rows[0] ?? null
  }
  private profile(row: Row): DriverCompanyProfile { return { firstName: row.first_name, lastName: row.last_name, phone: row.phone, legalForm: row.legal_form, professionalName: row.professional_name, siret: row.siret, legalAddress: { line1: row.legal_address_line1, postalCode: row.legal_address_postal_code, city: row.legal_address_city }, vatNumber: row.vat_number, vatRegime: row.vat_regime } }
  private status(row: Row | null): DriverCompanyProfileStatus {
    if (row === null) return { complete: false, missing: ['first_name', 'last_name', 'phone', 'legal_form', 'professional_name', 'siret', 'legal_address_line1', 'legal_address_postal_code', 'legal_address_city', 'vat_regime', 'identity_document', 'business_registration_document'] }
    const missing: MissingCompanyProfileItem[] = []
    if (!nonBlank(row.first_name)) missing.push('first_name'); if (!nonBlank(row.last_name)) missing.push('last_name'); if (!nonBlank(row.phone) || !frenchPhone.test(row.phone)) missing.push('phone')
    if (!nonBlank(row.legal_form)) missing.push('legal_form'); if (!nonBlank(row.professional_name)) missing.push('professional_name')
    if (!nonBlank(row.siret) || !isValidSiret(normalizeSiret(row.siret))) missing.push('siret')
    if (!nonBlank(row.legal_address_line1)) missing.push('legal_address_line1'); if (!nonBlank(row.legal_address_postal_code) || !/^\d{5}$/.test(row.legal_address_postal_code)) missing.push('legal_address_postal_code'); if (!nonBlank(row.legal_address_city)) missing.push('legal_address_city')
    if (row.vat_regime === null) missing.push('vat_regime'); if (row.vat_regime === 'assujetti' && (!nonBlank(row.vat_number) || !/^FR[A-Z0-9]{2}\d{9}$/.test(row.vat_number))) missing.push('vat_number')
    if (!row.has_identity_document) missing.push('identity_document'); if (!row.has_business_registration_document) missing.push('business_registration_document')
    return { complete: missing.length === 0, missing }
  }
  public async get(driverId: string): Promise<{ profile: DriverCompanyProfile; status: DriverCompanyProfileStatus }> { const row = await this.row(driverId); return { profile: row === null ? { firstName: null, lastName: null, phone: null, legalForm: null, professionalName: null, siret: null, legalAddress: { line1: null, postalCode: null, city: null }, vatNumber: null, vatRegime: null } : this.profile(row), status: this.status(row) } }
  public async statusFor(driverId: string): Promise<DriverCompanyProfileStatus> { return this.status(await this.row(driverId)) }
  public async save(driverId: string, profile: DriverCompanyProfile): Promise<{ profile: DriverCompanyProfile; status: DriverCompanyProfileStatus }> {
    await inTransaction(this.pool, async client => { await client.query(`insert into driver_company_profile_drafts(driver_id,first_name,last_name,phone,legal_form,professional_name,siret,legal_address_line1,legal_address_postal_code,legal_address_city,vat_number,vat_regime,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) on conflict(driver_id) do update set first_name=excluded.first_name,last_name=excluded.last_name,phone=excluded.phone,legal_form=excluded.legal_form,professional_name=excluded.professional_name,siret=excluded.siret,legal_address_line1=excluded.legal_address_line1,legal_address_postal_code=excluded.legal_address_postal_code,legal_address_city=excluded.legal_address_city,vat_number=excluded.vat_number,vat_regime=excluded.vat_regime,updated_at=now()`, [driverId,profile.firstName,profile.lastName,profile.phone,profile.legalForm,profile.professionalName,profile.siret,profile.legalAddress.line1,profile.legalAddress.postalCode,profile.legalAddress.city,profile.vatNumber,profile.vatRegime]) })
    const current = await this.get(driverId)
    if (!current.status.complete) return current
    const p = current.profile
    await inTransaction(this.pool, async client => {
      await client.query('update drivers set first_name=$1,last_name=$2,phone=$3,name=$4 where id=$5', [p.firstName,p.lastName,p.phone,`${p.firstName} ${p.lastName}`,driverId])
      const siret = normalizeSiret(p.siret!)
      await client.query(`insert into driver_legal_information(driver_id,professional_name,siret,siren,legal_address_line1,legal_address_postal_code,legal_address_city,legal_address_country_code,vat_number,vat_regime,legal_form) values($1,$2,$3,$4,$5,$6,$7,'FR',$8,$9,$10) on conflict(driver_id) do update set professional_name=excluded.professional_name,siret=excluded.siret,siren=excluded.siren,legal_address_line1=excluded.legal_address_line1,legal_address_postal_code=excluded.legal_address_postal_code,legal_address_city=excluded.legal_address_city,vat_number=excluded.vat_number,vat_regime=excluded.vat_regime,legal_form=excluded.legal_form,updated_at=now()`, [driverId,p.professionalName,siret,siret.slice(0,9),p.legalAddress.line1,p.legalAddress.postalCode,p.legalAddress.city,p.vatNumber,p.vatRegime,p.legalForm])
    })
    return current
  }
}
