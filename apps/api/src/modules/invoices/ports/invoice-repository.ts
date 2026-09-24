export type InvoiceDocument = {
  id: string
  number: string
  issuerKind: 'driver' | 'locadely'
  invoiceTypeCode: '380' | '389'
  issuedAt: Date
  totalHtCents: number
  totalVatCents: number
  totalTtcCents: number
  transmissionStatus: string
  submissionStatus: 'prepared' | 'submitting' | 'submitted' | 'accepted' | 'rejected' | 'retryable' | 'failed' | 'unknown_outcome'
  lastError: string | null
  facturXAvailable: boolean
}

export type CreditNoteDocument = {
  id: string
  number: string
  originalInvoiceNumber: string
  issuedAt: Date
  totalHtCents: number
  totalVatCents: number
  totalTtcCents: number
  transmissionStatus: string
  submissionStatus: 'prepared' | 'submitting' | 'submitted' | 'accepted' | 'rejected' | 'retryable' | 'failed' | 'unknown_outcome'
  lastError: string | null
  facturXAvailable: boolean
}

export type OrderDocuments = { invoices: InvoiceDocument[]; creditNotes: CreditNoteDocument[] }

export interface InvoiceRepository {
  issueForCompletedOrder(orderId: string): Promise<'issued' | 'already_issued' | 'legacy_or_not_completed'>
  listForMerchantOrder(orderId: string, merchantId: string): Promise<OrderDocuments | null>
  listForDriverOrder(orderId: string, driverId: string): Promise<OrderDocuments | null>
  createCreditNote(input: { originalInvoiceLineId: string; decisionReference: string; decisionReason: string; lineHtCents: number }): Promise<CreditNoteDocument>
}
