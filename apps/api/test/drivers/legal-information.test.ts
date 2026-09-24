import { describe, expect, it } from 'vitest'
import { InvalidDriverSiretError, UpdateDriverLegalInformationUseCase, isValidSiret, normalizeSiret, type DriverLegalInformation, type PostalAddress } from '../../src/modules/drivers/application/legal-information.js'
import type { DriverLegalInformationRepository, DriverRepository } from '../../src/modules/drivers/ports/driver-repository.js'
import type { Driver } from '../../src/modules/drivers/domain/driver.js'

const address: PostalAddress = { line1: '10 rue du Test', line2: null, postalCode: '01000', city: 'Bourg-en-Bresse', countryCode: 'FR', communeCode: null }
const driver: Driver = { id: 'driver-1', name: 'Jean-Paul Martin', firstName: 'Jean-Paul', lastName: 'Martin', phone: '0600000000', zoneId: 'zone-1', isAvailable: false }
const command = { professionalName: 'Jean-Paul Martin Livraisons', siret: '73282932000074', legalAddress: address, billingAddress: null, vatNumber: null, vatRegime: null, legalForm: null }

class Drivers implements DriverRepository {
  public async findById() { return driver }
  public async findIdsByZoneId() { return [] }
  public async setPushToken() { return }
  public async findPushTokensByDriverIds() { return [] }
}
class LegalRepository implements DriverLegalInformationRepository {
  public value: DriverLegalInformation | null = null
  public async findLegalInformation() { return this.value }
  public async upsertLegalInformation(value: DriverLegalInformation) { this.value = value; return value }
}

describe('driver legal information', () => {
  it('normalizes and validates a SIRET with the same Luhn check as merchants, without importing across modules', () => {
    expect(normalizeSiret('732 829 320-00074')).toBe('73282932000074')
    expect(isValidSiret('73282932000074')).toBe(true)
    expect(isValidSiret('73282932000075')).toBe(false)
    expect(isValidSiret('123')).toBe(false)
  })

  it('rejects an invalid SIRET before touching the repository', async () => {
    const legal = new LegalRepository()
    await expect(new UpdateDriverLegalInformationUseCase(new Drivers(), legal).execute('driver-1', { ...command, siret: '73282932000075' })).rejects.toBeInstanceOf(InvalidDriverSiretError)
    expect(legal.value).toBeNull()
  })

  it('derives the SIREN from the SIRET server-side and stores it', async () => {
    const legal = new LegalRepository()
    const result = await new UpdateDriverLegalInformationUseCase(new Drivers(), legal).execute('driver-1', command)
    expect(result.siren).toBe('732829320')
    expect(result.driverId).toBe('driver-1')
  })

  it('never infers vatRegime from the presence of a vatNumber — an explicit value or nothing', async () => {
    const legal = new LegalRepository()
    const withVatNumberOnly = await new UpdateDriverLegalInformationUseCase(new Drivers(), legal).execute('driver-1', { ...command, vatNumber: 'FR40732829320' })
    expect(withVatNumberOnly.vatRegime).toBeNull()
    const withExplicitRegime = await new UpdateDriverLegalInformationUseCase(new Drivers(), legal).execute('driver-1', { ...command, vatNumber: 'FR40732829320', vatRegime: 'assujetti' })
    expect(withExplicitRegime.vatRegime).toBe('assujetti')
  })

  it('rejects when the driver profile does not exist', async () => {
    class MissingDrivers implements DriverRepository { public async findById() { return null }; public async findIdsByZoneId() { return [] }; public async setPushToken() { return }; public async findPushTokensByDriverIds() { return [] } }
    await expect(new UpdateDriverLegalInformationUseCase(new MissingDrivers(), new LegalRepository()).execute('unknown', command)).rejects.toThrow()
  })
})
