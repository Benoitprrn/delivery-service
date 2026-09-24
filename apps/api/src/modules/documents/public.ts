import type { Pool } from 'pg'
import { DeleteAccountDocumentUseCase, GetAccountDocumentSignedUrlUseCase, UploadAccountDocumentUseCase } from './application/account-documents.js'
import { PostgresAccountDocumentRepository } from './infrastructure/postgres-account-document-repository.js'
import { SupabaseDocumentStorage } from './infrastructure/supabase-document-storage.js'
export { registerAccountDocumentHttpRoutes } from './transport/http/routes.js'
export function createDocumentsModule(pool: Pool, supabaseUrl: string, secret: string | undefined, logger: { warn(value: object, message: string): void }) { const repository = new PostgresAccountDocumentRepository(pool); const storage = new SupabaseDocumentStorage(supabaseUrl, secret); const upload = new UploadAccountDocumentUseCase(repository, storage, logger); const signed = new GetAccountDocumentSignedUrlUseCase(repository, storage); const remove = new DeleteAccountDocumentUseCase(repository, storage, logger); return { upload: upload.execute.bind(upload), list: repository.list.bind(repository), signedUrl: signed.execute.bind(signed), delete: remove.execute.bind(remove) } }
