export interface EInvoiceDocumentStorage {
  uploadDocument(input: { path: string; content: Buffer; contentType: string }): Promise<void>
  createSignedDocumentUrl(path: string, expiresInSeconds?: number): Promise<string>
}
