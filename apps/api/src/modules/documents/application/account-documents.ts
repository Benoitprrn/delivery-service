import { randomUUID } from 'node:crypto'
import type { DocumentStorage } from '../ports/document-storage.js'
export type Owner = { kind: 'driver' | 'merchant'; id: string }
export type DocumentType = 'identity_document' | 'business_registration_document'
export type AccountDocument = { id: string; owner: Owner; documentType: DocumentType; storagePath: string; originalFilename: string | null; contentType: 'application/pdf' | 'image/jpeg' | 'image/png'; sizeBytes: number; uploadedAt: Date }
export interface AccountDocumentRepository { replace(document: AccountDocument): Promise<{ replacedStoragePath: string | null }>; list(owner: Owner): Promise<AccountDocument[]>; findCurrent(owner: Owner, type: DocumentType): Promise<AccountDocument | null>; markReplaced(owner: Owner, type: DocumentType): Promise<AccountDocument | null> }
const types = new Map<string, { bytes: number[]; extension: string }>([['application/pdf', { bytes: [0x25, 0x50, 0x44, 0x46], extension: 'pdf' }], ['image/jpeg', { bytes: [0xff, 0xd8, 0xff], extension: 'jpg' }], ['image/png', { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], extension: 'png' }]])
export function validateDocument(content: Buffer, contentType: string): { contentType: AccountDocument['contentType']; extension: string } { const type = types.get(contentType); if (type === undefined || content.length > 10 * 1024 * 1024 || content.length === 0 || !type.bytes.every((byte, index) => content[index] === byte)) throw new Error('Invalid account document') ; return { contentType: contentType as AccountDocument['contentType'], extension: type.extension } }
export class UploadAccountDocumentUseCase {
  public constructor(private readonly repository: AccountDocumentRepository, private readonly storage: DocumentStorage, private readonly logger: { warn(value: object, message: string): void }) {}
  public async execute(input: { owner: Owner; documentType: DocumentType; content: Buffer; contentType: string; originalFilename: string | null; correlationId: string }): Promise<void> {
    const valid = validateDocument(input.content, input.contentType)
    const id = randomUUID()
    const path = `${input.owner.kind}s/${input.owner.id}/${input.documentType}/${id}.${valid.extension}`
    await this.storage.upload({ bucketPath: path, content: input.content, contentType: valid.contentType })
    let replacedStoragePath: string | null
    try {
      ;({ replacedStoragePath } = await this.repository.replace({ id, owner: input.owner, documentType: input.documentType, storagePath: path, originalFilename: input.originalFilename, contentType: valid.contentType, sizeBytes: input.content.length, uploadedAt: new Date() }))
    } catch (error) {
      try { await this.storage.delete(path) } catch { /* best-effort cleanup of the just-uploaded orphan */ }
      throw error
    }
    // Le nouvel objet est déjà la version courante en base : la suppression de l'ancien
    // objet Storage est best-effort, jamais bloquante pour l'utilisateur (même politique
    // que DeleteAccountDocumentUseCase) — un échec laisse un objet orphelin, journalisé.
    if (replacedStoragePath !== null) {
      try { await this.storage.delete(replacedStoragePath) } catch (error) { this.logger.warn({ err: error, correlationId: input.correlationId }, 'Account document replacement Storage cleanup failed') }
    }
  }
}
export class DeleteAccountDocumentUseCase { public constructor(private readonly repository: AccountDocumentRepository, private readonly storage: DocumentStorage, private readonly logger: { warn(value: object, message: string): void }) {} public async execute(owner: Owner, type: DocumentType, correlationId: string): Promise<void> { const document = await this.repository.markReplaced(owner, type); if (document === null) return; try { await this.storage.delete(document.storagePath) } catch (error) { this.logger.warn({ err: error, correlationId }, 'Account document Storage deletion failed') } } }
export class GetAccountDocumentSignedUrlUseCase { public constructor(private readonly repository: AccountDocumentRepository, private readonly storage: DocumentStorage) {} public async execute(owner: Owner, type: DocumentType): Promise<string | null> { const document = await this.repository.findCurrent(owner, type); return document === null ? null : this.storage.createSignedUrl(document.storagePath, 300) } }
