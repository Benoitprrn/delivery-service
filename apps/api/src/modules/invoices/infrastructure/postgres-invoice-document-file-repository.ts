import type { Pool } from 'pg'
import type { AuthorizedInvoiceDocumentFile, GetInvoiceDocumentFileCommand, InvoiceDocumentFileRepository } from '../ports/invoice-document-file-repository.js'

type DocumentRow = { id: string; transmission_status: string; submission_id: string | null; provider_document_id: string | null; document_storage_path: string | null }

export class PostgresInvoiceDocumentFileRepository implements InvoiceDocumentFileRepository {
  public constructor(private readonly pool: Pool) {}

  public async findAuthorized(command: GetInvoiceDocumentFileCommand): Promise<AuthorizedInvoiceDocumentFile | null> {
    const actorId = command.role === 'merchant' ? command.merchantId : command.driverId
    const access = await this.pool.query(
      command.role === 'merchant'
        ? 'select 1 from orders where id = $1 and merchant_id = $2'
        : 'select 1 from orders where id = $1 and driver_id = $2',
      [command.orderId, actorId]
    )
    if (access.rowCount !== 1) return null

    const row = command.documentKind === 'invoice'
      ? (await this.pool.query<DocumentRow>(
          `select i.id, i.transmission_status, s.id as submission_id, s.provider_document_id, s.document_storage_path
           from invoices i left join invoice_provider_submissions s on s.invoice_id = i.id and s.provider = 'superpdp'
           where i.id = $1 and i.order_id = $2${command.role === 'driver' ? ' and i.issuer_driver_id = $3' : ''}`,
          command.role === 'driver' ? [command.documentId, command.orderId, command.driverId] : [command.documentId, command.orderId]
        )).rows[0]
      : (await this.pool.query<DocumentRow>(
          `select cn.id, cn.transmission_status, s.id as submission_id, s.provider_document_id, s.document_storage_path
           from credit_notes cn join invoices i on i.id = cn.original_invoice_id
           left join invoice_provider_submissions s on s.credit_note_id = cn.id and s.provider = 'superpdp'
           where cn.id = $1 and cn.order_id = $2${command.role === 'driver' ? ' and i.issuer_driver_id = $3' : ''}`,
          command.role === 'driver' ? [command.documentId, command.orderId, command.driverId] : [command.documentId, command.orderId]
        )).rows[0]
    if (row === undefined) return null
    return { id: row.id, kind: command.documentKind, transmissionStatus: row.transmission_status, submissionId: row.submission_id, providerDocumentId: row.provider_document_id, documentStoragePath: row.document_storage_path }
  }

  public async cacheDocument(input: { submissionId: string; path: string; contentType: string; sha256: string }): Promise<void> {
    await this.pool.query(
      'update invoice_provider_submissions set document_storage_path = $1, document_content_type = $2, document_sha256 = $3 where id = $4',
      [input.path, input.contentType, input.sha256, input.submissionId]
    )
  }
}
