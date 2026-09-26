import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DriverCompanyProfileUseCases, type DriverCompanyProfile } from '../../src/modules/drivers/application/company-profile.js'
import { pool } from '../../src/platform/db.js'

// Zone déjà seedée pour les tests d'inscription livreur (voir provision-driver.integration.test.ts).
const zoneId = '11111111-1111-1111-1111-111111111111'

const validAddress = { line1: '10 rue du Test', postalCode: '01000', city: 'Bourg-en-Bresse' }
const emptyProfile: DriverCompanyProfile = { firstName: null, lastName: null, phone: null, legalForm: null, professionalName: null, siret: null, legalAddress: { line1: null, postalCode: null, city: null }, vatNumber: null, vatRegime: null }
const completeProfile: DriverCompanyProfile = { firstName: 'Jean-Paul', lastName: 'Martin', phone: '0612345678', legalForm: 'Auto-entrepreneur', professionalName: 'Jean-Paul Martin Livraisons', siret: '73282932000074', legalAddress: validAddress, vatNumber: null, vatRegime: 'franchise_en_base' }

const createdDriverIds: string[] = []

async function createDriver(): Promise<string> {
  const result = await pool.query<{ id: string }>('insert into drivers (name, zone_id) values ($1, $2) returning id', ['Test Driver', zoneId])
  const id = result.rows[0]!.id
  createdDriverIds.push(id)
  return id
}

async function insertDocument(driverId: string, documentType: 'identity_document' | 'business_registration_document'): Promise<void> {
  await pool.query(
    `insert into account_documents (driver_id, document_type, storage_path, content_type, size_bytes)
     values ($1, $2, $3, 'application/pdf', 1024)`,
    [driverId, documentType, `drivers/${driverId}/${documentType}/${randomUUID()}.pdf`]
  )
}

afterEach(async () => {
  while (createdDriverIds.length > 0) {
    const id = createdDriverIds.pop()
    if (id === undefined) continue
    await pool.query('delete from account_documents where driver_id = $1', [id])
    await pool.query('delete from driver_legal_information where driver_id = $1', [id])
    await pool.query('delete from driver_company_profile_drafts where driver_id = $1', [id])
    await pool.query('delete from drivers where id = $1', [id])
  }
})

