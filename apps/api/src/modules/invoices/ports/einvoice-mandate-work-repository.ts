export type MandateSubmissionWork = { id: string; driverId: string; grantorSiren: string; grantorLegalName: string; signedPdfStoragePath: string; attempts: number }

export interface EInvoiceMandateWorkRepository {
  claimDue(now: Date, leaseSeconds: number, limit: number): Promise<MandateSubmissionWork[]>
  submitted(input: { id: string; providerMandateId: string; now: Date }): Promise<void>
  retryable(input: { id: string; error: string; retryAt: Date; now: Date }): Promise<void>
  failed(input: { id: string; error: string; now: Date }): Promise<void>
  unknownOutcome(input: { id: string; error: string; now: Date }): Promise<void>
}

export interface EInvoiceMandateVerificationRepository {
  dueForVerification(now: Date, limit: number): Promise<Array<{ id: string; providerMandateId: string }>>
  applyVerification(input: { id: string; verificationStatus: 'verified' | 'not_verified'; now: Date }): Promise<void>
}
