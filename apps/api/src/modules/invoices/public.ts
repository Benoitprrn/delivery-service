import type { Pool } from 'pg'
import { IssueOrderInvoicesUseCase } from './application/issue-order-invoices.js'
import { CreateCreditNoteUseCase } from './application/create-credit-note.js'
import { GetOrderDocumentsUseCase } from './application/get-order-documents.js'
import { GetInvoiceDocumentFileUseCase } from './application/get-invoice-document-file.js'
import { PostgresInvoiceRepository, InvoiceIssuanceDeferredError } from './infrastructure/postgres-invoice-repository.js'
import { PostgresInvoiceDocumentFileRepository } from './infrastructure/postgres-invoice-document-file-repository.js'
import { PostgresEInvoiceDirectoryCacheRepository } from './infrastructure/postgres-einvoice-directory-cache-repository.js'
export { registerInvoiceHttpRoutes } from './transport/http/routes.js'
export { PostgresInvoiceRepository, InvoiceIssuanceDeferredError }
export { CreateCreditNoteUseCase, GetOrderDocumentsUseCase, GetInvoiceDocumentFileUseCase }
export { PostgresInvoiceDocumentFileRepository } from './infrastructure/postgres-invoice-document-file-repository.js'
export { SuperPdpOAuthClient } from './infrastructure/superpdp-oauth-client.js'
export { SuperPdpEInvoiceProvider } from './infrastructure/superpdp-einvoice-provider.js'
export { SuperPdpFrenchDirectoryProvider } from './infrastructure/superpdp-french-directory-provider.js'
export { SuperPdpEInvoiceMandateProvider } from './infrastructure/superpdp-einvoice-mandate-provider.js'
export { PostgresEInvoiceWorkRepository, PostgresEInvoiceEventsRepository } from './infrastructure/postgres-einvoice-work-repository.js'
export { PostgresEInvoiceMandateWorkRepository } from './infrastructure/postgres-einvoice-mandate-work-repository.js'
export { PostgresDriverEInvoiceReadinessReader } from './infrastructure/postgres-driver-einvoice-readiness-reader.js'
export { startEInvoiceSubmissionWorker, startEInvoicePollingWorker, startEInvoiceMandateSubmissionWorker, startEInvoiceMandatePollingWorker } from './infrastructure/einvoice-workers.js'
export { RunEInvoiceSubmissionsUseCase } from './application/run-einvoice-submissions.js'
export { RunEInvoiceMandateSubmissionsUseCase } from './application/run-einvoice-mandate-submissions.js'
export { RefreshBuyerElectronicAddressUseCase } from './application/resolve-buyer-electronic-address.js'
export { PostgresEInvoiceDirectoryCacheRepository }
export { selectBuyerDirectoryEntry } from './domain/directory-selection.js'
export { canSubmitElectronicInvoice } from './domain/transmission-readiness.js'
export { PollEInvoiceEventsUseCase } from './application/poll-einvoice-events.js'
export { PollEInvoiceMandatesUseCase } from './application/poll-einvoice-mandates.js'
export { mapToEnInvoice, projectSubmissionStatus, CREDIT_NOTE_TYPE_CODE } from './infrastructure/en16931-mapper.js'
export { DriverEInvoiceReadiness } from './application/driver-einvoice-readiness.js'
export { AcceptDriverEInvoiceMandateUseCase, DriverLegalInformationRequiredError, InvalidMandateAcceptanceError, MandateTemplateNotConfiguredError, MandateTemplateIntegrityError, PlatformLegalIdentityRequiredError } from './application/accept-driver-einvoice-mandate.js'
export { GetDriverEInvoiceMandateStatusUseCase } from './application/get-driver-einvoice-mandate-status.js'
export { GetDriverEInvoiceMandatePdfUrlUseCase } from './application/get-driver-einvoice-mandate-pdf-url.js'
export { PostgresDriverEInvoiceMandateRepository, DriverEInvoiceMandateAlreadyExistsError } from './infrastructure/postgres-driver-einvoice-mandate-repository.js'
export { PostgresMandateTemplateRepository } from './infrastructure/postgres-mandate-template-repository.js'
export { PostgresPlatformLegalIdentityReader } from './infrastructure/postgres-platform-legal-identity-reader.js'
export { PdfLibMandatePdfRenderer } from './infrastructure/pdf-lib-mandate-pdf-renderer.js'
export { SupabaseEInvoiceMandateStorage } from './infrastructure/supabase-einvoice-mandate-storage.js'
export { SupabaseEInvoiceDocumentStorage } from './infrastructure/supabase-einvoice-document-storage.js'
export { legalDataDrift } from './domain/mandate-acceptance.js'
export { hasValidMandateTemplateHash } from './domain/mandate-template.js'
export type { EInvoiceProvider } from './ports/einvoice-provider.js'
export type { FrenchDirectoryEntry, DirectoryResolution } from './domain/directory-selection.js'
export type { TransmissionReadiness } from './domain/transmission-readiness.js'
export type { BuyerElectronicAddressResolver } from './application/resolve-buyer-electronic-address.js'
export type { EInvoiceMandateProvider } from './ports/einvoice-mandate-provider.js'
export type { DriverEInvoiceMandateRepository, DriverEInvoiceMandateSnapshot, CurrentDriverEInvoiceMandate } from './ports/driver-einvoice-mandate-repository.js'
export type { MandateTemplateRepository, MandateTemplate } from './ports/mandate-template-repository.js'
export type { GetOrderDocumentsCommand } from './application/get-order-documents.js'
export type { GetInvoiceDocumentFileCommand, InvoiceDocumentFileRepository } from './ports/invoice-document-file-repository.js'
export type { EInvoiceDocumentStorage } from './ports/einvoice-document-storage.js'
export type { InvoiceRepository, InvoiceDocument, CreditNoteDocument, OrderDocuments } from './ports/invoice-repository.js'
export function createInvoicesModule(pool: Pool, electronicAddressScheme: string) {
  const repository = new PostgresInvoiceRepository(pool, electronicAddressScheme)
  const issue = new IssueOrderInvoicesUseCase(repository)
  const createCreditNote = new CreateCreditNoteUseCase(repository)
  const getOrderDocuments = new GetOrderDocumentsUseCase(repository)
  const documentFiles = new PostgresInvoiceDocumentFileRepository(pool)
  const directoryCache = new PostgresEInvoiceDirectoryCacheRepository(pool)
  return {
    issueForCompletedOrder: issue.execute.bind(issue),
    createCreditNote: createCreditNote.execute.bind(createCreditNote),
    getOrderDocuments: getOrderDocuments.execute.bind(getOrderDocuments),
    documentFiles,
    getElectronicInvoicingStatus: async (merchantId: string) => {
      const entry = await directoryCache.read(merchantId)
      return entry === null ? 'unknown' as const : entry.resolution.status === 'ready' ? 'available' as const : 'unavailable' as const
    }
  }
}
