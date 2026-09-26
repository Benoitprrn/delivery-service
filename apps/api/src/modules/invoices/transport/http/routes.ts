import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { GetOrderDocumentsCommand } from '../../application/get-order-documents.js'
import type { GetInvoiceDocumentFileResult } from '../../application/get-invoice-document-file.js'
import type { GetInvoiceDocumentFileCommand } from '../../ports/invoice-document-file-repository.js'
import type { DriverInvoiceListItem, OrderDocuments } from '../../ports/invoice-repository.js'
import type { CurrentDriverEInvoiceMandate } from '../../ports/driver-einvoice-mandate-repository.js'
import { DriverLegalInformationRequiredError, InvalidMandateAcceptanceError, MandateTemplateIntegrityError, MandateTemplateNotConfiguredError, PlatformLegalIdentityRequiredError } from '../../application/accept-driver-einvoice-mandate.js'

const params = z.object({ id: z.string().uuid() }).strict()
const documentParams = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).strict()
const facturXQuery = z.object({ kind: z.enum(['invoice', 'credit_note']) }).strict()

const mandateBody = z.object({ signatureImageBase64: z.string().min(1), signerFirstName: z.string().trim().min(1), signerLastName: z.string().trim().min(1) }).strict()
type MandateStatus = { mandateExists: boolean; providerVerificationStatus: string | null; submissionStatus: 'prepared' | 'submitting' | 'submitted' | 'retryable' | 'failed' | 'unknown_outcome' | null; lastError: string | null; drift: unknown; template: { text: string; version: number } | null; liveLegalInformation: unknown; blockedReason: 'legal_information_missing' | 'driver_name_missing' | 'template_not_configured' | 'platform_identity_missing' | null; previewText: string | null }
export const registerInvoiceHttpRoutes: FastifyPluginAsync<{
  getOrderDocuments: (command: GetOrderDocumentsCommand) => Promise<OrderDocuments | null>
  getDriverInvoices: (driverId: string) => Promise<DriverInvoiceListItem[]>
  getInvoiceDocumentFile: (command: GetInvoiceDocumentFileCommand) => Promise<GetInvoiceDocumentFileResult>
  getDriverEInvoiceMandateStatus: (driverId: string) => Promise<MandateStatus>
  acceptDriverEInvoiceMandate: (input: { driverId: string; signatureImageBase64: string; signerFirstName: string; signerLastName: string }) => Promise<CurrentDriverEInvoiceMandate>
  getDriverEInvoiceMandatePdfUrl: (driverId: string) => Promise<string | null>
}> = async (app, options) => {
  app.get('/api/v1/orders/:id/documents', async (request, reply) => {
    const { id } = params.parse(request.params)
    if (request.authUser?.role === 'merchant') {
      const documents = await options.getOrderDocuments({ role: 'merchant', orderId: id, merchantId: request.authUser.id })
      return documents === null ? reply.code(404).send({ error: 'OrderNotFound' }) : reply.send(documents)
    }
    if (request.authUser?.role === 'driver') {
      const documents = await options.getOrderDocuments({ role: 'driver', orderId: id, driverId: request.authUser.id })
      return documents === null ? reply.code(404).send({ error: 'OrderNotFound' }) : reply.send(documents)
    }
    return reply.code(403).send({ error: 'ForbiddenError', message: 'Only merchants and drivers can access documents' })
  })
  app.get('/api/v1/orders/:id/documents/:documentId/factur-x', async (request, reply) => {
    try {
      const { id, documentId } = documentParams.parse(request.params)
      const { kind } = facturXQuery.parse(request.query)
      const result = request.authUser?.role === 'merchant'
        ? await options.getInvoiceDocumentFile({ role: 'merchant', orderId: id, merchantId: request.authUser.id, documentKind: kind, documentId })
        : request.authUser?.role === 'driver'
          ? await options.getInvoiceDocumentFile({ role: 'driver', orderId: id, driverId: request.authUser.id, documentKind: kind, documentId })
          : null
      if (result === null) return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
      if (result.status === 'not_found') return reply.code(404).send({ error: 'DocumentNotFound', correlationId: request.correlationId })
      if (result.status === 'not_available') return reply.code(409).send({ error: 'DocumentNotAvailable', correlationId: request.correlationId })
      return reply.send({ url: result.signedUrl })
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'ValidationError', correlationId: request.correlationId })
      throw error
    }
  })
  app.get('/api/v1/drivers/me/invoices', async (request, reply) => {
    if (request.authUser?.role !== 'driver') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
    return reply.send({ invoices: await options.getDriverInvoices(request.authUser.id) })
  })
  app.get('/api/v1/drivers/me/einvoice-mandate', async (request, reply) => {
    if (request.authUser?.role !== 'driver') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
    return reply.send(await options.getDriverEInvoiceMandateStatus(request.authUser.id))
  })
  app.post('/api/v1/drivers/me/einvoice-mandate', async (request, reply) => {
    try {
      if (request.authUser?.role !== 'driver') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
      const body = mandateBody.parse(request.body)
      return reply.code(201).send(await options.acceptDriverEInvoiceMandate({ driverId: request.authUser.id, ...body }))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof InvalidMandateAcceptanceError) return reply.code(400).send({ error: 'ValidationError', correlationId: request.correlationId })
      if (error instanceof DriverLegalInformationRequiredError || error instanceof PlatformLegalIdentityRequiredError) return reply.code(422).send({ error: error.name, correlationId: request.correlationId })
      if (error instanceof MandateTemplateNotConfiguredError || error instanceof MandateTemplateIntegrityError) return reply.code(503).send({ error: error.name, correlationId: request.correlationId })
      request.log.error({ err: error }, 'Driver electronic invoice mandate acceptance failed')
      return reply.code(500).send({ error: 'InternalServerError', correlationId: request.correlationId })
    }
  })
  app.get('/api/v1/drivers/me/einvoice-mandate/pdf-url', async (request, reply) => {
    if (request.authUser?.role !== 'driver') return reply.code(403).send({ error: 'ForbiddenError', correlationId: request.correlationId })
    const url = await options.getDriverEInvoiceMandatePdfUrl(request.authUser.id)
    return url === null ? reply.code(404).send({ error: 'MandateNotFound', correlationId: request.correlationId }) : reply.send({ url })
  })
}
