import { createHash } from 'node:crypto'
import type { EInvoiceProvider } from '../ports/einvoice-provider.js'
import type { EInvoiceDocumentStorage } from '../ports/einvoice-document-storage.js'
import type { GetInvoiceDocumentFileCommand, InvoiceDocumentFileRepository } from '../ports/invoice-document-file-repository.js'

export type GetInvoiceDocumentFileResult = { status: 'not_found' } | { status: 'not_available' } | { status: 'ready'; signedUrl: string }

export class GetInvoiceDocumentFileUseCase {
  public constructor(private readonly repository: InvoiceDocumentFileRepository, private readonly provider: EInvoiceProvider | null, private readonly storage: EInvoiceDocumentStorage) {}

  public async execute(command: GetInvoiceDocumentFileCommand): Promise<GetInvoiceDocumentFileResult> {
    const document = await this.repository.findAuthorized(command)
    if (document === null) return { status: 'not_found' }
    if (document.transmissionStatus !== 'confirmed') return { status: 'not_available' }
    if (document.documentStoragePath !== null) return { status: 'ready', signedUrl: await this.storage.createSignedDocumentUrl(document.documentStoragePath) }
    if (document.submissionId === null || document.providerDocumentId === null || this.provider === null) return { status: 'not_available' }

    const file = await this.provider.getDocument(document.providerDocumentId)
    const path = document.kind === 'invoice' ? `invoices/${document.id}/factur-x.pdf` : `credit-notes/${document.id}/factur-x.pdf`
    await this.storage.uploadDocument({ path, content: file.content, contentType: file.contentType })
    await this.repository.cacheDocument({ submissionId: document.submissionId, path, contentType: file.contentType, sha256: createHash('sha256').update(file.content).digest('hex') })
    return { status: 'ready', signedUrl: await this.storage.createSignedDocumentUrl(path) }
  }
}
