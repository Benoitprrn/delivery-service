/** Provider boundary: application code never depends on Super PDP's HTTP/OAuth model. */
export type EInvoiceSubmission = { providerDocumentId: string; document: Buffer; contentType: string }
export type EInvoiceEvent = { id: number; invoiceId: string; statusCode: string; statusText: string; createdAt: Date }

/** Transport errors are created only by the HTTP adapter and interpreted by the submission use case. */
export class EInvoiceNetworkBeforeSendError extends Error {}
export class EInvoiceUnknownOutcomeError extends Error {}

export interface EInvoiceProvider {
  submitInvoice(input: { externalId: string; enInvoice: Record<string, unknown> }): Promise<EInvoiceSubmission>
  submitCreditNote(input: { externalId: string; enInvoice: Record<string, unknown> }): Promise<EInvoiceSubmission>
  getStatus(providerDocumentId: string): Promise<Record<string, unknown>>
  listEvents(startingAfterId: number): Promise<{ events: EInvoiceEvent[]; hasAfter: boolean }>
  getDocument(providerDocumentId: string): Promise<{ content: Buffer; contentType: string }>
}