describe('DriverCompanyProfileUseCases (real Postgres)', () => {
  it('saves a partial draft without requiring any field, and reports it as incomplete', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    const result = await useCase.save(driverId, { ...emptyProfile, firstName: 'Jean-Paul' })
    expect(result.status.complete).toBe(false)
    expect(result.profile.firstName).toBe('Jean-Paul')
    const draft = await pool.query('select first_name from driver_company_profile_drafts where driver_id = $1', [driverId])
    expect(draft.rows[0]).toMatchObject({ first_name: 'Jean-Paul' })
  })

  it('re-saving overwrites the draft with the latest submitted state, including clearing a field back to null', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    await useCase.save(driverId, { ...emptyProfile, firstName: 'Jean-Paul', lastName: 'Martin' })
    const result = await useCase.save(driverId, { ...emptyProfile, firstName: 'Jean-Paul', lastName: null })
    expect(result.profile.lastName).toBeNull()
  })

  it('lists every missing field for a driver who has never saved anything', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    const result = await useCase.get(driverId)
    expect(result.status.complete).toBe(false)
    expect(result.status.missing).toEqual(expect.arrayContaining(['first_name', 'last_name', 'phone', 'legal_form', 'professional_name', 'siret', 'legal_address_line1', 'legal_address_postal_code', 'legal_address_city', 'vat_regime', 'identity_document', 'business_registration_document']))
  })

  it('flags an invalid phone and an invalid SIRET individually, without marking unrelated fields missing', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    const result = await useCase.save(driverId, { ...completeProfile, phone: '0000000000', siret: '73282932000075' })
    expect(result.status.missing).toEqual(expect.arrayContaining(['phone', 'siret']))
    expect(result.status.missing).not.toContain('first_name')
    expect(result.status.missing).not.toContain('legal_address_line1')
  })

  it('requires a VAT number only when the VAT regime is "assujetti"', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    const franchise = await useCase.save(driverId, { ...completeProfile, vatRegime: 'franchise_en_base', vatNumber: null })
    expect(franchise.status.missing).not.toContain('vat_number')
    const assujettiWithoutNumber = await useCase.save(driverId, { ...completeProfile, vatRegime: 'assujetti', vatNumber: null })
    expect(assujettiWithoutNumber.status.missing).toContain('vat_number')
    const assujettiWithNumber = await useCase.save(driverId, { ...completeProfile, vatRegime: 'assujetti', vatNumber: 'FR40732829320' })
    expect(assujettiWithNumber.status.missing).not.toContain('vat_number')
  })

  it('reports the two documents as missing until each is uploaded, independently', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    const noDocs = await useCase.save(driverId, completeProfile)
    expect(noDocs.status.missing).toEqual(expect.arrayContaining(['identity_document', 'business_registration_document']))
    await insertDocument(driverId, 'identity_document')
    const oneDoc = await useCase.statusFor(driverId)
    expect(oneDoc.missing).toContain('business_registration_document')
    expect(oneDoc.missing).not.toContain('identity_document')
    await insertDocument(driverId, 'business_registration_document')
    const bothDocs = await useCase.statusFor(driverId)
    expect(bothDocs.complete).toBe(true)
  })

  it('never publishes to drivers/driver_legal_information while the dossier is incomplete', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    await useCase.save(driverId, { ...completeProfile, siret: null })
    const legal = await pool.query('select 1 from driver_legal_information where driver_id = $1', [driverId])
    expect(legal.rowCount).toBe(0)
    const driver = await pool.query('select first_name from drivers where id = $1', [driverId])
    expect(driver.rows[0]).toMatchObject({ first_name: null })
  })

  it('publishes to drivers and driver_legal_information exactly once everything (fields + both documents) is complete', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    await insertDocument(driverId, 'identity_document')
    await insertDocument(driverId, 'business_registration_document')
    const result = await useCase.save(driverId, completeProfile)
    expect(result.status.complete).toBe(true)

    const driver = await pool.query('select first_name, last_name, phone, name from drivers where id = $1', [driverId])
    expect(driver.rows[0]).toMatchObject({ first_name: 'Jean-Paul', last_name: 'Martin', phone: '0612345678', name: 'Jean-Paul Martin' })

    const legal = await pool.query('select professional_name, siret, siren, legal_address_line1, vat_regime from driver_legal_information where driver_id = $1', [driverId])
    expect(legal.rows[0]).toMatchObject({ professional_name: 'Jean-Paul Martin Livraisons', siret: '73282932000074', siren: '732829320', legal_address_line1: '10 rue du Test', vat_regime: 'franchise_en_base' })
  })

  it('deleting a required document after completion makes the dossier incomplete again, without touching the already-published legal information', async () => {
    const driverId = await createDriver()
    const useCase = new DriverCompanyProfileUseCases(pool)
    await insertDocument(driverId, 'identity_document')
    await insertDocument(driverId, 'business_registration_document')
    await useCase.save(driverId, completeProfile)

    await pool.query(`update account_documents set replaced_at = now() where driver_id = $1 and document_type = 'identity_document'`, [driverId])
    const afterDelete = await useCase.statusFor(driverId)
    expect(afterDelete.complete).toBe(false)
    expect(afterDelete.missing).toContain('identity_document')

    // The already-published legal information is a separate, deliberately decoupled snapshot — it is not erased.
    const legal = await pool.query('select 1 from driver_legal_information where driver_id = $1', [driverId])
    expect(legal.rowCount).toBe(1)
  })
})
