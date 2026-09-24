import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { AccountAlreadyExistsError, AuthProviderError } from '../../../auth/public.js'
import type { GetMerchantUseCase } from '../../application/get-merchant.js'
import type { LookupMerchantLegalInformationUseCase, UpdateMerchantLegalInformationUseCase } from '../../application/legal-information.js'
import type { ProvisionMerchantUseCase } from '../../application/provision-merchant.js'
import type { UpdateMerchantInformationUseCase } from '../../application/update-merchant-information.js'
import type { UploadMerchantLogoUseCase } from '../../application/upload-merchant-logo.js'
import { mapErrorToHttp } from './error-handler.js'
import { AmbiguousMerchantZoneError, MerchantProvisioningError } from '../../domain/errors.js'
import { isMerchantInformationComplete, type Merchant } from '../../domain/merchant.js'
import type { MerchantLegalInformation } from '../../ports/merchant-repository.js'
import type { MerchantAccountContact } from '../../application/account-contact.js'
import type { ElectronicInvoicingStatus } from '../../ports/electronic-invoicing-status-reader.js'
import { merchantSignupBodySchema, sireneLookupBodySchema, updateLegalInformationBodySchema, updateMerchantAccountContactBodySchema, updateMerchantBodySchema } from './schemas.js'
import { isMerchantLegalInformationComplete } from '../../application/legal-information.js'

type MerchantsHttpRoutesOptions = {
  merchants: {
    getMerchant: GetMerchantUseCase['execute']
    updateMerchantInformation: UpdateMerchantInformationUseCase['execute']
    uploadLogo: UploadMerchantLogoUseCase['execute']
    provisionMerchant: ProvisionMerchantUseCase['execute']
    getLegalInformation(merchantId: string): Promise<MerchantLegalInformation | null>
    lookupLegalInformation: LookupMerchantLegalInformationUseCase['execute']
    updateLegalInformation: UpdateMerchantLegalInformationUseCase['execute']
    getElectronicInvoicingStatus(merchantId: string): Promise<ElectronicInvoicingStatus>
    getAccountContact(merchantId: string): Promise<MerchantAccountContact | null>
    updateAccountContact(merchantId: string, contact: MerchantAccountContact): Promise<MerchantAccountContact>
  }
}

function sendMappedError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AmbiguousMerchantZoneError) {
    request.log.error({ point: error.point, zones: error.zones }, 'Merchant address matches multiple zones')
  }
  const { statusCode, body } = mapErrorToHttp(error, request.correlationId)
  request.log.error({ err: error, statusCode }, 'HTTP request failed')
  return reply.code(statusCode).send(body)
}

function sendForbidden(reply: FastifyReply, correlationId: string): FastifyReply {
  return reply.code(403).send({
    error: 'ForbiddenError',
    message: 'Only merchants can access this resource',
    correlationId
  })
}

function merchantResponse(merchant: Merchant) {
  return {
    name: merchant.name,
    phonePrimary: merchant.phonePrimary,
    phoneSecondary: merchant.phoneSecondary,
    logoUrl: merchant.logoUrl,
    address: merchant.address,
    lat: merchant.lat,
    lng: merchant.lng,
    zoneId: merchant.zoneId,
    merchantInformationCompleted: isMerchantInformationComplete(merchant),
    onboardingCompleted: merchant.onboardingCompleted
  }
}

function sendSignupError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const correlationId = request.correlationId
  if (error instanceof ZodError) return reply.code(400).send({ error: 'ValidationError', message: 'Request validation failed', correlationId })
  if (error instanceof AccountAlreadyExistsError) return reply.code(409).send({ error: error.name, message: error.message, correlationId })
  if (error instanceof AuthProviderError) return reply.code(502).send({ error: error.name, message: error.message, correlationId })
  if (error instanceof MerchantProvisioningError) return reply.code(500).send({ error: error.name, message: error.message, correlationId })
  request.log.error({ err: error }, 'HTTP request failed')
  return reply.code(500).send({ error: 'InternalServerError', message: 'An unexpected error occurred', correlationId })
}

