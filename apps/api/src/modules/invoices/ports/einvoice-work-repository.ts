import type { TransmissionInvoice } from '../infrastructure/en16931-mapper.js'

export type SubmissionStatus = 'prepared' | 'submitting' | 'submitted' | 'accepted' | 'rejected' | 'retryable' | 'failed' | 'unknown_outcome'
export type SubmissionWork = { id: string; documentKind: 'invoice' | 'credit_note'; documentId: string; externalId: string; attempts: number; issuerKind: 'driver' | 'locadely'; issuerDriverId: string | null; buyerMerchantId: string; buyerSiren: string; invoice: Omit<TransmissionInvoice, 'buyer'> & { buyer: Omit<TransmissionInvoice['buyer'], 'electronicAddress'> } }
export interface EInvoiceWorkRepository {
  claimDue(now: Date, leaseSeconds: number, limit: number): Promise<SubmissionWork[]>
  submitted(input: { id: string; providerDocumentId: string; contentType: string; sha256: string; now: Date }): Promise<void>
  retryable(input: { id: string; error: string; retryAt: Date; now: Date }): Promise<void>
  failed(input: { id: string; error: string; now: Date }): Promise<void>
  unknownOutcome(input: { id: string; error: string; now: Date }): Promise<void>
}

export interface EInvoiceEventsRepository { cursor(): Promise<number>; applyEvents(input: { events: Array<{ id: number; invoiceId: string; statusCode: string; statusText: string | null; createdAt: Date }>; now: Date }): Promise<void> }
