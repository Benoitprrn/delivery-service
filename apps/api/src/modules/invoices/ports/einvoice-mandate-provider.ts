export type EInvoiceMandate = { id: string; verificationStatus: 'verified' | 'not_verified' }

export interface EInvoiceMandateProvider {
  // `grantorNumberScheme` optionnel, défaut 'fr_siren' (production, vrai SIREN livreur) — un
  // appelant sandbox/test peut passer 'sandbox' explicitement (jamais deviné par le provider).
  createMandate(input: { grantorNumber: string; grantorNumberScheme?: 'fr_siren' | 'sandbox'; grantorLegalName: string; pdf: Buffer }): Promise<EInvoiceMandate>
  getMandate(providerMandateId: string): Promise<EInvoiceMandate>
  downloadMandate(providerMandateId: string): Promise<Buffer>
}
