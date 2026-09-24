import type { DriverEInvoiceMandateSnapshot } from '../ports/driver-einvoice-mandate-repository.js'
import type { DriverLegalInformationSnapshot } from '../ports/driver-legal-information-reader.js'

// JSON stored in acceptance_evidence uses camelCase and is a self-contained proof record.
export type MandateAcceptanceEvidence = { schemaVersion: 1; method: 'mobile_drawn_signature'; acceptedAt: string; signer: { driverId: string; firstName: string; lastName: string }; mandateTemplate: { version: number; textSha256: string }; consentText: string; signaturePngSha256: string; signedPdfSha256: string }
export function legalDataDrift(snapshot: DriverEInvoiceMandateSnapshot, live: DriverLegalInformationSnapshot): { drifted: false } | { drifted: true; changedFields: string[] } {
  const changedFields: string[] = []
  if (snapshot.professionalNameSnapshot !== live.professionalName) changedFields.push('professionalName')
  if (snapshot.siretSnapshot !== live.siret) changedFields.push('siret')
  if (snapshot.siren !== live.siren) changedFields.push('siren')
  if (snapshot.legalAddressLine1Snapshot !== live.legalAddress.line1 || snapshot.legalAddressLine2Snapshot !== live.legalAddress.line2 || snapshot.legalAddressPostalCodeSnapshot !== live.legalAddress.postalCode || snapshot.legalAddressCitySnapshot !== live.legalAddress.city || snapshot.legalAddressCountryCodeSnapshot !== live.legalAddress.countryCode) changedFields.push('legalAddress')
  if (snapshot.vatNumberSnapshot !== live.vatNumber) changedFields.push('vatNumber')
  if (snapshot.vatRegimeSnapshot !== live.vatRegime) changedFields.push('vatRegime')
  if (snapshot.legalFormSnapshot !== live.legalForm) changedFields.push('legalForm')
  return changedFields.length === 0 ? { drifted: false } : { drifted: true, changedFields }
}
