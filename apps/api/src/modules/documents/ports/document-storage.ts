export const ACCOUNT_DOCUMENTS_BUCKET = 'account-documents'
export interface DocumentStorage { upload(input: { bucketPath: string; content: Buffer; contentType: string }): Promise<void>; createSignedUrl(bucketPath: string, expiresInSeconds: number): Promise<string>; delete(bucketPath: string): Promise<void> }
