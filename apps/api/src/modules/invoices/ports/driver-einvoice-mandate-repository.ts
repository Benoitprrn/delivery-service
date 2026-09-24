export type VatRegime = 'assujetti' | 'franchise_en_base' | 'exonere'

export type DriverEInvoiceMandateSnapshot = {
  firstNameSnapshot: string
  lastNameSnapshot: string
  siren: string
  legalNameSnapshot: string
  nameSnapshot: string
  professionalNameSnapshot: string
  siretSnapshot: string
  legalAddressLine1Snapshot: string
  legalAddressLine2Snapshot: string | null
  legalAddressPostalCodeSnapshot: string
  legalAddressCitySnapshot: string
  legalAddressCountryCodeSnapshot: string
  vatNumberSnapshot: string | null
  vatRegimeSnapshot: VatRegime | null
  legalFormSnapshot: string | null
}

export type ProviderVerificationStatus = 'not_submitted' | 'submitted' | 'not_verified' | 'verified' | 'rejected'

export type CurrentDriverEInvoiceMandate = {
  id: string
  driverId: string
  snapshot: DriverEInvoiceMandateSnapshot
  mandateTemplateVersion: number
  mandateTextHash: string
  acceptedAt: Date
  signedPdfStoragePath: string
  signedPdfSha256: string
  providerVerificationStatus: ProviderVerificationStatus
  submissionStatus: 'prepared' | 'submitting' | 'submitted' | 'retryable' | 'failed' | 'unknown_outcome'
  lastError: string | null
}

export interface DriverEInvoiceMandateRepository {
  findCurrent(driverId: string): Promise<CurrentDriverEInvoiceMandate | null>
  insert(input: { id: string; driverId: string; snapshot: DriverEInvoiceMandateSnapshot; mandateTemplateVersion: number; mandateTextHash: string; acceptedAt: Date; acceptanceEvidence: unknown; signedPdfStoragePath: string; signedPdfSha256: string }): Promise<CurrentDriverEInvoiceMandate>
}
