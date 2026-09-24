import { describe, expect, it, vi } from 'vitest'
import { GetInvoiceDocumentFileUseCase } from '../../src/modules/invoices/application/get-invoice-document-file.js'
import type { AuthorizedInvoiceDocumentFile, GetInvoiceDocumentFileCommand, InvoiceDocumentFileRepository } from '../../src/modules/invoices/ports/invoice-document-file-repository.js'

const command: GetInvoiceDocumentFileCommand = { role: 'driver', orderId: 'order', driverId: 'driver-a', documentKind: 'invoice', documentId: 'invoice' }
const confirmed = (overrides: Partial<AuthorizedInvoiceDocumentFile> = {}): AuthorizedInvoiceDocumentFile => ({ id: 'invoice', kind: 'invoice', transmissionStatus: 'confirmed', submissionId: 'submission', providerDocumentId: 'provider-document', documentStoragePath: null, ...overrides })

function setup(document: AuthorizedInvoiceDocumentFile | null) {
  const repository: InvoiceDocumentFileRepository = { findAuthorized: vi.fn().mockResolvedValue(document), cacheDocument: vi.fn() }
  const provider = { getDocument: vi.fn().mockResolvedValue({ content: Buffer.from('factur-x'), contentType: 'application/pdf' }) }
  const storage = { uploadDocument: vi.fn(), createSignedDocumentUrl: vi.fn().mockResolvedValue('https://storage.test/signed') }
  return { repository, provider, storage, useCase: new GetInvoiceDocumentFileUseCase(repository, provider as never, storage) }
}

describe('GetInvoiceDocumentFileUseCase', () => {
  it('returns not_found for a wrong order, role, tenant, or cross-driver credit note', async () => {
    for (const input of [command, { ...command, orderId: 'wrong-order' }, { ...command, driverId: 'wrong-driver' }, { ...command, role: 'merchant' as const, merchantId: 'wrong-merchant' }, { ...command, documentKind: 'credit_note' as const, documentId: 'credit-other-driver' }]) {
      const { useCase } = setup(null)
      await expect(useCase.execute(input as GetInvoiceDocumentFileCommand)).resolves.toEqual({ status: 'not_found' })
    }
  })

  it.each(['not_submitted', 'rejected'])('does not retrieve a %s document', async (transmissionStatus) => {
    const { useCase, provider, storage } = setup(confirmed({ transmissionStatus }))
    await expect(useCase.execute(command)).resolves.toEqual({ status: 'not_available' })
    expect(provider.getDocument).not.toHaveBeenCalled()
    expect(storage.uploadDocument).not.toHaveBeenCalled()
  })

  it('signs the cached Factur-X without calling the provider', async () => {
    const { useCase, provider, repository, storage } = setup(confirmed({ documentStoragePath: 'invoices/invoice/factur-x.pdf' }))
    await expect(useCase.execute(command)).resolves.toEqual({ status: 'ready', signedUrl: 'https://storage.test/signed' })
    expect(provider.getDocument).not.toHaveBeenCalled()
    expect(repository.cacheDocument).not.toHaveBeenCalled()
    expect(storage.createSignedDocumentUrl).toHaveBeenCalledWith('invoices/invoice/factur-x.pdf')
  })

  it('retrieves, caches, hashes, and signs a confirmed uncached Factur-X', async () => {
    const { useCase, provider, repository, storage } = setup(confirmed())
    await expect(useCase.execute(command)).resolves.toEqual({ status: 'ready', signedUrl: 'https://storage.test/signed' })
    expect(provider.getDocument).toHaveBeenCalledTimes(1)
    expect(storage.uploadDocument).toHaveBeenCalledWith({ path: 'invoices/invoice/factur-x.pdf', content: Buffer.from('factur-x'), contentType: 'application/pdf' })
    expect(repository.cacheDocument).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'submission', path: 'invoices/invoice/factur-x.pdf', contentType: 'application/pdf', sha256: 'd1849fe65acc6c14cb1ea0c0070805d4d3459abfe210bbf8c9f787e37ac11e15' }))
    expect(storage.createSignedDocumentUrl).toHaveBeenCalledWith('invoices/invoice/factur-x.pdf')
  })
})
