import type { VatRegime } from './driver-einvoice-mandate-repository.js'
export type DriverLegalInformationSnapshot = { professionalName: string; siret: string; siren: string; legalAddress: { line1: string; line2: string | null; postalCode: string; city: string; countryCode: string }; vatNumber: string | null; vatRegime: VatRegime | null; legalForm: string | null }
export interface DriverLegalInformationReader { findDriverLegalInformation(driverId: string): Promise<DriverLegalInformationSnapshot | null> }
