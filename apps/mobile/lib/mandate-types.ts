// Miroir de la réponse GET /api/v1/drivers/me/einvoice-mandate côté apps/api — voir
// apps/api/src/modules/invoices/application/get-driver-einvoice-mandate-status.ts.
export type MandateProviderVerificationStatus = 'not_submitted' | 'submitted' | 'not_verified' | 'verified' | 'rejected';
export type MandateSubmissionStatus = 'prepared' | 'submitting' | 'submitted' | 'retryable' | 'failed' | 'unknown_outcome';
export type MandateBlockedReason = 'legal_information_missing' | 'driver_name_missing' | 'template_not_configured' | 'platform_identity_missing';
export type MandateDrift = { drifted: false } | { drifted: true; changedFields: string[] };

export type MandateStatus = {
  mandateExists: boolean;
  providerVerificationStatus: MandateProviderVerificationStatus | null;
  submissionStatus: MandateSubmissionStatus | null;
  lastError: string | null;
  drift: MandateDrift | null;
  template: { text: string; version: number } | null;
  liveLegalInformation: unknown;
  blockedReason: MandateBlockedReason | null;
  previewText: string | null;
};

export type SignedMandate = {
  id: string;
  driverId: string;
  providerVerificationStatus: MandateProviderVerificationStatus;
};
