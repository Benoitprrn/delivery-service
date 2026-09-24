import { describe, expect, it, vi } from 'vitest'
import { DeleteAccountDocumentUseCase, GetAccountDocumentSignedUrlUseCase, UploadAccountDocumentUseCase, validateDocument, type AccountDocument, type AccountDocumentRepository, type Owner } from '../../src/modules/documents/application/account-documents.js'
import type { DocumentStorage } from '../../src/modules/documents/ports/document-storage.js'

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
const driver: Owner = { kind: 'driver', id: 'driver-1' }

describe('validateDocument — binary signature, not just the declared content-type', () => {
  it('accepts a real PDF/JPEG/PNG whose bytes match the declared type', () => {
    expect(validateDocument(PDF, 'application/pdf').extension).toBe('pdf')
    expect(validateDocument(JPEG, 'image/jpeg').extension).toBe('jpg')
    expect(validateDocument(PNG, 'image/png').extension).toBe('png')
  })

  it('rejects a mismatched signature even when the declared content-type is allowed', () => {
    expect(() => validateDocument(PDF, 'image/jpeg')).toThrow()
    expect(() => validateDocument(JPEG, 'application/pdf')).toThrow()
  })

  it('rejects a content-type outside the allowlist', () => {
    expect(() => validateDocument(PDF, 'image/gif')).toThrow()
  })

  it('rejects an oversized file', () => {
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])
    expect(() => validateDocument(big, 'application/pdf')).toThrow()
  })

  it('rejects an empty file', () => {
    expect(() => validateDocument(Buffer.alloc(0), 'application/pdf')).toThrow()
  })
})

class FakeRepository implements AccountDocumentRepository {
  public current: AccountDocument | null = null
  public async replace(document: AccountDocument) {
    const replacedStoragePath = this.current?.storagePath ?? null
    this.current = document
    return { replacedStoragePath }
  }
  public async list(_owner: Owner) { return this.current === null ? [] : [this.current] }
  public async findCurrent(_owner: Owner, _type: AccountDocument['documentType']) { return this.current }
  public async markReplaced() { const doc = this.current; this.current = null; return doc }
}

function fakeStorage(): DocumentStorage & { uploaded: string[]; deleted: string[] } {
  return {
    uploaded: [], deleted: [],
    async upload(input) { this.uploaded.push(input.bucketPath) },
    async createSignedUrl(path) { return `https://signed.example/${path}` },
    async delete(path) { this.deleted.push(path) }
  }
}

describe('UploadAccountDocumentUseCase — replacement never leaves an orphan Storage object', () => {
  it('deletes the previous Storage object after a successful replacement', async () => {
    const repository = new FakeRepository()
    const storage = fakeStorage()
    const logger = { warn: vi.fn() }
    const useCase = new UploadAccountDocumentUseCase(repository, storage, logger)

    await useCase.execute({ owner: driver, documentType: 'identity_document', content: JPEG, contentType: 'image/jpeg', originalFilename: 'cni.jpg', correlationId: 'c1' })
    const firstPath = repository.current!.storagePath
    expect(storage.uploaded).toEqual([firstPath])

    await useCase.execute({ owner: driver, documentType: 'identity_document', content: PNG, contentType: 'image/png', originalFilename: 'cni.png', correlationId: 'c2' })
    expect(storage.deleted).toEqual([firstPath])
    expect(repository.current!.storagePath).not.toBe(firstPath)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs a warning instead of failing the request when the old object cannot be deleted', async () => {
    const repository = new FakeRepository()
    const storage = fakeStorage()
    storage.delete = async () => { throw new Error('boom') }
    const logger = { warn: vi.fn() }
    const useCase = new UploadAccountDocumentUseCase(repository, storage, logger)

    await useCase.execute({ owner: driver, documentType: 'identity_document', content: JPEG, contentType: 'image/jpeg', originalFilename: null, correlationId: 'c1' })
    await expect(useCase.execute({ owner: driver, documentType: 'identity_document', content: PNG, contentType: 'image/png', originalFilename: null, correlationId: 'c2' })).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid document before ever calling Storage', async () => {
    const repository = new FakeRepository()
    const storage = fakeStorage()
    const useCase = new UploadAccountDocumentUseCase(repository, storage, { warn: vi.fn() })
    await expect(useCase.execute({ owner: driver, documentType: 'identity_document', content: JPEG, contentType: 'application/pdf', originalFilename: null, correlationId: 'c1' })).rejects.toThrow()
    expect(storage.uploaded).toEqual([])
  })
})

describe('GetAccountDocumentSignedUrlUseCase', () => {
  it('returns null instead of a signed URL when there is no current document', async () => {
    const repository = new FakeRepository()
    const useCase = new GetAccountDocumentSignedUrlUseCase(repository, fakeStorage())
    expect(await useCase.execute(driver, 'identity_document')).toBeNull()
  })
})

describe('DeleteAccountDocumentUseCase', () => {
  it('is a no-op when there is nothing to delete', async () => {
    const repository = new FakeRepository()
    const storage = fakeStorage()
    await new DeleteAccountDocumentUseCase(repository, storage, { warn: vi.fn() }).execute(driver, 'identity_document', 'c1')
    expect(storage.deleted).toEqual([])
  })
})