export async function registerMerchantHttpRoutes(
  app: FastifyInstance,
  options: MerchantsHttpRoutesOptions
): Promise<void> {
  app.post('/api/v1/auth/merchant-signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = merchantSignupBodySchema.parse(request.body)
      const result = await options.merchants.provisionMerchant({ merchantName: body.merchantName, email: body.email, password: body.password, correlationId: request.correlationId, logger: request.log })
      return reply.code(201).send(result)
    } catch (error) {
      return sendSignupError(request, reply, error)
    }
  })

  app.get('/api/v1/merchants/me', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'merchant') {
        return sendForbidden(reply, request.correlationId)
      }
      const merchant = await options.merchants.getMerchant(request.authUser.id)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.patch('/api/v1/merchants/me', async (request, reply) => {
    try {
      if (request.authUser === undefined) {
        throw new Error('Authenticated user is missing')
      }
      if (request.authUser.role !== 'merchant') {
        return sendForbidden(reply, request.correlationId)
      }
      const body = updateMerchantBodySchema.parse(request.body)
      const merchant = await options.merchants.updateMerchantInformation(request.authUser.id, body)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })

  app.get('/api/v1/merchants/me/account-contact', async (request, reply) => {
    try {
      if (request.authUser === undefined) throw new Error('Authenticated user is missing')
      if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId)
      const contact = await options.merchants.getAccountContact(request.authUser.id)
      if (contact === null) return reply.code(404).send({ error: 'MerchantAccountContactNotFoundError', message: 'Merchant account contact was not found', correlationId: request.correlationId })
      return reply.send(contact)
    } catch (error) { return sendMappedError(request, reply, error) }
  })
  app.patch('/api/v1/merchants/me/account-contact', async (request, reply) => {
    try {
      if (request.authUser === undefined) throw new Error('Authenticated user is missing')
      if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId)
      const body = updateMerchantAccountContactBodySchema.parse(request.body)
      return reply.send(await options.merchants.updateAccountContact(request.authUser.id, body))
    } catch (error) { return sendMappedError(request, reply, error) }
  })

  const legalResponse = (legal: MerchantLegalInformation | null, electronicInvoicingStatus: ElectronicInvoicingStatus) => legal === null ? { legalInformation: null, merchantLegalInformationCompleted: false, electronicInvoicingStatus } : { legalInformation: { siret: legal.siret, siren: legal.siren, legalName: legal.legalName, legalAddress: legal.legalAddress, billingAddress: legal.billingAddress, vatNumber: legal.vatNumber, vatRegime: legal.vatRegime, legalForm: legal.legalForm, buyerReference: legal.buyerReference, sireneVerificationStatus: legal.sireneVerificationStatus, sireneVerifiedAt: legal.sireneVerifiedAt }, merchantLegalInformationCompleted: isMerchantLegalInformationComplete(legal), electronicInvoicingStatus }
  app.get('/api/v1/merchants/me/legal-information', async (request, reply) => { try { if (request.authUser === undefined) throw new Error('Authenticated user is missing'); if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId); const id = request.authUser.id; return reply.send(legalResponse(await options.merchants.getLegalInformation(id), await options.merchants.getElectronicInvoicingStatus(id))) } catch (error) { return sendMappedError(request, reply, error) } })
  app.post('/api/v1/merchants/me/legal-information/siret-lookup', async (request, reply) => { try { if (request.authUser === undefined) throw new Error('Authenticated user is missing'); if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId); const body=sireneLookupBodySchema.parse(request.body); const found=await options.merchants.lookupLegalInformation(request.authUser.id, body.siret); return reply.send({ siret: found.siret, siren: found.siren, legalName: found.legalName, legalAddress: found.legalAddress, sireneVerificationStatus: 'verified', warning: found.establishmentActive && found.legalUnitActive ? null : 'The establishment or legal unit is inactive' }) } catch (error) { return sendMappedError(request, reply, error) } })
  app.patch('/api/v1/merchants/me/legal-information', async (request, reply) => { try { if (request.authUser === undefined) throw new Error('Authenticated user is missing'); if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId); const body=updateLegalInformationBodySchema.parse(request.body); const id = request.authUser.id; return reply.send(legalResponse(await options.merchants.updateLegalInformation(id, body), await options.merchants.getElectronicInvoicingStatus(id))) } catch (error) { return sendMappedError(request, reply, error) } })

  app.post('/api/v1/merchants/me/logo', async (request, reply) => {
    try {
      if (request.authUser === undefined) throw new Error('Authenticated user is missing')
      if (request.authUser.role !== 'merchant') return sendForbidden(reply, request.correlationId)
      const file = await request.file()
      if (file === undefined) return reply.code(400).send({ error: 'ValidationError', message: 'Logo file is required', correlationId: request.correlationId })
      const merchant = await options.merchants.uploadLogo(request.authUser.id, await file.toBuffer(), file.mimetype)
      return reply.code(200).send(merchantResponse(merchant))
    } catch (error) {
      return sendMappedError(request, reply, error)
    }
  })
}
