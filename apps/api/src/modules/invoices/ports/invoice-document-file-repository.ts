export type GetInvoiceDocumentFileCommand =
  | { role: 'merchant'; orderId: string; merchantId: string; documentKind: 'invoice' | 'credit_note'; documentId: string }
  | { role: 'driver'; orderId: string; driverId: string; documentKind: 'invoice' | 'credit_note'; documentId: string }

export type AuthorizedInvoiceDocumentFile = {
  id: string
  kind: 'invoice' | 'credit_note'
  transmissionStatus: string
  submissionId: string | null
  providerDocumentId: string | null
  documentStoragePath: string | null
}

export interface InvoiceDocumentFileRepository {
  findAuthorized(command: GetInvoiceDocumentFileCommand): Promise<AuthorizedInvoiceDocumentFile | null>
  cacheDocument(input: { submissionId: string; path: string; contentType: string; sha256: string }): Promise<void>
}
