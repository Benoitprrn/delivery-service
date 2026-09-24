import type { DriverLegalInformationRepository, DriverRepository } from '../ports/driver-repository.js'

export type PostalAddress = { line1: string; line2: string | null; postalCode: string; city: string; countryCode: string; communeCode: string | null }

export function normalizeSiret(value: string): string { return value.replace(/[\s.-]/g, '') }
export function isValidSiret(value: string): boolean { if (!/^\d{14}$/.test(value)) return false; let sum = 0; for (let i = 0; i < 14; i += 1) { let n = Number(value[i]); if (i % 2 === 0) n *= 2; sum += n > 9 ? n - 9 : n } return sum % 10 === 0 }
export class InvalidDriverSiretError extends Error { public constructor() { super('SIRET must contain 14 valid digits'); this.name = 'InvalidDriverSiretError' } }
export type DriverLegalInformation = { driverId: string; professionalName: string; siret: string; siren: string; legalAddress: PostalAddress; billingAddress: PostalAddress | null; vatNumber: string | null; vatRegime: 'assujetti' | 'franchise_en_base' | 'exonere' | null; legalForm: string | null }
export type UpdateLegalCommand = Omit<DriverLegalInformation, 'driverId' | 'siren'>
export class UpdateDriverLegalInformationUseCase {
  public constructor(private readonly drivers: DriverRepository, private readonly legal: DriverLegalInformationRepository) {}
  public async execute(driverId: string, command: UpdateLegalCommand): Promise<DriverLegalInformation> {
    if (await this.drivers.findById(driverId) === null) throw new Error('Driver profile was not found')
    const siret = normalizeSiret(command.siret)
    if (!isValidSiret(siret)) throw new InvalidDriverSiretError()
    return this.legal.upsertLegalInformation({ ...command, driverId, siret, siren: siret.slice(0, 9) })
  }
}
