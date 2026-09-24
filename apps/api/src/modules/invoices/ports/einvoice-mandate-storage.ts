export interface EInvoiceMandateStorage {
  uploadMandatePdf(input: { driverId: string; mandateId: string; content: Buffer }): Promise<string>
  downloadMandatePdf(bucketPath: string): Promise<Buffer>
  createSignedMandatePdfUrl(bucketPath: string, expiresInSeconds?: number): Promise<string>
}
